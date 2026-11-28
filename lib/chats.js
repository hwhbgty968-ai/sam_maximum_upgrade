// Conversation + message operations. Every query is scoped to the user who owns the data.
const { db } = require("./db");

const parseMeta = s => { if (!s) return null; try { return JSON.parse(s); } catch { return null; } };
const httpError = (status, message) => Object.assign(new Error(message), { status });

async function listConversations(userId, { archived = false } = {}) {
  const rows = await db.all(
    `SELECT id, title, mode, pinned, archived, assistant, created_at, updated_at FROM conversations
     WHERE user_id=? AND COALESCE(archived,0)=? ORDER BY COALESCE(pinned,0) DESC, updated_at DESC, id DESC`,
    userId, archived ? 1 : 0);
  return rows.map(c => ({ ...c, pinned: !!c.pinned, archived: !!c.archived }));
}

async function createConversation(userId, mode = "chat", assistant = null) {
  return db.insert("INSERT INTO conversations (user_id, title, mode, assistant) VALUES (?, 'New chat', ?, ?)", userId, mode, assistant);
}

async function ownsConversation(userId, id) {
  return !!(await db.get("SELECT id FROM conversations WHERE id=? AND user_id=?", id, userId));
}

async function getConversation(userId, id) {
  const conversation = await db.get("SELECT id, title, mode, pinned, archived, assistant FROM conversations WHERE id=? AND user_id=?", id, userId);
  if (!conversation) return null;
  const messages = (await db.all(
    "SELECT id, role, content, model, pinned, meta, created_at FROM messages WHERE conversation_id=? AND user_id=? ORDER BY id",
    conversation.id, userId)).map(m => ({ ...m, pinned: !!m.pinned, meta: parseMeta(m.meta) }));
  return { conversation: { ...conversation, pinned: !!conversation.pinned, archived: !!conversation.archived }, messages };
}

async function conversationAssistant(userId, id) {
  return (await db.get("SELECT assistant FROM conversations WHERE id=? AND user_id=?", id, userId))?.assistant || null;
}

// Rename / pin / archive. Returns the updated conversation, or null if it isn't this user's.
async function updateConversation(userId, id, changes = {}) {
  if (!(await ownsConversation(userId, id))) return null;
  if (typeof changes.title === "string") {
    const title = changes.title.replace(/\s+/g, " ").trim().slice(0, 80);
    if (!title) throw httpError(400, "Title can't be empty.");
    await db.run("UPDATE conversations SET title=? WHERE id=? AND user_id=?", title, id, userId);
  }
  if (typeof changes.pinned === "boolean") await db.run("UPDATE conversations SET pinned=? WHERE id=? AND user_id=?", changes.pinned ? 1 : 0, id, userId);
  if (changes.assistant !== undefined) await db.run("UPDATE conversations SET assistant=? WHERE id=? AND user_id=?", changes.assistant || null, id, userId); // validated by the route
  if (typeof changes.archived === "boolean") await db.run("UPDATE conversations SET archived=? WHERE id=? AND user_id=?", changes.archived ? 1 : 0, id, userId);
  return (await getConversation(userId, id)).conversation;
}

async function deleteConversation(userId, id) {
  if (!(await ownsConversation(userId, id))) return false;
  await db.tx(async t => {
    await t.run("DELETE FROM messages WHERE conversation_id=? AND user_id=?", id, userId);
    await t.run("DELETE FROM conversations WHERE id=? AND user_id=?", id, userId);
  });
  return true;
}

const likeEscape = s => s.replace(/[\\%_]/g, ch => "\\" + ch);
function snippet(text, q, radius = 70) {
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return text.slice(0, radius * 2);
  const start = Math.max(0, i - radius), end = Math.min(text.length, i + q.length + radius);
  return (start > 0 ? "…" : "") + text.slice(start, end).replace(/\s+/g, " ") + (end < text.length ? "…" : "");
}

// Search titles + message text across this user's chats (archived included, flagged). Case-insensitive on both engines.
async function search(userId, query, limit = 30) {
  const q = String(query || "").trim().slice(0, 100);
  if (q.length < 2) return { query: q, conversations: [], messages: [] };
  const like = "%" + likeEscape(q.toLowerCase()) + "%";
  const conversations = (await db.all(
    `SELECT id, title, mode, archived, updated_at FROM conversations
     WHERE user_id=? AND lower(title) LIKE ? ESCAPE '\\' ORDER BY updated_at DESC LIMIT 10`,
    userId, like)).map(c => ({ ...c, archived: !!c.archived }));
  const messages = (await db.all(
    `SELECT m.id, m.conversation_id, m.role, m.content, c.title, c.archived FROM messages m
     JOIN conversations c ON c.id = m.conversation_id AND c.user_id = m.user_id
     WHERE m.user_id=? AND lower(m.content) LIKE ? ESCAPE '\\' ORDER BY m.id DESC LIMIT ?`,
    userId, like, Math.min(Number(limit) || 30, 100)))
    .map(m => ({ id: m.id, conversationId: m.conversation_id, role: m.role, title: m.title, archived: !!m.archived, snippet: snippet(m.content, q) }));
  return { query: q, conversations, messages };
}

