// Restore a Sam JSON backup into the database that .env / DATABASE_URL points at.
//   npm run restore -- backups/sam-backup-2026-11-28T12-00.json
// Moving from SQLite to Neon:  1) npm run backup  (without DATABASE_URL)   2) DATABASE_URL=… npm run restore -- <that file>
// Refuses to restore into a database that already has accounts, unless you add --force.
require("dotenv").config();
const fs = require("fs");
const { db, engine, init } = require("../lib/db");
const { restoreAll } = require("../lib/backup");

(async () => {
  const file = process.argv.slice(2).find(a => !a.startsWith("--"));
  if (!file) { console.error("Usage: npm run restore -- <backup.json> [--force]"); process.exit(1); }
  const dump = JSON.parse(fs.readFileSync(file, "utf8"));
  await init();
  console.log(`Restoring ${file} (made ${dump.createdAt} from ${dump.engine}) into the ${engine} database (${db.location})…`);
  const restored = await restoreAll(dump, { force: process.argv.includes("--force"), log: console.log });
  console.log("Done: " + Object.values(restored).reduce((a, b) => a + b, 0) + " rows restored.");
  await db.close();
})().catch(e => { console.error("Restore failed:", e.message); process.exit(1); });
