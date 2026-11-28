// Personalisation: user settings, personalities, specialist assistants, prompt library, task detection.
const { db } = require("./db");

const PERSONALITIES = {
  sam: { label: "Sam (classic mix)", text: "Blend humour, intelligence, friendliness and professionalism. Be entertaining when it fits, serious and precise when it matters." },
  funny: { label: "Extra funny", text: "Lean into wit and playful jokes, but never at the expense of accuracy." },
  professional: { label: "Professional", text: "Be polished, calm and businesslike. Minimal jokes." },
  friendly: { label: "Warm & encouraging", text: "Be warm, supportive and encouraging, like a friendly mentor." },
  calm: { label: "Calm & simple", text: "Be calm, gentle and plain-spoken. Short sentences, no hype." }
};
const STYLES = {
  short: { label: "Short", text: "Keep answers short: a few sentences or a tight list unless asked for more." },
  balanced: { label: "Balanced", text: "Give complete but focused answers." },
  detailed: { label: "Detailed", text: "Give thorough, well-structured answers with examples." }
};
const ACCENTS = ["cyan", "blue", "purple", "green", "orange", "silver"];
const SPEEDS = ["auto", "fast", "balanced", "deep", "best"];

const BUILTIN_ASSISTANTS = [
  { id: "sam", icon: "🤖", name: "Sam", instructions: "" },
  { id: "tutor", icon: "🎓", name: "Tutor", instructions: "Act as a patient school tutor. Explain step by step at the learner's level, use everyday examples, check understanding with a quick question, and for homework guide the learner to the answer instead of just giving it." },
  { id: "coder", icon: "💻", name: "Coder", instructions: "Act as a senior software engineer and pair-programmer. Give working code in fenced blocks with a language tag, explain the key idea briefly, prefer the smallest correct change, and point out bugs and security issues." },
  { id: "researcher", icon: "🔎", name: "Researcher", instructions: "Act as a careful researcher. Separate facts from opinions, say how confident you are, cite sources when you have them, and never invent sources, quotes or numbers." },
  { id: "writer", icon: "✍️", name: "Writer", instructions: "Act as a skilled writing coach and editor. Improve clarity, structure and tone while keeping the author's voice. Explain the main changes." },
  { id: "business", icon: "📈", name: "Business coach", instructions: "Act as a practical startup and small-business coach. Be honest about risks, focus on customers, costs and next concrete steps." },
  { id: "creative", icon: "🎨", name: "Creative partner", instructions: "Act as an imaginative creative partner for stories, designs, videos and ideas. Offer varied options and build on the user's ideas." }
];

const BUILTIN_PROMPTS = [
  { id: "b:eli12", title: "Explain like I'm 12", body: "Explain [topic] simply, like I'm 12, with an everyday example." },
  { id: "b:quiz", title: "Quiz me", body: "Give me a 5-question quiz on [topic]. Ask one question at a time, wait for my answer, then mark it and explain." },
  { id: "b:revplan", title: "Revision plan", body: "Make me a revision plan for [subjects] before [date]. I can study about [hours] hours a day." },
  { id: "b:fixcode", title: "Fix my code", body: "Here's my code and the error. Find the bug, explain it, and show the fix:\n\n" },
  { id: "b:summary", title: "Summarise", body: "Summarise this in 5 bullet points, then give a one-line takeaway:\n\n" },
  { id: "b:idea", title: "Check my business idea", body: "Critique this business idea honestly — strengths, risks, competitors, and the first 3 steps:\n\n" }
];

const DEFAULTS = {
  personality: "sam", responseStyle: "balanced", explainSimply: false, customInstructions: "",
  defaultModel: "auto", defaultSpeed: "auto", autoMode: true, useMemories: true, theme: "dark", accent: "cyan"
};

const httpError = (status, message) => Object.assign(new Error(message), { status });

async function getSettings(userId) {
  const row = await db.get("SELECT settings FROM users WHERE id=?", userId);
  let saved = {};
  try { saved = JSON.parse(row?.settings || "{}") || {}; } catch {}
  return { ...DEFAULTS, ...saved };
}

