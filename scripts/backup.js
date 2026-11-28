// Full backup of Sam's database to a JSON file on THIS computer — works for SQLite and Postgres.
//   npm run backup                          → backs up whatever .env points at (DATABASE_URL, or the local SQLite file)
//   DATABASE_URL=postgres://… npm run backup → pull a copy of the live Neon database onto your computer
// Writes backups/sam-backup-YYYY-MM-DDTHH-MM.json and keeps the newest 14 (BACKUP_KEEP).
// The file contains password hashes: keep it somewhere private.
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { db, engine, init, DATA_DIR } = require("../lib/db");
const { dumpAll } = require("../lib/backup");

(async () => {
  const dir = process.env.BACKUP_DIR || path.join(DATA_DIR, "backups");
  const keep = Number(process.env.BACKUP_KEEP) || 14;
  await init();
  const dump = await dumpAll();
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `sam-backup-${dump.createdAt.slice(0, 16).replace(/:/g, "-")}.json`);
  fs.writeFileSync(file, JSON.stringify(dump), { mode: 0o600 });
  console.log(`Backed up the ${engine} database (${db.location}) → ${file}`);
  console.log("  " + Object.entries(dump.counts).map(([t, n]) => `${t}: ${n}`).join(", "));
  const old = fs.readdirSync(dir).filter(f => /^sam-backup-.*\.json$/.test(f)).sort().reverse().slice(keep);
  for (const f of old) fs.unlinkSync(path.join(dir, f));
  if (old.length) console.log(`Removed ${old.length} old backup(s).`);
  await db.close();
})().catch(e => { console.error("Backup failed:", e.message); process.exit(1); });
