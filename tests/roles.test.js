const assert = require("node:assert/strict");
const repo = process.argv[2] || require("path").join(__dirname, "..");
const { t, done } = require("./_env")("roles");
process.env.SESSION_SECRET = "x".repeat(40);
const { db, init } = require(repo + "/lib/db.js");
const roles = require(repo + "/lib/roles.js");
const mailer = require(repo + "/lib/mailer.js");
// Capture emails instead of sending them.
const sent = []; mailer.configured = () => true; mailer.send = async m => { sent.push(m); return { ok: true }; };
const tokenOf = m => /#t=([A-Za-z0-9_-]+)/.exec(m.text)[1];
const user = async id => db.get("SELECT * FROM users WHERE id=?", id);

(async () => {
  await init();
  const mk = (name, role = "user") => db.insert("INSERT INTO users(username,password_hash,role) VALUES(?,?,?)", name, "h", role);

  await t("an older install's first admin becomes the Creator, keeping their username as the Creator username", async () => {
    const c = await mk("Sam_Creator_Owner_ziang", "admin"); await mk("later_admin", "admin");
    const id = await roles.ensureOwner(() => {});
    const me = await user(c);
    assert.equal(id, c); assert.equal(me.role, "owner"); assert.equal(me.creator_handle, "Sam_Creator_Owner_ziang");
    assert.equal((await db.get("SELECT role FROM users WHERE username='later_admin'")).role, "admin", "other admins stay admins");
    assert.equal(await roles.ensureOwner(() => {}), null, "runs once");
    assert.ok((await roles.auditList()).some(a => a.action === "owner_set"));
  });
  const owner = await user((await db.get("SELECT id FROM users WHERE role='owner'")).id);

  await t("1. the Creator claims an available username", async () => {
    assert.equal(await roles.claimHandle(owner, "RyderBuilds"), "RyderBuilds");
    assert.equal((await user(owner.id)).creator_handle, "RyderBuilds");
    assert.ok((await roles.auditList()).some(a => a.action === "handle_claimed" && /@RyderBuilds \(was @Sam_Creator_Owner_ziang\)/.test(a.detail)));
  });

  await t("2–4. a taken name (any case) is refused with suggestions that are all really available", async () => {
    await mk("Alex"); await mk("AlexAI"); await mk("TheRealAlex");
    const err = await roles.claimHandle(owner, "alex").catch(e => e);
    assert.equal(err.status, 409); assert.match(err.message, /already taken/);
    assert.ok(err.suggestions.length >= 5, JSON.stringify(err.suggestions));
    assert.ok(!err.suggestions.some(s => ["alexai", "therealalex"].includes(s.toLowerCase())), "taken ideas are filtered out");
    const used = await roles.takenSet(err.suggestions, owner.id);
    assert.equal(used.size, 0, "every suggestion checked against the database");
    assert.ok(err.suggestions.every(s => /alex/i.test(s) && roles.HANDLE_RE.test(s)), "based on what they typed");
    const chk = await roles.checkName("ALEX", { kind: "handle", exceptUserId: owner.id });
    assert.equal(chk.available, false); assert.ok(chk.suggestions.length);
    assert.equal((await roles.checkName("ezer", { kind: "handle" })).available, false, "reserved names");
    assert.equal((await roles.checkName("FreshName", { kind: "handle", exceptUserId: owner.id })).available, true);
    assert.equal((await roles.checkName("RyderBuilds", { kind: "handle", exceptUserId: owner.id })).available, true, "your own name counts as yours");
  });

  await t("5. two claims of the same name at the same moment: exactly one wins", async () => {
    const other = await mk("racer_one");
    // Login sign-ups and the Creator claim share one namespace and one lock.
    const signup = name => db.tx(async tx => { await roles.nameLock(tx); if ((await roles.takenSet([name], 0, tx)).size) return null; return tx.insert("INSERT INTO users(username,password_hash) VALUES(?,?)", name, "h"); });
    const results = await Promise.allSettled([roles.claimHandle(owner, "SameNameZ"), signup("samenamez"), signup("SAMENAMEZ")]);
    const wins = results.filter(r => r.status === "fulfilled" && r.value);
    assert.equal(wins.length, 1, JSON.stringify(results.map(r => r.status + ":" + (r.value ?? r.reason?.message))));
    const n = Number((await db.get("SELECT COUNT(*) AS c FROM users WHERE lower(username)='samenamez' OR lower(creator_handle)='samenamez'")).c);
    assert.equal(n, 1);
    assert.ok(other);
  });

  await t("only the Creator can have a Creator username", async () => {
    const a = await user(await mk("plain_admin", "admin"));
    await assert.rejects(roles.claimHandle(a, "AdminHandle"), /Only the Creator/);
  });

  let invitee, token;
  await t("6. the Creator sends an Admin invitation (email, single-use token, expiry); duplicates blocked", async () => {
    const inv = await roles.createInvite(owner, "  New.Admin@Example.com ", "https://ezer.test/");
    assert.equal(inv.email, "new.admin@example.com");
    assert.equal(sent.length, 1); assert.equal(sent[0].to, "new.admin@example.com");
    assert.match(sent[0].text, /https:\/\/ezer\.test\/invite#t=[A-Za-z0-9_-]{40,}/);
    token = tokenOf(sent[0]);
    const row = await db.get("SELECT * FROM admin_invites WHERE id=?", inv.id);
    assert.notEqual(row.token_hash, token, "only a hash of the token is stored"); assert.equal(row.token_hash, roles.sha(token));
    await assert.rejects(roles.createInvite(owner, "new.admin@example.com", "https://ezer.test"), /already a pending invitation/);
    const look = await roles.lookupInvite(token);
    assert.deepEqual([look.status, look.email], ["pending", "n***n@example.com"], "the link shows a masked address only");
    assert.ok((await roles.auditList()).some(a => a.action === "invite_sent"));
  });

  await t("9–10. Admins and ordinary users can't invite, revoke or claim", async () => {
    const adm = await user((await db.get("SELECT id FROM users WHERE username='plain_admin'")).id);
    const usr = await user((await db.get("SELECT id FROM users WHERE username='Alex'")).id);
    for (const who of [adm, usr]) {
      await assert.rejects(roles.createInvite(who, "x@example.com", "https://e"), /Only the Creator can invite/);
      await assert.rejects(roles.revokeInvite(who, 1), /Only the Creator/);
      await assert.rejects(roles.removeAdmin(who, adm.id), /Only the Creator/);
    }
    assert.equal(sent.length, 1, "no email went out");
  });

  await t("13. a different email address can't accept the invitation", async () => {
    invitee = await user(await mk("future_admin"));
    const e = await roles.acceptInvite(invitee, token, "someone.else@example.com").catch(x => x);
    assert.equal(e.status, 403); assert.match(e.message, /isn't the email address this invitation was sent to/);
    assert.equal((await user(invitee.id)).role, "user");
    assert.ok((await roles.auditList()).some(a => a.action === "invite_email_mismatch"));
  });

  await t("7–8. the intended recipient accepts and becomes an Admin (email linked)", async () => {
    const r = await roles.acceptInvite(invitee, token, "NEW.ADMIN@example.com");
    assert.equal(r.role, "admin");
    const me = await user(invitee.id);
    assert.equal(me.role, "admin"); assert.equal(me.email, "new.admin@example.com");
    const row = await db.get("SELECT status, accepted_by FROM admin_invites WHERE token_hash=?", roles.sha(token));
    assert.deepEqual([row.status, row.accepted_by], ["accepted", invitee.id]);
    assert.ok((await roles.auditList()).some(a => a.action === "admin_added"));
  });

  await t("12. a used token can't be used again (by anyone)", async () => {
    const again = await roles.acceptInvite(invitee, token, "new.admin@example.com").catch(x => x);
    assert.equal(again.code, "INVITE_USED");
    const thief = await user(await mk("token_thief"));
    assert.equal((await roles.acceptInvite(thief, token, "new.admin@example.com").catch(x => x)).code, "INVITE_USED");
    assert.equal((await user(thief.id)).role, "user");
  });

  await t("a token accepted twice at the same moment only works once", async () => {
    await roles.createInvite(owner, "race@example.com", "https://e"); const tk = tokenOf(sent.at(-1));
    const a = await user(await mk("race_a")), b = await user(await mk("race_b"));
    const r = await Promise.allSettled([roles.acceptInvite(a, tk, "race@example.com"), roles.acceptInvite(b, tk, "race@example.com")]);
    assert.equal(r.filter(x => x.status === "fulfilled").length, 1, JSON.stringify(r.map(x => x.status + ":" + (x.reason?.message || ""))));
    assert.equal(Number((await db.get("SELECT COUNT(*) AS c FROM users WHERE username IN ('race_a','race_b') AND role='admin'")).c), 1);
  });

  await t("11. revoked and expired invitations can't be accepted", async () => {
    const inv = await roles.createInvite(owner, "revoke.me@example.com", "https://e"); const tk = tokenOf(sent.at(-1));
    await roles.revokeInvite(owner, inv.id);
    assert.equal((await roles.lookupInvite(tk)).status, "revoked");
    const u1 = await user(await mk("would_be1"));
    assert.equal((await roles.acceptInvite(u1, tk, "revoke.me@example.com").catch(x => x)).code, "INVITE_REVOKED");
    await assert.rejects(roles.revokeInvite(owner, inv.id), /Only pending/);
    await roles.createInvite(owner, "revoke.me@example.com", "https://e"); // a new one can be sent after revoking
    const tk2 = tokenOf(sent.at(-1));
    await db.run("UPDATE admin_invites SET expires_at='2000-01-01 00:00:00' WHERE token_hash=?", roles.sha(tk2));
    assert.equal((await roles.lookupInvite(tk2)).status, "expired");
    assert.equal((await roles.acceptInvite(u1, tk2, "revoke.me@example.com").catch(x => x)).code, "INVITE_EXPIRED");
    assert.equal((await user(u1.id)).role, "user");
    assert.deepEqual((await roles.listInvites()).filter(i => i.email === "revoke.me@example.com").map(i => i.status).sort(), ["expired", "revoked"]);
  });

  await t("invitation for an email that's already an admin is refused; Creator can't be made admin by an invite", async () => {
    await assert.rejects(roles.createInvite(owner, "new.admin@example.com", "https://e"), /already belongs to an admin/);
    await roles.createInvite(owner, "owner.addr@example.com", "https://e");
    assert.match((await roles.acceptInvite(owner, tokenOf(sent.at(-1)), "owner.addr@example.com").catch(x => x)).message, /You're the Creator already/);
    assert.equal((await user(owner.id)).role, "owner");
  });

  await t("bad addresses, bad tokens, and email not set up are clear errors (no fake success)", async () => {
    await assert.rejects(roles.createInvite(owner, "not-an-email", "https://e"), /valid email/);
    await assert.rejects(roles.lookupInvite("short"), /isn't valid/);
    await assert.rejects(roles.lookupInvite("x".repeat(43)), /isn't valid/);
    const keep = mailer.configured; mailer.configured = () => false;
    const before = Number((await db.get("SELECT COUNT(*) AS c FROM admin_invites")).c);
    await assert.rejects(roles.createInvite(owner, "later@example.com", "https://e"), /Email sending isn't set up/);
    assert.equal(Number((await db.get("SELECT COUNT(*) AS c FROM admin_invites")).c), before, "nothing created");
    mailer.configured = keep;
    const keepSend = mailer.send; mailer.send = async () => { throw Object.assign(new Error("The email couldn't be sent."), { status: 502 }); };
    await assert.rejects(roles.createInvite(owner, "bounce@example.com", "https://e"), /couldn't be sent/);
    assert.equal(await db.get("SELECT 1 AS x FROM admin_invites WHERE email='bounce@example.com'"), undefined ?? (await db.get("SELECT 1 AS x FROM admin_invites WHERE email='bounce@example.com'")));
    assert.ok(!(await db.get("SELECT 1 AS x FROM admin_invites WHERE email='bounce@example.com'")), "an undelivered invite is removed");
    mailer.send = keepSend;
  });

  await t("14. the Creator stays protected; admins can be removed only by the Creator", async () => {
    await assert.rejects(roles.removeAdmin(owner, owner.id), /Creator's role can't be changed/);
    assert.equal(await roles.removeAdmin(owner, invitee.id), true);
    assert.equal((await user(invitee.id)).role, "user");
    assert.equal((await user(owner.id)).role, "owner");
    assert.equal(Number((await db.get("SELECT COUNT(*) AS c FROM users WHERE role='owner'")).c), 1);
    const ov = await roles.creatorOverview(owner);
    assert.equal(ov.profile.handle, "SameNameZ".length && (await user(owner.id)).creator_handle);
    assert.ok(ov.audit.length > 5 && ov.invites.length >= 5);
  });

  done("roles.js");
  process.exit(process.exitCode || 0);
})();
