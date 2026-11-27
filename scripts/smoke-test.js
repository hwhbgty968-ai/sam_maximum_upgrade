// Multi-user smoke test. Start Sam first (npm start), then in another terminal: npm run test:smoke
// Optional: BASE_URL=https://your-sam.onrender.com npm run test:smoke
// Creates two throwaway accounts and checks login, privacy between users, chats, memories and AI replies.
const BASE = (process.env.BASE_URL || "http://localhost:3000").replace(/\/$/, "");
let passed = 0, failed = 0;

function client() {
  let cookie = "";
  return async function call(method, url, body) {
    const res = await fetch(BASE + url, {
      method,
      headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined
    });
    const set = res.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0];
    const text = await res.text();
    let data = text;
    try { data = JSON.parse(text); } catch {}
    return { status: res.status, data, text };
  };
}

function check(name, ok, detail = "") {
  if (ok) { passed++; console.log("  ✅ " + name); }
  else { failed++; console.log("  ❌ " + name + (detail ? "  → " + detail : "")); }
}

(async () => {
  console.log(`Testing Sam at ${BASE}\n`);
  const id = Date.now().toString(36);
  const A = client(), B = client(), anon = client();
  const pw = "test-password-" + id;

  const health = await anon("GET", "/healthz");
  check("health check responds", health.status === 200 && health.data.ok, health.text);

  const st = await anon("GET", "/api/status");
  check("status works logged out", st.status === 200 && st.data.loggedIn === false);
  const aiOn = !!st.data.aiConfigured;

  check("protected route needs login", (await anon("GET", "/api/conversations")).status === 401);
  check("unknown API route returns JSON 404", (await anon("GET", "/api/nope")).status === 404);

  const ra = await A("POST", "/api/register", { username: "smokeA_" + id, password: pw, age: 15 });
  check("user A can register", ra.status === 200 && ra.data.ok, ra.text);
  const rb = await B("POST", "/api/register", { username: "smokeB_" + id, password: pw, age: 30 });
  check("user B can register", rb.status === 200 && rb.data.ok, rb.text);

  const dup = await anon("POST", "/api/register", { username: "SMOKEA_" + id, password: pw, age: 20 });
  check("duplicate username (different case) rejected", dup.status === 409, dup.text);

  const sa = await A("GET", "/api/status");
  check("user A session sticks after register", sa.data.loggedIn === true && sa.data.username === "smokeA_" + id, sa.text);

  const bad = await anon("POST", "/api/login", { username: "smokeA_" + id, password: "wrong-password!!" });
  check("wrong password rejected", bad.status === 401);

  const ca = await A("POST", "/api/conversations", { mode: "chat" });
  check("user A can create a chat", ca.status === 200 && ca.data.id, ca.text);
  const peek = await B("GET", "/api/conversations/" + ca.data.id);
  check("user B CANNOT read user A's chat", peek.status === 404, peek.text);
  const del = await B("DELETE", "/api/conversations/" + ca.data.id);
  check("user B CANNOT delete user A's chat", del.status === 404, del.text);

  await A("POST", "/api/memories", { content: "A's private note " + id });
  const memB = await B("GET", "/api/history");
  check("user B cannot see user A's memories", !JSON.stringify(memB.data).includes("A's private note " + id));

  const chatB = await B("POST", "/api/chat", { message: "hi", conversationId: ca.data.id });
  check("user B cannot post into user A's chat", chatB.status === 404, chatB.text.slice(0, 200));

  if (aiOn) {
    const t0 = Date.now();
    const chat = await A("POST", "/api/chat", { message: "Reply with just the word: pong", conversationId: ca.data.id, speed: "fast" });
    const events = chat.text.split("\n\n").filter(l => l.startsWith("data: ")).map(l => JSON.parse(l.slice(6)));
    const answer = events.filter(e => e.delta).map(e => e.delta).join("");
    const err = events.find(e => e.error);
    check(`AI replies (${((Date.now() - t0) / 1000).toFixed(1)}s, model: ${events.find(e => e.model)?.model || "?"})`, !err && answer.length > 0, err?.error || chat.text.slice(0, 300));
    const saved = await A("GET", "/api/conversations/" + ca.data.id);
    check("reply saved to chat history", saved.data.messages?.length >= 2, saved.text.slice(0, 200));
  } else {
    console.log("  ⏭  AI reply test skipped — no AI key configured on the server");
  }

  await A("POST", "/api/logout");
  check("logout ends the session", (await A("GET", "/api/conversations")).status === 401);
  const relog = await A("POST", "/api/login", { username: "SMOKEa_" + id, password: pw });
  check("log back in (case-insensitive username)", relog.status === 200, relog.text);
  const again = await A("GET", "/api/conversations");
  check("chats still there after re-login", again.status === 200 && again.data.conversations.some(c => c.id === ca.data.id));

  console.log(`\n${passed} passed, ${failed} failed`);
  console.log("(Test accounts smokeA_/smokeB_ were left in the database — harmless, delete them if you like.)");
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error("\nCould not run tests:", e.message, "\nIs Sam running at " + BASE + "?"); process.exit(1); });
