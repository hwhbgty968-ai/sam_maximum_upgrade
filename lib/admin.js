// Admin queries. Every function here is only reachable through routes guarded by requireAdmin.
const fs = require("fs");
const path = require("path");
const { db, DB_PATH, DATA_DIR } = require("./db");

const START = Date.now();
const BACKUP_DIR = process.env.BACKUP_DIR || path.join(DATA_DIR, "backups");
const BACKUP_KEEP = Number(process.env.BACKUP_KEEP) || 14;

// Admins are whoever is listed in ADMIN_USERNAMES (comma-separated, any capitalisation).
// Nobody can promote themselves from inside the app.
function adminNames() {
  return (process.env.ADMIN_USERNAMES || "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
}
function isAdmin(username) {
  return !!username && adminNames().includes(String(username).toLowerCase());
}

// Keep users.role in step with ADMIN_USERNAMES (for display) and warn about names with no account yet.
function syncAdminRoles(warn = console.warn) {
  const names = adminNames();
  db.transaction(() => {
    db.prepare("UPDATE users SET role='user' WHERE role='admin'").run();
    for (const n of names) db.prepare("UPDATE users SET role='admin' WHERE username=? COLLATE NOCASE").run(n);
  })();
  for (const n of names) {
    if (!db.prepare("SELECT 1 FROM users WHERE username=? COLLATE NOCASE").get(n)) {
      warn(`[sam] ADMIN_USERNAMES lists "${n}" but no account has that name yet. Register it yourself straight away, or remove it — whoever registers it first becomes admin.`);
    }
  }
  return names;
}

const one = (sql, ...a) => db.prepare(sql).get(...a);

function overview() {
  const usage = since => one(
    `SELECT COUNT(*) AS requests, COALESCE(SUM(input_tokens),0) AS input_tokens, COALESCE(SUM(output_tokens),0) AS output_tokens,
            COALESCE(SUM(CASE WHEN ok=0 THEN 1 ELSE 0 END),0) AS failures
     FROM usage_log WHERE created_at >= datetime('now', ?)`, since);
  let dbSizeBytes = null;
  try { dbSizeBytes = fs.statSync(DB_PATH).size; } catch {}
  return {
    users: one("SELECT COUNT(*) c FROM users").c,
    disabledUsers: one("SELECT COUNT(*) c FROM users WHERE disabled=1").c,
    activeUsers7d: one("SELECT COUNT(*) c FROM users WHERE last_login_at >= datetime('now','-7 days')").c,
    conversations: one("SELECT COUNT(*) c FROM conversations").c,
    messages: one("SELECT COUNT(*) c FROM messages").c,
    memories: one("SELECT COUNT(*) c FROM memories").c,
    usageToday: usage("-1 day"),
    usage30d: usage("-30 days"),
    errors24h: one("SELECT COUNT(*) c FROM error_log WHERE created_at >= datetime('now','-1 day')").c,
    dbSizeBytes,
    uptimeSeconds: Math.round((Date.now() - START) / 1000),
    node: process.version
  };
}

function listUsers({ q = "", limit = 50, offset = 0 } = {}) {
  limit = Math.min(Math.max(Number(limit) || 50, 1), 200);
  offset = Math.max(Number(offset) || 0, 0);
  const like = "%" + String(q).replace(/[%_]/g, "") + "%";
  const rows = db.prepare(
    `SELECT u.id, u.username, u.age, u.role, u.disabled, u.created_at, u.last_login_at,
            (SELECT COUNT(*) FROM messages m WHERE m.user_id=u.id) AS messages,
            (SELECT COUNT(*) FROM usage_log l WHERE l.user_id=u.id AND l.created_at >= datetime('now','-30 days')) AS requests30d,
            (SELECT COALESCE(SUM(input_tokens+output_tokens),0) FROM usage_log l WHERE l.user_id=u.id AND l.created_at >= datetime('now','-30 days')) AS tokens30d
     FROM users u WHERE u.username LIKE ? ORDER BY u.id DESC LIMIT ? OFFSET ?`
  ).all(like, limit, offset);
  const total = one("SELECT COUNT(*) c FROM users WHERE username LIKE ?", like).c;
  return { users: rows.map(r => ({ ...r, disabled: !!r.disabled, isAdmin: isAdmin(r.username) })), total };
}

function setDisabled(userId, disabled) {
  return db.prepare("UPDATE users SET disabled=? WHERE id=?").run(disabled ? 1 : 0, userId).changes > 0;
}

// MODEL_PRICES='{"gemini-3.7-flash":[0.30,2.50]}' → USD per 1M input/output tokens.
// No price configured → cost is shown as unknown rather than guessed.
function prices() {
  try { return JSON.parse(process.env.MODEL_PRICES || "{}"); } catch { return {}; }
}

function usageReport(days = 30) {
  days = Math.min(Math.max(Number(days) || 30, 1), 365);
  const p = prices();
  const rows = db.prepare(
    `SELECT date(created_at) AS day, provider, model,
            COUNT(*) AS requests, SUM(CASE WHEN ok=0 THEN 1 ELSE 0 END) AS failures,
            COALESCE(SUM(input_tokens),0) AS input_tokens, COALESCE(SUM(output_tokens),0) AS output_tokens,
            MAX(estimated) AS estimated
     FROM usage_log WHERE created_at >= datetime('now', ?)
     GROUP BY day, provider, model ORDER BY day DESC, requests DESC`
  ).all(`-${days} days`);
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

function recentErrors(limit = 100) {
  return db.prepare(
    `SELECT e.id, e.created_at, e.request_id, e.route, e.message, e.stack, u.username
     FROM error_log e LEFT JOIN users u ON u.id = e.user_id ORDER BY e.id DESC LIMIT ?`
  ).all(Math.min(Number(limit) || 100, 500));
}

function listBackups() {
  try {
    return fs.readdirSync(BACKUP_DIR).filter(f => /^sam-.*\.sqlite$/.test(f)).sort().reverse()
      .map(f => ({ file: f, bytes: fs.statSync(path.join(BACKUP_DIR, f)).size }));
  } catch { return []; }
}

async function runBackup() {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 19).replace(/:/g, "-");
  const file = `sam-${stamp}.sqlite`;
  await db.backup(path.join(BACKUP_DIR, file));
  const old = listBackups().slice(BACKUP_KEEP);
  for (const b of old) fs.unlinkSync(path.join(BACKUP_DIR, b.file));
  return { file, removed: old.length };
}

module.exports = { isAdmin, adminNames, syncAdminRoles, overview, listUsers, setDisabled, usageReport, recentErrors, listBackups, runBackup, BACKUP_DIR };
