// Admin queries. Every function here is only reachable through routes guarded by requireAdmin,
// except the one-time setup-code claim, which only works while Sam has no admin at all.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { db, engine, DB_PATH, DATA_DIR } = require("./db");

const START = Date.now();
const BACKUP_DIR = process.env.BACKUP_DIR || path.join(DATA_DIR, "backups");
const BACKUP_KEEP = Number(process.env.BACKUP_KEEP) || 14;
const httpError = (status, message) => Object.assign(new Error(message), { status });

// ---------------- Who is an admin ----------------
// Admin rights live in the database (users.role). Nobody can promote themselves, with one exception:
// while Sam has no admin, whoever enters the one-time setup code becomes the first admin.
// Admins and the Creator (owner) both count as admins; the owner-only rules live in lib/roles.js.
const roles = require("./roles");
const isAdmin = roles.isAdmin;

async function hasAdmin() {
  return !!(await db.get("SELECT 1 AS x FROM users WHERE role IN ('admin','owner') AND COALESCE(disabled,0)=0"));
}

let setupCode = null;
const normCode = s => String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
function newCode() {
  const abc = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O or 1/I mix-ups
  const raw = Array.from(crypto.randomBytes(12), b => abc[b % abc.length]).join("");
  return raw.match(/.{4}/g).join("-");
}

// Called at startup (and when a claim is attempted without a live code). Logs where to find the code.
async function ensureSetupCode(say = console.log) {
  if (await hasAdmin()) { setupCode = null; return null; }
  if (process.env.ADMIN_SETUP_CODE) {
    setupCode = process.env.ADMIN_SETUP_CODE;
    say("[sam] No admin yet. Log in, open Settings → Become admin, and enter your ADMIN_SETUP_CODE.");
  } else {
    setupCode = newCode();
    say(`[sam] No admin yet. Admin setup code: ${setupCode}  (log in, open Settings → Become admin, enter it. A new code is made on every restart until an admin exists.)`);
  }
  if (process.env.ADMIN_USERNAMES) say("[sam] ADMIN_USERNAMES is no longer used; admins are set with the setup code and the admin dashboard. You can delete that setting.");
  return setupCode;
}

const sameCode = (a, b) => {
  const h = s => crypto.createHash("sha256").update(normCode(s)).digest();
  return normCode(a).length > 0 && crypto.timingSafeEqual(h(a), h(b));
};

async function claimAdmin(userId, code) {
  if (await hasAdmin()) throw httpError(409, "Ezer already has an admin. Ask them to make you one.");
  if (!setupCode) await ensureSetupCode();
  if (!sameCode(code, setupCode)) throw httpError(400, "That setup code isn't right. Check Ezer's server logs for the current code.");
  // The setup code makes the very first person the Creator (owner). It only works while Ezer has no admin at all.
  await db.tx(async t => {
    if (await t.get("SELECT 1 AS x FROM users WHERE role IN ('admin','owner')")) throw httpError(409, "Ezer already has an admin.");
    await t.run("UPDATE users SET role='owner' WHERE id=?", userId);
    const u = await t.get("SELECT username FROM users WHERE id=?", userId);
    if (roles.validHandle(u.username)) await t.run("UPDATE users SET creator_handle=? WHERE id=? AND creator_handle IS NULL", u.username, userId);
    await roles.audit(t, { actorId: userId, action: "owner_set", targetId: userId, detail: "claimed with the one-time setup code" });
  });
  setupCode = null;
  return true;
}

const status = () => ({ setupOpen: !!setupCode });

// ---------------- Dashboard data ----------------
const count = async (sql, ...a) => Number((await db.get(sql, ...a))?.c || 0);

async function dbSize() {
  try {
    if (engine === "sqlite") return fs.statSync(DB_PATH).size;
    return Number((await db.get("SELECT pg_database_size(current_database()) AS c")).c);
  } catch { return null; }
}

async function overview() {
  const usage = since => db.get(
    `SELECT COUNT(*) AS requests, COALESCE(SUM(input_tokens),0) AS input_tokens, COALESCE(SUM(output_tokens),0) AS output_tokens,
            COALESCE(SUM(CASE WHEN ok=0 THEN 1 ELSE 0 END),0) AS failures
     FROM usage_log WHERE created_at >= datetime('now', ?)`, since);
  return {
    users: await count("SELECT COUNT(*) AS c FROM users"),
    admins: (await db.all("SELECT username FROM users WHERE role IN ('owner','admin') ORDER BY id")).map(r => r.username),
    disabledUsers: await count("SELECT COUNT(*) AS c FROM users WHERE disabled=1"),
    activeUsers7d: await count("SELECT COUNT(*) AS c FROM users WHERE last_login_at >= datetime('now','-7 days')"),
    conversations: await count("SELECT COUNT(*) AS c FROM conversations"),
    messages: await count("SELECT COUNT(*) AS c FROM messages"),
    memories: await count("SELECT COUNT(*) AS c FROM memories"),
    usageToday: await usage("-1 day"),
    usage30d: await usage("-30 days"),
    errors24h: await count("SELECT COUNT(*) AS c FROM error_log WHERE created_at >= datetime('now','-1 day')"),
    database: { engine, sizeBytes: await dbSize() },
    dbSizeBytes: await dbSize(),
    uptimeSeconds: Math.round((Date.now() - START) / 1000),
    node: process.version
  };
}

