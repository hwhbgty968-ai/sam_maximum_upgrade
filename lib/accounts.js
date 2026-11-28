// Account data operations: password reset tokens, data export, account deletion.
const crypto = require("crypto");
const { db } = require("./db");

const sha256 = s => crypto.createHash("sha256").update(s).digest("hex");
const RESET_TTL_MINUTES = 60;

// One-time reset token. Only its hash is stored, so a leaked database can't be used to reset passwords.
function createResetToken(userId, createdBy = null) {
  const token = crypto.randomBytes(32).toString("hex");
  db.transaction(() => {
    db.prepare("UPDATE password_resets SET used_at=CURRENT_TIMESTAMP WHERE user_id=? AND used_at IS NULL").run(userId); // old links stop working
    db.prepare(`INSERT INTO password_resets(user_id, token_hash, expires_at, created_by) VALUES(?,?,datetime('now', ?),?)`)
      .run(userId, sha256(token), `+${RESET_TTL_MINUTES} minutes`, createdBy);
  })();
  return { token, expiresInMinutes: RESET_TTL_MINUTES };
}

// Returns the user id if the token is valid, and marks it used. Returns null otherwise.
function consumeResetToken(token) {
  if (!/^[a-f0-9]{64}$/.test(String(token || ""))) return null;
  return db.transaction(() => {
    const row = db.prepare(
      "SELECT id, user_id FROM password_resets WHERE token_hash=? AND used_at IS NULL AND expires_at > datetime('now')"
    ).get(sha256(token));
    if (!row) return null;
    db.prepare("UPDATE password_resets SET used_at=CURRENT_TIMESTAMP WHERE id=?").run(row.id);
    return row.user_id;
  })();
}

// Changing the password stamps password_changed_at; requireAuth compares it with the session,
// so every other logged-in device is signed out automatically.
function setPasswordHash(userId, hash) {
  const stamp = new Date().toISOString();
  db.prepare("UPDATE users SET password_hash=?, password_changed_at=? WHERE id=?").run(hash, stamp, userId);
  return stamp;
}

function exportUserData(userId) {
  const account = db.prepare("SELECT username, age, created_at, last_login_at FROM users WHERE id=?").get(userId);
  const conversations = db.prepare("SELECT id, title, mode, created_at, updated_at FROM conversations WHERE user_id=? ORDER BY id").all(userId);
  const msgStmt = db.prepare("SELECT role, content, model, pinned, meta, created_at FROM messages WHERE user_id=? AND conversation_id=? ORDER BY id");
  for (const c of conversations) c.messages = msgStmt.all(userId, c.id);
  return {
    exportedAt: new Date().toISOString(),
    format: "sam-export-v1",
    account,
    memories: db.prepare("SELECT content, created_at FROM memories WHERE user_id=? ORDER BY id").all(userId),
    conversations,
    usage: db.prepare("SELECT provider, model, mode, input_tokens, output_tokens, created_at FROM usage_log WHERE user_id=? ORDER BY id").all(userId)
  };
}

// Permanently removes everything belonging to the user.
function deleteUserData(userId) {
  db.transaction(() => {
    for (const t of ["messages", "conversations", "memories", "usage_log", "password_resets"]) {
      db.prepare(`DELETE FROM ${t} WHERE user_id=?`).run(userId);
    }
    db.prepare("UPDATE error_log SET user_id=NULL WHERE user_id=?").run(userId);
    db.prepare("DELETE FROM users WHERE id=?").run(userId);
  })();
}

module.exports = { createResetToken, consumeResetToken, setPasswordHash, exportUserData, deleteUserData, sha256 };
