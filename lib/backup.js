// Full-database backup as one JSON file, and restore from it. Works on both engines, so the same file
// can move Sam from SQLite to Postgres (or back). Backups contain password HASHES: keep them private.
const { db, engine, TABLES } = require("./db");

const FORMAT = "sam-backup-v1";
const SKIP_SETTINGS = ["session_secret"]; // a restored server makes its own

async function dumpAll() {
  const tables = {};
  for (const t of TABLES) {
    const order = t === "app_settings" ? "key" : "id";
    let rows = await db.all(`SELECT * FROM ${t} ORDER BY ${order}`);
    if (t === "app_settings") rows = rows.filter(r => !SKIP_SETTINGS.includes(r.key));
    tables[t] = rows;
  }
  const counts = Object.fromEntries(Object.entries(tables).map(([t, r]) => [t, r.length]));
  return { format: FORMAT, createdAt: new Date().toISOString(), engine, counts, tables };
}

// Restores into an EMPTY database (refuses to mix with existing accounts unless force is set).
async function restoreAll(dump, { force = false, log = () => {} } = {}) {
  if (!dump || dump.format !== FORMAT || typeof dump.tables !== "object") throw new Error("This isn't a Sam backup file (expected format " + FORMAT + ").");
  const existing = Number((await db.get("SELECT COUNT(*) AS c FROM users")).c);
  if (existing && !force) throw new Error(`This database already has ${existing} account(s). Restore only into an empty database (or pass --force to add to it).`);
  const restored = {};
  await db.tx(async t => {
    for (const table of TABLES) {
      const rows = Array.isArray(dump.tables[table]) ? dump.tables[table] : [];
      if (!rows.length) { restored[table] = 0; continue; }
      const have = new Set(await db.columns(table));
      const cols = Object.keys(rows[0]).filter(c => have.has(c));
      const batch = Math.max(1, Math.floor(900 / cols.length));
      for (let i = 0; i < rows.length; i += batch) {
        const chunk = rows.slice(i, i + batch);
        const values = chunk.map(() => "(" + cols.map(() => "?").join(",") + ")").join(",");
        const conflict = table === "app_settings" ? " ON CONFLICT(key) DO NOTHING" : "";
        await t.run(`INSERT INTO ${table} (${cols.join(",")}) VALUES ${values}${conflict}`, ...chunk.flatMap(r => cols.map(c => r[c])));
      }
      restored[table] = rows.length;
      log(`  ${table}: ${rows.length}`);
    }
    // Postgres hands out ids from sequences: move each one past the restored rows.
    if (engine === "postgres") {
      for (const table of TABLES.filter(x => x !== "app_settings")) {
        await t.get(`SELECT setval(pg_get_serial_sequence('${table}', 'id'), COALESCE((SELECT MAX(id) FROM ${table}), 0) + 1, false) AS v`);
      }
    }
  });
  return restored;
}

module.exports = { dumpAll, restoreAll, FORMAT };