async function listUsers({ q = "", limit = 50, offset = 0 } = {}) {
  limit = Math.min(Math.max(Number(limit) || 50, 1), 200);
  offset = Math.max(Number(offset) || 0, 0);
  const month = new Date().toISOString().slice(0, 7);
  // Wildcards typed in the search box are matched literally (usernames can contain "_").
  const like = "%" + String(q).toLowerCase().slice(0, 50).replace(/[\\%_]/g, ch => "\\" + ch) + "%";
  const rows = await db.all(
    `SELECT u.id, u.username, u.age, u.role, u.disabled, u.created_at, u.last_login_at, COALESCE(u.plan,'free') AS plan,
            (SELECT COALESCE(SUM(-c.delta),0) FROM credit_ledger c WHERE c.user_id=u.id AND c.month=? AND c.kind IN ('use','hold')) AS credits_used,
            (SELECT COUNT(*) FROM messages m WHERE m.user_id=u.id) AS messages,
            (SELECT COUNT(*) FROM usage_log l WHERE l.user_id=u.id AND l.created_at >= datetime('now','-30 days')) AS requests30d,
            (SELECT COALESCE(SUM(input_tokens+output_tokens),0) FROM usage_log l WHERE l.user_id=u.id AND l.created_at >= datetime('now','-30 days')) AS tokens30d
     FROM users u WHERE lower(u.username) LIKE ? ESCAPE '\\' ORDER BY u.id DESC LIMIT ? OFFSET ?`, month, like, limit, offset);
  const total = await count("SELECT COUNT(*) AS c FROM users WHERE lower(username) LIKE ? ESCAPE '\\'", like);
  return { users: rows.map(r => ({ ...r, credits_used: Number(r.credits_used), disabled: !!r.disabled, isAdmin: r.role === "admin" || r.role === "owner", isOwner: r.role === "owner" })), total };
}

async function setDisabled(userId, disabled) {
  return (await db.run("UPDATE users SET disabled=? WHERE id=?", disabled ? 1 : 0, userId)) > 0;
}

// MODEL_PRICES='{"gemini-3.7-flash":[0.30,2.50]}' → USD per 1M input/output tokens.
// No price configured → cost is shown as unknown rather than guessed.
function prices() {
  try { return JSON.parse(process.env.MODEL_PRICES || "{}"); } catch { return {}; }
}

async function usageReport(days = 30) {
  days = Math.min(Math.max(Number(days) || 30, 1), 365);
  const p = prices();
  const rows = await db.all(
    `SELECT substr(created_at, 1, 10) AS day, provider, model,
            COUNT(*) AS requests, SUM(CASE WHEN ok=0 THEN 1 ELSE 0 END) AS failures,
            COALESCE(SUM(input_tokens),0) AS input_tokens, COALESCE(SUM(output_tokens),0) AS output_tokens,
            MAX(estimated) AS estimated
     FROM usage_log WHERE created_at >= datetime('now', ?)
     GROUP BY substr(created_at, 1, 10), provider, model ORDER BY day DESC, requests DESC`, `-${days} days`);
  let totalCost = 0, unpriced = 0;
  for (const r of rows) {
    const price = p[r.model];
    if (Array.isArray(price) && price.length === 2) {
      r.costUsd = +((r.input_tokens * price[0] + r.output_tokens * price[1]) / 1e6).toFixed(4);
      totalCost += r.costUsd;
    } else {
      r.costUsd = null;
      unpriced += r.requests;
    }
    r.estimated = !!r.estimated;
  }
  return { days, rows, totalCostUsd: +totalCost.toFixed(4), unpricedRequests: unpriced };
}

async function recentErrors(limit = 100) {
  return db.all(
    `SELECT e.id, e.created_at, e.request_id, e.route, e.message, e.stack, u.username
     FROM error_log e LEFT JOIN users u ON u.id = e.user_id ORDER BY e.id DESC LIMIT ?`, Math.min(Number(limit) || 100, 500));
}

// ---------------- Server-side backup files (SQLite only) ----------------
// With Postgres, the database provider keeps point-in-time history, and admins download full backups instead.
function listBackups() {
  if (engine !== "sqlite") return [];
  try {
    return fs.readdirSync(BACKUP_DIR).filter(f => /^sam-.*\.sqlite$/.test(f)).sort().reverse()
      .map(f => ({ file: f, bytes: fs.statSync(path.join(BACKUP_DIR, f)).size }));
  } catch { return []; }
}

async function runBackup() {
  if (engine !== "sqlite") throw httpError(400, "On Postgres, use “Download full backup” instead. Your database provider also keeps its own restore history.");
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 19).replace(/:/g, "-");
  const file = `sam-${stamp}.sqlite`;
  await db.raw.backup(path.join(BACKUP_DIR, file));
  const old = listBackups().slice(BACKUP_KEEP);
  for (const b of old) fs.unlinkSync(path.join(BACKUP_DIR, b.file));
  return { file, removed: old.length };
}

module.exports = {
  isAdmin, hasAdmin, ensureSetupCode, claimAdmin, status, overview, listUsers, setDisabled,
  usageReport, recentErrors, listBackups, runBackup, BACKUP_DIR
};
