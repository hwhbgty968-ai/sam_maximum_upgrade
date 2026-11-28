// Outgoing email (admin invitations). Free option, no domain needed: a Gmail account with an "app password".
//   SMTP_USER=you@gmail.com  SMTP_PASS=<16-letter Google app password>
// Optional: SMTP_HOST (default smtp.gmail.com), SMTP_PORT (465), SMTP_SECURE (1 = TLS from the start, 0 = STARTTLS),
//           MAIL_FROM (default "Ezer <SMTP_USER>").
// Nothing is sent, and nothing pretends to be sent, until SMTP_USER and SMTP_PASS are set.
let transport = null, transportKey = null;

function settings(env = process.env) {
  const port = Number(env.SMTP_PORT) || 465;
  return {
    host: env.SMTP_HOST || "smtp.gmail.com",
    port,
    secure: env.SMTP_SECURE ? env.SMTP_SECURE !== "0" : port === 465,
    user: env.SMTP_USER || "",
    pass: env.SMTP_PASS || "",
    from: env.MAIL_FROM || (env.SMTP_USER ? `Ezer <${env.SMTP_USER}>` : "")
  };
}
const configured = () => { const s = settings(); return !!(s.user && s.pass); };
const status = () => { const s = settings(); return { configured: configured(), host: s.host, from: s.from || null }; };

function getTransport() {
  const s = settings();
  const key = JSON.stringify([s.host, s.port, s.secure, s.user, s.pass]);
  if (!transport || key !== transportKey) {
    const nodemailer = require("nodemailer");
    transport = nodemailer.createTransport({
      host: s.host, port: s.port, secure: s.secure, auth: { user: s.user, pass: s.pass },
      connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 20000,
      tls: { rejectUnauthorized: process.env.SMTP_INSECURE_TLS !== "1" }
    });
    transportKey = key;
  }
  return transport;
}

async function send({ to, subject, text, html }) {
  if (!configured()) throw Object.assign(new Error("Email sending isn't set up yet. Add SMTP_USER and SMTP_PASS in the server's environment (a Gmail address and a Google app password work)."), { status: 503, code: "MAIL_NOT_CONFIGURED" });
  try {
    const info = await getTransport().sendMail({ from: settings().from, to, subject, text, html });
    return { ok: true, messageId: info.messageId };
  } catch (e) {
    // Never pass the password or server details back to the browser.
    const err = new Error("The email couldn't be sent. Check the SMTP settings (for Gmail: an app password, not your normal password).");
    err.status = 502; err.code = "MAIL_FAILED"; err.cause = e;
    throw err;
  }
}

module.exports = { configured, status, send, settings };
