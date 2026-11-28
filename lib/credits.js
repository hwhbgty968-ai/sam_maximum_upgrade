// Ezer Credits (master-plan Stage 9a): credits WITHOUT real money.
//
// Rules shown to customers, and followed exactly here:
// - Free plan: a monthly allowance (default 1,000). It resets on the 1st of each month (UTC) and doesn't roll over.
// - Each AI answer costs a fixed, published number of credits for the model that answered.
//   The price is shown before sending, and a user is never charged more than that quote.
// - Failed answers cost nothing. A stopped answer costs credits only if some of it was written.
// - Max plan: "Unlimited Ezer Credits". No monthly allowance and NO credit deductions for included features.
//   One published fair-use rule: after N top-model (Deep) messages a day, Sam answers with standard models
//   until midnight UTC. Never a charge, never a block.
// - Every change to a balance is a ledger row the user can see. Nothing is deducted anywhere else.
// - Everything (allowance, costs, Max features, fair use, wording) is an admin setting.
const { db } = require("./db");

const FEATURES = {
  chat: "Chat",
  coding: "Coding help",
  web: "Web search",
  research: "Deep research",
  council: "Sam Council",
  images: "Image analysis"
};

// Admins get full access (when adminFullAccess is on): no credits taken, no daily limits, every feature.
const ADMIN_PLAN = { label: "Admin", unlimited: true, fullAccess: true, eligible: Object.keys(FEATURES), topModelDailyMessages: 0 };

const DEFAULTS = {
  creditName: "Ezer Credits",
  adminFullAccess: true,
  plans: {
    free: { label: "Free", monthlyCredits: 1000 },
    max: { label: "Max", unlimited: true, eligible: Object.keys(FEATURES), topModelDailyMessages: 30 }
  },
  // Credits per answer. 1 credit ≈ $0.002 of provider cost, rounded up (prices from the Nov 2026 audit).
  costs: {
    fast: 1, balanced: 5, deep: 12, // used for models without their own price below
    web: 1,                          // extra for web search / research (the articles make the request bigger)
    images: 2,                       // extra for reading an image
    models: {
      "gemini-3.1-flash-lite": 1, "gemini-3.5-flash": 5, "gemini-3.1-pro-preview": 6,
      "claude-haiku-5-5": 1, "claude-sonnet-5-5": 6, "claude-opus-5-5": 11,
      "gpt-6-luna": 1, "gpt-6.1-terra": 3, "gpt-6-astra": 28
    }
  },
  maxNote: "Unlimited Ezer Credits means Ezer never takes credits for the features included in Max, and there's no monthly allowance to run out of. It isn't a promise of unlimited access to every outside AI model or service: AI providers (such as Google, Anthropic, OpenAI and DeepSeek), integrations and hosting have their own limits, outages and requirements, so a model or feature can sometimes be busy or unavailable. When that happens, Sam tells you and answers with another model where it can."
};

const clone = o => JSON.parse(JSON.stringify(o));
let cache = null;

async function config() {
  if (cache) return cache;
  let saved = {};
  try { saved = JSON.parse((await db.get("SELECT value FROM app_settings WHERE key='credits_config'"))?.value || "{}"); } catch {}
  cache = merge(clone(DEFAULTS), saved);
  return cache;
}
function merge(base, extra) {
  for (const [k, v] of Object.entries(extra || {})) {
    if (v && typeof v === "object" && !Array.isArray(v) && base[k] && typeof base[k] === "object" && !Array.isArray(base[k])) merge(base[k], v);
    else base[k] = v;
  }
  return base;
}

