// Cloudflare Worker for the DELTA IT Resource and Project Allocation tracker.
//
// Responsibilities:
//   1. Gate every request behind a single shared password (server-side check,
//      not just a client-side JS prompt).
//   2. Serve a small key/value API backed by D1, matching the interface the
//      React app already expects (get/set/list/delete).
//   3. Serve the built frontend (the Vite output in /dist) for everything else.
//   4. Serve each person's public update form at /update/<personal link>, which
//      can change only that person's allocation (no password needed).
//   5. Let the board create, copy and turn off those personal links.
//
// Required secrets — either method works, the code below handles both:
//   Plain Worker secret:   wrangler secret put SITE_PASSWORD / SESSION_SECRET
//   Secrets Store binding: added via the dashboard's Bindings tab
//   SITE_PASSWORD   - the plaintext password visitors must enter
//   SESSION_SECRET  - a random string used as the session cookie's value
//
// Required bindings (see wrangler.toml):
//   DB      - the D1 database
//   ASSETS  - the built static frontend

const COOKIE_NAME = "capacity_session";
const MAX_AGE_SECONDS = 60 * 60 * 24 * 30; // 30 days

// A Secrets Store binding is an object you must call .get() on (async).
// A plain `wrangler secret put` value is just a string already.
// This works with either, so it doesn't matter which one was used.
async function resolveSecret(value) {
  if (value && typeof value.get === "function") {
    return await value.get();
  }
  return value;
}

function getCookie(request, name) {
  const header = request.headers.get("Cookie") || "";
  const match = header.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}

async function isAuthenticated(request, env) {
  const cookie = getCookie(request, COOKIE_NAME);
  if (cookie === null) return false;
  const sessionSecret = await resolveSecret(env.SESSION_SECRET);
  return Boolean(sessionSecret) && cookie === sessionSecret;
}

