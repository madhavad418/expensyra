// One-off maintenance: rebuilds the six dq_* flags on every transaction row
// from current canonical stored state. Mirrors recalculateAllTransactionQuality()
// in server.js exactly (keep both in sync) — provided as a standalone script
// so it can be run without an authenticated admin HTTP session, e.g. directly
// after a schema migration. Prefer POST /api/admin/recalculate-quality-flags
// when a running, authenticated server is available; this script exists for
// the case where it isn't yet (e.g. immediately after the first boot that
// adds the new columns).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function loadDotEnvIfPresent(file) {
  if (!fs.existsSync(file)) return;
  for (const rawLine of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
loadDotEnvIfPresent(path.join(root, '.env'));

const dbPath = process.env.DATABASE_PATH
  ? path.resolve(root, process.env.DATABASE_PATH)
  : path.join(root, 'data', 'spendops.db');

const db = new DatabaseSync(dbPath);
const cols = db.prepare('PRAGMA table_info(transactions)').all().map(c => c.name);
for (const required of ['resolved_category_name', 'category_resolution_source', 'historical_category_name']) {
  if (!cols.includes(required)) {
    console.error(`Column ${required} not found on transactions — start the server once first so initDb()'s migration runs, then re-run this script.`);
    db.close();
    process.exit(1);
  }
}

const before = db.prepare("SELECT COUNT(*) n FROM transactions WHERE project_status='MISSING_PROJECT' AND dq_missing_project=0").get().n;

const r = db.prepare(`UPDATE transactions SET
  dq_missing_project = CASE WHEN project_status='MISSING_PROJECT' THEN 1 ELSE 0 END,
  dq_missing_classification = CASE WHEN classification_status='MISSING_CLASSIFICATION' THEN 1 ELSE 0 END,
  dq_unresolved_category = CASE WHEN resolved_category_name IS NOT NULL AND resolved_category_name<>'' THEN 0 ELSE 1 END,
  dq_missing_receipt = CASE WHEN receipt_count>0 THEN 0 ELSE 1 END,
  dq_unmapped_historical_project = 0,
  dq_unknown_employee = CASE WHEN employee_id IS NULL OR employee_name IS NULL OR employee_name='' THEN 1 ELSE 0 END,
  updated_at = ?
`).run(new Date().toISOString());

const after = db.prepare("SELECT COUNT(*) n FROM transactions WHERE project_status='MISSING_PROJECT' AND dq_missing_project=0").get().n;
db.close();

console.log(JSON.stringify({ dbPath, rowsTouched: r.changes, staleMismatchBefore: before, staleMismatchAfter: after }, null, 2));