// Admin settings: checked strictly, so a typo can't silently break billing.
function validate(input) {
  const c = merge(clone(DEFAULTS), input || {});
  const int = (v, name, min = 0, max = 1e7) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < min || n > max) throw Object.assign(new Error(`${name} must be a whole number from ${min} to ${max}.`), { status: 400 });
    return n;
  };
  const text = (v, name, min, max) => {
    const s = String(v ?? "").trim();
    if (s.length < min || s.length > max) throw Object.assign(new Error(`${name} must be ${min}–${max} characters.`), { status: 400 });
    return s;
  };
  const out = {
    creditName: text(c.creditName, "Credit name", 2, 40),
    adminFullAccess: c.adminFullAccess !== false,
    plans: {
      free: { label: text(c.plans.free.label, "Free plan name", 2, 30), monthlyCredits: int(c.plans.free.monthlyCredits, "Free monthly credits") },
      max: {
        label: text(c.plans.max.label, "Max plan name", 2, 30),
        unlimited: c.plans.max.unlimited !== false,
        eligible: [...new Set((c.plans.max.eligible || []).filter(f => FEATURES[f]))],
        topModelDailyMessages: int(c.plans.max.topModelDailyMessages, "Top-model messages per day", 0, 100000),
        monthlyCredits: int(c.plans.max.monthlyCredits ?? 0, "Max monthly credits")
      }
    },
    costs: { fast: int(c.costs.fast, "Fast cost", 0, 10000), balanced: int(c.costs.balanced, "Balanced cost", 0, 10000), deep: int(c.costs.deep, "Deep cost", 0, 10000),
      web: int(c.costs.web, "Web search extra", 0, 10000), images: int(c.costs.images, "Image extra", 0, 10000), models: {} },
    maxNote: text(c.maxNote, "Max explanation", 20, 2000)
  };
  for (const [m, v] of Object.entries(c.costs.models || {})) {
    const name = String(m).trim();
    if (!/^[\w.:-]{1,80}$/.test(name)) throw Object.assign(new Error(`"${m}" isn't a valid model name.`), { status: 400 });
    out.costs.models[name] = int(v, `Cost for ${name}`, 0, 10000);
  }
  return out;
}

async function saveConfig(input) {
  const c = validate(input);
  await db.run("INSERT INTO app_settings(key,value) VALUES('credits_config',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", JSON.stringify(c));
  cache = null;
  return config();
}
const resetCache = () => { cache = null; };
// For synchronous checks (the per-minute limiter): the last loaded setting. config() is loaded at startup and after every save.
const adminFullAccessNow = () => (cache ? cache.adminFullAccess : DEFAULTS.adminFullAccess) !== false;

// ---------------------------------------------------------------- Pricing
const month = (d = new Date()) => d.toISOString().slice(0, 7);
const today = (d = new Date()) => d.toISOString().slice(0, 10);
const nextReset = (d = new Date()) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString();

const costOf = (cfg, c) => (c && cfg.costs.models[c.model] != null) ? cfg.costs.models[c.model] : (cfg.costs[c?.tier] ?? cfg.costs.balanced);
const extraFor = (cfg, feature) => feature === "web" || feature === "research" ? cfg.costs.web : feature === "images" ? cfg.costs.images : 0;

// The price shown before sending: the first model Sam will try (council: every member + the chair).
function quote(cfg, { feature, candidates = [], members = null, chair = null }) {
  if (members) return members.reduce((s, m) => s + costOf(cfg, m), 0) + costOf(cfg, chair?.[0] || { tier: "balanced" }) + extraFor(cfg, feature);
  return costOf(cfg, candidates[0]) + extraFor(cfg, feature);
}
// What the answer really used: the models that actually answered.
function actual(cfg, { feature, result }) {
  if (result.members) return result.members.reduce((s, m) => s + costOf(cfg, m), 0) + costOf(cfg, result) + extraFor(cfg, feature);
  return costOf(cfg, result) + extraFor(cfg, feature);
}

// ---------------------------------------------------------------- Plans and balances
// The plan that applies right now: an admin (not disabled) gets full access when that setting is on.
function resolvePlan(cfg, row) {
  if (row && (row.role === "admin" || row.role === "owner") && !row.disabled && cfg.adminFullAccess) return { id: "admin", ...ADMIN_PLAN };
  const id = cfg.plans[row?.plan] ? row.plan : "free";
  return { id, ...cfg.plans[id] };
}
async function planOf(userId, cfg) {
  cfg = cfg || await config();
  return resolvePlan(cfg, await db.get("SELECT plan, role, disabled FROM users WHERE id=?", userId));
}

// The monthly allowance is added as a visible ledger row the first time it's needed each month.
// A unique index makes sure two requests at once can't add it twice.
async function ensureAllowance(t, userId, plan, m = month()) {
  if (plan.unlimited || !plan.monthlyCredits) return;
  await t.run("INSERT INTO credit_ledger(user_id, month, delta, kind, description) VALUES(?,?,?,'allowance',?) ON CONFLICT DO NOTHING",
    userId, m, plan.monthlyCredits, `Monthly allowance (${plan.label})`);
}
const balanceIn = async (t, userId, m = month()) => Number((await t.get("SELECT COALESCE(SUM(delta),0) AS b FROM credit_ledger WHERE user_id=? AND month=?", userId, m))?.b || 0);

