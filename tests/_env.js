// Test harness.  npm test            → every unit test on SQLite
//                TEST_PG_URL=postgres://user@localhost:5432/postgres npm test → also on Postgres
// (TEST_PG_URL must be allowed to CREATE DATABASE; each test file gets a brand-new database.)
const fs = require("fs"), path = require("path"), os = require("os");
const { execFileSync } = require("child_process");
function createPgDb(label) {
  const admin = process.env.TEST_PG_URL;
  if (!admin) throw new Error("Set TEST_PG_URL to run the Postgres tests.");
  const name = ("t_" + label + "_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)).toLowerCase().replace(/[^a-z0-9_]/g, "");
  execFileSync("psql", [admin, "-qc", `CREATE DATABASE ${name}`]);
  const u = new URL(admin); u.pathname = "/" + name; return u.toString();
}
module.exports = function setup(label) {
  const engine = process.argv[3] || process.env.TEST_ENGINE || "sqlite";
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sam" + label + "-"));
  process.env.DATA_DIR = dir;
  if (engine === "postgres") process.env.DATABASE_URL = createPgDb(label); else delete process.env.DATABASE_URL;
  let pass = 0, fail = 0;
  const t = async (n, f) => {
    try { await f(); pass++; console.log("  ✅", n); }
    catch (e) { fail++; console.log("  ❌", n, "\n    ", String(e.stack || e.message).split("\n").slice(0, 3).join(" | ")); process.exitCode = 1; }
  };
  const done = name => console.log(`\n${name} [${engine}]: ${pass} passed, ${fail} failed`);
  return { engine, dir, t, done, createPgDb, havePg: !!process.env.TEST_PG_URL };
};
