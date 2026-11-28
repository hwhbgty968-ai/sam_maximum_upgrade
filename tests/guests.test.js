const assert = require("node:assert/strict");
const repo = process.argv[2] || require("path").join(__dirname, "..");
const { t, done } = require("./_env")("guests");
process.env.SESSION_SECRET = "x".repeat(40);
for (const k of ["GUEST_MODE", "GUEST_DAILY_MESSAGES", "GUEST_NETWORK_DAILY", "GUEST_DAILY_TOTAL", "GUEST_IDLE_MIN"]) delete process.env[k];
const { db, init } = require(repo + "/lib/db.js");
const guests = require(repo + "/lib/guests.js");
const chats = require(repo + "/lib/chats.js");

(async () => {
  await init();
  guests.setSalt("test-secret");

  await t("defaults: 10 a day per guest, 30 per network, 300 for all guests, 2 h idle", () => {
    const c = guests.config();
    assert.deepEqual([c.enabled, c.perGuest, c.perNetwork, c.total, c.idleMs], [true, 10, 30, 300, 120 * 60000]);
  });

  await t("each guest gets exactly 10 messages a day, then a clear 'create an account' message", async () => {
    const g = guests.newGuestId();
    assert.equal((await guests.remaining(g, "1.1.1.1")).remaining, 10);
    for (let i = 0; i < 10; i++) assert.equal((await guests.reserve(g, "1.1.1.1")).ok, true);
    const r = await guests.reserve(g, "1.1.1.1");
    assert.deepEqual([r.ok, r.reason], [false, "perGuest"]);
    assert.match(guests.limitMessage(r.reason), /today's 10 free guest messages\. Create a free account/);
    assert.equal((await guests.remaining(g, "1.1.1.1")).remaining, 0);
  });

  await t("a refused message takes nothing; release() gives a message back", async () => {
    const g = guests.newGuestId();
    const s = await guests.reserve(g, "2.2.2.2");
    assert.equal((await guests.remaining(g, "2.2.2.2")).remaining, 9);
    await s.release();
    assert.equal((await guests.remaining(g, "2.2.2.2")).remaining, 10);
    await s.release(); // twice is harmless
    assert.equal((await guests.remaining(g, "2.2.2.2")).remaining, 10);
  });

  await t("clearing cookies doesn't reset the limit forever: the network cap (30) stops it", async () => {
    const ip = "3.3.3.3"; let refused = null;
    for (let n = 0; n < 4 && !refused; n++) {
      const g = guests.newGuestId(); // a "new" guest each time
      for (let i = 0; i < 10; i++) { const r = await guests.reserve(g, ip); if (!r.ok) { refused = r.reason; break; } }
    }
    assert.equal(refused, "perNetwork");
    assert.equal((await guests.remaining(guests.newGuestId(), ip)).remaining, 0);
    assert.equal((await guests.remaining(guests.newGuestId(), "4.4.4.4")).remaining, 10, "other networks are unaffected");
  });

  await t("the all-guests daily cap protects costs; counts only (no chat text, no raw IPs) are stored", async () => {
    process.env.GUEST_DAILY_TOTAL = "5";
    const total = Number((await db.get("SELECT count FROM guest_usage WHERE bucket='all'")).count);
    assert.ok(total > 5);
    const r = await guests.reserve(guests.newGuestId(), "5.5.5.5");
    assert.deepEqual([r.ok, r.reason], [false, "total"]);
    assert.match(guests.limitMessage("total"), /all used up for today/);
    delete process.env.GUEST_DAILY_TOTAL;
    const rows = await db.all("SELECT * FROM guest_usage");
    assert.deepEqual(Object.keys(rows[0]).sort(), ["bucket", "count", "day"]);
    assert.ok(!JSON.stringify(rows).includes("3.3.3.3"), "network addresses are hashed");
  });

  await t("parallel messages can't sneak past the limit", async () => {
    process.env.GUEST_DAILY_MESSAGES = "3";
    const g = guests.newGuestId();
    const results = await Promise.all(Array.from({ length: 8 }, () => guests.reserve(g, "6.6.6.6")));
    assert.equal(results.filter(r => r.ok).length, 3);
    delete process.env.GUEST_DAILY_MESSAGES;
  });

  await t("guest chats live in memory only, keep the last 20 messages, and are deleted on forget/idle", async () => {
    const g = guests.newGuestId(), h = guests.newGuestId();
    for (let i = 0; i < 12; i++) guests.add(g, "q" + i, "a" + i, "m");
    guests.add(h, "other", "chat", "m");
    assert.equal(guests.messages(g).length, 20);
    assert.equal(guests.messages(g)[0].content, "q2");
    assert.deepEqual(guests.history(h), [{ role: "user", content: "other" }, { role: "assistant", content: "chat" }]);
    assert.ok(!(await db.all("SELECT content FROM messages")).length, "nothing written to the messages table");
    guests.forget(g);
    assert.deepEqual(guests.messages(g), []);
    await guests.sweep(Date.now() + 121 * 60000);
    assert.deepEqual(guests.messages(h), [], "idle for over 2 hours → deleted");
  });

  await t("old daily counters are cleaned up after 3 days", async () => {
    await db.run("INSERT INTO guest_usage(bucket,day,count) VALUES('all','2000-01-01',5)");
    await guests.sweep();
    assert.ok(!(await db.get("SELECT 1 AS x FROM guest_usage WHERE day='2000-01-01'")));
  });

  await t("guests only get Fast models (Balanced as a backup), never Deep", () => {
    const list = [{ tier: "deep", model: "d" }, { tier: "balanced", model: "b" }, { tier: "fast", model: "f1" }, { tier: "fast", model: "f2" }];
    assert.deepEqual(guests.candidates(list).map(c => c.model), ["f1", "f2", "b"]);
  });

  await t("saving a guest chat into an account (only when asked) creates one normal conversation", async () => {
    const uid = await db.insert("INSERT INTO users(username,password_hash) VALUES('newbie','h')");
    const g = guests.newGuestId();
    guests.add(g, "What is a black hole?", "A region where gravity…", "gemini-3.5-flash");
    const cid = await chats.importConversation(uid, guests.messages(g));
    const conv = await chats.getConversation(uid, cid);
    assert.equal(conv.conversation.title, "What is a black hole?");
    assert.deepEqual(conv.messages.map(m => [m.role, m.content]), [["user", "What is a black hole?"], ["assistant", "A region where gravity…"]]);
    assert.equal(await chats.importConversation(uid, []), null, "an empty guest chat creates nothing");
  });

  await t("stats for the admin dashboard", async () => {
    const s = await guests.stats();
    assert.equal(s.perGuest, 10); assert.equal(s.dailyTotal, 300); assert.ok(s.messagesToday > 0);
  });

  done("guests.js");
  process.exit(process.exitCode || 0);
})();
