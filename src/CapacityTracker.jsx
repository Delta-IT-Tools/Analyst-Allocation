import { useState, useEffect, useRef } from "react";
import { Plus, X, Check, AlertTriangle, Gauge, Bell, History, FolderCog, Palette, TrendingUp, Pencil, Link2, Network, MoreHorizontal, Download, Upload, Archive } from "lucide-react";
import InterfacesView from "./InterfacesView.jsx";

const PALETTE = [
  "#1F6F63",
  "#E8A33D",
  "#C1443C",
  "#4F5FA6",
  "#6B8F3E",
  "#8E5B9E",
  "#5C7080",
  "#B08B4F",
];

const DATA_KEY = "capacity-board-data";
const USER_KEY = "capacity-current-user";
const BACKUP_PREFIX = "capacity-board-backup:";
const MAX_BACKUPS = 10;

function uid() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

// Projects named like "BN – Barrett Integration" or "General – Ecom Projects"
// share a prefix before the dash. Group by that prefix so related projects
// get the same color at a glance. A name with no dash is its own group.
function getProjectGroupKey(name) {
  const match = name.match(/^(.*?)\s+[–—-]\s+/);
  return (match ? match[1] : name).trim();
}

// The part of a grouped project's name after the group prefix
// ("BN – Barrett Integration" -> "Barrett Integration").
function stripGroupPrefix(name) {
  return name.replace(/^(.*?)\s+[–—-]\s+/, "").trim() || name;
}

// Splits projects into their name-prefix groups, keeping first-seen order.
// Groups with several projects get a heading on the dashboard; a project
// that is alone in its group is shown on its own with its full name.
function groupProjects(projects) {
  const groups = [];
  const byKey = new Map();
  projects.forEach((p) => {
    const key = getProjectGroupKey(p.name);
    if (!byKey.has(key)) {
      const g = { key, color: p.color, projects: [] };
      byKey.set(key, g);
      groups.push(g);
    }
    byKey.get(key).projects.push(p);
  });
  return groups.map((g) => ({ ...g, multi: g.projects.length > 1 }));
}

// Dashboard heatmap tint for an allocation %. Stepped rather than smooth so
// the text on every step stays readable: dark text on the light steps,
// white text on the solid 70%+ step.
const HEAT_RGB = [31, 107, 92];
function heatStyle(value) {
  if (!value) return undefined;
  if (value >= 70) return { background: `rgb(${HEAT_RGB.join(",")})`, color: "#FFFFFF" };
  const a = value <= 10 ? 0.1 : value <= 25 ? 0.2 : value <= 45 ? 0.32 : 0.46;
  const [r, g, b] = HEAT_RGB.map((c) => Math.round(c * a + 255 * (1 - a)));
  return { background: `rgb(${r},${g},${b})`, color: "#15181D" };
}

function initialsFor(name) {
  const parts = name.trim().split(/\s+/);
  const letters = parts.length > 1 ? parts[0][0] + parts[1][0] : name.trim().slice(0, 2);
  return letters.toUpperCase();
}

// Picks a color for a project name, reusing the color already assigned to
// its group if one exists among existingProjects, otherwise handing out the
// next unused palette color. This keeps colors consistent and meaningful
// everywhere in the app, no matter when a project was added.
function colorForProjectName(name, existingProjects) {
  const groupKey = getProjectGroupKey(name);
  const sameGroup = existingProjects.find((p) => getProjectGroupKey(p.name) === groupKey);
  if (sameGroup) return sameGroup.color;
  const usedColors = new Set(existingProjects.map((p) => p.color));
  const unused = PALETTE.find((c) => !usedColors.has(c));
  return unused || PALETTE[existingProjects.length % PALETTE.length];
}

// Orders a resource's project cards by their current allocation on that
// project, highest first, so the projects they usually work on (and are
// most likely updating again this month) surface at the top. Ties break
// alphabetically by project name.
function sortProjectsForResource(projects, allocationForResource) {
  const alloc = allocationForResource || {};
  return [...projects].sort((a, b) => {
    const av = alloc[a.id] || 0;
    const bv = alloc[b.id] || 0;
    if (bv !== av) return bv - av;
    return a.name.localeCompare(b.name);
  });
}

// ---------- Allocation history ----------
// data.history = { "YYYY-MM": { [memberId]: { [projectId]: pct } } }
// One snapshot per analyst per month: every allocation change overwrites that
// analyst's entry for the current month, so each month holds the last values
// they submitted. Months with no update carry the previous values forward in
// the Trends view (shown muted), minus any project retired before that month.

function monthKeyFromDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function currentMonthKey() {
  return monthKeyFromDate(new Date());
}

function monthKeyFromISO(iso) {
  return iso && /^\d{4}-\d{2}/.test(iso) ? iso.slice(0, 7) : currentMonthKey();
}

function addMonths(key, n) {
  const [y, m] = key.split("-").map(Number);
  return monthKeyFromDate(new Date(y, m - 1 + n, 1));
}

function monthRange(start, end) {
  const out = [];
  let k = start;
  while (k <= end && out.length < 240) {
    out.push(k);
    k = addMonths(k, 1);
  }
  return out;
}

function formatMonth(key) {
  const [y, m] = key.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: "short", year: "2-digit" });
}

function pruneZeros(alloc) {
  const out = {};
  Object.entries(alloc || {}).forEach(([pid, v]) => {
    if (v) out[pid] = v;
  });
  return out;
}

// ---------- Update log ----------
// data.updates = [{ memberId, at: ISO timestamp, alloc: { [projectId]: pct }, source }]
// Every allocation change is kept, however often (or rarely) each analyst
// updates. Edits by the same person within UPDATE_COALESCE_MS are one sitting,
// so they're merged into a single entry. source is "board", "form" (personal
// update link) or "import" (entries rebuilt from the older monthly snapshots).
//
// data.history (monthly last-value snapshots) is still written alongside for
// compatibility, but Trends now reads from the update log.

const UPDATE_COALESCE_MS = 30 * 60 * 1000;

// Boards saved before history existed get a baseline: each analyst's current
// allocation is recorded in the month they last updated it. Boards saved
// before the update log existed get one log entry per monthly snapshot.
function ensureHistory(d) {
  let out = d;
  if (!(out && out.history && typeof out.history === "object")) {
    const history = {};
    ((out && out.members) || []).forEach((m) => {
      const mk = monthKeyFromISO(m.lastUpdated);
      history[mk] = history[mk] || {};
      history[mk][m.id] = pruneZeros((out.allocations || {})[m.id]);
    });
    out = { ...out, history };
  }
  if (!Array.isArray(out.updates)) {
    out = { ...out, updates: updatesFromHistory(out) };
  }
  return out;
}

function updatesFromHistory(d) {
  const lastUpdated = {};
  ((d && d.members) || []).forEach((m) => (lastUpdated[m.id] = m.lastUpdated || ""));
  const updates = [];
  Object.keys(d.history || {})
    .sort()
    .forEach((mk) => {
      Object.entries(d.history[mk] || {}).forEach(([memberId, alloc]) => {
        const lu = lastUpdated[memberId];
        const day = lu && lu.slice(0, 7) === mk ? lu : `${mk}-01`;
        updates.push({ memberId, at: `${day}T12:00:00.000Z`, alloc: pruneZeros(alloc), source: "import" });
      });
    });
  return updates;
}

function recordUpdate(updates, memberId, alloc, source, nowMs = Date.now()) {
  const list = [...(updates || [])];
  const entry = { memberId, at: new Date(nowMs).toISOString(), alloc: pruneZeros(alloc), source };
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i].memberId !== memberId) continue;
    const prevMs = Date.parse(list[i].at);
    if (list[i].source !== "import" && !Number.isNaN(prevMs) && nowMs - prevMs >= 0 && nowMs - prevMs < UPDATE_COALESCE_MS) {
      list[i] = entry;
      return list;
    }
    break;
  }
  list.push(entry);
  return list;
}

function memberUpdates(data, memberId) {
  return (data.updates || [])
    .filter((u) => u.memberId === memberId)
    .map((u) => ({ ...u, t: Date.parse(u.at) }))
    .filter((u) => !Number.isNaN(u.t))
    .sort((a, b) => a.t - b.t);
}

function localDayStartMs(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).getTime();
}

function monthBoundsMs(mk) {
  const [y, m] = mk.split("-").map(Number);
  return [new Date(y, m - 1, 1).getTime(), new Date(y, m, 1).getTime()];
}

function earliestUpdateMonth(data) {
  let min = null;
  (data.updates || []).forEach((u) => {
    const t = Date.parse(u.at);
    if (Number.isNaN(t)) return;
    const mk = monthKeyFromDate(new Date(t));
    if (!min || mk < min) min = mk;
  });
  return min;
}

// Round fractional percentages to whole numbers while keeping their total
// equal to the rounded true total (largest-remainder method).
function roundAlloc(raw) {
  const entries = Object.entries(raw).filter(([, v]) => v > 0);
  const target = Math.round(entries.reduce((a, [, v]) => a + v, 0));
  const floored = entries.map(([pid, v]) => ({ pid, base: Math.floor(v), rem: v - Math.floor(v) }));
  let short = target - floored.reduce((a, e) => a + e.base, 0);
  floored.sort((a, b) => b.rem - a.rem);
  const out = {};
  floored.forEach((e) => {
    let v = e.base;
    if (short > 0 && e.rem > 0) {
      v += 1;
      short -= 1;
    }
    if (v) out[e.pid] = v;
  });
  return out;
}

// Returns one entry per month: { month, alloc, recorded, updateCount }.
// alloc is the month's time-weighted average: each update counts for as long
// as it was in effect during that month. alloc is null before the analyst's
// first update. recorded is false when no update was made that month and the
// values were carried forward. A retired project stops counting from the day
// it was retired.
function memberTimeline(data, memberId, months) {
  const events = memberUpdates(data, memberId);
  const retirements = data.projects
    .filter((p) => p.archived && p.archivedAt)
    .map((p) => ({ pid: p.id, t: localDayStartMs(p.archivedAt) }));
  const now = Date.now();

  function inEffect(t) {
    let ev = null;
    for (const e of events) {
      if (e.t <= t) ev = e;
      else break;
    }
    if (!ev) return null;
    const alloc = {};
    Object.entries(ev.alloc || {}).forEach(([pid, v]) => {
      if (retirements.some((r) => r.pid === pid && r.t <= t)) return;
      alloc[pid] = v;
    });
    return alloc;
  }

  return months.map((mk) => {
    const [ms, me] = monthBoundsMs(mk);
    const updateCount = events.filter((e) => e.t >= ms && e.t < me).length;
    const recorded = updateCount > 0;
    const end = Math.min(me, now);
    if (!events.length || events[0].t >= end) return { month: mk, alloc: null, recorded: false, updateCount };
    const start = Math.max(ms, events[0].t);

    const cuts = new Set([start, end]);
    events.forEach((e) => e.t > start && e.t < end && cuts.add(e.t));
    retirements.forEach((r) => r.t > start && r.t < end && cuts.add(r.t));
    const points = [...cuts].sort((a, b) => a - b);

    const sums = {};
    let covered = 0;
    for (let i = 0; i < points.length - 1; i++) {
      const dur = points[i + 1] - points[i];
      if (dur <= 0) continue;
      const alloc = inEffect(points[i]) || {};
      Object.entries(alloc).forEach(([pid, v]) => (sums[pid] = (sums[pid] || 0) + v * dur));
      covered += dur;
    }
    if (covered === 0) return { month: mk, alloc: inEffect(start) || {}, recorded, updateCount };
    const avg = {};
    Object.entries(sums).forEach(([pid, v]) => (avg[pid] = v / covered));
    return { month: mk, alloc: roundAlloc(avg), recorded, updateCount };
  });
}

function sumAlloc(alloc) {
  return Object.values(alloc || {}).reduce((a, b) => a + b, 0);
}

// Seeded from SharePoint: ITKnowledgeBase / Analyst Allocation page
const SEED_MEMBER_NAMES = ["Dusko", "Paul", "Sandy", "Diego", "Shelly", "Kim", "Bhaskar", "Carmen", "Brent"];
// "Last updated" dates from the SharePoint page header (e.g. DUSKO 7.1 = July 1, 2026)
const SEED_MEMBER_DATES = ["2026-07-01", "2026-07-29", "2026-06-25", "2026-06-25", "2026-08-04", "2026-07-02", "2026-05-13", "2026-06-25", "2026-05-13"];

const SEED_PROJECT_NAMES = [
  "Tifton WMS",
  "BN \u2013 Barrett Integration",
  "BN \u2013 Barrett PROD Support",
  "BN \u2013 General Support",
  "SPL \u2013 Anaplan",
  "SAP",
  "7FAM \u2013 POS - xStore",
  "Fontana \u2013 Passport Integration",
  "Fontana \u2013 WMS Support",
  "General \u2013 Ecom Projects",
  "General \u2013 Drop Ship / EDI Projects",
  "General \u2013 Other gen support",
];

// One row per project above, values = % allocated by that analyst
const SEED_ALLOCATION_ROWS = [
  { Dusko: 60, Paul: 70, Sandy: 10, Brent: 40 },
  { Diego: 30, Brent: 40 },
  { Paul: 5, Diego: 10, Shelly: 60 },
  { Paul: 25, Sandy: 10, Diego: 25 },
  { Dusko: 10, Brent: 10 },
  { Sandy: 25, Diego: 5, Kim: 75, Bhaskar: 60, Carmen: 80 },
  {},
  {},
  { Shelly: 10, Bhaskar: 40 },
  { Diego: 15 },
  { Sandy: 30, Kim: 5, Carmen: 10 },
  { Dusko: 30, Sandy: 25, Diego: 15, Shelly: 30, Kim: 20, Carmen: 10, Brent: 10 },
];

function buildSeedData() {
  const members = SEED_MEMBER_NAMES.map((name, i) => ({ id: uid(), name, lastUpdated: SEED_MEMBER_DATES[i] || "", lastRequested: "" }));
  const idByName = {};
  members.forEach((m) => (idByName[m.name] = m.id));

  const projects = [];
  SEED_PROJECT_NAMES.forEach((name) => {
    const color = colorForProjectName(name, projects);
    projects.push({ id: uid(), name, color });
  });

  const allocations = {};
  members.forEach((m) => (allocations[m.id] = {}));
  projects.forEach((p, i) => {
    const row = SEED_ALLOCATION_ROWS[i] || {};
    Object.entries(row).forEach(([name, pct]) => {
      const mid = idByName[name];
      if (mid) allocations[mid][p.id] = pct;
    });
  });

  return ensureHistory({ projects, members, allocations });
}

