// Database setup + migrations. Every migration is additive: nothing existing is dropped or renamed,
// so old sam.sqlite files keep all their users, chats and memories.
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const Database = require("better-sqlite3");

// DATA_DIR lets you point the database at a persistent disk (e.g. Render disk mounted at /var/data).
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "..");
fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = path.join(DATA_DIR, "sam.sqlite");

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("busy_timeout = 5000");

// ---- Original tables (unchanged) ----
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(user_id) REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(user_id) REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  title TEXT NOT NULL DEFAULT 'New chat',
  mode TEXT NOT NULL DEFAULT 'chat',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(user_id) REFERENCES users(id)
);
`);

function addColumn(table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some(c => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

// ---- Earlier migrations (kept exactly as before) ----
addColumn("messages", "conversation_id", "INTEGER");
addColumn("messages", "mode", "TEXT DEFAULT 'chat'");
addColumn("users", "age", "INTEGER");

db.exec(`
CREATE INDEX IF NOT EXISTS idx_conversations_user ON conversations(user_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, id);
`);

// Move pre-conversation messages into a "Previous chat" conversation (runs once per old user).
const orphanUsers = db.prepare("SELECT DISTINCT user_id FROM messages WHERE conversation_id IS NULL").all();
for (const { user_id } of orphanUsers) {
  const r = db.prepare("INSERT INTO conversations (user_id, title, mode) VALUES (?, 'Previous chat', 'chat')").run(user_id);
  db.prepare("UPDATE messages SET conversation_id=?, mode='chat' WHERE user_id=? AND conversation_id IS NULL").run(r.lastInsertRowid, user_id);
}

// ---- New migrations (stage 1) ----
addColumn("users", "role", "TEXT DEFAULT 'user'");
addColumn("users", "last_login_at", "TEXT");
addColumn("messages", "model", "TEXT");
db.exec(`
CREATE INDEX IF NOT EXISTS idx_users_username_nocase ON users(username COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_memories_user ON memories(user_id, id);
CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS usage_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  provider TEXT,
  model TEXT,
  mode TEXT,
  input_tokens INTEGER DEFAULT 0,
  output_tokens INTEGER DEFAULT 0,
  estimated INTEGER DEFAULT 0,
  ok INTEGER DEFAULT 1,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_usage_user ON usage_log(user_id, created_at);
`);

// ---- New migrations (stage 1b: admin + account security) ----
addColumn("users", "disabled", "INTEGER DEFAULT 0");
addColumn("users", "password_changed_at", "TEXT");
db.exec(`
CREATE TABLE IF NOT EXISTS error_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  request_id TEXT,
  user_id INTEGER,
  route TEXT,
  message TEXT,
  stack TEXT
);
CREATE INDEX IF NOT EXISTS idx_error_log_time ON error_log(created_at);
CREATE TABLE IF NOT EXISTS password_resets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_by INTEGER,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
`);

// A stable session secret. Uses SESSION_SECRET if set; otherwise generates one ONCE and stores it,
// so sessions survive restarts and nobody can forge cookies with a known default secret.
function getSessionSecret() {
  if (process.env.SESSION_SECRET && !/replace_with/.test(process.env.SESSION_SECRET)) return process.env.SESSION_SECRET;
  const row = db.prepare("SELECT value FROM app_settings WHERE key='session_secret'").get();
  if (row) return row.value;
  const secret = crypto.randomBytes(48).toString("hex");
  db.prepare("INSERT INTO app_settings(key,value) VALUES('session_secret',?)").run(secret);
  console.warn("[sam] SESSION_SECRET not set — generated one and stored it in the database.");
  return secret;
}

// Find a user by username. Exact match first (old accounts), then case-insensitive,
// so "Ryder" can log in as "ryder" — but only if that's unambiguous.
function findUserByUsername(username) {
  const exact = db.prepare("SELECT * FROM users WHERE username=?").get(username);
  if (exact) return exact;
  const loose = db.prepare("SELECT * FROM users WHERE username=? COLLATE NOCASE").all(username);
  return loose.length === 1 ? loose[0] : null;
}

function usernameTaken(username) {
  return !!db.prepare("SELECT 1 FROM users WHERE username=? COLLATE NOCASE").get(username);
}

function logUsage({ userId, provider, model, mode, inputTokens = 0, outputTokens = 0, estimated = false, ok = true }) {
  try {
    db.prepare(
      "INSERT INTO usage_log(user_id,provider,model,mode,input_tokens,output_tokens,estimated,ok) VALUES(?,?,?,?,?,?,?,?)"
    ).run(userId, provider || null, model || null, mode || null, inputTokens | 0, outputTokens | 0, estimated ? 1 : 0, ok ? 1 : 0);
  } catch (e) {
    console.error("[sam] usage log failed:", e.message);
  }
}

module.exports = { db, DB_PATH, DATA_DIR, getSessionSecret, findUserByUsername, usernameTaken, logUsage };