// Validates every field; unknown keys are ignored.
async function saveSettings(userId, input = {}) {
  const s = await getSettings(userId);
  if (input.personality !== undefined) { if (!PERSONALITIES[input.personality]) throw httpError(400, "Unknown personality."); s.personality = input.personality; }
  if (input.responseStyle !== undefined) { if (!STYLES[input.responseStyle]) throw httpError(400, "Unknown response style."); s.responseStyle = input.responseStyle; }
  if (input.defaultSpeed !== undefined) { if (!SPEEDS.includes(input.defaultSpeed)) throw httpError(400, "Unknown speed."); s.defaultSpeed = input.defaultSpeed; }
  if (input.theme !== undefined) { if (!["dark", "light"].includes(input.theme)) throw httpError(400, "Theme must be dark or light."); s.theme = input.theme; }
  if (input.accent !== undefined) { if (!ACCENTS.includes(input.accent)) throw httpError(400, "Unknown accent colour."); s.accent = input.accent; }
  if (input.defaultModel !== undefined) { const m = String(input.defaultModel); if (m !== "auto" && !/^[a-z]+:[\w.\-:]+$/i.test(m)) throw httpError(400, "Unknown model."); s.defaultModel = m; }
  for (const k of ["explainSimply", "autoMode", "useMemories"]) if (input[k] !== undefined) s[k] = !!input[k];
  if (input.customInstructions !== undefined) s.customInstructions = String(input.customInstructions).slice(0, 1500);
  await db.run("UPDATE users SET settings=? WHERE id=?", JSON.stringify(s), userId);
  return s;
}

// ---- Assistants ----
async function listAssistants(userId) {
  const custom = (await db.all("SELECT id, name, icon, instructions FROM assistants WHERE user_id=? ORDER BY id", userId))
    .map(a => ({ id: "custom:" + a.id, name: a.name, icon: a.icon || "⭐", instructions: a.instructions, custom: true }));
  return [...BUILTIN_ASSISTANTS.map(a => ({ ...a, custom: false })), ...custom];
}
function cleanAssistant({ name, icon, instructions } = {}) {
  name = String(name || "").trim().slice(0, 40);
  instructions = String(instructions || "").trim().slice(0, 3000);
  icon = String(icon || "⭐").trim().slice(0, 4) || "⭐";
  if (!name) throw httpError(400, "Give your assistant a name.");
  if (!instructions) throw httpError(400, "Tell your assistant how to behave.");
  return { name, icon, instructions };
}
async function createAssistant(userId, input) {
  const a = cleanAssistant(input);
  if (Number((await db.get("SELECT COUNT(*) AS c FROM assistants WHERE user_id=?", userId)).c) >= 50) throw httpError(400, "You can have up to 50 custom assistants.");
  const id = await db.insert("INSERT INTO assistants(user_id,name,icon,instructions) VALUES(?,?,?,?)", userId, a.name, a.icon, a.instructions);
  return { id: "custom:" + id, ...a, custom: true };
}
const customId = ref => { const m = /^custom:(\d+)$/.exec(String(ref || "")); return m ? Number(m[1]) : null; };
async function updateAssistant(userId, ref, input) {
  const id = customId(ref); if (!id) throw httpError(400, "Built-in assistants can't be edited.");
  const a = cleanAssistant(input);
  if (!(await db.run("UPDATE assistants SET name=?, icon=?, instructions=? WHERE id=? AND user_id=?", a.name, a.icon, a.instructions, id, userId))) return null;
  return { id: ref, ...a, custom: true };
}
async function deleteAssistant(userId, ref) {
  const id = customId(ref); if (!id) throw httpError(400, "Built-in assistants can't be deleted.");
  return db.tx(async t => {
    const ok = (await t.run("DELETE FROM assistants WHERE id=? AND user_id=?", id, userId)) > 0;
    if (ok) await t.run("UPDATE conversations SET assistant=NULL WHERE user_id=? AND assistant=?", userId, ref);
    return ok;
  });
}
// Returns the assistant for a reference, or null if it doesn't exist / isn't this user's.
async function resolveAssistant(userId, ref) {
  if (!ref) return BUILTIN_ASSISTANTS[0];
  const b = BUILTIN_ASSISTANTS.find(a => a.id === ref); if (b) return b;
  const id = customId(ref); if (!id) return null;
  const a = await db.get("SELECT id, name, icon, instructions FROM assistants WHERE id=? AND user_id=?", id, userId);
  return a ? { id: ref, name: a.name, icon: a.icon, instructions: a.instructions } : null;
}

