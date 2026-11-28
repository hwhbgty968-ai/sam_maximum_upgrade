// Account data operations: password reset tokens, data export, account deletion.
const crypto = require("crypto");
const { db } = require("./db");

const sha256 = s => crypto.createHash("sha256").update(s).digest("hex");
const RESET_TTL_MINUTES = 60;

// One-time reset token. Only its hash is stored, so a leaked database can't be used to reset passwords.
async function createResetToken(userId, createdBy = null) {
  const token = crypto.randomBytes(32).toString("hex");
  await db.tx(async t => {
    await t.run("UPDATE password_resets SET used_at=datetime('now') WHERE user_id=? AND used_at IS NULL", userId); // old links stop working
    await t.run("INSERT INTO password_resets(user_id, token_hash, expires_at, created_by) VALUES(?,?,datetime('now', ?),?)",
      userId, sha256(token), `+${RESET_TTL_MINUTES} minutes`, createdBy);
  });
  return { token, expiresInMinutes: RESET_TTL_MINUTES };
}

// Returns the user id if the token is valid, and marks it used. Returns null otherwise.
async function consumeResetToken(token) {
  if (!/^[a-f0-9]{64}$/.test(String(token || ""))) return null;
  return db.tx(async t => {
    const row = await t.get("SELECT id, user_id FROM password_resets WHERE token_hash=? AND used_at IS NULL AND expires_at > datetime('now')", sha256(token));
    if (!row) return null;
    // Only one request can claim a token, even if two arrive at the same moment.
    const claimed = await t.run("UPDATE password_resets SET used_at=datetime('now') WHERE id=? AND used_at IS NULL", row.id);
    return claimed ? row.user_id : null;
  });
}

// Changing the password stamps password_changed_at; requireAuth compares it with the session,
// so every other logged-in device is signed out automatically.
async function setPasswordHash(userId, hash) {
  const stamp = new Date().toISOString();
  await db.run("UPDATE users SET password_hash=?, password_changed_at=? WHERE id=?", hash, stamp, userId);
  return stamp;
}

async function exportUserData(userId) {
  const account = await db.get("SELECT username, age, created_at, last_login_at FROM users WHERE id=?", userId);
  const conversations = await db.all("SELECT id, title, mode, created_at, updated_at FROM conversations WHERE user_id=? ORDER BY id", userId);
  const messages = await db.all("SELECT conversation_id, role, content, model, pinned, meta, created_at FROM messages WHERE user_id=? ORDER BY id", userId);
  const byConv = new Map(conversations.map(c => [c.id, (c.messages = [])]));
  for (const { conversation_id, ...m } of messages) byConv.get(conversation_id)?.push(m);
  let settings = {};
  try { settings = JSON.parse((await db.get("SELECT settings FROM users WHERE id=?", userId))?.settings || "{}"); } catch {}
  return {
    exportedAt: new Date().toISOString(),
    format: "sam-export-v1",
    account,
    memories: await db.all("SELECT content, created_at FROM memories WHERE user_id=? ORDER BY id", userId),
    settings,
    assistants: await db.all("SELECT name, icon, instructions, created_at FROM assistants WHERE user_id=? ORDER BY id", userId),
    prompts: await db.all("SELECT title, body, created_at FROM prompts WHERE user_id=? ORDER BY id", userId),
    conversations,
    usage: await db.all("SELECT provider, model, mode, input_tokens, output_tokens, created_at FROM usage_log WHERE user_id=? ORDER BY id", userId)
  };
}

// Permanently removes everything belonging to the user.
async function deleteUserData(userId) {
  await db.tx(async t => {
    for (const table of ["messages", "conversations", "memories", "usage_log", "password_resets", "assistants", "prompts"]) {
      await t.run(`DELETE FROM ${table} WHERE user_id=?`, userId);
    }
    await t.run("UPDATE error_log SET user_id=NULL WHERE user_id=?", userId);
    await t.run("DELETE FROM users WHERE id=?", userId);
  });
}

module.exports = { createResetToken, consumeResetToken, setPasswordHash, exportUserData, deleteUserData, sha256 };
