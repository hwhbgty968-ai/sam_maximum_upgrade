// Database layer. Sam runs on either engine with the same code:
//   • Postgres (e.g. Neon) when DATABASE_URL is set: permanent, survives restarts and redeploys.
//   • SQLite (a file in DATA_DIR) otherwise: zero setup, ideal for running Sam on your own computer.
//
// Every call is async:  await db.get(sql, ...params)  → first row or undefined
//                       await db.all(sql, ...params)  → rows
//                       await db.run(sql, ...params)  → number of rows changed
//                       await db.insert(sql, ...params) → new row id
//                       await db.tx(async t => { …same methods on t… })  → all-or-nothing
// SQL is written once, in a dialect both engines understand: "?" placeholders, datetime('now'[, '-1 day']),
// lower(x) for case-insensitive matching, substr() instead of date(). Migrations only ever ADD things.
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "..");
const DB_PATH = path.join(DATA_DIR, "sam.sqlite");
const DATABASE_URL = (process.env.DATABASE_URL || "").trim();
const engine = DATABASE_URL ? "postgres" : "sqlite";

// Plain values only: booleans become 1/0 (both engines store flags as integers), undefined becomes NULL.
const norm = v => (v === undefined ? null : typeof v === "boolean" ? (v ? 1 : 0) : v);

// ---------------------------------------------------------------- SQLite
class SqliteDb {
  constructor(file) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const Database = require("better-sqlite3");
    this.raw = new Database(file);
    this.raw.pragma("journal_mode = WAL");
    this.raw.pragma("busy_timeout = 5000");
    this.engine = "sqlite";
    this.location = file;
    this.cache = new Map();
    this.txChain = Promise.resolve();
    this.txCount = 0; // transactions running or queued
    const self = this;
    // The transaction handle runs statements directly (no waiting), so it never deadlocks on itself.
    this.direct = {
      get: (sql, ...p) => self.stmt(sql).get(...p.map(norm)),
      all: (sql, ...p) => self.stmt(sql).all(...p.map(norm)),
      run: (sql, ...p) => Number(self.stmt(sql).run(...p.map(norm)).changes),
      insert: (sql, ...p) => Number(self.stmt(sql).run(...p.map(norm)).lastInsertRowid),
      exec: sql => { self.raw.exec(sql); }
    };
  }
  stmt(sql) {
    let s = this.cache.get(sql);
    if (!s) { s = this.raw.prepare(sql); if (this.cache.size > 500) this.cache.clear(); this.cache.set(sql, s); }
    return s;
  }
  // SQLite has one connection, so a statement from another request would silently join an open transaction
  // (and be rolled back with it). Outside a transaction, wait until no transaction is running or queued.
  async idle() { while (this.txCount > 0) await this.txChain; }
  async get(sql, ...p) { await this.idle(); return this.direct.get(sql, ...p); }
  async all(sql, ...p) { await this.idle(); return this.direct.all(sql, ...p); }
  async run(sql, ...p) { await this.idle(); return this.direct.run(sql, ...p); }
  async insert(sql, ...p) { await this.idle(); return this.direct.insert(sql, ...p); }
  async exec(sql) { await this.idle(); this.direct.exec(sql); }
  async tx(fn) {
    this.txCount++; // counted at once (before any await), so statements issued after this call wait for it
    const prev = this.txChain;
    let release;
    this.txChain = new Promise(r => { release = r; });
    await prev;
    let begun = false;
    try {
      this.raw.exec("BEGIN IMMEDIATE");
      begun = true;
      const t = {
        get: async (...a) => this.direct.get(...a), all: async (...a) => this.direct.all(...a),
        run: async (...a) => this.direct.run(...a), insert: async (...a) => this.direct.insert(...a),
        exec: async sql => this.direct.exec(sql)
      };
      const result = await fn(t);
      this.raw.exec("COMMIT");
      return result;
    } catch (e) {
      if (begun) try { this.raw.exec("ROLLBACK"); } catch {}
      throw e;
    } finally {
      this.txCount--;
      release();
    }
  }
  async columns(table) { return this.direct.all(`PRAGMA table_info(${table})`).map(c => c.name); }
  async addColumn(table, column, definition) {
    if (!(await this.columns(table)).includes(column)) this.direct.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
  async close() { this.raw.close(); }
}

