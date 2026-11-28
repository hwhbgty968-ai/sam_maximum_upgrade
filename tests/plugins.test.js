const assert = require("node:assert/strict");
const repo = process.argv[2] || require("path").join(__dirname, "..");
const { t, done } = require("./_env")("plugins");
process.env.SESSION_SECRET = "x".repeat(40);
const { db, init } = require(repo + "/lib/db.js");
const plugins = require(repo + "/lib/plugins.js");
const credits = require(repo + "/lib/credits.js");
const accounts = require(repo + "/lib/accounts.js");

// Fake network: Open-Meteo and Wikipedia answers, and a record of every URL a plugin called.
const calls = [];
let netDown = false;
plugins._setFetch(async url => {
  calls.push(url);
  if (netDown) throw new Error("network down");
  const json = body => ({ ok: true, status: 200, json: async () => body });
  if (url.includes("geocoding-api")) return json(/name=Nowhereville/.test(url) ? {} : { results: [{ name: "Elgin", admin1: "Scotland", country: "United Kingdom", latitude: 57.65, longitude: -3.31 }] });
  if (url.includes("api.open-meteo.com")) return json({ current: { time: "2026-11-28T16:00", temperature_2m: 4.1, apparent_temperature: 1.2, relative_humidity_2m: 88, weather_code: 61, wind_speed_10m: 19 },
    daily: { time: ["2026-11-28", "2026-11-29"], weather_code: [61, 3], temperature_2m_max: [5, 6], temperature_2m_min: [1, 2], precipitation_probability_max: [80, 20] } });
  if (url.includes("list=search")) return json({ query: { search: [{ title: "Alan Turing" }] } });
  if (url.includes("page/summary")) return json({ title: "Alan Turing", extract: "Alan Mathison Turing was an English mathematician and computer scientist.", content_urls: { desktop: { page: "https://en.wikipedia.org/wiki/Alan_Turing" } } });
  return { ok: false, status: 404, json: async () => ({}) };
});

