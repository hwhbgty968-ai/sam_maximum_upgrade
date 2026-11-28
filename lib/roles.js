// Roles, the Creator area and admin invitations.
//
// Roles (users.role):  owner = the Creator (exactly one, protected)  ·  admin  ·  user.  Guests have no account.
// - Every check happens here, on the server. Nobody can change their own role.
// - Only the Owner can add Admins, and only by an email invitation the invitee accepts.
//   Admins can't invite or promote anyone, and nobody can become Owner through the app
//   (the first Owner comes from the one-time setup code, or from the first admin of an older install).
// - Creator usernames ("handles") and login usernames share one case-insensitive namespace, so a handle
//   can't copy anyone's login name (or the other way round). Claims are serialised by a lock and a unique index.
// - Every role change, invitation and handle change is written to audit_log.
const crypto = require("crypto");
const { db, engine } = require("./db");
const mailer = require("./mailer");

const httpError = (status, message, extra = {}) => Object.assign(new Error(message), { status, ...extra });
const ROLES = ["owner", "admin", "user"];
const isOwner = u => !!u && u.role === "owner" && !u.disabled;
const isAdmin = u => !!u && (u.role === "admin" || u.role === "owner") && !u.disabled;

// ---------------------------------------------------------------- Audit log
async function audit(t, { actorId = null, action, targetId = null, detail = null }) {
  await (t || db).run("INSERT INTO audit_log(actor_id, action, target_id, detail) VALUES(?,?,?,?)",
    actorId, action, targetId, detail == null ? null : (typeof detail === "string" ? detail : JSON.stringify(detail)).slice(0, 500));
}
async function auditList(limit = 50) {
  return db.all(`SELECT a.id, a.action, a.detail, a.created_at, ua.username AS actor, ut.username AS target
    FROM audit_log a LEFT JOIN users ua ON ua.id=a.actor_id LEFT JOIN users ut ON ut.id=a.target_id ORDER BY a.id DESC LIMIT ?`, Math.min(Number(limit) || 50, 200));
}

// ---------------------------------------------------------------- Owner
// Older installs (v4.0–4.4) had admins but no owner: the first admin (the one who used the setup code) becomes the Owner.
async function ensureOwner(say = console.log) {
  if (await db.get("SELECT 1 AS x FROM users WHERE role='owner'")) return null;
  const first = await db.get("SELECT id, username FROM users WHERE role='admin' AND COALESCE(disabled,0)=0 ORDER BY id LIMIT 1");
  if (!first) return null;
  await db.tx(async t => {
    await t.run("UPDATE users SET role='owner' WHERE id=?", first.id);
    await audit(t, { actorId: null, action: "owner_set", targetId: first.id, detail: "first admin of an older install became the Creator (owner)" });
    if (validHandle(first.username)) {
      const clash = await t.get("SELECT 1 AS x FROM users WHERE id<>? AND (lower(creator_handle)=lower(?) OR lower(username)=lower(?))", first.id, first.username, first.username);
      if (!clash) {
        await t.run("UPDATE users SET creator_handle=? WHERE id=? AND creator_handle IS NULL", first.username, first.id);
        await audit(t, { actorId: first.id, action: "handle_claimed", targetId: first.id, detail: `@${first.username} (kept from the existing username)` });
      }
    }
  });
  say(`[ezer] ${first.username} is now the Creator (owner).`);
  return first.id;
}

// ---------------------------------------------------------------- Names (login usernames + Creator handles)
const HANDLE_RE = /^[A-Za-z0-9_]{3,24}$/;
const USERNAME_RE = /^[a-zA-Z0-9_-]{3,24}$/;
const RESERVED = new Set(["admin", "administrator", "owner", "creator", "ezer", "sam", "support", "help", "root", "system", "moderator", "staff", "official", "security", "null", "undefined", "guest"]);
const validHandle = h => HANDLE_RE.test(String(h || "")) && !RESERVED.has(String(h).toLowerCase());

// One lock for every name change, so two people can't take the same name at the same moment.
async function nameLock(t) { if (engine === "postgres") await t.get("SELECT pg_advisory_xact_lock(424242) AS l"); }

// Which of these names are already used (as a login username or a Creator handle) by someone other than exceptUserId?
async function takenSet(names, exceptUserId = 0, t = db) {
  const lower = [...new Set(names.map(n => String(n).toLowerCase()))];
  if (!lower.length) return new Set();
  const marks = lower.map(() => "?").join(",");
  const rows = await t.all(`SELECT lower(username) AS u, lower(creator_handle) AS h FROM users WHERE id<>? AND (lower(username) IN (${marks}) OR lower(creator_handle) IN (${marks}))`,
    exceptUserId, ...lower, ...lower);
  const used = new Set();
  for (const r of rows) { if (r.u) used.add(r.u); if (r.h) used.add(r.h); }
  for (const n of lower) if (RESERVED.has(n)) used.add(n);
  return used;
}

