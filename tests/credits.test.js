const assert = require("node:assert/strict");
const repo = process.argv[2] || require("path").join(__dirname, "..");
const { t, done } = require("./_env")("credits");
process.env.SESSION_SECRET = "x".repeat(40);
const { db, init } = require(repo + "/lib/db.js");
const credits = require(repo + "/lib/credits.js");

(async () => {
  await init();
  const user = (u, plan = "free") => db.insert("INSERT INTO users(username,password_hash,plan) VALUES(?,?,?)", u, "h", plan);
  const cfg = await credits.config();
  const fast = { provider: "gemini", model: "gemini-3.1-flash-lite", tier: "fast" }, bal = { provider: "gemini", model: "gemini-3.5-flash", tier: "balanced" };
  const deep = { provider: "gemini", model: "gemini-3.1-pro-preview", tier: "deep" }, opus = { provider: "anthropic", model: "claude-opus-5-5", tier: "deep" };

  await t("defaults: Free = 1,000 a month; Max = Unlimited Sam Credits with every feature included", () => {
    assert.equal(cfg.plans.free.monthlyCredits, 1000);
    assert.equal(cfg.plans.max.unlimited, true);
    assert.deepEqual(cfg.plans.max.eligible.sort(), Object.keys(credits.FEATURES).sort());
    assert.equal(cfg.creditName, "Sam Credits");
    assert.match(cfg.maxNote, /isn't a promise of unlimited access to every outside AI model/);
  });

  await t("published prices: per model, else per speed; web +1, images +2; council = members + chair", () => {
    assert.equal(credits.quote(cfg, { feature: "chat", candidates: [fast] }), 1);
    assert.equal(credits.quote(cfg, { feature: "chat", candidates: [bal] }), 5);
    assert.equal(credits.quote(cfg, { feature: "chat", candidates: [opus] }), 11);
    assert.equal(credits.quote(cfg, { feature: "chat", candidates: [{ provider: "x", model: "unknown-deep", tier: "deep" }] }), 12);
    assert.equal(credits.quote(cfg, { feature: "web", candidates: [bal] }), 6);
    assert.equal(credits.quote(cfg, { feature: "images", candidates: [bal] }), 7);
    assert.equal(credits.quote(cfg, { feature: "council", members: [fast, bal, deep], chair: [bal] }), 1 + 5 + 6 + 5);
  });

  await t("Free: allowance appears as a visible row, the answer is charged, history shows it", async () => {
    const u = await user("freddie");
    const c = await credits.begin(u, { feature: "chat", quoteCredits: 5 });
    assert.equal(c.ok, true);
    const bill = await c.finish({ charged: 5, model: "gemini-3.5-flash", tier: "balanced", description: "Chat · gemini-3.5-flash" });
    assert.deepEqual([bill.charged, bill.balance], [5, 995]);
    const h = await credits.history(u);
    assert.deepEqual(h.map(r => [r.kind, r.delta]), [["use", -5], ["allowance", 1000]]);
    assert.equal(h[0].description, "Chat · gemini-3.5-flash");
    const s = await credits.summary(u);
    assert.deepEqual([s.balance, s.usedThisMonth, s.plan.label, s.plan.unlimited], [995, 5, "Free", false]);
  });

  await t("never charged more than the quote; a cheaper fallback is charged less", async () => {
    const u = await user("quoted");
    const a = await credits.begin(u, { feature: "chat", quoteCredits: 1 });
    assert.equal((await a.finish({ charged: 6, model: "gemini-3.1-pro-preview", tier: "deep" })).charged, 1);
    const b = await credits.begin(u, { feature: "chat", quoteCredits: 6 });
    assert.equal((await b.finish({ charged: 5, model: "gemini-3.5-flash", tier: "balanced" })).charged, 5);
    assert.equal((await credits.summary(u)).balance, 994);
  });

  await t("failed answers cost nothing (cancel removes the hold)", async () => {
    const u = await user("unlucky");
    const c = await credits.begin(u, { feature: "chat", quoteCredits: 12 });
    assert.equal((await credits.summary(u)).balance, 988, "held while answering");
    await c.cancel();
    assert.equal((await credits.summary(u)).balance, 1000);
    assert.ok(!(await credits.history(u)).some(r => r.kind === "hold" || r.kind === "use"));
  });

  await t("out of credits → clear refusal with the balance, the reset date and the cheaper option", async () => {
    const u = await user("spender");
    await credits.grant(u, -996, "test");
    const c = await credits.begin(u, { feature: "chat", quoteCredits: 5 });
    assert.equal(c.ok, false); assert.equal(c.status, 402); assert.equal(c.code, "NO_CREDITS");
    assert.match(c.message, /needs 5 Sam Credits and you have 4 left this month\. Your allowance resets on 1 \w+\. Switching speed to Fast costs 1\./);
    assert.equal((await credits.begin(u, { feature: "chat", quoteCredits: 1 })).ok, true, "a 1-credit Fast answer still works");
  });

  await t("parallel messages can't spend more than the balance", async () => {
    const u = await user("racer");
    await credits.grant(u, -990, "test"); // 10 left
    const all = await Promise.all(Array.from({ length: 6 }, () => credits.begin(u, { feature: "chat", quoteCredits: 3 })));
    assert.equal(all.filter(c => c.ok).length, 3);
    assert.equal((await credits.summary(u)).balance, 1);
  });

  await t("the monthly allowance is added once per month, even with parallel requests", async () => {
    const u = await user("twice");
    await Promise.all([credits.summary(u), credits.summary(u), credits.begin(u, { feature: "chat", quoteCredits: 1 }).then(c => c.cancel())]);
    assert.equal(Number((await db.get("SELECT COUNT(*) AS c FROM credit_ledger WHERE user_id=? AND kind='allowance'", u)).c), 1);
    await db.run("INSERT INTO credit_ledger(user_id, month, delta, kind) VALUES(?, '2000-01', 1000, 'allowance')", u);
    await db.run("INSERT INTO credit_ledger(user_id, month, delta, kind) VALUES(?, '2000-01', -700, 'use')", u);
    assert.equal((await credits.summary(u)).balance, 1000, "last month's leftovers don't roll over, this month starts fresh");
  });

  await t("Max: no allowance and NOTHING deducted for included features — just a 0-credit 'included' record", async () => {
    const u = await user("maxine", "max");
    const c = await credits.begin(u, { feature: "council", quoteCredits: 40 });
    assert.equal(c.ok, true); assert.equal(c.included, true);
    const bill = await c.finish({ charged: 40, model: "gemini-3.5-flash", tier: "balanced" });
    assert.deepEqual(bill, { charged: 0, included: true, unlimited: true });
    const h = await credits.history(u);
    assert.deepEqual(h.map(r => [r.kind, r.delta]), [["included", 0]]);
    const s = await credits.summary(u);
    assert.deepEqual([s.balance, s.plan.label, s.plan.unlimited, s.plan.monthlyCredits], [null, "Max", true, null]);
    assert.ok(!(await credits.history(u)).some(r => r.kind === "allowance"));
  });

  await t("Max fair use: after N top-model messages today, the rule says use standard models (published, consistent)", async () => {
    await credits.saveConfig({ plans: { max: { topModelDailyMessages: 2 } } });
    const u = await user("maximo", "max");
    const plan = await credits.planOf(u);
    assert.equal((await credits.fairUse(u, plan)).limited, false);
    for (let i = 0; i < 2; i++) await (await credits.begin(u, { feature: "chat", quoteCredits: 6 })).finish({ model: "gemini-3.1-pro-preview", tier: "deep" });
    await (await credits.begin(u, { feature: "chat", quoteCredits: 5 })).finish({ model: "gemini-3.5-flash", tier: "balanced" });
    assert.deepEqual(await credits.fairUse(u, plan), { limited: true, used: 2, limit: 2 });
    const free = await credits.planOf(await user("plainfree"));
    assert.equal((await credits.fairUse(1, free)).limited, false, "fair use is a Max rule only");
    await credits.saveConfig({ plans: { max: { topModelDailyMessages: 0 } } });
    assert.equal((await credits.fairUse(u, await credits.planOf(u))).limited, false, "0 turns it off");
  });

  await t("a feature left out of Max is refused clearly, never silently charged", async () => {
    await credits.saveConfig({ plans: { max: { eligible: ["chat", "coding", "web", "research", "council"] } } });
    const u = await user("nopics", "max");
    const c = await credits.begin(u, { feature: "images", quoteCredits: 7 });
    assert.deepEqual([c.ok, c.code], [false, "NOT_INCLUDED"]);
    assert.match(c.message, /Image analysis isn't included in Max yet/);
    await credits.saveConfig({ plans: { max: { eligible: Object.keys(credits.FEATURES) } } });
  });

  await t("admin settings are validated and take effect immediately", async () => {
    await assert.rejects(credits.saveConfig({ plans: { free: { monthlyCredits: -5 } } }), /Free monthly credits must be a whole number/);
    await assert.rejects(credits.saveConfig({ creditName: "" }), /Credit name/);
    await assert.rejects(credits.saveConfig({ costs: { models: { "bad name!": 3 } } }), /isn't a valid model name/);
    await credits.saveConfig({ creditName: "Ezer Credits", plans: { free: { monthlyCredits: 500 } }, costs: { balanced: 4, models: { "gemini-3.5-flash": 4 } } });
    const c2 = await credits.config();
    assert.deepEqual([c2.creditName, c2.plans.free.monthlyCredits, c2.costs.models["gemini-3.5-flash"], c2.costs.models["claude-opus-5-5"]], ["Ezer Credits", 500, 4, 11]);
    const u = await user("newmonth");
    assert.equal((await credits.summary(u)).balance, 500);
    assert.match((await credits.begin(u, { feature: "chat", quoteCredits: 999 })).message, /999 Ezer Credits/);
    await credits.saveConfig({ creditName: "Sam Credits", plans: { free: { monthlyCredits: 1000 } }, costs: { balanced: 5, models: { "gemini-3.5-flash": 5 } } });
  });

  await t("admin: change plan, add or remove credits, stats", async () => {
    const u = await user("upgraded");
    assert.equal(await credits.setPlan(u, "max"), true);
    assert.equal((await credits.summary(u)).plan.unlimited, true);
    await assert.rejects(credits.setPlan(u, "platinum"), /Unknown plan/);
    await credits.setPlan(u, "free");
    assert.equal(await credits.grant(u, 250, "thanks for testing"), 1250);
    assert.match((await credits.history(u))[0].description, /Bonus from Sam's admin: thanks for testing/);
    await assert.rejects(credits.grant(u, 1.5), /whole number/);
    assert.equal(await credits.grant(999999, 5), null);
    const st = await credits.stats();
    assert.ok(st.creditsUsed > 0 && st.plans.max >= 1 && st.includedAnswers >= 1);
  });

  await t("a hold left by a crash is released after 15 minutes", async () => {
    const u = await user("crashy");
    await credits.begin(u, { feature: "chat", quoteCredits: 5 });
    await db.run("UPDATE credit_ledger SET created_at=datetime('now','-20 minutes') WHERE user_id=? AND kind='hold'", u);
    await credits.releaseStaleHolds();
    assert.equal((await credits.summary(u)).balance, 1000);
  });

  done("credits.js");
  process.exit(process.exitCode || 0);
})();
