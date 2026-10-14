import { useState, useEffect, useMemo, useRef } from "react";
import { Pencil, X, Check, AlertTriangle, Search, Eye, Wrench, Users } from "lucide-react";

// Interfaces section of the IT Analyst Resource Tracker.
//
// Records live in the same D1 kv_store as the rest of the board, under one
// shared key, read and written through window.storage (see storagePolyfill.js).
// Saves are conditional on the etag last read, so two people editing at once
// can't silently overwrite each other: on a conflict the latest data is
// reloaded and the edit is re-applied on top of it.
//
// Ownership format (unchanged from the standalone Interface Support Tracker):
//   monitors:  [{ name, note }]  — who watches it; [{ name: "Unassigned" }] = gap
//   resolvers: [{ name, note }]  — who fixes it;   [{ name: "Unassigned" }] = gap,
//                                  [] = no fixer needed (e.g. documentation)

export const INTERFACES_KEY = "capacity-interfaces";
const UNASSIGNED = "Unassigned";

const SEED_INTERFACES = 
[
  {"id": 1, "interface": "Item Master", "source": "Movex", "destination": "Manhattan", "check": "Manhattan WM", "msgType": "", "partner": "", "monitors": [{"name": "Shelly", "note": "errors on WM side"}], "resolvers": [{"name": "Unassigned", "note": null}], "brands": ["Internal / All Brands"]},
  {"id": 2, "interface": "Orders", "source": "Movex", "destination": "Manhattan", "check": "QV Report", "msgType": "", "partner": "", "monitors": [{"name": "CS", "note": null}], "resolvers": [{"name": "Unassigned", "note": null}], "brands": ["Internal / All Brands"]},
  {"id": 3, "interface": "PIX", "source": "Movex", "destination": "Manhattan", "check": "Movex", "msgType": "", "partner": "", "monitors": [{"name": "Shelly", "note": null}], "resolvers": [{"name": "Unassigned", "note": null}], "brands": ["Internal / All Brands"]},
  {"id": 4, "interface": "Ship Confirm", "source": "Movex", "destination": "Manhattan", "check": "Movex", "msgType": "", "partner": "", "monitors": [{"name": "Shelly", "note": null}], "resolvers": [{"name": "Unassigned", "note": null}], "brands": ["Internal / All Brands"]},
  {"id": 5, "interface": "Inventory Variance", "source": "Movex", "destination": "Manhattan", "check": "Movex", "msgType": "", "partner": "", "monitors": [{"name": "Shelly", "note": null}], "resolvers": [{"name": "Unassigned", "note": null}], "brands": ["Internal / All Brands"]},
  {"id": 6, "interface": "Item Master", "source": "Movex", "destination": "IntraOne", "check": "Team Central", "msgType": "", "partner": "", "monitors": [{"name": "Unassigned", "note": null}], "resolvers": [{"name": "Unassigned", "note": null}], "brands": ["Internal / All Brands"]},
  {"id": 7, "interface": "Orders", "source": "Movex", "destination": "IntraOne", "check": "QV Report", "msgType": "", "partner": "", "monitors": [{"name": "Unassigned", "note": null}], "resolvers": [{"name": "Unassigned", "note": null}], "brands": ["Internal / All Brands"]},
  {"id": 8, "interface": "PIX", "source": "Movex", "destination": "IntraOne", "check": "Movex", "msgType": "", "partner": "", "monitors": [{"name": "Paul", "note": null}], "resolvers": [{"name": "Unassigned", "note": null}], "brands": ["Internal / All Brands"]},
  {"id": 9, "interface": "Ship Confirm", "source": "Movex", "destination": "IntraOne", "check": "Movex", "msgType": "", "partner": "", "monitors": [{"name": "Paul", "note": null}], "resolvers": [{"name": "Unassigned", "note": null}], "brands": ["Internal / All Brands"]},
  {"id": 10, "interface": "Inventory Variance", "source": "Movex", "destination": "IntraOne", "check": "Movex", "msgType": "", "partner": "", "monitors": [{"name": "Paul", "note": null}], "resolvers": [{"name": "Brent", "note": null}, {"name": "Paul", "note": null}], "brands": ["Internal / All Brands"]},
  {"id": 11, "interface": "Inventory", "source": "Movex", "destination": "Shopify - Bare Necessities", "check": "Movex/Matrixify", "msgType": "407", "partner": "WEB-BN", "monitors": [{"name": "Diego", "note": null}], "resolvers": [{"name": "Diego", "note": null}], "brands": ["Bare Necessities"]},
  {"id": 12, "interface": "Orders", "source": "Movex", "destination": "Shopify - Bare Necessities", "check": "Movex", "msgType": "409", "partner": "WEB-BN", "monitors": [{"name": "EDI team", "note": null}], "resolvers": [{"name": "Diego", "note": null}], "brands": ["Bare Necessities"]},
  {"id": 13, "interface": "Ship Confirm", "source": "Movex", "destination": "Shopify - Bare Necessities", "check": "Movex", "msgType": "413", "partner": "WEB-BN", "monitors": [{"name": "CS", "note": null}], "resolvers": [{"name": "Diego", "note": null}], "brands": ["Bare Necessities"]},
  {"id": 14, "interface": "Documentation", "source": "Movex", "destination": "IntraOne", "check": "Sharepoint", "msgType": "", "partner": "", "monitors": [{"name": "Brent", "note": null}, {"name": "Paul", "note": null}], "resolvers": [{"name": "Unassigned", "note": null}], "brands": ["Internal / All Brands"]},
  {"id": 15, "interface": "Shopify Documentation", "source": "Movex", "destination": "Shopify - Bare Necessities", "check": "Sharepoint", "msgType": "", "partner": "", "flowOverride": "Sharepoint", "monitors": [{"name": "Diego", "note": null}], "resolvers": [], "brands": ["Bare Necessities"]},
  {"id": 16, "interface": "Barrett Documentation", "source": "Movex", "destination": "Barrett - Bare Necessities", "check": "Sharepoint", "msgType": "", "partner": "", "flowOverride": "Sharepoint", "monitors": [{"name": "Shelly", "note": null}, {"name": "Sayre", "note": null}], "resolvers": [], "brands": ["Bare Necessities"]},
  {"id": 17, "interface": "Techsera", "source": "Movex", "destination": "OMNI", "check": "OMNI", "msgType": "", "partner": "", "monitors": [{"name": "Shelly", "note": null}, {"name": "Diego", "note": null}, {"name": "Sayre", "note": null}], "resolvers": [{"name": "Abhijeet", "note": null}], "brands": ["Bare Necessities"]},
  {"id": 18, "interface": "Anaplan", "source": "Movex", "destination": "Anaplan", "check": "Anaplan", "msgType": "", "partner": "", "monitors": [{"name": "Dusko", "note": null}], "resolvers": [{"name": "Dusko", "note": null}], "brands": ["Splendid"]},
  {"id": 19, "interface": "xStore Integration", "source": "Movex", "destination": "xStore", "check": "xStore", "msgType": "", "partner": "", "monitors": [{"name": "Dusko", "note": null}], "resolvers": [{"name": "Dusko", "note": null}], "brands": ["7FAM"]},
  {"id": 20, "interface": "Inventory", "source": "Movex", "destination": "Shopify - Splendid / KWI", "check": "", "msgType": "407", "partner": "WEB-SPL", "monitors": [{"name": "Diego", "note": null}], "resolvers": [{"name": "Diego", "note": null}], "brands": ["Splendid"]},
  {"id": 21, "interface": "Orders", "source": "Movex", "destination": "Shopify - Splendid", "check": "", "msgType": "409", "partner": "WEB-SPL", "monitors": [{"name": "EDI team", "note": null}], "resolvers": [{"name": "Diego", "note": null}], "brands": ["Splendid"]},
  {"id": 22, "interface": "Ship Confirm", "source": "Movex", "destination": "Shopify - Splendid / KWI", "check": "", "msgType": "413", "partner": "WEB-SPL", "monitors": [{"name": "CS", "note": "Nicole"}], "resolvers": [{"name": "Diego", "note": null}], "brands": ["Splendid"]},
  {"id": 23, "interface": "Inventory", "source": "Movex", "destination": "Shopify - FBM", "check": "", "msgType": "407", "partner": "WEB-FBM", "monitors": [{"name": "Unassigned", "note": null}], "resolvers": [{"name": "Diego", "note": null}], "brands": ["FBM"]},
  {"id": 24, "interface": "Orders", "source": "Movex", "destination": "Shopify - FBM", "check": "", "msgType": "409", "partner": "", "monitors": [{"name": "EDI team", "note": null}], "resolvers": [{"name": "Unassigned", "note": null}], "brands": ["Internal / All Brands"]},
  {"id": 25, "interface": "Ship Confirm", "source": "Movex", "destination": "Shopify - FBM", "check": "", "msgType": "413", "partner": "WEB-FBM", "monitors": [{"name": "CS", "note": "Nicole"}], "resolvers": [{"name": "Diego", "note": null}], "brands": ["Internal / All Brands"]},
  {"id": 26, "interface": "Ship Confirm", "source": "Movex", "destination": "Shopify - PJ Salvage", "check": "", "msgType": "413", "partner": "", "monitors": [{"name": "EDI team", "note": null}], "resolvers": [{"name": "Diego", "note": null}], "brands": ["PJ Salvage"]},
  {"id": 27, "interface": "Inventory", "source": "Movex", "destination": "Shopify - PJ Salvage", "check": "", "msgType": "407", "partner": "", "monitors": [{"name": "Tierra", "note": "CS"}], "resolvers": [{"name": "Diego", "note": null}], "brands": ["PJ Salvage"]},
  {"id": 28, "interface": "Orders", "source": "Movex", "destination": "Shopify - PJ Salvage", "check": "", "msgType": "407", "partner": "", "monitors": [{"name": "Unassigned", "note": null}], "resolvers": [{"name": "Diego", "note": null}], "brands": ["PJ Salvage"]},
  {"id": 29, "interface": "Item Master", "source": "Movex", "destination": "KWI", "check": "", "msgType": "646", "partner": "", "monitors": [{"name": "Dusko", "note": null}], "resolvers": [{"name": "Dusko", "note": null}], "brands": ["Internal / All Brands"]},
  {"id": 30, "interface": "Attribute Master", "source": "Movex", "destination": "KWI", "check": "", "msgType": "648", "partner": "", "monitors": [{"name": "Dusko", "note": null}], "resolvers": [{"name": "Dusko", "note": null}], "brands": ["Internal / All Brands"]},
  {"id": 31, "interface": "Ship Confirm", "source": "Movex", "destination": "KWI", "check": "", "msgType": "856", "partner": "", "monitors": [{"name": "Dusko", "note": null}], "resolvers": [{"name": "Dusko", "note": null}], "brands": ["Internal / All Brands"]},
  {"id": 32, "interface": "Purchase Orders (Ecom)", "source": "Movex", "destination": "KWI", "check": "", "msgType": "446", "partner": "", "monitors": [{"name": "Dusko", "note": null}], "resolvers": [{"name": "Dusko", "note": null}], "brands": ["Internal / All Brands"]},
  {"id": 33, "interface": "Orders", "source": "Movex", "destination": "Inspectario", "check": "", "msgType": "628", "partner": "", "monitors": [{"name": "Dusko", "note": null}], "resolvers": [{"name": "Dusko", "note": null}], "brands": ["Internal / All Brands"]},
  {"id": 34, "interface": "Customers", "source": "Movex", "destination": "NuOrder", "check": "", "msgType": "", "partner": "", "monitors": [{"name": "Shelly", "note": null}], "resolvers": [{"name": "Unassigned", "note": null}], "brands": ["Internal / All Brands"]},
  {"id": 35, "interface": "PO Load", "source": "Movex", "destination": "Nexus", "check": "Email Report", "msgType": "630", "partner": "", "monitors": [{"name": "Dusko", "note": null}, {"name": "Zack", "note": null}], "resolvers": [{"name": "Unassigned", "note": null}], "brands": ["Internal / All Brands"]},
  {"id": 36, "interface": "ASN", "source": "Movex", "destination": "Nexus", "check": "Movex/EDZ100", "msgType": "635", "partner": "", "monitors": [{"name": "Dusko", "note": null}, {"name": "Zack", "note": null}], "resolvers": [{"name": "Unassigned", "note": null}], "brands": ["Internal / All Brands"]},
  {"id": 37, "interface": "RA Load", "source": "Movex", "destination": "Narvar", "check": "EDZ100", "msgType": "486", "partner": "", "monitors": [{"name": "EDI team", "note": null}], "resolvers": [{"name": "Diego", "note": null}], "brands": ["Splendid", "FBM", "Bare Necessities"]},
  {"id": 38, "interface": "RA Load", "source": "Movex", "destination": "Narvar", "check": "EDZ100", "msgType": "464", "partner": "", "monitors": [{"name": "EDI team", "note": null}], "resolvers": [{"name": "Diego", "note": null}], "brands": ["PJ Salvage"]},
  {"id": 39, "interface": "Drop Ship Orders", "source": "Movex", "destination": "Nordstrom/Neimans", "check": "EDZ100", "msgType": "486", "partner": "", "monitors": [{"name": "EDI team", "note": null}], "resolvers": [{"name": "Sandy", "note": null}], "brands": ["Internal / All Brands"]},
  {"id": 40, "interface": "Drop Ship Orders", "source": "Movex", "destination": "All others", "check": "EDZ100", "msgType": "471", "partner": "", "monitors": [{"name": "EDI team", "note": null}], "resolvers": [{"name": "Sandy", "note": null}], "brands": ["Internal / All Brands"]}
];

