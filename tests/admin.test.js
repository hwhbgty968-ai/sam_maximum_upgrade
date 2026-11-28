const assert = require("node:assert/strict");
const fs = require("fs"), path = require("path");
const repo = process.argv[2] || require("path").join(__dirname, "..");
const { engine, t, done } = require("./_env")("adm");
process.env.SESSION_SECRET = "x".repeat(40);
delete process.env.ADMIN_SETUP_CODE; process.env.ADMIN_USERNAMES = "ryder";
process.env.MODEL_PRICES = JSON.stringify({ "gemini-3.7-flash": [0.3, 2.5] });
const { db, init, logUsage } = require(repo + "/lib/db.js");
const admin = require(repo + "/lib/admin.js");
const acc = require(repo + "/lib/accounts.js");
const { logError } = require(repo + "/lib/log.js");

(async () => {
  await init();
  const c = async (sql, ...a) => Number((await db.get(sql, ...a)).c);
  const add = u => db.insert("INSERT INTO users(username,password_hash,age) VALUES(?,?,?)", u, "h", 14);
  const ryder = await add("ryder"), alice = await add("alice"), bob = await add("bob");
  const conv = uid => db.insert("INSERT INTO conversations(user_id,title) VALUES(?,'t')", uid);
  const ca = await conv(alice), cb = await conv(bob);
  await db.run("INSERT INTO messages(user_id,role,content,conversation_id) VALUES(?,?,?,?)", alice, "user", "alice secret", ca);
  await db.run("INSERT INTO messages(user_id,role,content,conversation_id) VALUES(?,?,?,?)", bob, "user", "bob secret", cb);
  await db.run("INSERT INTO memories(user_id,content) VALUES(?,?)", alice, "alice memory");
  await db.run("INSERT INTO memories(user_id,content) VALUES(?,?)", bob, "bob memory");
  await logUsage({ userId: alice, provider: "gemini", model: "gemini-3.7-flash", mode: "chat", inputTokens: 1_000_000, outputTokens: 100_000 });
  await logUsage({ userId: bob, provider: "anthropic", model: "claude-x", mode: "chat", inputTokens: 500, outputTokens: 50, ok: false });

  let code;
  await t("no admin yet → a setup code is made and logged; ADMIN_USERNAMES no longer grants admin", async () => {
    const said = []; code = await admin.ensureSetupCode(s => said.push(s));
    assert.match(code, /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    assert.ok(said.some(s => s.includes(code)), "code is printed in the server log");
    assert.ok(said.some(s => /ADMIN_USERNAMES is no longer used/.test(s)));
    assert.equal(admin.isAdmin(await db.get("SELECT * FROM users WHERE id=?", ryder)), false, "a name in ADMIN_USERNAMES is NOT admin by itself");
    assert.equal(admin.status().setupOpen, true);
  });
  await t("wrong code rejected; right code (any case/spacing) makes you the first admin", async () => {
    await assert.rejects(admin.claimAdmin(alice, "AAAA-BBBB-CCCC"), /isn't right/);
    await assert.rejects(admin.claimAdmin(alice, ""), /isn't right/);
    assert.ok(await admin.claimAdmin(ryder, " " + code.toLowerCase().replace(/-/g, " ") + " "));
    assert.equal((await db.get("SELECT role FROM users WHERE id=?", ryder)).role, "owner", "the first person becomes the Creator (owner)");
    assert.equal(admin.status().setupOpen, false, "code is used up");
  });
  await t("once an admin exists nobody else can claim, even with the old code", async () => {
    await assert.rejects(admin.claimAdmin(alice, code), /already has an admin/);
    assert.equal(await admin.ensureSetupCode(() => {}), null, "no new code after restart");
  });
  await t("ADMIN_SETUP_CODE from the environment is used instead of a random one (and not printed)", async () => {
    await db.run("UPDATE users SET role='user' WHERE id=?", ryder);
    process.env.ADMIN_SETUP_CODE = "my-own-code-123"; const said = [];
    assert.equal(await admin.ensureSetupCode(s => said.push(s)), "my-own-code-123");
    assert.ok(!said.join(" ").includes("my-own-code-123"));
    assert.ok(await admin.claimAdmin(ryder, "MY OWN CODE 123"));
    delete process.env.ADMIN_SETUP_CODE;
  });
  await t("the Creator (owner) can remove admins, nobody can change the Creator; disabled admins aren't admins", async () => {
    const roles = require(repo + "/lib/roles.js");
    const owner = await db.get("SELECT * FROM users WHERE id=?", ryder);
    assert.equal(owner.role, "owner", "the setup code makes the Creator");
    await db.run("UPDATE users SET role='admin' WHERE id=?", alice);
    const al = await db.get("SELECT * FROM users WHERE id=?", alice);
    assert.ok(admin.isAdmin(al) && admin.isAdmin(owner));
    assert.ok(!admin.isAdmin({ role: "admin", disabled: 1 }));
    await assert.rejects(roles.removeAdmin(al, ryder), /Only the Creator/);
    await assert.rejects(roles.removeAdmin(owner, ryder), /Creator's role can't be changed/);
    assert.equal(await roles.removeAdmin(owner, alice), true);
    await assert.rejects(roles.removeAdmin(owner, 99999), /not found/);
  });
  await t("overview counts + database info", async () => {
    const o = await admin.overview();
    assert.equal(o.users, 3); assert.equal(o.conversations, 2); assert.equal(o.messages, 2);
    assert.equal(o.usageToday.requests, 2); assert.equal(o.usageToday.failures, 1);
    assert.deepEqual(o.admins, ["ryder"]); assert.equal(o.database.engine, engine); assert.ok(o.dbSizeBytes > 0);
  });
  await t("user list: search, per-user stats, admin flag", async () => {
    const all = await admin.listUsers({});
    assert.equal(all.total, 3);
    const a = all.users.find(u => u.username === "alice");
    assert.equal(a.messages, 1); assert.equal(a.tokens30d, 1_100_000); assert.equal(a.disabled, false);
    assert.ok(all.users.find(u => u.username === "ryder").isAdmin);
    assert.deepEqual((await admin.listUsers({ q: "BO" })).users.map(u => u.username), ["bob"]);
    assert.equal((await admin.listUsers({ q: "%" })).total, 0, "a typed % is literal, not 'match everything'");
    const u2 = await db.insert("INSERT INTO users(username,password_hash) VALUES(?,?)", "smoke_x1", "h");
    assert.deepEqual((await admin.listUsers({ q: "e_x" })).users.map(u => u.username), ["smoke_x1"], "underscore matches literally");
    assert.equal((await admin.listUsers({ q: "ex" })).total, 0, "_ isn't a wildcard");
    await db.run("DELETE FROM users WHERE id=?", u2);
  });
  await t("disable / enable", async () => {
    assert.ok(await admin.setDisabled(alice, true)); assert.equal((await db.get("SELECT disabled FROM users WHERE id=?", alice)).disabled, 1);
    assert.ok(await admin.setDisabled(alice, false)); assert.ok(!(await admin.setDisabled(9999, true)));
  });
  await t("usage report: costs only for priced models, never guessed", async () => {
    const r = await admin.usageReport(1);
    const g = r.rows.find(x => x.model === "gemini-3.7-flash"), cl = r.rows.find(x => x.model === "claude-x");
    assert.equal(g.costUsd, 0.55); assert.equal(cl.costUsd, null); assert.equal(cl.failures, 1);
    assert.match(g.day, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(r.totalCostUsd, 0.55); assert.equal(r.unpricedRequests, 1);
  });
  await t("error log stores ref + user, readable by admin", async () => {
    const orig = console.error; console.error = () => {};
    await logError({ requestId: "abcd1234", userId: alice, route: "/api/chat", error: new Error("boom") });
    console.error = orig;
    const e = (await admin.recentErrors())[0];
    assert.equal(e.request_id, "abcd1234"); assert.equal(e.username, "alice"); assert.equal(e.message, "boom"); assert.match(e.stack, /Error: boom/);
  });
  await t("reset token: works once, only hash stored", async () => {
    const { token } = await acc.createResetToken(alice, ryder);
    assert.match(token, /^[a-f0-9]{64}$/);
    assert.equal(await c("SELECT COUNT(*) AS c FROM password_resets WHERE token_hash=?", token), 0, "raw token must not be stored");
    assert.equal(await acc.consumeResetToken(token), alice);
    assert.equal(await acc.consumeResetToken(token), null, "second use rejected");
  });
  await t("reset token: two uses at the same moment → only one wins", async () => {
    const { token } = await acc.createResetToken(bob);
    const r = await Promise.all([acc.consumeResetToken(token), acc.consumeResetToken(token), acc.consumeResetToken(token)]);
    assert.equal(r.filter(Boolean).length, 1, JSON.stringify(r));
  });
  await t("reset token: new link cancels the old one; garbage rejected", async () => {
    const t1 = (await acc.createResetToken(bob)).token, t2 = (await acc.createResetToken(bob)).token;
    assert.equal(await acc.consumeResetToken(t1), null); assert.equal(await acc.consumeResetToken(t2), bob);
    assert.equal(await acc.consumeResetToken("x' OR 1=1 --"), null); assert.equal(await acc.consumeResetToken(undefined), null);
  });
  await t("reset token: expired link rejected", async () => {
    const { token } = await acc.createResetToken(bob);
    await db.run("UPDATE password_resets SET expires_at=datetime('now','-1 minute') WHERE token_hash=?", acc.sha256(token));
    assert.equal(await acc.consumeResetToken(token), null);
  });
  await t("password change stamps password_changed_at (signs out other devices)", async () => {
    const stamp = await acc.setPasswordHash(alice, "newhash");
    const u = await db.get("SELECT password_hash, password_changed_at FROM users WHERE id=?", alice);
    assert.equal(u.password_hash, "newhash"); assert.equal(u.password_changed_at, stamp);
  });
  await t("export: only the user's own data, no password hash", async () => {
    const ex = await acc.exportUserData(alice), s = JSON.stringify(ex);
    assert.ok(s.includes("alice secret") && s.includes("alice memory"));
    assert.ok(!s.includes("bob") && !s.includes("password_hash") && !s.includes("newhash"));
    assert.equal(ex.conversations[0].messages.length, 1);
  });
  await t("delete account removes everything of theirs and nothing of anyone else's", async () => {
    await acc.deleteUserData(alice);
    for (const tbl of ["messages", "conversations", "memories", "usage_log", "password_resets"])
      assert.equal(await c(`SELECT COUNT(*) AS c FROM ${tbl} WHERE user_id=?`, alice), 0, tbl);
    assert.equal(await c("SELECT COUNT(*) AS c FROM users WHERE id=?", alice), 0);
    assert.equal(await c("SELECT COUNT(*) AS c FROM error_log WHERE user_id=?", alice), 0, "error log kept but anonymised");
    assert.equal(await c("SELECT COUNT(*) AS c FROM messages WHERE user_id=?", bob), 1);
    assert.equal(await c("SELECT COUNT(*) AS c FROM memories WHERE user_id=?", bob), 1);
  });
  if (engine === "sqlite") {
    await t("SQLite backup files: readable copy, pruned to BACKUP_KEEP", async () => {
      const r = await admin.runBackup();
      assert.match(r.file, /^sam-.*\.sqlite$/);
      const Database = require("better-sqlite3");
      const copy = new Database(path.join(admin.BACKUP_DIR, r.file), { readonly: true });
      assert.equal(copy.prepare("SELECT COUNT(*) c FROM users").get().c, 2);
      for (let i = 0; i < 16; i++) fs.writeFileSync(path.join(admin.BACKUP_DIR, `sam-2020-01-${String(i + 1).padStart(2, "0")}T00-00-00.sqlite`), "x");
      await new Promise(r => setTimeout(r, 1100)); await admin.runBackup();
      assert.equal(admin.listBackups().length, 14); assert.ok(!admin.listBackups().some(b => b.file.includes("2020-01-01")));
    });
  } else {
    await t("Postgres: server backup files are refused with a helpful message", async () => {
      await assert.rejects(admin.runBackup(), /Download full backup/);
      assert.deepEqual(admin.listBackups(), []);
    });
  }
  await db.close();
  done("admin.js + accounts.js");
})();
