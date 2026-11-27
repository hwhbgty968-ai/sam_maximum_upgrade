// Structured JSON logging + a persistent error log the admin dashboard can read.
const { db } = require("./db");

function log(level, msg, extra = {}) {
  const line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...extra });
  (level === "error" ? console.error : level === "warn" ? console.warn : console.log)(line);
}

let inserts = 0;
function logError({ requestId, userId, route, error }) {
  const message = String(error?.message || error || "Unknown error").slice(0, 2000);
  const stack = String(error?.stack || "").slice(0, 8000);
  log("error", message, { requestId, userId, route });
  try {
    db.prepare("INSERT INTO error_log(request_id,user_id,route,message,stack) VALUES(?,?,?,?,?)")
      .run(requestId || null, userId || null, route || null, message, stack);
    // Keep the table from growing forever: trim to the newest 5000 rows now and then.
    if (++inserts % 100 === 0) db.prepare("DELETE FROM error_log WHERE id <= (SELECT MAX(id) - 5000 FROM error_log)").run();
  } catch (e) {
    console.error("[sam] could not write error log:", e.message);
  }
}

module.exports = { log, logError };