// ---------------------------------------------------------------- Postgres
// "?" → "$1, $2…", skipping anything inside quotes.
function toPg(sql) {
  let out = "", n = 0, quote = null;
  for (const ch of sql) {
    if (quote) { if (ch === quote) quote = null; out += ch; continue; }
    if (ch === "'" || ch === '"') { quote = ch; out += ch; continue; }
    out += ch === "?" ? "$" + ++n : ch;
  }
  return out;
}

// Neon-style URLs carry sslmode/channel_binding. We turn TLS on explicitly (with certificate checks)
// and drop those parameters so every version of the pg driver reads the URL the same way.
function pgConfig(url) {
  const u = new URL(url);
  const mode = u.searchParams.get("sslmode");
  ["sslmode", "channel_binding", "sslrootcert", "sslcert", "sslkey"].forEach(k => u.searchParams.delete(k));
  const local = ["localhost", "127.0.0.1", "::1", ""].includes(u.hostname);
  const ssl = mode === "disable" || (local && !mode) ? false : { rejectUnauthorized: mode !== "no-verify" };
  return { connectionString: u.toString(), ssl };
}

const RETRYABLE = /Connection terminated|ECONNRESET|EPIPE|ETIMEDOUT|terminating connection|server closed the connection|Client has encountered a connection error/i;
const retryable = e => ["57P01", "57P02", "57P03", "08000", "08003", "08006"].includes(e?.code) || RETRYABLE.test(e?.message || "");

