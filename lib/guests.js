// Guest mode: try Sam without an account.
//
// - A guest's chat lives only in this server's memory. It is never written to the database, and it is
//   deleted when the guest leaves, logs in or signs up, after GUEST_IDLE_MIN minutes without a message,
//   or when the server restarts. It moves into an account only if the guest ticks "save this chat".
// - The database only keeps daily message COUNTS (table guest_usage), for three buckets: the random guest
//   id, a one-way hash of the network address (never the address itself), and "all" (every guest
//   together, a cost safety net). Rows older than 3 days are deleted.
const crypto = require("crypto");
const { db } = require("./db");

const num = (v, d) => (Number.isFinite(Number(v)) && v !== "" && v != null ? Number(v) : d);
function config() {
  return {
    enabled: process.env.GUEST_MODE !== "0",
    perGuest: num(process.env.GUEST_DAILY_MESSAGES, 10),   // what each guest gets per day
    perNetwork: num(process.env.GUEST_NETWORK_DAILY, 30),  // stops "clear cookies, get 10 more" (a few people can share a network)
    total: num(process.env.GUEST_DAILY_TOTAL, 300),        // all guests together per day
    idleMs: num(process.env.GUEST_IDLE_MIN, 120) * 60000,
    maxChars: 2000
  };
}
const enabled = () => config().enabled;

const chats = new Map(); // guestId -> { messages: [{ role, content, model? }], lastSeen }
const KEEP = 20;         // messages kept (and sent back to the AI as context)
const MAX_GUESTS = 5000; // memory guard: the oldest idle chats go first

let salt = "sam";
const setSalt = s => { salt = String(s || "sam"); };
const newGuestId = () => crypto.randomBytes(12).toString("hex");
const today = () => new Date().toISOString().slice(0, 10);
const networkBucket = ip => "n:" + crypto.createHmac("sha256", salt).update(String(ip || "unknown")).digest("hex").slice(0, 24);
const bucketsFor = (guestId, ip) => [["g:" + guestId, "perGuest"], [networkBucket(ip), "perNetwork"], ["all", "total"]];

async function counts(guestId, ip, day = today()) {
  const out = {};
  for (const [bucket, kind] of bucketsFor(guestId, ip)) {
    const r = await db.get("SELECT count FROM guest_usage WHERE bucket=? AND day=?", bucket, day);
    out[kind] = Number(r?.count || 0);
  }
  return out;
}

async function remaining(guestId, ip) {
  const c = config(), n = await counts(guestId, ip);
  const left = Math.max(0, Math.min(c.perGuest - n.perGuest, c.perNetwork - n.perNetwork, c.total - n.total));
  return { remaining: left, limit: c.perGuest, used: n.perGuest };
}

// Takes one message from every bucket. If any bucket is over its limit, nothing is taken.
// Returns { ok, release } — release() gives the message back (used when the AI couldn't answer).
async function reserve(guestId, ip) {
  const c = config(), day = today(), taken = [];
  const giveBack = async () => { for (const b of taken.splice(0)) await db.run("UPDATE guest_usage SET count=count-1 WHERE bucket=? AND day=? AND count>0", b, day); };
  for (const [bucket, kind] of bucketsFor(guestId, ip)) {
    const r = await db.get("INSERT INTO guest_usage(bucket,day,count) VALUES(?,?,1) ON CONFLICT(bucket,day) DO UPDATE SET count=guest_usage.count+1 RETURNING count", bucket, day);
    taken.push(bucket);
    if (Number(r.count) > c[kind]) { await giveBack(); return { ok: false, reason: kind }; }
  }
  return { ok: true, release: giveBack };
}

function limitMessage(reason) {
  const c = config();
  if (reason === "perNetwork") return "Guests on this network have used today's free messages. Create a free account to keep chatting.";
  if (reason === "total") return "Ezer's free guest messages are all used up for today. Create a free account to keep chatting.";
  return `You've used today's ${c.perGuest} free guest messages. Create a free account to keep chatting (and keep this chat).`;
}

function messages(guestId) { return (chats.get(guestId)?.messages || []).map(m => ({ ...m })); }
function history(guestId) { return messages(guestId).map(({ role, content }) => ({ role, content })); }
function add(guestId, userText, answer, model) {
  const entry = chats.get(guestId) || { messages: [] };
  entry.messages.push({ role: "user", content: userText }, { role: "assistant", content: answer, model });
  entry.messages = entry.messages.slice(-KEEP);
  entry.lastSeen = Date.now();
  chats.delete(guestId); chats.set(guestId, entry); // re-insert = most recently used at the end
  while (chats.size > MAX_GUESTS) chats.delete(chats.keys().next().value);
}
const forget = guestId => chats.delete(guestId);

// Guests get the Fast models; Balanced only as a backup when every Fast model is down. Never Deep.
const candidates = list => list.filter(c => c.tier === "fast").concat(list.filter(c => c.tier === "balanced"));

function systemPrompt() {
  const today = new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  return [
    "You are Sam, the AI assistant built into Ezer (the platform the user is on). You are funny, entertaining, futuristic, warm, clever, concise and helpful.",
    "Format replies in markdown: short paragraphs, bullet lists where useful, **bold** for key points, fenced code blocks for code.",
    "Explain school topics clearly when asked. Never pretend to have performed actions you cannot perform.",
    `Today is ${today}.`,
    "This person is trying Ezer as a guest, without an account. You don't know their age, so keep everything suitable for teenagers (13+).",
    "You can't save memories or settings for guests and you can't search the web or look at images in guest mode. If they ask, say a free account unlocks those."
  ].join("\n");
}

// Deletes idle guest chats and old counters. Runs every few minutes.
async function sweep(now = Date.now()) {
  const { idleMs } = config();
  for (const [id, e] of chats) if (now - e.lastSeen > idleMs) chats.delete(id);
  const cutoff = new Date(now - 3 * 86400000).toISOString().slice(0, 10);
  await db.run("DELETE FROM guest_usage WHERE day < ?", cutoff);
}

async function stats() {
  const c = config();
  const r = await db.get("SELECT count FROM guest_usage WHERE bucket='all' AND day=?", today());
  return { enabled: c.enabled, messagesToday: Number(r?.count || 0), dailyTotal: c.total, perGuest: c.perGuest, perNetwork: c.perNetwork, openChats: chats.size };
}

module.exports = { config, enabled, setSalt, newGuestId, remaining, reserve, limitMessage, messages, history, add, forget, candidates, systemPrompt, sweep, stats, _chats: chats };
