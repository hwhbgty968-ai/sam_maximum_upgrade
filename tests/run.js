// Runs every unit test file on SQLite, and on Postgres too when TEST_PG_URL is set.
const { execFileSync } = require("child_process");
const path = require("path");
const repo = path.join(__dirname, "..");
const files = ["ai", "db", "chats", "library", "admin", "backup"];
const engines = ["sqlite", ...(process.env.TEST_PG_URL ? ["postgres"] : [])];
let failed = 0;
for (const engine of engines) for (const f of files) {
  if (f === "ai" && engine !== "sqlite") continue; // no database involved
  try { process.stdout.write(execFileSync(process.execPath, [path.join(__dirname, f + ".test.js"), repo, engine], { stdio: ["ignore", "pipe", "inherit"] })); }
  catch (e) { failed++; process.stdout.write(e.stdout || ""); }
}
if (!process.env.TEST_PG_URL) console.log("\n(Postgres tests skipped — set TEST_PG_URL to include them.)");
process.exit(failed ? 1 : 0);