class PgDb {
  constructor(url) {
    const pg = require("pg");
    // COUNT(*) and SUM() come back as int8/numeric; Sam's numbers are small, so read them as JS numbers.
    pg.types.setTypeParser(20, v => parseInt(v, 10));
    pg.types.setTypeParser(1700, v => parseFloat(v));
    this.engine = "postgres";
    const cfg = pgConfig(url);
    this.location = (() => { const u = new URL(cfg.connectionString); return `${u.hostname}/${u.pathname.slice(1)}`; })();
    this.pool = new pg.Pool({
      ...cfg,
      max: Number(process.env.PG_POOL_MAX) || 5,
      // Close idle connections well before Neon's compute sleeps, so we don't reuse dead ones.
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 20000
    });
    this.pool.on("error", e => console.warn("[sam] database connection dropped (will reconnect):", e.message));
    this.cache = new Map();
  }
  sql(s) {
    let c = this.cache.get(s);
    if (!c) { c = toPg(s); if (this.cache.size > 500) this.cache.clear(); this.cache.set(s, c); }
    return c;
  }
  async q(sql, params) {
    const text = this.sql(sql), values = params.map(norm);
    try { return await this.pool.query(text, values); }
    catch (e) {
      if (!retryable(e)) throw e;
      return this.pool.query(text, values); // one retry: Neon may have just woken up or recycled a connection
    }
  }
  static withReturning(sql) { return /\breturning\b/i.test(sql) ? sql : sql.replace(/;?\s*$/, " RETURNING id"); }
  async get(sql, ...p) { return (await this.q(sql, p)).rows[0]; }
  async all(sql, ...p) { return (await this.q(sql, p)).rows; }
  async run(sql, ...p) { return (await this.q(sql, p)).rowCount; }
  async insert(sql, ...p) { return Number((await this.q(PgDb.withReturning(sql), p)).rows[0].id); }
  async exec(sql) { await this.pool.query(sql); }
  async tx(fn) {
    const client = await this.pool.connect();
    const run = async (sql, p) => client.query(this.sql(sql), p.map(norm));
    try {
      await client.query("BEGIN");
      const t = {
        get: async (s, ...p) => (await run(s, p)).rows[0],
        all: async (s, ...p) => (await run(s, p)).rows,
        run: async (s, ...p) => (await run(s, p)).rowCount,
        insert: async (s, ...p) => Number((await run(PgDb.withReturning(s), p)).rows[0].id),
        exec: async s => { await client.query(s); }
      };
      const result = await fn(t);
      await client.query("COMMIT");
      return result;
    } catch (e) {
      try { await client.query("ROLLBACK"); } catch {}
      throw e;
    } finally {
      client.release();
    }
  }
  async columns(table) {
    return (await this.all("SELECT column_name AS name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name=?", table)).map(c => c.name);
  }
  async addColumn(table, column, definition) { await this.exec(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${column} ${definition}`); }
  async close() { await this.pool.end(); }
}

const db = engine === "postgres" ? new PgDb(DATABASE_URL) : new SqliteDb(DB_PATH);

// ---------------------------------------------------------------- Schema
// Tables in the order a backup must restore them (parents before children).
const TABLES = ["users", "conversations", "messages", "memories", "usage_log", "error_log", "password_resets", "assistants", "prompts", "app_settings", "credit_ledger"];

async function migrateSqlite() {
  const x = sql => db.exec(sql), add = (t, c, d) => db.addColumn(t, c, d);
  // ---- Original tables (unchanged) ----
  await x(`
CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS memories (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, content TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(user_id) REFERENCES users(id));
CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(user_id) REFERENCES users(id));
CREATE TABLE IF NOT EXISTS conversations (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, title TEXT NOT NULL DEFAULT 'New chat', mode TEXT NOT NULL DEFAULT 'chat', created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(user_id) REFERENCES users(id));`);
  // ---- Earlier migrations (kept exactly as before) ----
  await add("messages", "conversation_id", "INTEGER");
  await add("messages", "mode", "TEXT DEFAULT 'chat'");
  await add("users", "age", "INTEGER");
  await x(`CREATE INDEX IF NOT EXISTS idx_conversations_user ON conversations(user_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, id);`);
  // Move pre-conversation messages into a "Previous chat" conversation (runs once per old user).
  for (const { user_id } of await db.all("SELECT DISTINCT user_id FROM messages WHERE conversation_id IS NULL")) {
    await db.tx(async t => {
      const cid = await t.insert("INSERT INTO conversations (user_id, title, mode) VALUES (?, 'Previous chat', 'chat')", user_id);
      await t.run("UPDATE messages SET conversation_id=?, mode='chat' WHERE user_id=? AND conversation_id IS NULL", cid, user_id);
    });
  }
  // ---- Stage 1 ----
  await add("users", "role", "TEXT DEFAULT 'user'");
  await add("users", "last_login_at", "TEXT");
  await add("messages", "model", "TEXT");
  await x(`CREATE INDEX IF NOT EXISTS idx_users_username_nocase ON users(username COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_memories_user ON memories(user_id, id);
CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS usage_log (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, provider TEXT, model TEXT, mode TEXT, input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0, estimated INTEGER DEFAULT 0, ok INTEGER DEFAULT 1, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX IF NOT EXISTS idx_usage_user ON usage_log(user_id, created_at);`);
  // ---- Stage 1b: admin + account security ----
  await add("users", "disabled", "INTEGER DEFAULT 0");
  await add("users", "password_changed_at", "TEXT");
  await x(`CREATE TABLE IF NOT EXISTS error_log (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, request_id TEXT, user_id INTEGER, route TEXT, message TEXT, stack TEXT);
CREATE INDEX IF NOT EXISTS idx_error_log_time ON error_log(created_at);
CREATE TABLE IF NOT EXISTS password_resets (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, token_hash TEXT NOT NULL UNIQUE, expires_at TEXT NOT NULL, used_at TEXT, created_by INTEGER, created_at TEXT DEFAULT CURRENT_TIMESTAMP);`);
  // ---- v3.2: chat management ----
  await add("conversations", "pinned", "INTEGER DEFAULT 0");
  await add("conversations", "archived", "INTEGER DEFAULT 0");
  await add("messages", "pinned", "INTEGER DEFAULT 0");
  await add("messages", "meta", "TEXT");
  await x(`CREATE INDEX IF NOT EXISTS idx_conversations_user_list ON conversations(user_id, archived, pinned, updated_at);
CREATE INDEX IF NOT EXISTS idx_messages_user_pinned ON messages(user_id, pinned);`);
  // ---- v3.3: personalisation ----
  await add("users", "settings", "TEXT");
  await add("conversations", "assistant", "TEXT");
  await x(`CREATE TABLE IF NOT EXISTS assistants (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, name TEXT NOT NULL, icon TEXT, instructions TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX IF NOT EXISTS idx_assistants_user ON assistants(user_id);
CREATE TABLE IF NOT EXISTS prompts (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX IF NOT EXISTS idx_prompts_user ON prompts(user_id);`);
  // ---- v4.0: engine-neutral sessions + case-insensitive username lookups ----
  await x(`CREATE TABLE IF NOT EXISTS user_sessions (sid TEXT PRIMARY KEY, sess TEXT NOT NULL, expire INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_user_sessions_expire ON user_sessions(expire);
CREATE INDEX IF NOT EXISTS idx_users_username_lower ON users(lower(username));`);
  // ---- v4.2: guest mode — daily message counts only (no chat text, no IP addresses) ----
  await x(`CREATE TABLE IF NOT EXISTS guest_usage (bucket TEXT NOT NULL, day TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (bucket, day));`);
  // ---- v4.3: plans and Sam Credits (no real money yet) ----
  await add("users", "plan", "TEXT DEFAULT 'free'");
  await x(`CREATE TABLE IF NOT EXISTS credit_ledger (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, month TEXT NOT NULL, delta INTEGER NOT NULL, kind TEXT NOT NULL,
  feature TEXT, model TEXT, tier TEXT, description TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX IF NOT EXISTS idx_credit_user_month ON credit_ledger(user_id, month);
CREATE UNIQUE INDEX IF NOT EXISTS idx_credit_allowance ON credit_ledger(user_id, month) WHERE kind='allowance';`);
}

// A fresh Postgres database gets the whole current schema at once; later changes are added below it.
async function migratePostgres() {
  await db.exec(`
-- SQLite-compatible datetime('now'[, modifier]) → 'YYYY-MM-DD HH:MM:SS' in UTC, so timestamps look the same on both engines.
CREATE OR REPLACE FUNCTION datetime(t text, modifier text DEFAULT NULL) RETURNS text LANGUAGE sql STABLE AS $fn$
  SELECT to_char((CASE WHEN t = 'now' THEN timezone('UTC', now()) ELSE t::timestamp END) + COALESCE(modifier::interval, interval '0'), 'YYYY-MM-DD HH24:MI:SS')
$fn$;
CREATE TABLE IF NOT EXISTS users (id SERIAL PRIMARY KEY, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, created_at TEXT DEFAULT datetime('now'),
  age INTEGER, role TEXT DEFAULT 'user', last_login_at TEXT, disabled INTEGER DEFAULT 0, password_changed_at TEXT, settings TEXT);
CREATE TABLE IF NOT EXISTS conversations (id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), title TEXT NOT NULL DEFAULT 'New chat', mode TEXT NOT NULL DEFAULT 'chat',
  created_at TEXT DEFAULT datetime('now'), updated_at TEXT DEFAULT datetime('now'), pinned INTEGER DEFAULT 0, archived INTEGER DEFAULT 0, assistant TEXT);
CREATE TABLE IF NOT EXISTS messages (id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), role TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT DEFAULT datetime('now'),
  conversation_id INTEGER, mode TEXT DEFAULT 'chat', model TEXT, pinned INTEGER DEFAULT 0, meta TEXT);
CREATE TABLE IF NOT EXISTS memories (id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), content TEXT NOT NULL, created_at TEXT DEFAULT datetime('now'));
CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS usage_log (id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL, provider TEXT, model TEXT, mode TEXT, input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0,
  estimated INTEGER DEFAULT 0, ok INTEGER DEFAULT 1, created_at TEXT DEFAULT datetime('now'));
CREATE TABLE IF NOT EXISTS error_log (id SERIAL PRIMARY KEY, created_at TEXT DEFAULT datetime('now'), request_id TEXT, user_id INTEGER, route TEXT, message TEXT, stack TEXT);
CREATE TABLE IF NOT EXISTS password_resets (id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL, token_hash TEXT NOT NULL UNIQUE, expires_at TEXT NOT NULL, used_at TEXT, created_by INTEGER,
  created_at TEXT DEFAULT datetime('now'));
CREATE TABLE IF NOT EXISTS assistants (id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL, name TEXT NOT NULL, icon TEXT, instructions TEXT NOT NULL, created_at TEXT DEFAULT datetime('now'));
CREATE TABLE IF NOT EXISTS prompts (id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT DEFAULT datetime('now'));
CREATE TABLE IF NOT EXISTS user_sessions (sid TEXT PRIMARY KEY, sess TEXT NOT NULL, expire BIGINT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_users_username_lower ON users(lower(username));
CREATE INDEX IF NOT EXISTS idx_conversations_user_list ON conversations(user_id, archived, pinned, updated_at);
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, id);
CREATE INDEX IF NOT EXISTS idx_messages_user_pinned ON messages(user_id, pinned);
CREATE INDEX IF NOT EXISTS idx_memories_user ON memories(user_id, id);
CREATE INDEX IF NOT EXISTS idx_usage_user ON usage_log(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_error_log_time ON error_log(created_at);
CREATE INDEX IF NOT EXISTS idx_assistants_user ON assistants(user_id);
CREATE INDEX IF NOT EXISTS idx_prompts_user ON prompts(user_id);
CREATE INDEX IF NOT EXISTS idx_user_sessions_expire ON user_sessions(expire);`);
  // v4.2: guest mode — daily message counts only (no chat text, no IP addresses)
  await db.exec("CREATE TABLE IF NOT EXISTS guest_usage (bucket TEXT NOT NULL, day TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (bucket, day));");
  // v4.3: plans and Sam Credits (no real money yet)
  await db.addColumn("users", "plan", "TEXT DEFAULT 'free'");
  await db.exec(`CREATE TABLE IF NOT EXISTS credit_ledger (id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL, month TEXT NOT NULL, delta INTEGER NOT NULL, kind TEXT NOT NULL,
  feature TEXT, model TEXT, tier TEXT, description TEXT, created_at TEXT DEFAULT datetime('now'));
CREATE INDEX IF NOT EXISTS idx_credit_user_month ON credit_ledger(user_id, month);
CREATE UNIQUE INDEX IF NOT EXISTS idx_credit_allowance ON credit_ledger(user_id, month) WHERE kind='allowance';`);
  // Future additive changes go here, e.g.: await db.addColumn("users", "email", "TEXT");
}

let ready = null;
function init() {
  if (!ready) ready = (engine === "postgres" ? migratePostgres() : migrateSqlite()).catch(e => { ready = null; throw e; });
  return ready;
}

// ---------------------------------------------------------------- Shared helpers
// A stable session secret: SESSION_SECRET if set, otherwise generated ONCE and stored in the database,
// so sessions survive restarts and nobody can forge cookies with a known default secret.
async function getSessionSecret() {
  if (process.env.SESSION_SECRET && !/replace_with/.test(process.env.SESSION_SECRET)) return process.env.SESSION_SECRET;
  const row = await db.get("SELECT value FROM app_settings WHERE key='session_secret'");
  if (row) return row.value;
  const secret = crypto.randomBytes(48).toString("hex");
  await db.run("INSERT INTO app_settings(key,value) VALUES('session_secret',?) ON CONFLICT(key) DO NOTHING", secret);
  console.warn("[sam] SESSION_SECRET not set — generated one and stored it in the database.");
  return (await db.get("SELECT value FROM app_settings WHERE key='session_secret'")).value;
}

// Exact match first (old accounts), then case-insensitive — "Ryder" can log in as "ryder", but only if unambiguous.
async function findUserByUsername(username) {
  const exact = await db.get("SELECT * FROM users WHERE username=?", username);
  if (exact) return exact;
  const loose = await db.all("SELECT * FROM users WHERE lower(username)=lower(?)", username);
  return loose.length === 1 ? loose[0] : null;
}

async function usernameTaken(username) {
  return !!(await db.get("SELECT 1 AS x FROM users WHERE lower(username)=lower(?)", username));
}

// Never throws: a failed usage record must not break a chat.
function logUsage({ userId, provider, model, mode, inputTokens = 0, outputTokens = 0, estimated = false, ok = true }) {
  return db.run(
    "INSERT INTO usage_log(user_id,provider,model,mode,input_tokens,output_tokens,estimated,ok) VALUES(?,?,?,?,?,?,?,?)",
    userId, provider || null, model || null, mode || null, inputTokens | 0, outputTokens | 0, estimated ? 1 : 0, ok ? 1 : 0
  ).catch(e => console.error("[sam] usage log failed:", e.message));
}

module.exports = { db, engine, init, TABLES, DB_PATH, DATA_DIR, getSessionSecret, findUserByUsername, usernameTaken, logUsage, toPg, pgConfig };
