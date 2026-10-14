import { useState, useEffect, useMemo, useRef } from "react";
import { Pencil, X, Check, AlertTriangle, Search, Eye, Wrench } from "lucide-react";

// Interfaces section of the IT Analyst Resource Tracker.
//
// Records live in the same D1 kv_store as the rest of the board, under one
// shared key, read and written through window.storage (see storagePolyfill.js).
// Saves are conditional on the etag last read, so two people editing at once
// can't silently overwrite each other: on a conflict the latest data is
// reloaded and the edit is re-applied on top of it.
//
// Record fields: id, brands (["Bare Necessities"]), interface, source, check,
// msgType, status ("Enabled" | "Disabled"), monitors, resolvers.
// Ownership format (unchanged from the standalone Interface Support Tracker):
//   monitors:  [{ name, note }]  — who watches it; [{ name: "Unassigned" }] = gap
//   resolvers: [{ name, note }]  — who fixes it;   [{ name: "Unassigned" }] = gap,
//                                  [] = no fixer needed (e.g. documentation)

export const INTERFACES_KEY = "capacity-interfaces";
const UNASSIGNED = "Unassigned";

const SEED_INTERFACES = [
  {"id": 1, "brands": ["7FAM"], "interface": "XStore Integration", "source": "Movex", "check": "xStore", "msgType": "", "monitors": [{"name": "Dusko", "note": null}], "resolvers": [{"name": "Dusko", "note": null}], "status": "Enabled"},
  {"id": 2, "brands": ["Bare Necessities"], "interface": "ASN", "source": "Nexus", "check": "Movex - EDZ100", "msgType": "635", "monitors": [{"name": "Dusko", "note": null}, {"name": "Zack", "note": null}], "resolvers": [{"name": "Unassigned", "note": null}], "status": "Enabled"},
  {"id": 3, "brands": ["Bare Necessities"], "interface": "Inventory", "source": "Movex", "check": "Shopify", "msgType": "407", "monitors": [{"name": "Shelly", "note": null}, {"name": "Sayre", "note": null}], "resolvers": [{"name": "Unassigned", "note": null}], "status": "Enabled"},
  {"id": 4, "brands": ["Bare Necessities"], "interface": "Orders", "source": "Shopify", "check": "Movex", "msgType": "409", "monitors": [{"name": "Diego", "note": null}], "resolvers": [{"name": "Diego", "note": null}], "status": "Enabled"},
  {"id": 5, "brands": ["Bare Necessities"], "interface": "Ship Confirmation", "source": "Shopify", "check": "Movex", "msgType": "413", "monitors": [{"name": "EDI Team", "note": null}], "resolvers": [{"name": "Diego", "note": null}], "status": "Enabled"},
  {"id": 6, "brands": ["Bare Necessities"], "interface": "Returns", "source": "Shopify", "check": "Movex", "msgType": "", "monitors": [{"name": "Customer Service", "note": null}], "resolvers": [{"name": "Diego", "note": null}], "status": "Disabled"},
  {"id": 7, "brands": ["Bare Necessities"], "interface": "Techsera", "source": "Movex / Shopify", "check": "Omni", "msgType": "", "monitors": [{"name": "Diego", "note": null}, {"name": "Shelly", "note": null}, {"name": "Sayre", "note": null}], "resolvers": [{"name": "Abhijeet", "note": null}, {"name": "Diego", "note": null}], "status": "Enabled"},
  {"id": 8, "brands": ["FBM"], "interface": "ASN", "source": "Nexus", "check": "Movex - EDZ100", "msgType": "635", "monitors": [{"name": "Dusko", "note": null}, {"name": "Zack", "note": null}], "resolvers": [{"name": "Unassigned", "note": null}], "status": "Enabled"},
  {"id": 9, "brands": ["FBM"], "interface": "Inventory", "source": "Movex", "check": "Shopify", "msgType": "407", "monitors": [{"name": "Unassigned", "note": null}], "resolvers": [{"name": "Diego", "note": null}], "status": "Enabled"},
  {"id": 10, "brands": ["FBM"], "interface": "Orders", "source": "Shopify", "check": "Movex", "msgType": "409", "monitors": [{"name": "EDI Team", "note": null}], "resolvers": [{"name": "Unassigned", "note": null}], "status": "Enabled"},
  {"id": 11, "brands": ["FBM"], "interface": "Ship Confirmation", "source": "Shopify", "check": "Movex", "msgType": "413", "monitors": [{"name": "Customer Service", "note": null}], "resolvers": [{"name": "Diego", "note": null}], "status": "Enabled"},
  {"id": 12, "brands": ["PJ Salvage"], "interface": "ASN", "source": "Nexus", "check": "Movex - EDZ100", "msgType": "635", "monitors": [{"name": "Dusko", "note": null}, {"name": "Zack", "note": null}], "resolvers": [{"name": "Unassigned", "note": null}], "status": "Enabled"},
  {"id": 13, "brands": ["PJ Salvage"], "interface": "Inventory", "source": "Movex", "check": "Shopify", "msgType": "407", "monitors": [{"name": "Tierra", "note": null}, {"name": "Customer Service", "note": null}], "resolvers": [{"name": "Diego", "note": null}], "status": "Enabled"},
  {"id": 14, "brands": ["PJ Salvage"], "interface": "Orders", "source": "Shopify", "check": "Movex", "msgType": "407", "monitors": [{"name": "Unassigned", "note": null}], "resolvers": [{"name": "Diego", "note": null}], "status": "Enabled"},
  {"id": 15, "brands": ["PJ Salvage"], "interface": "Ship Confirmation", "source": "Shopify", "check": "Movex", "msgType": "413", "monitors": [{"name": "EDI Team", "note": null}], "resolvers": [{"name": "Diego", "note": null}], "status": "Enabled"},
  {"id": 16, "brands": ["PJ Salvage"], "interface": "Returns", "source": "Shopify", "check": "Movex - EDZ100", "msgType": "464", "monitors": [{"name": "EDI Team", "note": null}], "resolvers": [{"name": "Diego", "note": null}], "status": "Enabled"},
  {"id": 17, "brands": ["Splendid"], "interface": "ASN", "source": "Nexus", "check": "Movex - EDZ100", "msgType": "635", "monitors": [{"name": "Dusko", "note": null}, {"name": "Zack", "note": null}], "resolvers": [{"name": "Unassigned", "note": null}], "status": "Enabled"},
  {"id": 18, "brands": ["Splendid"], "interface": "Anaplan Data Integration", "source": "Movex", "check": "Anaplan", "msgType": "", "monitors": [{"name": "Dusko", "note": null}], "resolvers": [{"name": "Dusko", "note": null}], "status": "Disabled"},
  {"id": 19, "brands": ["Splendid"], "interface": "Inventory", "source": "Movex", "check": "Shopify", "msgType": "407", "monitors": [{"name": "Diego", "note": null}], "resolvers": [{"name": "Diego", "note": null}], "status": "Enabled"},
  {"id": 20, "brands": ["Splendid"], "interface": "Orders", "source": "Shopify", "check": "Movex", "msgType": "409", "monitors": [{"name": "EDI Team", "note": null}], "resolvers": [{"name": "Diego", "note": null}], "status": "Enabled"},
  {"id": 21, "brands": ["Splendid"], "interface": "Ship Confirmation", "source": "Shopify", "check": "Movex", "msgType": "413", "monitors": [{"name": "Customer Service", "note": null}], "resolvers": [{"name": "Diego", "note": null}], "status": "Enabled"},
  {"id": 22, "brands": ["Splendid"], "interface": "Returns", "source": "Shopify", "check": "Movex - EDZ100", "msgType": "486", "monitors": [{"name": "EDI Team", "note": null}], "resolvers": [{"name": "Diego", "note": null}], "status": "Enabled"},
  {"id": 23, "brands": ["Tifton Warehouse (Automation)"], "interface": "Inventory Variance", "source": "IntraOne", "check": "Movex", "msgType": "", "monitors": [{"name": "Paul", "note": null}], "resolvers": [{"name": "Paul", "note": null}, {"name": "Brent", "note": null}], "status": "Enabled"},
  {"id": 24, "brands": ["Tifton Warehouse (Automation)"], "interface": "Item Master", "source": "Movex", "check": "IntraOne", "msgType": "", "monitors": [{"name": "Unassigned", "note": null}], "resolvers": [{"name": "Unassigned", "note": null}], "status": "Enabled"},
  {"id": 25, "brands": ["Tifton Warehouse (Automation)"], "interface": "Orders", "source": "IntraOne", "check": "QlikView", "msgType": "", "monitors": [{"name": "Unassigned", "note": null}], "resolvers": [{"name": "Unassigned", "note": null}], "status": "Enabled"},
  {"id": 26, "brands": ["Tifton Warehouse (Automation)"], "interface": "Ship Confirmation", "source": "IntraOne", "check": "Movex", "msgType": "", "monitors": [{"name": "Paul", "note": null}], "resolvers": [{"name": "Unassigned", "note": null}], "status": "Enabled"},
  {"id": 27, "brands": ["Tifton Warehouse (Automation)"], "interface": "PIX", "source": "IntraOne", "check": "Movex", "msgType": "", "monitors": [{"name": "Paul", "note": null}], "resolvers": [{"name": "Unassigned", "note": null}], "status": "Enabled"},
  {"id": 28, "brands": ["Fontana Warehouse"], "interface": "Inventory Variance", "source": "Manhattan", "check": "Movex - EDZ100", "msgType": "", "monitors": [{"name": "Shelly", "note": null}], "resolvers": [{"name": "Unassigned", "note": null}], "status": "Enabled"},
  {"id": 29, "brands": ["Fontana Warehouse"], "interface": "Item Master", "source": "Movex", "check": "Manhattan", "msgType": "", "monitors": [{"name": "Shelly", "note": null}], "resolvers": [{"name": "Unassigned", "note": null}], "status": "Enabled"},
  {"id": 30, "brands": ["Fontana Warehouse"], "interface": "Orders", "source": "Manhattan", "check": "QlikView", "msgType": "", "monitors": [{"name": "Customer Service", "note": null}], "resolvers": [{"name": "Unassigned", "note": null}], "status": "Enabled"},
  {"id": 31, "brands": ["Fontana Warehouse"], "interface": "Ship Confirmation", "source": "Manhattan", "check": "Movex", "msgType": "", "monitors": [{"name": "Shelly", "note": null}], "resolvers": [{"name": "Unassigned", "note": null}], "status": "Enabled"},
  {"id": 32, "brands": ["Fontana Warehouse"], "interface": "PO Load", "source": "Nexus", "check": "Email Report", "msgType": "630", "monitors": [{"name": "Dusko", "note": null}, {"name": "Zack", "note": null}], "resolvers": [{"name": "Unassigned", "note": null}], "status": "Enabled"},
  {"id": 33, "brands": ["Fontana Warehouse"], "interface": "PIX", "source": "Manhattan", "check": "Movex", "msgType": "", "monitors": [{"name": "Shelly", "note": null}], "resolvers": [{"name": "Unassigned", "note": null}], "status": "Enabled"},
  {"id": 34, "brands": ["KWI"], "interface": "Item Master", "source": "Movex", "check": "KWI", "msgType": "646", "monitors": [{"name": "Dusko", "note": null}], "resolvers": [{"name": "Dusko", "note": null}], "status": "Enabled"},
  {"id": 35, "brands": ["KWI"], "interface": "Attribute Master", "source": "Movex", "check": "KWI", "msgType": "648", "monitors": [{"name": "Dusko", "note": null}], "resolvers": [{"name": "Dusko", "note": null}], "status": "Enabled"},
  {"id": 36, "brands": ["KWI"], "interface": "Ship Confirmation", "source": "KWI", "check": "Movex", "msgType": "856", "monitors": [{"name": "Dusko", "note": null}], "resolvers": [{"name": "Dusko", "note": null}], "status": "Enabled"},
  {"id": 37, "brands": ["KWI"], "interface": "Purchase Orders", "source": "Movex", "check": "KWI", "msgType": "446", "monitors": [{"name": "Dusko", "note": null}], "resolvers": [{"name": "Dusko", "note": null}], "status": "Enabled"},
  {"id": 38, "brands": ["Inspectario"], "interface": "Orders", "source": "Movex", "check": "Inspectario", "msgType": "628", "monitors": [{"name": "Dusko", "note": null}], "resolvers": [{"name": "Dusko", "note": null}], "status": "Enabled"},
  {"id": 39, "brands": ["NuOrder"], "interface": "Customers", "source": "Movex", "check": "NuOrder", "msgType": "", "monitors": [{"name": "Shelly", "note": null}], "resolvers": [{"name": "Unassigned", "note": null}], "status": "Enabled"},
  {"id": 40, "brands": ["Cymbio"], "interface": "DS Orders (all)", "source": "Retailer", "check": "Movex", "msgType": "471", "monitors": [{"name": "EDI Team", "note": null}], "resolvers": [{"name": "Sandy", "note": null}], "status": "Enabled"},
  {"id": 41, "brands": ["Cymbio"], "interface": "DS Orders (nordstrom/neimans)", "source": "Retailer", "check": "Movex", "msgType": "486", "monitors": [{"name": "EDI Team", "note": null}], "resolvers": [{"name": "Sandy", "note": null}], "status": "Enabled"}
];

