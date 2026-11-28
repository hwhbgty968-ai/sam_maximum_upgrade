// Restore drill: fill one engine with data, back it up, restore into a fresh database of the OTHER engine,
// and check everything came across, ids continue correctly, and logins still work.
const assert = require("node:assert/strict");
const fs = require("fs"), path = require("path"), os = require("os");
const { execFileSync } = require("child_process");
const repo = process.argv[2] || require("path").join(__dirname, "..");
const { engine, t, done, createPgDb, havePg } = require("./_env")("bk");
process.env.SESSION_SECRET = "x".repeat(40);
const other = engine === "postgres" ? "sqlite" : havePg ? "postgres" : "sqlite"; // cross-engine when Postgres is available

(async () => {
  const { db, init } = require(repo + "/lib/db.js");
  const chats = require(repo + "/lib/chats.js");
  const L = require(repo + "/lib/library.js");
  const bcrypt = require("bcryptjs");
  const { dumpAll, restoreAll } = require(repo + "/lib/backup.js");
  await init();
  const hash = bcrypt.hashSync("correct horse battery", 4);
  const A = await db.insert("INSERT INTO users(username,password_hash,age,role) VALUES(?,?,?,?)", "Ryder", hash, 14, "admin");
  const B = await db.insert("INSERT INTO users(username,password_hash,age) VALUES(?,?,?)", "bob", hash, 30);
  const c1 = await chats.createConversation(A, "chat");
  await chats.saveExchange(A, c1, "chat", "Hello 'quotes' and \\backslashes\\ and émoji 🚀", "Hi! **bold**\n```js\nx=1\n```", "gemini", { council: [{ text: "x" }] });
  await chats.saveExchange(B, await chats.createConversation(B), "chat", "bob q", "bob a", "m");
  await db.run("INSERT INTO memories(user_id,content) VALUES(?,?)", A, "likes planes");
  await L.saveSettings(A, { theme: "light" });
  await L.createAssistant(A, { name: "Pilot", instructions: "talk like a pilot" });
  await L.createPrompt(A, { title: "p", body: "b" });
  await db.run("INSERT INTO usage_log(user_id,provider,model,input_tokens,output_tokens) VALUES(?,?,?,?,?)", A, "gemini", "g", 5, 6);
  await db.run("INSERT INTO app_settings(key,value) VALUES('custom_flag','on')");
  const dump = await dumpAll();
  await db.close();

  await t("backup covers every table, skips the session secret, keeps hashes (marked private)", () => {
    assert.equal(dump.format, "sam-backup-v1");
    assert.equal(dump.counts.users, 2); assert.equal(dump.counts.messages, 4); assert.equal(dump.counts.assistants, 1);
    assert.ok(!dump.tables.app_settings.some(r => r.key === "session_secret"));
    assert.ok(dump.tables.app_settings.some(r => r.key === "custom_flag"));
  });

  // Restore into a fresh database of the other engine, in a separate process (each process has one database).
  const file = path.join(os.tmpdir(), `sam-drill-${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify(dump));
  const env = { ...process.env, DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "samrestore-")) };
  if (other === "postgres") env.DATABASE_URL = createPgDb("restore"); else delete env.DATABASE_URL;
  const script = `
    const assert=require("node:assert/strict");const bcrypt=require("bcryptjs");
    const {db,init,engine}=require(${JSON.stringify(repo + "/lib/db.js")});const {restoreAll,dumpAll}=require(${JSON.stringify(repo + "/lib/backup.js")});
    const chats=require(${JSON.stringify(repo + "/lib/chats.js")});const L=require(${JSON.stringify(repo + "/lib/library.js")});const {findUserByUsername}=require(${JSON.stringify(repo + "/lib/db.js")});
    (async()=>{await init();const d=JSON.parse(require("fs").readFileSync(${JSON.stringify(file)},"utf8"));
      const r=await restoreAll(d);const out={engine,r};
      const u=await findUserByUsername("ryder");out.login=bcrypt.compareSync("correct horse battery",u.password_hash);out.role=u.role;
      const conv=(await chats.listConversations(u.id))[0];const g=await chats.getConversation(u.id,conv.id);out.msgs=g.messages.map(m=>m.content);out.meta=g.messages[1].meta;
      out.theme=(await L.getSettings(u.id)).theme;out.assistants=(await L.listAssistants(u.id)).filter(a=>a.custom).map(a=>a.name);
      const nid=await chats.createConversation(u.id,"chat");out.newIdOk=nid>conv.id;const s=await chats.saveExchange(u.id,nid,"chat","after restore","ok","m");out.newMsgOk=s.userMessageId>4;
      try{await restoreAll(d);out.refused=false}catch(e){out.refused=/already has/.test(e.message)}
      out.again=(await dumpAll()).counts;console.log(JSON.stringify(out));await db.close();})().catch(e=>{console.error(e);process.exit(1)});`;
  let res;
  await t(`restore drill: ${engine} backup → fresh ${other} database`, () => {
    res = JSON.parse(execFileSync(process.execPath, ["-e", script], { env, stdio: ["ignore", "pipe", "inherit"] }).toString());
    assert.equal(res.engine, other);
    assert.equal(res.r.users, 2); assert.equal(res.r.messages, 4);
  });
  await t("restored: password still works, admin role kept, text with quotes/emoji/code intact", () => {
    assert.equal(res.login, true); assert.equal(res.role, "admin");
    assert.deepEqual(res.msgs, ["Hello 'quotes' and \\backslashes\\ and émoji 🚀", "Hi! **bold**\n```js\nx=1\n```"]);
    assert.deepEqual(res.meta, { council: [{ text: "x" }] });
  });
  await t("restored: settings, custom assistants come back", () => { assert.equal(res.theme, "light"); assert.deepEqual(res.assistants, ["Pilot"]); });
  await t("restored: new chats and messages get fresh ids (no clashes)", () => { assert.ok(res.newIdOk); assert.ok(res.newMsgOk); });
  await t("restore refuses to overwrite a database that already has accounts", () => assert.equal(res.refused, true));
  await t("a second backup of the restored database matches (plus the new chat)", () => {
    assert.equal(res.again.users, 2); assert.equal(res.again.messages, 6); assert.equal(res.again.conversations, 3);
  });
  fs.unlinkSync(file);
  done("backup + restore drill");
})();
