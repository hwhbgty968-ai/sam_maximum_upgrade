const assert = require("node:assert/strict");
const path = require("path");
const { execFileSync } = require("child_process");
const repo = process.argv[2] || require("path").join(__dirname, "..");
const { engine, dir, t, done } = require("./_env")("db");
delete process.env.SESSION_SECRET;

(async () => {
  if (engine === "sqlite") {
    // A database exactly like the ORIGINAL (oldest) Sam: no conversations, no age, no conversation_id.
    const Database = require("better-sqlite3");
    const old = new Database(path.join(dir, "sam.sqlite"));
    old.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE memories (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, content TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
INSERT INTO users(username,password_hash) VALUES ('Ryder','hashR'),('Sam','hashS1'),('sam','hashS2');
INSERT INTO messages(user_id,role,content) VALUES (1,'user','old hello'),(1,'assistant','old reply'),(2,'user','sam msg');
INSERT INTO memories(user_id,content) VALUES (1,'likes planes');`);
    old.close();
  }
  const origWarn = console.warn; console.warn = () => {};
  const m = require(repo + "/lib/db.js");
  await m.init();
  console.warn = origWarn;
  const { db } = m;
  const c = async (sql, ...a) => Number((await db.get(sql, ...a)).c);
  if (engine === "postgres") {
    await db.run("INSERT INTO users(username,password_hash) VALUES ('Ryder','hashR'),('Sam','hashS1'),('sam','hashS2')");
  }

  await t("engine chosen from DATABASE_URL", () => assert.equal(m.engine, engine));
  if (engine === "sqlite") {
    await t("old database: every user, message and memory still there", async () => {
      assert.equal(await c("SELECT COUNT(*) AS c FROM users"), 3);
      assert.equal(await c("SELECT COUNT(*) AS c FROM messages"), 3);
      assert.equal((await db.get("SELECT content FROM memories WHERE user_id=1")).content, "likes planes");
    });
    await t("old messages moved into a 'Previous chat' per user", async () => {
      const convs = await db.all("SELECT * FROM conversations WHERE title='Previous chat' ORDER BY user_id");
      assert.equal(convs.length, 2);
      assert.equal(await c("SELECT COUNT(*) AS c FROM messages WHERE conversation_id IS NULL"), 0);
      assert.equal(await c("SELECT COUNT(*) AS c FROM messages WHERE conversation_id=?", convs[0].id), 2);
    });
  }
  await t("all columns + tables present", async () => {
    for (const col of ["age", "role", "last_login_at", "disabled", "password_changed_at", "settings"]) assert.ok((await db.columns("users")).includes(col), col);
    for (const col of ["conversation_id", "mode", "model", "pinned", "meta"]) assert.ok((await db.columns("messages")).includes(col), col);
    for (const tbl of ["usage_log", "app_settings", "error_log", "password_resets", "assistants", "prompts", "user_sessions"]) assert.ok((await db.columns(tbl)).length > 1, tbl);
  });
  await t("login lookup: case-insensitive when unambiguous", async () => assert.equal((await m.findUserByUsername("RYDER")).password_hash, "hashR"));
  await t("login lookup: exact match wins for 'Sam' vs 'sam'; ambiguous refused", async () => {
    assert.equal((await m.findUserByUsername("Sam")).password_hash, "hashS1");
    assert.equal((await m.findUserByUsername("sam")).password_hash, "hashS2");
    assert.equal(await m.findUserByUsername("SAM"), null);
  });
  await t("registration blocks case-variants of existing names", async () => { assert.ok(await m.usernameTaken("rYdEr")); assert.ok(!(await m.usernameTaken("newperson"))); });
  await t("timestamps look the same on both engines (YYYY-MM-DD HH:MM:SS, UTC)", async () => {
    const r = await db.get("SELECT datetime('now') AS a, datetime('now', ?) AS b, created_at FROM users LIMIT 1", "-1 day");
    for (const v of [r.a, r.b, r.created_at]) assert.match(v, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    assert.ok(r.b < r.a);
    assert.equal(r.a.slice(0, 13), new Date().toISOString().replace("T", " ").slice(0, 13));
  });
  const secret1 = await m.getSessionSecret();
  await t("session secret generated (not a default)", () => { assert.ok(secret1.length >= 64); assert.ok(!/development-only/.test(secret1)); });
  await t("usage logging works and never throws", async () => {
    await m.logUsage({ userId: 1, provider: "gemini", model: "g", mode: "chat", inputTokens: 12, outputTokens: 7, estimated: true });
    assert.equal((await db.get("SELECT output_tokens AS o FROM usage_log")).o, 7);
    const orig = console.error; console.error = () => {};
    await m.logUsage({ userId: null }); // NOT NULL violation → logged, not thrown
    console.error = orig;
  });
  await t("booleans and undefined are stored as 1/0 and NULL", async () => {
    await db.run("UPDATE users SET disabled=?, settings=? WHERE id=1", true, undefined);
    const u = await db.get("SELECT disabled, settings FROM users WHERE id=1");
    assert.equal(u.disabled, 1); assert.equal(u.settings, null);
    await db.run("UPDATE users SET disabled=? WHERE id=1", false);
  });
  await t("transactions: other requests can't see or join a half-finished one", async () => {
    let inside = null;
    const tx = db.tx(async tr => {
      await tr.run("UPDATE users SET age=? WHERE id=1", 77);
      await new Promise(r => setTimeout(r, 50)); // another request runs meanwhile
      inside = (await tr.get("SELECT age FROM users WHERE id=1")).age;
      throw new Error("abort");
    });
    const outside = db.run("UPDATE users SET age=? WHERE id=2", 55); // must not be rolled back with the tx
    await assert.rejects(tx, /abort/); await outside;
    assert.equal(inside, 77);
    assert.equal((await db.get("SELECT age FROM users WHERE id=1")).age, null, "rolled back");
    assert.equal((await db.get("SELECT age FROM users WHERE id=2")).age, 55, "other request kept");
  });
  await t("sessions table: upsert works", async () => {
    await db.run("INSERT INTO user_sessions(sid,sess,expire) VALUES(?,?,?) ON CONFLICT(sid) DO UPDATE SET sess=excluded.sess, expire=excluded.expire", "s1", "{}", Date.now() + 1e6);
    await db.run("INSERT INTO user_sessions(sid,sess,expire) VALUES(?,?,?) ON CONFLICT(sid) DO UPDATE SET sess=excluded.sess, expire=excluded.expire", "s1", '{"a":1}', 1733000000000);
    const s = await db.get("SELECT * FROM user_sessions WHERE sid='s1'");
    assert.equal(s.sess, '{"a":1}'); assert.equal(Number(s.expire), 1733000000000, "big millisecond numbers survive (BIGINT)");
  });
  await db.close();

  // Restart in a fresh process: migrations must be idempotent and the secret must survive.
  const out = execFileSync(process.execPath, ["-e", `const m=require(${JSON.stringify(repo + "/lib/db.js")});(async()=>{await m.init();const n=async s=>Number((await m.db.get(s)).c);console.log(JSON.stringify({s:await m.getSessionSecret(),c:await n("SELECT COUNT(*) AS c FROM conversations"),u:await n("SELECT COUNT(*) AS c FROM users")}));await m.db.close();})()`], { env: { ...process.env }, stdio: ["ignore", "pipe", "ignore"] }).toString();
  const after = JSON.parse(out);
  await t("restart: session secret is the same (users stay logged in)", () => assert.equal(after.s, secret1));
  await t("restart: migrations don't duplicate anything", () => { assert.equal(after.c, engine === "sqlite" ? 2 : 0); assert.equal(after.u, 3); });
  process.env.SESSION_SECRET = "my-own-secret-from-env";
  await t("SESSION_SECRET from env takes priority", async () => assert.equal(await m.getSessionSecret(), "my-own-secret-from-env"));

  await t("placeholder conversion skips quoted text", () => {
    assert.equal(m.toPg("SELECT * FROM t WHERE a=? AND b='?' AND c=? ESCAPE '\\'"), "SELECT * FROM t WHERE a=$1 AND b='?' AND c=$2 ESCAPE '\\'");
  });
  await t("Neon URL: TLS on with certificate checks, libpq-only params removed, password kept", () => {
    const cfg = m.pgConfig("postgresql://neondb_owner:p%40ss@ep-x-pooler.c-15.us-east-1.aws.neon.tech/neondb?channel_binding=require&sslmode=require");
    assert.deepEqual(cfg.ssl, { rejectUnauthorized: true });
    assert.ok(!/sslmode|channel_binding/.test(cfg.connectionString));
    assert.match(cfg.connectionString, /^postgresql:\/\/neondb_owner:p%40ss@ep-x-pooler\.c-15\.us-east-1\.aws\.neon\.tech\/neondb$/);
    assert.equal(m.pgConfig("postgres://u@localhost:5432/db").ssl, false, "local test servers don't need TLS");
    assert.deepEqual(m.pgConfig("postgres://u@db.example.com/db").ssl, { rejectUnauthorized: true }, "remote: TLS by default");
  });
  done("db.js");
})();
