// Multi-user smoke test. Start Sam first (npm start), then in another terminal: npm run test:smoke
// Options:
//   BASE_URL=https://your-sam.onrender.com npm run test:smoke      test a deployed copy
//   SMOKE_ADMIN_USER=you SMOKE_ADMIN_PASS='...' npm run test:smoke  also test the admin dashboard
//   SMOKE_ADMIN_SETUP_CODE=XXXX-XXXX-XXXX npm run test:smoke        on a brand-new Sam with no admin yet: a throwaway
//                                                                    account claims admin with the setup code from the logs
// Creates throwaway accounts (smokeA_…, smokeB_…). User B deletes itself at the end.
const BASE = (process.env.BASE_URL || "http://localhost:3000").replace(/\/$/, "");
let passed = 0, failed = 0;

function client() {
  let cookie = "";
  return async function call(method, url, body, headers = {}) {
    const res = await fetch(BASE + url, {
      method,
      headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined
    });
    const set = res.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0];
    const text = await res.text();
    let data = text;
    try { data = JSON.parse(text); } catch {}
    return { status: res.status, data, text, headers: res.headers };
  };
}

function check(name, ok, detail = "") {
  if (ok) { passed++; console.log("  ✅ " + name); }
  else { failed++; console.log("  ❌ " + name + (detail ? "  → " + String(detail).slice(0, 300) : "")); }
}

