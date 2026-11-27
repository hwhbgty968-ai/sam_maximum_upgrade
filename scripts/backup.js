// Safe online backup of the SQLite database (works while Sam is running).
// Usage: npm run backup   → writes backups/sam-YYYY-MM-DDTHH-MM.sqlite and keeps the newest 14.
require("dotenv").config();
const path = require("path");
const fs = require("fs");
const Database = require("better-sqlite3");

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "..");
const src = path.join(DATA_DIR, "sam.sqlite");
const dir = process.env.BACKUP_DIR || path.join(DATA_DIR, "backups");
const keep = Number(process.env.BACKUP_KEEP) || 14;

if (!fs.existsSync(src)) { console.error("No database found at " + src); process.exit(1); }
fs.mkdirSync(dir, { recursive: true });
const stamp = new Date().toISOString().slice(0, 16).replace(/:/g, "-");
const dest = path.join(dir, `sam-${stamp}.sqlite`);

new Database(src, { readonly: true }).backup(dest).then(() => {
  console.log("Backup written: " + dest);
  const old = fs.readdirSync(dir).filter(f => /^sam-.*\.sqlite$/.test(f)).sort().reverse().slice(keep);
  for (const f of old) fs.unlinkSync(path.join(dir, f));
  if (old.length) console.log(`Removed ${old.length} old backup(s).`);
}).catch(e => { console.error("Backup failed:", e.message); process.exit(1); });