const GROUP_OPTIONS = [
  { value: "none", label: "No grouping" },
  { value: "source", label: "Source" },
  { value: "check", label: "Check in" },
];


function norm(name) {
  return String(name || "").trim().toLowerCase();
}

function assigned(list) {
  return (list || []).filter((p) => p && p.name && p.name !== UNASSIGNED);
}

function isDisabled(r) {
  return String(r.status || "").toLowerCase() === "disabled";
}

// Disabled interfaces don't count as coverage gaps.
function needsMonitor(r) {
  return !isDisabled(r) && assigned(r.monitors).length === 0;
}

// An empty resolvers list means "no fixer needed", so only an explicit
// Unassigned entry counts as a gap.
function needsFixer(r) {
  return !isDisabled(r) && (r.resolvers || []).length > 0 && assigned(r.resolvers).length === 0;
}

function findPerson(list, name) {
  const n = norm(name);
  return (list || []).find((p) => norm(p.name) === n);
}

function brandLabel(r) {
  return (r.brands || []).join(", ") || "—";
}

// Keep the order of the master spreadsheet (grouped by brand / system).
function compareRecords(a, b) {
  return a.id - b.id;
}

function describe(r) {
  return `${r.interface} (${brandLabel(r)})`;
}

function matchesQuery(r, q) {
  if (!q) return true;
  const hay = [
    r.interface,
    r.source,
    r.check,
    r.status,
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

function groupKey(r, groupBy) {
  if (groupBy === "source") return r.source || "Not specified";
  if (groupBy === "check") return r.check || "Not specified";
  return "all";
}

// Every interface a person is on, as one row with their role(s).
function rowsForPerson(records, name) {
  return records
    .map((r) => {
      const watch = findPerson(r.monitors, name);
      const fix = findPerson(r.resolvers, name);
      if (!watch && !fix) return null;
      return { record: r, watch: !!watch, fix: !!fix, note: (watch && watch.note) || (fix && fix.note) || "" };
    })
    .filter(Boolean);
}

export default function InterfacesView({ members }) {
  const [records, setRecords] = useState([]);
  const [status, setStatus] = useState("loading"); // loading | ready | error
  const [saveState, setSaveState] = useState("idle"); // idle | saving | saved | error
  const [notice, setNotice] = useState("");
  const [view, setView] = useState("interfaces"); // interfaces | analyst
  const [brand, setBrand] = useState("");
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
        // First use: load the interfaces from the master spreadsheet.
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

  const brandOptions = useMemo(() => {
    // In spreadsheet order, so brands come first and warehouses/systems after.
    const set = new Set();
    [...records].sort(compareRecords).forEach((r) => (r.brands || []).forEach((b) => set.add(b)));
    return [...set];
  }, [records]);

  const q = query.trim().toLowerCase();
  const visible = useMemo(
    () =>
      records
        .filter((r) => !brand || (r.brands || []).includes(brand))
        .filter((r) => matchesQuery(r, q))
        .sort(compareRecords),
    [records, brand, q]
  );
  const memberNames = useMemo(() => new Set(members.map((m) => norm(m.name))), [members]);

  const gapsMonitor = visible.filter(needsMonitor).length;
  const gapsFixer = visible.filter(needsFixer).length;

  // Analysts first (in board order), then any other people or teams assigned.
  const people = useMemo(() => {
    const list = members.map((m) => ({ key: m.id, name: m.name, isAnalyst: true }));
    const seen = new Set(memberNames);
    records.forEach((r) => {
      [...assigned(r.monitors), ...assigned(r.resolvers)].forEach((p) => {
        const n = norm(p.name);
        if (seen.has(n)) return;
        seen.add(n);
        list.push({ key: `other:${n}`, name: p.name, isAnalyst: false });
      });
    });
    return list;
  }, [members, memberNames, records]);

  const editingRecord = editing ? records.find((r) => r.id === editing.id) : null;
  const filtersActive = !!(brand || q);

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

  // By-analyst view: one block per person, each a plain list of their interfaces.
  const shownPeople = (analyst ? people.filter((p) => p.key === analyst) : people)
    .map((p) => ({ ...p, rows: rowsForPerson(visible, p.name) }));
  const withRows = shownPeople.filter((p) => p.rows.length > 0);
  const analystsWithout = shownPeople.filter((p) => p.isAnalyst && p.rows.length === 0);
  const analystBlocks = withRows.filter((p) => p.isAnalyst);
  const otherBlocks = withRows.filter((p) => !p.isAnalyst);

  return (
    <div className="ct-if">
      <InterfacesStyle />

      <section className="ct-panel">
        <div className="ct-panel-head-row">
          <h2>Interfaces</h2>
          <span className={`ct-save ct-save-${saveState}`}>
            {saveState === "saving" ? "Saving…" : saveState === "saved" ? "Saved" : saveState === "error" ? "Save failed" : ""}
          </span>
        </div>
        <p className="ct-hint" style={{ marginBottom: 12 }}>
          Which interfaces each analyst watches for failures, and who fixes them when they break.
        </p>

        <div className="ct-if-controls">
          <div className="ct-segmented" role="tablist" aria-label="Interface view">
            <button type="button" role="tab" aria-selected={view === "interfaces"} className={view === "interfaces" ? "ct-seg ct-seg-on" : "ct-seg"} onClick={() => setView("interfaces")}>
              Interfaces
            </button>
            <button type="button" role="tab" aria-selected={view === "analyst"} className={view === "analyst" ? "ct-seg ct-seg-on" : "ct-seg"} onClick={() => setView("analyst")}>
              By analyst
            </button>
          </div>

          <div className="ct-identity">
            <label htmlFor="ct-if-brand">Brand / System</label>
            <select id="ct-if-brand" value={brand} onChange={(e) => setBrand(e.target.value)}>
              <option value="">All</option>
              {brandOptions.map((b) => (
                <option key={b} value={b}>{b}</option>
              ))}
            </select>
          </div>

          {view === "analyst" ? (
            <div className="ct-identity">
              <label htmlFor="ct-if-analyst">Analyst</label>
              <select id="ct-if-analyst" value={analyst} onChange={(e) => setAnalyst(e.target.value)}>
                <option value="">Everyone</option>
                {people.map((p) => (
                  <option key={p.key} value={p.key}>{p.name}</option>
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
              placeholder="Search interface, system, person…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label="Search interfaces"
            />
          </div>

          {filtersActive && (
            <button type="button" className="ct-btn ct-btn-icon" onClick={() => { setBrand(""); setQuery(""); }}>
              <X size={13} /> Clear filters
            </button>
          )}
        </div>

        <div className="ct-if-stats">
          <span className="ct-if-stat"><b>{visible.length}</b> interfaces{filtersActive ? " shown" : ""}</span>
          <span className={gapsMonitor ? "ct-if-stat ct-if-stat-warn" : "ct-if-stat"}><b>{gapsMonitor}</b> without a watcher</span>
          <span className={gapsFixer ? "ct-if-stat ct-if-stat-warn" : "ct-if-stat"}><b>{gapsFixer}</b> without a fixer</span>
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

      {view === "interfaces" ? (
        <AllInterfacesTable
          records={visible}
          groupBy={groupBy}
          memberNames={memberNames}
          onEdit={(id, role) => setEditing({ id, role })}
        />
      ) : (
        <section className="ct-panel">
          {withRows.length === 0 ? (
            <p className="ct-hint" style={{ margin: "6px 0" }}>No assignments match these filters.</p>
          ) : (
            <>
              {analystBlocks.map((p) => (
                <PersonBlock key={p.key} person={p} />
              ))}
              {otherBlocks.length > 0 && (
                <>
                  <div className="ct-if-divider">Other teams &amp; people</div>
                  {otherBlocks.map((p) => (
                    <PersonBlock key={p.key} person={p} />
                  ))}
                </>
              )}
            </>
          )}
          {analystsWithout.length > 0 && (
            <p className="ct-hint ct-if-without">
              No interfaces{filtersActive ? " matching these filters" : ""}: {analystsWithout.map((p) => p.name).join(", ")}
            </p>
          )}
          <p className="ct-caption">To change who watches or fixes an interface, use the pencil buttons in the Interfaces view.</p>
        </section>
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

function PersonBlock({ person }) {
  const watches = person.rows.filter((r) => r.watch).length;
  const fixes = person.rows.filter((r) => r.fix).length;
  return (
    <div className="ct-if-person">
      <div className="ct-if-person-head">
        <h3>{person.name}</h3>
        <span className="ct-hint">
          Watches {watches} · Fixes {fixes}
        </span>
      </div>
      <div className="ct-table-wrap">
        <table className="ct-if-table ct-if-person-table">
          <thead>
            <tr>
              <th>Brand / System</th>
              <th>Interface</th>
              <th>Source</th>
              <th>Check in</th>
              <th>Msg</th>
              <th>Role</th>
            </tr>
          </thead>
          <tbody>
            {person.rows.map(({ record: r, watch, fix, note }) => (
              <tr key={r.id} className={isDisabled(r) ? "ct-if-row-disabled" : undefined}>
                <td className="ct-if-brand-cell">{brandLabel(r)}</td>
                <td>
                  <InterfaceName record={r} />
                  {note && <div className="ct-if-note">{note}</div>}
                </td>
                <td>{r.source || <span className="ct-hint">—</span>}</td>
                <td>{r.check || <span className="ct-hint">—</span>}</td>
                <td className="ct-if-mono">{r.msgType || ""}</td>
                <td>
                  <span className="ct-if-roles">
                    {watch && <span className="ct-if-role ct-if-role-watch"><Eye size={11} /> Watches</span>}
                    {fix && <span className="ct-if-role ct-if-role-fix"><Wrench size={11} /> Fixes</span>}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function InterfaceName({ record: r }) {
  return (
    <>
      <strong>{r.interface}</strong>
      {isDisabled(r) && <span className="ct-if-disabled-tag">Disabled</span>}
    </>
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
      const k = groupKey(r, groupBy);
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(r);
    });
    const entries = [...map.entries()];
    if (groupBy !== "none") entries.sort((a, b) => a[0].localeCompare(b[0]));
    return entries;
  }, [records, groupBy]);

  if (records.length === 0) {
    return <div className="ct-empty">No interfaces match these filters.</div>;
  }

  return (
    <section className="ct-panel">
      <div className="ct-table-wrap">
        <table className="ct-if-table">
          <thead>
            <tr>
              <th>Brand / System</th>
              <th>Interface</th>
              <th>Source</th>
              <th>Check in</th>
              <th>Msg</th>
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
        Teal names are analysts on this board; amber marks an interface that still needs someone. Disabled interfaces are
        greyed out and don't count as gaps.
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
        <tr key={`${label || ""}-${r.id}`} className={isDisabled(r) ? "ct-if-row-disabled" : undefined}>
          <td className="ct-if-brand-cell">{brandLabel(r)}</td>
          <td><InterfaceName record={r} /></td>
          <td>{r.source || <span className="ct-hint">—</span>}</td>
          <td>{r.check || <span className="ct-hint">—</span>}</td>
          <td className="ct-if-mono">{r.msgType || ""}</td>
          <td>
            <div className="ct-if-cell">
              <OwnerChips list={r.monitors} memberNames={memberNames} emptyLabel="Unassigned" />
              <button type="button" className="ct-if-edit" onClick={() => onEdit(r.id, "monitor")} title="Edit watchers" aria-label={`Edit watchers: ${describe(r)}`}>
                <Pencil size={12} />
              </button>
            </div>
          </td>
          <td>
            <div className="ct-if-cell">
              <OwnerChips list={r.resolvers} memberNames={memberNames} emptyLabel="No fixer needed" />
              <button type="button" className="ct-if-edit" onClick={() => onEdit(r.id, "resolve")} title="Edit fixers" aria-label={`Edit fixers: ${describe(r)}`}>
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
            {role === "monitor" ? "Who monitors" : "Who fixes"} {describe(record)}?
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



      .ct-if-edit { flex-shrink: 0; background: none; border: 1px solid transparent; border-radius: 6px; padding: 4px 5px; color: var(--ink-soft); cursor: pointer; display: inline-flex; }
      .ct-if-edit:hover { border-color: var(--line); color: var(--c-teal); background: var(--surface); }
      .ct-if-edit:focus-visible { outline: 2px solid var(--c-teal); outline-offset: 1px; }


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

      .ct-if-brand-cell { font-weight: 600; color: #003759; white-space: nowrap; }
      .ct-if-person { padding: 6px 0 14px; }
      .ct-if-person + .ct-if-person { border-top: 1px solid var(--line); padding-top: 14px; }
      .ct-if-person-head { display: flex; align-items: baseline; gap: 12px; margin-bottom: 6px; }
      .ct-if-person-head h3 { font-family: "Space Grotesk", sans-serif; font-size: 15px; margin: 0; }
      .ct-if-person-table th:nth-child(1) { width: 18%; }
      .ct-if-person-table th:nth-child(2) { width: 22%; }
      .ct-if-person-table th:nth-child(3) { width: 22%; }
      .ct-if-person-table th:nth-child(4) { width: 14%; }
      .ct-if-person-table th:nth-child(5) { width: 6%; }
      .ct-if-person-table { table-layout: fixed; }
      .ct-if-roles { display: inline-flex; gap: 4px; flex-wrap: wrap; }
      .ct-if-role { display: inline-flex; align-items: center; gap: 4px; font-size: 11.5px; border-radius: 12px; padding: 2px 8px; white-space: nowrap; }
      .ct-if-role-watch { background: rgba(31,111,99,0.12); color: #185349; }
      .ct-if-role-fix { background: rgba(0,55,89,0.1); color: #003759; }
      .ct-if-divider { font-size: 11.5px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; color: var(--ink-soft); border-top: 2px solid var(--line); padding: 14px 0 4px; margin-top: 4px; }
      .ct-if-without { font-size: 12.5px; margin: 10px 0 0; padding-top: 10px; border-top: 1px solid var(--line); }
      .ct-if-note { color: var(--c-teal); font-style: italic; font-size: 11.5px; font-weight: 400; }

      .ct-if-row-disabled td { color: var(--ink-soft); }
      .ct-if-row-disabled td strong { color: var(--ink-soft); }
      .ct-if-row-disabled .ct-if-chip { opacity: 0.6; }
      .ct-if-disabled-tag { display: inline-block; margin-left: 6px; font-size: 10.5px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; color: #8A4B2A; background: #F6E6DC; border-radius: 4px; padding: 1px 5px; vertical-align: 1px; }

      @media (max-width: 480px) {
        .ct-if-search { max-width: none; }
      }
    `}</style>
  );
}