function loginPageHtml(error) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>DELTA IT Resource and Project Allocation — Sign in</title>
  <style>
    body {
      font-family: -apple-system, "Segoe UI", sans-serif;
      background: linear-gradient(180deg, #DCEBF7 0%, #FFFFFF 55%);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      margin: 0;
    }
    form {
      background: #fff;
      border: 1px solid #D9DCD1;
      border-radius: 14px;
      padding: 32px;
      width: 280px;
      box-shadow: 0 4px 20px rgba(0,0,0,0.06);
    }
    h1 { font-size: 16px; margin: 0 0 18px; color: #1B2320; }
    input {
      width: 100%;
      box-sizing: border-box;
      padding: 10px 12px;
      border: 1px solid #D9DCD1;
      border-radius: 8px;
      font-size: 14px;
      margin-bottom: 12px;
    }
    button {
      width: 100%;
      padding: 10px 12px;
      background: #1F6F63;
      color: #fff;
      border: none;
      border-radius: 8px;
      font-size: 14px;
      cursor: pointer;
    }
    button:hover { background: #185349; }
    .error { color: #C1443C; font-size: 12.5px; margin: -6px 0 12px; }
  </style>
</head>
<body>
  <form method="POST" action="/login">
    <h1>Enter password to continue</h1>
    ${error ? `<div class="error">Incorrect password — try again.</div>` : ""}
    <input type="password" name="password" placeholder="Password" autofocus />
    <button type="submit">Sign in</button>
  </form>
</body>
</html>`;
}

async function handleLogin(request, env) {
  if (request.method === "GET") {
    return new Response(loginPageHtml(false), { headers: { "Content-Type": "text/html" } });
  }

  const formData = await request.formData();
  const password = formData.get("password") || "";

  const sitePassword = await resolveSecret(env.SITE_PASSWORD);
  const sessionSecret = await resolveSecret(env.SESSION_SECRET);

  if (!sitePassword || !sessionSecret) {
    const missing = [!sitePassword && "SITE_PASSWORD", !sessionSecret && "SESSION_SECRET"]
      .filter(Boolean)
      .join(" and ");
    return new Response(
      `Server misconfigured: ${missing} not set. Add ${missing} as a Worker secret or Secrets Store binding (variable name must match exactly), then redeploy.`,
      { status: 500, headers: { "Content-Type": "text/plain" } }
    );
  }

  if (password !== sitePassword) {
    return new Response(loginPageHtml(true), {
      status: 401,
      headers: { "Content-Type": "text/html" },
    });
  }

  const headers = new Headers();
  headers.set("Location", "/");
  headers.append(
    "Set-Cookie",
    `${COOKIE_NAME}=${encodeURIComponent(sessionSecret)}; HttpOnly; Secure; Path=/; Max-Age=${MAX_AGE_SECONDS}; SameSite=Lax`
  );
  return new Response(null, { status: 302, headers });
}

// ---------------------------------------------------------------------------
// Shared constants (must match src/CapacityTracker.jsx)
// ---------------------------------------------------------------------------

const DATA_KEY = "capacity-board-data";
const BACKUP_PREFIX = "capacity-board-backup:";
const MAX_BACKUPS = 10;

// Personal update-form links live here, as { [memberId]: token }. Keys that
// start with "capacity-form-" are managed only by the /api/links endpoints and
// are hidden from the general key/value API.
const LINKS_KEY = "capacity-form-links";
const PROTECTED_PREFIX = "capacity-form-";

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function isProtectedKey(key) {
  return typeof key === "string" && key.startsWith(PROTECTED_PREFIX);
}

// ---------------------------------------------------------------------------
// Key/value API used by the board (password protected)
// ---------------------------------------------------------------------------
//
// Every read returns an "etag" (a fingerprint of the stored value). When the
// board saves, it sends back the etag it last saw as "ifMatch". If the stored
// value has changed since then (another person's edit, or an update-form
// submission), the save is refused with 409 instead of silently overwriting.

async function handleKvApi(request, env, url) {
  const path = url.pathname;

  if (path === "/api/kv/get" && request.method === "GET") {
    const key = url.searchParams.get("key");
    if (!key) return jsonResponse({ error: "missing key" }, 400);
    if (isProtectedKey(key)) return jsonResponse({ error: "forbidden" }, 403);
    const row = await env.DB.prepare("SELECT value FROM kv_store WHERE key = ?").bind(key).first();
    if (!row) return jsonResponse({ error: "not_found" }, 404);
    return jsonResponse({ key, value: row.value, etag: await sha256Hex(row.value) });
  }

  if (path === "/api/kv/set" && request.method === "POST") {
    const body = await request.json();
    if (!body || typeof body.key !== "string" || typeof body.value !== "string") {
      return jsonResponse({ error: "key and value (strings) required" }, 400);
    }
    if (isProtectedKey(body.key)) return jsonResponse({ error: "forbidden" }, 403);

    if (typeof body.ifMatch === "string" && body.ifMatch) {
      // Conditional save: only write if nobody else has changed it.
      const row = await env.DB.prepare("SELECT value FROM kv_store WHERE key = ?").bind(body.key).first();
      if (!row || (await sha256Hex(row.value)) !== body.ifMatch) {
        return jsonResponse({ error: "conflict" }, 409);
      }
      const result = await env.DB.prepare(
        "UPDATE kv_store SET value = ?, updated_at = datetime('now') WHERE key = ? AND value = ?"
      )
        .bind(body.value, body.key, row.value)
        .run();
      if (!result.meta || result.meta.changes !== 1) {
        return jsonResponse({ error: "conflict" }, 409);
      }
    } else {
      await env.DB.prepare(
        `INSERT INTO kv_store (key, value, updated_at) VALUES (?, ?, datetime('now'))
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
      )
        .bind(body.key, body.value)
        .run();
    }
    return jsonResponse({ key: body.key, value: body.value, etag: await sha256Hex(body.value) });
  }

  if (path === "/api/kv/delete" && request.method === "POST") {
    const body = await request.json();
    if (!body || typeof body.key !== "string") {
      return jsonResponse({ error: "key (string) required" }, 400);
    }
    if (isProtectedKey(body.key)) return jsonResponse({ error: "forbidden" }, 403);
    await env.DB.prepare("DELETE FROM kv_store WHERE key = ?").bind(body.key).run();
    return jsonResponse({ key: body.key, deleted: true });
  }

  if (path === "/api/kv/list" && request.method === "GET") {
    const prefix = url.searchParams.get("prefix") || "";
    const { results } = await env.DB.prepare("SELECT key FROM kv_store WHERE key LIKE ?")
      .bind(`${prefix}%`)
      .all();
    return jsonResponse({ keys: results.map((r) => r.key).filter((k) => !isProtectedKey(k)) });
  }

  return jsonResponse({ error: "not_found" }, 404);
}

