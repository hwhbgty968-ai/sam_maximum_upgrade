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
  // Never throws and never waits: logging an error must not cause another one.
  return db.run("INSERT INTO error_log(request_id,user_id,route,message,stack) VALUES(?,?,?,?,?)",
    requestId || null, userId || null, route || null, message, stack)
    .then(() => {
      // Keep the table from growing forever: trim to the newest 5000 rows now and then.
      if (++inserts % 100 === 0) return db.run("DELETE FROM error_log WHERE id <= (SELECT MAX(id) - 5000 FROM error_log)");
    })
    .catch(e => console.error("[sam] could not write error log:", e.message));
}

module.exports = { log, logError };
