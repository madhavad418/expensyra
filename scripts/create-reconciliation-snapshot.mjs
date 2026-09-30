// Creates a point-in-time, self-consistent copy of the active database for
// reconciliation/hard-gate work, so gate counts are never computed against a
// database that's still receiving live Pleo syncs. Uses `VACUUM INTO`, which
// SQLite guarantees is a consistent snapshot even with a concurrent writer
// and an active WAL — this script never opens the live DB for writing and
// never touches the running server process.
//
// Usage: node scripts/create-reconciliation-snapshot.mjs
// Output: data/backups/spendops-live-gate-YYYYMMDD-HHMM.db
//         data/backups/spendops-live-gate-YYYYMMDD-HHMM.snapshot.json
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

const sourcePath = process.env.DATABASE_PATH
  ? path.resolve(root, process.env.DATABASE_PATH)
  : path.join(root, 'data', 'spendops.db');

if (!fs.existsSync(sourcePath)) {
  console.error(`Source database not found: ${sourcePath}`);
  process.exit(1);
}

const backupsDir = path.join(root, 'data', 'backups');
fs.mkdirSync(backupsDir, { recursive: true });

const now = new Date();
const stamp = now.toISOString().slice(0, 16).replace(/[-:T]/g, '').replace(/^(\d{8})(\d{4})$/, '$1-$2');
const targetPath = path.join(backupsDir, `spendops-live-gate-${stamp}.db`);
const metaPath = targetPath.replace(/\.db$/, '.snapshot.json');

if (fs.existsSync(targetPath)) {
  console.error(`Snapshot already exists for this minute: ${targetPath}`);
  process.exit(1);
}

// Fresh connection, opened read-write only against the SOURCE (VACUUM INTO
// requires a writable handle on the connection issuing it, but never
// modifies the source database's content — it only reads a consistent
// snapshot of it). Never the live app's own handle.
const src = new DatabaseSync(sourcePath);
try {
  const sqlPath = targetPath.replace(/\\/g, '/').replace(/'/g, "''");
  src.exec(`VACUUM INTO '${sqlPath}'`);
} finally {
  src.close();
}

const snap = new DatabaseSync(targetPath, { readOnly: true });
try {
  const txCount = snap.prepare('SELECT COUNT(*) n FROM transactions').get().n;
  const latest = snap.prepare('SELECT MAX(transaction_date) d FROM transactions').get().d;
  let lastRun = null;
  try {
    lastRun = snap.prepare('SELECT id,status,started_at,finished_at FROM pleo_sync_runs ORDER BY id DESC LIMIT 1').get() || null;
  } catch { /* table may not exist on a very old DB */ }

  const meta = {
    snapshotTimestamp: now.toISOString(),
    snapshotPath: targetPath,
    sourceDbPath: sourcePath,
    sourceTransactionCount: txCount,
    latestTransactionTimestamp: latest,
    latestSyncRunId: lastRun?.id ?? null,
    latestSyncRunStatus: lastRun?.status ?? null,
    latestSyncRunFinishedAt: lastRun?.finished_at ?? null,
  };
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
  console.log(JSON.stringify(meta, null, 2));
} finally {
  snap.close();
}