// ---- Prompt library ----
async function listPrompts(userId) {
  const mine = (await db.all("SELECT id, title, body FROM prompts WHERE user_id=? ORDER BY id DESC", userId)).map(p => ({ id: "p:" + p.id, title: p.title, body: p.body, custom: true }));
  return [...mine, ...BUILTIN_PROMPTS.map(p => ({ ...p, custom: false }))];
}
async function createPrompt(userId, { title, body } = {}) {
  title = String(title || "").trim().slice(0, 80); body = String(body || "").trim().slice(0, 4000);
  if (!title || !body) throw httpError(400, "A prompt needs a title and some text.");
  if (Number((await db.get("SELECT COUNT(*) AS c FROM prompts WHERE user_id=?", userId)).c) >= 200) throw httpError(400, "You can save up to 200 prompts.");
  const id = await db.insert("INSERT INTO prompts(user_id,title,body) VALUES(?,?,?)", userId, title, body);
  return { id: "p:" + id, title, body, custom: true };
}
async function deletePrompt(userId, ref) {
  const m = /^p:(\d+)$/.exec(String(ref || "")); if (!m) throw httpError(400, "Built-in prompts can't be deleted.");
  return (await db.run("DELETE FROM prompts WHERE id=? AND user_id=?", Number(m[1]), userId)) > 0;
}

// ---- Automatic task recognition (cheap, local — no extra AI call) ----
const CODE_WORDS = /```|\b(stack ?trace|exception|debug(ging)?|compiler?|syntax error|my code|this code|the code|javascript|typescript|python|java|c\+\+|c#|html|css|sql|node\.?js|react|npm|github|terminal command)\b|\berror:/i;
const ERROR_NAMES = /\b[A-Z]\w*Error\b/; // TypeError, SyntaxError… (case-sensitive so "terror" doesn't count)
const TASKS = [
  { mode: "coding", label: "Coding Assistant", match: m => CODE_WORDS.test(m) || ERROR_NAMES.test(m) },
  { mode: "research", label: "Deep Research", match: m => /\b(research|in[- ]depth|compare (the )?sources|literature review|pros and cons of|history of|investigate|evidence (for|on))\b/i.test(m) },
  { mode: "web", label: "Web Search", match: m => /\b(latest|news|today|tonight|this week|right now|currently|price of|who won|score of|weather in)\b/i.test(m) },
  { mode: "chat", assistant: "tutor", label: "Tutor", match: m => /\b(homework|revise|revision|quiz me|test me|exam|gcse|a[- ]level|ks3|teach me|help me understand|worksheet)\b/i.test(m) }
];
function detectTask(message) {
  const m = String(message || "");
  const t = TASKS.find(x => x.match(m));
  return t ? { mode: t.mode, assistant: t.assistant || null, label: t.label } : null;
}

// The personalisation block added to Sam's system prompt.
function personaPrompt(settings, assistant) {
  return [
    `Personality: ${PERSONALITIES[settings.personality]?.text || PERSONALITIES.sam.text}`,
    `Response style: ${STYLES[settings.responseStyle]?.text || STYLES.balanced.text}`,
    settings.explainSimply ? "Explain things simply and avoid unnecessary jargon." : "",
    assistant?.instructions ? `Specialist role (${assistant.name}): ${assistant.instructions}` : "",
    settings.customInstructions ? `The user's custom instructions (follow them unless unsafe):\n${settings.customInstructions}` : ""
  ].filter(Boolean).join("\n");
}

function options() {
  return {
    personalities: Object.entries(PERSONALITIES).map(([id, p]) => ({ id, label: p.label })),
    styles: Object.entries(STYLES).map(([id, s]) => ({ id, label: s.label })),
    accents: ACCENTS, speeds: SPEEDS, defaults: DEFAULTS
  };
}

module.exports = {
  getSettings, saveSettings, listAssistants, createAssistant, updateAssistant, deleteAssistant, resolveAssistant,
  listPrompts, createPrompt, deletePrompt, detectTask, personaPrompt, options, BUILTIN_ASSISTANTS
};