async function topModelUsedToday(userId) {
  const r = await db.get("SELECT COUNT(*) AS c FROM credit_ledger WHERE user_id=? AND kind='included' AND tier='deep' AND substr(created_at,1,10)=?", userId, today());
  return Number(r?.c || 0);
}
// Max fair use: true when today's top-model messages are used up (Sam then uses standard models, free of charge).
async function fairUse(userId, plan) {
  const limit = plan.unlimited ? plan.topModelDailyMessages || 0 : 0;
  if (!limit) return { limited: false, used: 0, limit: 0 };
  const used = await topModelUsedToday(userId);
  return { limited: used >= limit, used, limit };
}

// Before an answer: checks the plan, reserves the quoted credits, and returns finish()/cancel().
// finish({ charged, model, tier, description }) settles the real amount (never above the quote);
// cancel() gives everything back (used when the answer failed).
async function begin(userId, { feature, quoteCredits, description }) {
  const cfg = await config();
  return db.tx(async t => {
    await t.run("UPDATE users SET id=id WHERE id=?", userId); // locks this user's row (Postgres) so parallel requests queue
    const plan = resolvePlan(cfg, await t.get("SELECT plan, role, disabled FROM users WHERE id=?", userId));
    const name = cfg.creditName;
    if (plan.unlimited) {
      if (!plan.eligible.includes(feature)) {
        return { ok: false, status: 403, code: "NOT_INCLUDED", message: `${FEATURES[feature] || "This feature"} isn't included in ${plan.label} yet.` };
      }
      return {
        ok: true, included: true, plan, quote: 0,
        finish: async ({ model, tier, description: d }) => {
          await db.run("INSERT INTO credit_ledger(user_id, month, delta, kind, feature, model, tier, description) VALUES(?,?,0,'included',?,?,?,?)",
            userId, month(), feature, model || null, tier || null, d || description || FEATURES[feature]);
          return { charged: 0, included: true, unlimited: true };
        },
        cancel: async () => {}
      };
    }
    await ensureAllowance(t, userId, plan);
    const balance = await balanceIn(t, userId);
    if (balance < quoteCredits) {
      const reset = new Date(nextReset()).toLocaleDateString("en-GB", { day: "numeric", month: "long", timeZone: "UTC" });
      return { ok: false, status: 402, code: "NO_CREDITS", balance, quote: quoteCredits,
        message: `This message needs ${quoteCredits} ${name} and you have ${balance} left this month. Your allowance resets on ${reset}.` + (quoteCredits > cfg.costs.fast && balance >= cfg.costs.fast ? ` Switching speed to Fast costs ${cfg.costs.fast}.` : "") };
    }
    const id = await t.insert("INSERT INTO credit_ledger(user_id, month, delta, kind, feature, description) VALUES(?,?,?,'hold',?,?)",
      userId, month(), -quoteCredits, feature, (description || FEATURES[feature]) + " (answering…)");
    let settled = false;
    return {
      ok: true, included: false, plan, quote: quoteCredits,
      finish: async ({ charged, model, tier, description: d }) => {
        if (settled) return null; settled = true;
        const amount = Math.max(0, Math.min(quoteCredits, Math.round(charged))); // never more than the quote
        await db.run("UPDATE credit_ledger SET kind='use', delta=?, model=?, tier=?, description=? WHERE id=?", -amount, model || null, tier || null, d || description || FEATURES[feature], id);
        return { charged: amount, balance: await balanceIn(db, userId), unlimited: false };
      },
      cancel: async () => { if (settled) return; settled = true; await db.run("DELETE FROM credit_ledger WHERE id=?", id); }
    };
  });
}

