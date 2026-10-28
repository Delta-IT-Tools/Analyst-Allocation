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

const FORM_FONTS = `<link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,500&family=Inter:wght@400;500;600&display=swap" rel="stylesheet" />`;

const FORM_STYLES = `
  :root {
    --bg: #F6F4EF;
    --surface: #FFFFFF;
    --ink: #15181D;
    --ink-soft: #6B6760;
    --line: #E4E0D8;
    --teal: #1F6B5C;
    --teal-dark: #15493F;
    --amber: #96600F;
    --danger: #B03A2E;
    --header: #14171C;
    color-scheme: light;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: "Inter", -apple-system, "Segoe UI", sans-serif;
    font-variant-numeric: tabular-nums;
    color: var(--ink);
    background: var(--bg);
    min-height: 100vh;
    -webkit-font-smoothing: antialiased;
  }
  .band { background: var(--header); color: #F3F1EC; padding: 22px 16px 64px; }
  .band-inner { max-width: 600px; margin: 0 auto; display: flex; align-items: center; gap: 12px; }
  .mark { width: 34px; height: 34px; border-radius: 10px; background: var(--teal); display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
  .org { margin: 0; font-size: 11px; letter-spacing: 0.14em; text-transform: uppercase; color: #A9A49A; }
  .wrap { max-width: 600px; margin: -44px auto 0; padding: 0 16px 140px; }
  .card {
    background: var(--surface);
    border-radius: 18px;
    padding: 26px 22px;
    box-shadow: 0 1px 2px rgba(20,23,28,0.04), 0 12px 40px rgba(20,23,28,0.08);
  }
  h1 { font-family: "Fraunces", Georgia, serif; font-weight: 500; font-size: 26px; line-height: 1.2; letter-spacing: -0.01em; margin: 0 0 8px; }
  .sub { font-size: 14px; color: var(--ink-soft); margin: 0 0 4px; line-height: 1.5; }
  .chips-row { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
  .pill { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; font-weight: 500; padding: 4px 10px; border-radius: 999px; background: #F0EDE7; color: var(--ink-soft); }
  .pill.warn { background: #FBF0DC; color: #7A4C0A; }

  .head { display: flex; align-items: flex-end; justify-content: space-between; gap: 12px; margin-top: 24px; }
  .state { font-size: 13px; font-weight: 500; }
  .state.ok { color: var(--teal); }
  .state.under { color: var(--amber); }
  .state.over { color: var(--danger); }
  .total { font-family: "Fraunces", Georgia, serif; font-size: 34px; font-weight: 500; line-height: 1; color: var(--ink); }
  .bar { display: flex; gap: 2px; height: 14px; border-radius: 7px; overflow: hidden; background: #F0EDE7; margin-top: 12px; }
  .bar span { display: block; height: 100%; transition: width 160ms ease; }
  .bar.over { outline: 2px solid var(--danger); outline-offset: 2px; }
  .legend { display: flex; flex-wrap: wrap; gap: 6px 18px; margin-top: 10px; font-size: 13px; }
  .legend span { display: inline-flex; align-items: center; gap: 6px; }
  .legend b { font-weight: 600; }
  .legend .gap { color: var(--ink-soft); }

  .list-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; margin-top: 28px; padding: 0 2px 8px; border-bottom: 1px solid var(--line); }
  h2 { margin: 0; font-size: 14px; font-weight: 600; }
  h2 span { font-weight: 400; color: var(--ink-soft); }
  .hint { font-size: 12px; color: var(--ink-soft); }
  ul { list-style: none; margin: 0; padding: 0; }
  li { display: grid; grid-template-columns: minmax(0, 1fr) 92px 40px; align-items: center; gap: 12px; min-height: 60px; padding: 0 4px 0 6px; border-bottom: 1px solid #F2EFEA; border-radius: 8px; }
  li:focus-within { background: #FAF8F4; }
  .pcell { display: flex; align-items: center; gap: 11px; min-width: 0; }
  .dot { width: 9px; height: 9px; border-radius: 50%; flex-shrink: 0; }
  .pname { display: block; font-size: 15px; font-weight: 500; line-height: 1.3; }
  .pgroup { display: block; font-size: 12px; color: var(--ink-soft); margin-top: 1px; }
  .box { display: flex; align-items: center; justify-content: center; gap: 2px; height: 44px; border-radius: 10px; cursor: text; }
  .box.empty { border: 1px solid var(--line); background: var(--surface); }
  .box:focus-within { outline: 2px solid var(--teal); outline-offset: 2px; }
  .box input {
    width: 42px; border: none; background: transparent; color: inherit; padding: 0;
    font: inherit; font-size: 16px; font-weight: 600; text-align: right;
    -moz-appearance: textfield; appearance: textfield;
  }
  .box input:focus { outline: none; }
  .box input::placeholder { color: #B5B0A6; font-weight: 400; }
  .box input::-webkit-outer-spin-button, .box input::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
  .box .pc { font-size: 13px; opacity: 0.8; }
  .remove { width: 40px; height: 40px; border: none; background: transparent; color: var(--ink-soft); border-radius: 10px; display: flex; align-items: center; justify-content: center; cursor: pointer; }
  .remove:hover { background: #F4F1EB; color: var(--danger); }
  .empty-note { font-size: 14px; color: var(--ink-soft); margin: 16px 4px; }

  .add { margin-top: 24px; padding: 18px; border-radius: 14px; background: #FAF8F4; }
  .add h2 { margin-bottom: 3px; }
  .add .hint { margin: 0 0 12px; font-size: 12.5px; }
  .groups { display: flex; flex-direction: column; gap: 10px; }
  .group { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
  .glabel { width: 100%; font-size: 12px; font-weight: 600; color: var(--ink-soft); }
  .chip { display: inline-flex; align-items: center; gap: 7px; min-height: 40px; padding: 0 13px 0 12px; border-radius: 999px; border: 1px solid var(--line); background: var(--surface); color: var(--ink); font: inherit; font-size: 14px; cursor: pointer; }
  .chip:hover { border-color: var(--teal); }
  .chip svg { color: var(--ink-soft); }

  .footer {
    position: fixed; left: 0; right: 0; bottom: 0;
    background: var(--header); color: #fff;
    padding: 12px 16px calc(12px + env(safe-area-inset-bottom, 0px));
  }
  .footer-inner { max-width: 600px; margin: 0 auto; display: flex; align-items: center; gap: 14px; }
  .status { flex: 1; font-size: 13.5px; line-height: 1.4; color: #CFCAC0; }
  .status.ok { color: #9FD6C4; }
  .status.err { color: #FFB9AE; }
  .save {
    background: #F3F1EC; color: var(--header); border: none; border-radius: 10px;
    min-height: 44px; padding: 0 20px; font-size: 14.5px; font-weight: 600; font-family: inherit; cursor: pointer; flex-shrink: 0;
  }
  .save:hover:not(:disabled) { background: #FFFFFF; }
  .save:disabled { background: #3A3F47; color: #8E8A82; cursor: not-allowed; }
  .note { font-size: 12.5px; color: var(--ink-soft); margin: 16px 6px 0; line-height: 1.5; }

  button:focus-visible { outline: 2px solid var(--teal); outline-offset: 2px; }
  .footer button:focus-visible { outline-color: #7FB8A9; }
  @media (prefers-reduced-motion: reduce) { .bar span { transition: none; } }
  @media (max-width: 380px) { li { grid-template-columns: minmax(0, 1fr) 84px 36px; gap: 8px; } }
`;

