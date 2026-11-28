const assert = require("node:assert/strict");
const path = require("path");
const ai = require((process.argv[2] || require("path").join(__dirname, "..")) + "/lib/ai.js");
const FakeOpenAI = require("./_fake-openai");
const init = env => ai.init(env, o => new FakeOpenAI(o)); // never touches the network
const G = "https://generativelanguage.googleapis.com/v1beta/openai/", A = "https://api.anthropic.com/v1/", D = "https://api.deepseek.com";
let pass = 0; const t = async (name, fn) => { try { await fn(); pass++; console.log("  ✅", name); } catch (e) { console.log("  ❌", name, "\n    ", e.message); process.exitCode = 1; } };
const quiet = { warn: () => {} };

(async () => {
  await t("no keys → not configured, placeholder keys ignored", () => {
    init({ GEMINI_API_KEY: "replace_with_your_gemini_key" });
    assert.equal(ai.isConfigured(), false);
    assert.deepEqual(ai.routeCandidates({ message: "hi" }), []);
  });

  await t("only providers with keys are enabled; PROVIDER_ORDER respected", () => {
    process.env.PROVIDER_ORDER = "anthropic,gemini";
    assert.deepEqual(init({ GEMINI_API_KEY: "g", ANTHROPIC_API_KEY: "a" }), ["gemini", "anthropic"]);
    const c = ai.routeCandidates({ speed: "balanced", message: "x" });
    assert.equal(c[0].provider, "anthropic"); assert.equal(c[1].provider, "gemini");
    delete process.env.PROVIDER_ORDER;
  });

  await t("old .env vars (AI_MODEL / OPENAI_MODEL) still work", () => {
    process.env.AI_MODEL = "gemini-legacy"; process.env.OPENAI_MODEL = "gpt-4.1-mini";
    init({ GEMINI_API_KEY: "g", OPENAI_API_KEY: "o" });
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
    global.FAKE = { [G]: { models: ["models/gemini-3.5-flash", "models/gemini-3.1-flash-lite", "models/gemini-3.1-pro-preview", "models/text-embedding-004", "models/gemini-3.1-flash-tts"] } };
    process.env.GEMINI_MODEL_DEEP = "gemini-does-not-exist-pro";
    init({ GEMINI_API_KEY: "g" }); await ai.verifyModels(quiet);
    const s = ai.providerStatus().gemini;
    assert.equal(s.models.fast, "gemini-3.1-flash-lite"); assert.equal(s.verified.fast, true);
    assert.equal(s.models.balanced, "gemini-3.5-flash"); assert.equal(s.verified.balanced, true);
    assert.equal(s.models.deep, "gemini-3.1-pro-preview"); assert.equal(s.replaced.deep, "gemini-does-not-exist-pro");
    delete process.env.GEMINI_MODEL_DEEP;
  });

  await t("model list failure doesn't disable the provider", async () => {
    global.FAKE = { [G]: { listError: "403 nope" } };
    init({ GEMINI_API_KEY: "g" }); await ai.verifyModels(quiet);
    assert.equal(ai.providerStatus().gemini.reachable, false);
    assert.equal(ai.providerStatus().gemini.key, "unknown", "an unclear listing error doesn't mark the key bad");
    assert.ok(ai.routeCandidates({ message: "hi" }).length >= 1);
  });

  await t("streaming works and uses the right token param per provider", async () => {
    global.FAKE = { [G]: { reply: () => "Hello Ryder, this is Sam." }, openai: {} }; global.CALLS = [];
    init({ GEMINI_API_KEY: "g", OPENAI_API_KEY: "o" });
    let out = "";
    const r = await ai.stream({ messages: [{ role: "user", content: "hi" }], candidates: ai.routeCandidates({ speed: "fast", message: "hi" }), onDelta: d => out += d });
    assert.equal(out, "Hello Ryder, this is Sam."); assert.equal(r.provider, "gemini");
    assert.ok("max_tokens" in CALLS[0].body);
    await ai.complete({ messages: [], candidates: [{ provider: "openai", model: "gpt-x", tier: "balanced" }] });
    assert.ok("max_completion_tokens" in CALLS[1].body && !("max_tokens" in CALLS[1].body));
  });

  await t("fallback: provider down before streaming → next provider answers", async () => {
    global.FAKE = { [G]: { fail: "503 overloaded" }, [A]: { reply: () => "Claude here" } };
    init({ GEMINI_API_KEY: "g", ANTHROPIC_API_KEY: "a" });
    let out = ""; const origWarn = console.warn; console.warn = () => {};
    const r = await ai.stream({ messages: [], candidates: ai.routeCandidates({ message: "hello there friend?" }), onDelta: d => out += d });
    console.warn = origWarn;
    assert.equal(r.provider, "anthropic"); assert.equal(out, "Claude here");
  });

  await t("no fallback mid-stream (never splices two models' answers)", async () => {
    global.FAKE = { [G]: { failMidStream: true, reply: () => "abcdefghijklmnop" }, [A]: { reply: () => "other" } };
    init({ GEMINI_API_KEY: "g", ANTHROPIC_API_KEY: "a" });
    let out = "";
    await assert.rejects(ai.stream({ messages: [], candidates: ai.routeCandidates({ message: "hi?" }), onDelta: d => out += d }), /mid-stream/);
    assert.equal(out, "abcdefgh");
  });

  await t("Stop: abort keeps partial text and doesn't fall back", async () => {
    global.FAKE = { [G]: { delay: 15, reply: () => "one two three four five six seven" }, [A]: {} };
    init({ GEMINI_API_KEY: "g", ANTHROPIC_API_KEY: "a" });
    const ctl = new AbortController(); let out = "";
    setTimeout(() => ctl.abort(), 50);
    const err = await ai.stream({ messages: [], candidates: ai.routeCandidates({ message: "hi?" }), signal: ctl.signal, onDelta: d => out += d }).catch(e => e);
    assert.ok(err instanceof Error); assert.ok(out.length > 0 && out.length < 33); assert.equal(err.partialText, out);
  });

  await t("vision requests skip DeepSeek (text-only)", () => {
    init({ DEEPSEEK_API_KEY: "d", GEMINI_API_KEY: "g" });
    const c = ai.routeCandidates({ needVision: true, message: "x" });
    assert.ok(c.length && c.every(x => x.provider !== "deepseek"));
  });

  await t("explicit model choice goes first, others stay as fallback", () => {
    init({ GEMINI_API_KEY: "g", ANTHROPIC_API_KEY: "a" });
    const c = ai.routeCandidates({ model: "anthropic:claude-opus-5-5", speed: "fast", message: "x" });
    assert.equal(c[0].model, "claude-opus-5-5"); assert.ok(c.length >= 2);
  });

  await t("Sam Council: asks every provider, chair combines, one failure tolerated", async () => {
    global.FAKE = { [G]: { reply: b => b.messages[0].content.includes("chairing") ? "COMBINED" : "gemini says 4" }, [A]: { reply: () => "claude says 4" }, [D]: { fail: "down" } };
    global.CALLS = []; const origWarn = console.warn; console.warn = () => {};
    init({ GEMINI_API_KEY: "g", ANTHROPIC_API_KEY: "a", DEEPSEEK_API_KEY: "d" });
    const statuses = []; let out = "";
    const r = await ai.council({ messages: [{ role: "system", content: "You are Sam" }, { role: "user", content: "2+2?" }], question: "2+2?", onStatus: s => statuses.push(s), onDelta: d => out += d });
    console.warn = origWarn;
    assert.equal(out, "COMBINED"); assert.equal(r.members.length, 2);
    assert.match(statuses[0], /Consulting 3 models/); assert.match(statuses[1], /Combining 2 answers/);
    const chairCall = CALLS.find(c => c.body.stream);
    assert.match(chairCall.body.messages[1].content, /gemini says 4[\s\S]*claude says 4/);
  });

  await t("Council with a single provider uses its different tiers", () => {
    global.FAKE = {}; init({ GEMINI_API_KEY: "g" });
    const models = ai.listModels().filter(m => m.id !== "auto");
    assert.equal(models.length, 3);
  });

  // ---------------- Stage 3: provider diagnostics ----------------
  const mk = (status, message, extra = {}) => Object.assign(new Error(message), { status, ...extra });
  await t("errors are classified into plain categories", () => {
    const c = ai.classifyError;
    assert.equal(c(mk(401, "401 Incorrect API key provided: Sam_AI_GPT")), "invalid_key");
    assert.equal(c(mk(400, "400 API key not valid. Please pass a valid API key.")), "invalid_key", "Gemini's bad-key error is a 400");
    assert.equal(c(mk(403, "403 Permission denied")), "invalid_key");
    assert.equal(c(mk(403, "403 billing account disabled")), "quota");
    assert.equal(c(mk(404, "404 models/gemini-9 is not found")), "model_not_found");
    assert.equal(c(mk(400, "400 The model gpt-x does not exist")), "model_not_found");
    assert.equal(c(mk(429, "429 Quota exceeded for metric: requests per minute")), "rate_limit");
    assert.equal(c(mk(429, "429 You exceeded your current quota ... limit: 0, model: gemini-3.1-pro")), "quota", "free tier has no access to this model");
    assert.equal(c(mk(429, "429 insufficient_quota")), "quota");
    assert.equal(c(mk(402, "402 payment required")), "quota");
    assert.equal(c(mk(503, "503 status code (no body)")), "outage");
    assert.equal(c(mk(529, "529 Overloaded")), "outage");
    assert.equal(c(mk(undefined, "Connection error.", { name: "APIConnectionError" })), "network");
    assert.equal(c(mk(undefined, "Request timed out.", { name: "APIConnectionTimeoutError" })), "network");
    assert.equal(c(mk(400, "400 context too long")), "bad_request");
    assert.equal(c(new TypeError("x is not a function")), "unknown");
  });

  await t("your friend's case: Gemini Deep overloaded + OpenAI key bad → Sam answers with another Gemini model", async () => {
    const O = "openai";
    global.FAKE = { [G]: { failModels: { "gemini-3.1-pro-preview": { status: 503, message: "503 status code (no body)" } }, reply: b => "answer from " + b.model }, [O]: { fail: "401 Incorrect API key provided: Sam_AI_GPT", status: 401 } };
    global.CALLS = []; const w = console.warn; console.warn = () => {};
    init({ GEMINI_API_KEY: "g", OPENAI_API_KEY: "Sam_AI_GPT" });
    let out = "";
    const r = await ai.stream({ messages: [], candidates: ai.routeCandidates({ speed: "deep", message: "explain" }), onDelta: d => out += d });
    console.warn = w;
    assert.equal(r.provider, "gemini"); assert.equal(r.model, "gemini-3.5-flash", "fell back to Gemini's Balanced model");
    assert.equal(out, "answer from gemini-3.5-flash");
    assert.deepEqual(r.attempts.map(a => a.kind), ["outage", "invalid_key"]);
    assert.equal(CALLS.filter(c => c.base === O).length, 1, "after the key was rejected, no more OpenAI calls in this request");
    assert.ok(ai.routeCandidates({ speed: "deep", message: "x" }).every(c => c.provider !== "openai"), "OpenAI is skipped from now on");
    assert.equal(ai.routeCandidates({ speed: "deep", message: "x" }).at(-1).model, "gemini-3.1-pro-preview", "the overloaded model goes to the back of the queue for a while");
  });

  await t("when everything fails, the message names the real cause (not the backup's bad key)", async () => {
    global.FAKE = { [G]: { fail: "503 status code (no body)", status: 503 }, openai: { fail: "401 Incorrect API key provided: Sam_AI_GPT", status: 401 } };
    const w = console.warn; console.warn = () => {};
    init({ GEMINI_API_KEY: "g", OPENAI_API_KEY: "Sam_AI_GPT" });
    const err = await ai.stream({ messages: [], candidates: ai.routeCandidates({ speed: "deep", message: "x" }), onDelta: () => {} }).catch(e => e);
    console.warn = w;
    assert.equal(err.kind, "outage");
    const user = ai.describeFailure(err), adm = ai.describeFailure(err, { isAdmin: true });
    assert.match(user, /Gemini is overloaded or having problems right now/);
    assert.ok(!/API key/i.test(user), "ordinary users aren't told about the backup's key");
    assert.match(adm, /Admin details: .*gemini\/gemini-3\.1-pro-preview → Provider overloaded or down \(503\).*openai\/gpt-6-astra → Invalid API key \(401\)/);
    assert.ok(!/Sam_AI_GPT/.test(adm + err.message), "the key value never appears in messages or logs");
  });

  await t("only a bad key left → the message says the admin must fix that provider's key", async () => {
    global.FAKE = { openai: { fail: "401 Incorrect API key provided: sk-proj-abcdefghijklmnop", status: 401 } };
    const w = console.warn; console.warn = () => {};
    init({ OPENAI_API_KEY: "sk-proj-abcdefghijklmnop" });
    const err = await ai.complete({ messages: [], candidates: ai.routeCandidates({ message: "x" }) }).catch(e => e);
    console.warn = w;
    assert.equal(err.kind, "invalid_key"); assert.match(ai.describeFailure(err), /The site admin needs to check the OpenAI API key/);
    assert.ok(!/sk-proj-abcdefghijklmnop/.test(err.message));
    assert.deepEqual(ai.routeCandidates({ message: "x" }), [], "no usable provider left");
  });

  await t("a key rejected at startup (model list 401) keeps the provider out of routing, pickers and the council", async () => {
    global.FAKE = { [G]: { models: ["gemini-3.1-flash-lite", "gemini-3.5-flash", "gemini-3.1-pro-preview"] }, openai: { listError: "401 Incorrect API key provided: Sam_AI_GPT", listStatus: 401 } };
    init({ GEMINI_API_KEY: "g", OPENAI_API_KEY: "Sam_AI_GPT" }); await ai.verifyModels(quiet);
    assert.equal(ai.providerStatus().openai.key, "invalid"); assert.equal(ai.providerStatus().gemini.key, "ok");
    assert.ok(ai.routeCandidates({ model: "openai:gpt-6-astra", message: "x" }).every(c => c.provider === "gemini"), "even an explicit pick is skipped");
    const lm = ai.listModels().filter(m => m.provider === "openai");
    assert.ok(lm.length && lm.every(m => m.available === false && m.unavailableReason === "Invalid API key"));
    assert.equal(ai.catalog().find(p => p.id === "openai").keyStatus, "invalid");
    assert.equal(ai.pickMembers(["openai:gpt-6-astra"]), null);
  });

  await t("live test: reports each model; a bad key stops after one call; 'no quota' models are skipped until the next test", async () => {
    global.FAKE = { [G]: { failModels: { "gemini-3.1-pro-preview": { status: 429, message: "429 You exceeded your current quota ... limit: 0" } } }, openai: { fail: "401 Incorrect API key", status: 401 } };
    global.CALLS = []; const w = console.warn; console.warn = () => {};
    init({ GEMINI_API_KEY: "g", OPENAI_API_KEY: "bad" });
    const run = await ai.testProviders();
    console.warn = w;
    const g = run.results.gemini.models;
    assert.deepEqual(g.map(m => m.ok), [true, true, false]); assert.equal(g[2].kind, "quota");
    assert.equal(run.results.openai.key, "invalid"); assert.equal(CALLS.filter(c => c.base === "openai").length, 1, "one call is enough to know the key is bad");
    assert.equal(run.results.anthropic.key, "missing");
    assert.ok(!ai.routeCandidates({ speed: "deep", message: "x" }).some(c => c.model === "gemini-3.1-pro-preview" && ai.routeCandidates({ speed: "deep", message: "x" })[0] === c), "Pro isn't tried first any more");
    assert.equal(ai.routeCandidates({ speed: "deep", message: "x" })[0].model, "gemini-3.5-flash");
    assert.equal(ai.listModels().find(m => m.id === "gemini:gemini-3.1-pro-preview").available, false);
    // after a restart, the stored result is restored
    init({ GEMINI_API_KEY: "g" }); ai.loadTestResults(JSON.parse(JSON.stringify(run)));
    assert.equal(ai.routeCandidates({ speed: "deep", message: "x" })[0].model, "gemini-3.5-flash");
    assert.equal(ai.providerStatus().gemini.cooling["gemini-3.1-pro-preview"].untilTest, true);
  });

  await t("a model that doesn't exist is skipped; an outage only cools down briefly", async () => {
    global.FAKE = { [G]: { failModels: { "gemini-3.5-flash": { status: 404, message: "404 model not found" } } } };
    const w = console.warn; console.warn = () => {};
    init({ GEMINI_API_KEY: "g" });
    const r = await ai.complete({ messages: [], candidates: ai.routeCandidates({ speed: "balanced", message: "x" }) });
    console.warn = w;
    assert.equal(r.model, "gemini-3.1-flash-lite");
    assert.ok(!ai.routeCandidates({ speed: "balanced", message: "x" }).some(c => c.model === "gemini-3.5-flash"));
    const st = ai.providerStatus().gemini;
    assert.equal(st.failures.model_not_found, 1); assert.equal(st.lastError.kind, "model_not_found");
  });

  console.log(`\nai.js: ${pass} passed`);
})();