// Suggestions built from what the person typed; every one is checked against the database before it's shown.
async function suggestions(base, { kind = "handle", exceptUserId = 0, count = 5 } = {}) {
  const re = kind === "handle" ? HANDLE_RE : USERNAME_RE;
  let core = String(base || "").replace(kind === "handle" ? /[^A-Za-z0-9_]/g : /[^A-Za-z0-9_-]/g, "").slice(0, 16);
  if (core.length < 2) core = "Ezer" + core;
  const cap = core[0].toUpperCase() + core.slice(1);
  const year = new Date().getUTCFullYear();
  const rand = () => String(crypto.randomInt(10, 999));
  const ideas = [core + "AI", core + "Official", "TheReal" + cap, core + "Studio", core + "Creator", core + "HQ", core + "Labs",
    core + "_" + year, "Its" + cap, core + "Hub", core + "_" + rand(), core + rand(), cap + "Works", "Hey" + cap, core + "_" + rand()];
  const fit = [...new Set(ideas.filter(n => re.test(n) && !RESERVED.has(n.toLowerCase())))];
  const used = await takenSet(fit, exceptUserId);
  const out = fit.filter(n => !used.has(n.toLowerCase()));
  // If almost everything is taken, keep trying random numbers (each still checked).
  for (let i = 0; out.length < count && i < 10; i++) {
    const n = (core.slice(0, 18) + "_" + crypto.randomInt(100, 99999)).slice(0, 24);
    if (re.test(n) && !(await takenSet([n], exceptUserId)).size && !out.includes(n)) out.push(n);
  }
  return out.slice(0, count);
}

async function checkName(name, { kind = "handle", exceptUserId = 0 } = {}) {
  const n = String(name || "").trim();
  const re = kind === "handle" ? HANDLE_RE : USERNAME_RE;
  if (!re.test(n)) return { available: false, reason: kind === "handle" ? "Use 3–24 letters, numbers or _." : "Use 3–24 letters, numbers, _ or -.", suggestions: n.length >= 2 ? await suggestions(n, { kind, exceptUserId }) : [] };
  if (RESERVED.has(n.toLowerCase())) return { available: false, reason: "That name is reserved.", suggestions: await suggestions(n, { kind, exceptUserId }) };
  if ((await takenSet([n], exceptUserId)).size) return { available: false, reason: `"${n}" is already taken.`, suggestions: await suggestions(n, { kind, exceptUserId }) };
  return { available: true };
}

// Creator handle: Owner only. Final check inside the lock + unique index, so a race can't produce duplicates.
async function claimHandle(user, handle) {
  if (!isOwner(user)) throw httpError(403, "Only the Creator can have a Creator username.");
  const h = String(handle || "").trim();
  if (!HANDLE_RE.test(h)) throw httpError(400, "Use 3–24 letters, numbers or _.", { suggestions: h.length >= 2 ? await suggestions(h, { exceptUserId: user.id }) : [] });
  try {
    await db.tx(async t => {
      await nameLock(t);
      if ((await takenSet([h], user.id, t)).size) throw httpError(409, `"${h}" is already taken.`, { code: "NAME_TAKEN" });
      const before = await t.get("SELECT creator_handle FROM users WHERE id=?", user.id);
      await t.run("UPDATE users SET creator_handle=? WHERE id=?", h, user.id);
      await audit(t, { actorId: user.id, action: "handle_claimed", targetId: user.id, detail: `@${h}` + (before?.creator_handle ? ` (was @${before.creator_handle})` : "") });
    });
  } catch (e) {
    const dup = e.code === "23505" || /UNIQUE constraint/i.test(e.message || "");
    if (e.code === "NAME_TAKEN" || dup) throw httpError(409, `"${h}" is already taken.`, { code: "NAME_TAKEN", suggestions: await suggestions(h, { exceptUserId: user.id }) });
    throw e;
  }
  return h;
}

// ---------------------------------------------------------------- Admin removal (Owner only)
async function removeAdmin(actor, userId) {
  if (!isOwner(actor)) throw httpError(403, "Only the Creator can change admin rights.");
  const target = await db.get("SELECT id, role, username FROM users WHERE id=?", userId);
  if (!target) throw httpError(404, "User not found.");
  if (target.role === "owner") throw httpError(403, "The Creator's role can't be changed.");
  if (target.role !== "admin") return false;
  await db.tx(async t => {
    await t.run("UPDATE users SET role='user' WHERE id=? AND role='admin'", userId);
    await audit(t, { actorId: actor.id, action: "admin_removed", targetId: userId });
  });
  return true;
}