const GROUP_OPTIONS = [
  { value: "none", label: "No grouping" },
  { value: "destination", label: "Destination" },
  { value: "brand", label: "Brand" },
  { value: "check", label: "Check system" },
];

function norm(name) {
  return String(name || "").trim().toLowerCase();
}

function assigned(list) {
  return (list || []).filter((p) => p && p.name && p.name !== UNASSIGNED);
}

function needsMonitor(r) {
  return assigned(r.monitors).length === 0;
}

// An empty resolvers list means "no fixer needed", so only an explicit
// Unassigned entry counts as a gap.
function needsFixer(r) {
  return (r.resolvers || []).length > 0 && assigned(r.resolvers).length === 0;
}

function hasPerson(list, name) {
  const n = norm(name);
  return (list || []).some((p) => norm(p.name) === n);
}

function matchesQuery(r, q) {
  if (!q) return true;
  const hay = [
    r.interface,
    r.source,
    r.destination,
    r.check,
    r.msgType,
    r.partner,
    ...(r.brands || []),
    ...(r.monitors || []).map((p) => `${p.name} ${p.note || ""}`),
    ...(r.resolvers || []).map((p) => `${p.name} ${p.note || ""}`),
  ]
    .join(" ")
    .toLowerCase();
  return hay.includes(q);
}

