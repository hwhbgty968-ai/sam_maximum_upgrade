// Conversation + message operations. Every query is scoped to the user who owns the data.
const { db } = require("./db");

const parseMeta = s => { if (!s) return null; try { return JSON.parse(s); } catch { return null; } };

function listConversations(userId, { archived = false } = {}) {
  return db.prepare(
    `SELECT id, title, mode, pinned, archived, assistant, created_at, updated_at FROM conversations
     WHERE user_id=? AND COALESCE(archived,0)=? ORDER BY COALESCE(pinned,0) DESC, updated_at DESC, id DESC`
  ).all(userId, archived ? 1 : 0).map(c => ({ ...c, pinned: !!c.pinned, archived: !!c.archived }));
}

function getConversation(userId, id) {
  const conversation = db.prepare("SELECT id, title, mode, pinned, archived, assistant FROM conversations WHERE id=? AND user_id=?").get(id, userId);
  if (!conversation) return null;
  const messages = db.prepare(
    "SELECT id, role, content, model, pinned, meta, created_at FROM messages WHERE conversation_id=? AND user_id=? ORDER BY id"
  ).all(conversation.id, userId).map(m => ({ ...m, pinned: !!m.pinned, meta: parseMeta(m.meta) }));
  return { conversation: { ...conversation, pinned: !!conversation.pinned, archived: !!conversation.archived }, messages };
}

// Rename / pin / archive. Returns the updated conversation, or null if it isn't this user's.
function updateConversation(userId, id, changes = {}) {
  const c = db.prepare("SELECT id FROM conversations WHERE id=? AND user_id=?").get(id, userId);
  if (!c) return null;
  if (typeof changes.title === "string") {
    const title = changes.title.replace(/\s+/g, " ").trim().slice(0, 80);
    if (!title) throw Object.assign(new Error("Title can't be empty."), { status: 400 });
    db.prepare("UPDATE conversations SET title=? WHERE id=? AND user_id=?").run(title, id, userId);
  }
  if (typeof changes.pinned === "boolean") db.prepare("UPDATE conversations SET pinned=? WHERE id=? AND user_id=?").run(changes.pinned ? 1 : 0, id, userId);
  if (changes.assistant !== undefined) db.prepare("UPDATE conversations SET assistant=? WHERE id=? AND user_id=?").run(changes.assistant || null, id, userId); // validated by the route
  if (typeof changes.archived === "boolean") db.prepare("UPDATE conversations SET archived=? WHERE id=? AND user_id=?").run(changes.archived ? 1 : 0, id, userId);
  return getConversation(userId, id).conversation;
}

const likeEscape = s => s.replace(/[\\%_]/g, ch => "\\" + ch);
function snippet(text, q, radius = 70) {
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return text.slice(0, radius * 2);
  const start = Math.max(0, i - radius), end = Math.min(text.length, i + q.length + radius);
  return (start > 0 ? "…" : "") + text.slice(start, end).replace(/\s+/g, " ") + (end < text.length ? "…" : "");
}

// Search titles + message text across this user's chats (archived included, flagged).
function search(userId, query, limit = 30) {
  const q = String(query || "").trim().slice(0, 100);
  if (q.length < 2) return { query: q, conversations: [], messages: [] };
  const like = "%" + likeEscape(q) + "%";
  const conversations = db.prepare(
    `SELECT id, title, mode, archived, updated_at FROM conversations
     WHERE user_id=? AND title LIKE ? ESCAPE '\\' ORDER BY updated_at DESC LIMIT 10`
  ).all(userId, like).map(c => ({ ...c, archived: !!c.archived }));
  const messages = db.prepare(
    `SELECT m.id, m.conversation_id, m.role, m.content, c.title, c.archived FROM messages m
     JOIN conversations c ON c.id = m.conversation_id AND c.user_id = m.user_id
     WHERE m.user_id=? AND m.content LIKE ? ESCAPE '\\' ORDER BY m.id DESC LIMIT ?`
  ).all(userId, like, Math.min(Number(limit) || 30, 100))
    .map(m => ({ id: m.id, conversationId: m.conversation_id, role: m.role, title: m.title, archived: !!m.archived, snippet: snippet(m.content, q) }));
  return { query: q, conversations, messages };
}

function setMessagePinned(userId, messageId, pinned) {
  return db.prepare("UPDATE messages SET pinned=? WHERE id=? AND user_id=?").run(pinned ? 1 : 0, messageId, userId).changes > 0;
}

function listPins(userId) {
  const messages = db.prepare(
    `SELECT m.id, m.conversation_id, m.role, m.content, m.created_at, c.title FROM messages m
     JOIN conversations c ON c.id = m.conversation_id AND c.user_id = m.user_id
     WHERE m.user_id=? AND m.pinned=1 ORDER BY m.id DESC`
  ).all(userId).map(m => ({ id: m.id, conversationId: m.conversation_id, role: m.role, title: m.title, created_at: m.created_at, preview: m.content.slice(0, 300) }));
  const conversations = db.prepare("SELECT id, title, mode, updated_at FROM conversations WHERE user_id=? AND pinned=1 ORDER BY updated_at DESC").all(userId);
  return { messages, conversations };
}