const FORM_MARK = `<span class="mark" aria-hidden="true"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.9" stroke-linecap="round"><path d="M4 16a8 8 0 1 1 16 0"/><path d="M12 16l4-5"/></svg></span>`;

function formMessagePage(title, message, status) {
  return htmlResponse(
    `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  ${FORM_FONTS}
  <style>${FORM_STYLES}</style>
</head>
<body>
  <header class="band"><div class="band-inner">${FORM_MARK}<p class="org">Delta IT · Resource &amp; Project Allocation</p></div></header>
  <main class="wrap">
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
  ${FORM_FONTS}
  <style>${FORM_STYLES}</style>
</head>
<body>
  <header class="band"><div class="band-inner">${FORM_MARK}<p class="org">Delta IT · Resource &amp; Project Allocation</p></div></header>
  <main class="wrap">
    <div class="card">
      <h1 id="title"></h1>
      <p class="sub">Set roughly how your time splits across projects right now.</p>
      <div class="chips-row">
        <span class="pill" id="last"></span>
        <span class="pill warn" id="request" hidden></span>
      </div>

      <div class="head">
        <span class="state" id="state"></span>
        <span class="total" id="total" aria-live="polite"></span>
      </div>
      <div class="bar" id="bar" aria-hidden="true"></div>
      <div class="legend" id="legend"></div>

      <div class="list-head">
        <h2>Your projects <span id="count"></span></h2>
        <span class="hint">Tap a number to change it</span>
      </div>
      <ul id="list"></ul>
      <p class="empty-note" id="empty" hidden>Nothing assigned yet. Add a project below to start.</p>

      <div class="add" id="add">
        <h2>Add a project</h2>
        <p class="hint">Tap a project to add it at 5%, then change the number.</p>
        <div class="groups" id="groups"></div>
      </div>
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
  var byId = {};
  data.projects.forEach(function (p) { values[p.id] = p.value; byId[p.id] = p; });
  // Projects shown in "Your projects": the ones with time, in the order the
  // page opened with. Added projects go at the end and stay until removed.
  var shown = data.projects.filter(function (p) { return p.value > 0; }).map(function (p) { return p.id; });
  var dirty = false;
  var saving = false;

  // Same grouping as the board: "BN – Barrett Integration" is in group "BN".
  function groupKey(name) {
    var m = name.match(/^(.*?)\\s+[\\u2013\\u2014-]\\s+/);
    return (m ? m[1] : name).trim();
  }
  var groupCounts = {};
  data.projects.forEach(function (p) { var k = groupKey(p.name); groupCounts[k] = (groupCounts[k] || 0) + 1; });
  function groupOf(p) { var k = groupKey(p.name); return groupCounts[k] > 1 ? k : ""; }
  function shortName(p) {
    return groupOf(p) ? (p.name.replace(/^(.*?)\\s+[\\u2013\\u2014-]\\s+/, "").trim() || p.name) : p.name;
  }

  function heat(v) {
    if (!v) return null;
    if (v >= 70) return { bg: "rgb(31,107,92)", fg: "#FFFFFF" };
    var a = v <= 10 ? 0.1 : v <= 25 ? 0.2 : v <= 45 ? 0.32 : 0.46;
    var c = [31, 107, 92].map(function (x) { return Math.round(x * a + 255 * (1 - a)); });
    return { bg: "rgb(" + c.join(",") + ")", fg: "#15181D" };
  }

  function fmt(iso) {
    if (!iso) return "";
    var parts = iso.split("-");
    return parts[1] + "/" + parts[2] + "/" + parts[0].slice(2);
  }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function svg(path, size) {
    var s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    s.setAttribute("width", size); s.setAttribute("height", size); s.setAttribute("viewBox", "0 0 24 24");
    s.setAttribute("fill", "none"); s.setAttribute("stroke", "currentColor"); s.setAttribute("stroke-width", "2");
    s.setAttribute("stroke-linecap", "round"); s.setAttribute("aria-hidden", "true");
    var p = document.createElementNS("http://www.w3.org/2000/svg", "path"); p.setAttribute("d", path); s.appendChild(p);
    return s;
  }

  document.getElementById("title").textContent = "Hi " + data.name + ", update your allocation";
  document.getElementById("last").textContent = data.lastUpdated
    ? "Last updated " + fmt(data.lastUpdated)
    : "No allocation submitted yet";
  if (data.lastRequested && (!data.lastUpdated || data.lastRequested > data.lastUpdated)) {
    var req = document.getElementById("request");
    req.textContent = "Update requested " + fmt(data.lastRequested);
    req.hidden = false;
  }

  function totalNow() {
    var t = 0;
    Object.keys(values).forEach(function (k) { t += values[k]; });
    return t;
  }

  function setStatus(text, kind) {
    var s = document.getElementById("status");
    s.textContent = text;
    s.className = "status" + (kind ? " " + kind : "");
  }

  function paintBox(box, v) {
    var h = heat(v);
    box.className = h ? "box" : "box empty";
    box.style.background = h ? h.bg : "";
    box.style.color = h ? h.fg : "";
  }

  // Rebuilds the list and the add-chips. Only called when rows are added or
  // removed, never while someone is typing, so focus isn't lost.
  function buildRows() {
    var list = document.getElementById("list");
    list.textContent = "";
    shown.forEach(function (id) {
      var p = byId[id];
      var li = el("li");
      var cell = el("div", "pcell");
      var dot = el("span", "dot"); dot.style.background = p.color;
      var names = el("div");
      var nm = el("label", "pname", shortName(p)); nm.htmlFor = "in-" + p.id;
      names.appendChild(nm);
      if (groupOf(p)) names.appendChild(el("span", "pgroup", groupOf(p)));
      cell.appendChild(dot); cell.appendChild(names);

      var box = el("label", "box");
      var input = document.createElement("input");
      input.type = "number"; input.inputMode = "numeric"; input.min = "0"; input.max = "100"; input.step = "1";
      input.id = "in-" + p.id; input.placeholder = "0";
      input.value = values[p.id] ? String(values[p.id]) : "";
      input.setAttribute("aria-label", p.name + " allocation percent");
      input.addEventListener("focus", function () { input.select(); });
      input.addEventListener("input", function () {
        var n = parseInt(input.value, 10);
        values[p.id] = isNaN(n) ? 0 : Math.max(0, Math.min(100, n));
        dirty = true;
        paintBox(box, values[p.id]);
        render(false);
      });
      input.addEventListener("blur", function () { input.value = values[p.id] ? String(values[p.id]) : ""; });
      input.addEventListener("keydown", function (e) { if (e.key === "Enter") input.blur(); });
      box.appendChild(input); box.appendChild(el("span", "pc", "%"));
      paintBox(box, values[p.id]);

      var rm = el("button", "remove");
      rm.type = "button";
      rm.setAttribute("aria-label", "Remove " + p.name);
      rm.appendChild(svg("M6 6l12 12M18 6L6 18", 16));
      rm.addEventListener("click", function () {
        values[p.id] = 0;
        shown = shown.filter(function (x) { return x !== p.id; });
        dirty = true;
        buildRows();
        render(false);
      });

      li.appendChild(cell); li.appendChild(box); li.appendChild(rm);
      list.appendChild(li);
    });
    document.getElementById("count").textContent = "(" + shown.length + ")";
    document.getElementById("empty").hidden = shown.length > 0;

    // Add-a-project chips, grouped by client; lone projects go under "Other".
    var groups = document.getElementById("groups");
    groups.textContent = "";
    var order = [], buckets = {};
    data.projects.forEach(function (p) {
      if (shown.indexOf(p.id) !== -1) return;
      var k = groupOf(p) || "Other";
      if (!buckets[k]) { buckets[k] = []; if (k !== "Other") order.push(k); }
      buckets[k].push(p);
    });
    if (buckets.Other) order.push("Other");
    order.forEach(function (k) {
      var g = el("div", "group");
      g.appendChild(el("span", "glabel", k));
      buckets[k].forEach(function (p) {
        var chip = el("button", "chip");
        chip.type = "button";
        var d = el("span", "dot"); d.style.background = p.color;
        chip.appendChild(d);
        chip.appendChild(document.createTextNode(shortName(p)));
        chip.appendChild(svg("M12 5v14M5 12h14", 12));
        chip.setAttribute("aria-label", "Add " + p.name);
        chip.addEventListener("click", function () {
          values[p.id] = 5;
          shown.push(p.id);
          dirty = true;
          buildRows();
          render(false);
          var inp = document.getElementById("in-" + p.id);
          if (inp) inp.focus();
        });
        g.appendChild(chip);
      });
      groups.appendChild(g);
    });
    document.getElementById("add").hidden = order.length === 0;
  }

  function render(keepStatus) {
    var total = totalNow();
    var over = total > 100;
    var scale = Math.max(100, total);

    var bar = document.getElementById("bar");
    var legend = document.getElementById("legend");
    bar.textContent = ""; legend.textContent = "";
    shown.forEach(function (id) {
      var v = values[id];
      if (!v) return;
      var p = byId[id];
      var seg = el("span"); seg.style.background = p.color; seg.style.width = (v / scale * 100) + "%";
      bar.appendChild(seg);
      var item = el("span");
      var d = el("span", "dot"); d.style.background = p.color;
      item.appendChild(d);
      item.appendChild(document.createTextNode(shortName(p) + " "));
      item.appendChild(el("b", null, v + "%"));
      legend.appendChild(item);
    });
    if (total < 100) {
      var gap = el("span", "gap");
      var gd = el("span", "dot"); gd.style.background = "#E4E0D8";
      gap.appendChild(gd);
      gap.appendChild(document.createTextNode("Unallocated "));
      gap.appendChild(el("b", null, (100 - total) + "%"));
      legend.appendChild(gap);
    }
    bar.className = over ? "bar over" : "bar";

    document.getElementById("total").textContent = total + "%";
    var state = document.getElementById("state");
    state.textContent = over ? (total - 100) + "% over capacity" : total === 100 ? "Fully allocated" : (100 - total) + "% unallocated";
    state.className = "state " + (over ? "over" : total === 100 ? "ok" : "under");

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
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
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
          document.getElementById("last").textContent = "Last updated " + fmt(r.body.lastUpdated);
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

  buildRows();
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