// ---------------------------------------------------------------------------
// Personal link management (password protected, used by the board)
// ---------------------------------------------------------------------------

function newToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function readLinks(env) {
  const row = await env.DB.prepare("SELECT value FROM kv_store WHERE key = ?").bind(LINKS_KEY).first();
  if (!row) return {};
  try {
    const parsed = JSON.parse(row.value);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (e) {
    return {};
  }
}

async function writeLinks(env, links) {
  await env.DB.prepare(
    `INSERT INTO kv_store (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  )
    .bind(LINKS_KEY, JSON.stringify(links))
    .run();
}

function linkUrl(origin, token) {
  return `${origin}/update/${token}`;
}

function linksForResponse(links, origin) {
  const out = {};
  Object.entries(links).forEach(([memberId, token]) => {
    out[memberId] = linkUrl(origin, token);
  });
  return out;
}

async function handleLinksApi(request, env, url) {
  if (request.method === "GET") {
    const links = await readLinks(env);
    return jsonResponse({ links: linksForResponse(links, url.origin) });
  }

  if (request.method === "POST") {
    const body = await request.json().catch(() => null);
    if (!body || typeof body.memberId !== "string" || !["create", "revoke"].includes(body.action)) {
      return jsonResponse({ error: "memberId and action ('create' or 'revoke') required" }, 400);
    }
    const links = await readLinks(env);
    if (body.action === "create") {
      links[body.memberId] = newToken();
    } else {
      delete links[body.memberId];
    }
    await writeLinks(env, links);
    return jsonResponse({ links: linksForResponse(links, url.origin) });
  }

  return jsonResponse({ error: "not_found" }, 404);
}

// ---------------------------------------------------------------------------
// Public update form (no password; the personal link is the key)
// ---------------------------------------------------------------------------

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{20,64}$/;

async function memberIdForToken(env, token) {
  if (!TOKEN_PATTERN.test(token)) return null;
  const links = await readLinks(env);
  const match = Object.entries(links).find(([, t]) => t === token);
  return match ? match[0] : null;
}

// These mirror the helpers in src/CapacityTracker.jsx so the board and the
// form record history the same way.
function utcTodayISO() {
  return new Date().toISOString().slice(0, 10);
}

function utcMonthKey() {
  return new Date().toISOString().slice(0, 7);
}

function monthKeyFromISO(iso) {
  return iso && /^\d{4}-\d{2}/.test(iso) ? iso.slice(0, 7) : utcMonthKey();
}

function pruneZeros(alloc) {
  const out = {};
  Object.entries(alloc || {}).forEach(([pid, v]) => {
    if (v) out[pid] = v;
  });
  return out;
}

// Keep in sync with ensureHistory / updatesFromHistory / recordUpdate in
// src/CapacityTracker.jsx.
const UPDATE_COALESCE_MS = 30 * 60 * 1000;

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

// The form sends the month from the person's own clock (the board does the
// same). Accept it only if it's within a month of the server's date.
function acceptableMonthKey(clientKey) {
  if (typeof clientKey !== "string" || !/^\d{4}-\d{2}$/.test(clientKey)) return utcMonthKey();
  const [y, m] = utcMonthKey().split("-").map(Number);
  const near = [-1, 0, 1].map((n) => {
    const d = new Date(Date.UTC(y, m - 1 + n, 1));
    return d.toISOString().slice(0, 7);
  });
  return near.includes(clientKey) ? clientKey : utcMonthKey();
}

function sortProjectsForResource(projects, alloc) {
  const a = alloc || {};
  return [...projects].sort((p, q) => {
    const pv = a[p.id] || 0;
    const qv = a[q.id] || 0;
    if (qv !== pv) return qv - pv;
    return p.name.localeCompare(q.name);
  });
}

async function writeBackup(env, json) {
  await env.DB.prepare("INSERT INTO kv_store (key, value, updated_at) VALUES (?, ?, datetime('now'))")
    .bind(`${BACKUP_PREFIX}${Date.now()}`, json)
    .run();
  const { results } = await env.DB.prepare("SELECT key FROM kv_store WHERE key LIKE ? ORDER BY key")
    .bind(`${BACKUP_PREFIX}%`)
    .all();
  const keys = results.map((r) => r.key);
  const toDelete = keys.slice(0, Math.max(0, keys.length - MAX_BACKUPS));
  if (toDelete.length) {
    await env.DB.batch(toDelete.map((k) => env.DB.prepare("DELETE FROM kv_store WHERE key = ?").bind(k)));
  }
}

async function handleFormPage(env, token) {
  const memberId = await memberIdForToken(env, token);
  if (!memberId) return formMessagePage("This link isn't active", "Ask your manager for a new update link.", 404);

  const row = await env.DB.prepare("SELECT value FROM kv_store WHERE key = ?").bind(DATA_KEY).first();
  if (!row) return formMessagePage("The board isn't available", "Try again in a few minutes.", 503);
  const data = JSON.parse(row.value);
  const member = (data.members || []).find((m) => m.id === memberId);
  if (!member) return formMessagePage("This link isn't active", "Ask your manager for a new update link.", 404);

  const alloc = (data.allocations || {})[memberId] || {};
  const active = (data.projects || []).filter((p) => !p.archived);
  const payload = {
    name: member.name,
    lastUpdated: member.lastUpdated || "",
    lastRequested: member.lastRequested || "",
    projects: sortProjectsForResource(active, alloc).map((p) => ({
      id: p.id,
      name: p.name,
      color: p.color,
      value: alloc[p.id] || 0,
    })),
  };
  return htmlResponse(formPageHtml(payload));
}

async function handleFormSubmit(request, env, token) {
  const memberId = await memberIdForToken(env, token);
  if (!memberId) return jsonResponse({ error: "This link isn't active. Ask your manager for a new one." }, 404);

  const body = await request.json().catch(() => null);
  const submitted = body && body.allocations;
  if (!submitted || typeof submitted !== "object" || Array.isArray(submitted)) {
    return jsonResponse({ error: "Nothing to save." }, 400);
  }
  const monthKey = acceptableMonthKey(body.month);

  // Retry a few times in case someone saves the board at the same instant.
  for (let attempt = 0; attempt < 5; attempt++) {
    const row = await env.DB.prepare("SELECT value FROM kv_store WHERE key = ?").bind(DATA_KEY).first();
    if (!row) return jsonResponse({ error: "The board isn't available. Try again in a few minutes." }, 503);

    const data = ensureHistory(JSON.parse(row.value));
    if (!data.members.some((m) => m.id === memberId)) {
      return jsonResponse({ error: "This link isn't active. Ask your manager for a new one." }, 404);
    }

    const activeIds = new Set(data.projects.filter((p) => !p.archived).map((p) => p.id));
    for (const [pid, v] of Object.entries(submitted)) {
      if (!activeIds.has(pid)) {
        return jsonResponse({ error: "The project list changed. Reload this page and try again." }, 409);
      }
      if (!Number.isInteger(v) || v < 0 || v > 100) {
        return jsonResponse({ error: "Each project needs a whole number from 0 to 100." }, 400);
      }
    }

    // Keep any entries for projects not shown on the form, replace the rest.
    const previous = data.allocations[memberId] || {};
    const next = {};
    Object.entries(previous).forEach(([pid, v]) => {
      if (!activeIds.has(pid) && v) next[pid] = v;
    });
    Object.entries(submitted).forEach(([pid, v]) => {
      if (v) next[pid] = v;
    });
    const total = Object.values(next).reduce((a, b) => a + b, 0);
    if (total > 100) {
      return jsonResponse({ error: `That adds up to ${total}%. Bring it down to 100% or less.` }, 400);
    }

    const today = utcTodayISO();
    const updated = {
      ...data,
      allocations: { ...data.allocations, [memberId]: next },
      members: data.members.map((m) => (m.id === memberId ? { ...m, lastUpdated: today } : m)),
      history: { ...data.history, [monthKey]: { ...(data.history[monthKey] || {}), [memberId]: pruneZeros(next) } },
      updates: recordUpdate(data.updates, memberId, next, "form"),
    };
    const json = JSON.stringify(updated);

    const result = await env.DB.prepare(
      "UPDATE kv_store SET value = ?, updated_at = datetime('now') WHERE key = ? AND value = ?"
    )
      .bind(json, DATA_KEY, row.value)
      .run();

    if (result.meta && result.meta.changes === 1) {
      try {
        await writeBackup(env, json);
      } catch (e) {
        // Backups are best-effort, same as on the board.
      }
      return jsonResponse({ ok: true, lastUpdated: today, total });
    }
  }

  return jsonResponse({ error: "The board was busy. Press Save again." }, 409);
}

function htmlResponse(html, status = 200) {
  return new Response(html, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Robots-Tag": "noindex, nofollow",
      "X-Frame-Options": "DENY",
    },
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

const FORM_STYLES = `
  :root {
    --bg: #ECEEE7;
    --surface: #FFFFFF;
    --ink: #1B2320;
    --ink-soft: #58635C;
    --line: #D9DCD1;
    --teal: #1F6F63;
    --teal-dark: #185349;
    --amber: #B9791F;
    --danger: #C1443C;
    --header: #334249;
    color-scheme: light;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: "IBM Plex Sans", -apple-system, "Segoe UI", sans-serif;
    color: var(--ink);
    background: linear-gradient(180deg, #9AC6E2 0%, #DCEBF7 260px, var(--bg) 520px);
    min-height: 100vh;
    -webkit-font-smoothing: antialiased;
  }
  .wrap { max-width: 560px; margin: 0 auto; padding: 28px 16px 140px; }
  .org { font-size: 13px; color: #263138; margin: 0 0 18px; }
  .card {
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: 14px;
    padding: 22px 20px;
  }
  h1 {
    font-family: "Space Grotesk", "IBM Plex Sans", -apple-system, sans-serif;
    font-size: 24px; line-height: 1.2; letter-spacing: -0.01em; margin: 0 0 6px;
  }
  .sub { font-size: 14px; color: var(--ink-soft); margin: 0 0 4px; line-height: 1.5; }
  .request { font-size: 13px; color: var(--amber); margin: 8px 0 0; }

  .meter { margin: 22px 0 6px; }
  .bar {
    display: flex; height: 22px; border-radius: 6px; overflow: hidden;
    background: repeating-linear-gradient(135deg, #F3F4EF 0 6px, #E8EAE2 6px 12px);
    border: 1px solid var(--line);
  }
  .bar span { display: block; height: 100%; transition: flex-basis 160ms ease; }
  .bar.over { outline: 2px solid var(--danger); outline-offset: 1px; }
  .meter-text { display: flex; justify-content: space-between; align-items: baseline; margin-top: 8px; font-size: 13px; color: var(--ink-soft); }
  .total { font-size: 20px; font-weight: 600; color: var(--ink); font-variant-numeric: tabular-nums; }
  .total.over { color: var(--danger); }

  ul { list-style: none; margin: 18px 0 0; padding: 0; }
  li { display: flex; align-items: center; gap: 12px; padding: 10px 0; border-top: 1px solid #EEF0EA; }
  li:first-child { border-top: none; }
  .dot { width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0; }
  .pname { flex: 1; font-size: 14.5px; line-height: 1.35; min-width: 0; }
  li.zero .pname { color: var(--ink-soft); }
  .stepper { display: flex; align-items: center; border: 1px solid var(--line); border-radius: 8px; overflow: hidden; flex-shrink: 0; }
  .stepper button {
    width: 34px; height: 36px; border: none; background: #F6F7F3; color: var(--ink);
    font-size: 17px; cursor: pointer; font-family: inherit;
  }
  .stepper button:hover { background: #ECEEE7; }
  .stepper input {
    width: 52px; height: 36px; border: none; border-left: 1px solid var(--line); border-right: 1px solid var(--line);
    text-align: right; padding: 0 16px 0 4px; font-size: 15px; font-family: inherit; color: var(--ink);
    font-variant-numeric: tabular-nums; -moz-appearance: textfield; appearance: textfield;
  }
  .stepper input::-webkit-outer-spin-button, .stepper input::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
  .pct { position: relative; }
  .pct::after { content: "%"; position: absolute; right: 6px; top: 50%; transform: translateY(-50%); font-size: 12px; color: var(--ink-soft); pointer-events: none; }

  .footer {
    position: fixed; left: 0; right: 0; bottom: 0;
    background: var(--header); color: #fff;
    padding: 12px 16px calc(12px + env(safe-area-inset-bottom, 0px));
  }
  .footer-inner { max-width: 560px; margin: 0 auto; display: flex; align-items: center; gap: 14px; }
  .status { flex: 1; font-size: 13.5px; line-height: 1.4; color: #D6E2E7; }
  .status.ok { color: #A8E0CF; }
  .status.err { color: #FFB9B3; }
  .save {
    background: var(--teal); color: #fff; border: none; border-radius: 8px;
    padding: 11px 18px; font-size: 14.5px; font-weight: 600; font-family: inherit; cursor: pointer; flex-shrink: 0;
  }
  .save:hover:not(:disabled) { background: var(--teal-dark); }
  .save:disabled { background: #5A6A70; color: #C9D3D6; cursor: not-allowed; }
  .note { font-size: 12.5px; color: var(--ink-soft); margin: 16px 4px 0; line-height: 1.5; }

  button:focus-visible, input:focus-visible { outline: 2px solid #4D9BC7; outline-offset: 2px; }
  @media (prefers-reduced-motion: reduce) { .bar span { transition: none; } }
  @media (max-width: 380px) { .stepper button { width: 30px; } .stepper input { width: 46px; } }
`;

function formMessagePage(title, message, status) {
  return htmlResponse(
    `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <style>${FORM_STYLES}</style>
</head>
<body>
  <main class="wrap">
    <p class="org">DELTA IT Resource and Project Allocation</p>
    <div class="card">
      <h1>${escapeHtml(title)}</h1>
      <p class="sub">${escapeHtml(message)}</p>
    </div>
  </main>
</body>
</html>`,
    status
  );
}

function formPageHtml(payload) {
  const json = JSON.stringify(payload).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Update your allocation</title>
  <style>${FORM_STYLES}</style>
</head>
<body>
  <main class="wrap">
    <p class="org">DELTA IT Resource and Project Allocation</p>
    <div class="card">
      <h1 id="title"></h1>
      <p class="sub">Set roughly how your time splits across projects right now. Leave anything you're not working on at 0.</p>
      <p class="sub" id="last"></p>
      <p class="request" id="request" hidden></p>

      <div class="meter" aria-hidden="true">
        <div class="bar" id="bar"></div>
      </div>
      <div class="meter-text">
        <span id="meter-note"></span>
        <span class="total" id="total" aria-live="polite"></span>
      </div>

      <ul id="list"></ul>
    </div>
    <p class="note">This link is just for you. Anyone who has it can change your allocation, so please don't forward it.</p>
  </main>

  <div class="footer">
    <div class="footer-inner">
      <span class="status" id="status" role="status"></span>
      <button class="save" id="save" type="button">Save allocation</button>
    </div>
  </div>

<script>
(function () {
  var data = ${json};
  var values = {};
  data.projects.forEach(function (p) { values[p.id] = p.value; });
  var dirty = false;
  var saving = false;

  function fmt(iso) {
    if (!iso) return "";
    var parts = iso.split("-");
    return parts[1] + "/" + parts[2] + "/" + parts[0].slice(2);
  }

  document.getElementById("title").textContent = "Hi " + data.name + ", update your allocation";
  document.getElementById("last").textContent = data.lastUpdated
    ? "Last updated " + fmt(data.lastUpdated) + "."
    : "You haven't submitted an allocation yet.";
  if (data.lastRequested && (!data.lastUpdated || data.lastRequested > data.lastUpdated)) {
    var req = document.getElementById("request");
    req.textContent = "An update was requested from you on " + fmt(data.lastRequested) + ".";
    req.hidden = false;
  }

  var list = document.getElementById("list");
  var bar = document.getElementById("bar");
  var inputs = {};

  data.projects.forEach(function (p) {
    var li = document.createElement("li");
    li.id = "row-" + p.id;

    var dot = document.createElement("span");
    dot.className = "dot";
    dot.style.background = p.color;

    var name = document.createElement("label");
    name.className = "pname";
    name.textContent = p.name;
    name.htmlFor = "in-" + p.id;

    var stepper = document.createElement("div");
    stepper.className = "stepper";

    var minus = document.createElement("button");
    minus.type = "button";
    minus.textContent = "\\u2212";
    minus.setAttribute("aria-label", "Decrease " + p.name + " by 5");
    minus.addEventListener("click", function () { setValue(p.id, values[p.id] - 5); });

    var wrap = document.createElement("span");
    wrap.className = "pct";
    var input = document.createElement("input");
    input.type = "number";
    input.inputMode = "numeric";
    input.min = "0";
    input.max = "100";
    input.step = "1";
    input.id = "in-" + p.id;
    input.value = String(p.value);
    input.addEventListener("input", function () {
      var n = parseInt(input.value, 10);
      values[p.id] = isNaN(n) ? 0 : Math.max(0, Math.min(100, n));
      dirty = true;
      render(false);
    });
    input.addEventListener("blur", function () { input.value = String(values[p.id]); });
    input.addEventListener("focus", function () { input.select(); });
    wrap.appendChild(input);
    inputs[p.id] = input;

    var plus = document.createElement("button");
    plus.type = "button";
    plus.textContent = "+";
    plus.setAttribute("aria-label", "Increase " + p.name + " by 5");
    plus.addEventListener("click", function () { setValue(p.id, values[p.id] + 5); });

    stepper.appendChild(minus);
    stepper.appendChild(wrap);
    stepper.appendChild(plus);
    li.appendChild(dot);
    li.appendChild(name);
    li.appendChild(stepper);
    list.appendChild(li);

    var seg = document.createElement("span");
    seg.id = "seg-" + p.id;
    seg.style.background = p.color;
    bar.appendChild(seg);
  });

  function setValue(id, v) {
    values[id] = Math.max(0, Math.min(100, Math.round(v)));
    inputs[id].value = String(values[id]);
    dirty = true;
    render(false);
  }

  function totalNow() {
    var t = 0;
    Object.keys(values).forEach(function (k) { t += values[k]; });
    return t;
  }

  function setStatus(text, kind) {
    var el = document.getElementById("status");
    el.textContent = text;
    el.className = "status" + (kind ? " " + kind : "");
  }

  function render(keepStatus) {
    var total = totalNow();
    var over = total > 100;
    data.projects.forEach(function (p) {
      var seg = document.getElementById("seg-" + p.id);
      var share = over ? (values[p.id] / total) * 100 : values[p.id];
      seg.style.flex = "0 0 " + share + "%";
      document.getElementById("row-" + p.id).className = values[p.id] ? "" : "zero";
    });
    bar.className = over ? "bar over" : "bar";
    var totalEl = document.getElementById("total");
    totalEl.textContent = total + "%";
    totalEl.className = over ? "total over" : "total";
    document.getElementById("meter-note").textContent =
      over ? (total - 100) + "% over capacity" : total === 100 ? "Fully allocated" : (100 - total) + "% unallocated";

    var btn = document.getElementById("save");
    btn.disabled = saving || over;
    if (keepStatus) return;
    if (over) setStatus("You're " + (total - 100) + "% over. Lower a project to save.", "err");
    else if (dirty) setStatus("You have unsaved changes.", "");
    else setStatus("", "");
  }

  function localMonth() {
    var d = new Date();
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0");
  }

  document.getElementById("save").addEventListener("click", function () {
    if (saving || totalNow() > 100) return;
    saving = true;
    render(true);
    setStatus("Saving\\u2026", "");
    fetch(window.location.pathname, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ allocations: values, month: localMonth() })
    })
      .then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (body) { return { ok: res.ok, body: body }; });
      })
      .then(function (r) {
        saving = false;
        if (r.ok) {
          dirty = false;
          data.lastUpdated = r.body.lastUpdated;
          document.getElementById("last").textContent = "Last updated " + fmt(r.body.lastUpdated) + ".";
          document.getElementById("request").hidden = true;
          render(true);
          setStatus("Saved. Your allocation is on the team board.", "ok");
        } else {
          render(true);
          setStatus(r.body.error || "Couldn't save. Try again.", "err");
        }
      })
      .catch(function () {
        saving = false;
        render(true);
        setStatus("Couldn't reach the board. Check your connection and press Save again.", "err");
      });
  });

  window.addEventListener("beforeunload", function (e) {
    if (dirty) { e.preventDefault(); e.returnValue = ""; }
  });

  render(false);
})();
</script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Login page and its POST handler are always reachable, unauthenticated.
    if (url.pathname === "/login") {
      return handleLogin(request, env);
    }

    // Personal update-form links are public: the unguessable link itself
    // identifies the person, and it can only change that person's numbers.
    const formMatch = url.pathname.match(/^\/update\/([^/]+)\/?$/);
    if (formMatch) {
      const token = formMatch[1];
      if (request.method === "GET") return handleFormPage(env, token);
      if (request.method === "POST") return handleFormSubmit(request, env, token);
      return new Response("Method not allowed", { status: 405 });
    }

    const authed = await isAuthenticated(request, env);

    if (url.pathname.startsWith("/api/")) {
      if (!authed) return jsonResponse({ error: "unauthorized" }, 401);
      if (url.pathname === "/api/links") return handleLinksApi(request, env, url);
      return handleKvApi(request, env, url);
    }

    if (!authed) {
      // Not logged in — send everything else to the login page.
      return Response.redirect(`${url.origin}/login`, 302);
    }

    // Authenticated — serve the built frontend.
    return env.ASSETS.fetch(request);
  },
};
