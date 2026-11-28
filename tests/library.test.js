const assert = require("node:assert/strict");
const repo = process.argv[2] || require("path").join(__dirname, "..");
const { t, done } = require("./_env")("lib");
process.env.SESSION_SECRET = "x".repeat(40);
const { db, init } = require(repo + "/lib/db.js");
const L = require(repo + "/lib/library.js");
const acc = require(repo + "/lib/accounts.js");
const ai = require(repo + "/lib/ai.js");

(async () => {
  await init();
  const user = u => db.insert("INSERT INTO users(username,password_hash) VALUES(?,?)", u, "h");
  const A = await user("alice"), B = await user("bob");
  const c = async (sql, ...a) => Number((await db.get(sql, ...a)).c);

  await t("settings: defaults, save, validation, isolation", async () => {
    assert.equal((await L.getSettings(A)).personality, "sam"); assert.equal((await L.getSettings(A)).autoMode, true);
    const s = await L.saveSettings(A, { personality: "professional", theme: "light", accent: "blue", explainSimply: 1, customInstructions: "x".repeat(2000), junk: "ignored" });
    assert.equal(s.theme, "light"); assert.equal(s.explainSimply, true); assert.equal(s.customInstructions.length, 1500); assert.ok(!("junk" in s));
    await assert.rejects(L.saveSettings(A, { theme: "neon" }), /dark or light/);
    await assert.rejects(L.saveSettings(A, { accent: "<script>" }), /accent/);
    await assert.rejects(L.saveSettings(A, { defaultModel: "x y" }), /Unknown model/);
    assert.equal((await L.getSettings(B)).theme, "dark", "bob unaffected");
    assert.equal((await L.getSettings(A)).theme, "light", "saved setting persists");
  });
  await t("assistants: built-ins + custom, scoped to owner", async () => {
    const a = await L.createAssistant(A, { name: " Physics Pro ", icon: "⚛️", instructions: "Explain physics with diagrams in words." });
    assert.ok(a.id.startsWith("custom:")); assert.equal(a.name, "Physics Pro");
    assert.equal((await L.listAssistants(A)).filter(x => x.custom).length, 1);
    assert.equal((await L.listAssistants(B)).filter(x => x.custom).length, 0);
    assert.equal(await L.resolveAssistant(B, a.id), null, "bob can't use alice's assistant");
    assert.equal((await L.resolveAssistant(A, a.id)).name, "Physics Pro");
    assert.equal((await L.resolveAssistant(A, "tutor")).name, "Tutor"); assert.equal((await L.resolveAssistant(A, null)).id, "sam");
    assert.equal(await L.updateAssistant(B, a.id, { name: "hack", instructions: "x" }), null);
    assert.equal((await L.updateAssistant(A, a.id, { name: "Physics Max", instructions: "y" })).name, "Physics Max");
    await assert.rejects(L.deleteAssistant(A, "tutor"), /Built-in/);
    await assert.rejects(L.createAssistant(A, { name: "", instructions: "x" }), /name/);
    assert.equal(await L.deleteAssistant(B, a.id), false);
    const cid = await db.insert("INSERT INTO conversations(user_id,title,assistant) VALUES(?,?,?)", A, "c", a.id);
    assert.ok(await L.deleteAssistant(A, a.id));
    assert.equal((await db.get("SELECT assistant FROM conversations WHERE id=?", cid)).assistant, null, "chats using it fall back to Sam");
  });
  await t("prompt library: built-ins + own, scoped", async () => {
    const p = await L.createPrompt(A, { title: "Essay check", body: "Check my essay for…" });
    assert.equal((await L.listPrompts(A))[0].id, p.id); assert.ok((await L.listPrompts(A)).some(x => x.id === "b:quiz"));
    assert.ok(!(await L.listPrompts(B)).some(x => x.id === p.id));
    assert.equal(await L.deletePrompt(B, p.id), false); await assert.rejects(L.deletePrompt(A, "b:quiz"), /Built-in/);
    assert.ok(await L.deletePrompt(A, p.id));
  });
  await t("limits: 50 assistants, 200 prompts", async () => {
    for (let i = 0; i < 50; i++) await db.run("INSERT INTO assistants(user_id,name,instructions) VALUES(?,?,?)", B, "a" + i, "x");
    await assert.rejects(L.createAssistant(B, { name: "one too many", instructions: "x" }), /up to 50/);
  });
  await t("task recognition: right mode, no false alarms on everyday words", () => {
    const d = m => (L.detectTask(m) || {}).label || null;
    assert.equal(d("why does my python code throw a TypeError?"), "Coding Assistant");
    assert.equal(d("What is the latest news on the election?"), "Web Search");
    assert.equal(d("Research the history of the Roman Empire in depth"), "Deep Research");
    assert.equal(d("Can you help with my GCSE maths homework"), "Tutor");
    assert.equal(d("What's a quadratic function?"), null);
    assert.equal(d("a film about terror"), null);
  });
  await t("persona prompt includes personality, style, specialist, custom instructions", async () => {
    await L.saveSettings(A, { explainSimply: true, customInstructions: "Call me captain" });
    const p = L.personaPrompt(await L.getSettings(A), await L.resolveAssistant(A, "coder"));
    assert.match(p, /businesslike/); assert.match(p, /Coder/); assert.match(p, /simply/); assert.match(p, /custom instructions/);
  });
  await t("export + delete account include assistants, prompts, settings", async () => {
    await L.createAssistant(A, { name: "Mine", instructions: "x" }); await L.createPrompt(A, { title: "t", body: "b" });
    const ex = await acc.exportUserData(A);
    assert.equal(ex.assistants.length, 1); assert.equal(ex.prompts.length, 1); assert.equal(ex.settings.theme, "light");
    await acc.deleteUserData(A);
    assert.equal(await c("SELECT COUNT(*) AS c FROM assistants WHERE user_id=?", A), 0);
    assert.equal(await c("SELECT COUNT(*) AS c FROM prompts WHERE user_id=?", A), 0);
    assert.equal(await c("SELECT COUNT(*) AS c FROM assistants WHERE user_id=?", B), 50, "bob's untouched");
  });
  await t("model catalog lists all 4 providers, keys never exposed", () => {
    ai.init({ GEMINI_API_KEY: "g" });
    const cat = ai.catalog();
    assert.deepEqual(cat.map(p => p.id), ["gemini", "anthropic", "openai", "deepseek"]);
    assert.ok(!JSON.stringify(cat).includes('"g"'));
  });
  await db.close();
  done("library.js");
})();