(async () => {
  console.log(`Testing Sam at ${BASE}\n`);
  const id = Date.now().toString(36);
  const A = client(), A2 = client(), B = client(), anon = client();
  const userA = "smokeA_" + id, userB = "smokeB_" + id;
  const pw = "test-password-" + id, pw2 = "new-password-" + id;

  console.log("Basics");
  const health = await anon("GET", "/healthz");
  check("health check responds", health.status === 200 && health.data.ok, health.text);
  const engine = health.data.database || "sqlite";
  console.log(`  (database: ${engine})`);
  const st = await anon("GET", "/api/status");
  check("status works logged out", st.status === 200 && st.data.loggedIn === false);
  check("every response has a request ID", !!st.headers.get("x-request-id"));
  const aiOn = !!st.data.aiConfigured;
  check("protected route needs login", (await anon("GET", "/api/conversations")).status === 401);
  check("unknown API route returns JSON 404", (await anon("GET", "/api/nope")).status === 404);

  console.log("\nAccounts");
  const ra = await A("POST", "/api/register", { username: userA, password: pw, age: 15 });
  check("user A can register", ra.status === 200 && ra.data.ok, ra.text);
  const rb = await B("POST", "/api/register", { username: userB, password: pw, age: 30 });
  check("user B can register", rb.status === 200 && rb.data.ok, rb.text);
  const young = await anon("POST", "/api/register", { username: userA + "_kid", password: pw, age: 12 });
  check("sign-up under 13 is refused", young.status === 400 && young.data.code === "TOO_YOUNG", young.text);
  const dup = await anon("POST", "/api/register", { username: userA.toUpperCase(), password: pw, age: 20 });
  check("duplicate username (different case) rejected", dup.status === 409, dup.text);
  const cr = await A("GET", "/api/credits");
  check("new account: a plan, a credit balance and published prices", cr.status === 200 && !!cr.data.plan?.label && (cr.data.plan.unlimited || cr.data.balance === cr.data.plan.monthlyCredits) && cr.data.costs?.fast >= 0, cr.text.slice(0, 200));
  check("no one can see or change credit settings without being admin", (await A("GET", "/api/admin/credits/config")).status === 403 && (await A("PUT", "/api/admin/credits/config", { config: {} })).status === 403);
  const sa = await A("GET", "/api/status");
  check("user A session sticks after register", sa.data.loggedIn === true && sa.data.username === userA, sa.text);
  check("user A is not an admin", sa.data.isAdmin === false);
  check("wrong password rejected", (await anon("POST", "/api/login", { username: userA, password: "wrong-password!!" })).status === 401);
  const a2 = await A2("POST", "/api/login", { username: userA, password: pw });
  check("user A can also log in on a second device", a2.status === 200, a2.text);

  console.log("\nPrivacy between users");
  const ca = await A("POST", "/api/conversations", { mode: "chat" });
  check("user A can create a chat", ca.status === 200 && ca.data.id, ca.text);
  check("user B CANNOT read user A's chat", (await B("GET", "/api/conversations/" + ca.data.id)).status === 404);
  check("user B CANNOT delete user A's chat", (await B("DELETE", "/api/conversations/" + ca.data.id)).status === 404);
  await A("POST", "/api/memories", { content: "A's private note " + id });
  await B("POST", "/api/memories", { content: "B's private note " + id });
  const memB = await B("GET", "/api/history");
  check("user B cannot see user A's memories", !JSON.stringify(memB.data).includes("A's private note " + id));
  check("user B cannot post into user A's chat", (await B("POST", "/api/chat", { message: "hi", conversationId: ca.data.id })).status === 404);

  console.log("\nSecurity");
  const evil = await A("POST", "/api/memories", { content: "from evil site" }, { Origin: "https://evil.example" });
  check("cross-site request blocked (CSRF)", evil.status === 403, evil.text);
  check("non-admin can't open admin API", (await A("GET", "/api/admin/overview")).status === 403);
  check("non-admin can't download a backup", (await A("GET", "/api/admin/backup/download")).status === 403);
  const claimBad = await A("POST", "/api/admin/claim", { code: "WRONG-CODE-0000" });
  check("wrong admin setup code rejected", claimBad.status === 400 || claimBad.status === 409, claimBad.text);
  check("bad ids give 404, not a server error", (await A("GET", "/api/conversations/abc")).status === 404 && (await A("GET", "/api/conversations/1.5")).status === 404 && (await A("DELETE", "/api/conversations/99999999999")).status === 404);

  if (aiOn) {
    console.log("\nAI");
    const t0 = Date.now();
    const chat = await A("POST", "/api/chat", { message: "Reply with just the word: pong", conversationId: ca.data.id, speed: "fast" });
    const events = chat.text.split("\n\n").filter(l => l.startsWith("data: ")).map(l => JSON.parse(l.slice(6)));
    const answer = events.filter(e => e.delta).map(e => e.delta).join("");
    const err = events.find(e => e.error);
    check(`AI replies (${((Date.now() - t0) / 1000).toFixed(1)}s, model: ${events.find(e => e.model)?.model || "?"})`, !err && answer.length > 0, err?.error || chat.text.slice(0, 300));
    const saved = await A("GET", "/api/conversations/" + ca.data.id);
    check("reply saved to chat history", saved.data.messages?.length >= 2, saved.text.slice(0, 200));
    const bill = events.find(e => e.done)?.credits;
    const after = await A("GET", "/api/credits");
    check("the answer reports its credit cost, and the balance matches", bill && (bill.unlimited || (bill.charged >= 0 && bill.balance === after.data.balance)), JSON.stringify(bill) + " / " + after.data.balance);
    const usage = await A("GET", "/api/usage");
    check("usage recorded for user A", usage.data.today?.requests >= 1, usage.text);
  } else {
    console.log("\n  ⏭  AI tests skipped — no AI key configured on the server");
  }

  console.log("\nChat management (v3.2)");
  const ren = await A("PATCH", "/api/conversations/" + ca.data.id, { title: "Smoke chat " + id });
  check("rename own chat", ren.status === 200 && ren.data.conversation?.title === "Smoke chat " + id, ren.text);
  check("user B can't rename A's chat", (await B("PATCH", "/api/conversations/" + ca.data.id, { title: "hacked" })).status === 404);
  check("pin own chat", (await A("PATCH", "/api/conversations/" + ca.data.id, { pinned: true })).data.conversation?.pinned === true);
  const listA = await A("GET", "/api/conversations");
  check("pinned chat listed first", listA.data.conversations?.[0]?.id === ca.data.id);
  const srA = await A("GET", "/api/search?q=" + encodeURIComponent("Smoke chat " + id));
  check("search finds own chat", srA.data.conversations?.some(c => c.id === ca.data.id), srA.text);
  const srB = await B("GET", "/api/search?q=" + encodeURIComponent("Smoke chat " + id));
  check("search never shows another user's chats", srB.status === 200 && !srB.data.conversations?.length && !srB.data.messages?.length, srB.text);
  check("archive own chat", (await A("PATCH", "/api/conversations/" + ca.data.id, { archived: true })).status === 200);
  check("archived chat hidden from main list", !(await A("GET", "/api/conversations")).data.conversations.some(c => c.id === ca.data.id));
  check("…and shown in the archive", (await A("GET", "/api/conversations?archived=1")).data.conversations.some(c => c.id === ca.data.id));
  await A("PATCH", "/api/conversations/" + ca.data.id, { archived: false });

  if (aiOn) {
    const parse = t => t.split("\n\n").filter(l => l.startsWith("data: ")).map(l => JSON.parse(l.slice(6)));
    const done = evs => evs.find(e => e.done) || {};
    const before = (await A("GET", "/api/conversations/" + ca.data.id)).data.messages.length;
    const rg = done(parse((await A("POST", "/api/chat", { regenerate: true, conversationId: ca.data.id, speed: "fast" })).text));
    const afterRg = (await A("GET", "/api/conversations/" + ca.data.id)).data.messages;
    check("regenerate replaces the last reply (same message count)", rg.assistantMessageId && afterRg.length === before, JSON.stringify(rg).slice(0, 200));
    check("user B can't regenerate in A's chat", (await B("POST", "/api/chat", { regenerate: true, conversationId: ca.data.id })).status === 404);
    const firstUser = afterRg.find(m => m.role === "user");
    const ed = done(parse((await A("POST", "/api/chat", { message: "Reply with just the word: edited", editMessageId: firstUser.id, conversationId: ca.data.id, speed: "fast" })).text));
    const afterEd = (await A("GET", "/api/conversations/" + ca.data.id)).data.messages;
    check("edit & resend replaces the message and what followed", ed.userMessageId && afterEd.length === 2 && afterEd[0].content.includes("edited"), JSON.stringify(afterEd).slice(0, 200));
    const pinR = await A("PATCH", "/api/messages/" + ed.assistantMessageId, { pinned: true });
    check("pin a message", pinR.status === 200);
    check("user B can't pin A's message", (await B("PATCH", "/api/messages/" + ed.assistantMessageId, { pinned: true })).status === 404);
    check("pinned message in Pins", (await A("GET", "/api/pins")).data.messages?.some(m => m.id === ed.assistantMessageId));
    check("B's Pins don't include A's", !(await B("GET", "/api/pins")).data.messages?.length);
    const models = (await A("GET", "/api/models")).data.models.filter(m => m.id !== "auto").slice(0, 2).map(m => m.id);
    const cc = await A("POST", "/api/conversations", { mode: "council" });
    const cdone = done(parse((await A("POST", "/api/chat", { message: "What is 2+2? One line.", conversationId: cc.data.id, mode: "council", councilModels: models })).text));
    check(`Sam Council with chosen members (${models.join(", ")})`, cdone.meta?.council?.length >= 1 && cdone.meta.council.every(m => models.includes(m.provider + ":" + m.model)), JSON.stringify(cdone).slice(0, 300));
  }

  console.log("\nPersonalisation (v3.3)");
  const st0 = await A("GET", "/api/settings");
  check("settings load with defaults", st0.status === 200 && st0.data.settings?.personality === "sam", st0.text);
  const st1 = await A("PUT", "/api/settings", { personality: "professional", theme: "light", accent: "blue", customInstructions: "Use British spelling" });
  check("settings save", st1.status === 200 && st1.data.settings.theme === "light", st1.text);
  check("invalid settings rejected", (await A("PUT", "/api/settings", { theme: "neon" })).status === 400);
  check("settings are per-user", (await B("GET", "/api/settings")).data.settings?.theme === "dark");
  const asA = await A("POST", "/api/assistants", { name: "Smoke Tutor", icon: "🧪", instructions: "Explain like a chemistry teacher." });
  check("create a custom assistant", asA.status === 200 && /^custom:\d+$/.test(asA.data.assistant?.id), asA.text);
  check("B doesn't see A's assistants", !(await B("GET", "/api/assistants")).data.assistants.some(x => x.id === asA.data.assistant.id));
  const bConv = await B("POST", "/api/conversations", { mode: "chat" });
  check("B can't use A's assistant", (await B("PATCH", "/api/conversations/" + bConv.data.id, { assistant: asA.data.assistant.id })).status === 400);
  check("A can put their assistant on a chat", (await A("PATCH", "/api/conversations/" + ca.data.id, { assistant: asA.data.assistant.id })).data.conversation?.assistant === asA.data.assistant.id);
  const prA = await A("POST", "/api/prompts", { title: "Smoke prompt", body: "Test [x]" });
  check("save a prompt", prA.status === 200, prA.text);
  check("B doesn't see A's prompts", !(await B("GET", "/api/prompts")).data.prompts.some(x => x.id === prA.data.prompt.id));
  const cat = await A("GET", "/api/models/catalog");
  check("model marketplace lists all providers", cat.status === 200 && cat.data.providers?.length === 4, cat.text);
  check("model marketplace never exposes API keys", !/sk-|AIza/.test(cat.text));
  if (aiOn) {
    const autoConv = await A("POST", "/api/conversations", { mode: "chat" });
    const ev = (await A("POST", "/api/chat", { message: "Why does my python code throw a TypeError? One line.", conversationId: autoConv.data.id, speed: "fast" })).text;
    check("auto task recognition kicks in (coding)", ev.includes('"auto":"Coding Assistant"'), ev.slice(0, 300));
  }
  await A("PUT", "/api/settings", { theme: "dark", accent: "silver", personality: "sam", customInstructions: "" });

  console.log("\nYour account");
  const exp = await A("GET", "/api/account/export");
  check("export contains A's own chat and memory", exp.status === 200 && exp.data.conversations?.some(c => c.id === ca.data.id) && exp.text.includes("A's private note " + id), exp.text.slice(0, 200));
  check("export does NOT contain B's data", !exp.text.includes("B's private note") && !exp.text.includes("password_hash"));
  const wrongPw = await A("POST", "/api/account/password", { current: "nope-nope-nope", next: pw2 });
  check("change password: wrong current password rejected (and you stay logged in)", wrongPw.status === 400 && (await A("GET", "/api/conversations")).status === 200, wrongPw.text);
  const ch = await A("POST", "/api/account/password", { current: pw, next: pw2 });
  check("change password works", ch.status === 200, ch.text);
  check("…this device stays logged in", (await A("GET", "/api/conversations")).status === 200);
  check("…other device is signed out", (await A2("GET", "/api/conversations")).status === 401);
  check("…old password no longer works", (await anon("POST", "/api/login", { username: userA, password: pw })).status === 401);

  await A("POST", "/api/logout");
  check("logout ends the session", (await A("GET", "/api/conversations")).status === 401);
  const relog = await A("POST", "/api/login", { username: userA.replace("smokeA", "SMOKEa"), password: pw2 });
  check("log back in (new password, any capitals)", relog.status === 200, relog.text);
  const again = await A("GET", "/api/conversations");
  check("chats still there after re-login", again.status === 200 && again.data.conversations.some(c => c.id === ca.data.id));

  if (process.env.SMOKE_ADMIN_USER || process.env.SMOKE_ADMIN_SETUP_CODE) {
    console.log("\nAdmin");
    const ADM = client();
    if (process.env.SMOKE_ADMIN_SETUP_CODE) {
      const admName = "smokeAdmin_" + id;
      check("admin-to-be registers", (await ADM("POST", "/api/register", { username: admName, password: pw, age: 30 })).status === 200);
      check("status says the admin setup is open", (await ADM("GET", "/api/status")).data.adminSetupOpen === true);
      const cl = await ADM("POST", "/api/admin/claim", { code: process.env.SMOKE_ADMIN_SETUP_CODE });
      check("setup code makes them the first admin", cl.status === 200 && cl.data.isAdmin, cl.text);
      check("…the code can't be used again", (await B("POST", "/api/admin/claim", { code: process.env.SMOKE_ADMIN_SETUP_CODE })).status === 409);
      check("…and status now shows admin", (await ADM("GET", "/api/status")).data.isAdmin === true);
    } else {
      const al = await ADM("POST", "/api/login", { username: process.env.SMOKE_ADMIN_USER, password: process.env.SMOKE_ADMIN_PASS });
      check("admin can log in", al.status === 200, al.text);
    }
    const ov = await ADM("GET", "/api/admin/overview");
    check("admin overview loads", ov.status === 200 && ov.data.users >= 2, ov.text);
    const ul = await ADM("GET", "/api/admin/users?q=" + userA);
    const uA = ul.data.users?.find(u => u.username === userA);
    check("admin can find user A", !!uA, ul.text);
    if (uA) {
      check("admin can disable user A", (await ADM("PATCH", `/api/admin/users/${uA.id}`, { disabled: true })).status === 200);
      check("…disabled user is kicked out immediately", (await A("GET", "/api/conversations")).status === 401);
      check("…and can't log in", (await anon("POST", "/api/login", { username: userA, password: pw2 })).status === 403);
      check("admin can re-enable user A", (await ADM("PATCH", `/api/admin/users/${uA.id}`, { disabled: false })).status === 200);
      const rl = await ADM("POST", `/api/admin/users/${uA.id}/reset-link`);
      const token = (rl.data.url || "").split("#token=")[1];
      check("admin can create a reset link", rl.status === 200 && /^[a-f0-9]{64}$/.test(token || ""), rl.text);
      const pw3 = "reset-password-" + id;
      check("reset link sets a new password", (await anon("POST", "/api/reset-password", { token, password: pw3 })).status === 200);
      check("reset link can't be used twice", (await anon("POST", "/api/reset-password", { token, password: pw3 + "x" })).status === 400);
      check("user A logs in with the reset password", (await A("POST", "/api/login", { username: userA, password: pw3 })).status === 200);
    }
    const us = await ADM("GET", "/api/admin/usage?days=1");
    check("admin usage report loads", us.status === 200 && Array.isArray(us.data.rows), us.text);
    check("admin error log loads", (await ADM("GET", "/api/admin/errors")).status === 200);
    if (uA) {
      check("admin can make user A an admin", (await ADM("PATCH", `/api/admin/users/${uA.id}`, { role: "admin" })).status === 200 && (await A("GET", "/api/status")).data.isAdmin === true);
      check("…and take it away again", (await ADM("PATCH", `/api/admin/users/${uA.id}`, { role: "user" })).status === 200 && (await A("GET", "/api/status")).data.isAdmin === false);
    }
    const dl = await ADM("GET", "/api/admin/backup/download");
    check("admin can download a full backup", dl.status === 200 && dl.data.format === "sam-backup-v1" && dl.data.counts?.users >= 2, dl.text.slice(0, 200));
    if (engine === "sqlite") {
      const bk = await ADM("POST", "/api/admin/backups");
      check("admin can run a server backup file (SQLite)", bk.status === 200 && /^sam-.*\.sqlite$/.test(bk.data.file || ""), bk.text);
    } else {
      check("server backup files are refused on Postgres (download instead)", (await ADM("POST", "/api/admin/backups")).status === 400);
    }
  } else {
    console.log("\n  ⏭  Admin tests skipped — set SMOKE_ADMIN_USER and SMOKE_ADMIN_PASS to include them");
  }

  console.log("\nGuest mode");
  if (st.data.guestMode) {
    const G = client();
    const gs = await G("POST", "/api/guest/start");
    check("a guest session can start", gs.status === 200 && typeof gs.data.remaining === "number", gs.text);
    check("guests can't see anyone's chats", (await G("GET", "/api/conversations")).status === 401 && (await G("GET", "/api/conversations/" + ca.data.id)).status === 401);
    check("guests can't use the member chat or admin routes", (await G("POST", "/api/chat", { message: "hi" })).status === 401 && (await G("GET", "/api/admin/overview")).status === 401);
    const gc = await G("GET", "/api/guest/chat");
    check("a new guest chat starts empty", gc.status === 200 && gc.data.messages.length === 0, gc.text);
    check("leaving ends the guest session", (await G("POST", "/api/guest/end")).status === 200 && (await G("GET", "/api/guest/chat")).status === 401);
  } else console.log("  ⏭  Guest mode is off on this server (GUEST_MODE=0)");

  console.log("\nAccount deletion (user B)");
  check("delete account: wrong password refused", (await B("DELETE", "/api/account", { password: "wrong-wrong-wrong" })).status === 400);
  const del = await B("DELETE", "/api/account", { password: pw });
  check("user B can delete their account", del.status === 200, del.text);
  check("…B's session is gone", (await B("GET", "/api/conversations")).status === 401);
  check("…B can't log in any more", (await anon("POST", "/api/login", { username: userB, password: pw })).status === 401);
  check("…A is unaffected", (await A("GET", "/api/conversations")).status === 200);

  console.log(`\n${passed} passed, ${failed} failed`);
  console.log(`(Test account ${userA} was left in the database — delete it from /admin if you like.)`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error("\nCould not run tests:", e.message, "\nIs Sam running at " + BASE + "?"); process.exit(1); });