// The last N messages before a given message (or the end), for the AI's context.
function history(userId, conversationId, { beforeId = null, limit = 20 } = {}) {
  const rows = beforeId
    ? db.prepare("SELECT role, content FROM messages WHERE user_id=? AND conversation_id=? AND id<? ORDER BY id DESC LIMIT ?").all(userId, conversationId, beforeId, limit)
    : db.prepare("SELECT role, content FROM messages WHERE user_id=? AND conversation_id=? ORDER BY id DESC LIMIT ?").all(userId, conversationId, limit);
  return rows.reverse();
}

function touchTitle(userId, conversationId, userText) {
  const title = String(userText).replace(/^\[Image\]\s*/, "").replace(/\s+/g, " ").slice(0, 40) || "New chat";
  db.prepare("UPDATE conversations SET title=CASE WHEN title='New chat' THEN ? ELSE title END, updated_at=CURRENT_TIMESTAMP WHERE id=? AND user_id=?").run(title, conversationId, userId);
  return db.prepare("SELECT title FROM conversations WHERE id=? AND user_id=?").get(conversationId, userId)?.title || "Chat";
}

const insertMsg = () => db.prepare("INSERT INTO messages(user_id, role, content, conversation_id, mode, model, meta) VALUES(?,?,?,?,?,?,?)");

// Save a user message + Sam's reply together.
// replaceFromId (edit & resend): that message and everything after it are removed in the SAME transaction,
// so if the AI call failed earlier nothing was lost.
function saveExchange(userId, conversationId, mode, userText, answer, modelLabel = null, meta = null, { replaceFromId = null } = {}) {
  let ids;
  db.transaction(() => {
    if (replaceFromId) db.prepare("DELETE FROM messages WHERE user_id=? AND conversation_id=? AND id>=?").run(userId, conversationId, replaceFromId);
    const ins = insertMsg();
    const u = ins.run(userId, "user", userText, conversationId, mode, null, null);
    const a = ins.run(userId, "assistant", answer, conversationId, mode, modelLabel, meta ? JSON.stringify(meta) : null);
    ids = { userMessageId: Number(u.lastInsertRowid), assistantMessageId: Number(a.lastInsertRowid) };
  })();
  return { ...ids, title: touchTitle(userId, conversationId, userText) };
}

// Save a new reply to an existing user message (Regenerate). Older replies after it are replaced atomically.
function saveAssistant(userId, conversationId, mode, answer, modelLabel = null, meta = null, { afterUserMessageId } = {}) {
  let id;
  db.transaction(() => {
    if (afterUserMessageId) db.prepare("DELETE FROM messages WHERE user_id=? AND conversation_id=? AND id>?").run(userId, conversationId, afterUserMessageId);
    id = Number(insertMsg().run(userId, "assistant", answer, conversationId, mode, modelLabel, meta ? JSON.stringify(meta) : null).lastInsertRowid);
    db.prepare("UPDATE conversations SET updated_at=CURRENT_TIMESTAMP WHERE id=? AND user_id=?").run(conversationId, userId);
  })();
  return { assistantMessageId: id, title: db.prepare("SELECT title FROM conversations WHERE id=? AND user_id=?").get(conversationId, userId)?.title };
}

const httpError = (status, message) => Object.assign(new Error(message), { status });

// Regenerate: find the user message to answer again. Nothing is deleted until the new answer is saved.
function prepareRegenerate(userId, conversationId) {
  const lastUser = db.prepare("SELECT id, content FROM messages WHERE user_id=? AND conversation_id=? AND role='user' ORDER BY id DESC LIMIT 1").get(userId, conversationId);
  if (!lastUser) throw httpError(400, "There's nothing to regenerate yet.");
  if (lastUser.content.startsWith("[Image]")) throw httpError(400, "To redo an image answer, attach the image again.");
  return { message: lastUser.content, userMessageId: lastUser.id };
}

// Edit & resend: check the message can be edited. Deletion happens when the new answer is saved.
function prepareEdit(userId, conversationId, messageId) {
  const m = db.prepare("SELECT id, role FROM messages WHERE id=? AND user_id=? AND conversation_id=?").get(messageId, userId, conversationId);
  if (!m) throw httpError(404, "Message not found.");
  if (m.role !== "user") throw httpError(400, "Only your own messages can be edited.");
  return { replaceFromId: m.id };
}

module.exports = {
  listConversations, getConversation, updateConversation, search, setMessagePinned, listPins,
  history, saveExchange, saveAssistant, prepareRegenerate, prepareEdit, snippet
};