// ---------------------------------------------------------------- Admin invitations (Owner only)
const EMAIL_RE = /^[^\s@<>"',;]{1,64}@[^\s@<>"',;]{1,190}\.[A-Za-z]{2,}$/;
const normEmail = e => String(e || "").trim().toLowerCase();
const sha = s => crypto.createHash("sha256").update(String(s)).digest("hex");
const expiryHours = () => Math.min(Math.max(Number(process.env.INVITE_EXPIRY_HOURS) || 72, 1), 24 * 30);
const sqlTime = d => d.toISOString().slice(0, 19).replace("T", " ");
const maskEmail = e => { const [u, d] = String(e).split("@"); return (u.length <= 2 ? u[0] + "*" : u[0] + "***" + u.slice(-1)) + "@" + d; };

async function expireOld(t = db) {
  const n = await t.run("UPDATE admin_invites SET status='expired' WHERE status='pending' AND expires_at <= ?", sqlTime(new Date()));
  return n;
}

async function createInvite(actor, email, baseUrl) {
  if (!isOwner(actor)) throw httpError(403, "Only the Creator can invite admins.");
  const to = normEmail(email);
  if (!EMAIL_RE.test(to) || to.length > 254) throw httpError(400, "Enter a valid email address.");
  if (!mailer.configured()) throw httpError(503, "Email sending isn't set up yet, so the invitation can't be delivered. Add SMTP_USER and SMTP_PASS in Render → Environment (a Gmail address and a Google app password work), then try again.", { code: "MAIL_NOT_CONFIGURED" });
  const existing = await db.get("SELECT id, role FROM users WHERE lower(email)=?", to);
  if (existing && (existing.role === "admin" || existing.role === "owner")) throw httpError(409, "That email already belongs to an admin.");
  const token = crypto.randomBytes(32).toString("base64url");
  const expires = new Date(Date.now() + expiryHours() * 3600e3);
  let id;
  await db.tx(async t => {
    await expireOld(t);
    if (await t.get("SELECT 1 AS x FROM admin_invites WHERE lower(email)=? AND status='pending'", to)) throw httpError(409, "There's already a pending invitation for that email. Revoke it first if you want to send a new one.", { code: "INVITE_PENDING" });
    id = await t.insert("INSERT INTO admin_invites(email, token_hash, invited_by, status, expires_at) VALUES(?,?,?,'pending',?)", to, sha(token), actor.id, sqlTime(expires));
    await audit(t, { actorId: actor.id, action: "invite_sent", detail: { inviteId: id, email: to, expires: sqlTime(expires) } });
  });
  // The link carries the token after "#", so it never reaches server logs or other sites.
  const link = `${String(baseUrl).replace(/\/+$/, "")}/invite#t=${token}`;
  const who = actor.creator_handle ? `@${actor.creator_handle}` : actor.username;
  try {
    await mailer.send({
      to,
      subject: "You've been invited to be an admin of Ezer",
      text: `Hi,\n\n${who}, the Creator of Ezer, has invited you to be an admin.\n\nTo accept, open this link (it works once and expires on ${expires.toUTCString()}):\n${link}\n\nYou'll need to log in to Ezer (or create a free account) and confirm this email address.\nIf you weren't expecting this, you can ignore this email.\n\n— Ezer · One platform. Endless possibilities.`,
      html: `<p>Hi,</p><p><b>${escapeHtml(who)}</b>, the Creator of Ezer, has invited you to be an <b>admin</b>.</p><p><a href="${link}">Accept the invitation</a></p><p>The link works once and expires on ${expires.toUTCString()}. You'll need to log in to Ezer (or create a free account) and confirm this email address.</p><p style="color:#777">If you weren't expecting this, you can ignore this email.<br>— Ezer · One platform. Endless possibilities.</p>`
    });
  } catch (e) {
    await db.run("DELETE FROM admin_invites WHERE id=?", id); // not delivered → not an invitation
    await audit(null, { actorId: actor.id, action: "invite_failed", detail: { email: to } });
    throw e;
  }
  return { id, email: to, expiresAt: sqlTime(expires) };
}

async function listInvites() {
  await expireOld();
  return db.all(`SELECT i.id, i.email, i.status, i.created_at, i.expires_at, i.accepted_at, i.revoked_at, ua.username AS accepted_by
    FROM admin_invites i LEFT JOIN users ua ON ua.id=i.accepted_by ORDER BY i.id DESC LIMIT 100`);
}

async function revokeInvite(actor, id) {
  if (!isOwner(actor)) throw httpError(403, "Only the Creator can revoke invitations.");
  await expireOld();
  const n = await db.tx(async t => {
    const changed = await t.run("UPDATE admin_invites SET status='revoked', revoked_at=datetime('now') WHERE id=? AND status='pending'", id);
    if (changed) await audit(t, { actorId: actor.id, action: "invite_revoked", detail: { inviteId: id } });
    return changed;
  });
  if (!n) throw httpError(409, "Only pending invitations can be revoked.");
  return true;
}

// Anyone with the link can see what it's for (masked), never the full address or anything secret.
async function lookupInvite(token) {
  if (!token || String(token).length < 20) throw httpError(404, "This invitation link isn't valid.");
  await expireOld();
  const inv = await db.get("SELECT email, status, expires_at FROM admin_invites WHERE token_hash=?", sha(token));
  if (!inv) throw httpError(404, "This invitation link isn't valid.");
  return { status: inv.status, email: maskEmail(inv.email), expiresAt: inv.expires_at };
}

// Accepting: must be logged in, must type the invited email (proving it's theirs: the link was only sent there),
// and the token works exactly once. Admin rights are given only here.
async function acceptInvite(user, token, email) {
  if (!user || user.disabled) throw httpError(401, "Please log in first.");
  if (!token || String(token).length < 20) throw httpError(404, "This invitation link isn't valid.");
  const typed = normEmail(email);
  try { return await acceptTx(user, token, typed); }
  catch (e) {
    // Logged outside the (rolled-back) transaction, so refused attempts are always on record.
    if (e.code === "INVITE_EMAIL_MISMATCH" || e.code === "INVITE_USED") await audit(null, { actorId: user.id, action: e.code === "INVITE_USED" ? "invite_reuse_blocked" : "invite_email_mismatch", detail: { tokenHash: sha(token).slice(0, 12) } }).catch(() => {});
    throw e;
  }
}
async function acceptTx(user, token, typed) {
  return db.tx(async t => {
    await expireOld(t);
    await t.run("UPDATE admin_invites SET status=status WHERE token_hash=?", sha(token)); // row lock (Postgres)
    const inv = await t.get("SELECT id, email, status, invited_by FROM admin_invites WHERE token_hash=?", sha(token));
    if (!inv) throw httpError(404, "This invitation link isn't valid.");
    if (inv.status === "accepted") throw httpError(410, "This invitation has already been used.", { code: "INVITE_USED" });
    if (inv.status === "revoked") throw httpError(410, "This invitation was revoked by the Creator.", { code: "INVITE_REVOKED" });
    if (inv.status === "expired") throw httpError(410, "This invitation has expired. Ask the Creator for a new one.", { code: "INVITE_EXPIRED" });
    if (typed !== inv.email) {
      throw httpError(403, "That isn't the email address this invitation was sent to. Invitations can only be accepted by the person they were sent to.", { code: "INVITE_EMAIL_MISMATCH" });
    }
    const me = await t.get("SELECT id, role, email FROM users WHERE id=?", user.id);
    if (me.role === "owner") throw httpError(400, "You're the Creator already.");
    if (me.email && normEmail(me.email) !== inv.email) throw httpError(403, "This account is linked to a different email address.", { code: "INVITE_EMAIL_MISMATCH" });
    const other = await t.get("SELECT id FROM users WHERE lower(email)=? AND id<>?", inv.email, user.id);
    if (other) throw httpError(409, "That email address is already linked to another Ezer account. Accept the invitation from that account.");
    const used = await t.run("UPDATE admin_invites SET status='accepted', accepted_by=?, accepted_at=datetime('now') WHERE id=? AND status='pending'", user.id, inv.id);
    if (!used) throw httpError(410, "This invitation has already been used.", { code: "INVITE_USED" });
    await t.run("UPDATE users SET role='admin', email=? WHERE id=? AND role<>'owner'", inv.email, user.id);
    await audit(t, { actorId: user.id, action: "invite_accepted", targetId: user.id, detail: { inviteId: inv.id, invitedBy: inv.invited_by } });
    await audit(t, { actorId: inv.invited_by, action: "admin_added", targetId: user.id, detail: "by invitation" });
    return { ok: true, role: "admin" };
  });
}

function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

async function creatorOverview(owner) {
  const me = await db.get("SELECT id, username, creator_handle, email, created_at FROM users WHERE id=?", owner.id);
  return {
    profile: { username: me.username, handle: me.creator_handle, email: me.email, since: me.created_at, role: "owner" },
    invites: await listInvites(),
    admins: await db.all("SELECT id, username, email, role, last_login_at FROM users WHERE role IN ('owner','admin') ORDER BY CASE role WHEN 'owner' THEN 0 ELSE 1 END, id"),
    audit: await auditList(40),
    mail: mailer.status(),
    inviteExpiryHours: expiryHours()
  };
}

module.exports = {
  ROLES, isOwner, isAdmin, audit, auditList, ensureOwner, nameLock, takenSet, suggestions, checkName, claimHandle, validHandle,
  removeAdmin, createInvite, listInvites, revokeInvite, lookupInvite, acceptInvite, creatorOverview, maskEmail, sha, expireOld, HANDLE_RE, USERNAME_RE
};