async function summary(userId) {
  const cfg = await config();
  const plan = await planOf(userId, cfg);
  if (!plan.unlimited) await db.tx(t => ensureAllowance(t, userId, plan));
  const m = month();
  const rows = await db.all("SELECT kind, delta FROM credit_ledger WHERE user_id=? AND month=?", userId, m);
  const used = rows.filter(r => r.kind === "use" || r.kind === "hold").reduce((s, r) => s - Number(r.delta), 0);
  const fair = await fairUse(userId, plan);
  return {
    creditName: cfg.creditName,
    plan: { id: plan.id, label: plan.label, unlimited: !!plan.unlimited, fullAccess: !!plan.fullAccess, monthlyCredits: plan.unlimited ? null : plan.monthlyCredits,
      eligible: plan.unlimited ? plan.eligible.map(f => ({ id: f, label: FEATURES[f] })) : null,
      topModelDailyMessages: plan.unlimited ? plan.topModelDailyMessages : null },
    balance: plan.unlimited ? null : rows.reduce((s, r) => s + Number(r.delta), 0),
    usedThisMonth: used,
    includedThisMonth: rows.filter(r => r.kind === "included").length,
    topModelToday: plan.unlimited ? { used: fair.used, limit: fair.limit } : null,
    resetsAt: nextReset(),
    costs: { fast: cfg.costs.fast, balanced: cfg.costs.balanced, deep: cfg.costs.deep, web: cfg.costs.web, images: cfg.costs.images, models: cfg.costs.models },
    maxNote: cfg.maxNote,
    plans: Object.entries(cfg.plans).map(([id, p]) => ({ id, label: p.label, unlimited: !!p.unlimited, monthlyCredits: p.unlimited ? null : p.monthlyCredits,
      eligible: p.unlimited ? p.eligible.map(f => FEATURES[f]) : null, topModelDailyMessages: p.unlimited ? p.topModelDailyMessages : null }))
  };
}

async function history(userId, limit = 50) {
  const rows = await db.all("SELECT id, month, delta, kind, feature, model, tier, description, created_at FROM credit_ledger WHERE user_id=? ORDER BY id DESC LIMIT ?",
    userId, Math.min(Math.max(Number(limit) || 50, 1), 200));
  return rows.map(r => ({ ...r, delta: Number(r.delta) }));
}

// ---------------------------------------------------------------- Admin
async function setPlan(userId, plan) {
  const cfg = await config();
  if (!cfg.plans[plan]) throw Object.assign(new Error("Unknown plan."), { status: 400 });
  return (await db.run("UPDATE users SET plan=? WHERE id=?", plan, userId)) > 0;
}
async function grant(userId, amount, note) {
  const n = Number(amount);
  if (!Number.isInteger(n) || n === 0 || Math.abs(n) > 1e6) throw Object.assign(new Error("Enter a whole number of credits (use a minus sign to remove)."), { status: 400 });
  const text = String(note || "").trim().slice(0, 120);
  return db.tx(async t => {
    const u = await t.get("SELECT id, plan FROM users WHERE id=?", userId);
    if (!u) return null;
    const cfg = await config(); const plan = { ...(cfg.plans[u.plan] || cfg.plans.free) }; // their own plan's allowance (even if they're an admin)
    await ensureAllowance(t, userId, plan);
    await t.insert("INSERT INTO credit_ledger(user_id, month, delta, kind, description) VALUES(?,?,?,'bonus',?)",
      userId, month(), n, (n > 0 ? "Bonus from Ezer's admin" : "Adjustment by Ezer's admin") + (text ? ": " + text : ""));
    return balanceIn(t, userId);
  });
}
// A hold left behind by a crash or restart mid-answer is given back (the answer never finished).
async function releaseStaleHolds() {
  return db.run("DELETE FROM credit_ledger WHERE kind='hold' AND created_at < datetime('now','-15 minutes')");
}
async function stats() {
  const m = month();
  const used = await db.get("SELECT COALESCE(SUM(-delta),0) AS c FROM credit_ledger WHERE month=? AND kind='use'", m);
  const included = await db.get("SELECT COUNT(*) AS c FROM credit_ledger WHERE month=? AND kind='included'", m);
  const plans = await db.all("SELECT COALESCE(plan,'free') AS plan, COUNT(*) AS c FROM users GROUP BY COALESCE(plan,'free')");
  return { month: m, creditsUsed: Number(used?.c || 0), includedAnswers: Number(included?.c || 0), plans: Object.fromEntries(plans.map(p => [p.plan, Number(p.c)])) };
}

module.exports = { adminFullAccessNow, ADMIN_PLAN, releaseStaleHolds, FEATURES, DEFAULTS, config, saveConfig, validate, resetCache, month, nextReset, costOf, quote, actual, planOf, fairUse, topModelUsedToday, begin, summary, history, setPlan, grant, stats };