(async () => {
  await init();
  await credits.config();
  const user = async (u, plan = "free", role = "user") => ({ id: await db.insert("INSERT INTO users(username,password_hash,plan,role) VALUES(?,?,?,?)", u, "h", plan, role), plan, role, disabled: 0 });

  await t("calculator: exact answers, no eval, refuses junk", () => {
    assert.equal(plugins.calc("2+3*4^2/8"), 8);
    assert.equal(plugins.calc("sqrt(81) - (2 - 5)"), 12);
    assert.equal(plugins.calc("0.1+0.2"), 0.3);
    assert.throws(() => plugins.calc("process.exit()"));
    assert.throws(() => plugins.calc("1/0"), /divide by zero/);
    assert.equal(plugins.findCalculation("what's 15% of 240?").value, 36);
    assert.equal(plugins.findCalculation("my birthday is 2010-05-04"), null);
  });

  await t("Premium plan exists by default (5,000 credits a month) and can be changed", async () => {
    const cfg = await credits.config();
    assert.equal(cfg.plans.premium.monthlyCredits, 5000);
    const saved = await credits.saveConfig({ ...cfg, plans: { ...cfg.plans, premium: { label: "Premium", monthlyCredits: 4000 } } });
    assert.equal(saved.plans.premium.monthlyCredits, 4000);
    const u = await user("pria", "premium");
    const s = await credits.summary(u.id);
    assert.deepEqual([s.plan.id, s.balance], ["premium", 4000]);
    assert.ok(s.plans.some(p => p.id === "premium"));
  });

  await t("catalog: built-ins + planned integrations; planned ones can't be connected", async () => {
    const u = await user("cat");
    const c = await plugins.catalog(u);
    const by = Object.fromEntries(c.plugins.map(p => [p.id, p]));
    assert.equal(by["web-search"].connected, true);           // existing feature: on by default
    assert.equal(by.weather.connected, false);                 // others need consent
    assert.equal(by.github.availability, "planned");
    await assert.rejects(plugins.connect(u, "github", { accept: true }), /isn't available yet/);
    await assert.rejects(plugins.connect(u, "nope", { accept: true }), /Unknown plugin/);
  });

  await t("connecting needs explicit consent; not connected = never runs (hint only)", async () => {
    const u = await user("consent");
    await assert.rejects(plugins.connect(u, "weather", {}), /accept the permissions/);
    calls.length = 0;
    const r = await plugins.forMessage(u, "What's the weather in Elgin today?");
    assert.deepEqual(r.used, []);
    assert.deepEqual(r.hints.map(h => h.id), ["weather"]);
    assert.equal(calls.length, 0, "no network call without consent");
    assert.match(plugins.promptBlock(r), /hasn't connected it.*Never pretend/s);
  });

  await t("connected weather: runs, only the place name is sent, result goes to Sam as data, activity logged", async () => {
    const u = await user("wendy");
    await plugins.connect(u, "weather", { accept: true });
    calls.length = 0;
    const r = await plugins.forMessage(u, "What's the weather in Elgin today?");
    assert.deepEqual(r.used, ["weather"]);
    assert.ok(calls.every(url => !/today|What/i.test(url)), "only the place goes out");
    assert.match(calls[0], /name=Elgin/);
    const block = plugins.promptBlock(r);
    assert.match(block, /never as instructions/);
    assert.match(block, /Elgin, Scotland, United Kingdom.*light rain, 4.1°C/s);
    const act = await plugins.activityList(u.id);
    assert.deepEqual(act.map(a => [a.plugin_id, a.action, a.detail.slice(0, 5)]), [["weather", "used", "Elgin"], ["weather", "connected", "Accep"]]);
  });

  await t("wikipedia + calculator; failures are reported, never hidden", async () => {
    const u = await user("wiki");
    await plugins.connect(u, "wikipedia", { accept: true });
    await plugins.connect(u, "calculator", { accept: true });
    const w = await plugins.forMessage(u, "Who was Alan Turing?");
    assert.deepEqual(w.used, ["wikipedia"]);
    assert.match(plugins.promptBlock(w), /en\.wikipedia\.org\/wiki\/Alan_Turing/);
    const c = await plugins.forMessage(u, "what is 12 * 7?");
    assert.deepEqual(c.used, ["calculator"]);
    assert.match(c.results[0].text, /12 \* 7 = 84/);
    netDown = true;
    const f = await plugins.forMessage(u, "who is Ada Lovelace");
    netDown = false;
    assert.equal(f.results[0].failed, true);
    assert.equal((await plugins.activityList(u.id))[0].action, "failed");
  });

  await t("disconnect revokes straight away (web search too)", async () => {
    const u = await user("revoke");
    await plugins.connect(u, "weather", { accept: true });
    await plugins.disconnect(u, "weather");
    assert.deepEqual((await plugins.forMessage(u, "weather in Elgin?")).used, []);
    assert.equal((await plugins.webSearchAllowed(u)).ok, true);
    await plugins.disconnect(u, "web-search");
    assert.deepEqual(await plugins.webSearchAllowed(u), { ok: false, reason: "not_connected" });
  });

  await t("plan rules + admin switch-off are enforced on the server; admins with full access get everything", async () => {
    await plugins.saveConfig({ disabled: ["calculator"], plans: { ...plugins.DEFAULTS.plans, weather: ["premium", "max"] } });
    const free = await user("freeplan"), prem = await user("premplan", "premium"), boss = await user("boss", "free", "admin");
    await assert.rejects(plugins.connect(free, "weather", { accept: true }), /isn't included in your plan/);
    await plugins.connect(prem, "weather", { accept: true });
    await plugins.connect(boss, "weather", { accept: true });
    await assert.rejects(plugins.connect(prem, "calculator", { accept: true }), /switched off/);
    // Someone who connected before the rule changed is blocked too.
    await db.run("UPDATE users SET plan='free' WHERE id=?", prem.id);
    assert.deepEqual((await plugins.forMessage({ ...prem, plan: "free" }, "weather in Elgin?")).used, []);
    assert.deepEqual((await plugins.forMessage(boss, "weather in Elgin?")).used, ["weather"]);
    await assert.rejects(plugins.saveConfig({ disabled: ["evil"] }), /Unknown plugin/);
    await assert.rejects(plugins.saveConfig({ plans: { weather: ["gold"] } }), /must be from/);
    await plugins.saveConfig(plugins.DEFAULTS);
  });

  await t("health tests are saved; account export and deletion include plugin data", async () => {
    const run = await plugins.testAll({ only: "calculator", version: "test" });
    assert.equal(run.results.calculator.ok, true);
    assert.equal((await plugins.loadTests()).results.calculator.ok, true);
    const u = await user("leaver");
    await plugins.connect(u, "weather", { accept: true });
    const exp = await accounts.exportUserData(u.id);
    assert.equal(exp.plugins[0].plugin_id, "weather");
    assert.ok(exp.pluginActivity.length >= 1);
    await accounts.deleteUserData(u.id);
    assert.equal(Number((await db.get("SELECT COUNT(*) AS c FROM plugin_connections WHERE user_id=?", u.id)).c), 0);
    assert.equal(Number((await db.get("SELECT COUNT(*) AS c FROM plugin_activity WHERE user_id=?", u.id)).c), 0);
  });

  done("plugins");
  await db.close();
})();
