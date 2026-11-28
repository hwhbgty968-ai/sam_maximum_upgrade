const assert = require("node:assert/strict");
const path = require("path");
const ai = require((process.argv[2] || require("path").join(__dirname, "..")) + "/lib/ai.js");
const G = "https://generativelanguage.googleapis.com/v1beta/openai/", A = "https://api.anthropic.com/v1/", D = "https://api.deepseek.com";
let pass = 0; const t = async (name, fn) => { try { await fn(); pass++; console.log("  ✅", name); } catch (e) { console.log("  ❌", name, "\n    ", e.message); process.exitCode = 1; } };
const quiet = { warn: () => {} };

(async () => {
  await t("no keys → not configured, placeholder keys ignored", () => {
    ai.init({ GEMINI_API_KEY: "replace_with_your_gemini_key" });
    assert.equal(ai.isConfigured(), false);
    assert.deepEqual(ai.routeCandidates({ message: "hi" }), []);
  });

  await t("only providers with keys are enabled; PROVIDER_ORDER respected", () => {
    process.env.PROVIDER_ORDER = "anthropic,gemini";
    assert.deepEqual(ai.init({ GEMINI_API_KEY: "g", ANTHROPIC_API_KEY: "a" }), ["gemini", "anthropic"]);
    const c = ai.routeCandidates({ speed: "balanced", message: "x" });
    assert.equal(c[0].provider, "anthropic"); assert.equal(c[1].provider, "gemini");
    delete process.env.PROVIDER_ORDER;
  });

  await t("old .env vars (AI_MODEL / OPENAI_MODEL) still work", () => {
    process.env.AI_MODEL = "gemini-legacy"; process.env.OPENAI_MODEL = "gpt-4.1-mini";
    ai.init({ GEMINI_API_KEY: "g", OPENAI_API_KEY: "o" });
    const s = ai.providerStatus();
    assert.equal(s.gemini.models.balanced, "gemini-legacy"); assert.equal(s.openai.models.balanced, "gpt-4.1-mini");
    delete process.env.AI_MODEL; delete process.env.OPENAI_MODEL;
  });

  await t("tier routing: auto picks fast/balanced/deep sensibly", () => {
    assert.equal(ai.chooseTier("auto", { message: "hey sam" }), "fast");
    assert.equal(ai.chooseTier("auto", { message: "What is photosynthesis and why does it matter?" }), "balanced");
    assert.equal(ai.chooseTier("auto", { mode: "research", message: "x" }), "deep");
    assert.equal(ai.chooseTier("auto", { mode: "coding", message: "debug ".repeat(400) }), "deep");
    assert.equal(ai.chooseTier("deep", { message: "hi" }), "deep");
  });

  await t("model discovery swaps a missing model for the closest real one", async () => {
    global.FAKE = { [G]: { models: ["models/gemini-3.8-flash", "models/gemini-3.7-flash", "models/gemini-3.5-flash-lite", "models/gemini-3.1-pro-preview", "models/text-embedding-004", "models/gemini-3.1-flash-tts"] } };
    process.env.GEMINI_MODEL_DEEP = "gemini-does-not-exist-pro";
    ai.init({ GEMINI_API_KEY: "g" }); await ai.verifyModels(quiet);
    const s = ai.providerStatus().gemini;
    assert.equal(s.models.fast, "gemini-3.5-flash-lite"); assert.equal(s.verified.fast, true);
    assert.equal(s.models.deep, "gemini-3.1-pro-preview"); assert.equal(s.replaced.deep, "gemini-does-not-exist-pro");
    delete process.env.GEMINI_MODEL_DEEP;
  });

  await t("model list failure doesn't disable the provider", async () => {
    global.FAKE = { [G]: { listError: "403 nope" } };
    ai.init({ GEMINI_API_KEY: "g" }); await ai.verifyModels(quiet);
    assert.equal(ai.providerStatus().gemini.reachable, false);
    assert.equal(ai.routeCandidates({ message: "hi" }).length, 1);
  });

  await t("streaming works and uses the right token param per provider", async () => {
    global.FAKE = { [G]: { reply: () => "Hello Ryder, this is Sam." }, openai: {} }; global.CALLS = [];
    ai.init({ GEMINI_API_KEY: "g", OPENAI_API_KEY: "o" });
    let out = "";
    const r = await ai.stream({ messages: [{ role: "user", content: "hi" }], candidates: ai.routeCandidates({ speed: "fast", message: "hi" }), onDelta: d => out += d });
    assert.equal(out, "Hello Ryder, this is Sam."); assert.equal(r.provider, "gemini");
    assert.ok("max_tokens" in CALLS[0].body);
    await ai.complete({ messages: [], candidates: [{ provider: "openai", model: "gpt-x", tier: "balanced" }] });
    assert.ok("max_completion_tokens" in CALLS[1].body && !("max_tokens" in CALLS[1].body));
  });

  await t("fallback: provider down before streaming → next provider answers", async () => {
    global.FAKE = { [G]: { fail: "503 overloaded" }, [A]: { reply: () => "Claude here" } };
    ai.init({ GEMINI_API_KEY: "g", ANTHROPIC_API_KEY: "a" });
    let out = ""; const origWarn = console.warn; console.warn = () => {};
    const r = await ai.stream({ messages: [], candidates: ai.routeCandidates({ message: "hello there friend?" }), onDelta: d => out += d });
    console.warn = origWarn;
    assert.equal(r.provider, "anthropic"); assert.equal(out, "Claude here");
  });

  await t("no fallback mid-stream (never splices two models' answers)", async () => {
    global.FAKE = { [G]: { failMidStream: true, reply: () => "abcdefghijklmnop" }, [A]: { reply: () => "other" } };
    ai.init({ GEMINI_API_KEY: "g", ANTHROPIC_API_KEY: "a" });
    let out = "";
    await assert.rejects(ai.stream({ messages: [], candidates: ai.routeCandidates({ message: "hi?" }), onDelta: d => out += d }), /mid-stream/);
    assert.equal(out, "abcdefgh");
  });

  await t("Stop: abort keeps partial text and doesn't fall back", async () => {
    global.FAKE = { [G]: { delay: 15, reply: () => "one two three four five six seven" }, [A]: {} };
    ai.init({ GEMINI_API_KEY: "g", ANTHROPIC_API_KEY: "a" });
    const ctl = new AbortController(); let out = "";
    setTimeout(() => ctl.abort(), 50);
    const err = await ai.stream({ messages: [], candidates: ai.routeCandidates({ message: "hi?" }), signal: ctl.signal, onDelta: d => out += d }).catch(e => e);
    assert.ok(err instanceof Error); assert.ok(out.length > 0 && out.length < 33); assert.equal(err.partialText, out);
  });

  await t("vision requests skip DeepSeek (text-only)", () => {
    ai.init({ DEEPSEEK_API_KEY: "d", GEMINI_API_KEY: "g" });
    const c = ai.routeCandidates({ needVision: true, message: "x" });
    assert.ok(c.length && c.every(x => x.provider !== "deepseek"));
  });

  await t("explicit model choice goes first, others stay as fallback", () => {
    ai.init({ GEMINI_API_KEY: "g", ANTHROPIC_API_KEY: "a" });
    const c = ai.routeCandidates({ model: "anthropic:claude-opus-5-5", speed: "fast", message: "x" });
    assert.equal(c[0].model, "claude-opus-5-5"); assert.ok(c.length >= 2);
  });

  await t("Sam Council: asks every provider, chair combines, one failure tolerated", async () => {
    global.FAKE = { [G]: { reply: b => b.messages[0].content.includes("chairing") ? "COMBINED" : "gemini says 4" }, [A]: { reply: () => "claude says 4" }, [D]: { fail: "down" } };
    global.CALLS = []; const origWarn = console.warn; console.warn = () => {};
    ai.init({ GEMINI_API_KEY: "g", ANTHROPIC_API_KEY: "a", DEEPSEEK_API_KEY: "d" });
    const statuses = []; let out = "";
    const r = await ai.council({ messages: [{ role: "system", content: "You are Sam" }, { role: "user", content: "2+2?" }], question: "2+2?", onStatus: s => statuses.push(s), onDelta: d => out += d });
    console.warn = origWarn;
    assert.equal(out, "COMBINED"); assert.equal(r.members.length, 2);
    assert.match(statuses[0], /Consulting 3 models/); assert.match(statuses[1], /Combining 2 answers/);
    const chairCall = CALLS.find(c => c.body.stream);
    assert.match(chairCall.body.messages[1].content, /gemini says 4[\s\S]*claude says 4/);
  });

  await t("Council with a single provider uses its different tiers", () => {
    global.FAKE = {}; ai.init({ GEMINI_API_KEY: "g" });
    const models = ai.listModels().filter(m => m.id !== "auto");
    assert.equal(models.length, 3);
  });

  console.log(`\nai.js: ${pass} passed`);
})();