function groupKeys(r, groupBy) {
  if (groupBy === "destination") return [r.destination || "—"];
  if (groupBy === "check") return [r.check || "Not specified"];
  if (groupBy === "brand") return (r.brands && r.brands.length ? r.brands : ["No brand"]);
  return ["all"];
}

export default function InterfacesView({ members }) {
  const [records, setRecords] = useState([]);
  const [status, setStatus] = useState("loading"); // loading | ready | error
  const [saveState, setSaveState] = useState("idle"); // idle | saving | saved | error
  const [notice, setNotice] = useState("");
  const [view, setView] = useState("analyst"); // analyst | all
  const [analyst, setAnalyst] = useState("");
  const [query, setQuery] = useState("");
  const [groupBy, setGroupBy] = useState("none");
  const [editing, setEditing] = useState(null); // { id, role }
  const etagRef = useRef(null);
  const editingRef = useRef(null);
  editingRef.current = editing;

  async function load({ quiet = false } = {}) {
    if (!quiet) setStatus("loading");
    try {
      const res = await window.storage.get(INTERFACES_KEY, true);
      const parsed = JSON.parse(res.value);
      etagRef.current = res.etag;
      setRecords(Array.isArray(parsed) ? parsed : []);
      setStatus("ready");
    } catch (err) {
      if (err && err.code === "NOT_FOUND") {
        // First use: load the 40 interfaces from the standalone tracker.
        try {
          const saved = await window.storage.set(INTERFACES_KEY, JSON.stringify(SEED_INTERFACES), true);
          etagRef.current = saved.etag;
          setRecords(SEED_INTERFACES);
          setStatus("ready");
        } catch (e) {
          if (!quiet) setStatus("error");
        }
      } else if (!quiet) {
        setStatus("error");
      }
    }
  }

  useEffect(() => {
    load();
    function onVisible() {
      if (document.visibilityState === "visible" && !editingRef.current) load({ quiet: true });
    }
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);

  useEffect(() => {
    if (saveState !== "saved") return;
    const t = setTimeout(() => setSaveState("idle"), 2000);
    return () => clearTimeout(t);
  }, [saveState]);

  async function saveOwners(id, role, list) {
    const field = role === "monitor" ? "monitors" : "resolvers";
    const apply = (recs) => recs.map((r) => (r.id === id ? { ...r, [field]: list } : r));
    const next = apply(records);
    setRecords(next);
    setSaveState("saving");
    setNotice("");
    try {
      const saved = await window.storage.set(INTERFACES_KEY, JSON.stringify(next), true, { ifMatch: etagRef.current });
      etagRef.current = saved.etag;
      setSaveState("saved");
    } catch (err) {
      if (err && err.code === "CONFLICT") {
        // Someone else saved first: take their version and re-apply this edit.
        try {
          const fresh = await window.storage.get(INTERFACES_KEY, true);
          const merged = apply(JSON.parse(fresh.value));
          const saved = await window.storage.set(INTERFACES_KEY, JSON.stringify(merged), true, { ifMatch: fresh.etag });
          etagRef.current = saved.etag;
          setRecords(merged);
          setSaveState("saved");
          setNotice("Someone else changed interface assignments at the same time. Their changes were kept and yours was applied on top.");
          return;
        } catch (e) {
          // fall through to the generic failure handling below
        }
      }
      setSaveState("error");
      setNotice("That change couldn't be saved, so the latest saved assignments have been reloaded. Please try again.");
      load({ quiet: true });
    }
  }

  const q = query.trim().toLowerCase();
  const visible = useMemo(() => records.filter((r) => matchesQuery(r, q)), [records, q]);
  const memberNames = useMemo(() => new Set(members.map((m) => norm(m.name))), [members]);

  const gapsMonitor = visible.filter(needsMonitor);
  const gapsFixer = visible.filter(needsFixer);

  // Owners who aren't on the team list (support groups, people outside IT).
  const otherOwners = useMemo(() => {
    const map = new Map();
    visible.forEach((r) => {
      [["monitors", r.monitors], ["fixes", r.resolvers]].forEach(([kind, list]) => {
        assigned(list).forEach((p) => {
          const n = norm(p.name);
          if (memberNames.has(n)) return;
          if (!map.has(n)) map.set(n, { name: p.name, monitors: [], fixes: [] });
          const entry = map.get(n);
          if (!entry[kind].includes(r)) entry[kind].push(r);
        });
      });
    });
    return [...map.values()].sort((a, b) => b.monitors.length - a.monitors.length || a.name.localeCompare(b.name));
  }, [visible, memberNames]);

  const shownMembers = analyst ? members.filter((m) => m.name === analyst) : members;
  const editingRecord = editing ? records.find((r) => r.id === editing.id) : null;

  if (status === "loading") {
    return (
      <>
        <InterfacesStyle />
        <div className="ct-empty">Loading interfaces…</div>
      </>
    );
  }

  if (status === "error") {
    return (
      <>
        <InterfacesStyle />
        <div className="ct-load-error" style={{ marginTop: 14 }}>
          <AlertTriangle size={15} />
          <span>Couldn't load the interface assignments. Nothing has been changed; try reconnecting.</span>
          <button type="button" className="ct-btn ct-btn-icon" onClick={() => load()}>
            Retry
          </button>
        </div>
      </>
    );
  }

  return (
    <div className="ct-if">
      <InterfacesStyle />

      <section className="ct-panel">
        <div className="ct-panel-head-row">
          <h2>Interface monitoring</h2>
          <span className={`ct-save ct-save-${saveState}`}>
            {saveState === "saving" ? "Saving…" : saveState === "saved" ? "Saved" : saveState === "error" ? "Save failed" : ""}
          </span>
        </div>
        <p className="ct-hint" style={{ marginBottom: 12 }}>
          Which interfaces each analyst watches for failures, and who fixes them when they break. Use the pencil next to any
          assignment to change it. Analysts come from the team list on this board.
        </p>

        <div className="ct-if-controls">
          <div className="ct-segmented" role="tablist" aria-label="Interface view">
            <button type="button" role="tab" aria-selected={view === "analyst"} className={view === "analyst" ? "ct-seg ct-seg-on" : "ct-seg"} onClick={() => setView("analyst")}>
              By analyst
            </button>
            <button type="button" role="tab" aria-selected={view === "all"} className={view === "all" ? "ct-seg ct-seg-on" : "ct-seg"} onClick={() => setView("all")}>
              All interfaces
            </button>
          </div>

          {view === "analyst" ? (
            <div className="ct-identity">
              <label htmlFor="ct-if-analyst">Analyst</label>
              <select id="ct-if-analyst" value={analyst} onChange={(e) => setAnalyst(e.target.value)}>
                <option value="">All analysts</option>
                {members.map((m) => (
                  <option key={m.id} value={m.name}>{m.name}</option>
                ))}
              </select>
            </div>
          ) : (
            <div className="ct-identity">
              <label htmlFor="ct-if-group">Group by</label>
              <select id="ct-if-group" value={groupBy} onChange={(e) => setGroupBy(e.target.value)}>
                {GROUP_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </div>
          )}

          <div className="ct-if-search">
            <Search size={14} />
            <input
              type="search"
              placeholder="Search interface, system, brand, person…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label="Search interfaces"
            />
          </div>
        </div>

        <div className="ct-if-stats">
          <span className="ct-if-stat"><b>{visible.length}</b> interfaces{q ? " match" : ""}</span>
          <span className={gapsMonitor.length ? "ct-if-stat ct-if-stat-warn" : "ct-if-stat"}><b>{gapsMonitor.length}</b> without a watcher</span>
          <span className={gapsFixer.length ? "ct-if-stat ct-if-stat-warn" : "ct-if-stat"}><b>{gapsFixer.length}</b> without a fixer</span>
        </div>
      </section>

      {notice && (
        <div className="ct-restore-notice">
          <Check size={13} /> {notice}
          <button type="button" className="ct-restore-notice-close" onClick={() => setNotice("")}>
            <X size={12} />
          </button>
        </div>
      )}

      {view === "analyst" ? (
        <>
          {!analyst && gapsMonitor.length > 0 && (
            <section className="ct-panel ct-if-gap-panel">
              <h2><AlertTriangle size={14} /> Nobody is watching these</h2>
              <p className="ct-hint" style={{ marginBottom: 8 }}>Assign a watcher so failures on these interfaces get noticed.</p>
              <div className="ct-if-list">
                {gapsMonitor.map((r) => (
                  <InterfaceLine key={r.id} record={r} onEdit={() => setEditing({ id: r.id, role: "monitor" })} editLabel="Assign watcher" />
                ))}
              </div>
            </section>
          )}

          <div className="ct-if-grid">
            {shownMembers.map((m) => {
              const watches = visible.filter((r) => hasPerson(r.monitors, m.name));
              const fixes = visible.filter((r) => hasPerson(r.resolvers, m.name));
              return (
                <section key={m.id} className="ct-panel ct-if-card">
                  <div className="ct-if-card-head">
                    <h2>{m.name}</h2>
                    <span className="ct-hint">
                      Watches {watches.length} · Fixes {fixes.length}
                    </span>
                  </div>

                  <h3 className="ct-if-subhead"><Eye size={13} /> Monitors</h3>
                  {watches.length === 0 ? (
                    <p className="ct-hint ct-if-none">Not monitoring any interfaces{q ? " that match" : ""}.</p>
                  ) : (
                    <div className="ct-if-list">
                      {watches.map((r) => (
                        <InterfaceLine
                          key={r.id}
                          record={r}
                          personNote={(r.monitors.find((p) => norm(p.name) === norm(m.name)) || {}).note}
                          coOwners={assigned(r.monitors).filter((p) => norm(p.name) !== norm(m.name))}
                          onEdit={() => setEditing({ id: r.id, role: "monitor" })}
                          editLabel="Edit watchers"
                        />
                      ))}
                    </div>
                  )}

                  {fixes.length > 0 && (
                    <>
                      <h3 className="ct-if-subhead"><Wrench size={13} /> Also fixes</h3>
                      <div className="ct-if-list">
                        {fixes.map((r) => (
                          <InterfaceLine
                            key={r.id}
                            record={r}
                            compact
                            onEdit={() => setEditing({ id: r.id, role: "resolve" })}
                            editLabel="Edit fixers"
                          />
                        ))}
                      </div>
                    </>
                  )}
                </section>
              );
            })}
          </div>

          {!analyst && otherOwners.length > 0 && (
            <section className="ct-panel">
              <h2><Users size={14} style={{ verticalAlign: "-2px" }} /> Other owners</h2>
              <p className="ct-hint" style={{ marginBottom: 10 }}>
                Teams and people outside the analyst list who are assigned to interfaces.
              </p>
              <div className="ct-if-others">
                {otherOwners.map((o) => (
                  <div key={o.name} className="ct-if-other">
                    <div className="ct-if-other-name">{o.name}</div>
                    <div className="ct-hint" style={{ fontSize: 12 }}>
                      {o.monitors.length > 0 && <>Watches: {o.monitors.map((r) => `${r.interface} → ${r.destination}`).join(", ")}</>}
                      {o.monitors.length > 0 && o.fixes.length > 0 && <br />}
                      {o.fixes.length > 0 && <>Fixes: {o.fixes.map((r) => `${r.interface} → ${r.destination}`).join(", ")}</>}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}
        </>
      ) : (
        <AllInterfacesTable
          records={visible}
          groupBy={groupBy}
          memberNames={memberNames}
          onEdit={(id, role) => setEditing({ id, role })}
        />
      )}

      {editing && editingRecord && (
        <EditOwnersModal
          record={editingRecord}
          role={editing.role}
          members={members}
          onClose={() => setEditing(null)}
          onSave={(list) => {
            setEditing(null);
            saveOwners(editing.id, editing.role, list);
          }}
        />
      )}
    </div>
  );
}

function InterfaceLine({ record: r, personNote, coOwners, onEdit, editLabel, compact }) {
  return (
    <div className="ct-if-line">
      <div className="ct-if-line-main">
        <div className="ct-if-line-title">
          <strong>{r.interface}</strong>
          <span className="ct-if-arrow">→</span>
          <span>{r.destination}</span>
          {r.msgType && <span className="ct-if-badge" title="Message type">{r.msgType}</span>}
        </div>
        {!compact && (
          <div className="ct-if-line-meta">
            {r.check && <span>Check in {r.check}</span>}
            {(r.brands || []).length > 0 && <span>{r.brands.join(", ")}</span>}
            {personNote && <span className="ct-if-note">{personNote}</span>}
            {coOwners && coOwners.length > 0 && <span>with {coOwners.map((p) => p.name).join(", ")}</span>}
          </div>
        )}
      </div>
      <button type="button" className="ct-if-edit" onClick={onEdit} title={editLabel} aria-label={`${editLabel}: ${r.interface} → ${r.destination}`}>
        <Pencil size={13} />
      </button>
    </div>
  );
}

function OwnerChips({ list, memberNames, emptyLabel }) {
  if (!list || list.length === 0) return <span className="ct-hint" style={{ fontSize: 12 }}>{emptyLabel}</span>;
  return (
    <span className="ct-if-chips">
      {list.map((p, i) => {
        const cls =
          p.name === UNASSIGNED ? "ct-if-chip ct-if-chip-gap" : memberNames.has(norm(p.name)) ? "ct-if-chip ct-if-chip-team" : "ct-if-chip";
        return (
          <span key={`${p.name}-${i}`} className={cls} title={p.note || undefined}>
            {p.name}
            {p.note && <span className="ct-if-chip-note"> · {p.note}</span>}
          </span>
        );
      })}
    </span>
  );
}

function AllInterfacesTable({ records, groupBy, memberNames, onEdit }) {
  const groups = useMemo(() => {
    const map = new Map();
    records.forEach((r) => {
      groupKeys(r, groupBy).forEach((k) => {
        if (!map.has(k)) map.set(k, []);
        map.get(k).push(r);
      });
    });
    const entries = [...map.entries()];
    if (groupBy !== "none") entries.sort((a, b) => a[0].localeCompare(b[0]));
    return entries;
  }, [records, groupBy]);

  if (records.length === 0) {
    return <div className="ct-empty">No interfaces match your search.</div>;
  }

  return (
    <section className="ct-panel">
      <div className="ct-table-wrap">
        <table className="ct-if-table">
          <thead>
            <tr>
              <th>Interface</th>
              <th>Destination</th>
              <th>Check in</th>
              <th>Msg</th>
              <th>Brands</th>
              <th>Monitored by</th>
              <th>Fixed by</th>
            </tr>
          </thead>
          <tbody>
            {groups.map(([key, rows]) => (
              <GroupRows key={key} label={groupBy === "none" ? null : key} rows={rows} memberNames={memberNames} onEdit={onEdit} />
            ))}
          </tbody>
        </table>
      </div>
      <p className="ct-caption">
        Teal names are analysts on this board; amber marks an interface that still needs someone. "No fixer needed" means the
        interface has no fix step (for example, documentation).
      </p>
    </section>
  );
}

function GroupRows({ label, rows, memberNames, onEdit }) {
  return (
    <>
      {label && (
        <tr className="ct-if-group-row">
          <td colSpan={7}>
            {label} <span className="ct-if-group-count">{rows.length}</span>
          </td>
        </tr>
      )}
      {rows.map((r) => (
        <tr key={`${label || ""}-${r.id}`}>
          <td><strong>{r.interface}</strong></td>
          <td>{r.destination}</td>
          <td>{r.check || <span className="ct-hint">—</span>}</td>
          <td className="ct-if-mono">{r.msgType || ""}</td>
          <td>{(r.brands || []).join(", ")}</td>
          <td>
            <div className="ct-if-cell">
              <OwnerChips list={r.monitors} memberNames={memberNames} emptyLabel="Unassigned" />
              <button type="button" className="ct-if-edit" onClick={() => onEdit(r.id, "monitor")} title="Edit watchers" aria-label={`Edit watchers: ${r.interface} → ${r.destination}`}>
                <Pencil size={12} />
              </button>
            </div>
          </td>
          <td>
            <div className="ct-if-cell">
              <OwnerChips list={r.resolvers} memberNames={memberNames} emptyLabel="No fixer needed" />
              <button type="button" className="ct-if-edit" onClick={() => onEdit(r.id, "resolve")} title="Edit fixers" aria-label={`Edit fixers: ${r.interface} → ${r.destination}`}>
                <Pencil size={12} />
              </button>
            </div>
          </td>
        </tr>
      ))}
    </>
  );
}

function EditOwnersModal({ record, role, members, onClose, onSave }) {
  const field = role === "monitor" ? "monitors" : "resolvers";
  const current = record[field] || [];
  const memberByNorm = new Map(members.map((m) => [norm(m.name), m.name]));

  const [checked, setChecked] = useState(() => new Set(assigned(current).filter((p) => memberByNorm.has(norm(p.name))).map((p) => norm(p.name))));
  const [others, setOthers] = useState(() =>
    assigned(current)
      .filter((p) => !memberByNorm.has(norm(p.name)))
      .map((p) => p.name)
      .join(", ")
  );
  const [noFixer, setNoFixer] = useState(role === "resolve" && current.length === 0);

  useEffect(() => {
    function onKey(e) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  function toggle(n) {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(n)) next.delete(n);
      else next.add(n);
      return next;
    });
  }

  function handleSave() {
    if (role === "resolve" && noFixer) {
      onSave([]);
      return;
    }
    const names = [
      ...members.filter((m) => checked.has(norm(m.name))).map((m) => m.name),
      ...others.split(",").map((s) => s.trim()).filter(Boolean),
    ];
    const seen = new Set();
    const list = [];
    names.forEach((name) => {
      const n = norm(name);
      if (seen.has(n) || n === norm(UNASSIGNED)) return;
      seen.add(n);
      // Keep any note (e.g. "errors on WM side") for people who stay assigned.
      const existing = current.find((p) => norm(p.name) === n);
      list.push({ name, note: existing ? existing.note || null : null });
    });
    onSave(list.length ? list : [{ name: UNASSIGNED, note: null }]);
  }

  const disabled = role === "resolve" && noFixer;

  return (
    <div className="ct-network-backdrop" onClick={onClose}>
      <div className="ct-network-modal ct-if-modal" role="dialog" aria-modal="true" aria-labelledby="ct-if-modal-title" onClick={(e) => e.stopPropagation()}>
        <div className="ct-network-modal-head">
          <h2 id="ct-if-modal-title">
            {role === "monitor" ? "Who monitors" : "Who fixes"} {record.interface} → {record.destination}?
          </h2>
          <button type="button" className="ct-btn ct-btn-icon" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </div>

        <p className="ct-hint" style={{ marginTop: 0 }}>
          {role === "monitor"
            ? "Watchers check this interface for failures. Leave everyone unticked to mark it Unassigned."
            : "Fixers resolve failures on this interface. Leave everyone unticked to mark it Unassigned."}
        </p>

        <fieldset className="ct-if-fieldset" disabled={disabled}>
          <legend>Analysts</legend>
          <div className="ct-if-checks">
            {members.map((m) => {
              const n = norm(m.name);
              return (
                <label key={m.id} className={checked.has(n) ? "ct-if-check ct-if-check-on" : "ct-if-check"}>
                  <input type="checkbox" checked={checked.has(n)} onChange={() => toggle(n)} />
                  {m.name}
                </label>
              );
            })}
          </div>

          <label className="ct-if-others-label" htmlFor="ct-if-others">
            Other people or teams <span className="ct-hint">(comma-separated, e.g. CS, EDI team)</span>
          </label>
          <input id="ct-if-others" className="ct-if-text" value={others} onChange={(e) => setOthers(e.target.value)} />
        </fieldset>

        {role === "resolve" && (
          <label className="ct-if-nofixer">
            <input type="checkbox" checked={noFixer} onChange={(e) => setNoFixer(e.target.checked)} />
            No fixer needed for this interface
          </label>
        )}

        <p className="ct-hint" style={{ fontSize: 12 }}>Notes on an assignment (like "errors on WM side") are kept for anyone who stays assigned.</p>

        <div className="ct-if-modal-actions">
          <button type="button" className="ct-btn" onClick={onClose}>Cancel</button>
          <button type="button" className="ct-btn ct-btn-primary" onClick={handleSave}>
            <Check size={14} /> Save
          </button>
        </div>
      </div>
    </div>
  );
}

function InterfacesStyle() {
  return (
    <style>{`
      .ct-if-controls { display: flex; align-items: center; gap: 12px 20px; flex-wrap: wrap; }
      .ct-if-search { display: flex; align-items: center; gap: 6px; border: 1px solid var(--line); border-radius: 8px; padding: 0 10px; background: var(--surface); color: var(--ink-soft); flex: 1; min-width: 220px; max-width: 380px; }
      .ct-if-search input { border: none; outline: none; padding: 7px 0; font: inherit; font-size: 13px; width: 100%; background: transparent; color: var(--ink); }
      .ct-if-search:focus-within { border-color: var(--c-teal); }
      .ct-if-stats { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 12px; }
      .ct-if-stat { font-size: 12.5px; color: var(--ink-soft); border: 1px solid var(--line); border-radius: 20px; padding: 4px 10px; }
      .ct-if-stat b { color: var(--ink); font-family: "IBM Plex Mono", monospace; }
      .ct-if-stat-warn { border-color: #E9C98F; background: #FBF3E4; }
      .ct-if-stat-warn b { color: var(--c-amber); }

      .ct-if-gap-panel { border-color: #E9C98F; background: #FFFBF3; }
      .ct-if-gap-panel h2 { display: flex; align-items: center; gap: 6px; color: var(--c-amber); }

      .ct-if-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); gap: 0 14px; align-items: start; }
      .ct-if-card-head { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; border-bottom: 1px solid var(--line); padding-bottom: 6px; margin-bottom: 8px; }
      .ct-if-card-head h2 { margin: 0; }
      .ct-if-subhead { display: flex; align-items: center; gap: 6px; font-size: 11.5px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; color: var(--ink-soft); margin: 10px 0 6px; }
      .ct-if-none { font-size: 12.5px; margin: 0 0 4px; }

      .ct-if-list { display: flex; flex-direction: column; gap: 4px; }
      .ct-if-line { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; padding: 6px 8px; border: 1px solid var(--line); border-radius: 8px; font-size: 12.5px; }
      .ct-if-line:hover { border-color: #B9C9C2; }
      .ct-if-line-main { min-width: 0; }
      .ct-if-line-title { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
      .ct-if-arrow { color: var(--ink-soft); }
      .ct-if-line-meta { display: flex; flex-wrap: wrap; gap: 2px 12px; margin-top: 2px; color: var(--ink-soft); font-size: 11.5px; }
      .ct-if-note { color: var(--c-teal); font-style: italic; }
      .ct-if-badge { font-family: "IBM Plex Mono", monospace; font-size: 10.5px; background: #EEF0E8; border-radius: 4px; padding: 1px 5px; color: var(--ink-soft); }
      .ct-if-edit { flex-shrink: 0; background: none; border: 1px solid transparent; border-radius: 6px; padding: 4px 5px; color: var(--ink-soft); cursor: pointer; display: inline-flex; }
      .ct-if-edit:hover { border-color: var(--line); color: var(--c-teal); background: var(--surface); }
      .ct-if-edit:focus-visible { outline: 2px solid var(--c-teal); outline-offset: 1px; }

      .ct-if-others { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 8px; }
      .ct-if-other { border: 1px solid var(--line); border-radius: 8px; padding: 8px 10px; }
      .ct-if-other-name { font-weight: 600; font-size: 13px; margin-bottom: 2px; }

      .ct-if-table { border-collapse: collapse; width: 100%; font-size: 12.5px; }
      .ct-if-table th { background: #003759; color: #FFFFFF; font-weight: 500; font-size: 11.5px; text-align: left; padding: 7px 8px; position: sticky; top: 0; white-space: nowrap; }
      .ct-if-table td { padding: 6px 8px; border-bottom: 1px solid var(--line); vertical-align: top; }
      .ct-if-table tbody tr:hover td { background: #FAFBF7; }
      .ct-if-group-row td { background: #EEF0E8 !important; font-weight: 600; font-size: 12px; padding-top: 7px; }
      .ct-if-group-count { font-family: "IBM Plex Mono", monospace; font-weight: 400; color: var(--ink-soft); margin-left: 4px; }
      .ct-if-mono { font-family: "IBM Plex Mono", monospace; }
      .ct-if-cell { display: flex; align-items: flex-start; justify-content: space-between; gap: 4px; min-width: 150px; }
      .ct-if-chips { display: flex; flex-wrap: wrap; gap: 3px; }
      .ct-if-chip { font-size: 11.5px; border-radius: 12px; padding: 2px 8px; background: #EEF0E8; color: var(--ink); white-space: nowrap; }
      .ct-if-chip-team { background: rgba(31,111,99,0.12); color: #185349; }
      .ct-if-chip-gap { background: #FBF3E4; color: var(--c-amber); border: 1px dashed #E2B66E; }
      .ct-if-chip-note { color: var(--ink-soft); }

      .ct-if-modal { max-width: 520px; }
      .ct-if-fieldset { border: none; padding: 0; margin: 0 0 10px; }
      .ct-if-fieldset:disabled { opacity: 0.45; }
      .ct-if-fieldset legend { font-size: 12px; font-weight: 600; color: var(--ink-soft); margin-bottom: 6px; padding: 0; }
      .ct-if-checks { display: grid; grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); gap: 6px; margin-bottom: 12px; }
      .ct-if-check { display: flex; align-items: center; gap: 6px; border: 1px solid var(--line); border-radius: 8px; padding: 6px 8px; font-size: 13px; cursor: pointer; }
      .ct-if-check-on { border-color: var(--c-teal); background: rgba(31,111,99,0.07); }
      .ct-if-check input { accent-color: var(--c-teal); margin: 0; }
      .ct-if-others-label { display: block; font-size: 12px; font-weight: 600; color: var(--ink-soft); margin-bottom: 4px; }
      .ct-if-others-label .ct-hint { font-weight: 400; font-size: 11.5px; }
      .ct-if-text { width: 100%; border: 1px solid var(--line); border-radius: 8px; padding: 7px 10px; font: inherit; font-size: 13px; }
      .ct-if-text:focus { outline: none; border-color: var(--c-teal); }
      .ct-if-nofixer { display: flex; align-items: center; gap: 8px; font-size: 13px; margin: 4px 0 8px; cursor: pointer; }
      .ct-if-nofixer input { accent-color: var(--c-teal); }
      .ct-if-modal-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 12px; }
      .ct-if-modal-actions .ct-btn-primary { background: var(--c-teal); color: #fff; border-color: var(--c-teal); }
      .ct-if-modal-actions .ct-btn-primary:hover { background: #185349; border-color: #185349; }

      @media (max-width: 480px) {
        .ct-if-grid { grid-template-columns: 1fr; }
        .ct-if-search { max-width: none; }
      }
    `}</style>
  );
}