export default function CapacityTracker() {
  const [mode, setMode] = useState("dashboard"); // "dashboard" | "selfserve" | "trends" | "manageProjects" | "interfaces"
  const [data, setData] = useState({ projects: [], members: [], allocations: {} });
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadErrorState] = useState(false);
  // Mirror of loadError readable from timers and event listeners, which can
  // hold stale closures. Always change it through setLoadError below.
  const loadErrorRef = useRef(false);
  function setLoadError(value) {
    loadErrorRef.current = value;
    setLoadErrorState(value);
  }
  const [saveState, setSaveState] = useState("idle");
  const [currentUserId, setCurrentUserId] = useState("");
  const [selectedProjectId, setSelectedProjectId] = useState("");
  const [addingMember, setAddingMember] = useState(false);
  const [newMemberName, setNewMemberName] = useState("");
  const [selfServeUserId, setSelfServeUserId] = useState("");
  const [selfServeSubmitted, setSelfServeSubmitted] = useState(false);
  const saveTimeout = useRef(null);
  const pendingSaveData = useRef(null);
  const saveChain = useRef(Promise.resolve());
  const fileInputRef = useRef(null);
  const [showBackups, setShowBackups] = useState(false);
  const [showNetworkDiagram, setShowNetworkDiagram] = useState(false);
  const [backupsList, setBackupsList] = useState([]);
  const [backupsLoading, setBackupsLoading] = useState(false);
  const [restoreNotice, setRestoreNotice] = useState("");
  // Fingerprint of the board data as last loaded from / saved to the server.
  // Saves send it back so they're refused if someone else saved in between.
  const serverEtag = useRef(null);
  // Bumped whenever fresh data replaces what's on screen, so any save that was
  // queued against the old data is dropped instead of overwriting the new data.
  const dataGeneration = useRef(0);
  const [showLinks, setShowLinks] = useState(false);
  const [links, setLinks] = useState({});
  const [linksLoading, setLinksLoading] = useState(false);
  const [linksError, setLinksError] = useState("");
  const [linkNotice, setLinkNotice] = useState("");
  const [showMenu, setShowMenu] = useState(false);
  const menuRef = useRef(null);

  // Close the "More" menu on a click outside it or on Escape.
  useEffect(() => {
    if (!showMenu) return;
    function onPointer(e) {
      if (menuRef.current && !menuRef.current.contains(e.target)) setShowMenu(false);
    }
    function onKey(e) {
      if (e.key === "Escape") setShowMenu(false);
    }
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [showMenu]);

  async function loadData() {
    setLoadError(false);
    try {
      const res = await window.storage.get(DATA_KEY, true);
      if (res && res.value) {
        serverEtag.current = res.etag || null;
        setData(ensureHistory(JSON.parse(res.value)));
      } else {
        // Key genuinely doesn't exist yet — this is a true first-time load.
        const seed = buildSeedData();
        setData(seed);
        try {
          const saved = await window.storage.set(DATA_KEY, JSON.stringify(seed), true);
          serverEtag.current = (saved && saved.etag) || null;
        } catch (e2) {
          // seed will still show locally even if save fails
        }
      }
    } catch (e) {
      if (e && e.code === "NOT_FOUND") {
        // Normal first-time load (e.g. a brand-new database) — not an error.
        const seed = buildSeedData();
        setData(seed);
        try {
          const saved = await window.storage.set(DATA_KEY, JSON.stringify(seed), true);
          serverEtag.current = (saved && saved.etag) || null;
        } catch (e2) {
          // seed will still show locally even if save fails
        }
      } else {
        // A genuine fetch/connectivity error — NOT proof the data doesn't
        // exist. Never overwrite shared storage here, or a brief blip could
        // silently wipe out everyone's real data.
        setLoadError(true);
        const seed = buildSeedData();
        setData(seed);
      }
    }
    try {
      const res2 = await window.storage.get(USER_KEY, false);
      if (res2 && res2.value) setCurrentUserId(res2.value);
    } catch (e) {
      // no local user set yet
    }
    setLoaded(true);
  }

  useEffect(() => {
    loadData();
  }, []);

  useEffect(() => {
    function handleVisibilityOrUnload() {
      if (document.hidden) {
        flushPendingSave();
      } else {
        // Coming back to the tab: pick up anything others saved meanwhile
        // (including update-form submissions) before the next edit.
        refreshFromServer();
      }
    }
    document.addEventListener("visibilitychange", handleVisibilityOrUnload);
    window.addEventListener("pagehide", handleVisibilityOrUnload);
    window.addEventListener("beforeunload", handleVisibilityOrUnload);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityOrUnload);
      window.removeEventListener("pagehide", handleVisibilityOrUnload);
      window.removeEventListener("beforeunload", handleVisibilityOrUnload);
    };
  }, []);

  // While the team's real data failed to load, the screen shows sample data.
  // Saving anything then would overwrite the real board, so ordinary edits are
  // blocked. Import and Restore pass { recovery: true }: they replace the board
  // on purpose (after a confirm), which is also how to recover if the saved
  // data is unreadable.
  function persist(nextData, options = {}) {
    if (loadErrorRef.current) {
      if (!options.recovery) {
        window.alert(
          "Changes can't be saved right now: the team's data didn't load, so you're looking at sample data. Click Retry in the yellow banner first."
        );
        return;
      }
      setLoadError(false);
    }
    setData(nextData);
    setSaveState("saving");
    pendingSaveData.current = nextData;
    if (saveTimeout.current) clearTimeout(saveTimeout.current);
    saveTimeout.current = setTimeout(() => {
      flushPendingSave();
    }, 400);
  }

  async function flushPendingSave() {
    if (saveTimeout.current) {
      clearTimeout(saveTimeout.current);
      saveTimeout.current = null;
    }
    const toSave = pendingSaveData.current;
    if (toSave === null) return;
    pendingSaveData.current = null;
    const generation = dataGeneration.current;
    // Chain this write after any write already in flight completes. This
    // guarantees writes land in the order they were made — a faster network
    // response for a later edit can never overwrite an earlier one anymore.
    saveChain.current = saveChain.current.then(async () => {
      // Fresh data was loaded after this edit was queued; drop the stale save.
      if (generation !== dataGeneration.current) return;
      try {
        const ok = await window.storage.set(DATA_KEY, JSON.stringify(toSave), true, {
          ifMatch: serverEtag.current,
        });
        if (ok && ok.etag) serverEtag.current = ok.etag;
        setSaveState(ok ? "saved" : "error");
        if (ok) {
          // Best-effort recovery point. Never blocks or fails the main save.
          writeBackupSnapshot(toSave).catch(() => {});
        }
      } catch (e) {
        if (e && e.code === "CONFLICT") {
          // Someone else saved first. Don't overwrite their work: load the
          // latest board and ask this person to redo their last change.
          dataGeneration.current += 1;
          pendingSaveData.current = null;
          if (saveTimeout.current) {
            clearTimeout(saveTimeout.current);
            saveTimeout.current = null;
          }
          await loadData();
          setSaveState("idle");
          setRestoreNotice(
            "Someone else saved changes (or an analyst used their update link) since this board was loaded. The latest version is now showing. Please redo your last change."
          );
          return;
        }
        setSaveState("error");
      }
    });
    await saveChain.current;
  }

  // Quietly pick up changes others saved, but only when this browser has no
  // edit waiting to be saved (those are protected by the save check instead).
  async function refreshFromServer() {
    if (loadErrorRef.current) return;
    if (pendingSaveData.current !== null || saveTimeout.current) return;
    try {
      await saveChain.current;
      const before = serverEtag.current;
      const res = await window.storage.get(DATA_KEY, true);
      if (!res || !res.value || !res.etag || res.etag === before) return;
      if (pendingSaveData.current !== null || saveTimeout.current || serverEtag.current !== before) return;
      dataGeneration.current += 1;
      serverEtag.current = res.etag;
      setData(ensureHistory(JSON.parse(res.value)));
    } catch (e) {
      // Not worth interrupting anyone over; the next save is still protected.
    }
  }

  // ---------- Personal update links ----------
  async function linksRequest(options) {
    const res = await fetch("/api/links", { headers: { "Content-Type": "application/json" }, ...options });
    if (res.status === 401) {
      window.location.href = "/login";
      throw new Error("Not authenticated");
    }
    if (!res.ok) throw new Error(`Links request failed: ${res.status}`);
    const body = await res.json();
    return body.links || {};
  }

  async function loadLinks() {
    setLinksLoading(true);
    setLinksError("");
    try {
      setLinks(await linksRequest({ method: "GET" }));
    } catch (e) {
      setLinksError("Couldn't load update links. Try again.");
    }
    setLinksLoading(false);
  }

  async function changeLink(member, action) {
    if (action === "create" && links[member.id] &&
        !window.confirm(`Make a new link for ${member.name}? Their current link will stop working.`)) return;
    if (action === "revoke" &&
        !window.confirm(`Turn off ${member.name}'s update link? It will stop working right away.`)) return;
    setLinksError("");
    try {
      setLinks(await linksRequest({ method: "POST", body: JSON.stringify({ memberId: member.id, action }) }));
      setLinkNotice(action === "create" ? `Link ready for ${member.name}.` : `${member.name}'s link is turned off.`);
    } catch (e) {
      setLinksError("Couldn't change that link. Try again.");
    }
  }

  async function copyLink(member) {
    const url = links[member.id];
    if (!url) return;
    let copied = false;
    try {
      await navigator.clipboard.writeText(url);
      copied = true;
    } catch (e) {
      window.prompt(`Copy ${member.name}'s update link:`, url);
    }
    requestUpdate(member.id);
    setLinkNotice(
      `${copied ? "Copied" : "Showed"} ${member.name}'s link and logged today as an update request.`
    );
  }

  async function writeBackupSnapshot(snapshotData) {
    if (loadErrorRef.current) return;
    const key = `${BACKUP_PREFIX}${Date.now()}`;
    await window.storage.set(key, JSON.stringify(snapshotData), true);
    try {
      const list = await window.storage.list(BACKUP_PREFIX, true);
      const keys = (list && list.keys) || [];
      if (keys.length > MAX_BACKUPS) {
        const sorted = [...keys].sort(); // ISO-ish timestamp suffix sorts chronologically
        const toDelete = sorted.slice(0, sorted.length - MAX_BACKUPS);
        await Promise.all(toDelete.map((k) => window.storage.delete(k, true).catch(() => {})));
      }
    } catch (e) {
      // pruning is best-effort only
    }
  }

  async function createBackupNow() {
    if (loadErrorRef.current) {
      setRestoreNotice("Can't create a backup until the team's data loads. Click Retry first.");
      return;
    }
    setRestoreNotice("Creating backup…");
    try {
      await writeBackupSnapshot(data);
      setRestoreNotice("Backup created just now.");
      if (showBackups) loadBackupsList();
    } catch (e) {
      setRestoreNotice("Couldn't create a backup — please try again.");
    }
  }

  async function loadBackupsList() {
    setBackupsLoading(true);
    try {
      const list = await window.storage.list(BACKUP_PREFIX, true);
      const keys = (list && list.keys) || [];
      const withTimes = keys
        .map((k) => {
          const ts = Number(k.slice(BACKUP_PREFIX.length));
          return { key: k, ts };
        })
        .filter((entry) => !Number.isNaN(entry.ts))
        .sort((a, b) => b.ts - a.ts);
      setBackupsList(withTimes);
    } catch (e) {
      setBackupsList([]);
    }
    setBackupsLoading(false);
  }

  async function restoreBackup(key, label) {
    const confirmed = window.confirm(
      `Restore the board to the snapshot from ${label}? This will overwrite what's currently on screen (your current state is not automatically saved first).`
    );
    if (!confirmed) return;
    try {
      const res = await window.storage.get(key, true);
      if (res && res.value) {
        const parsed = JSON.parse(res.value);
        persist(ensureHistory(parsed), { recovery: true });
        setRestoreNotice(`Restored to snapshot from ${label}.`);
        setShowBackups(false);
      }
    } catch (e) {
      setRestoreNotice("Could not restore that snapshot — please try again.");
    }
  }

  function exportData() {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `capacity-board-backup-${todayISO()}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function triggerImport() {
    if (fileInputRef.current) fileInputRef.current.click();
  }

  function handleImportFile(e) {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(reader.result);
        if (parsed && parsed.projects && parsed.members && parsed.allocations) {
          const confirmed = window.confirm(
            "Import this file? This will overwrite the current board with the data in this file."
          );
          if (confirmed) {
            persist(ensureHistory(parsed), { recovery: true });
            setRestoreNotice("Imported data from file.");
          }
        } else {
          window.alert("That file doesn't look like a valid Capacity board backup.");
        }
      } catch (err) {
        window.alert("Couldn't read that file as JSON.");
      }
    };
    reader.readAsText(file);
    e.target.value = "";
  }

  function selectUser(id) {
    setCurrentUserId(id);
    window.storage.set(USER_KEY, id, false).catch(() => {});
  }

  function addProject(name) {
    const trimmed = name.trim();
    if (!trimmed) return;
    const color = colorForProjectName(trimmed, data.projects);
    const project = { id: uid(), name: trimmed, color };
    persist({ ...data, projects: [...data.projects, project] });
  }

  // Retiring hides a project from the live board and clears everyone's
  // current allocation on it, but keeps the project (and its history) so the
  // Trends view can still show past time spent on it.
  function retireProject(id, name) {
    const confirmed = window.confirm(
      `Retire "${name}"? It will be removed from the board and everyone's current allocation on it will be cleared. Past allocations stay visible in Trends.`
    );
    if (!confirmed) return;
    const allocations = {};
    Object.keys(data.allocations).forEach((mid) => {
      const rest = { ...data.allocations[mid] };
      delete rest[id];
      allocations[mid] = rest;
    });
    const projects = data.projects.map((p) => (p.id === id ? { ...p, archived: true, archivedAt: todayISO() } : p));
    persist({ ...data, projects, allocations });
  }

  function reactivateProject(id) {
    const projects = data.projects.map((p) => {
      if (p.id !== id) return p;
      const { archived, archivedAt, ...rest } = p;
      return rest;
    });
    persist({ ...data, projects });
  }

  function recolorProjectsByGroup() {
    writeBackupSnapshot(data).catch(() => {});
    const recolored = [];
    data.projects.forEach((p) => {
      const color = colorForProjectName(p.name, recolored);
      recolored.push({ ...p, color });
    });
    persist({ ...data, projects: recolored });
  }

  function addMember(name) {
    const trimmed = name.trim();
    if (!trimmed) return;
    const member = { id: uid(), name: trimmed, lastUpdated: "", lastRequested: "" };
    persist({
      ...data,
      members: [...data.members, member],
      allocations: { ...data.allocations, [member.id]: {} },
    });
    setNewMemberName("");
    setAddingMember(false);
  }

  // Permanently deletes a teammate: their column, current allocations,
  // update history and personal update link. Meant for test or mistaken
  // entries; there is no "retire" for people the way there is for projects.
  async function removeMember(member) {
    const confirmed = window.confirm(
      `Permanently remove ${member.name}? Their allocations, update history and update link will be deleted. This can't be undone (except by restoring a backup).`
    );
    if (!confirmed) return;

    const allocations = { ...data.allocations };
    delete allocations[member.id];
    const history = {};
    Object.entries(data.history || {}).forEach(([mk, byMember]) => {
      const rest = { ...byMember };
      delete rest[member.id];
      history[mk] = rest;
    });
    persist({
      ...data,
      members: data.members.filter((m) => m.id !== member.id),
      allocations,
      history,
      updates: (data.updates || []).filter((u) => u.memberId !== member.id),
    });

    if (currentUserId === member.id) selectUser("");
    if (selfServeUserId === member.id) setSelfServeUserId("");

    if (links[member.id]) {
      try {
        setLinks(await linksRequest({ method: "POST", body: JSON.stringify({ memberId: member.id, action: "revoke" }) }));
      } catch (e) {
        // The teammate is gone either way; a leftover link can only edit a person who no longer exists.
      }
    }
    setLinkNotice(`${member.name} has been removed.`);
  }

  function restoreMissingMembers() {
    const existingNames = new Set(data.members.map((m) => m.name));
    const missingNames = SEED_MEMBER_NAMES.filter((name) => !existingNames.has(name));
    if (missingNames.length === 0) return;

    // Ensure all seeded projects exist too, so restored allocations have somewhere to land
    const existingProjectNames = new Map(data.projects.map((p) => [p.name, p.id]));
    const newProjects = [];
    SEED_PROJECT_NAMES.forEach((name) => {
      if (!existingProjectNames.has(name)) {
        const color = colorForProjectName(name, [...data.projects, ...newProjects]);
        const project = { id: uid(), name, color };
        newProjects.push(project);
        existingProjectNames.set(name, project.id);
      }
    });

    const newMembers = missingNames.map((name) => {
      const idx = SEED_MEMBER_NAMES.indexOf(name);
      return { id: uid(), name, lastUpdated: SEED_MEMBER_DATES[idx] || "", lastRequested: "" };
    });

    const allocations = { ...data.allocations };
    newMembers.forEach((m) => {
      allocations[m.id] = {};
    });
    newMembers.forEach((m) => {
      const idx = SEED_MEMBER_NAMES.indexOf(m.name);
      SEED_ALLOCATION_ROWS.forEach((row, projIdx) => {
        const pct = row[m.name];
        if (pct) {
          const projName = SEED_PROJECT_NAMES[projIdx];
          const projId = existingProjectNames.get(projName);
          const proj = data.projects.find((p) => p.id === projId);
          if (projId && !(proj && proj.archived)) allocations[m.id][projId] = pct;
        }
      });
    });

    persist({
      ...data,
      projects: [...data.projects, ...newProjects],
      members: [...data.members, ...newMembers],
      allocations,
    });
  }

  function setLastUpdated(memberId, dateStr) {
    const members = data.members.map((m) => (m.id === memberId ? { ...m, lastUpdated: dateStr } : m));
    persist({ ...data, members });
  }

  function requestUpdate(memberId) {
    const members = data.members.map((m) => (m.id === memberId ? { ...m, lastRequested: todayISO() } : m));
    persist({ ...data, members });
  }

  function todayISO() {
    return new Date().toISOString().slice(0, 10);
  }

  function setAllocation(memberId, projectId, value) {
    const v = clamp(Math.round(value), 0, 100);
    const memberAlloc = { ...(data.allocations[memberId] || {}), [projectId]: v };
    const members = data.members.map((m) => (m.id === memberId ? { ...m, lastUpdated: todayISO() } : m));
    const mk = currentMonthKey();
    const base = ensureHistory(data);
    const history = { ...base.history };
    history[mk] = { ...(history[mk] || {}), [memberId]: pruneZeros(memberAlloc) };
    const updates = recordUpdate(base.updates, memberId, memberAlloc, "board");
    persist({ ...base, allocations: { ...data.allocations, [memberId]: memberAlloc }, members, history, updates });
  }

  function totalFor(memberId) {
    const alloc = data.allocations[memberId] || {};
    return Object.values(alloc).reduce((a, b) => a + b, 0);
  }

  function projectTotal(projectId) {
    return data.members.reduce(
      (sum, m) => sum + ((data.allocations[m.id] || {})[projectId] || 0),
      0
    );
  }

  function statusColor(total) {
    if (total > 100) return "var(--c-danger)";
    if (total >= 90) return "var(--c-amber)";
    return "var(--c-teal)";
  }

  function formatDate(iso) {
    if (!iso) return "no date";
    const [y, m, d] = iso.split("-");
    return `${m}/${d}/${y.slice(2)}`;
  }

  function daysSince(iso) {
    if (!iso) return Infinity;
    const then = new Date(iso + "T00:00:00");
    const now = new Date();
    return Math.floor((now - then) / (1000 * 60 * 60 * 24));
  }

  function isStale(iso) {
    return daysSince(iso) > 30;
  }

  function isRequestPending(member) {
    if (!member.lastRequested) return false;
    if (!member.lastUpdated) return true;
    // Fulfilled if the person updated on or after the day the request was made
    return member.lastRequested > member.lastUpdated;
  }

  const currentUser = data.members.find((m) => m.id === currentUserId);
  const activeProjects = data.projects.filter((p) => !p.archived);
  const selectedProject = activeProjects.find((p) => p.id === selectedProjectId);
  const sortedMembers = [...data.members].sort((a, b) => totalFor(b.id) - totalFor(a.id));
  const sortedProjects = [...activeProjects].sort((a, b) => projectTotal(b.id) - projectTotal(a.id));
  const projectGroups = groupProjects(activeProjects);
  const maxProjectTotal = Math.max(0, ...activeProjects.map((p) => projectTotal(p.id)));
  const staleMembers = data.members.filter((m) => isStale(m.lastUpdated));
  const missingSeedMembers = SEED_MEMBER_NAMES.filter((name) => !data.members.some((m) => m.name === name));

  if (!loaded) {
    return (
      <div className="ct-app">
        <Style />
        <div className="ct-loading">Loading capacity board…</div>
      </div>
    );
  }

  return (
    <div className="ct-app">
      <Style />

      <header className="ct-header">
      <div className="ct-header-inner">

      {loadError && (
        <div className="ct-load-error">
          <AlertTriangle size={15} />
          <span>
            Couldn't connect to the team's saved data — you're viewing sample starting data, not your team's real data. Editing is paused until this reconnects, so nothing here can overwrite the real data.
          </span>
          <button type="button" className="ct-btn ct-btn-icon" onClick={loadData} title="Try reconnecting">
            Retry
          </button>
        </div>
      )}

      <div className="ct-topbar">
        <div className="ct-brand">
          <div className="ct-brand-mark">
            <Gauge size={20} strokeWidth={2} />
          </div>
          <div>
            <h1>Resource &amp; Project Allocation</h1>
            <p>Delta IT · Team allocation across projects</p>
          </div>
        </div>
        <div className="ct-topbar-actions">
          <span className={`ct-save ct-save-${saveState}`}>
            {saveState === "saving" ? "Saving…" : saveState === "saved" ? "Saved" : saveState === "error" ? "Save failed" : ""}
          </span>
          <nav className="ct-header-links" aria-label="Board actions">
            {addingMember ? (
              <div className="ct-inline-form">
                <input
                  autoFocus
                  placeholder="Teammate name"
                  value={newMemberName}
                  onChange={(e) => setNewMemberName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      addMember(newMemberName);
                    } else if (e.key === "Escape") {
                      setAddingMember(false);
                      setNewMemberName("");
                    }
                  }}
                />
                <button type="button" className="ct-btn ct-btn-icon" onClick={() => addMember(newMemberName)}><Check size={15} /></button>
                <button type="button" className="ct-btn ct-btn-icon" onClick={() => { setAddingMember(false); setNewMemberName(""); }}><X size={15} /></button>
              </div>
            ) : (
              <button type="button" className="ct-btn-add" onClick={() => setAddingMember(true)}>
                <Plus size={15} strokeWidth={2.2} /> Add teammate
              </button>
            )}
            <div className="ct-menu" ref={menuRef}>
              <button
                type="button"
                className="ct-menu-btn"
                aria-label="More actions"
                aria-haspopup="menu"
                aria-expanded={showMenu}
                onClick={() => setShowMenu((v) => !v)}
              >
                <MoreHorizontal size={18} />
              </button>
              {showMenu && (
                <div className="ct-menu-pop" role="menu">
                  <button
                    type="button"
                    role="menuitem"
                    className={showLinks ? "ct-menu-item ct-menu-item-on" : "ct-menu-item"}
                    onClick={() => {
                      setShowMenu(false);
                      setShowLinks((v) => !v);
                      setLinkNotice("");
                      if (!showLinks) loadLinks();
                    }}
                  >
                    <Link2 size={15} /> Update links
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    className={showBackups ? "ct-menu-item ct-menu-item-on" : "ct-menu-item"}
                    onClick={() => {
                      setShowMenu(false);
                      setShowBackups((v) => !v);
                      if (!showBackups) loadBackupsList();
                    }}
                  >
                    <History size={15} /> Backups
                  </button>
                  <button type="button" role="menuitem" className="ct-menu-item" onClick={() => { setShowMenu(false); createBackupNow(); }}>
                    <Archive size={15} /> Create backup now
                  </button>
                  <div className="ct-menu-sep" role="separator" />
                  <button type="button" role="menuitem" className="ct-menu-item" onClick={() => { setShowMenu(false); exportData(); }} title="Download the current board as a JSON file you keep">
                    <Download size={15} /> Export board
                  </button>
                  <button type="button" role="menuitem" className="ct-menu-item" onClick={() => { setShowMenu(false); triggerImport(); }} title="Restore the board from a previously exported JSON file">
                    <Upload size={15} /> Import board
                  </button>
                  <div className="ct-menu-sep" role="separator" />
                  <button type="button" role="menuitem" className="ct-menu-item" onClick={() => { setShowMenu(false); setShowNetworkDiagram(true); }}>
                    <Network size={15} /> Network diagram
                  </button>
                </div>
              )}
            </div>
            <input
              type="file"
              accept="application/json"
              ref={fileInputRef}
              onChange={handleImportFile}
              style={{ display: "none" }}
            />
          </nav>
        </div>
      </div>

      <>
      <nav className="ct-nav" aria-label="Main">
        <div className="ct-tabs">
          {[
            { id: "dashboard", label: "Dashboard", icon: Gauge },
            { id: "selfserve", label: "Update allocations", icon: Pencil },
            { id: "trends", label: "Trends", icon: TrendingUp },
            { id: "manageProjects", label: "Projects", icon: FolderCog },
            { id: "interfaces", label: "Interfaces", icon: Network },
          ].map((tab) => {
            const Icon = tab.icon;
            const active = mode === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                className={active ? "ct-tab ct-tab-active" : "ct-tab"}
                aria-current={active ? "page" : undefined}
                onClick={() => {
                  setMode(tab.id);
                  if (tab.id === "dashboard" || tab.id === "selfserve") setSelfServeSubmitted(false);
                }}
              >
                <Icon size={15} strokeWidth={2} /> {tab.label}
              </button>
            );
          })}
        </div>

        <div className="ct-nav-utils">
          {missingSeedMembers.length > 0 && (
            <button
              type="button"
              className="ct-util ct-util-warn"
              onClick={restoreMissingMembers}
              title={`Missing: ${missingSeedMembers.join(", ")}`}
            >
              <Plus size={13} /> Restore team ({missingSeedMembers.length})
            </button>
          )}
        </div>
      </nav>

      {restoreNotice && (
        <div className="ct-restore-notice">
          <Check size={13} /> {restoreNotice}
          <button type="button" className="ct-restore-notice-close" onClick={() => setRestoreNotice("")}>
            <X size={12} />
          </button>
        </div>
      )}

      {showBackups && (
        <div className="ct-panel ct-backups-panel">
          <h2>Recovery snapshots</h2>
          <p className="ct-hint" style={{ marginBottom: 10 }}>
            The board automatically saves a snapshot after every change. If something ever looks wrong, you can jump back to any of the last {MAX_BACKUPS} recovery points below.
          </p>
          {backupsLoading ? (
            <p className="ct-hint">Loading snapshots…</p>
          ) : backupsList.length === 0 ? (
            <p className="ct-hint">No snapshots yet — they'll appear here after your first change.</p>
          ) : (
            <div className="ct-backups-list">
              {backupsList.map((b) => {
                const label = new Date(b.ts).toLocaleString();
                return (
                  <div key={b.key} className="ct-backups-row">
                    <span>{label}</span>
                    <button type="button" className="ct-btn ct-btn-icon" onClick={() => restoreBackup(b.key, label)}>
                      Restore
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {showLinks && (
        <div className="ct-panel ct-backups-panel">
          <h2>Teammates &amp; update links</h2>
          <p className="ct-hint" style={{ marginBottom: 10 }}>
            Each analyst gets their own link to update their allocation, with no password. A link can only change that
            person's numbers. Copying a link also logs today as an update request. If a link is shared by mistake, make a
            new one and the old one stops working. Remove deletes a teammate and all their data for good.
          </p>
          {linkNotice && (
            <p className="ct-hint ct-links-notice">
              <Check size={13} /> {linkNotice}
            </p>
          )}
          {linksError && <p className="ct-hint ct-links-error">{linksError}</p>}
          {linksLoading ? (
            <p className="ct-hint">Loading links…</p>
          ) : (
            <div className="ct-backups-list">
              {data.members.map((m) => {
                const hasLink = Boolean(links[m.id]);
                return (
                  <div key={m.id} className="ct-backups-row">
                    <span>
                      {m.name}
                      {!hasLink && <span className="ct-links-none"> (no link yet)</span>}
                    </span>
                    <span className="ct-links-actions">
                      {hasLink && (
                        <button type="button" className="ct-btn ct-btn-icon" onClick={() => copyLink(m)}>
                          Copy link
                        </button>
                      )}
                      <button type="button" className="ct-btn ct-btn-icon" onClick={() => changeLink(m, "create")}>
                        {hasLink ? "New link" : "Create link"}
                      </button>
                      {hasLink && (
                        <button type="button" className="ct-btn ct-btn-icon" onClick={() => changeLink(m, "revoke")}>
                          Turn off
                        </button>
                      )}
                      <button type="button" className="ct-btn ct-btn-icon ct-btn-remove" onClick={() => removeMember(m)}>
                        Remove
                      </button>
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
      </>

      </div>
      </header>

      <div className="ct-content-wrap">

      {mode === "selfserve" ? (
        <SelfServeForm
          data={data}
          selfServeUserId={selfServeUserId}
          setSelfServeUserId={setSelfServeUserId}
          setAllocation={setAllocation}
          setLastUpdated={setLastUpdated}
          totalFor={totalFor}
          statusColor={statusColor}
          saveState={saveState}
          submitted={selfServeSubmitted}
          setSubmitted={setSelfServeSubmitted}
          formatDate={formatDate}
          isRequestPending={isRequestPending}
        />
      ) : mode === "manageProjects" ? (
        <ProjectsManager
          data={data}
          addProject={addProject}
          retireProject={retireProject}
          reactivateProject={reactivateProject}
          projectTotal={projectTotal}
          recolorProjectsByGroup={recolorProjectsByGroup}
          formatDate={formatDate}
        />
      ) : mode === "trends" ? (
        <TrendsView data={data} statusColor={statusColor} />
      ) : mode === "interfaces" ? (
        <InterfacesView members={data.members} />
      ) : (
      <>
      {data.members.length === 0 ? (
        <div className="ct-empty">Add your first teammate to start tracking allocation.</div>
      ) : (
        <>

          <section className="ct-panel">
            <div className="ct-identity-row">
              <div className="ct-identity">
                <label htmlFor="ct-who">View resource</label>
                <select id="ct-who" value={currentUserId} onChange={(e) => selectUser(e.target.value)}>
                  <option value="">Team overview</option>
                  {data.members.map((m) => (
                    <option key={m.id} value={m.id}>{m.name}</option>
                  ))}
                </select>
              </div>
              <div className="ct-identity">
                <label htmlFor="ct-proj-select">View project</label>
                <select
                  id="ct-proj-select"
                  value={selectedProjectId}
                  onChange={(e) => setSelectedProjectId(e.target.value)}
                >
                  <option value="">Choose a project…</option>
                  {activeProjects.map((p) => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </select>
              </div>
            </div>

            {currentUser && (
              <div className="ct-editor">
                <div className="ct-editor-head">
                  <h3>{currentUser.name}'s allocation</h3>
                  <span style={{ color: statusColor(totalFor(currentUser.id)) }} className="ct-total">
                    {totalFor(currentUser.id)}%
                  </span>
                </div>

                <div className="ct-updated-row">
                  <label htmlFor="ct-updated">Last updated</label>
                  <input
                    id="ct-updated"
                    type="date"
                    value={currentUser.lastUpdated || ""}
                    onChange={(e) => setLastUpdated(currentUser.id, e.target.value)}
                  />
                  <span className="ct-req-sep">Last requested</span>
                  <span className="ct-req-date">
                    {currentUser.lastRequested ? formatDate(currentUser.lastRequested) : "never"}
                    {currentUser.lastRequested && !isRequestPending(currentUser) && (
                      <span className="ct-req-fulfilled"> · fulfilled</span>
                    )}
                  </span>
                  <button
                    type="button"
                    className="ct-btn ct-btn-icon ct-req-btn"
                    onClick={() => requestUpdate(currentUser.id)}
                    title="Log that an update was requested today"
                  >
                    <Bell size={13} />
                  </button>
                </div>

                {activeProjects.length === 0 ? (
                  <p className="ct-hint">Add a project below to allocate time against it.</p>
                ) : (
                  <div className="ct-alloc-cards">
                    {sortProjectsForResource(activeProjects, data.allocations[currentUser.id]).map((p) => {
                      const val = (data.allocations[currentUser.id] || {})[p.id] || 0;
                      return (
                        <AllocCard
                          key={p.id}
                          project={p}
                          value={val}
                          onCommit={(num) => setAllocation(currentUser.id, p.id, num)}
                        />
                      );
                    })}
                  </div>
                )}

                <AllocMessage total={totalFor(currentUser.id)} />
              </div>
            )}
            {selectedProject && (
              <div className="ct-editor">
                <div className="ct-editor-head">
                  <h3>
                    <span className="ct-dot" style={{ background: selectedProject.color, marginRight: 8, display: "inline-block" }} />
                    {selectedProject.name}
                  </h3>
                  <span className="ct-total">
                    {formatFTE(projectTotal(selectedProject.id))} FTE
                  </span>
                </div>

                {data.members.length === 0 ? (
                  <p className="ct-hint">Add a teammate to allocate time on this project.</p>
                ) : (
                  <div className="ct-sliders">
                    {sortedMembers.map((m) => {
                      const val = (data.allocations[m.id] || {})[selectedProject.id] || 0;
                      return (
                        <div key={m.id} className="ct-slider-row">
                          <span className="ct-dot" style={{ background: "transparent" }} />
                          <span className="ct-proj-name">{m.name}</span>
                          <input
                            type="range"
                            min={0}
                            max={100}
                            step={5}
                            value={val}
                            onChange={(e) => setAllocation(m.id, selectedProject.id, Number(e.target.value))}
                          />
                          <input
                            type="number"
                            min={0}
                            max={100}
                            className="ct-num"
                            value={val}
                            onChange={(e) => setAllocation(m.id, selectedProject.id, Number(e.target.value))}
                          />
                          <span className="ct-pct">%</span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </section>

          <section className="ct-panel">
            {activeProjects.length === 0 && (
              <p className="ct-hint">Add a project so allocation can be tracked against it.</p>
            )}
            <div className="ct-table-wrap">
              <table className="ct-table">
                <thead>
                  <tr>
                    <th className="ct-th-name">Project</th>
                    {sortedMembers.map((m) => {
                      const stale = isStale(m.lastUpdated);
                      const pending = isRequestPending(m);
                      return (
                        <th key={m.id} className={m.id === currentUserId ? "ct-th-proj ct-col-self" : "ct-th-proj"}>
                          <div className="ct-th-proj-inner">
                            <span className="ct-avatar" aria-hidden="true">{initialsFor(m.name)}</span>
                            <span className="ct-th-person" title={m.name}>
                              {m.name}
                              {m.id === currentUserId && <span className="ct-you-inline"> · you</span>}
                            </span>
                            <div className="ct-th-meta-row">
                              {stale ? (
                                <span className="ct-stale-pill" title="Stale: over 30 days since last update">
                                  <AlertTriangle size={11} /> {formatDate(m.lastUpdated)}
                                </span>
                              ) : (
                                <span className="ct-th-date" title="Last updated">{formatDate(m.lastUpdated)}</span>
                              )}
                              <button
                                type="button"
                                className={pending ? "ct-req-bell ct-req-bell-active" : "ct-req-bell"}
                                onClick={() => requestUpdate(m.id)}
                                aria-label={`Log an update request for ${m.name}`}
                                title={
                                  pending
                                    ? `Update requested ${formatDate(m.lastRequested)} — still waiting on them — click to log a new request`
                                    : m.lastRequested
                                    ? `Last requested ${formatDate(m.lastRequested)} — fulfilled — click to log a new request`
                                    : "Never requested — click to log a request"
                                }
                              >
                                <Bell size={12} />
                              </button>
                            </div>
                          </div>
                        </th>
                      );
                    })}
                    <th className="ct-th-demand" title="Full-time equivalent">FTE</th>
                  </tr>
                </thead>
                {projectGroups.map((g) => (
                  <tbody key={g.key} className="ct-group">
                    {g.multi && (
                      <tr className="ct-group-row">
                        <td colSpan={sortedMembers.length + 2}>
                          <span className="ct-group-label">
                            <span className="ct-dot" style={{ background: g.color }} />
                            {g.key}
                          </span>
                        </td>
                      </tr>
                    )}
                    {g.projects.map((p) => {
                      const pTotal = projectTotal(p.id);
                      return (
                        <tr key={p.id} className="ct-alloc-row">
                          <td className={g.multi ? "ct-td-name ct-td-name-grouped" : "ct-td-name"} title={p.name}>
                            {!g.multi && <span className="ct-dot" style={{ background: p.color }} />}
                            <span className="ct-td-name-text">{g.multi ? stripGroupPrefix(p.name) : p.name}</span>
                          </td>
                          {sortedMembers.map((m) => {
                            const val = (data.allocations[m.id] || {})[p.id] || 0;
                            return (
                              <td key={m.id} className={m.id === currentUserId ? "ct-td-cell ct-col-self" : "ct-td-cell"}>
                                {val ? <span className="ct-heat" style={heatStyle(val)}>{val}%</span> : null}
                              </td>
                            );
                          })}
                          <td className="ct-td-demand">
                            <span className="ct-fte-cell">
                              <span className="ct-fte-mini" aria-hidden="true">
                                <span style={{ width: `${maxProjectTotal ? (pTotal / maxProjectTotal) * 100 : 0}%`, background: p.color }} />
                              </span>
                              {formatFTE(pTotal)}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                ))}
                <tfoot>
                  <tr>
                    <td className="ct-td-name ct-foot-label">Total</td>
                    {sortedMembers.map((m) => {
                      const total = totalFor(m.id);
                      return (
                        <td key={m.id} className={m.id === currentUserId ? "ct-td-total ct-col-self" : "ct-td-total"}>
                          {total === 100 ? (
                            <span className="ct-total-ok"><Check size={12} strokeWidth={2.6} /> 100%</span>
                          ) : (
                            <span className={total > 100 ? "ct-total-flag ct-total-over" : "ct-total-flag"} title={total > 100 ? `${total - 100}% over capacity` : `${100 - total}% unallocated`}>
                              {total}%
                            </span>
                          )}
                        </td>
                      );
                    })}
                    <td className="ct-td-demand"></td>
                  </tr>
                </tfoot>
              </table>
            </div>
            <div className="ct-table-foot">
              <p className="ct-caption">FTE = full-time equivalent, the sum of allocated % on a project divided by 100.</p>
              <div className="ct-heat-legend" aria-label="Allocation color scale">
                <span>Allocation</span>
                {[10, 25, 45, 60, 70].map((v) => (
                  <span key={v} className="ct-heat ct-heat-sm" style={heatStyle(v)}>{v === 70 ? "70+" : v}</span>
                ))}
              </div>
            </div>
          </section>

          {activeProjects.length > 0 && (
            <section className="ct-panel">
              <h2>Project demand</h2>
              <div className="ct-projects">
                {sortedProjects.map((p) => (
                  <div key={p.id} className="ct-project-row">
                    <span className="ct-dot" style={{ background: p.color }} />
                    <span className="ct-proj-name" title={p.name}>{p.name}</span>
                    <div className="ct-demand-track">
                      <div
                        className="ct-demand-fill"
                        style={{
                          width: `${Math.min(100, (projectTotal(p.id) / (Math.max(data.members.length, 1) * 100)) * 100)}%`,
                          background: p.color,
                        }}
                      />
                    </div>
                    <span className="ct-fte">{formatFTE(projectTotal(p.id))} FTE</span>
                  </div>
                ))}
              </div>
            </section>
          )}

          {staleMembers.length > 0 && (
            <section className="ct-panel ct-alert-panel">
              <div className="ct-alert">
                <AlertTriangle size={15} />
                <span>
                  {staleMembers.length === 1 ? (
                    <><strong>{staleMembers[0].name}</strong> hasn't updated their allocation in over 30 days ({formatDate(staleMembers[0].lastUpdated)}).</>
                  ) : (
                    <>
                      {staleMembers.length} people haven't updated their allocation in over 30 days:{" "}
                      {staleMembers.map((m, i) => (
                        <span key={m.id}>
                          <strong>{m.name}</strong> ({formatDate(m.lastUpdated)}){i < staleMembers.length - 1 ? ", " : ""}
                        </span>
                      ))}
                    </>
                  )}
                </span>
              </div>
            </section>
          )}
        </>
      )}
      </>
      )}

      </div>

      {showNetworkDiagram && (
        <div className="ct-network-backdrop" onClick={() => setShowNetworkDiagram(false)}>
          <div className="ct-network-modal" onClick={(e) => e.stopPropagation()}>
            <div className="ct-network-modal-head">
              <h2>Deployment &amp; runtime architecture</h2>
              <button type="button" className="ct-btn ct-btn-icon" onClick={() => setShowNetworkDiagram(false)} aria-label="Close">
                <X size={16} />
              </button>
            </div>
            <div className="ct-diagram-visual">
              <NetworkDiagram />
              <p className="ct-diagram-caption">
                A push to GitHub triggers Cloudflare Workers Build, which runs the build and deploys the Worker.
                At runtime, the browser (behind the login) talks to the Worker, which serves the app and reads/writes the D1 database.
              </p>
              <p className="ct-diagram-caption" style={{ marginTop: 8 }}>
                The GitHub and Cloudflare accounts hosting this tool are owned and managed by Anthony Sole.
              </p>
            </div>
            <div className="ct-diagram-security">
              <div className="ct-diagram-security-title">Additional Security Details</div>
              <p className="ct-diagram-security-text">
                Every request is checked by the Cloudflare Worker before any page content is served. This check happens on
                the server, so it cannot be bypassed by viewing page source the way a password built into client-side
                JavaScript could be.
              </p>
              <p className="ct-diagram-security-text">
                The password itself is stored as a Cloudflare secret and never appears anywhere in the code or this
                repository. A correct password sets a session cookie (HttpOnly, Secure, SameSite=Lax) whose value is
                the session secret itself; the Worker checks this value on every request and keeps you signed in for
                30 days without re-entering the password.
              </p>
              <p className="ct-diagram-security-text">
                This is a single shared password for anyone who has it — there are no individual user accounts and no log
                of who signed in.
              </p>
              <p className="ct-diagram-security-text">
                The D1 database itself is not exposed to the internet directly — it's only reachable through the Worker's
                own code via a private binding, encrypted at rest by Cloudflare, and isolated to this Cloudflare account.
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function AllocCard({ project, value, onCommit }) {
  const [localValue, setLocalValue] = useState(String(value));

  useEffect(() => {
    setLocalValue(String(value));
  }, [value]);

  function commit() {
    const num = Number(localValue);
    if (!Number.isNaN(num)) {
      onCommit(num);
    } else {
      setLocalValue(String(value));
    }
  }

  return (
    <div className="ct-alloc-card">
      <div className="ct-alloc-card-top">
        <span className="ct-dot" style={{ background: project.color }} />
        <span className="ct-alloc-card-name" title={project.name}>{project.name}</span>
      </div>
      <div className="ct-alloc-card-bottom">
        <div className="ct-alloc-card-input">
          <input
            type="number"
            min={0}
            max={100}
            value={localValue}
            onChange={(e) => setLocalValue(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.currentTarget.blur();
              }
            }}
          />
          <span>%</span>
        </div>
      </div>
    </div>
  );
}

function NetworkDiagram() {
  const navy = "#003759";
  const teal = "#1F6F63";
  const amber = "#B9791F";

  return (
    <svg width="100%" viewBox="0 0 680 300" role="img" style={{ display: "block" }}>
      <title>Deployment and runtime architecture</title>
      <desc>
        GitHub repo pushes trigger Cloudflare Workers Build, which builds and deploys the Cloudflare
        Worker. At runtime, the browser talks to the Worker behind a login, which serves the app and
        reads/writes the D1 database.
      </desc>
      <defs>
        <marker id="ndArrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M2 1L8 5L2 9" fill="none" stroke="#FFFFFF" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </marker>
      </defs>

      <rect x="60" y="60" width="150" height="56" rx="8" fill="#FFFFFF" stroke="#c5ccd6" strokeWidth="1" />
      <text x="135" y="80" textAnchor="middle" fontSize="14" fontWeight="600" fill="#1B2320">GitHub repo</text>
      <text x="135" y="98" textAnchor="middle" fontSize="12" fill="#58635C">Source code</text>

      <rect x="270" y="60" width="220" height="56" rx="8" fill="#FFFFFF" stroke="#c5ccd6" strokeWidth="1" />
      <text x="380" y="80" textAnchor="middle" fontSize="14" fontWeight="600" fill="#1B2320">Cloudflare Workers Build</text>
      <text x="380" y="98" textAnchor="middle" fontSize="12" fill="#58635C">npm run build + deploy</text>

      <line x1="210" y1="88" x2="266" y2="88" stroke="#FFFFFF" strokeWidth="1" markerEnd="url(#ndArrow)" />
      <path d="M380,116 L380,158 L345,158 L345,196" fill="none" stroke="#FFFFFF" strokeWidth="1" markerEnd="url(#ndArrow)" />
      <text x="390" y="150" fontSize="12" fill="#FFFFFF">deploys</text>

      <rect x="60" y="200" width="140" height="56" rx="8" fill={navy} />
      <text x="130" y="220" textAnchor="middle" fontSize="14" fontWeight="600" fill="#FFFFFF">Browser</text>
      <text x="130" y="238" textAnchor="middle" fontSize="12" fill="rgba(255,255,255,0.8)">Login required</text>

      <rect x="250" y="200" width="190" height="56" rx="8" fill={teal} />
      <text x="345" y="220" textAnchor="middle" fontSize="14" fontWeight="600" fill="#FFFFFF">Cloudflare Worker</text>
      <text x="345" y="238" textAnchor="middle" fontSize="12" fill="rgba(255,255,255,0.85)">Auth, assets, API</text>

      <rect x="480" y="200" width="140" height="56" rx="8" fill={amber} />
      <text x="550" y="220" textAnchor="middle" fontSize="14" fontWeight="600" fill="#FFFFFF">D1 database</text>
      <text x="550" y="238" textAnchor="middle" fontSize="12" fill="rgba(255,255,255,0.85)">kv_store table</text>

      <line x1="200" y1="228" x2="246" y2="228" stroke="#FFFFFF" strokeWidth="1" markerStart="url(#ndArrow)" markerEnd="url(#ndArrow)" />
      <line x1="440" y1="228" x2="476" y2="228" stroke="#FFFFFF" strokeWidth="1" markerStart="url(#ndArrow)" markerEnd="url(#ndArrow)" />
    </svg>
  );
}

function AllocMessage({ total }) {
  if (total > 100) {
    return (
      <div className="ct-msg ct-msg-danger">
        <AlertTriangle size={14} /> {total - 100}% over capacity — trim an allocation.
      </div>
    );
  }
  if (total === 100) {
    return <div className="ct-msg ct-msg-ok">Fully allocated.</div>;
  }
  return <div className="ct-msg ct-msg-muted">{100 - total}% unallocated.</div>;
}

function ProjectsManager({ data, addProject, retireProject, reactivateProject, projectTotal, recolorProjectsByGroup, formatDate }) {
  const activeProjects = data.projects.filter((p) => !p.archived);
  const retiredProjects = data.projects.filter((p) => p.archived);
  const [name, setName] = useState("");
  const [confirmingRecolor, setConfirmingRecolor] = useState(false);
  const [recolorDone, setRecolorDone] = useState(false);

  function handleAdd() {
    addProject(name);
    setName("");
  }

  function handleConfirmRecolor() {
    recolorProjectsByGroup();
    setConfirmingRecolor(false);
    setRecolorDone(true);
  }

  return (
    <div className="ct-projects-manager">
      <section className="ct-panel">
        <div className="ct-panel-head-row">
          <h2>Manage projects</h2>
          {confirmingRecolor ? (
            <span className="ct-recolor-confirm">
              Recolor all projects by name group?
              <button type="button" className="ct-btn ct-btn-primary ct-btn-icon" onClick={handleConfirmRecolor}>
                Yes, recolor
              </button>
              <button type="button" className="ct-btn ct-btn-icon" onClick={() => setConfirmingRecolor(false)}>
                Cancel
              </button>
            </span>
          ) : (
            <button
              type="button"
              className="ct-btn ct-restore-btn"
              onClick={() => {
                setRecolorDone(false);
                setConfirmingRecolor(true);
              }}
              title="Give every project sharing a name prefix (like &quot;BN –&quot;) the same color"
            >
              <Palette size={14} /> Recolor by group
            </button>
          )}
        </div>
        {recolorDone && (
          <p className="ct-hint" style={{ color: "var(--c-teal)", marginTop: -4, marginBottom: 10 }}>
            <Check size={12} style={{ display: "inline", verticalAlign: "-1px" }} /> Done — a backup of the previous colors was saved automatically.
          </p>
        )}
        <p className="ct-hint" style={{ marginBottom: 14 }}>
          Add new projects or retire ones that are no longer live. Retiring a project takes it off the board and clears everyone's current allocation on it, but its past allocations stay visible in Trends.
        </p>

        <div className="ct-inline-form" style={{ marginBottom: 18 }}>
          <input
            autoFocus
            placeholder="New project name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                handleAdd();
              }
            }}
          />
          <button type="button" className="ct-btn ct-btn-icon" onClick={handleAdd} title="Add project">
            <Plus size={15} />
          </button>
        </div>

        {activeProjects.length === 0 ? (
          <p className="ct-hint">No live projects — add one above.</p>
        ) : (
          <div className="ct-projects-manage-list">
            {activeProjects.map((p) => (
              <div key={p.id} className="ct-backups-row">
                <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span className="ct-dot" style={{ background: p.color }} />
                  {p.name}
                  <span className="ct-hint" style={{ fontSize: 11.5 }}>
                    {formatFTE(projectTotal(p.id))} FTE
                  </span>
                </span>
                <button
                  type="button"
                  className="ct-btn ct-btn-icon"
                  onClick={() => retireProject(p.id, p.name)}
                  title={`Retire ${p.name}`}
                >
                  <X size={13} /> Retire
                </button>
              </div>
            ))}
          </div>
        )}

        {retiredProjects.length > 0 && (
          <>
            <h2 style={{ marginTop: 22 }}>Retired projects</h2>
            <p className="ct-hint" style={{ marginBottom: 10 }}>
              Hidden from the board, kept for history. Reactivate one to put it back on the board (allocations start at 0%).
            </p>
            <div className="ct-projects-manage-list">
              {retiredProjects.map((p) => (
                <div key={p.id} className="ct-backups-row ct-retired-row">
                  <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span className="ct-dot" style={{ background: p.color }} />
                    {p.name}
                    <span className="ct-retired-tag">Retired {p.archivedAt ? formatDate(p.archivedAt) : ""}</span>
                  </span>
                  <button
                    type="button"
                    className="ct-btn ct-btn-icon"
                    onClick={() => reactivateProject(p.id)}
                    title={`Reactivate ${p.name}`}
                  >
                    <Plus size={13} /> Reactivate
                  </button>
                </div>
              ))}
            </div>
          </>
        )}
      </section>
    </div>
  );
}

const RANGE_OPTIONS = [
  { value: "6", label: "Last 6 months" },
  { value: "12", label: "Last 12 months" },
  { value: "all", label: "All history" },
];

function formatShortDate(iso) {
  const [y, m, d] = String(iso).split("-");
  return y && m && d ? `${m}/${d}/${y.slice(2)}` : iso;
}

function TrendsView({ data, statusColor }) {
  const [view, setView] = useState("analyst"); // "analyst" | "project"
  const [memberId, setMemberId] = useState("");
  const [projectId, setProjectId] = useState("");
  const [range, setRange] = useState("12");

  const nowKey = currentMonthKey();
  const earliest = earliestUpdateMonth(data) || nowKey;
  const rangeStart = range === "all" ? earliest : addMonths(nowKey, -(Number(range) - 1));
  const start = rangeStart > earliest ? rangeStart : earliest;
  const months = monthRange(start <= nowKey ? start : nowKey, nowKey);

  const member = data.members.find((m) => m.id === memberId);
  const project = data.projects.find((p) => p.id === projectId);
  const projById = {};
  data.projects.forEach((p) => (projById[p.id] = p));
  const timelines = {};
  data.members.forEach((m) => (timelines[m.id] = memberTimeline(data, m.id, months)));

  // Live projects first, then retired, each alphabetical
  const projectOptions = [...data.projects].sort(
    (x, y) => Number(!!x.archived) - Number(!!y.archived) || x.name.localeCompare(y.name)
  );

  function pickMember(id) {
    setView("analyst");
    setMemberId(id);
  }

  function pickProject(id) {
    setView("project");
    setProjectId(id);
  }

  return (
    <div className="ct-trends">
      <section className="ct-panel">
        <div className="ct-panel-head-row">
          <h2>Allocation trends</h2>
          <div className="ct-identity-row" style={{ gap: 16 }}>
            <div className="ct-segmented" role="tablist" aria-label="Trend view">
              <button type="button" role="tab" aria-selected={view === "analyst"} className={view === "analyst" ? "ct-seg ct-seg-on" : "ct-seg"} onClick={() => setView("analyst")}>
                By analyst
              </button>
              <button type="button" role="tab" aria-selected={view === "project"} className={view === "project" ? "ct-seg ct-seg-on" : "ct-seg"} onClick={() => setView("project")}>
                By project
              </button>
            </div>
            {view === "project" && (
              <div className="ct-identity">
                <label htmlFor="ct-trend-proj">Project</label>
                <select id="ct-trend-proj" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
                  <option value="">All projects</option>
                  {projectOptions.map((p) => (
                    <option key={p.id} value={p.id}>{p.name}{p.archived ? " (retired)" : ""}</option>
                  ))}
                </select>
              </div>
            )}
            {(view === "project" || member) && (
            <div className="ct-identity">
              <label htmlFor="ct-trend-range">Range</label>
              <select id="ct-trend-range" value={range} onChange={(e) => setRange(e.target.value)}>
                {RANGE_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </div>
            )}
          </div>
        </div>

        {view === "analyst" ? (
        <p className="ct-hint" style={{ marginBottom: 12 }}>
          {member
            ? `Showing each update ${member.name} actually submitted, on the date they submitted it.`
            : "Choose a resource to see how their allocation has changed over time."}
        </p>
        ) : (
        <p className="ct-hint" style={{ marginBottom: 12 }}>
          Every update is kept. Each month shows the average split across that month, weighted by how many days each update was in effect, so analysts who update several times a month and those who update every other month are both counted fairly. Grey values were carried forward because no update was made that month.
          {earliest === nowKey && " History starts building from here, so trends will fill in as updates come in."}
        </p>
        )}

        {view === "analyst" && (
          <div className="ct-trend-people" role="group" aria-label="Choose a resource">
            {data.members.map((m) => {
              const on = m.id === memberId;
              return (
                <button
                  key={m.id}
                  type="button"
                  className={on ? "ct-trend-person ct-trend-person-on" : "ct-trend-person"}
                  aria-pressed={on}
                  onClick={() => setMemberId(on ? "" : m.id)}
                >
                  <span className="ct-trend-person-name">{m.name}</span>
                  <span className="ct-trend-person-date">
                    {m.lastUpdated ? `Updated ${formatShortDate(m.lastUpdated)}` : "No updates yet"}
                  </span>
                </button>
              );
            })}
          </div>
        )}

        {view === "analyst" ? (
          member ? (
            <MemberTrend data={data} member={member} months={months} projById={projById} statusColor={statusColor} />
          ) : null
        ) : project ? (
          <ProjectTrend data={data} project={project} months={months} timelines={timelines} onPickMember={pickMember} />
        ) : (
          <AllProjectsTrend data={data} months={months} timelines={timelines} projectOptions={projectOptions} onPick={pickProject} />
        )}
      </section>
    </div>
  );
}

// For one project, each analyst's % on it per month, plus whether that
// analyst actually updated that month (vs. carried forward).
function projectContributions(data, projectId, months, timelines) {
  return months.map((mk, i) => {
    const byMember = {};
    let total = 0;
    let anyRecorded = false;
    let anyData = false;
    data.members.forEach((m) => {
      const t = timelines[m.id][i];
      if (!t.alloc) return;
      anyData = true;
      const v = t.alloc[projectId] || 0;
      if (v) {
        byMember[m.id] = v;
        total += v;
        if (t.recorded) anyRecorded = true;
      }
    });
    return { month: mk, byMember, total, recorded: total === 0 || anyRecorded, anyData };
  });
}

// Allocations are whole percentage points, so round to the nearest 0.1 FTE
// using integer math. (pct / 100).toFixed(1) rounds some halves down, because
// values like 0.15 are stored as slightly less than 0.15 (15% showed 0.1 FTE).
// Halves round away from zero so positive and negative changes match.
function formatFTE(pctTotal) {
  const tenths = Math.sign(pctTotal) * Math.round(Math.abs(pctTotal) / 10);
  return (tenths / 10 || 0).toFixed(1);
}

function AllProjectsTrend({ data, months, timelines, projectOptions, onPick }) {
  const rows = projectOptions
    .map((p) => ({ p, cols: projectContributions(data, p.id, months, timelines) }))
    // Retired projects only appear if they had time logged in this range
    .filter((r) => !r.p.archived || r.cols.some((c) => c.total > 0));
  const last = (r) => r.cols[r.cols.length - 1].total;
  rows.sort((x, y) => Number(!!x.p.archived) - Number(!!y.p.archived) || last(y) - last(x) || x.p.name.localeCompare(y.p.name));

  const teamTotals = months.map((_, i) => rows.reduce((sum, r) => sum + r.cols[i].total, 0));

  return (
    <div className="ct-table-wrap">
      <table className="ct-trend-table">
        <thead>
          <tr>
            <th className="ct-trend-th-name">Project FTE</th>
            {months.map((mk) => (
              <th key={mk}>{formatMonth(mk)}</th>
            ))}
            <th title="Change in FTE from the first month to the latest month">Change</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ p, cols }) => {
            const firstCol = cols.find((c) => c.anyData);
            const deltaPct = firstCol ? last({ cols }) - firstCol.total : 0;
            const delta = deltaPct / 100;
            return (
              <tr key={p.id} className={p.archived ? "ct-trend-row-retired" : undefined}>
                <td className="ct-trend-td-name" title={p.name}>
                  <span className="ct-dot" style={{ background: p.color }} />
                  <button type="button" className="ct-trend-name-btn ct-td-name-text" onClick={() => onPick(p.id)} title={`See who worked on ${p.name}`}>
                    {p.name}
                  </button>
                  {p.archived && <span className="ct-retired-tag">Retired</span>}
                </td>
                {cols.map((c) => {
                  if (!c.anyData) return <td key={c.month} className="ct-trend-cell ct-trend-none">–</td>;
                  return (
                    <td
                      key={c.month}
                      className={c.recorded ? "ct-trend-cell" : "ct-trend-cell ct-trend-carried"}
                      title={c.recorded ? undefined : "Nobody on this project updated this month — carried forward"}
                    >
                      {c.total ? formatFTE(c.total) : <span className="ct-td-empty">–</span>}
                    </td>
                  );
                })}
                <td className="ct-trend-cell ct-trend-delta" style={{ color: delta > 0 ? "var(--c-teal)" : delta < 0 ? "var(--c-danger)" : "var(--ink-soft)" }}>
                  {deltaPct > 0 ? `+${formatFTE(deltaPct)}` : formatFTE(deltaPct)}
                </td>
              </tr>
            );
          })}
        </tbody>
        <tfoot>
          <tr>
            <td className="ct-trend-td-name ct-foot-label">Team total</td>
            {teamTotals.map((t, i) => (
              <td key={months[i]} className="ct-trend-cell ct-trend-total">{formatFTE(t)}</td>
            ))}
            <td />
          </tr>
        </tfoot>
      </table>
      <p className="ct-caption">FTE = sum of everyone's % on the project that month ÷ 100. Click a project to see who the time came from.</p>
    </div>
  );
}

function ProjectTrend({ data, project, months, timelines, onPickMember }) {
  const cols = projectContributions(data, project.id, months, timelines);
  const memberIds = data.members
    .map((m) => m.id)
    .filter((id) => cols.some((c) => c.byMember[id]));

  if (memberIds.length === 0) {
    return <p className="ct-hint">No time was logged against {project.name} in this range.</p>;
  }

  const lastCol = cols[cols.length - 1];
  const firstCol = cols.find((c) => c.anyData);
  memberIds.sort((a, b) => (lastCol.byMember[b] || 0) - (lastCol.byMember[a] || 0) || cols.reduce((s, c) => s + (c.byMember[b] || 0) - (c.byMember[a] || 0), 0));
  const memberById = {};
  data.members.forEach((m) => (memberById[m.id] = m));
  const colorFor = {};
  memberIds.forEach((id, i) => (colorFor[id] = PALETTE[i % PALETTE.length]));

  const series = memberIds.map((id) => ({ id, name: memberById[id].name, color: colorFor[id] }));
  const columns = cols.map((c) => ({ month: c.month, values: c.anyData ? c.byMember : null, recorded: c.recorded }));

  return (
    <>
      {project.archived && (
        <p className="ct-hint" style={{ marginBottom: 8 }}>
          <span className="ct-retired-tag" style={{ marginLeft: 0 }}>Retired {project.archivedAt ? formatMonth(monthKeyFromISO(project.archivedAt)) : ""}</span> No time is carried forward after the month it was retired.
        </p>
      )}
      <div className="ct-table-wrap">
        <table className="ct-trend-table">
          <thead>
            <tr>
              <th className="ct-trend-th-name">Analyst</th>
              {months.map((mk, i) => (
                <th key={mk} className={i === months.length - 1 ? "ct-trend-th-latest" : undefined}>
                  {formatMonth(mk)}
                  {i === months.length - 1 && <span className="ct-th-sub">Current</span>}
                </th>
              ))}
              <th title="Change from the first month with data to the latest month, in percentage points">Change</th>
            </tr>
          </thead>
          <tbody>
            {memberIds.map((id) => {
              const first = firstCol ? firstCol.byMember[id] || 0 : 0;
              const delta = (lastCol.byMember[id] || 0) - first;
              return (
                <tr key={id}>
                  <td className="ct-trend-td-name">
                    <span className="ct-dot" style={{ background: colorFor[id] }} />
                    <button type="button" className="ct-trend-name-btn" onClick={() => onPickMember(id)} title={`See ${memberById[id].name}'s full project mix`}>
                      {memberById[id].name}
                    </button>
                  </td>
                  {cols.map((c, i) => {
                    const t = timelines[id][i];
                    if (!t.alloc) return <td key={c.month} className="ct-trend-cell ct-trend-none">–</td>;
                    const v = c.byMember[id] || 0;
                    const prevT = i > 0 ? timelines[id][i - 1] : null;
                    const prev = prevT && prevT.alloc ? prevT.alloc[project.id] || 0 : null;
                    const changed = t.recorded && prev !== null && prev !== v;
                    const isLatest = i === cols.length - 1;
                    const cls = ["ct-trend-cell", isLatest ? "ct-trend-latest" : !t.recorded && "ct-trend-carried"].filter(Boolean).join(" ");
                    return (
                      <td key={c.month} className={cls} title={changed ? `Changed from ${prev}%` : undefined}>
                        {v ? `${v}%` : <span className="ct-td-empty">–</span>}
                        {changed && (
                          <span className={v > prev ? "ct-trend-arrow ct-trend-up" : "ct-trend-arrow ct-trend-down"} aria-label={`changed from ${prev}%`}>
                            {v > prev ? "▲" : "▼"}
                          </span>
                        )}
                      </td>
                    );
                  })}
                  <td className="ct-trend-cell ct-trend-delta" style={{ color: delta > 0 ? "var(--c-teal)" : delta < 0 ? "var(--c-danger)" : "var(--ink-soft)" }}>
                    {delta > 0 ? `+${delta}` : delta}
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr>
              <td className="ct-trend-td-name ct-foot-label">FTE</td>
              {cols.map((c, i) => {
                const isLatest = i === cols.length - 1;
                const cls = [
                  "ct-trend-cell ct-trend-total",
                  isLatest ? "ct-trend-latest" : "ct-trend-past",
                  !isLatest && !c.recorded && "ct-trend-carried",
                ].filter(Boolean).join(" ");
                return (
                  <td key={c.month} className={cls}>
                    {c.anyData ? formatFTE(c.total) : "–"}
                  </td>
                );
              })}
              <td />
            </tr>
          </tfoot>
        </table>
      </div>
      <p className="ct-caption">The latest month is in bold. Arrows mark values that went up or down from the month before. Click a name to see that analyst's full project mix.</p>

      <div className="ct-trend-chart-section">
      <TrendChart columns={columns} series={series} unit="fte" />

      <div className="ct-trend-legend">
        {series.map((sr) => (
          <span key={sr.id} className="ct-trend-legend-item">
            <span className="ct-dot" style={{ background: sr.color }} />
            {sr.name}
          </span>
        ))}
      </div>
      </div>
    </>
  );
}


function updateDateLabel(u) {
  return new Date(u.t).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "2-digit",
    timeZone: u.source === "import" ? "UTC" : undefined,
  });
}

function updateTimeLabel(u) {
  return new Date(u.t).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

// One column per update the analyst actually submitted, oldest to newest.
// Nothing is averaged or carried forward between updates.
function MemberTrend({ data, member, months, projById, statusColor }) {
  const [rangeStart] = monthBoundsMs(months[0]);
  const events = memberUpdates(data, member.id).filter((u) => u.t >= rangeStart);

  if (events.length === 0) {
    return <p className="ct-hint">No updates from {member.name} in this range yet.</p>;
  }

  const labelCounts = {};
  events.forEach((u) => {
    const l = updateDateLabel(u);
    labelCounts[l] = (labelCounts[l] || 0) + 1;
  });
  const cols = events.map((u) => {
    const label = updateDateLabel(u);
    return {
      key: `${u.at}-${u.source}`,
      label,
      time: labelCounts[label] > 1 && u.source !== "import" ? updateTimeLabel(u) : "",
      tooltip:
        u.source === "import"
          ? `${label}, from an earlier monthly snapshot`
          : `${label} at ${updateTimeLabel(u)}, ${UPDATE_SOURCE_LABELS[u.source] ? UPDATE_SOURCE_LABELS[u.source].toLowerCase() : u.source}`,
      alloc: u.alloc || {},
    };
  });
  const lastIdx = cols.length - 1;
  const latest = cols[lastIdx];
  const first = cols[0];

  const everSum = {};
  cols.forEach((c) => Object.entries(c.alloc).forEach(([pid, v]) => (everSum[pid] = (everSum[pid] || 0) + (v || 0))));
  const projectIds = Object.keys(everSum)
    .filter((pid) => projById[pid] && everSum[pid] > 0)
    .sort(
      (a, b) =>
        (latest.alloc[b] || 0) - (latest.alloc[a] || 0) ||
        everSum[b] - everSum[a] ||
        projById[a].name.localeCompare(projById[b].name)
    );

  return (
    <>
      <div className="ct-table-wrap">
        <table className="ct-trend-table">
          <thead>
            <tr>
              <th className="ct-trend-th-name">Project</th>
              {cols.map((c, i) => (
                <th key={c.key} className={i === lastIdx ? "ct-trend-th-latest" : undefined} title={c.tooltip}>
                  {c.label}
                  {(c.time || i === lastIdx) && (
                    <span className="ct-th-sub">{[c.time, i === lastIdx ? "Latest" : ""].filter(Boolean).join(", ")}</span>
                  )}
                </th>
              ))}
              <th title="Change from the first update shown to the latest update, in percentage points">Change</th>
            </tr>
          </thead>
          <tbody>
            {projectIds.map((pid) => {
              const p = projById[pid];
              const delta = (latest.alloc[pid] || 0) - (first.alloc[pid] || 0);
              return (
                <tr key={pid} className={p.archived ? "ct-trend-row-retired" : undefined}>
                  <td className="ct-trend-td-name" title={p.name}>
                    <span className="ct-dot" style={{ background: p.color }} />
                    <span className="ct-td-name-text">{p.name}</span>
                    {p.archived && <span className="ct-retired-tag">Retired</span>}
                  </td>
                  {cols.map((c, i) => {
                    const v = c.alloc[pid] || 0;
                    const prev = i > 0 ? cols[i - 1].alloc[pid] || 0 : null;
                    const changed = prev !== null && prev !== v;
                    return (
                      <td key={c.key} className={i === lastIdx ? "ct-trend-cell ct-trend-latest" : "ct-trend-cell"} title={changed ? `Changed from ${prev}%` : undefined}>
                        {v ? `${v}%` : <span className="ct-td-empty">–</span>}
                        {changed && (
                          <span className={v > prev ? "ct-trend-arrow ct-trend-up" : "ct-trend-arrow ct-trend-down"} aria-label={`changed from ${prev}%`}>
                            {v > prev ? "▲" : "▼"}
                          </span>
                        )}
                      </td>
                    );
                  })}
                  <td className="ct-trend-cell ct-trend-delta" style={{ color: delta > 0 ? "var(--c-teal)" : delta < 0 ? "var(--c-danger)" : "var(--ink-soft)" }}>
                    {delta > 0 ? `+${delta}` : delta}
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr>
              <td className="ct-trend-td-name ct-foot-label">Total</td>
              {cols.map((c, i) => {
                const total = sumAlloc(c.alloc);
                return (
                  <td
                    key={c.key}
                    className={i === lastIdx ? "ct-trend-cell ct-trend-total ct-trend-latest" : "ct-trend-cell ct-trend-total ct-trend-past"}
                    style={i === lastIdx ? { color: statusColor(total) } : undefined}
                  >
                    {total}%
                  </td>
                );
              })}
              <td />
            </tr>
          </tfoot>
        </table>
      </div>
      <p className="ct-caption">
        Each column is an update {member.name} actually submitted. The latest update is in bold. Arrows mark values that went up or down from the update before. Change compares the first update shown to the latest, in percentage points.
      </p>

      <div className="ct-trend-chart-section">
      <TrendChart
        columns={cols.map((c) => ({ month: c.key, label: c.label, values: c.alloc, recorded: true }))}
        series={projectIds.map((pid) => ({ id: pid, name: projById[pid].name, color: projById[pid].color, hatched: !!projById[pid].archived }))}
        unit="pct"
      />

      <div className="ct-trend-legend">
        {projectIds.map((pid) => {
          const p = projById[pid];
          return (
            <span key={pid} className={p.archived ? "ct-trend-legend-item ct-trend-legend-retired" : "ct-trend-legend-item"}>
              <span className="ct-dot" style={{ background: p.color }} />
              {p.name}
              {p.archived && <span className="ct-retired-tag">Retired</span>}
            </span>
          );
        })}
      </div>
      </div>

      <UpdateLog data={data} member={member} months={months} projById={projById} statusColor={statusColor} />
    </>
  );
}

const UPDATE_SOURCE_LABELS = {
  board: "On the board",
  form: "Personal update link",
  import: "From earlier monthly snapshot",
};

// Every dated update this analyst made in the selected range, newest first.
function UpdateLog({ data, member, months, projById, statusColor }) {
  const [rangeStart] = monthBoundsMs(months[0]);
  const entries = memberUpdates(data, member.id)
    .filter((u) => u.t >= rangeStart)
    .reverse();

  return (
    <div className="ct-update-log">
      <h3>Update log</h3>
      {entries.length === 0 ? (
        <p className="ct-hint">No updates from {member.name} in this range.</p>
      ) : (
        <div className="ct-table-wrap">
          <table className="ct-trend-table ct-update-log-table">
            <thead>
              <tr>
                <th className="ct-trend-th-name">Date</th>
                <th>Total</th>
                <th className="ct-update-log-split">Split</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((u) => {
                const total = sumAlloc(u.alloc);
                const when = new Date(u.t);
                const isImport = u.source === "import";
                const parts = Object.entries(u.alloc || {})
                  .filter(([pid, v]) => v && projById[pid])
                  .sort((a, b) => b[1] - a[1]);
                return (
                  <tr key={`${u.at}-${u.source}`}>
                    <td className="ct-trend-td-name">
                      <span className="ct-update-log-date">
                        {isImport
                          ? when.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })
                          : when.toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" })}
                      </span>
                      <span className="ct-update-log-source">{UPDATE_SOURCE_LABELS[u.source] || u.source}</span>
                    </td>
                    <td className="ct-trend-cell" style={{ color: statusColor(total) }}>{total}%</td>
                    <td className="ct-update-log-split">
                      {parts.length === 0 ? (
                        <span className="ct-td-empty">No time on any project</span>
                      ) : (
                        parts.map(([pid, v]) => (
                          <span key={pid} className="ct-update-log-chip" title={projById[pid].name}>
                            <span className="ct-dot" style={{ background: projById[pid].color }} />
                            {projById[pid].name} {v}%
                          </span>
                        ))
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// Stacked monthly bars. columns: [{ month, values: {seriesId: pct} | null, recorded }]
// series: [{ id, name, color, hatched }] in stacking order (bottom first).
// unit "pct" labels bars as % with a dashed 100% capacity line; "fte" labels as FTE.
function TrendChart({ columns, series, unit }) {
  const W = 760;
  const H = 240;
  const padL = 40;
  const padR = 12;
  const padT = 22;
  const padB = 26;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const isFte = unit === "fte";
  const maxTotal = Math.max(isFte ? 25 : 100, ...columns.map((c) => sumAlloc(c.values)));
  const step = isFte ? (maxTotal > 400 ? 100 : 50) : maxTotal > 150 ? 50 : 25;
  const yMax = Math.ceil(maxTotal / step) * step;
  const slot = plotW / columns.length;
  const barW = Math.min(46, slot * 0.62);
  const y = (v) => padT + plotH - (v / yMax) * plotH;
  const fmt = (v) => (isFte ? formatFTE(v) : `${v}%`);
  const ticks = [];
  for (let v = 0; v <= yMax; v += step) ticks.push(v);
  // With many columns, label every nth one (always the latest) so text doesn't overlap.
  const labelEvery = Math.ceil(columns.length / 12);
  const showLabel = (i) => i === columns.length - 1 || (i % labelEvery === 0 && columns.length - 1 - i >= labelEvery);

  return (
    <div className="ct-trend-chart">
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label={isFte ? "Monthly FTE by analyst" : "Monthly allocation by project"}>
        <defs>
          <pattern id="ctRetiredHatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <line x1="0" y1="0" x2="0" y2="6" stroke="rgba(255,255,255,0.55)" strokeWidth="2.5" />
          </pattern>
        </defs>
        {ticks.map((v) => {
          const capacity = !isFte && v === 100;
          return (
            <g key={v}>
              <line x1={padL} x2={W - padR} y1={y(v)} y2={y(v)} stroke={capacity ? "#58635C" : "#E3E5DD"} strokeDasharray={capacity ? "4 3" : undefined} strokeWidth="1" />
              <text x={padL - 6} y={y(v) + 4} textAnchor="end" fontSize="11" fill="#58635C">{fmt(v)}</text>
            </g>
          );
        })}
        {columns.map((c, i) => {
          const cx = padL + slot * i + slot / 2;
          const x = cx - barW / 2;
          let acc = 0;
          const total = sumAlloc(c.values);
          return (
            <g key={c.month} opacity={c.recorded || i === columns.length - 1 ? 1 : 0.45}>
              {c.values &&
                series.map((sr) => {
                  const v = c.values[sr.id] || 0;
                  if (!v) return null;
                  const top = y(acc + v);
                  const h = y(acc) - top;
                  acc += v;
                  return (
                    <g key={sr.id}>
                      <rect x={x} y={top} width={barW} height={h} fill={sr.color} stroke="#fff" strokeWidth="1" />
                      {sr.hatched && <rect x={x} y={top} width={barW} height={h} fill="url(#ctRetiredHatch)" />}
                      <title>{`${c.label || formatMonth(c.month)} · ${sr.name}${sr.hatched ? " (retired)" : ""}: ${v}%`}</title>
                    </g>
                  );
                })}
              {c.values && total > 0 && (
                <text x={cx} y={y(total) - 6} textAnchor="middle" fontSize="11" fontWeight={i === columns.length - 1 ? "700" : "400"} fill={i === columns.length - 1 ? "#1B2320" : "#58635C"}>{fmt(total)}</text>
              )}
              <text x={cx} y={H - 8} textAnchor="middle" fontSize="11" fontWeight={i === columns.length - 1 ? "700" : "400"} fill={i === columns.length - 1 ? "#1B2320" : "#58635C"}>{showLabel(i) ? c.label || formatMonth(c.month) : ""}</text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function SelfServeForm({
  data,
  selfServeUserId,
  setSelfServeUserId,
  setAllocation,
  setLastUpdated,
  totalFor,
  statusColor,
  saveState,
  submitted,
  setSubmitted,
  formatDate,
  isRequestPending,
}) {
  const user = data.members.find((m) => m.id === selfServeUserId);
  const activeProjects = data.projects.filter((p) => !p.archived);

  function handleDateChange(dateStr) {
    setLastUpdated(user.id, dateStr);
  }

  return (
    <div className="ct-selfserve">
      <section className="ct-panel ct-selfserve-panel">
        <h2>Update my allocation</h2>
        <p className="ct-hint" style={{ marginBottom: 16 }}>
          Pick your name, adjust your time on each project, then hit Submit. Your changes save straight to the team board.
        </p>

        <div className="ct-identity">
          <label htmlFor="ct-selfserve-who">I am</label>
          <select
            id="ct-selfserve-who"
            value={selfServeUserId}
            onChange={(e) => {
              setSelfServeUserId(e.target.value);
              setSubmitted(false);
            }}
          >
            <option value="">Select your name…</option>
            {data.members.map((m) => (
              <option key={m.id} value={m.id}>{m.name}</option>
            ))}
          </select>
        </div>

        {!user && (
          <p className="ct-hint" style={{ marginTop: 16 }}>
            Don't see your name? Ask whoever manages the board to add you first.
          </p>
        )}

        {user && (
          <div className="ct-editor">
            <div className="ct-editor-head">
              <h3>{user.name}'s allocation</h3>
              <span style={{ color: statusColor(totalFor(user.id)) }} className="ct-total">
                {totalFor(user.id)}%
              </span>
            </div>

            {isRequestPending(user) && (
              <p className="ct-hint" style={{ marginBottom: 10 }}>
                An update was requested from you on {formatDate(user.lastRequested)}.
              </p>
            )}

            {activeProjects.length === 0 ? (
              <p className="ct-hint">No projects have been added yet.</p>
            ) : (
              <div className="ct-alloc-cards">
                {sortProjectsForResource(activeProjects, data.allocations[user.id]).map((p) => {
                  const val = (data.allocations[user.id] || {})[p.id] || 0;
                  return (
                    <AllocCard
                      key={p.id}
                      project={p}
                      value={val}
                      onCommit={(num) => {
                        setAllocation(user.id, p.id, num);
                        setSubmitted(false);
                      }}
                    />
                  );
                })}
              </div>
            )}

            <AllocMessage total={totalFor(user.id)} />

            <div className="ct-selfserve-submitrow">
              <button
                className="ct-btn ct-btn-primary"
                onClick={() => setSubmitted(true)}
              >
                <Check size={15} /> Submit
              </button>
              {submitted && saveState !== "saving" && (
                <span className="ct-selfserve-confirm">
                  <Check size={13} /> Saved — thanks, {user.name}!
                </span>
              )}
              {submitted && saveState === "saving" && (
                <span className="ct-selfserve-confirm">Saving…</span>
              )}
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

function Style() {
  return (
    <style>{`
      .ct-app {
        --bg: #F6F4EF;
        --surface: #FFFFFF;
        --ink: #15181D;
        --ink-soft: #6B6760;
        --line: #E4E0D8;
        --c-teal: #1F6B5C;
        --c-amber: #96600F;
        --c-danger: #B03A2E;
        font-family: "Inter", -apple-system, "Segoe UI", sans-serif;
        font-variant-numeric: tabular-nums;
        -webkit-font-smoothing: antialiased;
        color: var(--ink);
        background: var(--bg);
        width: 100%;
        min-height: 100vh;
        margin: 0;
        zoom: 1.2;
      }
      .ct-app * { box-sizing: border-box; }
      .ct-content-wrap {
        max-width: 1600px;
        margin: 0 auto;
        padding: 18px;
      }
      .ct-header {
        background: #334249;
        width: 100%;
        padding: 18px 18px 0;
      }
      .ct-nav {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px 20px;
        flex-wrap: wrap;
        margin-top: 16px;
        border-top: 1px solid rgba(255,255,255,0.09);
      }
      .ct-tabs { display: flex; gap: 2px; overflow-x: auto; scrollbar-width: none; margin-left: -12px; }
      .ct-tabs::-webkit-scrollbar { display: none; }
      .ct-tab {
        position: relative;
        display: inline-flex;
        align-items: center;
        gap: 7px;
        padding: 13px 12px 14px;
        background: none;
        border: none;
        color: rgba(255,255,255,0.62);
        font: inherit;
        font-size: 13.5px;
        font-weight: 500;
        cursor: pointer;
        white-space: nowrap;
        transition: color 0.15s;
      }
      .ct-tab::after {
        content: "";
        position: absolute;
        left: 12px;
        right: 12px;
        bottom: 0;
        height: 3px;
        border-radius: 3px 3px 0 0;
        background: #9AC6E2;
        transform: scaleX(0);
        transition: transform 0.2s ease;
      }
      .ct-tab:hover { color: rgba(255,255,255,0.92); }
      .ct-tab-active { color: #fff; }
      .ct-tab-active::after { transform: scaleX(1); }
      .ct-tab:focus-visible { outline: 2px solid #9AC6E2; outline-offset: -4px; border-radius: 6px; }
      .ct-nav-utils { display: flex; align-items: center; gap: 18px; padding: 8px 0; }
      .ct-util {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        background: none;
        border: none;
        padding: 2px 0;
        font: inherit;
        font-size: 12.5px;
        color: rgba(255,255,255,0.55);
        cursor: pointer;
        transition: color 0.15s;
      }
      .ct-util:hover, .ct-util-on { color: #fff; }
      .ct-util-warn { color: #F2C46D; }
      .ct-util-warn:hover { color: #FFDC94; }
      .ct-util:focus-visible { outline: 2px solid #9AC6E2; outline-offset: 3px; border-radius: 2px; }
      .ct-header .ct-restore-notice { margin: 6px 0 14px; }
      .ct-header .ct-backups-panel { margin: 6px 0 16px; }
      @media (prefers-reduced-motion: reduce) {
        .ct-tab::after, .ct-tab, .ct-util { transition: none; }
      }
      .ct-header-inner {
        max-width: 1600px;
        margin: 0 auto;
      }
      .ct-header .ct-brand h1 { color: #fff; }
      .ct-header .ct-brand p { color: #FFFFFF; }
      .ct-header .ct-save { color: rgba(255,255,255,0.78); }
      .ct-loading { padding: 40px; text-align: center; color: var(--ink-soft); }
      .ct-load-error {
        display: flex;
        align-items: center;
        gap: 10px;
        background: #FBEBE9;
        border: 1px solid #F3C9C5;
        color: var(--c-danger);
        border-radius: 10px;
        padding: 10px 14px;
        font-size: 12.5px;
        line-height: 1.4;
        margin-bottom: 14px;
      }
      .ct-load-error svg { flex-shrink: 0; }
      .ct-load-error span { flex: 1; }
      .ct-load-error button { border: 1px solid var(--c-danger); color: var(--c-danger); background: #fff; flex-shrink: 0; }
      .ct-load-error button:hover { background: var(--c-danger); color: #fff; }
      .ct-restore-notice {
        display: flex;
        align-items: center;
        gap: 8px;
        background: #E6F1EE;
        color: var(--c-teal);
        border: 1px solid #BFE0D6;
        border-radius: 10px;
        padding: 8px 12px;
        font-size: 12.5px;
        margin: 10px 0;
      }
      .ct-restore-notice-close { margin-left: auto; background: none; border: none; color: var(--c-teal); cursor: pointer; padding: 2px; }
      .ct-backups-panel { margin-top: 12px; }
      .ct-backups-list { display: flex; flex-direction: column; gap: 6px; max-height: 260px; overflow-y: auto; }
      .ct-trend-latest { font-weight: 700; color: var(--ink); }
      .ct-trend-table th.ct-trend-th-latest { color: var(--ink); font-weight: 700; }
      .ct-trend-total.ct-trend-past { font-weight: 400; }
      .ct-trend-arrow { font-size: 8px; margin-left: 3px; vertical-align: 1px; }
      .ct-trend-up { color: var(--c-teal); }
      .ct-trend-down { color: var(--c-danger); }
      .ct-th-sub { display: block; font-size: 10.5px; font-weight: 400; color: var(--ink-soft); margin-top: 2px; }
      .ct-update-log { margin-top: 22px; }
      .ct-update-log h3 { font-family: "Fraunces", Georgia, serif; font-size: 14px; margin: 0 0 8px; }
      .ct-update-log-date { display: block; white-space: nowrap; }
      .ct-update-log-source { display: block; font-size: 11.5px; color: var(--ink-soft); }
      .ct-update-log-table td, .ct-update-log-table th { vertical-align: top; }
      .ct-trend-table .ct-update-log-split { text-align: left; white-space: normal; min-width: 280px; }
      .ct-update-log-chip { display: inline-flex; align-items: center; gap: 5px; margin: 2px 10px 2px 0; font-size: 12.5px; white-space: nowrap; }
      .ct-links-actions { display: flex; gap: 6px; flex-wrap: wrap; justify-content: flex-end; }
      .ct-links-none { color: var(--ink-soft); }
      .ct-btn.ct-btn-remove { color: var(--c-danger); }
      .ct-btn.ct-btn-remove:hover { border-color: var(--c-danger); background: #FBEDEC; }
      .ct-links-notice { display: flex; align-items: center; gap: 6px; color: var(--c-teal); margin-bottom: 8px; }
      .ct-links-error { color: var(--c-danger); margin-bottom: 8px; }
      .ct-backups-row { display: flex; align-items: center; justify-content: space-between; padding: 8px 10px; border: 1px solid var(--line); border-radius: 8px; font-size: 12.5px; }
      .ct-topbar { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; flex-wrap: wrap; }
      .ct-brand { display: flex; align-items: center; gap: 10px; }
      .ct-brand-mark { width: 36px; height: 36px; border-radius: 8px; background: var(--c-teal); color: #fff; display: flex; align-items: center; justify-content: center; }
      .ct-brand h1 { font-family: "Fraunces", Georgia, serif; font-size: 19px; line-height: 1.25; margin: 0; letter-spacing: -0.01em; max-width: 420px; }
      .ct-brand p { margin: 2px 0 0; font-size: 13px; color: var(--ink-soft); }
      .ct-topbar-actions { display: flex; align-items: center; gap: 12px; }
      .ct-topbar-actions { margin-left: auto; flex-wrap: wrap; justify-content: flex-end; }
      .ct-header-links { display: flex; align-items: center; gap: 18px; }
      .ct-link { background: none; border: none; padding: 2px 0; font: inherit; font-size: 13px; font-weight: 500; color: #fff; cursor: pointer; text-decoration: underline; text-decoration-color: transparent; text-underline-offset: 3px; transition: text-decoration-color 0.15s; }
      .ct-link:hover { text-decoration-color: currentColor; }
      .ct-link:focus-visible { outline: 2px solid #9AC6E2; outline-offset: 3px; border-radius: 2px; }
      .ct-restore-btn { background: #FDF3E3; border-color: var(--c-amber); color: #8A5A12; font-weight: 500; }
      .ct-restore-btn:hover { background: #FBEAC8; }
      .ct-selfserve { width: 100%; }
      .ct-projects-manager { width: 100%; }
      .ct-projects-manage-list { display: flex; flex-direction: column; gap: 6px; }
      .ct-selfserve-panel h2 { margin-bottom: 4px; }
      .ct-selfserve-submitrow { display: flex; align-items: center; gap: 12px; margin-top: 16px; }
      .ct-btn-primary { background: var(--c-teal); color: #fff; border-color: var(--c-teal); font-weight: 500; padding: 9px 16px; }
      .ct-btn-primary:hover { background: #185349; border-color: #185349; }
      .ct-selfserve-confirm { display: inline-flex; align-items: center; gap: 5px; font-size: 12.5px; color: var(--c-teal); font-weight: 500; }
      .ct-save { font-size: 12px; color: var(--ink-soft); font-family: inherit; }
      .ct-save-error { color: var(--c-danger); }
      .ct-retired-tag { font-size: 10.5px; font-weight: 500; color: var(--ink-soft); background: #EEF0EA; border: 1px solid var(--line); border-radius: 999px; padding: 1px 7px; margin-left: 6px; white-space: nowrap; }
      .ct-retired-row { color: var(--ink-soft); }
      .ct-trend-chart { margin: 4px 0 8px; }
      .ct-trend-chart-section { margin-top: 22px; padding-top: 18px; border-top: 1px solid var(--line); }
      .ct-segmented { display: inline-flex; border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
      .ct-seg { background: var(--surface); border: none; padding: 6px 12px; font: inherit; font-size: 13px; color: var(--ink-soft); cursor: pointer; }
      .ct-seg + .ct-seg { border-left: 1px solid var(--line); }
      .ct-seg-on { background: var(--c-teal); color: #fff; }
      .ct-seg:focus-visible { outline: 2px solid var(--c-teal); outline-offset: -2px; }
      .ct-trend-legend { display: flex; flex-wrap: wrap; gap: 6px 16px; font-size: 12.5px; margin: 0 0 14px; }
      .ct-trend-legend-item { display: inline-flex; align-items: center; gap: 6px; }
      .ct-trend-legend-retired { color: var(--ink-soft); }
      .ct-trend-people { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 8px; margin: 4px 0 14px; }
      .ct-trend-person { display: flex; flex-direction: column; align-items: flex-start; gap: 2px; text-align: left; background: var(--surface); border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px; font-family: inherit; color: var(--ink); cursor: pointer; transition: border-color 0.15s, background 0.15s; }
      .ct-trend-person:hover { border-color: var(--c-teal); }
      .ct-trend-person:focus-visible { outline: 2px solid var(--c-teal); outline-offset: 1px; }
      .ct-trend-person-on { background: var(--c-teal); border-color: var(--c-teal); color: #fff; }
      .ct-trend-person-name { font-family: "Fraunces", Georgia, serif; font-weight: 600; font-size: 14px; }
      .ct-trend-person-date { font-size: 11.5px; color: var(--ink-soft); }
      .ct-trend-person-on .ct-trend-person-date { color: rgba(255,255,255,0.85); }
      .ct-trend-table { border-collapse: collapse; font-size: 12.5px; width: 100%; }
      .ct-trend-table th { font-weight: 500; color: var(--ink-soft); text-align: right; padding: 6px 8px; border-bottom: 1px solid var(--line); white-space: nowrap; }
      .ct-trend-table th.ct-trend-th-name { text-align: left; }
      .ct-trend-table td { padding: 6px 8px; border-bottom: 1px solid #EEF0EA; }
      .ct-trend-td-name { min-width: 200px; max-width: 320px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .ct-trend-td-name > * { vertical-align: middle; }
      .ct-trend-td-name > .ct-dot { display: inline-block; margin-right: 7px; }
      .ct-trend-cell { text-align: right; font-family: inherit; white-space: nowrap; }
      .ct-trend-carried { color: #A5ACA3 !important; }
      .ct-trend-none { color: #C5CBC2; }
      .ct-trend-total { font-weight: 600; border-top: 1px solid var(--line); }
      .ct-trend-delta { font-weight: 600; }
      .ct-trend-row-retired .ct-td-name-text { color: var(--ink-soft); }
      .ct-trend-name-btn { background: none; border: none; padding: 0; font: inherit; color: var(--c-teal); cursor: pointer; text-decoration: underline; text-decoration-color: transparent; text-underline-offset: 3px; }
      .ct-trend-name-btn:hover { text-decoration-color: currentColor; }
      .ct-btn { display: inline-flex; align-items: center; gap: 6px; background: var(--surface); border: 1px solid var(--line); border-radius: 8px; padding: 7px 12px; font-size: 13px; color: var(--ink); cursor: pointer; font-family: inherit; }
      .ct-btn:hover { border-color: var(--c-teal); }
      .ct-btn-icon { padding: 7px 9px; }
      .ct-remove { border: none; background: transparent; color: var(--ink-soft); padding: 4px; }
      .ct-remove:hover { color: var(--c-danger); }
      .ct-inline-form { display: flex; gap: 6px; align-items: center; }
      .ct-inline-form input { border: 1px solid var(--line); border-radius: 8px; padding: 7px 10px; font-size: 13px; font-family: inherit; min-width: 160px; }
      .ct-empty { margin-top: 14px; padding: 20px; text-align: center; border: 1px dashed var(--line); border-radius: 12px; color: var(--ink-soft); font-size: 14px; }
      .ct-panel { margin-top: 14px; background: var(--surface); border: 1px solid var(--line); border-radius: 12px; padding: 12px 16px; }
      .ct-panel h2 { font-family: "Fraunces", Georgia, serif; font-size: 15px; margin: 0 0 8px; }
      .ct-panel-head-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
      .ct-panel-head-row h2 { margin: 0 0 8px; }
      .ct-recolor-confirm { display: flex; align-items: center; gap: 8px; font-size: 12.5px; color: var(--ink-soft); flex-wrap: wrap; }
      .ct-identity-row { display: flex; align-items: center; gap: 24px; flex-wrap: wrap; }
      .ct-identity { display: flex; align-items: center; gap: 10px; font-size: 13px; }
      .ct-identity label { color: var(--ink-soft); }
      .ct-identity select { border: 1px solid var(--line); border-radius: 8px; padding: 7px 10px; font-family: inherit; font-size: 13px; background: var(--surface); }
      .ct-editor { margin-top: 10px; border-top: 1px solid var(--line); padding-top: 10px; }
      .ct-editor-head { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 6px; }
      .ct-editor-head h3 { font-size: 14px; margin: 0; font-weight: 600; }
      .ct-total { font-family: inherit; font-size: 16px; font-weight: 600; }
      .ct-hint { font-size: 13px; color: var(--ink-soft); }
      .ct-sliders { display: flex; flex-direction: column; gap: 4px; }
      .ct-alloc-cards {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(170px, 1fr));
        gap: 10px;
      }
      .ct-alloc-card {
        border: 1px solid var(--line);
        border-radius: 10px;
        padding: 14px;
        background: var(--surface);
        min-height: 92px;
        display: flex;
        flex-direction: column;
        justify-content: space-between;
      }
      .ct-alloc-card-top { display: flex; align-items: flex-start; gap: 7px; margin-bottom: 10px; }
      .ct-alloc-card-name {
        font-size: 13px;
        font-weight: 600;
        color: var(--ink);
        line-height: 1.35;
        white-space: normal;
        overflow-wrap: break-word;
        min-width: 0;
      }
      .ct-alloc-card-top .ct-dot { margin-top: 4px; flex-shrink: 0; }
      .ct-alloc-card-bottom { display: flex; align-items: center; }
      .ct-alloc-card-input {
        flex: 1;
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 3px;
        border: 1px solid var(--line);
        border-radius: 7px;
        padding: 6px 8px;
        min-width: 0;
      }
      .ct-alloc-card-input input {
        width: 100%;
        min-width: 0;
        border: none;
        text-align: center;
        font-family: inherit;
        font-size: 14px;
        font-weight: 600;
        color: var(--ink);
        background: transparent;
      }
      .ct-alloc-card-input input:focus { outline: none; }
      .ct-alloc-card-input input::-webkit-outer-spin-button,
      .ct-alloc-card-input input::-webkit-inner-spin-button {
        -webkit-appearance: none;
        margin: 0;
      }
      .ct-alloc-card-input input[type=number] { -moz-appearance: textfield; }
      .ct-alloc-card-input span { font-size: 12px; color: var(--ink-soft); flex-shrink: 0; }
      .ct-slider-row { display: grid; grid-template-columns: 10px 110px 1fr 48px 12px; align-items: center; gap: 10px; padding: 2px 0; }
      .ct-slider-stack { display: flex; flex-direction: column; gap: 3px; padding: 5px 0; border-bottom: 1px solid var(--line); }
      .ct-slider-stack:last-child { border-bottom: none; }
      .ct-slider-stack-top { display: flex; align-items: center; gap: 8px; }
      .ct-proj-name-full { font-size: 13px; font-weight: 500; word-break: break-word; overflow-wrap: anywhere; }
      .ct-slider-stack-bottom { display: grid; grid-template-columns: 1fr 48px 12px; align-items: center; gap: 10px; }
      .ct-slider-stack-bottom input[type=range] { width: 100%; accent-color: var(--c-teal); }
      .ct-dot { width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0; }
      .ct-proj-name { font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .ct-slider-row input[type=range] { width: 100%; accent-color: var(--c-teal); }
      .ct-num { width: 48px; border: 1px solid var(--line); border-radius: 6px; padding: 4px 6px; font-family: inherit; font-size: 12px; text-align: right; }
      .ct-pct { font-size: 12px; color: var(--ink-soft); }
      .ct-msg { margin-top: 8px; font-size: 12px; display: flex; align-items: center; gap: 6px; padding: 6px 10px; border-radius: 8px; }
      .ct-msg-danger { background: #FBEBE9; color: var(--c-danger); }
      .ct-msg-ok { background: #E6F1EE; color: var(--c-teal); }
      .ct-msg-muted { background: #F1F2ED; color: var(--ink-soft); }
      .ct-caption { margin: 4px 2px 0; font-size: 11.5px; color: var(--ink-soft); }
      .ct-updated-row { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; font-size: 12px; color: var(--ink-soft); flex-wrap: wrap; }
      .ct-updated-row input[type=date] { border: 1px solid var(--line); border-radius: 6px; padding: 5px 8px; font-family: inherit; font-size: 12px; background: var(--surface); }
      .ct-req-sep { margin-left: 6px; padding-left: 12px; border-left: 1px solid var(--line); }
      .ct-req-date { font-family: inherit; font-size: 12px; color: var(--ink); }
      .ct-req-fulfilled { font-family: inherit; color: var(--c-teal); font-weight: 500; }
      .ct-req-btn { color: var(--ink-soft); }
      .ct-req-btn:hover { color: var(--c-teal); border-color: var(--c-teal); }
      .ct-req-bell { border: none; background: transparent; color: var(--line); padding: 2px; display: inline-flex; align-items: center; justify-content: center; cursor: pointer; margin-top: 2px; }
      .ct-req-bell:hover { color: var(--c-teal); }
      .ct-req-bell-active { color: var(--c-amber); }
      .ct-req-bell-active:hover { color: var(--c-teal); }
      .ct-th-date { font-weight: 500; font-size: 12px; color: rgba(255,255,255,0.9); text-transform: none; white-space: nowrap; }
      .ct-alert-panel { padding: 0; border: none; background: none; }
      .ct-alert { display: flex; align-items: flex-start; gap: 8px; padding: 12px 16px; background: #FBEBE9; color: var(--c-danger); border-radius: 12px; font-size: 12.5px; line-height: 1.5; border: 1px solid #F3C9C5; }
      .ct-alert svg { flex-shrink: 0; margin-top: 2px; }
      .ct-th-date-stale { color: var(--c-danger); display: inline-flex; align-items: center; gap: 3px; }
      .ct-you-inline { color: var(--c-teal); font-weight: 500; }
      .ct-col-self { background: #F5F8F1; }

      .ct-table-wrap {
        overflow-x: auto;
        border: 1px solid var(--line);
        border-radius: 10px;
        scrollbar-width: thin;
        scrollbar-color: var(--line) transparent;
      }
      .ct-table-wrap::-webkit-scrollbar { height: 6px; }
      .ct-table-wrap::-webkit-scrollbar-track { background: transparent; }
      .ct-table-wrap::-webkit-scrollbar-thumb { background: var(--line); border-radius: 6px; }
      .ct-table { border-collapse: collapse; width: 100%; table-layout: fixed; font-size: 12.5px; }
      .ct-table th, .ct-table td { padding: 5px 4px; border-bottom: 1px solid var(--line); text-align: center; }
      .ct-table thead th { background: #003759; color: #FFFFFF; font-weight: 500; font-size: 11.5px; position: sticky; top: 0; padding-top: 6px; padding-bottom: 6px; }
      .ct-th-name {
        width: 148px;
        text-align: left !important;
        position: sticky;
        left: 0;
        background: #003759;
        color: #FFFFFF;
        z-index: 3;
        padding-right: 10px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        font-size: 19px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.03em;
      }
      .ct-th-proj { width: 74px; position: relative; white-space: nowrap; padding: 8px 3px; vertical-align: middle; }
      .ct-th-proj-inner { display: flex; flex-direction: column; align-items: center; }
      .ct-th-name-rotated { display: flex; align-items: center; justify-content: center; overflow: visible; }
      .ct-th-name-rotated span {
        display: inline-block;
        white-space: nowrap;
        font-size: 12.5px;
        font-weight: 600;
        color: #FFFFFF;
        letter-spacing: -0.01em;
      }
      .ct-th-meta-row { display: flex; align-items: center; gap: 4px; margin-top: 5px; }
      .ct-th-demand, .ct-td-demand {
        width: 46px;
        position: sticky;
        right: 0;
        z-index: 2;
        font-family: inherit;
        font-weight: 600;
        color: var(--ink-soft);
        box-shadow: -6px 0 6px -6px rgba(0,0,0,0.12);
      }
      .ct-th-demand { background: #003759; color: #FFFFFF; z-index: 3; font-size: 15px; font-weight: 700; }
      .ct-td-demand { background: var(--surface); }
      .ct-table tbody tr:hover .ct-td-demand { background: #FAFBF7; }
      .ct-td-name {
        text-align: left !important;
        font-weight: 500;
        position: sticky;
        left: 0;
        background: var(--surface);
        z-index: 1;
        display: flex;
        align-items: center;
        gap: 6px;
        padding-right: 10px;
        overflow: hidden;
      }
      .ct-td-name-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
      .ct-foot-label { font-weight: 600; }
      .ct-table tfoot td { border-bottom: none; border-top: 1px solid var(--line); }
      .ct-table tfoot .ct-td-demand { background: var(--surface); }
      .ct-td-cell { font-family: inherit; color: var(--ink); }
      .ct-td-empty { color: var(--line); }
      .ct-td-total { font-family: inherit; font-weight: 600; color: var(--ink-soft); }
      .ct-td-name .ct-remove { opacity: 0; transition: opacity 0.1s; margin-left: auto; flex-shrink: 0; }
      .ct-table tbody tr:hover .ct-remove { opacity: 1; }

      .ct-projects { display: flex; flex-direction: column; gap: 6px; }
      .ct-project-row { display: grid; grid-template-columns: 10px 130px 1fr 56px 20px; align-items: center; gap: 10px; }
      .ct-demand-track { height: 8px; background: #EEF0E8; border-radius: 6px; overflow: hidden; }
      .ct-demand-fill { height: 100%; }
      .ct-fte { font-family: inherit; font-size: 12px; color: var(--ink-soft); text-align: right; }
      .ct-network-backdrop {
        position: fixed;
        inset: 0;
        background: rgba(0, 20, 34, 0.55);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 50;
        padding: 20px;
      }
      .ct-network-modal {
        background: #FFFFFF;
        border-radius: 14px;
        padding: 20px;
        max-width: 720px;
        width: 100%;
        max-height: 90vh;
        overflow-y: auto;
      }
      .ct-network-modal-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
      .ct-network-modal-head h2 { font-family: "Fraunces", Georgia, serif; font-size: 16px; margin: 0; color: var(--ink); }
      .ct-diagram-visual {
        background: linear-gradient(180deg, #9AC6E2 0%, #263138 100%);
        border-radius: 10px;
        padding: 16px;
      }
      .ct-diagram-caption { font-size: 13px; color: #FFFFFF; line-height: 1.5; margin: 12px 0 0; }
      .ct-diagram-security { margin-top: 18px; padding-top: 16px; border-top: 1px solid var(--line); }
      .ct-diagram-security-title { font-size: 14px; font-weight: 700; color: var(--ink); margin: 0 0 8px; }
      .ct-diagram-security-text { font-size: 13px; color: var(--ink-soft); line-height: 1.6; margin: 0 0 8px; }
      .ct-diagram-security-text:last-child { margin-bottom: 0; }

      /* ---- Ink & ivory theme (dashboard redesign) ---- */
      .ct-header { background: #14171C; padding: 26px 28px 0; }
      .ct-brand { gap: 14px; }
      .ct-brand-mark { width: 42px; height: 42px; border-radius: 12px; }
      .ct-brand h1 { font-family: "Fraunces", Georgia, serif; font-weight: 500; font-size: 24px; letter-spacing: -0.01em; max-width: none; }
      .ct-header .ct-brand p { color: #A9A49A; font-size: 11px; letter-spacing: 0.14em; text-transform: uppercase; margin-top: 5px; }
      .ct-topbar { align-items: center; }
      .ct-header-links { gap: 10px; }
      .ct-btn-add { display: inline-flex; align-items: center; gap: 7px; height: 38px; padding: 0 16px; border-radius: 10px; border: none; background: #F3F1EC; color: #14171C; font: inherit; font-size: 13px; font-weight: 600; cursor: pointer; transition: background 0.15s; }
      .ct-btn-add:hover { background: #FFFFFF; }
      .ct-menu { position: relative; }
      .ct-menu-btn { width: 38px; height: 38px; border-radius: 10px; border: 1px solid #2E333B; background: transparent; color: #E6E2DA; display: flex; align-items: center; justify-content: center; cursor: pointer; transition: background 0.15s; }
      .ct-menu-btn:hover, .ct-menu-btn[aria-expanded="true"] { background: #22262D; }
      .ct-btn-add:focus-visible, .ct-menu-btn:focus-visible { outline: 2px solid #7FB8A9; outline-offset: 2px; }
      .ct-menu-pop { position: absolute; right: 0; top: calc(100% + 8px); z-index: 60; min-width: 220px; background: #FFFFFF; border-radius: 14px; padding: 6px; box-shadow: 0 2px 6px rgba(20,23,28,0.08), 0 18px 48px rgba(20,23,28,0.18); }
      .ct-menu-item { display: flex; align-items: center; gap: 10px; width: 100%; padding: 9px 10px; border: none; background: none; border-radius: 8px; font: inherit; font-size: 13px; color: var(--ink); text-align: left; cursor: pointer; }
      .ct-menu-item svg { color: var(--ink-soft); flex-shrink: 0; }
      .ct-menu-item:hover { background: #F4F1EB; }
      .ct-menu-item:focus-visible { outline: 2px solid var(--c-teal); outline-offset: -2px; }
      .ct-menu-item-on, .ct-menu-item-on svg { color: var(--c-teal); }
      .ct-menu-item-on { font-weight: 600; }
      .ct-menu-sep { height: 1px; background: var(--line); margin: 6px 4px; }
      .ct-nav { border-top: none; margin-top: 22px; }
      .ct-tab { color: #A9A49A; }
      .ct-tab::after { background: #7FB8A9; height: 2px; border-radius: 2px 2px 0 0; }
      .ct-tab:focus-visible { outline-color: #7FB8A9; }
      .ct-util:focus-visible { outline-color: #7FB8A9; }
      .ct-content-wrap { padding: 28px 28px 48px; }
      .ct-panel { margin-top: 22px; border: none; border-radius: 18px; padding: 22px 24px; box-shadow: 0 1px 2px rgba(20,23,28,0.04), 0 10px 32px rgba(20,23,28,0.06); }
      .ct-content-wrap > .ct-panel:first-child { margin-top: 0; }
      .ct-panel h2 { font-weight: 500; font-size: 19px; margin-bottom: 14px; }
      .ct-identity label { font-size: 12px; }
      .ct-identity select { border-radius: 10px; padding: 8px 12px; background: #FAF8F4; }
      .ct-btn { border-radius: 10px; }

      .ct-table-wrap { border: none; border-radius: 0; }
      .ct-table { font-size: 13px; }
      .ct-table th, .ct-table td { border-bottom: 1px solid #F0EDE7; padding: 4px; }
      .ct-table thead th { background: #FFFFFF; color: var(--ink); vertical-align: bottom; padding: 10px 4px 12px; border-bottom: 1px solid var(--line); }
      .ct-table thead th.ct-th-name { width: 210px; padding-left: 12px; color: var(--ink-soft); font-size: 11px; font-weight: 600; letter-spacing: 0.14em; }
      .ct-table thead th.ct-th-demand { color: var(--ink-soft); font-size: 11px; font-weight: 600; letter-spacing: 0.14em; text-align: right; padding-right: 14px; }
      .ct-th-proj { width: 92px; }
      .ct-th-proj-inner { gap: 5px; }
      .ct-avatar { width: 30px; height: 30px; border-radius: 50%; background: #EFECE6; color: var(--ink); font-size: 11px; font-weight: 600; letter-spacing: 0.04em; display: flex; align-items: center; justify-content: center; }
      .ct-th-person { font-size: 12.5px; font-weight: 600; color: var(--ink); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%; }
      .ct-th-meta-row { margin-top: 0; gap: 2px; min-height: 22px; }
      .ct-th-date { color: var(--ink-soft); font-size: 11px; font-weight: 400; }
      .ct-stale-pill { display: inline-flex; align-items: center; gap: 3px; font-size: 10.5px; font-weight: 500; padding: 2px 7px; border-radius: 999px; background: #F7E6DF; color: #8E3519; white-space: nowrap; }
      .ct-req-bell { color: var(--ink-soft); opacity: 0; transition: opacity 0.15s; border-radius: 4px; margin-top: 0; }
      .ct-th-proj:hover .ct-req-bell, .ct-req-bell:focus-visible, .ct-req-bell-active { opacity: 1; }
      .ct-req-bell:focus-visible { outline: 2px solid var(--c-teal); }
      @media (hover: none) { .ct-req-bell { opacity: 1; } }
      .ct-th-demand, .ct-td-demand { width: 100px; box-shadow: none; }
      .ct-table td.ct-td-demand { color: var(--ink); font-weight: 600; text-align: right; padding-right: 14px; }
      .ct-fte-cell { display: inline-flex; align-items: center; gap: 10px; }
      .ct-fte-mini { width: 36px; height: 4px; border-radius: 4px; background: #EFECE6; overflow: hidden; display: inline-block; }
      .ct-fte-mini span { display: block; height: 100%; border-radius: 4px; }
      .ct-table .ct-group-row td { text-align: left; padding: 18px 12px 6px; border-bottom: none; background: #FFFFFF; }
      .ct-group-label { display: inline-flex; align-items: center; gap: 8px; font-size: 11px; font-weight: 600; letter-spacing: 0.14em; text-transform: uppercase; color: var(--ink-soft); position: sticky; left: 12px; }
      .ct-table td.ct-td-name { padding-left: 12px; font-weight: 400; font-size: 13.5px; gap: 9px; min-height: 46px; }
      .ct-table td.ct-td-name-grouped { padding-left: 30px; }
      .ct-alloc-row td { height: 46px; }
      .ct-table tbody tr.ct-alloc-row:hover td, .ct-table tbody tr.ct-alloc-row:hover .ct-td-demand { background: #FAF8F4; }
      .ct-heat { display: inline-flex; align-items: center; justify-content: center; min-width: 50px; height: 28px; padding: 0 8px; border-radius: 8px; font-size: 12.5px; font-weight: 500; }
      .ct-heat-sm { min-width: 34px; height: 20px; padding: 0 6px; border-radius: 5px; font-size: 10.5px; }
      .ct-col-self { background: #F7F5F0; }
      .ct-table tfoot td { border-top: 1px solid var(--line); padding-top: 12px; padding-bottom: 12px; }
      .ct-table td.ct-foot-label { font-size: 11px; font-weight: 600; letter-spacing: 0.14em; text-transform: uppercase; color: var(--ink-soft); }
      .ct-total-ok { display: inline-flex; align-items: center; gap: 4px; font-size: 12.5px; font-weight: 400; color: var(--ink-soft); }
      .ct-total-ok svg { color: var(--c-teal); }
      .ct-total-flag { font-size: 11.5px; font-weight: 600; padding: 3px 8px; border-radius: 999px; background: #FBF0DC; color: #7A4C0A; }
      .ct-total-over { background: #F7E6DF; color: #8E3519; }
      .ct-table-foot { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 10px 20px; margin-top: 14px; }
      .ct-table-foot .ct-caption { margin: 0; }
      .ct-heat-legend { display: flex; align-items: center; gap: 6px; font-size: 11.5px; color: var(--ink-soft); }
      .ct-heat-legend > span:first-child { margin-right: 4px; }

      .ct-projects { gap: 12px; }
      .ct-project-row { grid-template-columns: 8px minmax(140px, 230px) 1fr 64px; gap: 12px; }
      .ct-proj-name { font-size: 13.5px; }
      .ct-demand-track { height: 6px; background: #F0EDE7; }
      .ct-demand-fill { border-radius: 6px; }
      .ct-fte { font-weight: 600; color: var(--ink); }
      .ct-dot { width: 8px; height: 8px; }
      .ct-alert { background: #F7E6DF; color: #8E3519; border: none; border-radius: 14px; }
      .ct-panel.ct-alert-panel { padding: 0; background: none; box-shadow: none; }
      .ct-diagram-visual { background: #14171C; }
      @media (max-width: 480px) {
        .ct-slider-row { grid-template-columns: 8px 80px 1fr 40px 10px; }
        .ct-member-row { grid-template-columns: 90px 1fr 44px 18px; }
        .ct-project-row { grid-template-columns: 8px 80px 1fr 44px 18px; }
      }
    `}</style>
  );
}
