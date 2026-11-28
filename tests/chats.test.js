const assert = require("node:assert/strict");
const repo = process.argv[2] || require("path").join(__dirname, "..");
const { engine, t, done } = require("./_env")("chats");
process.env.SESSION_SECRET = "x".repeat(40);
const { db, init } = require(repo + "/lib/db.js");
const chats = require(repo + "/lib/chats.js");
const ai = require(repo + "/lib/ai.js");

(async () => {
  await init();
  const user = u => db.insert("INSERT INTO users(username,password_hash) VALUES(?,?)", u, "h");
  const conv = (uid, title = "New chat") => db.insert("INSERT INTO conversations(user_id,title) VALUES(?,?)", uid, title);
  const A = await user("alice"), B = await user("bob");
  const a1 = await conv(A), a2 = await conv(A), b1 = await conv(B);
  const ex1 = await chats.saveExchange(A, a1, "chat", "What is photosynthesis?", "Plants turn **light** into food.", "gemini-x");
  await chats.saveExchange(A, a1, "chat", "And respiration?", "Cells release energy.", "gemini-x");
  await chats.saveExchange(A, a2, "chat", "Plan my 100% revision_week", "Here's a plan", "claude-x");
  await chats.saveExchange(B, b1, "chat", "bob's photosynthesis homework", "secret bob answer", "x");

  await t("saveExchange: ids returned, title auto-set from first message", async () => {
    assert.ok(ex1.userMessageId < ex1.assistantMessageId);
    assert.equal(typeof ex1.userMessageId, "number");
    assert.equal(ex1.title, "What is photosynthesis?");
    assert.equal((await db.get("SELECT title FROM conversations WHERE id=?", a1)).title, "What is photosynthesis?");
  });
  await t("rename / pin / archive own chat; list ordering puts pinned first", async () => {
    assert.equal((await chats.updateConversation(A, a1, { title: "  Biology   revision " })).title, "Biology revision");
    await chats.updateConversation(A, a2, { pinned: true });
    assert.deepEqual((await chats.listConversations(A)).map(c => c.id), [a2, a1]);
    await chats.updateConversation(A, a2, { archived: true });
    assert.deepEqual((await chats.listConversations(A)).map(c => c.id), [a1]);
    assert.deepEqual((await chats.listConversations(A, { archived: true })).map(c => c.id), [a2]);
    await chats.updateConversation(A, a2, { archived: false });
  });
  await t("empty title rejected", () => assert.rejects(chats.updateConversation(A, a1, { title: "   " }), /empty/));
  await t("can't touch someone else's chat", async () => {
    assert.equal(await chats.updateConversation(B, a1, { title: "hacked" }), null);
    assert.equal(await chats.getConversation(B, a1), null);
    assert.equal(await chats.deleteConversation(B, a1), false);
    assert.equal((await db.get("SELECT title FROM conversations WHERE id=?", a1)).title, "Biology revision");
  });
  await t("search: own chats only, titles + message text, case-insensitive, with snippet", async () => {
    const r = await chats.search(A, "PHOTOSYNTHESIS");
    assert.equal(r.messages.length, 1); assert.equal(r.messages[0].conversationId, a1);
    assert.match(r.messages[0].snippet, /photosynthesis/);
    assert.ok(!JSON.stringify(r).includes("bob"));
    assert.equal((await chats.search(A, "biology")).conversations[0].id, a1);
  });
  await t("search: % and _ are literal, 1-char queries ignored", async () => {
    assert.equal((await chats.search(A, "100%")).messages.length, 1);
    assert.equal((await chats.search(A, "n_m")).messages.length, 0, "_ must not act as a wildcard");
    assert.equal((await chats.search(A, "n_w")).messages.length, 1, "literal underscore matches revision_week");
    assert.equal((await chats.search(A, "%%")).messages.length, 0);
    assert.deepEqual((await chats.search(A, "a")).messages, []);
  });
  await t("pin messages: own only; pins list has chat title", async () => {
    assert.ok(await chats.setMessagePinned(A, ex1.assistantMessageId, true));
    const bobMsg = (await db.get("SELECT id FROM messages WHERE user_id=?", B)).id;
    assert.ok(!(await chats.setMessagePinned(A, bobMsg, true)), "can't pin bob's message");
    const p = await chats.listPins(A);
    assert.equal(p.messages.length, 1); assert.equal(p.messages[0].title, "Biology revision");
    assert.deepEqual(p.conversations.map(c => c.id), [a2]);
    assert.equal((await chats.listPins(B)).messages.length, 0);
    assert.equal((await chats.getConversation(A, a1)).messages.find(m => m.id === ex1.assistantMessageId).pinned, true);
  });
  await t("regenerate: finds last user message, deletes nothing until saved", async () => {
    const before = (await chats.getConversation(A, a1)).messages.length;
    const r = await chats.prepareRegenerate(A, a1);
    assert.equal(r.message, "And respiration?");
    assert.equal((await chats.getConversation(A, a1)).messages.length, before, "nothing deleted yet");
    const h = await chats.history(A, a1, { beforeId: r.userMessageId });
    assert.equal(h.length, 2); assert.equal(h[1].content, "Plants turn **light** into food.");
    await chats.saveAssistant(A, a1, "chat", "NEW respiration answer", "m2", null, { afterUserMessageId: r.userMessageId });
    const msgs = (await chats.getConversation(A, a1)).messages;
    assert.equal(msgs.length, before); assert.equal(msgs.at(-1).content, "NEW respiration answer");
    assert.ok(!msgs.some(m => m.content === "Cells release energy."));
  });
  await t("regenerate refuses image answers and empty chats; other user's chat untouched", async () => {
    const a3 = await conv(A); await chats.saveExchange(A, a3, "vision", "[Image] what is this", "a cat", "g");
    await assert.rejects(chats.prepareRegenerate(A, a3), /attach the image again/);
    await assert.rejects(chats.prepareRegenerate(A, await conv(A)), /nothing to regenerate/);
    await assert.rejects(chats.prepareRegenerate(A, b1), /nothing to regenerate/, "can't see bob's messages");
  });
  await t("edit & resend: validates, then replaces atomically on save", async () => {
    const msgs = (await chats.getConversation(A, a1)).messages;
    const firstUser = msgs.find(m => m.role === "user");
    await assert.rejects(chats.prepareEdit(A, a1, msgs.find(m => m.role === "assistant").id), /Only your own/);
    await assert.rejects(chats.prepareEdit(B, a1, firstUser.id), /not found/);
    const { replaceFromId } = await chats.prepareEdit(A, a1, firstUser.id);
    assert.equal((await chats.getConversation(A, a1)).messages.length, msgs.length, "nothing deleted before save");
    await chats.saveExchange(A, a1, "chat", "What is osmosis?", "Water moves…", "m", null, { replaceFromId });
    assert.deepEqual((await chats.getConversation(A, a1)).messages.map(m => m.content), ["What is osmosis?", "Water moves…"]);
    assert.equal(Number((await db.get("SELECT COUNT(*) AS c FROM messages WHERE user_id=?", B)).c), 2, "bob untouched");
  });
  await t("council answers saved as meta and returned parsed", async () => {
    const meta = { council: [{ provider: "gemini", model: "g", text: "4" }, { provider: "anthropic", model: "c", text: "four" }] };
    const s = await chats.saveExchange(A, a2, "council", "2+2?", "It's 4.", "council → g", meta);
    assert.deepEqual((await chats.getConversation(A, a2)).messages.find(x => x.id === s.assistantMessageId).meta, meta);
  });
  await t("a failed save leaves nothing half-written (transaction rolls back)", async () => {
    const before = Number((await db.get("SELECT COUNT(*) AS c FROM messages")).c);
    const bad = "x".repeat(10);
    // NULL content violates NOT NULL on the reply insert, after the user message was inserted
    await assert.rejects(chats.saveExchange(A, a1, "chat", bad, null, "m"));
    assert.equal(Number((await db.get("SELECT COUNT(*) AS c FROM messages")).c), before, "user message rolled back too");
  });
  await t("many saves at once from different users don't mix up (concurrency)", async () => {
    const cs = await Promise.all([A, B, A, B, A, B].map(u => conv(u)));
    const res = await Promise.all(cs.map((c, i) => chats.saveExchange(i % 2 ? B : A, c, "chat", "q" + i, "a" + i, "m")));
    const ids = new Set(res.flatMap(r => [r.userMessageId, r.assistantMessageId]));
    assert.equal(ids.size, 12, "every message got its own id");
    for (let i = 0; i < cs.length; i++) {
      const g = await chats.getConversation(i % 2 ? B : A, cs[i]);
      assert.deepEqual(g.messages.map(m => m.content), ["q" + i, "a" + i]);
    }
  });
  await t("delete conversation removes its messages only", async () => {
    const c = await conv(A); await chats.saveExchange(A, c, "chat", "bye", "ok", "m");
    assert.ok(await chats.deleteConversation(A, c));
    assert.equal(Number((await db.get("SELECT COUNT(*) AS c FROM messages WHERE conversation_id=?", c)).c), 0);
    assert.equal(await chats.getConversation(A, c), null);
  });
  await t("council picks: only configured providers, deduped, max 4", () => {
    ai.init({ GEMINI_API_KEY: "g", ANTHROPIC_API_KEY: "a" });
    const p = ai.pickMembers(["gemini:gemini-3.7-flash", "gemini:gemini-3.7-flash", "openai:gpt-x", "anthropic:claude-opus-5-5", "nonsense", "gemini:gemini-3.8-flash", "gemini:gemini-3.5-flash-lite", "anthropic:claude-haiku-5-5"]);
    assert.deepEqual(p.map(m => m.model), ["gemini-3.7-flash", "claude-opus-5-5", "gemini-3.8-flash", "gemini-3.5-flash-lite"]);
    assert.equal(ai.pickMembers(["openai:gpt-x"]), null);
  });
  await db.close();
  done("chats.js");
})();
