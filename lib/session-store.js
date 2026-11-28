// Login sessions stored in Sam's own database (SQLite or Postgres), so people stay logged in across restarts.
const session = require("express-session");
const { db } = require("./db");

const DAY = 24 * 60 * 60 * 1000;

class DbSessionStore extends session.Store {
  constructor({ clearEveryMs = 15 * 60 * 1000 } = {}) {
    super();
    if (clearEveryMs) this.timer = setInterval(() => this.clearExpired().catch(() => {}), clearEveryMs).unref();
  }
  expiry(sess) {
    const exp = sess?.cookie?.expires ? new Date(sess.cookie.expires).getTime() : NaN;
    return Number.isFinite(exp) ? exp : Date.now() + DAY;
  }
  get(sid, cb) {
    db.get("SELECT sess, expire FROM user_sessions WHERE sid=?", sid)
      .then(row => {
        if (!row || Number(row.expire) <= Date.now()) return cb(null, null);
        try { cb(null, JSON.parse(row.sess)); } catch { cb(null, null); }
      }, cb);
  }
  set(sid, sess, cb = () => {}) {
    db.run(
      "INSERT INTO user_sessions(sid, sess, expire) VALUES(?,?,?) ON CONFLICT(sid) DO UPDATE SET sess=excluded.sess, expire=excluded.expire",
      sid, JSON.stringify(sess), this.expiry(sess)
    ).then(() => cb(null), cb);
  }
  touch(sid, sess, cb = () => {}) {
    db.run("UPDATE user_sessions SET expire=? WHERE sid=?", this.expiry(sess), sid).then(() => cb(null), cb);
  }
  destroy(sid, cb = () => {}) {
    db.run("DELETE FROM user_sessions WHERE sid=?", sid).then(() => cb(null), cb);
  }
  clearExpired() { return db.run("DELETE FROM user_sessions WHERE expire <= ?", Date.now()); }
}

module.exports = { DbSessionStore };