async function setMessagePinned(userId, messageId, pinned) {
  return (await db.run("UPDATE messages SET pinned=? WHERE id=? AND user_id=?", pinned ? 1 : 0, messageId, userId)) > 0;
}

async function listPins(userId) {
  const messages = (await db.all(
    `SELECT m.id, m.conversation_id, m.role, m.content, m.created_at, c.title FROM messages m
     JOIN conversations c ON c.id = m.conversation_id AND c.user_id = m.user_id
     WHERE m.user_id=? AND m.pinned=1 ORDER BY m.id DESC`, userId))
    .map(m => ({ id: m.id, conversationId: m.conversation_id, role: m.role, title: m.title, created_at: m.created_at, preview: m.content.slice(0, 300) }));
  const conversations = await db.all("SELECT id, title, mode, updated_at FROM conversations WHERE user_id=? AND pinned=1 ORDER BY updated_at DESC", userId);
  return { messages, conversations };
}

// The last N messages before a given message (or the end), for the AI's context.
async function history(userId, conversationId, { beforeId = null, limit = 20 } = {}) {
  const rows = beforeId
    ? await db.all("SELECT role, content FROM messages WHERE user_id=? AND conversation_id=? AND id<? ORDER BY id DESC LIMIT ?", userId, conversationId, beforeId, limit)
    : await db.all("SELECT role, content FROM messages WHERE user_id=? AND conversation_id=? ORDER BY id DESC LIMIT ?", userId, conversationId, limit);
  return rows.reverse();
}

async function touchTitle(t, userId, conversationId, userText) {
  const title = String(userText).replace(/^\[Image\]\s*/, "").replace(/\s+/g, " ").slice(0, 40) || "New chat";
  await t.run("UPDATE conversations SET title=CASE WHEN title='New chat' THEN ? ELSE title END, updated_at=datetime('now') WHERE id=? AND user_id=?", title, conversationId, userId);
  return (await t.get("SELECT title FROM conversations WHERE id=? AND user_id=?", conversationId, userId))?.title || "Chat";
}

const INSERT_MSG = "INSERT INTO messages(user_id, role, content, conversation_id, mode, model, meta) VALUES(?,?,?,?,?,?,?)";

// Save a user message + Sam's reply together.
// replaceFromId (edit & resend): that message and everything after it are removed in the SAME transaction,
// so if the AI call failed earlier nothing was lost.
async function saveExchange(userId, conversationId, mode, userText, answer, modelLabel = null, meta = null, { replaceFromId = null } = {}) {
  return db.tx(async t => {
    if (replaceFromId) await t.run("DELETE FROM messages WHERE user_id=? AND conversation_id=? AND id>=?", userId, conversationId, replaceFromId);
    const userMessageId = await t.insert(INSERT_MSG, userId, "user", userText, conversationId, mode, null, null);
    const assistantMessageId = await t.insert(INSERT_MSG, userId, "assistant", answer, conversationId, mode, modelLabel, meta ? JSON.stringify(meta) : null);
    const title = await touchTitle(t, userId, conversationId, userText);
    return { userMessageId, assistantMessageId, title };
  });
}

// Save a new reply to an existing user message (Regenerate). Older replies after it are replaced atomically.
async function saveAssistant(userId, conversationId, mode, answer, modelLabel = null, meta = null, { afterUserMessageId } = {}) {
  return db.tx(async t => {
    if (afterUserMessageId) await t.run("DELETE FROM messages WHERE user_id=? AND conversation_id=? AND id>?", userId, conversationId, afterUserMessageId);
    const assistantMessageId = await t.insert(INSERT_MSG, userId, "assistant", answer, conversationId, mode, modelLabel, meta ? JSON.stringify(meta) : null);
    await t.run("UPDATE conversations SET updated_at=datetime('now') WHERE id=? AND user_id=?", conversationId, userId);
    const title = (await t.get("SELECT title FROM conversations WHERE id=? AND user_id=?", conversationId, userId))?.title;
    return { assistantMessageId, title };
  });
}

// Regenerate: find the user message to answer again. Nothing is deleted until the new answer is saved.
async function prepareRegenerate(userId, conversationId) {
  const lastUser = await db.get("SELECT id, content FROM messages WHERE user_id=? AND conversation_id=? AND role='user' ORDER BY id DESC LIMIT 1", userId, conversationId);
  if (!lastUser) throw httpError(400, "There's nothing to regenerate yet.");
  if (lastUser.content.startsWith("[Image]")) throw httpError(400, "To redo an image answer, attach the image again.");
  return { message: lastUser.content, userMessageId: lastUser.id };
}

// Edit & resend: check the message can be edited. Deletion happens when the new answer is saved.
async function prepareEdit(userId, conversationId, messageId) {
  const m = await db.get("SELECT id, role FROM messages WHERE id=? AND user_id=? AND conversation_id=?", messageId, userId, conversationId);
  if (!m) throw httpError(404, "Message not found.");
  if (m.role !== "user") throw httpError(400, "Only your own messages can be edited.");
  return { replaceFromId: m.id };
}

module.exports = {
  listConversations, createConversation, ownsConversation, getConversation, conversationAssistant, updateConversation, deleteConversation,
  search, setMessagePinned, listPins, history, saveExchange, saveAssistant, prepareRegenerate, prepareEdit, snippet
};
