import { exportWorkbook } from './lib/xlsx-export.mjs';
import { expandApiExpenseSplits, summarizeExpenses, summarizeCommercialExpenses } from './lib/expense-summary.mjs';
import { previewImportRemoval, removeImportedData } from './lib/import-removal.mjs';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { openDatabase } from './lib/db.mjs';
import { mergeProjectAttribution, mergeCategoryEvidence, computeDqFlags, attributeProjectFromRules } from './lib/precedence.mjs';
import { readFirstSheet, readSheet } from './lib/xlsx.mjs';
import { normalizeCarRentalRows, buildCarRentalDashboard } from './lib/car-rentals.mjs';
import { dailySyncDecision, normalizeSyncTime, DAILY_SYNC_DEFAULT_TIME, INCREMENTAL_TRIGGERS } from './lib/daily-sync.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, 'public');

// Minimal built-in .env loader (no external dependency, no CLI flag required).
// Only fills variables not already present in process.env — so real
// environment variables (Railway/Docker/shell) always take precedence over
// the file, matching Node's own --env-file semantics. No-ops silently if
// .env doesn't exist, so production deployments never need one.
function loadDotEnvIfPresent(file) {
  if (!fs.existsSync(file)) return;
  for (const rawLine of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
loadDotEnvIfPresent(path.join(__dirname, '.env'));

const envBool = (name, def=false) => process.env[name] == null ? def : /^(1|true|yes|on)$/i.test(process.env[name]);
const cfg = {
  host: process.env.HOST || '0.0.0.0',
  port: Number(process.env.PORT || 4173),
  businessTz: process.env.BUSINESS_TZ || 'Asia/Kolkata',
  // DATABASE_URL (postgres://…, e.g. Railway Postgres) wins; otherwise a
  // local SQLite file at DATABASE_PATH.
  databaseUrl: process.env.DATABASE_URL || '',
  dbPath: process.env.DATABASE_PATH || path.join(__dirname, 'data', 'spendops.db'),
  attachmentDir: process.env.ATTACHMENT_DIR || path.join(__dirname, 'data', 'attachments'),
  cookieSecure: envBool('COOKIE_SECURE', false),
  sessionTtlHours: Math.max(1, Number(process.env.SESSION_TTL_HOURS || 12)),
  idleSeconds: Math.max(60, Number(process.env.VALIDATION_IDLE_TIMEOUT_SECONDS || 150)),
  pleoBase: (process.env.PLEO_API_BASE || 'https://external.pleo.io').replace(/\/$/, ''),
  pleoKey: process.env.PLEO_API_KEY || '',
  pleoCompanyId: process.env.PLEO_COMPANY_ID || '',
  pleoSyncMode: process.env.PLEO_SYNC_MODE || 'export_v2',
  pleoAutoSync: envBool('PLEO_AUTO_SYNC', true),
  pleoSyncOnStart: envBool('PLEO_SYNC_ON_START', false),
  pleoIntervalMinutes: Math.max(5, Number(process.env.PLEO_SYNC_INTERVAL_MINUTES || 15)),
  // Defaults only — once an admin flips the Transactions-page toggle, the
  // app_kv value wins so the choice survives restarts without editing .env.
  pleoDailySync: envBool('PLEO_DAILY_SYNC', false),
  pleoDailySyncTime: normalizeSyncTime(process.env.PLEO_DAILY_SYNC_TIME) || DAILY_SYNC_DEFAULT_TIME,
  pleoCacheAttachments: envBool('PLEO_CACHE_ATTACHMENTS', true),
  pleoMockMode: envBool('PLEO_MOCK_MODE', false),
  // First-ever incremental sync (no checkpoint yet) fetches only this many
  // hours. Anything older is a deliberate historical backfill.
  pleoInitialLookbackHours: Math.max(1, Number(process.env.PLEO_INITIAL_LOOKBACK_HOURS || 24)),
  // Upper bound for a user-chosen "Sync now" range.
  pleoMaxSyncRangeDays: 31,
  allowRecoveryImport: envBool('ALLOW_RECOVERY_IMPORT', true),
};
// Reviewer-chosen commercial classification. The legacy values stay valid in
// the database so earlier decisions keep their meaning, but new reviews pick
// from the active list only.
const COMMERCIAL_CLASSIFICATIONS = ['CUSTOMER_BILLABLE','JSAN_INTERNAL','SALARY_DEDUCTION','REFUND','REIMBURSEMENT'];
const LEGACY_COMMERCIAL_CLASSIFICATIONS = ['PROJECT_COST','SHARED_COST'];
const COMMERCIAL_CLASSIFICATION_CHECK = `commercial_classification TEXT CHECK(commercial_classification IS NULL OR commercial_classification IN (${[...COMMERCIAL_CLASSIFICATIONS,...LEGACY_COMMERCIAL_CLASSIFICATIONS].map(v=>`'${v}'`).join(',')}))`;
const CAR_RENTAL_SHEET = '2026 Car Rental Master Data';
const CAR_RENTAL_SOURCE_URL = process.env.CAR_RENTAL_WORKBOOK_URL || 'https://netorgft3705709-my.sharepoint.com/:x:/g/personal/rk_jsanconsulting_com/IQBsZsiAzPcASoXJba7eVPEuAVrbKbEbio6DbYnME54bsAs?CID=e8327d73-a49b-e694-f281-bd4bfcf98ebd&download=1';
let carRentalWorkbookCache = null;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
cfg.pleoCompanyIdLooksValid = cfg.pleoCompanyId === '' || UUID_RE.test(cfg.pleoCompanyId);

if(!cfg.databaseUrl) fs.mkdirSync(path.dirname(cfg.dbPath), { recursive: true });
fs.mkdirSync(cfg.attachmentDir, { recursive: true });
const db = openDatabase({ path: cfg.dbPath, url: cfg.databaseUrl });
// Where the data lives, for logs — never print credentials.
const dbLabel = db.dialect==='postgres' ? (()=>{try{const u=new URL(cfg.databaseUrl);return `postgres://${u.hostname}:${u.port||5432}${u.pathname}`;}catch{return 'postgres';}})() : cfg.dbPath;

const iso = (d=new Date()) => d.toISOString();
function businessDay(date=new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: cfg.businessTz, year:'numeric', month:'2-digit', day:'2-digit' }).formatToParts(date);
  const get = t => parts.find(p=>p.type===t)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}
const today = () => businessDay(new Date());
const sleep = ms => new Promise(r=>setTimeout(r,ms));
const safeJson = (v, fallback={}) => { try { return typeof v === 'string' ? JSON.parse(v) : v; } catch { return fallback; } };
const clampText = (v,n=4000) => String(v ?? '').slice(0,n);

function initDb() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      role TEXT NOT NULL CHECK(role IN ('ADMIN','TEAM_LEAD','REVIEWER','FINANCE_QC')),
      active INTEGER NOT NULL DEFAULT 1,
      password_hash TEXT NOT NULL,
      password_salt TEXT NOT NULL,
      must_change_password INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS auth_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token_hash TEXT NOT NULL UNIQUE,
      user_id INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_auth_sessions_token ON auth_sessions(token_hash);

    CREATE TABLE IF NOT EXISTS projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      customer TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS pleo_sync_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mode TEXT NOT NULL,
      trigger_type TEXT NOT NULL,
      triggered_by INTEGER,
      status TEXT NOT NULL,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      jobs_seen INTEGER NOT NULL DEFAULT 0,
      items_seen INTEGER NOT NULL DEFAULT 0,
      inserted_count INTEGER NOT NULL DEFAULT 0,
      updated_count INTEGER NOT NULL DEFAULT 0,
      attachment_count INTEGER NOT NULL DEFAULT 0,
      error_count INTEGER NOT NULL DEFAULT 0,
      error_message TEXT,
      FOREIGN KEY(triggered_by) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_sync_runs_started ON pleo_sync_runs(started_at DESC);

    CREATE TABLE IF NOT EXISTS pleo_raw_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      accounting_entry_id TEXT NOT NULL UNIQUE,
      company_id TEXT,
      source_mode TEXT NOT NULL,
      source_job_id TEXT,
      raw_json TEXT NOT NULL,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pleo_accounting_entry_id TEXT NOT NULL UNIQUE,
      pleo_reconciliation_id TEXT,
      employee_id TEXT,
      employee_name TEXT,
      employee_email TEXT,
      team_id TEXT,
      team_name TEXT,
      merchant TEXT,
      merchant_country TEXT,
      category TEXT,
      tags TEXT,
      expense_type TEXT,
      transaction_date TEXT,
      amount REAL NOT NULL DEFAULT 0,
      currency TEXT,
      note TEXT,
      receipt_count INTEGER NOT NULL DEFAULT 0,
      pleo_review_status TEXT,
      pleo_status TEXT,
      source_mode TEXT NOT NULL,
      reviewer_id INTEGER,
      allocated_by INTEGER,
      allocated_at TEXT,
      allocation_day TEXT,
      status TEXT NOT NULL DEFAULT 'UNASSIGNED' CHECK(status IN ('UNASSIGNED','ASSIGNED','IN_REVIEW','NEEDS_INFO','APPROVED','REJECTED')),
      decision TEXT,
      ${COMMERCIAL_CLASSIFICATION_CHECK},
      project_code TEXT,
      reviewer_notes TEXT,
      completed_at TEXT,
      completion_day TEXT,
      last_synced_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(reviewer_id) REFERENCES users(id),
      FOREIGN KEY(allocated_by) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_tx_status ON transactions(status);
    CREATE INDEX IF NOT EXISTS idx_tx_reviewer ON transactions(reviewer_id, status);
    CREATE INDEX IF NOT EXISTS idx_tx_date ON transactions(transaction_date);
    CREATE INDEX IF NOT EXISTS idx_tx_completion_day ON transactions(completion_day, reviewer_id);

    CREATE TABLE IF NOT EXISTS pleo_attachments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      transaction_id INTEGER NOT NULL,
      accounting_entry_id TEXT NOT NULL,
      file_key TEXT NOT NULL,
      receipt_id TEXT,
      source_url TEXT,
      cache_path TEXT,
      mime_type TEXT,
      size_bytes INTEGER,
      fetched_at TEXT,
      fetch_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(accounting_entry_id, file_key),
      FOREIGN KEY(transaction_id) REFERENCES transactions(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS work_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      transaction_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      started_at TEXT NOT NULL,
      last_heartbeat_at TEXT NOT NULL,
      ended_at TEXT,
      seconds INTEGER,
      business_day TEXT NOT NULL,
      end_reason TEXT,
      FOREIGN KEY(transaction_id) REFERENCES transactions(id) ON DELETE CASCADE,
      FOREIGN KEY(user_id) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_work_open ON work_sessions(user_id, ended_at);
    CREATE INDEX IF NOT EXISTS idx_work_day ON work_sessions(business_day, user_id);

    CREATE TABLE IF NOT EXISTS reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      transaction_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      decision TEXT NOT NULL CHECK(decision IN ('APPROVED','REJECTED','NEEDS_INFO')),
      commercial_classification TEXT,
      project_code TEXT,
      notes TEXT,
      review_seconds INTEGER NOT NULL DEFAULT 0,
      business_day TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY(transaction_id) REFERENCES transactions(id) ON DELETE CASCADE,
      FOREIGN KEY(user_id) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_reviews_day ON reviews(business_day, user_id);

    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      transaction_id INTEGER,
      actor_id INTEGER,
      action TEXT NOT NULL,
      detail TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY(transaction_id) REFERENCES transactions(id) ON DELETE CASCADE,
      FOREIGN KEY(actor_id) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_audit_tx ON audit_log(transaction_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS app_kv (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS recovery_imports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      filename TEXT NOT NULL,
      imported_by INTEGER,
      row_count INTEGER NOT NULL DEFAULT 0,
      inserted_count INTEGER NOT NULL DEFAULT 0,
      updated_count INTEGER NOT NULL DEFAULT 0,
      imported_at TEXT NOT NULL,
      FOREIGN KEY(imported_by) REFERENCES users(id)
    );
  `);

  // Provenance columns, added idempotently so this is safe on every startup
  // against an existing database (SQLite has no "ADD COLUMN IF NOT EXISTS").
  // Defaults intentionally label any pre-existing rows as DEMO/FIXTURE/MOCK —
  // every row inserted before this migration existed came from the mock
  // fixture, and must stay clearly marked as such, never silently promoted.
  const ensureColumn=(table,column,ddl)=>{
    const cols=db.prepare(`PRAGMA table_info(${table})`).all();
    if(!cols.some(c=>c.name===column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  };
  ensureColumn('transactions','source_system',"TEXT NOT NULL DEFAULT 'DEMO'");
  ensureColumn('transactions','source_channel',"TEXT NOT NULL DEFAULT 'FIXTURE'");
  ensureColumn('transactions','source_environment',"TEXT NOT NULL DEFAULT 'MOCK'");
  ensureColumn('transactions','source_kind',"TEXT NOT NULL DEFAULT 'DEMO'");
  ensureColumn('transactions','source_import_run_id','INTEGER');
  ensureColumn('transactions','source_period','TEXT');
  ensureColumn('pleo_sync_runs','pages_fetched','INTEGER NOT NULL DEFAULT 0');
  // Transaction ingestion and receipt/evidence enrichment are two independent
  // stages with independent status — a receipt failure must never fail the
  // financial sync (see docs/PLEO_SETUP.md).
  ensureColumn('pleo_sync_runs','requested_from','TEXT');
  ensureColumn('pleo_sync_runs','requested_to','TEXT');
  ensureColumn('pleo_sync_runs','heartbeat_at','TEXT');
  ensureColumn('pleo_sync_runs','real_count','INTEGER NOT NULL DEFAULT 0');
  ensureColumn('pleo_sync_runs','demo_fixture_count','INTEGER NOT NULL DEFAULT 0');
  ensureColumn('pleo_sync_runs','sample_external_ids','TEXT');
  ensureColumn('transactions','pleo_category_id','TEXT');

  // Pleo Tags/Chart-of-Accounts reference data, keyed by Pleo's own UUID so
  // upserts are trivial. Populated by syncPleoTagsAndCategories(); resolving
  // an accountId/tagId to a name never happens inline during ingestion — the
  // reference tables are the source of truth, refreshed independently.
  db.exec(`
    CREATE TABLE IF NOT EXISTS pleo_tag_groups (
      id TEXT PRIMARY KEY,
      company_id TEXT,
      name TEXT NOT NULL,
      code TEXT,
      archived INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS pleo_tags (
      id TEXT PRIMARY KEY,
      group_id TEXT NOT NULL,
      name TEXT NOT NULL,
      code TEXT,
      archived INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(group_id) REFERENCES pleo_tag_groups(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_pleo_tags_group ON pleo_tags(group_id);
    CREATE TABLE IF NOT EXISTS pleo_categories (
      id TEXT PRIMARY KEY,
      company_id TEXT,
      name TEXT NOT NULL,
      code TEXT,
      archived INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  // Provenance on reference data too — same PLEO/DEMO + PRODUCTION/MOCK axes
  // as transactions, so a mock-mode test run can never masquerade as real
  // production reference data (or vice versa).
  ensureColumn('pleo_tag_groups','source_system','TEXT');
  ensureColumn('pleo_tag_groups','source_environment','TEXT');
  ensureColumn('pleo_tag_groups','synced_at','TEXT');
  ensureColumn('pleo_tags','source_system','TEXT');
  ensureColumn('pleo_tags','source_environment','TEXT');
  ensureColumn('pleo_tags','synced_at','TEXT');
  ensureColumn('pleo_categories','source_system','TEXT');
  ensureColumn('pleo_categories','source_environment','TEXT');
  ensureColumn('pleo_categories','synced_at','TEXT');
  ensureColumn('pleo_attachments','receipt_status',"TEXT NOT NULL DEFAULT 'PENDING'");

  db.exec(`
    CREATE TABLE IF NOT EXISTS receipt_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      transaction_id INTEGER NOT NULL,
      pleo_accounting_entry_id TEXT NOT NULL,
      receipt_id TEXT NOT NULL,
      sync_run_id INTEGER,
      status TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','FETCHING','AVAILABLE','FAILED','RETRY_SCHEDULED')),
      attempts INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT,
      next_retry_at TEXT,
      last_error_code TEXT,
      last_error_message TEXT,
      UNIQUE(pleo_accounting_entry_id, receipt_id),
      FOREIGN KEY(transaction_id) REFERENCES transactions(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_receipt_jobs_status ON receipt_jobs(status, next_retry_at);
    CREATE INDEX IF NOT EXISTS idx_receipt_jobs_run ON receipt_jobs(sync_run_id);
  `);

  // === JSAN Project Master (extends the original minimal `projects` table) ===
  ensureColumn('projects','project_manager','TEXT');
  ensureColumn('projects','country','TEXT');
  ensureColumn('projects','status',"TEXT NOT NULL DEFAULT 'ACTIVE'");
  ensureColumn('projects','start_date','TEXT');
  ensureColumn('projects','end_date','TEXT');
  ensureColumn('projects','pleo_project_tag_id','TEXT');
  ensureColumn('projects','pleo_project_tag_name','TEXT');
  ensureColumn('projects','commercial_model','TEXT');

  // Demo project seed — mock mode / local testing only. This must never run
  // against a real deployment: it previously ran unconditionally and polluted
  // the real production "projects" table (the Project Master) with 4 fake
  // codes that no real transaction or review ever referenced (verified by
  // direct query before this fix). The cleanup below removes exactly that
  // known-fake, zero-usage seed from any non-mock database it already reached.
  if (cfg.pleoMockMode && db.prepare('SELECT COUNT(*) c FROM projects').get().c === 0) {
    const q = db.prepare('INSERT INTO projects(code,name,customer,created_at,updated_at) VALUES(?,?,?,?,?)');
    const t=iso();
    q.run('HERE-UK','Street View Collection — UK','HERE',t,t);
    q.run('HERE-AU','Street View Collection — Australia','HERE',t,t);
    q.run('CELLNEX-UK','Drone / LiDAR Pilot — UK','Cellnex',t,t);
    q.run('INTERNAL','JSAN Internal / Corporate','JSAN',t,t);
  }
  if (!cfg.pleoMockMode) {
    for (const code of ['HERE-UK','HERE-AU','CELLNEX-UK','INTERNAL']) {
      const used = (db.prepare('SELECT COUNT(*) c FROM transactions WHERE project_code=?').get(code).c)
        + (db.prepare('SELECT COUNT(*) c FROM reviews WHERE project_code=?').get(code).c);
      if (used === 0) db.prepare("UPDATE projects SET active=0,status='CLOSED',updated_at=? WHERE code=? AND active=1").run(iso(), code);
    }
  }

  // Pleo "Billing Status" tag -> Expensyra commercial classification. Never
  // guessed at runtime: seeded once from an explicit business decision (see
  // seedBillingStatusMapping()) and editable by an admin afterwards. The raw
  // Pleo tag is always preserved alongside the derived value.
  db.exec(`
    CREATE TABLE IF NOT EXISTS billing_status_mapping (
      pleo_tag_id TEXT PRIMARY KEY,
      pleo_tag_name TEXT NOT NULL,
      spendops_classification TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS project_mapping_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_type TEXT NOT NULL,
      source_value TEXT NOT NULL,
      project_id INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'PROPOSED',
      created_by INTEGER,
      approved_by INTEGER,
      approved_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(source_type, source_value),
      FOREIGN KEY(project_id) REFERENCES projects(id)
    );
    -- Learned from Pleo's own expense export (the XLSX the finance team works
    -- from): the Accounting Entries API returns teamId/accountId only, the
    -- export carries the human names. See importPleoExcel().
    CREATE TABLE IF NOT EXISTS pleo_team_names (
      team_id TEXT PRIMARY KEY,
      team_name TEXT NOT NULL,
      rows_seen INTEGER NOT NULL,
      share REAL NOT NULL,
      import_id INTEGER,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS account_category_mappings (
      pleo_account_id TEXT PRIMARY KEY,
      category_name TEXT NOT NULL,
      source TEXT NOT NULL,
      rows_seen INTEGER NOT NULL,
      import_id INTEGER,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS pleo_excel_imports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      filename TEXT,
      sheet_name TEXT,
      imported_by INTEGER,
      row_count INTEGER NOT NULL,
      matched_count INTEGER NOT NULL,
      summary TEXT,
      imported_at TEXT NOT NULL
    );
  `);

  // === Transaction-level attribution/resolution model ===
  // Category: never fabricate a name. accountId is preserved as-is even when
  // it cannot be resolved, so the exact gap is auditable.
  ensureColumn('transactions','pleo_account_id','TEXT');
  ensureColumn('transactions','category_resolution_status','TEXT');
  ensureColumn('transactions','category_source','TEXT');
  // Commercial classification derived from Pleo Billing Status — distinct
  // from the reviewer's own manual `commercial_classification` decision.
  ensureColumn('transactions','pleo_billing_status_tag_id','TEXT');
  ensureColumn('transactions','pleo_billing_status_tag_name','TEXT');
  ensureColumn('transactions','commercial_classification_derived','TEXT');
  ensureColumn('transactions','classification_status','TEXT');
  // Project attribution: every assignment must carry a source and never be
  // silently inferred. No ACTIVE Pleo Project Tag Group exists today (see the
  // reference-data gate), so project_status is MISSING_PROJECT until either a
  // real Pleo Project Tag goes active or an approved mapping rule/manual
  // assignment exists.
  ensureColumn('transactions','project_id','INTEGER');
  ensureColumn('transactions','project_attribution_source','TEXT');
  ensureColumn('transactions','project_attributed_at','TEXT');
  ensureColumn('transactions','project_attributed_by','INTEGER');
  ensureColumn('transactions','project_mapping_rule_id','INTEGER');
  ensureColumn('transactions','project_status',"TEXT NOT NULL DEFAULT 'MISSING_PROJECT'");
  // Data-quality flags — independent booleans, never collapsed into one
  // generic "Uncategorized" bucket. A transaction may carry several at once.
  ensureColumn('transactions','dq_missing_project','INTEGER NOT NULL DEFAULT 0');
  ensureColumn('transactions','dq_missing_classification','INTEGER NOT NULL DEFAULT 0');
  ensureColumn('transactions','dq_unresolved_category','INTEGER NOT NULL DEFAULT 0');
  ensureColumn('transactions','dq_missing_receipt','INTEGER NOT NULL DEFAULT 0');
  ensureColumn('transactions','dq_unmapped_historical_project','INTEGER NOT NULL DEFAULT 0');
  ensureColumn('transactions','dq_unknown_employee','INTEGER NOT NULL DEFAULT 0');

  // === Category evidence separation ===
  // `category`/`category_resolution_status` above reflect ONLY what the live
  // Pleo/Chart-of-Accounts reference data currently resolves — they are
  // legitimately overwritten on every sync. `historical_category_name` is a
  // separate, ingestion-immune column: the only writers are a future
  // historical import or manual admin action (the Pleo Excel import,
  // importPleoExcel(), is that writer). `resolved_category_name` is the
  // precedence-resolved value actually meant for display; see
  // mergeCategoryEvidence() and docs/ARCHITECTURE.md.
  ensureColumn('transactions','historical_category_name','TEXT');
  ensureColumn('transactions','manual_category_name','TEXT');
  ensureColumn('transactions','xpense_id','TEXT');
  // Pleo's own review outcome as shown in the Pleo expense export — reference
  // evidence only; the JSAN decision stays in status/decision/reviews.
  ensureColumn('transactions','pleo_review_status_label','TEXT');
  ensureColumn('transactions','pleo_reviewer_names','TEXT');
  ensureColumn('transactions','pleo_review_note','TEXT');
  db.exec('CREATE INDEX IF NOT EXISTS idx_transactions_team ON transactions(team_id)');
  // Fields the finance team's Pleo Excel export shows that ingestion didn't
  // keep: `amount`/`currency` hold the ORIGINAL purchase value (Pleo
  // transactionValue = Excel "Orig. amount"); bill_* is the signed charge in
  // the company currency (Pleo totalBillValue = Excel "Amount"/"Currency").
  ensureColumn('transactions','bill_amount','REAL');
  ensureColumn('transactions','bill_currency','TEXT');
  ensureColumn('transactions','pleo_export_status','TEXT');
  ensureColumn('transactions','employee_code','TEXT');
  ensureColumn('transactions','pleo_family','TEXT');
  ensureColumn('transactions','pleo_sub_family','TEXT');
  ensureColumn('transactions','resolved_category_name','TEXT');
  ensureColumn('transactions','category_resolution_source','TEXT');
  // Salary deduction: the part of the expense the employee repays, in the
  // transaction's own currency. `amount` stays the untouched Pleo value
  // (syncs overwrite it); the net figure is amount minus this.
  ensureColumn('transactions','salary_deduction_amount','REAL');
  ensureColumn('reviews','salary_deduction_amount','REAL');
  widenCommercialClassificationCheck();
  // Makes the dataVersion() MAX(updated_at) probe an index lookup, not a scan.
  db.exec('CREATE INDEX IF NOT EXISTS idx_transactions_updated ON transactions(updated_at)');
}

// A cheap fingerprint of everything Expense Intelligence is computed from.
// Every write path (review, allocation, sync, rollback, Excel import, project
// or category mapping change) touches one of these, so open pages poll this
// and re-fetch the summary only when it changes.
// Boot-time backfills rewrite derived fields without touching updated_at, so
// a restart must also count as a change for pages left open across it.
const SERVER_BOOT_ID=crypto.randomBytes(4).toString('hex');
function dataVersion(){
  const tx=db.prepare('SELECT MAX(updated_at) u,COUNT(*) c FROM transactions').get();
  const other=db.prepare(`SELECT (SELECT MAX(updated_at) FROM projects) p,(SELECT MAX(updated_at)||':'||COUNT(*) FROM account_category_mappings) m,(SELECT COUNT(*) FROM pleo_categories) k`).get();
  return crypto.createHash('sha1').update([SERVER_BOOT_ID,tx.u,tx.c,other.p,other.m,other.k].join('|')).digest('hex').slice(0,16);
}

// SQLite cannot ALTER a CHECK constraint, so databases created before the
// SALARY_DEDUCTION/REFUND/REIMBURSEMENT classifications existed get the
// transactions table rebuilt once, following SQLite's documented
// "12-step" procedure: foreign keys off (so dropping the old table does not
// cascade-delete reviews/sessions/receipts), copy rows, swap, re-create
// indexes/triggers/views, verify, foreign keys back on.
function widenCommercialClassificationCheck(){
  // Postgres databases are always created with the current CHECK list.
  if(db.dialect==='postgres')return;
  const row=db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='transactions'").get();
  const re=/commercial_classification TEXT CHECK\(commercial_classification IS NULL OR commercial_classification IN \([^)]*\)\)/;
  if(!row||!re.test(row.sql)||row.sql.includes("'SALARY_DEDUCTION'"))return;
  const newSql=row.sql.replace(re,COMMERCIAL_CLASSIFICATION_CHECK).replace(/^CREATE TABLE\s+("?)transactions\1/,'CREATE TABLE transactions__rebuild');
  const deps=db.prepare("SELECT type,name,sql FROM sqlite_master WHERE sql IS NOT NULL AND ((type IN ('index','trigger') AND tbl_name='transactions') OR type='view')").all();
  const before=db.prepare('SELECT COUNT(*) c FROM transactions').get().c;
  db.exec('PRAGMA foreign_keys=OFF');
  try{
    db.exec('BEGIN IMMEDIATE');
    try{
      for(const v of deps.filter(d=>d.type==='view'))db.exec(`DROP VIEW "${v.name}"`);
      db.exec('DROP TABLE IF EXISTS transactions__rebuild');
      db.exec(newSql);
      db.exec('INSERT INTO transactions__rebuild SELECT * FROM transactions');
      db.exec('DROP TABLE transactions');
      db.exec('ALTER TABLE transactions__rebuild RENAME TO transactions');
      for(const d of deps)db.exec(d.sql);
      const after=db.prepare('SELECT COUNT(*) c FROM transactions').get().c;
      if(after!==before)throw new Error(`row count changed ${before} -> ${after}`);
      const fk=db.prepare('PRAGMA foreign_key_check').all();
      if(fk.length)throw new Error(`${fk.length} foreign key violation(s) after rebuild`);
      db.exec('COMMIT');
      console.log(`[migration] transactions: commercial_classification now allows ${COMMERCIAL_CLASSIFICATIONS.join(', ')} (${after} rows kept)`);
    }catch(e){db.exec('ROLLBACK');throw e;}
  }finally{db.exec('PRAGMA foreign_keys=ON');}
}

function hashPassword(password, saltHex) {
  const salt = saltHex ? Buffer.from(saltHex,'hex') : crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return { salt: salt.toString('hex'), hash: hash.toString('hex') };
}
function verifyPassword(password, saltHex, expectedHex) {
  try {
    const actual = Buffer.from(hashPassword(password,saltHex).hash,'hex');
    const expected = Buffer.from(expectedHex,'hex');
    return actual.length===expected.length && crypto.timingSafeEqual(actual,expected);
  } catch { return false; }
}
function createUser(name,email,role,password,mustChange=1) {
  const {salt,hash}=hashPassword(password);
  const t=iso();
  const r=db.prepare(`INSERT INTO users(name,email,role,active,password_hash,password_salt,must_change_password,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?)`).run(name,email.toLowerCase(),role,1,hash,salt,mustChange,t,t);
  return Number(r.lastInsertRowid);
}
initDb();

// Any pleo_sync_runs row still 'RUNNING' at process start is guaranteed
// orphaned: the in-memory `syncInProgress` flag that would ever resolve it is
// gone with the old process. Never let a restart leave a sync looking
// permanently active — mark it INTERRUPTED immediately, once, at boot.
(function sweepStaleSyncRuns(){
  const stale=db.prepare("SELECT id FROM pleo_sync_runs WHERE status='RUNNING'").all();
  if(stale.length){
    db.prepare("UPDATE pleo_sync_runs SET status='INTERRUPTED',finished_at=?,error_message='Server restarted before this run completed' WHERE status='RUNNING'").run(iso());
    console.log(`[Pleo] Marked ${stale.length} stale RUNNING sync run(s) as INTERRUPTED at startup.`);
  }
})();

function json(res,status,data,headers={}) {
  res.writeHead(status,{ 'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...headers });
  res.end(JSON.stringify(data));
}
function text(res,status,data,type='text/plain; charset=utf-8',headers={}) {
  res.writeHead(status,{ 'Content-Type':type,'Cache-Control':/^text\/(html|javascript|css)/.test(type)?'no-cache':'public, max-age=3600','X-Content-Type-Options':'nosniff',...headers });
  res.end(data);
}
function readBody(req, max=2_000_000) {
  return new Promise((resolve,reject)=>{
    let raw='';
    req.on('data',c=>{ raw += c; if(raw.length>max){reject(new Error('Payload too large')); req.destroy();} });
    req.on('end',()=>resolve(raw)); req.on('error',reject);
  });
}
// Binary sibling of readBody() — file uploads such as the Pleo Excel export.
function readBuffer(req, max=50_000_000) {
  return new Promise((resolve,reject)=>{
    const chunks=[]; let size=0;
    req.on('data',c=>{ size+=c.length; if(size>max){reject(Object.assign(new Error('Payload too large'),{status:413})); req.destroy(); return;} chunks.push(c); });
    req.on('end',()=>resolve(Buffer.concat(chunks))); req.on('error',reject);
  });
}
async function readJson(req){ const raw=await readBody(req); try{return raw?JSON.parse(raw):{};}catch{throw Object.assign(new Error('Invalid JSON'),{status:400});} }
function parseCookies(req){ return Object.fromEntries(String(req.headers.cookie||'').split(';').map(x=>x.trim()).filter(Boolean).map(x=>{const i=x.indexOf('=');return [decodeURIComponent(i<0?x:x.slice(0,i)),decodeURIComponent(i<0?'':x.slice(i+1))];})); }
function cookie(name,value,{maxAge}={}) {
  const parts=[`${name}=${encodeURIComponent(value)}`,'Path=/','HttpOnly','SameSite=Lax'];
  if(cfg.cookieSecure) parts.push('Secure'); if(maxAge!=null) parts.push(`Max-Age=${maxAge}`);
  return parts.join('; ');
}
function tokenHash(token){return crypto.createHash('sha256').update(token).digest('hex');}
function newSession(userId){
  const token=crypto.randomBytes(32).toString('base64url'); const t=new Date(); const exp=new Date(t.getTime()+cfg.sessionTtlHours*3600_000);
  db.prepare('DELETE FROM auth_sessions WHERE expires_at < ?').run(iso());
  db.prepare('INSERT INTO auth_sessions(token_hash,user_id,created_at,expires_at,last_seen_at) VALUES(?,?,?,?,?)').run(tokenHash(token),userId,t.toISOString(),exp.toISOString(),t.toISOString());
  return {token,expiresAt:exp.toISOString()};
}
function authUser(req) {
  const token=parseCookies(req).jsan_spendops_session; if(!token) return null;
  const row=db.prepare(`SELECT u.id,u.name,u.email,u.role,u.active,u.must_change_password,s.id session_id,s.expires_at
    FROM auth_sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=?`).get(tokenHash(token));
  if(!row || !row.active || Date.parse(row.expires_at)<=Date.now()) return null;
  db.prepare('UPDATE auth_sessions SET last_seen_at=? WHERE id=?').run(iso(),row.session_id);
  return row;
}
function requireAuth(req,res,roles=null){ const u=authUser(req); if(!u){json(res,401,{error:'Authentication required'});return null;} if(roles && !roles.includes(u.role)){json(res,403,{error:'Insufficient access'});return null;} return u; }
function audit(txId,actorId,action,detail={}) { db.prepare('INSERT INTO audit_log(transaction_id,actor_id,action,detail,created_at) VALUES(?,?,?,?,?)').run(txId||null,actorId||null,action,JSON.stringify(detail),iso()); }
function getKv(key){return db.prepare('SELECT value FROM app_kv WHERE key=?').get(key)?.value || null;}
function setKv(key,value){db.prepare(`INSERT INTO app_kv(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`).run(key,String(value),iso());}

function pleoConfigured(){ return cfg.pleoMockMode || Boolean(cfg.pleoKey && cfg.pleoCompanyId && cfg.pleoCompanyIdLooksValid); }
// Distinguishes "nothing set" from "something set but malformed", so the UI/API
// can give a precise reason instead of a generic "not configured".
function pleoConfigStatus(){
  if(cfg.pleoMockMode) return {ok:true};
  if(!cfg.pleoKey || !cfg.pleoCompanyId) return {ok:false, reason:'MISSING', message:'PLEO_API_KEY and PLEO_COMPANY_ID must both be set.'};
  if(!cfg.pleoCompanyIdLooksValid) return {ok:false, reason:'INVALID_COMPANY_ID', message:'PLEO_COMPANY_ID is set but is not a valid UUID.'};
  return {ok:true};
}
// Turns a thrown pleoRequest() error into a stable {reason, message} pair for
// the UI, without ever including request/response headers or the API key.
function classifyPleoError(e){
  const status=e.statusCode||null; const requestId=e.requestId||null;
  if(status===401) return {reason:'AUTH_FAILED', message:'Authentication failed — Pleo rejected the API key.', requestId};
  if(status===403) return {reason:'MISSING_SCOPE', message:`Missing API scope/permission for this request: ${e.message}`, requestId};
  if(status===400||status===422) return {reason:'BAD_REQUEST', message:`Pleo rejected the request: ${e.message}`, requestId};
  if(status===404) return {reason:'NOT_FOUND', message:`Pleo returned Not Found — check PLEO_COMPANY_ID: ${e.message}`, requestId};
  if(status&&status>=500) return {reason:'UPSTREAM_ERROR', message:`Pleo server error (HTTP ${status}): ${e.message}`, requestId};
  if(e.name==='AbortError') return {reason:'TIMEOUT', message:'Request to Pleo timed out.', requestId};
  const causeCode=e.cause?.code; if(causeCode) return {reason:'NETWORK_ERROR', message:`Could not reach Pleo API (${causeCode}): ${e.message}`, requestId};
  return {reason:'UNKNOWN', message:e.message, requestId};
}
function pleoAuthHeader(){ return `Basic ${Buffer.from(`${cfg.pleoKey}:`).toString('base64')}`; }
async function fetchTimeout(url, options={}, timeoutMs=30000){
  const controller=new AbortController(); const timer=setTimeout(()=>controller.abort(),timeoutMs);
  try{return await fetch(url,{...options,signal:controller.signal});}finally{clearTimeout(timer);}
}
async function loadCarRentalRows(forceRefresh=false){
  if(!forceRefresh&&carRentalWorkbookCache&&Date.now()-carRentalWorkbookCache.cachedAt<300000)return carRentalWorkbookCache;
  try{
    const response=await fetchTimeout(CAR_RENTAL_SOURCE_URL,{headers:{Accept:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}},45000);
    if(!response.ok)throw new Error(`SharePoint returned HTTP ${response.status}`);
    const length=Number(response.headers.get('content-length')||0);
    if(length>20_000_000)throw new Error('Car rental workbook exceeds the 20 MB limit');
    const workbook=Buffer.from(await response.arrayBuffer());
    if(workbook.length>20_000_000)throw new Error('Car rental workbook exceeds the 20 MB limit');
    const sheet=readSheet(workbook,CAR_RENTAL_SHEET);
    const data={rows:normalizeCarRentalRows(sheet.rows),loadedAt:iso(),cachedAt:Date.now(),sheetName:sheet.sheetName,stale:false};
    carRentalWorkbookCache=data;
    return data;
  }catch(error){
    if(carRentalWorkbookCache)return {...carRentalWorkbookCache,stale:true};
    const snapshotPath=path.join(__dirname,'data','car-rentals-2026.json');
    if(fs.existsSync(snapshotPath)){
      const snapshot=JSON.parse(fs.readFileSync(snapshotPath,'utf8'));
      if(snapshot.sheetName===CAR_RENTAL_SHEET&&Array.isArray(snapshot.rows)){
        carRentalWorkbookCache={...snapshot,cachedAt:Date.parse(snapshot.loadedAt)||0,stale:true};
        return carRentalWorkbookCache;
      }
    }
    throw error;
  }
}
let mockFixture=null;
function getMockFixture(){ if(!mockFixture){mockFixture=JSON.parse(fs.readFileSync(path.join(__dirname,'sample','pleo-v2-fixture.json'),'utf8'));} return mockFixture; }
async function pleoRequest(method, endpoint, {query={},body=null}={}) {
  if(cfg.pleoMockMode){
    const f=getMockFixture();
    if(endpoint==='/v2/export-jobs') {
      let jobs=f.jobs||[]; if(query.status) jobs=jobs.filter(j=>j.status===query.status); if(query.statuses) jobs=jobs.filter(j=>query.statuses.includes(j.status)); return {data:jobs,pagination:{hasNextPage:false,total:jobs.length}};
    }
    if(endpoint==='/v2/export-items') { const items=f.itemsByJob?.[query.job_id]||[]; return {data:items,pagination:{hasNextPage:false,total:items.length}}; }
    if(endpoint==='/v2/employees') return {data:f.employees||[],pagination:{hasNextPage:false,total:(f.employees||[]).length}};
    if(endpoint==='/v1/accounting-entries:search') return {data:f.accountingEntries||[],pagination:{hasNextPage:false,total:(f.accountingEntries||[]).length}};
    if(endpoint.includes('/receipts')) return {data:[],pagination:{hasNextPage:false,total:0}};
    if(endpoint==='/v0/tag-groups') return {data:f.tagGroups||[]};
    const tagGroupMatch=endpoint.match(/^\/v0\/tag-groups\/([^/]+)\/tags$/);
    if(tagGroupMatch) return {data:(f.tagsByGroup||{})[tagGroupMatch[1]]||[],pagination:{hasNextPage:false}};
    if(endpoint==='/v1/chart-of-accounts:search') return {data:f.categories||[],pagination:{hasNextPage:false}};
    throw new Error(`Mock route not implemented: ${method} ${endpoint}`);
  }
  if(!cfg.pleoKey || !cfg.pleoCompanyId) throw new Error('Pleo is not configured. Set PLEO_API_KEY and PLEO_COMPANY_ID.');
  const url=new URL(cfg.pleoBase+endpoint);
  for(const [k,v] of Object.entries(query)) {
    if(v==null || v==='') continue;
    if(Array.isArray(v)) for(const item of v) url.searchParams.append(k,item); else url.searchParams.set(k,String(v));
  }
  const headers={Authorization:pleoAuthHeader(),Accept:'application/json'};
  const options={method,headers};
  if(body!=null){headers['Content-Type']='application/json;charset=UTF-8';options.body=JSON.stringify(body);}
  // Retry only genuine transport-level failures (DNS blip, connection reset,
  // our own timeout) — never retry a real HTTP response, even an error one;
  // 401/403/500 etc. are legitimate answers from Pleo, not something to redo.
  let r; const maxAttempts=3;
  for(let attempt=1;;attempt++){
    try{ r=await fetchTimeout(url,options); break; }
    catch(networkErr){
      if(attempt>=maxAttempts) throw networkErr;
      console.log(`[Pleo] ${method} ${endpoint} transport error (attempt ${attempt}/${maxAttempts}): ${networkErr.message} — retrying`);
      await sleep(500*attempt);
    }
  }
  const raw=await r.text(); let payload={}; try{payload=raw?JSON.parse(raw):{};}catch{payload={raw};}
  // Pleo's own request-id header — never log Authorization or signed receipt
  // URLs, but this one is safe and is what Pleo Support needs to trace a
  // specific failed call, so every non-2xx response logs it here.
  const requestId=r.headers.get('request-id')||r.headers.get('x-request-id')||null;
  if(!r.ok){const msg=payload?.message||payload?.error||payload?.type||`Pleo API HTTP ${r.status}`; const e=new Error(msg);e.statusCode=r.status;e.payload=payload;e.requestId=requestId;const ra=r.headers.get('retry-after');if(ra)e.retryAfterMs=/^\d+$/.test(ra)?Number(ra)*1000:Math.max(0,Date.parse(ra)-Date.now());console.log(`[Pleo] ${method} ${endpoint} -> HTTP ${r.status}${requestId?` (request-id ${requestId})`:''}: ${msg}`);throw e;}
  return payload;
}
async function pagedPleo(method, endpoint, {query={},body=null,limit=100,maxPages=100}={}) {
  let after=null, pages=0, out=[];
  while(pages<maxPages){
    const q={...query,limit}; if(after) q.after=after;
    const p=await pleoRequest(method,endpoint,{query:q,body}); out.push(...(p.data||[])); pages++;
    if(!p.pagination?.hasNextPage || !p.pagination?.endCursor) break;
    after=p.pagination.endCursor;
  }
  return out;
}
function centsMoney(obj){
  const m=obj?.inSupplierCurrency || obj?.inWalletCurrency || obj;
  const raw=m?.value ?? m?.minors ?? 0; return {amount:Number(raw||0)/100,currency:m?.currency||null};
}
function upsertRaw(entryId,companyId,mode,jobId,raw){
  const t=iso(); db.prepare(`INSERT INTO pleo_raw_entries(accounting_entry_id,company_id,source_mode,source_job_id,raw_json,first_seen_at,last_seen_at)
    VALUES(?,?,?,?,?,?,?) ON CONFLICT(accounting_entry_id) DO UPDATE SET company_id=excluded.company_id,source_mode=excluded.source_mode,source_job_id=excluded.source_job_id,raw_json=excluded.raw_json,last_seen_at=excluded.last_seen_at`)
    .run(entryId,companyId||null,mode,jobId||null,JSON.stringify(raw),t,t);
}
function flattenExportTags(item){
  const vals=[]; for(const line of item.accountingEntryLines||[]) for(const tag of line.tags||[]) vals.push(tag.groupCode?`${tag.groupCode}:${tag.code||tag.id}`:(tag.code||tag.id));
  return [...new Set(vals.filter(Boolean))].join(', ');
}
function exportCategory(item){
  const names=(item.accountingEntryLines||[]).map(l=>l.account?.name||l.account?.code).filter(Boolean); return [...new Set(names)].join(', ') || item.supplier?.categoryCode || '';
}
// === Category / classification / project-attribution resolution ===
// Every one of these is a pure function over already-synced local reference
// data (pleo_categories/pleo_tag_groups/pleo_tags/billing_status_mapping) —
// never an inline Pleo call, and never a guess when data is missing.
function classifyCategoryFields(accountId, categoryMap){
  if(!accountId) return {pleo_account_id:null, pleo_category_id:null, category:null, category_resolution_status:'MISSING_ACCOUNT_ID'};
  if(!categoryMap.has(accountId)) return {pleo_account_id:accountId, pleo_category_id:null, category:null, category_resolution_status:'ACCOUNT_ID_NOT_IN_REFERENCE_DATA'};
  const name=categoryMap.get(accountId);
  // Real JSAN Chart-of-Accounts entries currently come back named literally
  // "Unnamed Account" (escalated to Pleo Support) — never surface that as if
  // it were a real category label.
  if(!name || name==='Unnamed Account') return {pleo_account_id:accountId, pleo_category_id:accountId, category:null, category_resolution_status:'CATEGORY_MAPPING_PENDING'};
  return {pleo_account_id:accountId, pleo_category_id:accountId, category:name, category_resolution_status:'CATEGORY_RESOLVED'};
}
function resolveTagGroupIdByName(name){
  const row=db.prepare('SELECT id FROM pleo_tag_groups WHERE name=? ORDER BY archived ASC, updated_at DESC LIMIT 1').get(name);
  return row?.id||null;
}
function extractTagRefs(item){
  const refs=[...(item.tags||[])]; for(const s of item.splitItems||[]) refs.push(...(s.tags||[])); return refs;
}
// Pleo "Billing Status" is a commercial-classification dimension, not a
// project dimension (confirmed by the reference-data gate: it's the only tag
// group actually populated on real transactions, and its values — Billable
// to Customer, Personal Expense, JSAN Internal, Refund, etc. — describe who
// pays, not which client/project). The raw tag is always preserved alongside
// the mapped value.
// Preloaded once per bulk operation (e.g. recomputeDerivedFieldsFromRaw's
// 40k+ row loop) so classification doesn't re-run 3 fresh SQL queries per row
// — that alone turned a full-table recompute into a multi-second event-loop
// block. classifyBillingStatus() below still resolves fresh per call, which
// is fine for the much smaller per-page volume during normal ingestion.
function loadBillingStatusContext(){
  const groupId=resolveTagGroupIdByName('Billing Status');
  if(!groupId) return {groupId:null,tagNames:new Map(),mapping:new Map()};
  const tagNames=new Map(db.prepare('SELECT id,name FROM pleo_tags WHERE group_id=?').all(groupId).map(t=>[t.id,t.name]));
  const mapping=new Map(db.prepare('SELECT pleo_tag_id,spendops_classification FROM billing_status_mapping').all().map(r=>[r.pleo_tag_id,r.spendops_classification]));
  return {groupId,tagNames,mapping};
}
function classifyBillingStatusWithContext(item, ctx){
  const hit=ctx.groupId?extractTagRefs(item).find(t=>t.tagGroupId===ctx.groupId):null;
  if(!hit) return {pleo_billing_status_tag_id:null,pleo_billing_status_tag_name:null,commercial_classification_derived:null,classification_status:'MISSING_CLASSIFICATION'};
  const tagName=ctx.tagNames.get(hit.tagId)||null;
  const classification=ctx.mapping.get(hit.tagId);
  if(classification===undefined) return {pleo_billing_status_tag_id:hit.tagId,pleo_billing_status_tag_name:tagName,commercial_classification_derived:null,classification_status:'PENDING_MAPPING'};
  return {pleo_billing_status_tag_id:hit.tagId,pleo_billing_status_tag_name:tagName,commercial_classification_derived:classification,classification_status:'CLASSIFIED'};
}
function classifyBillingStatus(item){
  return classifyBillingStatusWithContext(item, loadBillingStatusContext());
}
// No ACTIVE Pleo Project Tag Group exists on this tenant (the archived
// "Project" group has 0/40,107 real transactions using it — see the
// reference-data gate), so the only automatic project source is an
// explicitly APPROVED project mapping rule (lib/precedence.mjs
// attributeProjectFromRules). Unmatched rows stay MISSING_PROJECT.
// Attribution context (approved rules, tag/team names, account→category
// mappings) is cached for bulk ingestion; invalidateAttributionContext() must
// be called whenever any of those tables change.
let attributionCtx=null;
function invalidateAttributionContext(){ attributionCtx=null; }
function loadAttributionContext(){
  if(attributionCtx) return attributionCtx;
  attributionCtx={
    rules:db.prepare("SELECT id,source_type,source_value,project_id FROM project_mapping_rules WHERE status='APPROVED'").all(),
    tagNames:new Map(db.prepare('SELECT id,name FROM pleo_tags').all().map(t=>[t.id,t.name])),
    groupNames:new Map(db.prepare('SELECT id,name FROM pleo_tag_groups').all().map(g=>[g.id,g.name])),
    teamNames:new Map(db.prepare('SELECT team_id,team_name FROM pleo_team_names').all().map(r=>[r.team_id,r.team_name])),
    accountCategories:new Map(db.prepare('SELECT pleo_account_id,category_name FROM account_category_mappings').all().map(r=>[r.pleo_account_id,r.category_name])),
  };
  return attributionCtx;
}
function classifyProjectAttribution(tx){
  return attributeProjectFromRules(tx, loadAttributionContext());
}
// Re-applies approved rules to every stored transaction (e.g. right after a
// rule is approved) without a Pleo re-sync. Goes through the same precedence
// merge as ingestion, so MANUAL reviewer assignments are never overwritten.
// One SQL transaction + preloaded context — see the perf note above
// recomputeDerivedFieldsFromRaw for why per-row autocommit is not an option.
function applyProjectMappingRulesToAll(){
  invalidateAttributionContext(); const ctx=loadAttributionContext();
  const rows=db.prepare('SELECT id,team_id,team_name,tags,project_id,project_attribution_source,project_attributed_at,project_attributed_by,project_mapping_rule_id,project_status FROM transactions').all();
  const stmt=db.prepare('UPDATE transactions SET project_id=?,project_attribution_source=?,project_attributed_at=?,project_attributed_by=?,project_mapping_rule_id=?,project_status=?,updated_at=? WHERE id=?');
  let assigned=0, conflicts=0, changed=0; const t=iso();
  db.exec('BEGIN');
  try{
    for(const row of rows){
      const p=mergeProjectAttribution(row, attributeProjectFromRules(row, ctx));
      if(p.project_status==='PROJECT_ATTRIBUTION_CONFLICT') conflicts++;
      else if(p.project_attribution_source==='APPROVED_MAPPING_RULE') assigned++;
      if(p.project_id===row.project_id && p.project_attribution_source===row.project_attribution_source && p.project_mapping_rule_id===row.project_mapping_rule_id && p.project_status===row.project_status) continue;
      stmt.run(p.project_id,p.project_attribution_source,p.project_attributed_at,p.project_attributed_by,p.project_mapping_rule_id,p.project_status,t,row.id);
      changed++;
    }
    db.exec('COMMIT');
  }catch(e){ db.exec('ROLLBACK'); throw e; }
  if(changed) recalculateAllTransactionQuality();
  return {scanned:rows.length,changed,ruleAssigned:assigned,conflicts};
}
// Before a link is deleted or re-pointed: return the transactions it had
// assigned to "no project", because mergeProjectAttribution() never lets a
// later pass downgrade rule-level evidence. applyProjectMappingRulesToAll()
// then re-derives them from the remaining rules. Reviewer (MANUAL) choices
// are untouched.
function clearRuleAttribution(ruleId){
  return db.prepare(`UPDATE transactions SET project_id=NULL,project_attribution_source='UNMAPPED',project_attributed_at=NULL,project_attributed_by=NULL,project_mapping_rule_id=NULL,project_status='MISSING_PROJECT',updated_at=? WHERE project_mapping_rule_id=? AND project_attribution_source='APPROVED_MAPPING_RULE'`).run(iso(),ruleId).changes;
}
function projectUsage(p){
  const n=(sql,...a)=>db.prepare(sql).get(...a).n;
  return {
    transactions:n('SELECT COUNT(*) n FROM transactions WHERE project_id=? OR project_code=?',p.id,p.code),
    links:n('SELECT COUNT(*) n FROM project_mapping_rules WHERE project_id=?',p.id),
    reviews:n('SELECT COUNT(*) n FROM reviews WHERE project_code=?',p.code),
  };
}
// computeDqFlags() now lives in lib/precedence.mjs, alongside
// mergeProjectAttribution/mergeCategoryEvidence — it's called from
// upsertTransaction() AFTER the precedence merge, not from the per-source
// mapXxx() functions below, so a dq flag always reflects what's actually
// stored on the row rather than what one sync source alone believes.
function mapExportV2(item, jobId) {
  const money=centsMoney(item.amount); const id=item.accountingEntryId; const reconciliation=item.additionalInformation?.reconciliationId || null;
  const categoryName=exportCategory(item)||null;
  const receiptCount=(item.files||[]).length;
  const categoryStatus=categoryName?'CATEGORY_RESOLVED':'MISSING_ACCOUNT_ID';
  return {
    pleo_accounting_entry_id:id, pleo_reconciliation_id:reconciliation,
    employee_id:item.user?.id||null, employee_name:item.user?.name||null, employee_email:null,
    team_id:item.team?.id||null, team_name:item.team?.name||item.teamCode||null,
    merchant:item.supplier?.name||item.vendor?.name||null, merchant_country:item.supplier?.country||item.vendor?.country||null,
    category:categoryName, pleo_account_id:null, pleo_category_id:null, category_resolution_status:categoryStatus, category_source:'PLEO_EXPORT_V2',
    tags:flattenExportTags(item), expense_type:[item.type,item.subType].filter(Boolean).join(' / '),
    pleo_billing_status_tag_id:null, pleo_billing_status_tag_name:null, commercial_classification_derived:null, classification_status:'MISSING_CLASSIFICATION',
    employee_unknown:!item.user?.id,
    transaction_date:item.date||null, amount:money.amount, currency:money.currency, note:item.note||null,
    receipt_count:receiptCount, pleo_review_status:null, pleo_status:'EXPORT_QUEUED', source_mode:'export_v2', raw:item, jobId
  };
}
function mapAccountingEntry(item, employeeMap=new Map(), categoryMap=new Map()) {
  const money=centsMoney(item.transactionValue||item.totalBillValue); const emp=employeeMap.get(item.employeeId)||{};
  const tags=[]; for(const t of item.tags||[]) tags.push(`${t.tagGroupId}:${t.tagId}`); for(const s of item.splitItems||[]) for(const t of s.tags||[]) tags.push(`${t.tagGroupId}:${t.tagId}`);
  // Category resolves via accountId → the synced Chart of Accounts
  // (pleo_categories), never via splitItems[].accountCode (empty on 100% of
  // observed real records) or family/subFamily (always generic).
  const cat=classifyCategoryFields(item.accountId||null, categoryMap);
  const billing=classifyBillingStatus(item);
  const employeeUnknown=!(item.employeeId && employeeMap.has(item.employeeId));
  const receiptCount=(item.receiptIds||[]).length;
  return {
    pleo_accounting_entry_id:item.id, pleo_reconciliation_id:item.foreignExtensionId||null,
    employee_id:item.employeeId||null, employee_name:[emp.firstName,emp.lastName].filter(Boolean).join(' ')||null, employee_email:emp.email||null,
    team_id:item.teamId||null, team_name:null,
    merchant:item.merchant?.name||null, merchant_country:item.merchant?.address?.country||null,
    category:cat.category, pleo_account_id:cat.pleo_account_id, pleo_category_id:cat.pleo_category_id, category_resolution_status:cat.category_resolution_status, category_source:'PLEO_ACCOUNTING_API',
    tags:[...new Set(tags)].join(', '), expense_type:[item.family,item.subFamily].filter(Boolean).join(' / '),
    pleo_billing_status_tag_id:billing.pleo_billing_status_tag_id, pleo_billing_status_tag_name:billing.pleo_billing_status_tag_name, commercial_classification_derived:billing.commercial_classification_derived, classification_status:billing.classification_status,
    employee_unknown:employeeUnknown,
    transaction_date:(item.status==='PENDING'?item.performedAt||item.settledAt:item.settledAt||item.performedAt)||null, amount:money.amount, currency:money.currency, note:item.note||null,
    receipt_count:receiptCount, pleo_review_status:item.reviewStatus||null, pleo_status:item.deletedAt?'DELETED':item.status||null, source_mode:'accounting_entries_v1', raw:item, jobId:null,
    ...accountingEntryExportFields(item), employee_code:emp.code||emp.employeeCode||emp.externalId||null,
  };
}
// Excel-export columns derivable from an Accounting Entry payload; shared by
// ingestion and backfillExportFieldsFromRaw() for rows stored before these
// columns existed.
function accountingEntryExportFields(item){
  const bill=item.totalBillValue?centsMoney(item.totalBillValue):null;
  return {bill_amount:bill?bill.amount:null, bill_currency:bill?.currency||null, pleo_export_status:item.exportStatus||null,
    pleo_family:item.family||null, pleo_sub_family:item.subFamily||null};
}
function backfillExportFieldsFromRaw(){
  const rows=db.prepare(`SELECT t.id,r.raw_json FROM transactions t JOIN pleo_raw_entries r ON r.accounting_entry_id=t.pleo_accounting_entry_id WHERE r.source_mode='accounting_entries_v1' AND t.pleo_family IS NULL`).all();
  if(!rows.length) return 0;
  const stmt=db.prepare('UPDATE transactions SET bill_amount=?,bill_currency=?,pleo_export_status=?,pleo_family=?,pleo_sub_family=? WHERE id=?');
  db.exec('BEGIN');
  try{ for(const row of rows){ let item; try{item=JSON.parse(row.raw_json);}catch{continue;} const f=accountingEntryExportFields(item); stmt.run(f.bill_amount,f.bill_currency,f.pleo_export_status,f.pleo_family,f.pleo_sub_family,row.id); } db.exec('COMMIT'); }
  catch(e){ db.exec('ROLLBACK'); throw e; }
  return rows.length;
}
// Built from a plain object rather than one hand-written positional SQL
// string — with ~35 columns now on this row, a literal ?-list is one silent
// off-by-one away from writing a value into the wrong column.
function upsertTransaction(m) {
  const existing=db.prepare('SELECT id,project_id,project_attribution_source,project_attributed_at,project_attributed_by,project_mapping_rule_id,project_status,historical_category_name,manual_category_name FROM transactions WHERE pleo_accounting_entry_id=?').get(m.pleo_accounting_entry_id); const t=iso();
  // Provenance defaults to DEMO/FIXTURE/MOCK/DEMO if a caller ever forgets to
  // set it explicitly — never silently inherit "looks real" by omission.
  const sourceSystem=m.source_system||'DEMO', sourceChannel=m.source_channel||'FIXTURE', sourceEnvironment=m.source_environment||'MOCK', sourceKind=m.source_kind||'DEMO';
  // Precedence merge: a sync may only add project evidence at a rank >= what
  // the row already carries — see lib/precedence.mjs and
  // docs/ARCHITECTURE.md. `historical_category_name` is deliberately never
  // part of `fields` below, so it round-trips untouched by ingestion.
  // Project evidence comes from approved mapping rules evaluated against this
  // row's Pleo team/tags — the same path for every ingestion source.
  // Accounting-entry rows carry teamId only — fill the name learned from the
  // Pleo Excel import so team-name rules/filters work on new syncs too.
  const actx=loadAttributionContext();
  if(!m.team_name && m.team_id && actx.teamNames.has(m.team_id)) m={...m, team_name:actx.teamNames.get(m.team_id)};
  const proj=mergeProjectAttribution(existing, classifyProjectAttribution(m));
  const cat=mergeCategoryEvidence(existing, m, m.pleo_account_id?actx.accountCategories.get(m.pleo_account_id):null);
  const dq=computeDqFlags({
    hasResolvedCategory:Boolean(cat.resolved_category_name),
    classification_status:m.classification_status,
    project_status:proj.project_status,
    receipt_count:m.receipt_count,
    employeeUnknown:Boolean(m.employee_unknown),
  });
  const fields={
    pleo_reconciliation_id:m.pleo_reconciliation_id, employee_id:m.employee_id, team_id:m.team_id,
    merchant:m.merchant, merchant_country:m.merchant_country,
    category:m.category, pleo_account_id:m.pleo_account_id||null, pleo_category_id:m.pleo_category_id||null,
    category_resolution_status:m.category_resolution_status||null, category_source:m.category_source||null,
    resolved_category_name:cat.resolved_category_name, category_resolution_source:cat.category_resolution_source,
    tags:m.tags, expense_type:m.expense_type,
    pleo_billing_status_tag_id:m.pleo_billing_status_tag_id||null, pleo_billing_status_tag_name:m.pleo_billing_status_tag_name||null,
    commercial_classification_derived:m.commercial_classification_derived||null, classification_status:m.classification_status||null,
    project_id:proj.project_id, project_attribution_source:proj.project_attribution_source, project_attributed_at:proj.project_attributed_at,
    project_attributed_by:proj.project_attributed_by, project_mapping_rule_id:proj.project_mapping_rule_id, project_status:proj.project_status,
    dq_missing_project:dq.dq_missing_project, dq_missing_classification:dq.dq_missing_classification, dq_unresolved_category:dq.dq_unresolved_category,
    dq_missing_receipt:dq.dq_missing_receipt, dq_unmapped_historical_project:dq.dq_unmapped_historical_project, dq_unknown_employee:dq.dq_unknown_employee,
    transaction_date:m.transaction_date, amount:m.amount, currency:m.currency, note:m.note, receipt_count:m.receipt_count,
    pleo_review_status:m.pleo_review_status, pleo_status:m.pleo_status, source_mode:m.source_mode,
    source_system:sourceSystem, source_channel:sourceChannel, source_environment:sourceEnvironment, source_kind:sourceKind,
    source_import_run_id:m.source_import_run_id||null, source_period:m.source_period||null,
    bill_amount:m.bill_amount??null, bill_currency:m.bill_currency||null, pleo_export_status:m.pleo_export_status||null,
    pleo_family:m.pleo_family||null, pleo_sub_family:m.pleo_sub_family||null,
    last_synced_at:t, updated_at:t,
  };
  if(existing){
    const setSql=Object.keys(fields).map(k=>`${k}=?`).join(',')+',employee_name=COALESCE(?,employee_name),employee_email=COALESCE(?,employee_email),team_name=COALESCE(?,team_name),employee_code=COALESCE(?,employee_code)';
    db.prepare(`UPDATE transactions SET ${setSql} WHERE id=?`).run(...Object.values(fields), m.employee_name, m.employee_email, m.team_name, m.employee_code||null, existing.id);
    return {id:existing.id,inserted:false};
  }
  const insertFields={...fields, pleo_accounting_entry_id:m.pleo_accounting_entry_id, employee_name:m.employee_name, employee_email:m.employee_email, team_name:m.team_name, employee_code:m.employee_code||null, created_at:t};
  const cols=Object.keys(insertFields);
  const r=db.prepare(`INSERT INTO transactions(${cols.join(',')}) VALUES(${cols.map(()=>'?').join(',')})`).run(...cols.map(c=>insertFields[c]));
  return {id:Number(r.lastInsertRowid),inserted:true};
}
// Single central recalculation (see docs/ARCHITECTURE.md "Attribution &
// Resolution Precedence" and lib/precedence.mjs). Reads a transaction's
// CURRENT stored canonical state — never a sync source — so a dq flag always
// reflects what's actually on the row, whether it was written moments ago or
// years before these columns existed. Used for a single transaction (e.g.
// after a manual project/classification/category change); see
// recalculateAllTransactionQuality() for the bulk equivalent.
function recalculateTransactionQuality(transactionId){
  const row=db.prepare('SELECT project_status,resolved_category_name,classification_status,receipt_count,employee_id,employee_name FROM transactions WHERE id=?').get(transactionId);
  if(!row) return null;
  const dq=computeDqFlags({
    hasResolvedCategory:Boolean(row.resolved_category_name),
    classification_status:row.classification_status,
    project_status:row.project_status,
    receipt_count:row.receipt_count,
    employeeUnknown:!row.employee_id||!row.employee_name,
  });
  db.prepare('UPDATE transactions SET dq_missing_project=?,dq_missing_classification=?,dq_unresolved_category=?,dq_missing_receipt=?,dq_unmapped_historical_project=?,dq_unknown_employee=?,updated_at=? WHERE id=?')
    .run(dq.dq_missing_project,dq.dq_missing_classification,dq.dq_unresolved_category,dq.dq_missing_receipt,dq.dq_unmapped_historical_project,dq.dq_unknown_employee,iso(),transactionId);
  return dq;
}
// Bulk sibling: one SQL statement over the whole table rather than a per-row
// JS loop — see the perf note above recomputeDerivedFieldsFromRaw (that exact
// per-row pattern once blocked the event loop for ~50s at 40k+ rows). This is
// what fixes flags that went stale before these columns/logic existed —
// dq_missing_project was found stuck at 0 for 55,774/55,774 live rows despite
// project_status='MISSING_PROJECT' on all of them, because nothing had ever
// backfilled it. Logic here must stay in sync with computeDqFlags() in
// lib/precedence.mjs.
function recalculateAllTransactionQuality(){
  const r=db.prepare(`UPDATE transactions SET
    dq_missing_project = CASE WHEN project_status='MISSING_PROJECT' THEN 1 ELSE 0 END,
    dq_missing_classification = CASE WHEN classification_status='MISSING_CLASSIFICATION' THEN 1 ELSE 0 END,
    dq_unresolved_category = CASE WHEN resolved_category_name IS NOT NULL AND resolved_category_name<>'' THEN 0 ELSE 1 END,
    dq_missing_receipt = CASE WHEN receipt_count>0 THEN 0 ELSE 1 END,
    dq_unmapped_historical_project = 0,
    dq_unknown_employee = CASE WHEN employee_id IS NULL OR employee_name IS NULL OR employee_name='' THEN 1 ELSE 0 END,
    updated_at = ?
  `).run(iso());
  return {changes:r.changes};
}
function extFromMime(mime){return mime==='application/pdf'?'.pdf':mime==='image/jpeg'?'.jpg':mime==='image/png'?'.png':mime==='image/webp'?'.webp':'.bin';}
function escapeHtml(v){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function mockReceiptHtml(tx,a){
  const amount=Number(tx.amount||0).toLocaleString('en-GB',{minimumFractionDigits:2,maximumFractionDigits:2});
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Demo receipt · ${escapeHtml(tx.merchant||'Pleo')}</title><style>
  :root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;background:#071a24;color:#eaf4f4;font:15px/1.5 Inter,ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif;display:grid;place-items:center;min-height:100vh;padding:32px}.shell{width:min(720px,100%)}.eyebrow{letter-spacing:.16em;text-transform:uppercase;color:#5ce0d4;font-size:12px;margin-bottom:12px}.card{background:#fff;color:#102833;border-radius:18px;padding:32px;box-shadow:0 24px 80px rgba(0,0,0,.35)}.brand{font-weight:800;letter-spacing:.08em;color:#071a24}.demo{display:inline-block;margin-left:10px;padding:3px 8px;border-radius:999px;background:#dff9f6;color:#0b5b55;font-size:11px;font-weight:700;letter-spacing:.08em}.merchant{font-size:30px;font-weight:750;margin:28px 0 2px}.amount{font-size:42px;font-weight:800;margin:0 0 24px}.grid{display:grid;grid-template-columns:140px 1fr;gap:10px 18px;border-top:1px solid #dce7e8;padding-top:22px}.k{color:#657a82}.v{font-weight:650}.note{margin-top:26px;padding:14px 16px;background:#f3f8f8;border-left:3px solid #22c4b5;color:#48616a}.foot{margin-top:18px;color:#8ea3a8;font-size:12px;text-align:center}@media(max-width:560px){.card{padding:22px}.grid{grid-template-columns:1fr;gap:2px}.v{margin-bottom:10px}.merchant{font-size:24px}.amount{font-size:34px}}
  </style></head><body><main class="shell"><div class="eyebrow">JSAN Expensyra · Mock Mode</div><section class="card"><div><span class="brand">PLEO RECEIPT</span><span class="demo">DEMO</span></div><div class="merchant">${escapeHtml(tx.merchant||'Demo merchant')}</div><div class="amount">${escapeHtml(tx.currency||'')} ${escapeHtml(amount)}</div><div class="grid"><div class="k">Employee</div><div class="v">${escapeHtml(tx.employee_name||'—')}</div><div class="k">Transaction date</div><div class="v">${escapeHtml(tx.transaction_date||'—')}</div><div class="k">Category</div><div class="v">${escapeHtml(tx.category||'—')}</div><div class="k">Pleo entry</div><div class="v">${escapeHtml(tx.pleo_accounting_entry_id||'—')}</div><div class="k">Attachment</div><div class="v">${escapeHtml(a.file_key||a.id)}</div></div><div class="note">This is a local demo receipt generated by JSAN Expensyra because PLEO_MOCK_MODE is enabled. No live Pleo document is being requested.</div></section><div class="foot">Phase 1 validation fixture · Not a financial document</div></main></body></html>`;
}
async function cacheAttachment(attId, url, mimeHint) {
  if(!url || !cfg.pleoCacheAttachments || cfg.pleoMockMode) return false;
  const row=db.prepare('SELECT * FROM pleo_attachments WHERE id=?').get(attId); if(!row || row.cache_path) return Boolean(row?.cache_path);
  try{
    const r=await fetchTimeout(url,{},45000); if(!r.ok) throw new Error(`HTTP ${r.status}`);
    const mime=r.headers.get('content-type')?.split(';')[0]||mimeHint||'application/octet-stream'; const buf=Buffer.from(await r.arrayBuffer());
    if(buf.length>25_000_000) throw new Error('Attachment exceeds 25 MB cache limit');
    const file=`${row.accounting_entry_id}-${row.id}${extFromMime(mime)}`.replace(/[^a-zA-Z0-9._-]/g,'_'); const dest=path.join(cfg.attachmentDir,file);
    fs.writeFileSync(dest,buf,{mode:0o600}); db.prepare('UPDATE pleo_attachments SET cache_path=?,mime_type=?,size_bytes=?,fetched_at=?,fetch_error=NULL,updated_at=? WHERE id=?').run(dest,mime,buf.length,iso(),iso(),attId); return true;
  }catch(e){db.prepare('UPDATE pleo_attachments SET fetch_error=?,updated_at=? WHERE id=?').run(clampText(e.message,500),iso(),attId);return false;}
}
async function syncExportAttachments(txId, entryId, files=[]) {
  let cached=0;
  for(let i=0;i<files.length;i++){
    const f=files[i]||{}; const key=`export-file-${i}-${f.size||0}-${f.type||''}`; const t=iso();
    db.prepare(`INSERT INTO pleo_attachments(transaction_id,accounting_entry_id,file_key,source_url,mime_type,size_bytes,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(accounting_entry_id,file_key) DO UPDATE SET source_url=excluded.source_url,mime_type=excluded.mime_type,size_bytes=excluded.size_bytes,updated_at=excluded.updated_at`)
      .run(txId,entryId,key,f.url||null,f.type||null,f.size||null,t,t);
    const a=db.prepare('SELECT id FROM pleo_attachments WHERE accounting_entry_id=? AND file_key=?').get(entryId,key); if(await cacheAttachment(a.id,f.url,f.type)) cached++;
  }
  return cached;
}
async function loadEmployeeMap(){
  try{
    const employees=await pagedPleo('GET','/v2/employees',{query:{companyId:cfg.pleoCompanyId},limit:100}); return new Map(employees.map(e=>[e.id,e]));
  }catch{return new Map();}
}
// Category resolution during ingestion reads only the local pleo_categories
// reference table (fast SQLite lookup) — it never calls Pleo inline. That
// table is populated/refreshed independently by syncPleoCategories() below.
async function loadCategoryMap(){
  const rows=db.prepare('SELECT id,name FROM pleo_categories').all(); return new Map(rows.map(r=>[r.id,r.name]));
}
// Pleo Tags live under Tag Groups (e.g. Departments, Locations, Projects,
// Cost Centres) — which group (if any) represents "Project" is not assumed
// here; that mapping is a Phase 2 admin decision made from this synced data.
// Split from tag-fetching so the two capabilities can fail/report independently
// (e.g. tag-groups:read granted but a per-group tags scope missing).
async function syncPleoTagGroups(){
  const groups=await pagedPleo('GET','/v0/tag-groups',{query:{company_id:cfg.pleoCompanyId,include_archived:true,include_tags_count:true},limit:100});
  const t=iso(); const prov=provenanceFor('TAGS_API','REFERENCE_DATA'); let inserted=0, updated=0;
  for(const g of groups){
    const existing=db.prepare('SELECT id FROM pleo_tag_groups WHERE id=?').get(g.id);
    db.prepare(`INSERT INTO pleo_tag_groups(id,company_id,name,code,archived,source_system,source_environment,synced_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET company_id=excluded.company_id,name=excluded.name,code=excluded.code,archived=excluded.archived,source_system=excluded.source_system,source_environment=excluded.source_environment,synced_at=excluded.synced_at,updated_at=excluded.updated_at`)
      .run(g.id,g.companyId||cfg.pleoCompanyId,g.name||g.id,g.code||null,g.archived?1:0,prov.source_system,prov.source_environment,t,t,t);
    existing?updated++:inserted++;
  }
  invalidateAttributionContext();
  return {groups,recordsFetched:groups.length,inserted,updated};
}
async function syncPleoTagsForGroups(groups){
  const t=iso(); const prov=provenanceFor('TAGS_API','REFERENCE_DATA'); let recordsFetched=0, inserted=0, updated=0;
  for(const g of groups){
    const tags=await pagedPleo('GET',`/v0/tag-groups/${encodeURIComponent(g.id)}/tags`,{query:{include_archived:true},limit:100});
    recordsFetched+=tags.length;
    for(const tag of tags){
      const existing=db.prepare('SELECT id FROM pleo_tags WHERE id=?').get(tag.id);
      db.prepare(`INSERT INTO pleo_tags(id,group_id,name,code,archived,source_system,source_environment,synced_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET group_id=excluded.group_id,name=excluded.name,code=excluded.code,archived=excluded.archived,source_system=excluded.source_system,source_environment=excluded.source_environment,synced_at=excluded.synced_at,updated_at=excluded.updated_at`)
        .run(tag.id,g.id,tag.name||tag.id,tag.code||null,tag.archived?1:0,prov.source_system,prov.source_environment,t,t,t);
      existing?updated++:inserted++;
    }
  }
  invalidateAttributionContext();
  return {recordsFetched,inserted,updated};
}
// Chart of Accounts is the real source of Pleo "Category" names. accountId on
// each accounting entry resolves here — never against family/subFamily (both
// always generic, e.g. CARD_PURCHASE/ONLINE) or splitItems[].accountCode
// (empty on 100% of observed real records).
async function syncPleoCategories(){
  const rows=await pagedPleo('POST','/v1/chart-of-accounts:search',{body:{companyId:cfg.pleoCompanyId,excludeIfAssignedToCategory:false,excludeIfAssignedToContraAccount:false},limit:100});
  const t=iso(); const prov=provenanceFor('CHART_OF_ACCOUNTS_API','REFERENCE_DATA'); let inserted=0, updated=0;
  for(const c of rows){
    const existing=db.prepare('SELECT id FROM pleo_categories WHERE id=?').get(c.id);
    db.prepare(`INSERT INTO pleo_categories(id,company_id,name,code,archived,source_system,source_environment,synced_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET company_id=excluded.company_id,name=excluded.name,code=excluded.code,archived=excluded.archived,source_system=excluded.source_system,source_environment=excluded.source_environment,synced_at=excluded.synced_at,updated_at=excluded.updated_at`)
      .run(c.id,c.companyId||cfg.pleoCompanyId,c.name||c.id,c.code||null,c.archived?1:0,prov.source_system,prov.source_environment,t,t,t);
    existing?updated++:inserted++;
  }
  return {recordsFetched:rows.length,inserted,updated};
}
// One-off retroactive fix: resolves category on already-ingested transactions
// from their stored raw payload once pleo_categories has real data, without
// requiring a full re-sync of the 20k+ existing rows.
// One-off retroactive fix: re-derives category + Billing Status classification
// on already-ingested transactions from their stored raw payload, using
// whatever reference/mapping data exists *now* — without requiring a full
// re-sync of tens of thousands of rows. Called after reference-data sync and
// after any billing-status-mapping edit. Project attribution is deliberately
// NOT touched here — it only changes via ingestion, an approved project
// mapping rule (applyProjectMappingRulesToAll) or manual review.
// dq_* flags are NOT computed per-row here either — recalculateAllTransactionQuality()
// runs once at the end instead, reading whatever this loop just wrote (this is
// also what fixes drift for rows this loop doesn't touch at all, e.g. stale
// project-status-driven flags from before these columns existed).
async function recomputeDerivedFieldsFromRaw(){
  const categoryMap=await loadCategoryMap();
  // Preloaded once, not per row — and wrapped in a single transaction rather
  // than SQLite's default autocommit (one fsync per statement). Both matter
  // at 40k+ rows: an earlier version of this function blocked the Node event
  // loop for ~50s on a single admin mapping edit before this fix.
  const billingCtx=loadBillingStatusContext();
  invalidateAttributionContext(); const {accountCategories}=loadAttributionContext();
  const rows=db.prepare(`SELECT r.accounting_entry_id,r.raw_json,t.id AS tx_id,t.historical_category_name,t.manual_category_name FROM pleo_raw_entries r JOIN transactions t ON t.pleo_accounting_entry_id=r.accounting_entry_id WHERE r.source_mode='accounting_entries_v1'`).all();
  let updated=0; const t=iso();
  const stmt=db.prepare(`UPDATE transactions SET category=?,pleo_account_id=?,pleo_category_id=?,category_resolution_status=?,category_source=?,resolved_category_name=?,category_resolution_source=?,pleo_billing_status_tag_id=?,pleo_billing_status_tag_name=?,commercial_classification_derived=?,classification_status=?,updated_at=? WHERE id=?`);
  db.exec('BEGIN');
  try{
    for(const row of rows){
      let item; try{item=JSON.parse(row.raw_json);}catch{continue;}
      const cat=classifyCategoryFields(item.accountId||null, categoryMap);
      const catMerged=mergeCategoryEvidence({historical_category_name:row.historical_category_name,manual_category_name:row.manual_category_name}, cat, cat.pleo_account_id?accountCategories.get(cat.pleo_account_id):null);
      const billing=classifyBillingStatusWithContext(item, billingCtx);
      stmt.run(cat.category, cat.pleo_account_id, cat.pleo_category_id, cat.category_resolution_status, 'PLEO_ACCOUNTING_API', catMerged.resolved_category_name, catMerged.category_resolution_source, billing.pleo_billing_status_tag_id, billing.pleo_billing_status_tag_name, billing.commercial_classification_derived, billing.classification_status, t, row.tx_id);
      updated++;
    }
    db.exec('COMMIT');
  }catch(e){ db.exec('ROLLBACK'); throw e; }
  recalculateAllTransactionQuality();
  return {scanned:rows.length,updated};
}
// === Pleo Excel import — bootstrap reference data from the finance team's
// existing Pleo expense export (the per-project Excel workflow Expensyra
// replaces). Enrichment only: rows are matched to already-synced live
// transactions by Expense ID (= Pleo accounting entry id); nothing is
// inserted as a transaction and no JSAN decision is touched. It learns:
//   - team_id → Team name (the API gives ids only; JSAN Team names carry the
//     project code, e.g. "PRJ-005-CT-AV-US-Waymo");
//   - a Project per Pleo Team. At JSAN a Pleo Team IS the project, so each
//     team gets a Project Master row and an APPROVED PLEO_TEAM rule, applied
//     to every stored transaction straight away (no separate approval step);
//   - accountId → Category name (applies to every month, not just the file's);
//   - per-row Category, Pleo Review Status, Reviewer and Review Note as
//     reference evidence.
// Only majority-consistent evidence is learned (IMPORT_AGREEMENT); anything
// less is reported back as ambiguous instead of guessed.
const PLEO_EXCEL_REQUIRED=['Expense ID','Team','Category','Review Status'];
const IMPORT_AGREEMENT=0.9;
// "PRJ-005-CT-AV-US-Waymo" → code PRJ-005, customer Waymo. Teams without a
// PRJ number (e.g. "TechM Bhanu Kasala", "JSAN FRANCE") are projects too;
// their code is the upper-cased team name.
function projectFromTeamName(teamName){
  const name=String(teamName||'').trim(); if(!name) return null;
  const m=/^(PRJ-\d+)\b/i.exec(name);
  if(m){ const parts=name.split('-').map(s=>s.trim()).filter(Boolean); return {code:m[1].toUpperCase(), name, customer:parts.length>2?parts[parts.length-1]:null}; }
  return {code:name.toUpperCase().replace(/[^A-Z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,50)||'TEAM', name, customer:null};
}
function tallyWinner(votes){
  let total=0, top=null, topCount=0;
  for(const [value,count] of votes){ total+=count; if(count>topCount){top=value;topCount=count;} }
  return {value:top, count:topCount, total, share:total?topCount/total:0, alternatives:[...votes].filter(([v])=>v!==top).map(([value,count])=>({value,count}))};
}
async function importPleoExcel(buffer,{filename,user,dryRun}){
  let sheet; try{ sheet=readFirstSheet(buffer); }catch(e){ throw Object.assign(new Error(`Could not read the Excel file: ${e.message}`),{status:400}); }
  const {sheetName,rows}=sheet;
  const hdr=(rows[0]||[]).map(h=>String(h??'').trim()); const col=n=>hdr.indexOf(n);
  const missing=PLEO_EXCEL_REQUIRED.filter(n=>col(n)<0);
  if(missing.length) throw Object.assign(new Error(`Not a Pleo expense export — missing column(s): ${missing.join(', ')}`),{status:400});
  const ix={id:col('Expense ID'),team:col('Team'),category:col('Category'),review:col('Review Status'),reviewer:col('Reviewer'),note:col('Review Note')};
  const str=v=>v==null?'':String(v).trim();
  const findTx=db.prepare('SELECT id,team_id,pleo_account_id FROM transactions WHERE pleo_accounting_entry_id=?');
  const vote=(map,key,value)=>{ let v=map.get(key); if(!v){v=new Map();map.set(key,v);} v.set(value,(v.get(value)||0)+1); };
  const matched=[], teamVotes=new Map(), acctVotes=new Map(); let dataRows=0, unmatched=0;
  for(const r of rows.slice(1)){
    const eid=str(r[ix.id]); if(!eid) continue; dataRows++;
    const tx=findTx.get(eid); if(!tx){unmatched++;continue;}
    const rec={txId:tx.id, category:str(r[ix.category])||null, review:str(r[ix.review])||null,
      reviewer:ix.reviewer>=0?(str(r[ix.reviewer])||null):null, note:ix.note>=0?(clampText(str(r[ix.note]),4000)||null):null};
    matched.push(rec);
    const team=str(r[ix.team]); if(tx.team_id&&team) vote(teamVotes,tx.team_id,team);
    if(tx.pleo_account_id&&rec.category) vote(acctVotes,tx.pleo_account_id,rec.category);
  }

  const teams=[], ambiguousTeams=[];
  for(const [teamId,votes] of teamVotes){ const w=tallyWinner(votes); (w.share>=IMPORT_AGREEMENT?teams:ambiguousTeams).push({teamId,teamName:w.value,rows:w.total,share:w.share,alternatives:w.alternatives}); }
  const accounts=[], ambiguousAccounts=[];
  for(const [accountId,votes] of acctVotes){ const w=tallyWinner(votes); (w.share>=IMPORT_AGREEMENT?accounts:ambiguousAccounts).push({accountId,category:w.value,rows:w.total,share:w.share,alternatives:w.alternatives}); }

  const projectByCode=new Map();
  for(const t of teams){ const p=projectFromTeamName(t.teamName); if(p&&!projectByCode.has(p.code)) projectByCode.set(p.code,p); }
  const projectExists=db.prepare('SELECT id FROM projects WHERE code=?');
  const projectsToCreate=[...projectByCode.values()].filter(p=>!projectExists.get(p.code));
  const ruleFor=db.prepare("SELECT id,status FROM project_mapping_rules WHERE source_type='PLEO_TEAM' AND source_value=?");
  const rulesToCreate=teams.filter(t=>!ruleFor.get(t.teamId));
  const rulesToApprove=teams.map(t=>ruleFor.get(t.teamId)).filter(r=>r&&r.status!=='APPROVED');
  const acceptedAccounts=new Set(accounts.map(a=>a.accountId));
  let categoryResolvable=0;
  for(const r of db.prepare("SELECT pleo_account_id FROM transactions WHERE (resolved_category_name IS NULL OR resolved_category_name='') AND pleo_account_id IS NOT NULL").all()) if(acceptedAccounts.has(r.pleo_account_id)) categoryResolvable++;

  const summary={
    sheetName, rows:dataRows, matched:matched.length, unmatched,
    teams:{named:teams.length, ambiguous:ambiguousTeams},
    projects:{toCreate:projectsToCreate.map(p=>p.name), alreadyExist:projectByCode.size-projectsToCreate.length, linked:rulesToCreate.length+rulesToApprove.length},
    categories:{accounts:accounts.length, ambiguous:ambiguousAccounts, unresolvedTransactionsThisWillName:categoryResolvable},
    reviewHistoryRows:matched.length,
  };
  if(dryRun) return {dryRun:true, summary};

  const t=iso(); let importId;
  db.exec('BEGIN');
  try{
    importId=Number(db.prepare('INSERT INTO pleo_excel_imports(filename,sheet_name,imported_by,row_count,matched_count,summary,imported_at) VALUES(?,?,?,?,?,?,?)').run(filename,sheetName,user.id,dataRows,matched.length,JSON.stringify(summary),t).lastInsertRowid);
    const upTeam=db.prepare('INSERT INTO pleo_team_names(team_id,team_name,rows_seen,share,import_id,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(team_id) DO UPDATE SET team_name=excluded.team_name,rows_seen=excluded.rows_seen,share=excluded.share,import_id=excluded.import_id,updated_at=excluded.updated_at');
    const fillTeam=db.prepare("UPDATE transactions SET team_name=?,updated_at=? WHERE team_id=? AND (team_name IS NULL OR team_name='')");
    for(const tm of teams){ upTeam.run(tm.teamId,tm.teamName,tm.rows,tm.share,importId,t); fillTeam.run(tm.teamName,t,tm.teamId); }
    const insProject=db.prepare("INSERT INTO projects(code,name,customer,active,status,created_at,updated_at) VALUES(?,?,?,1,'ACTIVE',?,?)");
    for(const p of projectsToCreate) insProject.run(p.code,p.name,p.customer,t,t);
    const insRule=db.prepare("INSERT INTO project_mapping_rules(source_type,source_value,project_id,status,created_by,approved_by,approved_at,created_at,updated_at) VALUES('PLEO_TEAM',?,?,'APPROVED',?,?,?,?,?)");
    for(const tm of rulesToCreate) insRule.run(tm.teamId,projectExists.get(projectFromTeamName(tm.teamName).code).id,user.id,user.id,t,t,t);
    const approveRule=db.prepare("UPDATE project_mapping_rules SET status='APPROVED',approved_by=?,approved_at=?,updated_at=? WHERE id=?");
    for(const r of rulesToApprove) approveRule.run(user.id,t,t,r.id);
    const upAcct=db.prepare("INSERT INTO account_category_mappings(pleo_account_id,category_name,source,rows_seen,import_id,updated_at) VALUES(?,?,'PLEO_EXCEL_EXPORT',?,?,?) ON CONFLICT(pleo_account_id) DO UPDATE SET category_name=excluded.category_name,source=excluded.source,rows_seen=excluded.rows_seen,import_id=excluded.import_id,updated_at=excluded.updated_at");
    for(const a of accounts) upAcct.run(a.accountId,a.category,a.rows,importId,t);
    const upRow=db.prepare('UPDATE transactions SET historical_category_name=COALESCE(?,historical_category_name),pleo_review_status_label=?,pleo_reviewer_names=?,pleo_review_note=?,updated_at=? WHERE id=?');
    for(const m of matched) upRow.run(m.category,m.review,m.reviewer,m.note,t,m.txId);
    db.exec('COMMIT');
  }catch(e){ db.exec('ROLLBACK'); throw e; }
  invalidateAttributionContext();
  // Re-derive resolved category (historical row evidence + account mapping)
  // and all dq_* flags over every stored live row.
  const categoryBackfill=await recomputeDerivedFieldsFromRaw();
  const projectBackfill=applyProjectMappingRulesToAll();
  audit(null,user.id,'PLEO_EXCEL_IMPORTED',{import_id:importId,filename,rows:dataRows,matched:matched.length,projects_created:projectsToCreate.length,projects_linked:rulesToCreate.length+rulesToApprove.length,category_accounts:accounts.length});
  return {dryRun:false, importId, summary, categoryBackfill, projectBackfill};
}
// Seeds the Billing Status → Commercial Classification mapping from an
// explicit business decision (docs/PLEO_SETUP.md §6b) — this is not inferred
// at runtime, and it never overwrites a mapping an admin has already set.
function seedBillingStatusMapping(){
  const groupId=resolveTagGroupIdByName('Billing Status');
  if(!groupId) return {seeded:0};
  const tags=db.prepare('SELECT id,name FROM pleo_tags WHERE group_id=?').all(groupId);
  // Order matters: "Project Expense – Non-Billable to Customer" contains the
  // substring "Billable to Customer", so the plain CUSTOMER_BILLABLE pattern
  // must be anchored to the start of the tag name or it wrongly matches the
  // non-billable variant too.
  const rules=[
    [/^billable to customer/i,'CUSTOMER_BILLABLE'],
    [/non-billable to customer/i,'PROJECT_NON_BILLABLE'],
    [/personal expense/i,'PERSONAL_NON_BILLABLE'],
    [/jsan internal/i,'JSAN_INTERNAL'],
    [/refund/i,'REFUND'],
  ];
  const t=iso(); let seeded=0;
  for(const tag of tags){
    if(db.prepare('SELECT pleo_tag_id FROM billing_status_mapping WHERE pleo_tag_id=?').get(tag.id)) continue;
    const match=rules.find(([re])=>re.test(tag.name));
    if(!match) continue;
    db.prepare('INSERT INTO billing_status_mapping(pleo_tag_id,pleo_tag_name,spendops_classification,created_at,updated_at) VALUES(?,?,?,?,?)').run(tag.id,tag.name,match[1],t,t);
    seeded++;
  }
  return {seeded};
}
// === Receipt/evidence enrichment: a durable queue, decoupled from ingestion ===
// This is Stage B. It never runs inside the Accounting Entries pagination loop
// (Stage A) — a receipt failure must never fail transaction ingestion, which is
// exactly what happened before this was split out (one 90-minute run killed by
// a single transient receipt-fetch error, after already fetching 500 real
// transactions that had nothing wrong with them).
const RECEIPT_CONCURRENCY=Math.max(1,Number(process.env.PLEO_RECEIPT_CONCURRENCY||4));
const RECEIPT_MAX_ATTEMPTS=Math.max(1,Number(process.env.PLEO_RECEIPT_MAX_ATTEMPTS||5));

// Fast, DB-only — called from inside the main ingestion loop. No HTTP calls,
// so it can never be the thing that makes a page fetch slow or fail.
function enqueueReceiptJobs(txId,item,runId){
  let queued=0; const t=iso();
  for(const rid of (item.receiptIds||[])){
    const existing=db.prepare('SELECT id,status FROM receipt_jobs WHERE pleo_accounting_entry_id=? AND receipt_id=?').get(item.id,rid);
    if(existing){
      if(existing.status==='AVAILABLE') continue; // already cached from a previous sync — never refetch
      if(existing.status==='FAILED') db.prepare("UPDATE receipt_jobs SET status='PENDING',attempts=0,next_retry_at=NULL,sync_run_id=? WHERE id=?").run(runId,existing.id);
      else db.prepare('UPDATE receipt_jobs SET sync_run_id=? WHERE id=?').run(runId,existing.id);
    } else {
      db.prepare(`INSERT INTO receipt_jobs(transaction_id,pleo_accounting_entry_id,receipt_id,sync_run_id,status,created_at) VALUES(?,?,?,?,'PENDING',?)`).run(txId,item.id,rid,runId,t);
    }
    queued++;
  }
  return queued;
}
function classifyReceiptFailure(e){
  const status=e.statusCode;
  const transient=e.name==='AbortError'||Boolean(e.cause)||[408,429,500,502,503,504].includes(status);
  return {transient,status};
}
// Pleo returns a short-lived signed link for a receipt file; field names vary.
async function fetchPleoReceiptLink(entryId,receiptId){
  const p=await pleoRequest('GET',`/v1/accounting-entries/${encodeURIComponent(entryId)}/receipts/${encodeURIComponent(receiptId)}`,{query:{file_type:'ORIGINAL'}});
  return {url:p.url||p.fileUrl||p.downloadUrl||p.receiptUrl||p.data?.url||p.data?.fileUrl||null,
    mime:p.mimeType||p.type||p.data?.mimeType||null, size:p.size||p.sizeInBytes||p.data?.size||p.data?.sizeInBytes||null};
}
// Receipt ids Pleo attached to this transaction (from its stored Accounting
// Entry payload) — the source of truth for the on-demand receipt viewer.
function receiptIdsFor(tx){
  const raw=db.prepare('SELECT raw_json FROM pleo_raw_entries WHERE accounting_entry_id=?').get(tx.pleo_accounting_entry_id);
  try{ return (JSON.parse(raw?.raw_json||'{}').receiptIds||[]).filter(x=>typeof x==='string'); }catch{ return []; }
}
async function processReceiptJob(job){
  db.prepare("UPDATE receipt_jobs SET status='FETCHING',started_at=? WHERE id=?").run(iso(),job.id);
  const key=`receipt-${job.receipt_id}`;
  try{
    const {url,mime,size}=await fetchPleoReceiptLink(job.pleo_accounting_entry_id,job.receipt_id);
    const t=iso();
    db.prepare(`INSERT INTO pleo_attachments(transaction_id,accounting_entry_id,file_key,receipt_id,source_url,mime_type,size_bytes,receipt_status,fetch_error,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,NULL,?,?) ON CONFLICT(accounting_entry_id,file_key) DO UPDATE SET source_url=excluded.source_url,mime_type=excluded.mime_type,size_bytes=excluded.size_bytes,receipt_status='AVAILABLE',fetch_error=NULL,updated_at=excluded.updated_at`)
      .run(job.transaction_id,job.pleo_accounting_entry_id,key,job.receipt_id,url,mime,size,'AVAILABLE',t,t);
    if(url){ const a=db.prepare('SELECT id FROM pleo_attachments WHERE accounting_entry_id=? AND file_key=?').get(job.pleo_accounting_entry_id,key); await cacheAttachment(a.id,url,mime); }
    db.prepare("UPDATE receipt_jobs SET status='AVAILABLE',completed_at=? WHERE id=?").run(iso(),job.id);
  }catch(e){
    const {transient,status}=classifyReceiptFailure(e);
    const attempts=job.attempts+1;
    if(transient && attempts<RECEIPT_MAX_ATTEMPTS){
      const backoffMs=e.retryAfterMs!=null?e.retryAfterMs:Math.min(15*60_000,1000*2**attempts)+Math.floor(Math.random()*1000);
      db.prepare("UPDATE receipt_jobs SET status='RETRY_SCHEDULED',attempts=?,next_retry_at=?,last_error_code=?,last_error_message=? WHERE id=?")
        .run(attempts,new Date(Date.now()+backoffMs).toISOString(),String(status||'NETWORK'),clampText(e.message,500),job.id);
    } else {
      db.prepare("UPDATE receipt_jobs SET status='FAILED',attempts=?,completed_at=?,last_error_code=?,last_error_message=? WHERE id=?")
        .run(attempts,iso(),String(status||'NETWORK'),clampText(e.message,500),job.id);
      const t=iso();
      db.prepare(`INSERT INTO pleo_attachments(transaction_id,accounting_entry_id,file_key,receipt_id,receipt_status,fetch_error,created_at,updated_at)
        VALUES(?,?,?,?,'FAILED',?,?,?) ON CONFLICT(accounting_entry_id,file_key) DO UPDATE SET receipt_status='FAILED',fetch_error=excluded.fetch_error,updated_at=excluded.updated_at`)
        .run(job.transaction_id,job.pleo_accounting_entry_id,key,job.receipt_id,clampText(e.message,500),t,t);
    }
  }
}
let receiptWorkerRunning=false;
async function receiptWorkerTick(){
  // With caching off, receipts are fetched on demand when a transaction is
  // opened (GET /api/transactions/:id/receipts/:receiptId), so there is
  // nothing for the background queue to do.
  // Paused while a sync runs, so a stopped (rolled-back) run never leaves
  // downloaded receipts behind for rows it removed.
  if(receiptWorkerRunning||syncInProgress||cfg.pleoMockMode||!cfg.pleoCacheAttachments) return;
  receiptWorkerRunning=true;
  try{
    const now=iso();
    const jobs=db.prepare(`SELECT * FROM receipt_jobs WHERE status IN ('PENDING','RETRY_SCHEDULED') AND (next_retry_at IS NULL OR next_retry_at<=?) ORDER BY created_at LIMIT ?`).all(now,RECEIPT_CONCURRENCY);
    if(jobs.length) await Promise.allSettled(jobs.map(processReceiptJob));
  } finally { receiptWorkerRunning=false; }
}
function receiptQueueStats(runId){
  const rows=db.prepare(`SELECT status,COUNT(*) c FROM receipt_jobs WHERE sync_run_id=? GROUP BY status`).all(runId);
  const stats={available:0,pending:0,fetching:0,retrying:0,failed:0};
  for(const r of rows){
    if(r.status==='AVAILABLE') stats.available=r.c;
    else if(r.status==='PENDING') stats.pending=r.c;
    else if(r.status==='FETCHING') stats.fetching=r.c;
    else if(r.status==='RETRY_SCHEDULED') stats.retrying=r.c;
    else if(r.status==='FAILED') stats.failed=r.c;
  }
  return stats;
}

// Provenance is decided here, once, based on actual runtime state — never
// inferred later from source_mode alone (that ambiguity is exactly what let
// 24 demo rows look indistinguishable from real Pleo data for a full session).
function provenanceFor(channel,kind){
  if(cfg.pleoMockMode) return {source_system:'DEMO',source_channel:'FIXTURE',source_environment:'MOCK',source_kind:'DEMO'};
  return {source_system:'PLEO',source_channel:channel,source_environment:'PRODUCTION',source_kind:kind};
}
// Known mock-fixture identifiers. Any row bearing one of these IDs must never
// be tagged as real, and — going the other direction — a "live" run that
// encounters one of these IDs indicates something is badly wrong (e.g. mock
// mode silently on) and must fail loudly rather than insert quietly.
const DEMO_HIST_ID_PREFIX='demo-hist-';
function isKnownDemoId(id){
  if(typeof id!=='string') return false;
  if(id.startsWith(DEMO_HIST_ID_PREFIX)) return true;
  try{ const fixtureIds=new Set(Object.values(getMockFixture().itemsByJob||{}).flat().map(x=>x.accountingEntryId).filter(Boolean)); return fixtureIds.has(id); }catch{ return false; }
}

// Persists progress mid-run (not just at completion) so polling
// /api/pleo/status during a long sync shows real numbers, not silence for 90
// minutes followed by one final result.
function updateSyncProgress(runId,{jobs=0,itemsSeen=0,inserted=0,updated=0,att=0,errors=0,pagesFetched=0}){
  db.prepare(`UPDATE pleo_sync_runs SET jobs_seen=?,items_seen=?,inserted_count=?,updated_count=?,attachment_count=?,error_count=?,pages_fetched=? WHERE id=?`)
    .run(jobs,itemsSeen,inserted,updated,att,errors,pagesFetched,runId);
}

let syncInProgress=false;
// Set by POST /api/pleo/sync/stop; the running loop checks it between pages.
let syncCancelRequested=null;
function throwIfSyncCancelled(runId){
  if(syncCancelRequested===runId)throw Object.assign(new Error('Stopped by user'),{cancelled:true});
}
// Undo what a stopped run inserted: transactions it created (never ones a
// reviewer has touched), their raw Pleo records and the receipt jobs it
// queued. Rows that already existed keep their refreshed Pleo fields.
function rollbackSyncRunInserts(runId){
  const run=db.prepare('SELECT started_at FROM pleo_sync_runs WHERE id=?').get(runId);if(!run)return {transactions:0,raw:0,jobs:0};
  const s=run.started_at,newTx=`SELECT id FROM transactions WHERE source_import_run_id=?1 AND created_at>=?2 AND reviewer_id IS NULL AND status='UNASSIGNED'`;
  db.exec('BEGIN IMMEDIATE');
  try{
    const jobs=db.prepare('DELETE FROM receipt_jobs WHERE sync_run_id=?1 AND created_at>=?2').run(runId,s).changes;
    const raw=db.prepare(`DELETE FROM pleo_raw_entries WHERE first_seen_at>=?2 AND accounting_entry_id IN (SELECT pleo_accounting_entry_id FROM transactions WHERE id IN (${newTx}))`).run(runId,s).changes;
    const transactions=db.prepare(`DELETE FROM transactions WHERE id IN (${newTx})`).run(runId,s).changes;
    db.exec('COMMIT');
    return {transactions,raw,jobs};
  }catch(e){db.exec('ROLLBACK');throw e;}
}
function finishCancelledRun(runId,counts){
  const r=rollbackSyncRunInserts(runId);
  db.prepare(`UPDATE pleo_sync_runs SET status='CANCELLED',finished_at=?,items_seen=?,inserted_count=0,updated_count=?,error_message=? WHERE id=?`)
    .run(iso(),counts.itemsSeen,counts.updated,`Stopped by user. Removed ${r.transactions} inserted transaction(s) and ${r.jobs} queued receipt job(s); ${counts.updated} existing row(s) kept their refreshed Pleo fields.`,runId);
  console.log(`[pleo sync] run #${runId} stopped by user; rolled back ${r.transactions} inserted row(s)`);
}
// Creates the run row and reserves the in-progress lock synchronously (fast,
// DB-only) so the HTTP route can return {runId} immediately instead of
// blocking on the actual multi-page fetch — closing the browser must not
// cancel a sync the server already committed to running.
function beginSyncRun(mode,triggerType,userId,{requestedFrom=null,requestedTo=null}={}){
  if(syncInProgress) throw Object.assign(new Error('A Pleo sync is already running'),{status:409});
  if(!pleoConfigured()) throw Object.assign(new Error('Pleo credentials are not configured'),{status:400});
  syncInProgress=true;syncCancelRequested=null;
  const rr=db.prepare('INSERT INTO pleo_sync_runs(mode,trigger_type,triggered_by,status,started_at,requested_from,requested_to,heartbeat_at) VALUES(?,?,?,?,?,?,?,?)')
    .run(mode,triggerType,userId,'RUNNING',iso(),requestedFrom,requestedTo,iso());
  return Number(rr.lastInsertRowid);
}
function startSyncPleo(triggerType,userId,opts={}){
  const runId=beginSyncRun(cfg.pleoSyncMode,triggerType,userId);
  syncPleo(runId,triggerType,userId,opts).catch(e=>console.error('[pleo sync]',e.statusCode?`HTTP ${e.statusCode} —`:'',e.message));
  return runId;
}
// Daily sync: one incremental run per business day at the configured time.
// A missed slot (server was off at 06:00) is caught up on the next tick.
function dailySyncSettings(){
  const en=getKv('daily_sync_enabled'),tm=normalizeSyncTime(getKv('daily_sync_time'));
  return {enabled:en==null?cfg.pleoDailySync:en==='1',time:tm||cfg.pleoDailySyncTime,timezone:cfg.businessTz};
}
function dailySyncState(now=new Date()){
  const s=dailySyncSettings(),ph=INCREMENTAL_TRIGGERS.map(()=>'?').join(',');
  const lastSuccess=db.prepare(`SELECT * FROM pleo_sync_runs WHERE status='SUCCESS' AND trigger_type IN (${ph}) ORDER BY id DESC LIMIT 1`).get(...INCREMENTAL_TRIGGERS)||null;
  const lastIncremental=db.prepare(`SELECT * FROM pleo_sync_runs WHERE trigger_type IN (${ph}) ORDER BY id DESC LIMIT 1`).get(...INCREMENTAL_TRIGGERS)||null;
  const lastDaily=db.prepare(`SELECT started_at,status FROM pleo_sync_runs WHERE trigger_type='daily' ORDER BY id DESC LIMIT 1`).get()||null;
  const decision=dailySyncDecision({...s,tz:s.timezone,now,configured:pleoConfigured(),busy:syncInProgress,lastSuccessAt:lastSuccess?.started_at,lastAttemptAt:lastDaily?.started_at,lastAttemptOk:lastDaily?(lastDaily.status==='RUNNING'?null:lastDaily.status==='SUCCESS'):null});
  return {settings:s,decision,lastSuccess,lastIncremental};
}
function dailySyncTick(){
  const {decision}=dailySyncState();
  if(!decision.run)return;
  const runId=startSyncPleo('daily',null);
  console.log(`[pleo daily sync] started run #${runId}`);
}
function startSyncPleoHistorical(dateFrom,dateTo,triggerType,userId){
  const runId=beginSyncRun('accounting_entries_v1',triggerType,userId,{requestedFrom:dateFrom,requestedTo:dateTo});
  syncPleoHistorical(runId,dateFrom,dateTo,triggerType,userId).catch(e=>console.error('[pleo historical backfill]',e.statusCode?`HTTP ${e.statusCode} —`:'',e.message));
  return runId;
}
// Pending entries have no final billed value yet. Refresh them independently
// of settlement windows so they remain visible in Transactions.
async function syncPendingEntries(runId,employeeMap,categoryMap){
  let inserted=0,updated=0,itemsSeen=0,att=0;
  const previous=new Map(db.prepare("SELECT t.pleo_accounting_entry_id,t.transaction_date,r.raw_json FROM transactions t LEFT JOIN pleo_raw_entries r ON r.accounting_entry_id=t.pleo_accounting_entry_id WHERE t.pleo_status='PENDING'").all().map(r=>[r.pleo_accounting_entry_id,r]));
  const ingest=item=>{
    if(!item.id)return;
    if(!cfg.pleoMockMode&&isKnownDemoId(item.id))throw new Error('Pending sync returned a demo ID');
    const mapped=mapAccountingEntry(item,employeeMap,categoryMap);
    Object.assign(mapped,provenanceFor('ACCOUNTING_ENTRIES_API','LIVE_API'),{source_import_run_id:runId});
    upsertRaw(item.id,item.companyId,'accounting_entries_v1',null,item);
    const result=upsertTransaction(mapped);result.inserted?inserted++:updated++;itemsSeen++;
    enqueueReceiptJobs(result.id,item,runId);att+=(item.receiptIds||[]).length;
  };
  const scan=async(body,visit,done=()=>false)=>{
    let after=null;const cursors=new Set();
    for(let page=0;page<500;page++){
      throwIfSyncCancelled(runId);
      const q={company_id:cfg.pleoCompanyId,limit:100};if(after)q.after=after;
      const response=await pleoRequest('POST','/v1/accounting-entries:search',{query:q,body});
      throwIfSyncCancelled(runId);
      for(const item of response.data||[])visit(item);
      if(done()||!response.pagination?.hasNextPage)return;
      const cursor=response.pagination.endCursor;
      if(!cursor||cursors.has(cursor))throw new Error('Invalid pending-entry pagination');
      cursors.add(cursor);after=cursor;
    }
    throw new Error('Pending-entry import exceeded page limit');
  };
  await scan({includeDeleted:false,status:['PENDING']},item=>{
    if(item.status!=='PENDING')return;
    previous.delete(item.id);ingest(item);
  });
  // A record disappearing from the pending feed may have settled or been
  // cancelled. Read its actual API status; never infer it from absence.
  if(previous.size){
    const dates=[...previous.values()].map(r=>Date.parse(safeJson(r.raw_json,{}).performedAt||r.transaction_date||'')).filter(Number.isFinite);
    const from=dates.length?new Date(Math.min(...dates)-86400_000).toISOString():null;
    const body={includeDeleted:true};if(from)body.performedAtStart=from;
    await scan(body,item=>{if(previous.has(item.id)){ingest(item);previous.delete(item.id);}},()=>previous.size===0);
  }
  return {inserted,updated,itemsSeen,att,unresolved:previous.size};
}

async function syncPleo(runId, triggerType='manual', userId=null, opts={}) {
  const mode=cfg.pleoSyncMode;
  let jobs=0,itemsSeen=0,inserted=0,updated=0,att=0,errors=0;
  try{
    if(mode==='export_v2'){
      const allJobs=[];
      for(const status of ['pending','in_progress']) { const js=await pagedPleo('GET','/v2/export-jobs',{query:{company_id:cfg.pleoCompanyId,status},limit:100}); allJobs.push(...js); }
      const uniq=[...new Map(allJobs.map(j=>[j.id,j])).values()]; jobs=uniq.length;
      for(const job of uniq){
        throwIfSyncCancelled(runId);
        let items=[]; try{items=await pagedPleo('GET','/v2/export-items',{query:{job_id:job.id},limit:100});}catch(e){errors++;continue;}
        for(const item of items){
          if(!item.accountingEntryId) continue; itemsSeen++; const m=mapExportV2(item,job.id); Object.assign(m,provenanceFor('EXPORT_V2','LIVE_API'),{source_import_run_id:runId}); upsertRaw(item.accountingEntryId,item.companyId,mode,job.id,item); const u=upsertTransaction(m); u.inserted?inserted++:updated++;
          try{att += await syncExportAttachments(u.id,item.accountingEntryId,item.files||[]);}catch{errors++;}
        }
      }
    } else if(mode==='accounting_entries_v1') {
      const employeeMap=await loadEmployeeMap(); const categoryMap=await loadCategoryMap();
      // All accounting imports use settlement dates, matching Transactions and
      // Expense Intelligence. Never reuse the old purchase-date checkpoint.
      const checkpointKey='pleo_accounting_entries_settled_last_success';
      const toMs=Date.parse(opts.to||''),endDate=Number.isFinite(toMs)?new Date(Math.min(toMs,Date.now())):new Date();
      const last=getKv(checkpointKey);
      const lastMs=Date.parse(last||''),fromMs=Date.parse(opts.from||'');
      // Window: an explicit "Sync now" range if one was chosen; otherwise
      // everything settled since the last successful sync (1h overlap for
      // late-arriving rows); first run ever: the last 24 hours only. Older
      // corrections are refreshed with a deliberate historical backfill.
      const startMs=Number.isFinite(fromMs)?fromMs:Number.isFinite(lastMs)?lastMs-60*60_000:endDate.getTime()-cfg.pleoInitialLookbackHours*3600_000;
      const startDate=new Date(startMs);
      const body={includeDeleted:false,settledAtStart:startDate.toISOString(),settledAtEnd:endDate.toISOString()};
      db.prepare('UPDATE pleo_sync_runs SET requested_from=?,requested_to=? WHERE id=?').run(body.settledAtStart,body.settledAtEnd,runId);
      let after=null,pages=0,complete=false;
      const cursors=new Set();
      while(pages<500){
        throwIfSyncCancelled(runId);
        const q={company_id:cfg.pleoCompanyId,limit:100};if(after)q.after=after;
        const p=await pleoRequest('POST','/v1/accounting-entries:search',{query:q,body});
        throwIfSyncCancelled(runId);
        const rows=p.data||[];
        for(const item of rows){
          if(!item.id)continue;
          const settledMs=Date.parse(item.settledAt||'');
          if(!Number.isFinite(settledMs)||settledMs<startMs||settledMs>endDate.getTime())continue;
          if(!cfg.pleoMockMode&&isKnownDemoId(item.id))throw new Error('Live sync returned a demo-fixture ID');
          const m=mapAccountingEntry(item,employeeMap,categoryMap);
          Object.assign(m,provenanceFor('ACCOUNTING_ENTRIES_API','LIVE_API'),{source_import_run_id:runId});
          upsertRaw(item.id,item.companyId,mode,null,item);
          const u=upsertTransaction(m);u.inserted?inserted++:updated++;itemsSeen++;
          enqueueReceiptJobs(u.id,item,runId);att+=(item.receiptIds||[]).length;
        }
        pages++;updateSyncProgress(runId,{jobs,itemsSeen,inserted,updated,att,errors,pagesFetched:pages});
        if(!p.pagination?.hasNextPage){complete=true;break;}
        const cursor=p.pagination.endCursor;
        if(!cursor||cursors.has(cursor))throw new Error('Live sync returned an invalid pagination cursor');
        cursors.add(cursor);after=cursor;
      }
      if(!complete)throw new Error('Live sync exceeded its page limit; range is incomplete');
      // A failed/partial run may safely upsert again, but must never skip pages.
      const pending=await syncPendingEntries(runId,employeeMap,categoryMap);
      inserted+=pending.inserted;updated+=pending.updated;itemsSeen+=pending.itemsSeen;att+=pending.att;
      // Advance "synced up to" only when this run joined on to the previous
      // one without a gap and reached further; a custom past range or a
      // "last 24h" run after a longer outage must not hide the missing days
      // from the next "since last sync".
      if(!Number.isFinite(lastMs)||(startMs<=lastMs&&endDate.getTime()>lastMs))setKv(checkpointKey,endDate.toISOString());
    } else throw new Error(`Unsupported PLEO_SYNC_MODE: ${mode}`);
    db.prepare(`UPDATE pleo_sync_runs SET status='SUCCESS',finished_at=?,jobs_seen=?,items_seen=?,inserted_count=?,updated_count=?,attachment_count=?,error_count=? WHERE id=?`).run(iso(),jobs,itemsSeen,inserted,updated,att,errors,runId);
    return {runId}; // fire-and-forget: no caller awaits this value; poll /api/pleo/sync-runs/:runId instead
  }catch(e){
    if(e.cancelled){finishCancelledRun(runId,{itemsSeen,updated});return {runId};}
    db.prepare(`UPDATE pleo_sync_runs SET status='FAILED',finished_at=?,jobs_seen=?,items_seen=?,inserted_count=?,updated_count=?,attachment_count=?,error_count=?,error_message=? WHERE id=?`).run(iso(),jobs,itemsSeen,inserted,updated,att,errors+1,clampText(e.message,2000),runId);
    throw e;
  }finally{syncInProgress=false;}
}

// Historical backfill: explicitly deliberate, admin-triggered, always uses the
// Accounting Entries API (v1) regardless of the configured live PLEO_SYNC_MODE,
// because Export V2 only ever exposes entries currently queued for export — it
// cannot answer "what happened in August" months after the fact. This never
// changes the live sync connector; it's a separate, one-off action.
async function syncPleoHistorical(runId, dateFrom, dateTo, triggerType, userId){
  let itemsSeen=0,inserted=0,updated=0,att=0,errors=0,skipped=0,demoFixtureCount=0,realCount=0;
  const sampleExternalIds=[]; const sourcePeriod=`${dateFrom}_${dateTo||'open'}`;
  const prov=provenanceFor('ACCOUNTING_ENTRIES_API','HISTORICAL_API');
  try{
    const employeeMap=await loadEmployeeMap(); const categoryMap=await loadCategoryMap();
    const fromDate=new Date(dateFrom+(dateFrom.includes('T')?'':'T00:00:00Z'));
    const fromBoundMs=fromDate.getTime();
    const toDate=dateTo?new Date(dateTo+(dateTo.includes('T')?'':'T23:59:59.999Z')):null;
    const toBoundMs=toDate?toDate.getTime():null;
    let after=null,pages=0,complete=false;
    const cursors=new Set();
    const body={includeDeleted:false,settledAtStart:fromDate.toISOString()};
    if(toDate) body.settledAtEnd=toDate.toISOString();
    while(pages<500){
      throwIfSyncCancelled(runId);
      const q={company_id:cfg.pleoCompanyId,limit:100}; if(after) q.after=after;
      const p=await pleoRequest('POST','/v1/accounting-entries:search',{query:q,body}); const rows=p.data||[];
      throwIfSyncCancelled(runId);
      pages++;
      console.log(`[Pleo historical backfill] Page ${pages}: ${rows.length} record(s)`);
      for(const item of rows){
        if(!item.id) continue;
        // Match the transaction/reporting date, including purchases made before
        // this month that settled inside it. Do not break on unsorted API rows.
        const whenMs=Date.parse(item.settledAt||'');
        if(!Number.isFinite(whenMs)||whenMs<fromBoundMs||(toBoundMs!=null&&whenMs>toBoundMs))continue;
        // Hard fixture exclusion — a "live" run must never silently absorb a
        // known demo ID. In mock mode this is expected and not an error; in
        // real mode this indicates something is badly wrong and must fail.
        if(isKnownDemoId(item.id)){
          demoFixtureCount++;
          if(!cfg.pleoMockMode){ errors++; skipped++; continue; }
        } else realCount++;
        if(sampleExternalIds.length<5) sampleExternalIds.push(item.id);
        itemsSeen++;
        const m=mapAccountingEntry(item,employeeMap,categoryMap); Object.assign(m,prov,{source_import_run_id:runId,source_period:sourcePeriod});
        upsertRaw(item.id,item.companyId,'accounting_entries_v1',null,item); const u=upsertTransaction(m); u.inserted?inserted++:updated++;
        enqueueReceiptJobs(u.id,item,runId); att+=(item.receiptIds||[]).length;
      }
      updateSyncProgress(runId,{jobs:0,itemsSeen,inserted,updated,att,errors,pagesFetched:pages});
      if(!p.pagination?.hasNextPage){complete=true;break;}
      if(!p.pagination.endCursor||cursors.has(p.pagination.endCursor))throw new Error('Historical sync returned an invalid pagination cursor');
      cursors.add(p.pagination.endCursor);after=p.pagination.endCursor;
    }
    if(!complete)throw new Error('Historical sync exceeded its page limit; range is incomplete');
    if(!cfg.pleoMockMode && demoFixtureCount>0){
      throw Object.assign(new Error(`Live backfill encountered ${demoFixtureCount} known demo-fixture ID(s) while PLEO_MOCK_MODE is off — refusing to continue. This should never happen against a real account; check for ID collisions.`),{status:500});
    }
    console.log(`[Pleo historical backfill] Total fetched: ${itemsSeen} | real=${realCount} demo=${demoFixtureCount} skipped=${skipped}`);
    db.prepare(`UPDATE pleo_sync_runs SET status='SUCCESS',finished_at=?,items_seen=?,inserted_count=?,updated_count=?,attachment_count=?,error_count=?,real_count=?,demo_fixture_count=?,sample_external_ids=? WHERE id=?`)
      .run(iso(),itemsSeen,inserted,updated,att,errors,realCount,demoFixtureCount,JSON.stringify(sampleExternalIds),runId);
    return {runId};
  }catch(e){
    if(e.cancelled){finishCancelledRun(runId,{itemsSeen,updated});return {runId};}
    db.prepare(`UPDATE pleo_sync_runs SET status='FAILED',finished_at=?,items_seen=?,inserted_count=?,updated_count=?,attachment_count=?,error_count=?,error_message=? WHERE id=?`).run(iso(),itemsSeen,inserted,updated,att,errors+1,clampText(e.message,2000),runId);
    throw e;
  }finally{syncInProgress=false;}
}

function closeSession(session, reason='PAUSED', endAt=new Date()) {
  if(!session || session.ended_at) return 0; const end=endAt instanceof Date?endAt:new Date(endAt); const start=new Date(session.started_at); const seconds=Math.max(0,Math.round((end-start)/1000));
  db.prepare('UPDATE work_sessions SET ended_at=?,seconds=?,end_reason=? WHERE id=?').run(end.toISOString(),seconds,reason,session.id); return seconds;
}
function closeUserOpenSessions(userId, reason='SWITCHED') {
  const sessions=db.prepare('SELECT * FROM work_sessions WHERE user_id=? AND ended_at IS NULL').all(userId); let n=0;
  for(const s of sessions){closeSession(s,reason,new Date(s.last_heartbeat_at||s.started_at)); const tx=db.prepare('SELECT status FROM transactions WHERE id=?').get(s.transaction_id); if(tx?.status==='IN_REVIEW') db.prepare(`UPDATE transactions SET status='ASSIGNED',updated_at=? WHERE id=?`).run(iso(),s.transaction_id); audit(s.transaction_id,userId,'VALIDATION_AUTO_PAUSED',{reason}); n++;}
  return n;
}
function sweepStaleSessions(){
  const cutoff=new Date(Date.now()-cfg.idleSeconds*1000); const rows=db.prepare('SELECT * FROM work_sessions WHERE ended_at IS NULL').all();
  for(const s of rows){ const hb=new Date(s.last_heartbeat_at||s.started_at); if(hb<cutoff){closeSession(s,'IDLE_TIMEOUT',hb); const tx=db.prepare('SELECT status FROM transactions WHERE id=?').get(s.transaction_id); if(tx?.status==='IN_REVIEW')db.prepare(`UPDATE transactions SET status='ASSIGNED',updated_at=? WHERE id=?`).run(iso(),s.transaction_id);audit(s.transaction_id,s.user_id,'VALIDATION_AUTO_PAUSED',{reason:'IDLE_TIMEOUT'});}}
}
function sessionSecondsForTxUser(txId,userId){return Number(db.prepare('SELECT COALESCE(SUM(COALESCE(seconds,0)),0) s FROM work_sessions WHERE transaction_id=? AND user_id=?').get(txId,userId).s||0);}
function reviewedSecondsForTxUser(txId,userId){return Number(db.prepare('SELECT COALESCE(SUM(review_seconds),0) s FROM reviews WHERE transaction_id=? AND user_id=?').get(txId,userId).s||0);}

function parseCsv(text) {
  const rows=[]; let row=[],field='',q=false; const s=text.replace(/^\uFEFF/,'');
  for(let i=0;i<s.length;i++){const ch=s[i]; if(q){if(ch==='"'&&s[i+1]==='"'){field+='"';i++;}else if(ch==='"')q=false;else field+=ch;}else{if(ch==='"')q=true;else if(ch===','){row.push(field);field='';}else if(ch==='\n'){row.push(field.replace(/\r$/,''));rows.push(row);row=[];field='';}else field+=ch;}}
  if(field.length||row.length){row.push(field.replace(/\r$/,''));rows.push(row);} if(!rows.length)return[];const h=rows.shift().map(x=>x.trim());return rows.filter(r=>r.some(v=>String(v).trim())).map(r=>Object.fromEntries(h.map((x,i)=>[x,(r[i]??'').trim()])));
}
const norm=s=>String(s||'').toLowerCase().replace(/[^a-z0-9]/g,'');
function pick(r,names){const m=new Map(Object.keys(r).map(k=>[norm(k),r[k]]));for(const n of names){const v=m.get(norm(n));if(v!==undefined&&v!=='')return v;}return'';}
function num(v){const n=Number(String(v||'').replace(/[^0-9.-]/g,''));return Number.isFinite(n)?n:0;}
function mapRecovery(row,idx){const id=pick(row,['Expense ID','Expense Id','Transaction ID','ID'])||`RECOVERY-${Date.now()}-${idx}`;return{pleo_accounting_entry_id:`recovery:${id}`,pleo_reconciliation_id:id,employee_id:null,employee_name:pick(row,['Employee name','Employee','Cardholder','User name']),employee_email:pick(row,['Employee email','User email','Email'])||null,team_id:null,team_name:pick(row,['Team name','Team'])||null,merchant:pick(row,['Merchant name','Merchant','Supplier'])||null,merchant_country:pick(row,['Merchant country code','Merchant country','Country'])||null,category:pick(row,['Category name','Category'])||null,tags:pick(row,['Tags','Tag'])||'',expense_type:pick(row,['Expense type','Type'])||null,transaction_date:pick(row,['Settled date','Transaction date','Date','Authorised date'])||null,amount:num(pick(row,['Settled amount','Amount','Authorised amount'])),currency:pick(row,['Settled currency','Currency','Authorised currency'])||null,note:pick(row,['Note','Notes','Description'])||null,receipt_count:0,pleo_review_status:pick(row,['Review status'])||null,pleo_status:null,source_mode:'recovery_csv',raw:row,jobId:null};}

function transactionAccess(user,tx){return ['ADMIN','TEAM_LEAD','FINANCE_QC'].includes(user.role) || tx.reviewer_id===user.id;}
function rowTx(id){return db.prepare(`SELECT t.*,u.name reviewer_name,u.email reviewer_email,ap.code attributed_project_code,ap.name attributed_project_name FROM transactions t LEFT JOIN users u ON u.id=t.reviewer_id LEFT JOIN projects ap ON ap.id=t.project_id WHERE t.id=?`).get(id);}

// Expands `month=YYYY-MM` into a first/last-day range, or falls back to explicit
// dateFrom/dateTo. Shared by the transaction list and every analytics endpoint
// so "August 2026" means the same thing everywhere.
function parseMonthOrRange(url){
  const month=url.searchParams.get('month');
  if(month && /^\d{4}-\d{2}$/.test(month)){
    const [y,m]=month.split('-').map(Number);
    const lastDay=new Date(Date.UTC(y,m,0)).getUTCDate();
    return {from:`${month}-01`, to:`${month}-${String(lastDay).padStart(2,'0')}`};
  }
  return {from:url.searchParams.get('dateFrom')||null, to:url.searchParams.get('dateTo')||null};
}

// A transaction's project for filtering/reporting: the reviewer's decision
// when one exists, otherwise the precedence-resolved attribution (approved
// mapping rule / Pleo tag). Correlated lookup on projects' primary key, so it
// works in any `FROM transactions t` query without changing its joins.
const EFFECTIVE_PROJECT_SQL="COALESCE(t.project_code,(SELECT code FROM projects WHERE id=t.project_id))";
function availableCategoryNames(){
  return db.prepare(`WITH names(name) AS (
    SELECT name FROM pleo_categories WHERE archived=0
    UNION ALL SELECT category_name FROM account_category_mappings
    UNION ALL SELECT category FROM transactions
    UNION ALL SELECT resolved_category_name FROM transactions
    UNION ALL SELECT manual_category_name FROM transactions
    UNION ALL SELECT historical_category_name FROM transactions
  ) SELECT MIN(TRIM(name)) AS name FROM names
    WHERE name IS NOT NULL AND TRIM(name)<>''
    GROUP BY TRIM(name) COLLATE NOCASE ORDER BY name COLLATE NOCASE`).all().map(r=>r.name);
}
function transactionList(user,url){
  const {whereSql,args}=transactionWhere(user,url.searchParams);
  const limit=Math.min(500,Math.max(1,Number(url.searchParams.get('limit')||200)));
  const offset=Math.max(0,Number(url.searchParams.get('offset')||0));
  const total=db.prepare(`SELECT COUNT(*) c FROM transactions t ${whereSql}`).get(...args).c;
  const rows=db.prepare(`SELECT t.*,u.name reviewer_name,${EFFECTIVE_PROJECT_SQL} effective_project_code FROM transactions t LEFT JOIN users u ON u.id=t.reviewer_id ${whereSql} ORDER BY COALESCE(t.transaction_date,t.created_at) DESC,t.id DESC LIMIT ? OFFSET ?`).all(...args,limit,offset);
  const names=new Map(db.prepare('SELECT code,name FROM projects').all().map(p=>[p.code,p.name]));
  for(const r of rows) r.effective_project_name=r.effective_project_code?(names.get(r.effective_project_code)||r.effective_project_code):null;
  const pendingTotal=user.role==='REVIEWER'?db.prepare("SELECT count(*) n FROM transactions WHERE pleo_status='PENDING' AND reviewer_id=?").get(user.id).n:db.prepare("SELECT count(*) n FROM transactions WHERE pleo_status='PENDING'").get().n;
  const evidenceParams=new URLSearchParams(url.searchParams);evidenceParams.delete('receipt_status');
  const evidenceWhere=transactionWhere(user,evidenceParams);
  const evidenceCounts=db.prepare(`SELECT COUNT(*) total,COALESCE(SUM(t.receipt_count>0),0) present,COALESCE(SUM(t.receipt_count=0),0) missing FROM transactions t ${evidenceWhere.whereSql}`).get(...evidenceWhere.args);
  return {rows,total,pendingTotal,evidenceCounts,limit,offset,page:Math.floor(offset/limit)+1,totalPages:Math.max(1,Math.ceil(total/limit))};
}
// Shared by the transaction list and filter-based bulk allocation, so
// "Assign all matching" always acts on exactly the set the list showed.
function transactionWhere(user,params){
  const wh=[],args=[]; if(user.role==='REVIEWER'){wh.push('t.reviewer_id=?');args.push(user.id);} const status=params.get('status');if(status){wh.push('t.status=?');args.push(status);} const reviewer=params.get('reviewer_id');if(reviewer&&user.role!=='REVIEWER'){wh.push('t.reviewer_id=?');args.push(Number(reviewer));}
  const q=params.get('q');if(q){wh.push('(t.merchant LIKE ? OR t.employee_name LIKE ? OR t.pleo_accounting_entry_id LIKE ? OR t.pleo_reconciliation_id LIKE ?)');const s=`%${q.slice(0,100)}%`;args.push(s,s,s,s);} const project=params.get('project');if(project){wh.push(`${EFFECTIVE_PROJECT_SQL}=?`);args.push(project);}
  const pleoStatus=params.get('pleo_status');if(pleoStatus){wh.push('t.pleo_status=?');args.push(pleoStatus);}
  const pleoReview=params.get('pleo_review');if(pleoReview){wh.push('t.pleo_review_status=?');args.push(pleoReview);}
  const category=params.get('category');if(category){wh.push('COALESCE(t.resolved_category_name,t.category)=?');args.push(category);}
  const currency=params.get('currency');if(currency){wh.push('t.currency=?');args.push(currency);}
  const commercial=params.get('commercial_classification');if(commercial){wh.push('t.commercial_classification=?');args.push(commercial);}
  const merchant=params.get('merchant');if(merchant){wh.push('t.merchant=?');args.push(merchant);}
  const receiptStatus=params.get('receipt_status');if(receiptStatus==='missing'){wh.push('t.receipt_count=0');}else if(receiptStatus==='present'){wh.push('t.receipt_count>0');}
  const source=params.get('source');if(source){wh.push('t.source_kind=?');args.push(source);}
  // "New from last sync": rows first inserted at/after a sync run's start.
  const newSince=params.get('new_since');if(newSince&&!isNaN(Date.parse(newSince))){wh.push('t.created_at>=?');args.push(new Date(newSince).toISOString());}
  // Explicit resolution-state filters — "All Projects / Mapped Projects /
  // Missing Project" and the four Expense Intelligence drill-down chips read
  // these, never a generic "Uncategorized" text match.
  const projectStatus=params.get('project_status');if(projectStatus){wh.push('t.project_status=?');args.push(projectStatus);}
  const classificationStatus=params.get('classification_status');if(classificationStatus){wh.push('t.classification_status=?');args.push(classificationStatus);}
  const categoryStatus=params.get('category_status');if(categoryStatus==='UNRESOLVED'){wh.push("t.category_resolution_status IS NOT NULL AND t.category_resolution_status<>'CATEGORY_RESOLVED'");}else if(categoryStatus){wh.push('t.category_resolution_status=?');args.push(categoryStatus);}
  const {from,to}=parseMonthOrRange({searchParams:params}); if(from){wh.push('date(t.transaction_date)>=date(?)');args.push(from);} if(to){wh.push('date(t.transaction_date)<=date(?)');args.push(to);}
  return {whereSql:wh.length?'WHERE '+wh.join(' AND '):'',args};
}

// Fixed-shape filter for analytics endpoints: always exactly 10 bound values
// (?1..?10), each a no-op when null, so every aggregate query below can share
// the exact same `where`+`args` pair regardless of which filters are active.
function expenseFilters(url){
  const {from,to}=parseMonthOrRange(url);
  const project=url.searchParams.get('project')||null;
  const category=url.searchParams.get('category')||null;
  const currency=url.searchParams.get('currency')||null;
  const commercial=url.searchParams.get('commercial_classification')||null;
  const status=url.searchParams.get('status')||null;
  const reviewerIdRaw=url.searchParams.get('reviewer_id'); const reviewerId=reviewerIdRaw?Number(reviewerIdRaw):null;
  const merchant=url.searchParams.get('merchant')||null;
  const receiptStatus=url.searchParams.get('receipt_status')||null;
  const projectStatus=url.searchParams.get('project_status')||null;
  const where=`WHERE (?1 IS NULL OR date(t.transaction_date)>=date(?1))
    AND (?2 IS NULL OR date(t.transaction_date)<=date(?2))
    AND (?3 IS NULL OR ${EFFECTIVE_PROJECT_SQL}=?3)
    AND (?4 IS NULL OR COALESCE(t.resolved_category_name,t.category)=?4)
    AND (?5 IS NULL OR t.currency=?5)
    AND (?6 IS NULL OR t.commercial_classification=?6)
    AND (?7 IS NULL OR t.status=?7)
    AND (?8 IS NULL OR t.reviewer_id=?8)
    AND (?9 IS NULL OR t.merchant=?9)
    AND (?10 IS NULL OR (?10='missing' AND t.receipt_count=0) OR (?10='present' AND t.receipt_count>0))
    AND (?11 IS NULL OR t.project_status=?11)`;
  return {where, args:[from,to,project,category,currency,commercial,status,reviewerId,merchant,receiptStatus,projectStatus], from, to};
}

async function api(req,res,url){
  try{
    if(req.method==='GET'&&url.pathname==='/api/health') return json(res,200,{status:'ok',service:'JSAN Expensyra',time:iso(),db:db.dialect,pleoConfigured:pleoConfigured(),syncMode:cfg.pleoSyncMode});
    if(req.method==='GET'&&url.pathname==='/api/setup/status') return json(res,200,{setupRequired:db.prepare('SELECT COUNT(*) c FROM users').get().c===0});
    if(req.method==='POST'&&url.pathname==='/api/setup/admin'){
      if(db.prepare('SELECT COUNT(*) c FROM users').get().c!==0) return json(res,409,{error:'Initial setup already completed'}); const b=await readJson(req); const name=clampText(b.name,120).trim(),email=clampText(b.email,200).trim().toLowerCase(),pw=String(b.password||'');
      if(!name||!email.includes('@')||pw.length<12)return json(res,400,{error:'Name, valid email and password of at least 12 characters are required'}); const id=createUser(name,email,'ADMIN',pw,0);audit(null,id,'INITIAL_ADMIN_CREATED',{email});return json(res,201,{ok:true});
    }
    if(req.method==='POST'&&url.pathname==='/api/auth/login'){
      const b=await readJson(req);const u=db.prepare('SELECT * FROM users WHERE email=? AND active=1').get(String(b.email||'').trim().toLowerCase());if(!u||!verifyPassword(String(b.password||''),u.password_salt,u.password_hash))return json(res,401,{error:'Invalid email or password'});const s=newSession(u.id);return json(res,200,{user:{id:u.id,name:u.name,email:u.email,role:u.role,must_change_password:Boolean(u.must_change_password)}},{'Set-Cookie':cookie('jsan_spendops_session',s.token,{maxAge:cfg.sessionTtlHours*3600})});
    }
    if(req.method==='POST'&&url.pathname==='/api/auth/logout'){const c=parseCookies(req);if(c.jsan_spendops_session)db.prepare('DELETE FROM auth_sessions WHERE token_hash=?').run(tokenHash(c.jsan_spendops_session));return json(res,200,{ok:true},{'Set-Cookie':cookie('jsan_spendops_session','',{maxAge:0})});}

    const user=requireAuth(req,res); if(!user)return;
    if(user.must_change_password && !(['/api/me','/api/auth/change-password'].includes(url.pathname))) return json(res,428,{error:'Password change required before continuing',code:'PASSWORD_CHANGE_REQUIRED'});
    if(req.method==='GET'&&url.pathname==='/api/me') return json(res,200,{user:{id:user.id,name:user.name,email:user.email,role:user.role,must_change_password:Boolean(user.must_change_password)}});
    if(req.method==='POST'&&url.pathname==='/api/auth/change-password'){
      const b=await readJson(req);const row=db.prepare('SELECT * FROM users WHERE id=?').get(user.id);if(!verifyPassword(String(b.current_password||''),row.password_salt,row.password_hash))return json(res,400,{error:'Current password is incorrect'});const pw=String(b.new_password||'');if(pw.length<12)return json(res,400,{error:'New password must be at least 12 characters'});const h=hashPassword(pw);db.prepare('UPDATE users SET password_hash=?,password_salt=?,must_change_password=0,updated_at=? WHERE id=?').run(h.hash,h.salt,iso(),user.id);db.prepare('DELETE FROM auth_sessions WHERE user_id=? AND id<>?').run(user.id,user.session_id);return json(res,200,{ok:true});
    }
    if(req.method==='GET'&&url.pathname==='/api/bootstrap'){
      const users=['ADMIN','TEAM_LEAD','FINANCE_QC'].includes(user.role)?db.prepare('SELECT id,name,email,role,active FROM users WHERE active=1 ORDER BY role,name').all():[];
      return json(res,200,{user,projects:db.prepare('SELECT code,name,customer FROM projects WHERE active=1 ORDER BY name').all(),users,config:{businessTz:cfg.businessTz,allowRecoveryImport:cfg.allowRecoveryImport,syncMode:cfg.pleoSyncMode,idleTimeoutSeconds:cfg.idleSeconds}});
    }
    if(req.method==='GET'&&url.pathname==='/api/car-rentals'){
      const u=requireAuth(req,res,['ADMIN','TEAM_LEAD','FINANCE_QC']);if(!u)return;
      try{
        const source=await loadCarRentalRows(url.searchParams.get('refresh')==='1');
        const dashboard=buildCarRentalDashboard(source.rows,{months:url.searchParams.getAll('month'),companies:url.searchParams.getAll('company'),projects:url.searchParams.getAll('project')});
        return json(res,200,{...dashboard,sheetName:source.sheetName,loadedAt:source.loadedAt,stale:source.stale});
      }catch(error){return json(res,502,{error:`Car rental workbook unavailable: ${clampText(error.message,400)}`});}
    }
    if(req.method==='GET'&&url.pathname==='/api/dashboard'){
      const scope=user.role==='REVIEWER'?'WHERE reviewer_id=?':'';const args=user.role==='REVIEWER'?[user.id]:[];const counts=db.prepare(`SELECT COUNT(*) total,SUM(status='UNASSIGNED') unassigned,SUM(status='ASSIGNED') assigned,SUM(status='IN_REVIEW') in_review,SUM(status='NEEDS_INFO') needs_info,SUM(status='APPROVED') approved,SUM(status='REJECTED') rejected FROM transactions ${scope}`).get(...args);
      const day=today(); const validations=user.role==='REVIEWER'?db.prepare('SELECT COUNT(*) c,COALESCE(SUM(review_seconds),0) review_secs FROM reviews WHERE business_day=? AND user_id=?').get(day,user.id):db.prepare('SELECT COUNT(*) c,COALESCE(SUM(review_seconds),0) review_secs FROM reviews WHERE business_day=?').get(day);
      const active=user.role==='REVIEWER'?db.prepare(`SELECT COALESCE(SUM(CASE WHEN ended_at IS NULL THEN MAX(0,CAST((julianday(last_heartbeat_at)-julianday(started_at))*86400 AS INTEGER)) ELSE COALESCE(seconds,0) END),0) secs FROM work_sessions WHERE business_day=? AND user_id=?`).get(day,user.id):db.prepare(`SELECT COALESCE(SUM(CASE WHEN ended_at IS NULL THEN MAX(0,CAST((julianday(last_heartbeat_at)-julianday(started_at))*86400 AS INTEGER)) ELSE COALESCE(seconds,0) END),0) secs FROM work_sessions WHERE business_day=?`).get(day);
      const completed=user.role==='REVIEWER'?db.prepare("SELECT COUNT(*) c FROM transactions WHERE completion_day=? AND reviewer_id=?").get(day,user.id):db.prepare("SELECT COUNT(*) c FROM transactions WHERE completion_day=?").get(day);
      const pending=user.role==='REVIEWER'?db.prepare("SELECT COUNT(*) c FROM transactions WHERE reviewer_id=? AND status IN ('ASSIGNED','IN_REVIEW','NEEDS_INFO')").get(user.id):db.prepare("SELECT COUNT(*) c FROM transactions WHERE status IN ('UNASSIGNED','ASSIGNED','IN_REVIEW','NEEDS_INFO')").get();
      const latest=db.prepare('SELECT * FROM pleo_sync_runs ORDER BY id DESC LIMIT 1').get()||null; return json(res,200,{counts,validationsToday:validations.c||0,activeSecondsToday:active.secs||0,reviewSecondsToday:validations.review_secs||0,completedToday:completed.c||0,pending:pending.c||0,latestSync:latest});
    }
    if(req.method==='GET'&&url.pathname==='/api/team'){
      const u=requireAuth(req,res,['ADMIN','TEAM_LEAD','FINANCE_QC']);if(!u)return;const day=today();const rows=db.prepare(`SELECT usr.id,usr.name,usr.email,usr.role,
        (SELECT COUNT(*) FROM transactions t WHERE t.reviewer_id=usr.id AND t.allocation_day=?) assigned_today,
        (SELECT COUNT(*) FROM reviews r WHERE r.user_id=usr.id AND r.business_day=?) validations_today,
        (SELECT COUNT(*) FROM reviews r WHERE r.user_id=usr.id AND r.business_day=? AND r.decision='APPROVED') approved_today,
        (SELECT COUNT(*) FROM reviews r WHERE r.user_id=usr.id AND r.business_day=? AND r.decision='REJECTED') rejected_today,
        (SELECT COUNT(*) FROM reviews r WHERE r.user_id=usr.id AND r.business_day=? AND r.decision='NEEDS_INFO') needs_info_today,
        (SELECT COALESCE(SUM(r.review_seconds),0) FROM reviews r WHERE r.user_id=usr.id AND r.business_day=?) review_seconds_today,
        (SELECT COALESCE(SUM(CASE WHEN w.ended_at IS NULL THEN MAX(0,CAST((julianday(w.last_heartbeat_at)-julianday(w.started_at))*86400 AS INTEGER)) ELSE COALESCE(w.seconds,0) END),0) FROM work_sessions w WHERE w.user_id=usr.id AND w.business_day=?) active_seconds_today,
        (SELECT COUNT(*) FROM transactions t WHERE t.reviewer_id=usr.id AND t.status IN ('ASSIGNED','IN_REVIEW','NEEDS_INFO')) pending,
        (SELECT COUNT(*) FROM work_sessions w WHERE w.user_id=usr.id AND w.ended_at IS NULL) active_sessions
        FROM users usr WHERE usr.active=1 AND usr.role='REVIEWER' ORDER BY usr.name`).all(day,day,day,day,day,day,day);
      return json(res,200,{day,rows:rows.map(r=>({...r,avg_seconds:r.validations_today?Math.round(r.review_seconds_today/r.validations_today):0}))});
    }
    // === EXPENSE INTELLIGENCE ===
    // All money is grouped by currency, never summed across currencies (no FX
    // model exists in this codebase). Filters: month=YYYY-MM or dateFrom/dateTo,
    // project, category, currency, commercial_classification, status,
    // reviewer_id, merchant, receipt_status.
    if(req.method==='GET'&&url.pathname==='/api/data-version'){
      const u=requireAuth(req,res,['ADMIN','TEAM_LEAD','FINANCE_QC']);if(!u)return;
      return json(res,200,{version:dataVersion()});
    }
    if(req.method==='GET'&&url.pathname==='/api/analytics/expense/summary'){
      const u=requireAuth(req,res,['ADMIN','TEAM_LEAD','FINANCE_QC']);if(!u)return;
      // Return full history so changing the displayed month never resets carry-forward.
      const rows=db.prepare(`SELECT t.pleo_accounting_entry_id,r.raw_json,t.transaction_date,t.bill_currency,t.bill_amount,t.pleo_status,t.expense_type,t.pleo_family,t.pleo_sub_family,
        t.resolved_category_name,t.manual_category_name,t.category,t.team_name,t.source_system,t.source_environment,t.source_kind,t.commercial_classification,t.salary_deduction_amount,t.amount,t.currency,
        ${EFFECTIVE_PROJECT_SQL} effective_project_code,
        (SELECT name FROM projects WHERE code=${EFFECTIVE_PROJECT_SQL}) effective_project_name
        FROM transactions t LEFT JOIN pleo_raw_entries r ON r.accounting_entry_id=t.pleo_accounting_entry_id`).all();
      const categories=new Map(db.prepare('SELECT pleo_account_id,category_name FROM account_category_mappings').all().map(r=>[r.pleo_account_id,r.category_name]));
      const liveCategories=db.prepare('SELECT id,name FROM pleo_categories').all();
      for(const r of liveCategories)if(r.name)categories.set(r.id,r.name);
      return json(res,200,{...summarizeExpenses(expandApiExpenseSplits(rows,categories)),commercialProjects:summarizeCommercialExpenses(rows),source:'PLEO_API',version:dataVersion()});
    }
    if(req.method==='GET'&&url.pathname==='/api/analytics/expense'){
      const u=requireAuth(req,res,['ADMIN','TEAM_LEAD','FINANCE_QC']);if(!u)return;
      const {where,args,from,to}=expenseFilters(url);
      const byCurrency=(extra='')=>db.prepare(`SELECT COALESCE(t.currency,'UNKNOWN') currency, COUNT(*) count, COALESCE(SUM(t.amount),0) amount FROM transactions t ${where}${extra} GROUP BY COALESCE(t.currency,'UNKNOWN')`).all(...args);
      const totalSpend=byCurrency();
      const approvedSpend=byCurrency(" AND t.status='APPROVED'");
      const rejectedSpend=byCurrency(" AND t.status='REJECTED'");
      const pendingSpend=byCurrency(" AND t.status IN ('UNASSIGNED','ASSIGNED','IN_REVIEW','NEEDS_INFO')");
      const customerBillableSpend=byCurrency(" AND t.commercial_classification='CUSTOMER_BILLABLE'");
      const jsanInternalSpend=byCurrency(" AND t.commercial_classification='JSAN_INTERNAL'");
      const projectCostSpend=byCurrency(" AND t.commercial_classification='PROJECT_COST'");
      const sharedCostSpend=byCurrency(" AND t.commercial_classification='SHARED_COST'");
      const unclassifiedSpend=byCurrency(" AND t.commercial_classification IS NULL");
      const missingEvidenceValue=byCurrency(" AND t.receipt_count=0");
      // Four explicit resolution-state chips, replacing the old generic
      // "Uncategorized" bucket — each is independently drillable and a
      // transaction can appear in more than one at once (see the dq_* flags).
      const projectMissing=byCurrency(" AND t.dq_missing_project=1");
      const classificationMissing=byCurrency(" AND t.dq_missing_classification=1");
      const categoryUnresolved=byCurrency(" AND t.dq_unresolved_category=1");
      const receiptMissing=byCurrency(" AND t.dq_missing_receipt=1");

      const spendByCategory=db.prepare(`SELECT COALESCE(t.resolved_category_name,t.category,'Category Unresolved') category, COALESCE(t.currency,'UNKNOWN') currency, COUNT(*) count, COALESCE(SUM(t.amount),0) amount FROM transactions t ${where} GROUP BY 1,currency ORDER BY amount DESC`).all(...args);
      const spendByProject=db.prepare(`SELECT COALESCE(${EFFECTIVE_PROJECT_SQL},'Missing Project') project_code, COALESCE(t.currency,'UNKNOWN') currency, COUNT(*) count, COALESCE(SUM(t.amount),0) amount FROM transactions t ${where} GROUP BY 1,currency ORDER BY amount DESC`).all(...args);
      const spendByMerchant=db.prepare(`SELECT COALESCE(t.merchant,'Unknown') merchant, COALESCE(t.currency,'UNKNOWN') currency, COUNT(*) count, COALESCE(SUM(t.amount),0) amount FROM transactions t ${where} GROUP BY merchant,currency ORDER BY amount DESC LIMIT 20`).all(...args);
      const spendByCommercialType=db.prepare(`SELECT COALESCE(t.commercial_classification,'UNCLASSIFIED') commercial_classification, COALESCE(t.currency,'UNKNOWN') currency, COUNT(*) count, COALESCE(SUM(t.amount),0) amount FROM transactions t ${where} GROUP BY commercial_classification,currency ORDER BY amount DESC`).all(...args);
      const spendTrend=db.prepare(`SELECT date(t.transaction_date) AS day, COALESCE(t.currency,'UNKNOWN') currency, COALESCE(SUM(t.amount),0) amount, COUNT(*) count FROM transactions t ${where} GROUP BY day,currency ORDER BY day`).all(...args);

      // Median is computed in application code, not SQL — SQLite has no MEDIAN
      // aggregate. Fine at current data volumes; loading all matching amounts
      // into memory would not scale to hundreds of thousands of transactions.
      const amountRows=db.prepare(`SELECT COALESCE(t.currency,'UNKNOWN') currency, t.amount amount FROM transactions t ${where}`).all(...args);
      const byCur={}; for(const r of amountRows){(byCur[r.currency]=byCur[r.currency]||[]).push(r.amount);}
      const median=arr=>{const s=[...arr].sort((a,b)=>a-b);const n=s.length;if(!n)return 0;const mid=Math.floor(n/2);return n%2?s[mid]:(s[mid-1]+s[mid])/2;};
      const medianTransaction=Object.entries(byCur).map(([currency,arr])=>({currency,amount:median(arr),count:arr.length}));
      const avgTransaction=totalSpend.map(t=>({currency:t.currency,amount:t.count?Math.round((t.amount/t.count)*100)/100:0,count:t.count}));

      return json(res,200,{
        filters:{from,to},
        kpis:{totalSpend,transactionCount:totalSpend.reduce((s,r)=>s+r.count,0),avgTransaction,medianTransaction,approvedSpend,rejectedSpend,pendingSpend,customerBillableSpend,jsanInternalSpend,projectCostSpend,sharedCostSpend,unclassifiedSpend,missingEvidenceValue,projectMissing,classificationMissing,categoryUnresolved,receiptMissing},
        breakdowns:{spendByCategory,spendByProject,spendByMerchant,spendByCommercialType,spendTrend}
      });
    }
    // === REVIEW OPERATIONS ===
    // "Active validation time" (recorded work_sessions/heartbeat data) and
    // "Elapsed TAT" (assigned_at -> completed_at wall-clock gap) are always
    // kept as separate fields — never combined into one number.
    if(req.method==='GET'&&url.pathname==='/api/analytics/reviewers'){
      const u=requireAuth(req,res,['ADMIN','TEAM_LEAD','FINANCE_QC']);if(!u)return;
      const {from,to}=parseMonthOrRange(url);
      const rows=db.prepare(`SELECT usr.id,usr.name,usr.email,
        (SELECT COUNT(*) FROM transactions t WHERE t.reviewer_id=usr.id AND (?1 IS NULL OR date(t.allocated_at)>=date(?1)) AND (?2 IS NULL OR date(t.allocated_at)<=date(?2))) assigned,
        (SELECT COUNT(*) FROM transactions t WHERE t.reviewer_id=usr.id AND t.status IN ('APPROVED','REJECTED') AND (?1 IS NULL OR date(t.completed_at)>=date(?1)) AND (?2 IS NULL OR date(t.completed_at)<=date(?2))) completed,
        (SELECT COUNT(*) FROM transactions t WHERE t.reviewer_id=usr.id AND t.status IN ('ASSIGNED','IN_REVIEW','NEEDS_INFO')) pending,
        (SELECT COUNT(*) FROM transactions t WHERE t.reviewer_id=usr.id AND t.status='APPROVED' AND (?1 IS NULL OR date(t.completed_at)>=date(?1)) AND (?2 IS NULL OR date(t.completed_at)<=date(?2))) approved,
        (SELECT COUNT(*) FROM transactions t WHERE t.reviewer_id=usr.id AND t.status='REJECTED' AND (?1 IS NULL OR date(t.completed_at)>=date(?1)) AND (?2 IS NULL OR date(t.completed_at)<=date(?2))) rejected,
        (SELECT COUNT(*) FROM reviews r WHERE r.user_id=usr.id AND r.decision='NEEDS_INFO' AND (?1 IS NULL OR date(r.created_at)>=date(?1)) AND (?2 IS NULL OR date(r.created_at)<=date(?2))) needs_info,
        (SELECT COALESCE(SUM(t.amount),0) FROM transactions t WHERE t.reviewer_id=usr.id AND t.status IN ('APPROVED','REJECTED') AND (?1 IS NULL OR date(t.completed_at)>=date(?1)) AND (?2 IS NULL OR date(t.completed_at)<=date(?2))) amount_reviewed_total,
        (SELECT COALESCE(SUM(CASE WHEN w.ended_at IS NULL THEN MAX(0,CAST((julianday(w.last_heartbeat_at)-julianday(w.started_at))*86400 AS INTEGER)) ELSE COALESCE(w.seconds,0) END),0) FROM work_sessions w WHERE w.user_id=usr.id AND (?1 IS NULL OR date(w.started_at)>=date(?1)) AND (?2 IS NULL OR date(w.started_at)<=date(?2))) active_seconds,
        (SELECT COALESCE(AVG((julianday(t.completed_at)-julianday(t.allocated_at))*86400),0) FROM transactions t WHERE t.reviewer_id=usr.id AND t.completed_at IS NOT NULL AND t.allocated_at IS NOT NULL AND (?1 IS NULL OR date(t.completed_at)>=date(?1)) AND (?2 IS NULL OR date(t.completed_at)<=date(?2))) elapsed_tat_avg_seconds,
        (SELECT MIN(t.allocated_at) FROM transactions t WHERE t.reviewer_id=usr.id AND t.status IN ('ASSIGNED','IN_REVIEW','NEEDS_INFO')) oldest_pending_allocated_at
        FROM users usr WHERE usr.active=1 AND usr.role='REVIEWER' ORDER BY usr.name`).all(from,to);
      const nowMs=Date.now();
      const withComputed=rows.map(r=>({
        ...r,
        avg_active_seconds: r.completed? Math.round(r.active_seconds/r.completed):0,
        elapsed_tat_avg_seconds: Math.round(r.elapsed_tat_avg_seconds||0),
        oldest_pending_age_days: r.oldest_pending_allocated_at? Math.floor((nowMs-Date.parse(r.oldest_pending_allocated_at))/86400000):null,
        backlog_over_1d: db.prepare(`SELECT COUNT(*) c FROM transactions WHERE reviewer_id=? AND status IN ('ASSIGNED','IN_REVIEW','NEEDS_INFO') AND allocated_at<=?`).get(r.id, iso(new Date(nowMs-86400000))).c,
        backlog_over_3d: db.prepare(`SELECT COUNT(*) c FROM transactions WHERE reviewer_id=? AND status IN ('ASSIGNED','IN_REVIEW','NEEDS_INFO') AND allocated_at<=?`).get(r.id, iso(new Date(nowMs-3*86400000))).c,
        backlog_over_7d: db.prepare(`SELECT COUNT(*) c FROM transactions WHERE reviewer_id=? AND status IN ('ASSIGNED','IN_REVIEW','NEEDS_INFO') AND allocated_at<=?`).get(r.id, iso(new Date(nowMs-7*86400000))).c,
      }));
      return json(res,200,{filters:{from,to},rows:withComputed});
    }
    const reviewerDetailMatch=url.pathname.match(/^\/api\/analytics\/reviewers\/(\d+)$/);
    if(req.method==='GET'&&reviewerDetailMatch){
      const u=requireAuth(req,res,['ADMIN','TEAM_LEAD','FINANCE_QC']);if(!u)return;
      const reviewerId=Number(reviewerDetailMatch[1]);
      const reviewer=db.prepare("SELECT id,name,email FROM users WHERE id=? AND role='REVIEWER'").get(reviewerId);
      if(!reviewer) return json(res,404,{error:'Reviewer not found'});
      const {from,to}=parseMonthOrRange(url);
      const dailyThroughput=db.prepare(`SELECT date(t.completed_at) AS day, COUNT(*) completed, SUM(t.status='APPROVED') approved, SUM(t.status='REJECTED') rejected FROM transactions t WHERE t.reviewer_id=?1 AND t.completed_at IS NOT NULL AND (?2 IS NULL OR date(t.completed_at)>=date(?2)) AND (?3 IS NULL OR date(t.completed_at)<=date(?3)) GROUP BY day ORDER BY day`).all(reviewerId,from,to);
      const decisionMix=db.prepare(`SELECT r.decision, COUNT(*) count FROM reviews r WHERE r.user_id=?1 AND (?2 IS NULL OR date(r.created_at)>=date(?2)) AND (?3 IS NULL OR date(r.created_at)<=date(?3)) GROUP BY r.decision`).all(reviewerId,from,to);
      const categoriesReviewed=db.prepare(`SELECT COALESCE(t.resolved_category_name,t.category,'Uncategorised') category, COUNT(*) count, COALESCE(t.currency,'UNKNOWN') currency, COALESCE(SUM(t.amount),0) amount FROM transactions t WHERE t.reviewer_id=?1 AND t.status IN ('APPROVED','REJECTED') AND (?2 IS NULL OR date(t.completed_at)>=date(?2)) AND (?3 IS NULL OR date(t.completed_at)<=date(?3)) GROUP BY 1,currency ORDER BY amount DESC`).all(reviewerId,from,to);
      const projectsReviewed=db.prepare(`SELECT COALESCE(t.project_code,'Unclassified') project_code, COUNT(*) count, COALESCE(t.currency,'UNKNOWN') currency, COALESCE(SUM(t.amount),0) amount FROM transactions t WHERE t.reviewer_id=?1 AND t.status IN ('APPROVED','REJECTED') AND (?2 IS NULL OR date(t.completed_at)>=date(?2)) AND (?3 IS NULL OR date(t.completed_at)<=date(?3)) GROUP BY project_code,currency ORDER BY amount DESC`).all(reviewerId,from,to);
      const sessions=db.prepare(`SELECT w.id,w.transaction_id,w.started_at,w.ended_at,w.seconds,w.end_reason,t.merchant FROM work_sessions w JOIN transactions t ON t.id=w.transaction_id WHERE w.user_id=?1 AND (?2 IS NULL OR date(w.started_at)>=date(?2)) AND (?3 IS NULL OR date(w.started_at)<=date(?3)) ORDER BY w.started_at DESC LIMIT 200`).all(reviewerId,from,to);
      const currentQueue=db.prepare(`SELECT id,merchant,amount,currency,status,allocated_at,transaction_date FROM transactions WHERE reviewer_id=? AND status IN ('ASSIGNED','IN_REVIEW','NEEDS_INFO') ORDER BY allocated_at ASC`).all(reviewerId);
      const completedQueue=db.prepare(`SELECT id,merchant,amount,currency,status,decision,completed_at,transaction_date FROM transactions WHERE reviewer_id=?1 AND status IN ('APPROVED','REJECTED') AND (?2 IS NULL OR date(completed_at)>=date(?2)) AND (?3 IS NULL OR date(completed_at)<=date(?3)) ORDER BY completed_at DESC LIMIT 200`).all(reviewerId,from,to);
      const elapsedTat=db.prepare(`SELECT id,merchant,allocated_at,completed_at,CAST((julianday(completed_at)-julianday(allocated_at))*86400 AS INTEGER) elapsed_seconds FROM transactions WHERE reviewer_id=?1 AND completed_at IS NOT NULL AND allocated_at IS NOT NULL AND (?2 IS NULL OR date(completed_at)>=date(?2)) AND (?3 IS NULL OR date(completed_at)<=date(?3)) ORDER BY completed_at DESC LIMIT 200`).all(reviewerId,from,to);
      return json(res,200,{reviewer,filters:{from,to},dailyThroughput,decisionMix,categoriesReviewed,projectsReviewed,sessions,currentQueue,completedQueue,elapsedTat});
    }
    if(req.method==='GET'&&url.pathname==='/api/transactions/export'){
      const from=url.searchParams.get('dateFrom'),to=url.searchParams.get('dateTo');
      const valid=v=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v)&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString().slice(0,10)===v;
      if(!valid(from)||!valid(to)||from>to)return json(res,400,{error:'Select valid From and To dates in order.'});
      const params=new URLSearchParams({dateFrom:from,dateTo:to});
      const {whereSql,args}=transactionWhere(user,params);
      const rows=db.prepare(`SELECT t.*,u.name reviewer_name,${EFFECTIVE_PROJECT_SQL} effective_project_code FROM transactions t LEFT JOIN users u ON u.id=t.reviewer_id ${whereSql} ORDER BY t.transaction_date,t.id`).all(...args);
      const projects=new Map(db.prepare('SELECT code,name FROM projects').all().map(p=>[p.code,p.name]));
      for(const row of rows)row.effective_project_name=projects.get(row.effective_project_code)||row.team_name||'';
      const priority=[['Date','transaction_date'],['Expense type','expense_type'],['Pleo status','pleo_status'],['Billed amount','bill_amount'],['Billing currency','bill_currency'],['Original amount','amount'],['Original currency','currency'],['Source description','merchant'],['Category','resolved_category_name'],['Commercial classification','commercial_classification'],['Salary deduction (original currency)','salary_deduction_amount'],['Owner','employee_name'],['Note','note'],['Project','effective_project_name'],['Project code','effective_project_code'],['Receipts','receipt_count'],['Employee code','employee_code'],['Pleo review status','pleo_review_status'],['Pleo reviewer','pleo_reviewer_names'],['Pleo review note','pleo_review_note'],['Merchant country','merchant_country'],['Expense ID','pleo_accounting_entry_id'],['Export status','pleo_export_status'],['Billing status','pleo_billing_status_tag_name'],['JSAN status','status'],['JSAN reviewer','reviewer_name'],['JSAN reviewer notes','reviewer_notes'],['Xpense ID','xpense_id']];
      const keys=new Set(priority.map(x=>x[1]));
      const columns=[...priority,...db.prepare('PRAGMA table_info(transactions)').all().filter(x=>!keys.has(x.name)).map(x=>[x.name.replaceAll('_',' '),x.name])];
      const file=exportWorkbook(rows,columns);
      res.writeHead(200,{'Content-Type':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','Content-Disposition':`attachment; filename="PleoExported_Data_${from}_to_${to}.xlsx"`,'Content-Length':file.length,'Cache-Control':'no-store'});return res.end(file);
    }
    if(req.method==='GET'&&url.pathname==='/api/transactions') return json(res,200,transactionList(user,url));
    const txMatch=url.pathname.match(/^\/api\/transactions\/(\d+)$/);
    if(req.method==='GET'&&txMatch){const tx=rowTx(Number(txMatch[1]));if(!tx)return json(res,404,{error:'Transaction not found'});if(!transactionAccess(user,tx))return json(res,403,{error:'Not assigned to you'});const sessions=db.prepare('SELECT * FROM work_sessions WHERE transaction_id=? ORDER BY id DESC').all(tx.id);const reviews=db.prepare('SELECT r.*,u.name reviewer_name FROM reviews r JOIN users u ON u.id=r.user_id WHERE r.transaction_id=? ORDER BY r.id DESC').all(tx.id);const auditRows=db.prepare('SELECT a.*,u.name actor_name FROM audit_log a LEFT JOIN users u ON u.id=a.actor_id WHERE a.transaction_id=? ORDER BY a.id DESC LIMIT 100').all(tx.id).map(a=>({...a,detail:safeJson(a.detail,{})}));const attachments=db.prepare('SELECT id,file_key,receipt_id,mime_type,size_bytes,fetched_at,fetch_error,CASE WHEN cache_path IS NULL THEN 0 ELSE 1 END cached FROM pleo_attachments WHERE transaction_id=? ORDER BY id').all(tx.id);
      // One list for the UI: live Pleo receipts (viewed on demand, nothing
      // stored) when the entry carries receiptIds, otherwise any legacy
      // attachment rows (Export V2 files / mock fixture).
      const rids=receiptIdsFor(tx);
      const receipts=rids.length
        ?rids.map((rid,i)=>({label:`Receipt ${i+1}`,url:`/api/transactions/${tx.id}/receipts/${encodeURIComponent(rid)}`,cached:attachments.some(a=>a.receipt_id===rid&&a.cached)}))
        :attachments.map((a,i)=>({label:`Receipt ${i+1}`,url:`/api/transactions/${tx.id}/attachments/${a.id}`,cached:Boolean(a.cached),error:a.fetch_error||null}));
      return json(res,200,{tx,sessions,reviews,audit:auditRows,attachments,receipts,categoryOptions:availableCategoryNames()});}
    // On-demand receipt viewer: serves a cached copy if one exists, otherwise
    // asks Pleo for a fresh signed link and streams the file straight through
    // — nothing is written to disk and the Pleo key never reaches the browser.
    const rcptMatch=url.pathname.match(/^\/api\/transactions\/(\d+)\/receipts\/([0-9A-Za-z-]{1,80})$/);
    if(req.method==='GET'&&rcptMatch){
      const tx=rowTx(Number(rcptMatch[1]));if(!tx)return json(res,404,{error:'Not found'});if(!transactionAccess(user,tx))return json(res,403,{error:'Forbidden'});
      const rid=rcptMatch[2];if(!receiptIdsFor(tx).includes(rid))return json(res,404,{error:'Receipt not found on this transaction'});
      // Receipt files come from outside JSAN: only images/PDF render inline,
      // anything else is forced to download inside a sandbox (not applied to
      // PDFs — Chrome's PDF viewer refuses to render in a sandboxed document).
      const send=(type,len)=>{const inline=/^(image\/(png|jpe?g|gif|webp|heic|heif)|application\/pdf)$/i.test(type||'');res.writeHead(200,{'Content-Type':type||'application/octet-stream',...(len?{'Content-Length':len}:{}),'Cache-Control':'private, max-age=300','Content-Disposition':inline?'inline':'attachment','X-Content-Type-Options':'nosniff',...(inline?{}:{'Content-Security-Policy':'sandbox'})});};
      const cached=db.prepare('SELECT cache_path,mime_type FROM pleo_attachments WHERE accounting_entry_id=? AND receipt_id=? AND cache_path IS NOT NULL').get(tx.pleo_accounting_entry_id,rid);
      if(cached&&fs.existsSync(cached.cache_path)){send(cached.mime_type,fs.statSync(cached.cache_path).size);return fs.createReadStream(cached.cache_path).pipe(res);}
      if(!pleoConfigured()||cfg.pleoMockMode)return json(res,503,{error:'Pleo is not connected, so this receipt cannot be loaded'});
      try{
        const link=await fetchPleoReceiptLink(tx.pleo_accounting_entry_id,rid);
        if(!link.url)return json(res,502,{error:'Pleo returned no file for this receipt'});
        const r=await fetchTimeout(link.url,{},30000);if(!r.ok)return json(res,502,{error:`Pleo receipt download failed (HTTP ${r.status})`});
        send(r.headers.get('content-type')?.split(';')[0]||link.mime,r.headers.get('content-length'));
        for await(const chunk of r.body)res.write(chunk);return res.end();
      }catch(e){if(res.headersSent)return res.end();return json(res,502,{error:`Could not load receipt from Pleo: ${clampText(e.message,300)}`});}
    }
    // Dropdown values for the allocation filters, with counts, from live data.
    if(req.method==='GET'&&url.pathname==='/api/transactions/filter-options'){
      const u=requireAuth(req,res,['ADMIN','TEAM_LEAD','FINANCE_QC']);if(!u)return;
      const projects=db.prepare(`SELECT ${EFFECTIVE_PROJECT_SQL} value,COUNT(*) count,SUM(t.status='UNASSIGNED') unassigned FROM transactions t GROUP BY 1 HAVING ${EFFECTIVE_PROJECT_SQL} IS NOT NULL`).all();
      const names=new Map(db.prepare('SELECT code,name FROM projects').all().map(p=>[p.code,p.name]));
      for(const p of projects) p.name=names.get(p.value)||p.value;
      projects.sort((a,b)=>a.name.localeCompare(b.name));
      const pleoReview=db.prepare("SELECT t.pleo_review_status value,COUNT(*) count,SUM(t.status='UNASSIGNED') unassigned FROM transactions t WHERE t.pleo_review_status IS NOT NULL GROUP BY 1 ORDER BY 2 DESC").all();
      const missingProject=db.prepare("SELECT COUNT(*) count,SUM(status='UNASSIGNED') unassigned FROM transactions WHERE project_status='MISSING_PROJECT'").get();
      return json(res,200,{projects,pleoReview,missingProject});
    }
    if(req.method==='POST'&&url.pathname==='/api/assign'){
      const u=requireAuth(req,res,['ADMIN','TEAM_LEAD']);if(!u)return;const b=await readJson(req);const reviewer=db.prepare("SELECT * FROM users WHERE id=? AND active=1 AND role='REVIEWER'").get(Number(b.reviewer_id));if(!reviewer)return json(res,400,{error:'Valid reviewer is required'});
      // Filter-based bulk allocation ("Assign all N matching"): the same
      // transactionWhere() the list used, re-evaluated now. expected_count is
      // the total the manager saw — if a sync/another allocation changed the
      // set since, refuse rather than assign something they didn't see.
      if(b.filter&&typeof b.filter==='object'){
        const params=new URLSearchParams();for(const [k,v] of Object.entries(b.filter))if(v!=null&&v!=='')params.set(k,String(v));
        const {whereSql,args}=transactionWhere(u,params);
        const matched=db.prepare(`SELECT t.id,t.status FROM transactions t ${whereSql}`).all(...args);
        if(b.expected_count!=null&&Number(b.expected_count)!==matched.length)return json(res,409,{error:`The matching set changed (now ${matched.length} transactions) — refresh the list and try again`,matched:matched.length});
        const t=iso(),day=today();const upd=db.prepare("UPDATE transactions SET reviewer_id=?,allocated_by=?,allocated_at=?,allocation_day=?,status='ASSIGNED',updated_at=? WHERE id=?");
        let n=0,skippedFinal=0;db.exec('BEGIN');
        try{for(const r of matched){if(['APPROVED','REJECTED'].includes(r.status)){skippedFinal++;continue;}upd.run(reviewer.id,u.id,t,day,t,r.id);audit(r.id,u.id,'ALLOCATED',{reviewer_id:reviewer.id,reviewer_name:reviewer.name,bulk_filter:Object.fromEntries(params)});n++;}db.exec('COMMIT');}
        catch(e){db.exec('ROLLBACK');throw e;}
        return json(res,200,{ok:true,assigned:n,skippedFinal});
      }
      const ids=(Array.isArray(b.transaction_ids)?b.transaction_ids:[b.transaction_id]).map(Number).filter(Boolean);if(!ids.length)return json(res,400,{error:'No transactions selected'});let n=0;const t=iso(),day=today();for(const id of ids){const tx=rowTx(id);if(!tx)continue;if(['APPROVED','REJECTED'].includes(tx.status)&&!b.force)continue;db.prepare("UPDATE transactions SET reviewer_id=?,allocated_by=?,allocated_at=?,allocation_day=?,status=CASE WHEN status IN ('APPROVED','REJECTED') THEN status ELSE 'ASSIGNED' END,updated_at=? WHERE id=?").run(reviewer.id,u.id,t,day,t,id);audit(id,u.id,'ALLOCATED',{reviewer_id:reviewer.id,reviewer_name:reviewer.name});n++;}return json(res,200,{ok:true,assigned:n});
    }
    const startMatch=url.pathname.match(/^\/api\/transactions\/(\d+)\/start$/);
    if(req.method==='POST'&&startMatch){const id=Number(startMatch[1]);const tx=rowTx(id);if(!tx)return json(res,404,{error:'Not found'});if(tx.reviewer_id!==user.id&&!['ADMIN','TEAM_LEAD','FINANCE_QC'].includes(user.role))return json(res,403,{error:'This transaction is not assigned to you'});if(['APPROVED','REJECTED'].includes(tx.status))return json(res,409,{error:'Transaction is already completed'});closeUserOpenSessions(user.id,'SWITCHED');const t=iso();const r=db.prepare('INSERT INTO work_sessions(transaction_id,user_id,started_at,last_heartbeat_at,business_day) VALUES(?,?,?,?,?)').run(id,user.id,t,t,today());db.prepare("UPDATE transactions SET status='IN_REVIEW',updated_at=? WHERE id=?").run(t,id);audit(id,user.id,'VALIDATION_STARTED',{session_id:Number(r.lastInsertRowid)});return json(res,200,{ok:true,sessionId:Number(r.lastInsertRowid),startedAt:t,idleTimeoutSeconds:cfg.idleSeconds});}
    // Reopen an approved/rejected transaction so its check can be redone.
    // Same people who may review it may reopen it; a reason is required and
    // audited. The earlier review rows stay as history, and the saved
    // classification/project/notes/deduction are kept to pre-fill the edit.
    const reopenMatch=url.pathname.match(/^\/api\/transactions\/(\d+)\/reopen$/);
    if(req.method==='POST'&&reopenMatch){
      const id=Number(reopenMatch[1]);const tx=rowTx(id);if(!tx)return json(res,404,{error:'Not found'});
      if(tx.reviewer_id!==user.id&&!['ADMIN','TEAM_LEAD','FINANCE_QC'].includes(user.role))return json(res,403,{error:'This transaction is not assigned to you'});
      if(!['APPROVED','REJECTED'].includes(tx.status))return json(res,409,{error:'Only approved or rejected transactions can be reopened'});
      const b=await readJson(req);const reason=clampText(b.reason,1000).trim();if(!reason)return json(res,400,{error:'A reason is required to reopen a decision'});
      const t=iso(),status=tx.reviewer_id?'ASSIGNED':'UNASSIGNED';
      db.prepare('UPDATE transactions SET status=?,decision=NULL,completed_at=NULL,completion_day=NULL,updated_at=? WHERE id=?').run(status,t,id);
      audit(id,user.id,'DECISION_REOPENED',{reason,previous_status:tx.status,previous_decision:tx.decision,previous_classification:tx.commercial_classification,previous_completed_at:tx.completed_at});
      return json(res,200,{ok:true,status});
    }
    const hbMatch=url.pathname.match(/^\/api\/transactions\/(\d+)\/heartbeat$/);
    if(req.method==='POST'&&hbMatch){const id=Number(hbMatch[1]);const s=db.prepare('SELECT * FROM work_sessions WHERE transaction_id=? AND user_id=? AND ended_at IS NULL ORDER BY id DESC LIMIT 1').get(id,user.id);if(!s)return json(res,409,{error:'No active validation session'});db.prepare('UPDATE work_sessions SET last_heartbeat_at=? WHERE id=?').run(iso(),s.id);return json(res,200,{ok:true});}
    const pauseMatch=url.pathname.match(/^\/api\/transactions\/(\d+)\/pause$/);
    if(req.method==='POST'&&pauseMatch){const id=Number(pauseMatch[1]);const s=db.prepare('SELECT * FROM work_sessions WHERE transaction_id=? AND user_id=? AND ended_at IS NULL ORDER BY id DESC LIMIT 1').get(id,user.id);if(!s)return json(res,200,{ok:true,seconds:0});const secs=closeSession(s,'PAUSED',new Date());const tx=rowTx(id);if(tx?.status==='IN_REVIEW')db.prepare("UPDATE transactions SET status='ASSIGNED',updated_at=? WHERE id=?").run(iso(),id);audit(id,user.id,'VALIDATION_PAUSED',{seconds:secs});return json(res,200,{ok:true,seconds:secs});}
    const completeMatch=url.pathname.match(/^\/api\/transactions\/(\d+)\/review$/);
    if(req.method==='POST'&&completeMatch){const id=Number(completeMatch[1]);const tx=rowTx(id);if(!tx)return json(res,404,{error:'Not found'});if(tx.reviewer_id!==user.id&&!['ADMIN','TEAM_LEAD','FINANCE_QC'].includes(user.role))return json(res,403,{error:'This transaction is not assigned to you'});if(['APPROVED','REJECTED'].includes(tx.status))return json(res,409,{error:'This decision is final. Use "Edit & re-check" to reopen it first.'});const b=await readJson(req);const decision=String(b.decision||'').toUpperCase();if(!['APPROVED','REJECTED','NEEDS_INFO'].includes(decision))return json(res,400,{error:'Decision must be APPROVED, REJECTED or NEEDS_INFO'});const classification=b.commercial_classification?String(b.commercial_classification).toUpperCase():null;if(decision==='APPROVED'&&!classification)return json(res,400,{error:'Commercial classification is required for approval'});if(classification&&!COMMERCIAL_CLASSIFICATIONS.includes(classification))return json(res,400,{error:`Commercial classification must be one of: ${COMMERCIAL_CLASSIFICATIONS.join(', ')}`});if(decision==='APPROVED'&&classification==='CUSTOMER_BILLABLE'&&!b.project_code)return json(res,400,{error:'Project is required for customer-billable expenses'});
      // Salary deduction: how much of this expense the employee repays, in the
      // transaction currency. Required to approve; can't exceed the expense.
      let salaryDeduction=null;
      if(classification==='SALARY_DEDUCTION'){
        const raw=b.salary_deduction_amount;
        if(raw!=null&&raw!==''){salaryDeduction=Math.round(Number(raw)*100)/100;if(!Number.isFinite(salaryDeduction)||salaryDeduction<=0)return json(res,400,{error:'Salary deduction amount must be a number greater than 0'});if(salaryDeduction>Math.abs(Number(tx.amount)||0)+0.005)return json(res,400,{error:`Salary deduction cannot exceed the transaction amount (${Math.abs(Number(tx.amount)||0).toFixed(2)} ${tx.currency||''})`.trim()});}
        else if(decision==='APPROVED')return json(res,400,{error:'Enter the salary deduction amount'});
      }if(decision!=='APPROVED'&&!String(b.notes||'').trim())return json(res,400,{error:'Reviewer notes are required for Reject / Need Info'});const reviewProject=b.project_code?db.prepare('SELECT id,code FROM projects WHERE code=?').get(String(b.project_code)):null;if(b.project_code&&!reviewProject)return json(res,400,{error:'Unknown project code'});
      const s=db.prepare('SELECT * FROM work_sessions WHERE transaction_id=? AND user_id=? AND ended_at IS NULL ORDER BY id DESC LIMIT 1').get(id,user.id);
      if(!s||Date.now()-Date.parse(s.last_heartbeat_at)>cfg.idleSeconds*1000){if(s)closeSession(s,'IDLE_TIMEOUT',new Date());return json(res,409,{error:'Click Start validation before editing or submitting a decision.'});}
      closeSession(s,'REVIEW_ACTION',new Date());const total=sessionSecondsForTxUser(id,user.id),used=reviewedSecondsForTxUser(id,user.id),reviewSecs=Math.max(0,total-used),t=iso(),day=today();
      db.prepare('INSERT INTO reviews(transaction_id,user_id,decision,commercial_classification,project_code,notes,review_seconds,business_day,created_at,salary_deduction_amount) VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,user.id,decision,classification,b.project_code||null,clampText(b.notes,4000)||null,reviewSecs,day,t,salaryDeduction);
      const finalStatus=decision;const completed=['APPROVED','REJECTED'].includes(decision);const manualCategory=clampText(b.manual_category_name,200)?.trim()||null;const xpenseId=clampText(b.xpense_id,500)?.trim()||null;db.prepare(`UPDATE transactions SET status=?,decision=?,commercial_classification=?,project_code=?,reviewer_notes=?,manual_category_name=COALESCE(?,manual_category_name),resolved_category_name=COALESCE(?,resolved_category_name),category_resolution_source=CASE WHEN ? IS NOT NULL THEN 'MANUAL_REVIEW' ELSE category_resolution_source END,xpense_id=?,salary_deduction_amount=?,completed_at=?,completion_day=?,updated_at=? WHERE id=?`).run(finalStatus,decision,classification,b.project_code||null,clampText(b.notes,4000)||null,manualCategory,manualCategory,manualCategory,xpenseId,salaryDeduction,completed?t:null,completed?day:null,t,id);
      // A reviewer-chosen project is MANUAL attribution — the top precedence tier, so no later sync or mapping rule can override it. Applied directly rather than via mergeProjectAttribution(): a human re-review changing their own earlier choice is a correction, not a same-tier conflict. No project chosen → attribution is left as-is.
      if(reviewProject){db.prepare(`UPDATE transactions SET project_id=?,project_attribution_source='MANUAL',project_attributed_at=?,project_attributed_by=?,project_mapping_rule_id=NULL,project_status='ASSIGNED' WHERE id=?`).run(reviewProject.id,t,user.id,id);}
      recalculateTransactionQuality(id);
      audit(id,user.id,'REVIEW_DECISION',{decision,classification,project_code:b.project_code||null,review_seconds:reviewSecs,...(reviewProject?{project_attribution:{from_project_id:tx.project_id??null,from_source:tx.project_attribution_source||'UNMAPPED',to_project_id:reviewProject.id,to_source:'MANUAL'}}:{})});return json(res,200,{ok:true,decision,reviewSeconds:reviewSecs});
    }
    const attMatch=url.pathname.match(/^\/api\/transactions\/(\d+)\/attachments\/(\d+)$/);
    if(req.method==='GET'&&attMatch){const tx=rowTx(Number(attMatch[1]));if(!tx)return json(res,404,{error:'Not found'});if(!transactionAccess(user,tx))return json(res,403,{error:'Forbidden'});const a=db.prepare('SELECT * FROM pleo_attachments WHERE id=? AND transaction_id=?').get(Number(attMatch[2]),tx.id);if(!a)return json(res,404,{error:'Attachment not found'});if(cfg.pleoMockMode){const body=mockReceiptHtml(tx,a);res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Content-Length':Buffer.byteLength(body),'Cache-Control':'no-store','Content-Disposition':'inline'});return res.end(body);}if(a.cache_path&&fs.existsSync(a.cache_path)){res.writeHead(200,{'Content-Type':a.mime_type||'application/octet-stream','Content-Length':fs.statSync(a.cache_path).size,'Cache-Control':'private, max-age=300','Content-Disposition':'inline'});return fs.createReadStream(a.cache_path).pipe(res);}if(a.source_url){try{const r=await fetchTimeout(a.source_url,{},30000);if(!r.ok)return json(res,410,{error:'Pleo receipt link expired; run Sync Now to refresh'});res.writeHead(200,{'Content-Type':r.headers.get('content-type')||a.mime_type||'application/octet-stream','Cache-Control':'no-store','Content-Disposition':'inline'});for await(const chunk of r.body)res.write(chunk);return res.end();}catch{return json(res,502,{error:'Unable to retrieve receipt from Pleo'});}}return json(res,404,{error:a.fetch_error||'No receipt file available'});}
    if(req.method==='GET'&&url.pathname==='/api/pleo/status'){
      const u=requireAuth(req,res,['ADMIN','TEAM_LEAD','FINANCE_QC']);if(!u)return;const latest=db.prepare('SELECT * FROM pleo_sync_runs ORDER BY id DESC LIMIT 1').get()||null;const history=db.prepare('SELECT * FROM pleo_sync_runs ORDER BY id DESC LIMIT 20').all().map(r=>({...r,evidence:receiptQueueStats(r.id)}));const lastTestRaw=getKv('pleo_last_test');let lastTest=null;try{lastTest=lastTestRaw?JSON.parse(lastTestRaw):null;}catch{lastTest=null;}
      const lastCompanyTestRaw=getKv('pleo_last_company_test');let lastCompanyTest=null;try{lastCompanyTest=lastCompanyTestRaw?JSON.parse(lastCompanyTestRaw):null;}catch{lastCompanyTest=null;}
      return json(res,200,{configured:pleoConfigured(),mockMode:cfg.pleoMockMode,baseUrl:cfg.pleoBase,companyId:cfg.pleoCompanyId?`${cfg.pleoCompanyId.slice(0,8)}…${cfg.pleoCompanyId.slice(-4)}`:null,companyIdValid:cfg.pleoCompanyIdLooksValid,keyConfigured:Boolean(cfg.pleoKey)||cfg.pleoMockMode,syncMode:cfg.pleoSyncMode,autoSync:cfg.pleoAutoSync,syncOnStart:cfg.pleoSyncOnStart,intervalMinutes:cfg.pleoIntervalMinutes,syncInProgress,lastTest,lastCompanyTest,latest,history});
    }
    if(req.method==='POST'&&url.pathname==='/api/pleo/test'){
      const u=requireAuth(req,res,['ADMIN','TEAM_LEAD']);if(!u)return;
      const cfgStatus=pleoConfigStatus();
      if(!cfgStatus.ok){
        setKv('pleo_last_test',JSON.stringify({at:iso(),ok:false,reason:cfgStatus.reason,message:cfgStatus.message,statusCode:null}));
        return json(res,400,{error:cfgStatus.message,reason:cfgStatus.reason});
      }
      try{
        let sample;
        if(cfg.pleoSyncMode==='export_v2')sample=await pleoRequest('GET','/v2/export-jobs',{query:{company_id:cfg.pleoCompanyId,limit:1}});
        else sample=await pleoRequest('POST','/v1/accounting-entries:search',{query:{company_id:cfg.pleoCompanyId,limit:1},body:{includeDeleted:false,performedAtStart:new Date(Date.now()-86400_000).toISOString()}});
        setKv('pleo_last_test',JSON.stringify({at:iso(),ok:true,statusCode:200,records:Array.isArray(sample.data)?sample.data.length:0}));
        return json(res,200,{ok:true,message:'Connected',records:Array.isArray(sample.data)?sample.data.length:0});
      }catch(e){
        const c=classifyPleoError(e);
        setKv('pleo_last_test',JSON.stringify({at:iso(),ok:false,reason:c.reason,message:c.message,statusCode:e.statusCode||null}));
        return json(res,502,{error:c.message,reason:c.reason,statusCode:e.statusCode||null});
      }
    }
    // Dedicated company/authentication check — run this BEFORE any accounting
    // entries request, per the live-connection gate. GET /v1/companies/{id} is
    // the documented single-company lookup (distinct from the /v1/companies
    // list endpoint, which requires organization_id we don't have).
    if(req.method==='POST'&&url.pathname==='/api/pleo/company-test'){
      const u=requireAuth(req,res,['ADMIN','TEAM_LEAD']);if(!u)return;
      const cfgStatus=pleoConfigStatus();
      if(!cfgStatus.ok){
        setKv('pleo_last_company_test',JSON.stringify({at:iso(),ok:false,reason:cfgStatus.reason,message:cfgStatus.message}));
        return json(res,400,{error:cfgStatus.message,reason:cfgStatus.reason});
      }
      if(cfg.pleoMockMode){
        setKv('pleo_last_company_test',JSON.stringify({at:iso(),ok:true,mock:true,companyName:'Mock Company (fixture)'}));
        return json(res,200,{ok:true,mock:true,companyName:'Mock Company (fixture)',message:'Mock mode is on — this did not call the real Pleo API.'});
      }
      try{
        const p=await pleoRequest('GET',`/v1/companies/${encodeURIComponent(cfg.pleoCompanyId)}`);
        const companyName=p?.data?.name||null;
        setKv('pleo_last_company_test',JSON.stringify({at:iso(),ok:true,companyName}));
        return json(res,200,{ok:true,companyName,message:'Company association PASS'});
      }catch(e){
        const c=classifyPleoError(e);
        const reason=e.statusCode===404?'COMPANY_NOT_FOUND':c.reason;
        setKv('pleo_last_company_test',JSON.stringify({at:iso(),ok:false,reason,message:c.message,statusCode:e.statusCode||null}));
        return json(res,502,{error:c.message,reason,statusCode:e.statusCode||null});
      }
    }
    // Phase 1 of the Expense Intelligence data-model fix: sync Pleo's own Tag
    // Groups/Tags and Chart of Accounts as reference data, so category/tag
    // resolution stops depending on the (empty on real data) splitItems
    // field. This is synchronous and fast (reference data, not 20k+
    // transactions) so it does not need the async job/poll pattern.
    if(req.method==='POST'&&url.pathname==='/api/pleo/sync-reference-data'){
      const u=requireAuth(req,res,['ADMIN','TEAM_LEAD']);if(!u)return;
      const cfgStatus=pleoConfigStatus();
      if(!cfgStatus.ok && !cfg.pleoMockMode) return json(res,400,{error:cfgStatus.message,reason:cfgStatus.reason});
      // Each capability is fetched/reported independently — tag-groups:read
      // and any Chart-of-Accounts scope are not guaranteed to be granted
      // together, so one missing scope must not hide the other two results.
      const result={};
      let groupsForTags=[];
      try{
        const g=await syncPleoTagGroups();
        result.tagGroups={status:'OK',recordsFetched:g.recordsFetched,inserted:g.inserted,updated:g.updated};
        groupsForTags=g.groups;
      }catch(e){ const c=classifyPleoError(e); result.tagGroups={status:'FAILED',error:c.message,reason:c.reason,statusCode:e.statusCode||null,requestId:c.requestId||null}; }
      if(groupsForTags.length){
        try{
          const tg=await syncPleoTagsForGroups(groupsForTags);
          result.tags={status:'OK',recordsFetched:tg.recordsFetched,inserted:tg.inserted,updated:tg.updated};
        }catch(e){ const c=classifyPleoError(e); result.tags={status:'FAILED',error:c.message,reason:c.reason,statusCode:e.statusCode||null,requestId:c.requestId||null}; }
      } else {
        result.tags={status:'SKIPPED',reason:'No tag groups available to sync tags for'};
      }
      try{
        const cat=await syncPleoCategories();
        result.chartOfAccounts={status:'OK',recordsFetched:cat.recordsFetched,inserted:cat.inserted,updated:cat.updated};
      }catch(e){ const c=classifyPleoError(e); result.chartOfAccounts={status:'FAILED',error:c.message,reason:c.reason,statusCode:e.statusCode||null,requestId:c.requestId||null}; }
      let billingStatusSeed=null;
      try{ billingStatusSeed=seedBillingStatusMapping(); }catch{ billingStatusSeed=null; }
      let categoryBackfill=null;
      try{ categoryBackfill=await recomputeDerivedFieldsFromRaw(); }catch{ categoryBackfill=null; }
      // Freshly synced tag names can make name-based PLEO_TAG rules match rows they didn't before.
      let projectRuleBackfill=null;
      try{ projectRuleBackfill=applyProjectMappingRulesToAll(); }catch{ projectRuleBackfill=null; }
      return json(res,200,{ok:true,...result,billingStatusSeed,categoryBackfill,projectRuleBackfill});
    }
    // Diagnostic report — no guessing which Pleo Tag Group represents
    // "Project": this returns every tag group with its tag counts/samples and
    // real-vs-unresolved category/tag coverage on ingested transactions, so
    // the Project Tag Group can be picked from real evidence (Phase 2).
    if(req.method==='GET'&&url.pathname==='/api/pleo/reference-data-report'){
      const u=requireAuth(req,res,['ADMIN','TEAM_LEAD']);if(!u)return;
      const groups=db.prepare('SELECT * FROM pleo_tag_groups ORDER BY name').all().map(g=>{
        const tags=db.prepare('SELECT id,name,code,archived FROM pleo_tags WHERE group_id=? ORDER BY name LIMIT 10').all(g.id);
        const tagCount=db.prepare('SELECT COUNT(*) AS n FROM pleo_tags WHERE group_id=?').get(g.id).n;
        return {...g,tagCount,sampleTags:tags};
      });
      const categoryCount=db.prepare('SELECT COUNT(*) AS n FROM pleo_categories').get().n;
      const sampleCategories=db.prepare('SELECT id,name,code FROM pleo_categories ORDER BY name LIMIT 15').all();
      const liveTxTotal=db.prepare("SELECT COUNT(*) AS n FROM transactions WHERE source_kind='LIVE_API' OR source_kind='HISTORICAL_API'").get().n;
      const liveTxWithCategory=db.prepare("SELECT COUNT(*) AS n FROM transactions WHERE (source_kind='LIVE_API' OR source_kind='HISTORICAL_API') AND category IS NOT NULL AND category<>''").get().n;
      const liveTxWithTags=db.prepare("SELECT COUNT(*) AS n FROM transactions WHERE (source_kind='LIVE_API' OR source_kind='HISTORICAL_API') AND tags IS NOT NULL AND tags<>''").get().n;
      return json(res,200,{tagGroups:groups,categoryCount,sampleCategories,liveTransactions:{total:liveTxTotal,withResolvedCategory:liveTxWithCategory,withAnyTag:liveTxWithTags}});
    }
    // === Commercial Classification mapping (Pleo Billing Status -> Expensyra) ===
    if(req.method==='GET'&&url.pathname==='/api/admin/billing-status-mapping'){
      const u=requireAuth(req,res,['ADMIN','TEAM_LEAD']);if(!u)return;
      const groupId=resolveTagGroupIdByName('Billing Status');
      if(!groupId) return json(res,200,{groupFound:false,tags:[]});
      const tags=db.prepare(`SELECT pt.id,pt.name,pt.archived,bsm.spendops_classification FROM pleo_tags pt LEFT JOIN billing_status_mapping bsm ON bsm.pleo_tag_id=pt.id WHERE pt.group_id=? ORDER BY pt.name`).all(groupId);
      return json(res,200,{groupFound:true,groupId,tags});
    }
    if(req.method==='POST'&&url.pathname==='/api/admin/billing-status-mapping'){
      const u=requireAuth(req,res,['ADMIN','TEAM_LEAD']);if(!u)return;
      const b=await readJson(req); const tagId=String(b.pleo_tag_id||'').trim(); const classification=clampText(b.classification,80).trim().toUpperCase();
      if(!tagId||!classification) return json(res,400,{error:'pleo_tag_id and classification are required'});
      const tag=db.prepare('SELECT id,name FROM pleo_tags WHERE id=?').get(tagId); if(!tag) return json(res,404,{error:'Unknown Pleo tag id — sync reference data first'});
      const t=iso();
      db.prepare(`INSERT INTO billing_status_mapping(pleo_tag_id,pleo_tag_name,spendops_classification,created_at,updated_at) VALUES(?,?,?,?,?)
        ON CONFLICT(pleo_tag_id) DO UPDATE SET spendops_classification=excluded.spendops_classification,updated_at=excluded.updated_at`).run(tagId,tag.name,classification,t,t);
      audit(null,u.id,'BILLING_STATUS_MAPPING_SET',{pleo_tag_id:tagId,pleo_tag_name:tag.name,classification});
      const recompute=await recomputeDerivedFieldsFromRaw();
      return json(res,200,{ok:true,recompute});
    }
    // On-demand rebuild of the six dq_* flags from current canonical state —
    // see recalculateAllTransactionQuality(). Safe to call any time; it only
    // ever derives from what's already stored, never a sync source.
    if(req.method==='POST'&&url.pathname==='/api/admin/recalculate-quality-flags'){
      const u=requireAuth(req,res,['ADMIN','TEAM_LEAD']);if(!u)return;
      const result=recalculateAllTransactionQuality();
      audit(null,u.id,'QUALITY_FLAGS_RECALCULATED',result);
      return json(res,200,{ok:true,...result});
    }
    // === JSAN Project Master ===
    if(req.method==='GET'&&url.pathname==='/api/admin/projects'){
      const u=requireAuth(req,res,['ADMIN','TEAM_LEAD']);if(!u)return;
      return json(res,200,{rows:db.prepare('SELECT * FROM projects ORDER BY active DESC,name').all().map(p=>({...p,usage:projectUsage(p)}))});
    }
    const projectPatchMatch=url.pathname.match(/^\/api\/admin\/projects\/(\d+)$/);
    if(req.method==='PATCH'&&projectPatchMatch){
      const u=requireAuth(req,res,['ADMIN','TEAM_LEAD']);if(!u)return;
      const id=Number(projectPatchMatch[1]); const row=db.prepare('SELECT * FROM projects WHERE id=?').get(id); if(!row) return json(res,404,{error:'Project not found'});
      const b=await readJson(req);
      const fields={
        name:b.name!==undefined?clampText(b.name,180).trim()||row.name:row.name,
        customer:b.customer!==undefined?clampText(b.customer,120)||null:row.customer,
        project_manager:b.project_manager!==undefined?clampText(b.project_manager,120)||null:row.project_manager,
        country:b.country!==undefined?clampText(b.country,80)||null:row.country,
        status:b.status!==undefined?clampText(b.status,30).trim().toUpperCase()||row.status:row.status,
        start_date:b.start_date!==undefined?b.start_date||null:row.start_date,
        end_date:b.end_date!==undefined?b.end_date||null:row.end_date,
        pleo_project_tag_id:b.pleo_project_tag_id!==undefined?b.pleo_project_tag_id||null:row.pleo_project_tag_id,
        pleo_project_tag_name:b.pleo_project_tag_name!==undefined?b.pleo_project_tag_name||null:row.pleo_project_tag_name,
        commercial_model:b.commercial_model!==undefined?clampText(b.commercial_model,80)||null:row.commercial_model,
        active:b.status!==undefined?(String(b.status).toUpperCase()==='ACTIVE'?1:0):row.active,
      };
      db.prepare(`UPDATE projects SET name=?,customer=?,project_manager=?,country=?,status=?,start_date=?,end_date=?,pleo_project_tag_id=?,pleo_project_tag_name=?,commercial_model=?,active=?,updated_at=? WHERE id=?`)
        .run(fields.name,fields.customer,fields.project_manager,fields.country,fields.status,fields.start_date,fields.end_date,fields.pleo_project_tag_id,fields.pleo_project_tag_name,fields.commercial_model,fields.active,iso(),id);
      return json(res,200,{ok:true});
    }
    // Delete a project only when nothing uses it; otherwise the answer is to
    // close it (status CLOSED), which keeps every past decision readable.
    if(req.method==='DELETE'&&projectPatchMatch){
      const u=requireAuth(req,res,['ADMIN']);if(!u)return;
      const id=Number(projectPatchMatch[1]); const row=db.prepare('SELECT * FROM projects WHERE id=?').get(id); if(!row) return json(res,404,{error:'Project not found'});
      const use=projectUsage(row);
      if(use.transactions||use.links||use.reviews)return json(res,409,{error:`${row.code} is used by ${[use.transactions&&`${use.transactions} transaction(s)`,use.links&&`${use.links} project link(s)`,use.reviews&&`${use.reviews} review(s)`].filter(Boolean).join(', ')}. Set its status to Closed instead, or remove those first.`,usage:use});
      db.prepare('DELETE FROM projects WHERE id=?').run(id);
      audit(null,u.id,'PROJECT_DELETED',{project_id:id,code:row.code,name:row.name});
      return json(res,200,{ok:true});
    }
    // === Users: list (incl. inactive), edit, deactivate, delete ===
    if(req.method==='GET'&&url.pathname==='/api/admin/users'){
      const u=requireAuth(req,res,['ADMIN','TEAM_LEAD']);if(!u)return;
      const rows=db.prepare(`SELECT u.id,u.name,u.email,u.role,u.active,u.must_change_password,u.created_at,
        (SELECT COUNT(*) FROM transactions t WHERE t.reviewer_id=u.id AND t.status IN ('ASSIGNED','IN_REVIEW','NEEDS_INFO')) open_assigned,
        (SELECT COUNT(*) FROM reviews r WHERE r.user_id=u.id) reviews,
        (SELECT MAX(s.last_seen_at) FROM auth_sessions s WHERE s.user_id=u.id) last_seen_at
        FROM users u ORDER BY u.active DESC,u.role,u.name`).all();
      return json(res,200,{rows});
    }
    const userMatch=url.pathname.match(/^\/api\/admin\/users\/(\d+)$/);
    if(userMatch&&(req.method==='PATCH'||req.method==='DELETE')){
      const u=requireAuth(req,res,['ADMIN','TEAM_LEAD']);if(!u)return;
      const id=Number(userMatch[1]); const target=db.prepare('SELECT * FROM users WHERE id=?').get(id); if(!target) return json(res,404,{error:'User not found'});
      // Team leads manage reviewers only; nobody can lock themselves out.
      if(u.role==='TEAM_LEAD'&&target.role!=='REVIEWER')return json(res,403,{error:'Team leads can only manage reviewers'});
      const activeAdmins=()=>db.prepare("SELECT COUNT(*) c FROM users WHERE role='ADMIN' AND active=1").get().c;
      if(req.method==='DELETE'){
        if(id===u.id)return json(res,400,{error:'You cannot delete your own account'});
        if(target.role==='ADMIN'&&target.active&&activeAdmins()<=1)return json(res,400,{error:'This is the last active admin'});
        try{db.prepare('DELETE FROM users WHERE id=?').run(id);}
        catch(e){if(String(e.message).includes('FOREIGN KEY'))return json(res,409,{error:`${target.name} has review or audit history, so the account can only be deactivated. Deactivating keeps that history and blocks sign-in.`,code:'HAS_HISTORY'});throw e;}
        audit(null,u.id,'USER_DELETED',{user_id:id,email:target.email,role:target.role});
        return json(res,200,{ok:true});
      }
      const b=await readJson(req);
      const name=b.name!==undefined?clampText(b.name,120).trim():target.name;
      const email=b.email!==undefined?clampText(b.email,200).trim().toLowerCase():target.email;
      let role=b.role!==undefined?String(b.role).toUpperCase():target.role;
      const active=b.active!==undefined?(b.active?1:0):target.active;
      if(!name||!email.includes('@'))return json(res,400,{error:'Name and a valid email are required'});
      if(!['ADMIN','TEAM_LEAD','REVIEWER','FINANCE_QC'].includes(role))return json(res,400,{error:'Invalid role'});
      if(u.role==='TEAM_LEAD')role='REVIEWER';
      if(id===u.id&&(role!==target.role||!active))return json(res,400,{error:'You cannot change your own role or deactivate yourself'});
      if(target.role==='ADMIN'&&target.active&&(role!=='ADMIN'||!active)&&activeAdmins()<=1)return json(res,400,{error:'This is the last active admin'});
      let pw=null;
      if(b.temporary_password){pw=String(b.temporary_password);if(pw.length<12)return json(res,400,{error:'Temporary password must be at least 12 characters'});}
      const t=iso();let unassigned=0;
      db.exec('BEGIN IMMEDIATE');
      try{
        try{db.prepare('UPDATE users SET name=?,email=?,role=?,active=?,updated_at=? WHERE id=?').run(name,email,role,active,t,id);}
        catch(e){if(String(e).includes('UNIQUE'))throw Object.assign(new Error('Another user already has that email'),{status:409});throw e;}
        if(pw){const h=hashPassword(pw);db.prepare('UPDATE users SET password_hash=?,password_salt=?,must_change_password=1 WHERE id=?').run(h.hash,h.salt,id);}
        // Deactivating, a password reset or leaving the reviewer role ends
        // their sign-ins; open work goes back to the unassigned queue.
        if(pw||!active)db.prepare('DELETE FROM auth_sessions WHERE user_id=?').run(id);
        if(target.active&&!active||target.role==='REVIEWER'&&role!=='REVIEWER'){
          for(const s of db.prepare('SELECT * FROM work_sessions WHERE user_id=? AND ended_at IS NULL').all(id))closeSession(s,'USER_DEACTIVATED',new Date(s.last_heartbeat_at||s.started_at));
          const open=db.prepare("SELECT id FROM transactions WHERE reviewer_id=? AND status IN ('ASSIGNED','IN_REVIEW','NEEDS_INFO')").all(id);
          const clear=db.prepare("UPDATE transactions SET reviewer_id=NULL,allocated_by=NULL,allocated_at=NULL,allocation_day=NULL,status='UNASSIGNED',updated_at=? WHERE id=?");
          for(const r of open){clear.run(t,r.id);audit(r.id,u.id,'UNALLOCATED',{reason:!active?'Reviewer deactivated':'Reviewer role removed',previous_reviewer_id:id});}
          unassigned=open.length;
        }
        db.exec('COMMIT');
      }catch(e){db.exec('ROLLBACK');if(e.status)return json(res,e.status,{error:e.message});throw e;}
      audit(null,u.id,'USER_UPDATED',{user_id:id,changes:{...(name!==target.name&&{name}),...(email!==target.email&&{email}),...(role!==target.role&&{role:[target.role,role]}),...(active!==target.active&&{active:Boolean(active)}),...(pw&&{password_reset:true})},unassigned});
      return json(res,200,{ok:true,unassigned});
    }
    // === Historical / mapping-rule based project attribution framework ===
    // Rules are proposed then explicitly approved — never auto-applied. This
    // exists now so the (not-yet-built) Historical XLSX import has a target
    // to write proposals into; today it also lets an admin manually map a
    // known source value (e.g. a Pleo Team) to a JSAN Project ahead of that.
    if(req.method==='GET'&&url.pathname==='/api/admin/project-mapping-rules'){
      const u=requireAuth(req,res,['ADMIN','TEAM_LEAD']);if(!u)return;
      const rows=db.prepare(`SELECT r.*,p.code project_code,p.name project_name,tn.team_name source_label,(SELECT COUNT(*) FROM transactions t WHERE t.team_id=r.source_value) team_transactions FROM project_mapping_rules r JOIN projects p ON p.id=r.project_id LEFT JOIN pleo_team_names tn ON r.source_type='PLEO_TEAM' AND tn.team_id=r.source_value ORDER BY r.status DESC,p.code,r.source_value`).all();
      return json(res,200,{rows});
    }
    if(req.method==='POST'&&url.pathname==='/api/admin/project-mapping-rules'){
      const u=requireAuth(req,res,['ADMIN','TEAM_LEAD']);if(!u)return;
      const b=await readJson(req); const sourceType=clampText(b.source_type,40).trim().toUpperCase(); const sourceValue=clampText(b.source_value,200).trim(); const projectId=Number(b.project_id);
      if(!sourceType||!sourceValue||!projectId) return json(res,400,{error:'source_type, source_value and project_id are required'});
      const project=db.prepare('SELECT id FROM projects WHERE id=?').get(projectId); if(!project) return json(res,400,{error:'Unknown project_id'});
      const t=iso();
      try{
        const r=db.prepare('INSERT INTO project_mapping_rules(source_type,source_value,project_id,status,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(sourceType,sourceValue,projectId,'PROPOSED',u.id,t,t);
        return json(res,201,{ok:true,id:Number(r.lastInsertRowid)});
      }catch(e){ if(String(e).includes('UNIQUE')) return json(res,409,{error:'A mapping rule already exists for this source value'}); throw e; }
    }
    // Bulk approval — e.g. the ~30 team rules proposed by one Pleo Excel
    // import — with a single backfill pass instead of one per rule.
    if(req.method==='POST'&&url.pathname==='/api/admin/project-mapping-rules/approve-all'){
      const u=requireAuth(req,res,['ADMIN']);if(!u)return;
      const pending=db.prepare("SELECT * FROM project_mapping_rules WHERE status='PROPOSED'").all();
      const t=iso(); const approve=db.prepare("UPDATE project_mapping_rules SET status='APPROVED',approved_by=?,approved_at=?,updated_at=? WHERE id=?");
      for(const rule of pending){ approve.run(u.id,t,t,rule.id); audit(null,u.id,'PROJECT_MAPPING_RULE_APPROVED',{rule_id:rule.id,source_type:rule.source_type,source_value:rule.source_value,project_id:rule.project_id,bulk:true}); }
      const applied=pending.length?applyProjectMappingRulesToAll():null;
      return json(res,200,{ok:true,approved:pending.length,applied});
    }
    if(req.method==='POST'&&url.pathname==='/api/admin/pleo-excel-import'){
      const u=requireAuth(req,res,['ADMIN']);if(!u)return;
      const filename=clampText(req.headers['x-filename']||'pleo-export.xlsx',240);
      const buffer=await readBuffer(req);
      if(!buffer.length) return json(res,400,{error:'No file received'});
      const result=await importPleoExcel(buffer,{filename,user:u,dryRun:url.searchParams.get('dry_run')==='1'});
      return json(res,200,{ok:true,...result});
    }
    // Edit or delete a project link. Changing an approved link's team/tag or
    // project, or deleting it, re-derives the transactions it had assigned.
    const ruleMatch=url.pathname.match(/^\/api\/admin\/project-mapping-rules\/(\d+)$/);
    if(ruleMatch&&(req.method==='PATCH'||req.method==='DELETE')){
      const u=requireAuth(req,res,['ADMIN','TEAM_LEAD']);if(!u)return;
      const id=Number(ruleMatch[1]); const rule=db.prepare('SELECT * FROM project_mapping_rules WHERE id=?').get(id); if(!rule) return json(res,404,{error:'Project link not found'});
      if(rule.status==='APPROVED'&&u.role!=='ADMIN')return json(res,403,{error:'Only an admin can change an approved project link'});
      if(req.method==='DELETE'){
        const cleared=rule.status==='APPROVED'?clearRuleAttribution(id):0;
        db.prepare('DELETE FROM project_mapping_rules WHERE id=?').run(id);
        const applied=rule.status==='APPROVED'?applyProjectMappingRulesToAll():null;
        if(cleared)recalculateAllTransactionQuality();
        audit(null,u.id,'PROJECT_MAPPING_RULE_DELETED',{rule_id:id,source_type:rule.source_type,source_value:rule.source_value,project_id:rule.project_id,status:rule.status,cleared,applied});
        return json(res,200,{ok:true,cleared,applied});
      }
      const b=await readJson(req);
      const sourceType=b.source_type!==undefined?clampText(b.source_type,40).trim().toUpperCase():rule.source_type;
      const sourceValue=b.source_value!==undefined?clampText(b.source_value,200).trim():rule.source_value;
      const projectId=b.project_id!==undefined?Number(b.project_id):rule.project_id;
      if(!sourceType||!sourceValue||!projectId)return json(res,400,{error:'Source type, source value and project are required'});
      if(!db.prepare('SELECT id FROM projects WHERE id=?').get(projectId))return json(res,400,{error:'Unknown project'});
      const changed=sourceType!==rule.source_type||sourceValue!==rule.source_value||projectId!==rule.project_id;
      if(!changed)return json(res,200,{ok:true,cleared:0,applied:null});
      const cleared=rule.status==='APPROVED'?clearRuleAttribution(id):0;
      try{db.prepare('UPDATE project_mapping_rules SET source_type=?,source_value=?,project_id=?,updated_at=? WHERE id=?').run(sourceType,sourceValue,projectId,iso(),id);}
      catch(e){if(String(e).includes('UNIQUE')){if(cleared)applyProjectMappingRulesToAll();return json(res,409,{error:'Another project link already uses this source value'});}throw e;}
      const applied=rule.status==='APPROVED'?applyProjectMappingRulesToAll():null;
      if(cleared)recalculateAllTransactionQuality();
      audit(null,u.id,'PROJECT_MAPPING_RULE_UPDATED',{rule_id:id,from:{source_type:rule.source_type,source_value:rule.source_value,project_id:rule.project_id},to:{source_type:sourceType,source_value:sourceValue,project_id:projectId},cleared,applied});
      return json(res,200,{ok:true,cleared,applied});
    }
    const ruleApproveMatch=url.pathname.match(/^\/api\/admin\/project-mapping-rules\/(\d+)\/approve$/);
    if(req.method==='POST'&&ruleApproveMatch){
      const u=requireAuth(req,res,['ADMIN']);if(!u)return;
      const id=Number(ruleApproveMatch[1]); const rule=db.prepare('SELECT * FROM project_mapping_rules WHERE id=?').get(id); if(!rule) return json(res,404,{error:'Rule not found'});
      db.prepare("UPDATE project_mapping_rules SET status='APPROVED',approved_by=?,approved_at=?,updated_at=? WHERE id=?").run(u.id,iso(),iso(),id);
      // Backfill existing transactions now; new syncs pick the rule up via upsertTransaction().
      const applied=applyProjectMappingRulesToAll();
      audit(null,u.id,'PROJECT_MAPPING_RULE_APPROVED',{rule_id:id,source_type:rule.source_type,source_value:rule.source_value,project_id:rule.project_id,applied});
      return json(res,200,{ok:true,applied});
    }
    // === Hard-gate evidence numbers — Commercial Classification / Project /
    // Category / Data Quality, computed from real persisted state only ===
    if(req.method==='GET'&&url.pathname==='/api/analytics/data-quality-gate'){
      const u=requireAuth(req,res,['ADMIN','TEAM_LEAD']);if(!u)return;
      const liveWhere="(source_kind='LIVE_API' OR source_kind='HISTORICAL_API')";
      const count=(sql,...args)=>db.prepare(sql).get(...args).n;
      const billingGroupId=resolveTagGroupIdByName('Billing Status');
      const billingTagCount=billingGroupId?count('SELECT COUNT(*) n FROM pleo_tags WHERE group_id=?',billingGroupId):0;
      const billingMappedCount=billingGroupId?count('SELECT COUNT(*) n FROM pleo_tags pt JOIN billing_status_mapping bsm ON bsm.pleo_tag_id=pt.id WHERE pt.group_id=?',billingGroupId):0;
      return json(res,200,{
        commercialClassification:{
          billingStatusTags: billingTagCount,
          mapped: billingMappedCount,
          missing: billingTagCount-billingMappedCount,
        },
        project:{
          projectMasterCount: count('SELECT COUNT(*) n FROM projects WHERE active=1'),
          historicalMappingRules: count("SELECT COUNT(*) n FROM project_mapping_rules WHERE status='APPROVED'"),
          mappedRealTransactions: count(`SELECT COUNT(*) n FROM transactions WHERE ${liveWhere} AND project_status='ASSIGNED'`),
          manualAssignments: count(`SELECT COUNT(*) n FROM transactions WHERE ${liveWhere} AND project_attribution_source='MANUAL'`),
          ruleAssignments: count(`SELECT COUNT(*) n FROM transactions WHERE ${liveWhere} AND project_attribution_source='APPROVED_MAPPING_RULE'`),
          tagAssignments: count(`SELECT COUNT(*) n FROM transactions WHERE ${liveWhere} AND project_attribution_source='PLEO_PROJECT_TAG'`),
          missingProject: count(`SELECT COUNT(*) n FROM transactions WHERE ${liveWhere} AND project_status='MISSING_PROJECT'`),
          conflicts: count(`SELECT COUNT(*) n FROM transactions WHERE ${liveWhere} AND project_status='PROJECT_ATTRIBUTION_CONFLICT'`),
        },
        category:{
          resolved: count(`SELECT COUNT(*) n FROM transactions WHERE ${liveWhere} AND category_resolution_status='CATEGORY_RESOLVED'`),
          missingAccountId: count(`SELECT COUNT(*) n FROM transactions WHERE ${liveWhere} AND category_resolution_status='MISSING_ACCOUNT_ID'`),
          accountIdNotFound: count(`SELECT COUNT(*) n FROM transactions WHERE ${liveWhere} AND category_resolution_status='ACCOUNT_ID_NOT_IN_REFERENCE_DATA'`),
          pendingMapping: count(`SELECT COUNT(*) n FROM transactions WHERE ${liveWhere} AND category_resolution_status='CATEGORY_MAPPING_PENDING'`),
          pleoResolved: count(`SELECT COUNT(*) n FROM transactions WHERE ${liveWhere} AND category_resolution_source='PLEO_RESOLVED_ACCOUNT'`),
          historicalResolved: count(`SELECT COUNT(*) n FROM transactions WHERE ${liveWhere} AND category_resolution_source='VERIFIED_HISTORICAL_EXPORT_CATEGORY'`),
          manualResolved: count(`SELECT COUNT(*) n FROM transactions WHERE ${liveWhere} AND category_resolution_source='APPROVED_MANUAL_MAPPING'`),
        },
        evidence:{
          receiptAvailable: count(`SELECT COUNT(*) n FROM transactions WHERE ${liveWhere} AND receipt_count>0`),
          receiptMissing: count(`SELECT COUNT(*) n FROM transactions WHERE ${liveWhere} AND receipt_count=0`),
        },
        dataQuality:{
          missingProject: count(`SELECT COUNT(*) n FROM transactions WHERE ${liveWhere} AND dq_missing_project=1`),
          missingClassification: count(`SELECT COUNT(*) n FROM transactions WHERE ${liveWhere} AND dq_missing_classification=1`),
          unresolvedCategory: count(`SELECT COUNT(*) n FROM transactions WHERE ${liveWhere} AND dq_unresolved_category=1`),
          missingReceipt: count(`SELECT COUNT(*) n FROM transactions WHERE ${liveWhere} AND dq_missing_receipt=1`),
          sourceConflict: count(`SELECT COUNT(*) n FROM transactions WHERE ${liveWhere} AND project_status='PROJECT_ATTRIBUTION_CONFLICT'`),
          unmappedHistoricalProject: count(`SELECT COUNT(*) n FROM transactions WHERE ${liveWhere} AND dq_unmapped_historical_project=1`),
          unknownEmployee: count(`SELECT COUNT(*) n FROM transactions WHERE ${liveWhere} AND dq_unknown_employee=1`),
        },
      });
    }
    // The server owns the running job: this returns as soon as the run row
    // exists, not when the (potentially 90-minute) fetch completes. Closing
    // the browser does not cancel it. Poll /api/pleo/sync-runs/:runId or
    // /api/pleo/status for progress.
    if(url.pathname==='/api/pleo/daily-sync'&&(req.method==='GET'||req.method==='POST')){
      const u=requireAuth(req,res,req.method==='GET'?['ADMIN','TEAM_LEAD','FINANCE_QC']:['ADMIN','TEAM_LEAD']);if(!u)return;
      if(req.method==='POST'){
        const b=await readJson(req);
        if(b.time!=null){const tm=normalizeSyncTime(b.time);if(!tm)return json(res,400,{error:'time must be HH:MM (24-hour)'});setKv('daily_sync_time',tm);}
        if(b.enabled!=null){
          if(b.enabled&&!pleoConfigured())return json(res,400,{error:'Pleo credentials are not configured'});
          setKv('daily_sync_enabled',b.enabled?'1':'0');
        }
        const s=dailySyncSettings();
        console.log(`[pleo daily sync] ${s.enabled?`enabled at ${s.time} ${s.timezone}`:'disabled'} by user #${u.id}`);
        // Catch up immediately if switched on after today's slot already passed.
        try{dailySyncTick();}catch(e){console.error('[pleo daily sync]',e.message);}
      }
      const {settings,decision,lastSuccess,lastIncremental}=dailySyncState();
      const running=syncInProgress?db.prepare("SELECT id,trigger_type,started_at,items_seen,inserted_count,updated_count FROM pleo_sync_runs WHERE status='RUNNING' ORDER BY id DESC LIMIT 1").get()||null:null;
      const newSinceLastSync=lastSuccess?db.prepare('SELECT COUNT(*) c FROM transactions WHERE created_at>=?').get(lastSuccess.started_at).c:0;
      const pick=r=>r&&{id:r.id,trigger_type:r.trigger_type,status:r.status,started_at:r.started_at,finished_at:r.finished_at,items_seen:r.items_seen,inserted_count:r.inserted_count,updated_count:r.updated_count,error_message:r.error_message};
      return json(res,200,{...settings,configured:pleoConfigured(),syncMode:cfg.pleoSyncMode,syncInProgress,stopping:Boolean(running&&syncCancelRequested===running.id),running,checkpoint:getKv('pleo_accounting_entries_settled_last_success'),maxRangeDays:cfg.pleoMaxSyncRangeDays,next:decision.next,doneToday:decision.doneToday,lastSuccess:pick(lastSuccess),lastRun:pick(lastIncremental),newSinceLastSync});
    }
    if(req.method==='POST'&&url.pathname==='/api/pleo/sync'){
      const u=requireAuth(req,res,['ADMIN','TEAM_LEAD']);if(!u)return;
      // Optional {from,to}: fetch rows settled in that window (to defaults to
      // now). Omitted = since the last successful sync (24h on the first run).
      const b=await readJson(req);let from=null,to=null;
      const given=v=>v!=null&&v!=='';
      if(given(b.to)&&!given(b.from))return json(res,400,{error:'Choose a From date as well'});
      if(given(b.from)){
        const fromMs=Date.parse(String(b.from)),toMs=given(b.to)?Date.parse(String(b.to)):Date.now();
        if(!Number.isFinite(fromMs)||fromMs>Date.now())return json(res,400,{error:'From must be a valid date, not in the future'});
        if(!Number.isFinite(toMs))return json(res,400,{error:'To must be a valid date'});
        if(toMs<=fromMs)return json(res,400,{error:'To must be after From'});
        if(Math.min(toMs,Date.now())-fromMs>cfg.pleoMaxSyncRangeDays*86400_000+86400_000)return json(res,400,{error:`Sync now covers at most ${cfg.pleoMaxSyncRangeDays} days at a time. Use Pleo Sync → historical backfill for longer periods.`});
        from=new Date(fromMs).toISOString();
        if(given(b.to))to=new Date(Math.min(toMs,Date.now())).toISOString();
      }
      try{const runId=startSyncPleo('manual',u.id,{from,to});return json(res,200,{ok:true,runId,status:'RUNNING'});}catch(e){return json(res,e.status||e.statusCode||500,{error:e.message});}
    }
    if(req.method==='POST'&&['/api/transactions/import-removal/preview','/api/transactions/import-removal/confirm'].includes(url.pathname)){
      const u=requireAuth(req,res,['ADMIN']);if(!u)return;
      const b=await readJson(req);
      if(syncInProgress||receiptWorkerRunning)return json(res,409,{error:'Wait for sync and receipt processing to finish before removing data.'});
      try{
        if(url.pathname.endsWith('/preview')){
          const p=previewImportRemoval(db,b.dateFrom,b.dateTo);
          return json(res,200,{token:p.token,matched:p.matched,removable:p.removable,protected:p.protected,sample:p.rows.slice(0,10).map(t=>({id:t.id,date:t.transaction_date}))});
        }
        return json(res,200,removeImportedData(db,b.dateFrom,b.dateTo,b.token,u.id));
      }catch(e){return json(res,e.status||500,{error:e.message});}
    }
    if(req.method==='POST'&&url.pathname==='/api/pleo/sync/stop'){
      const u=requireAuth(req,res,['ADMIN','TEAM_LEAD']);if(!u)return;
      const run=syncInProgress?db.prepare("SELECT id FROM pleo_sync_runs WHERE status='RUNNING' ORDER BY id DESC LIMIT 1").get():null;
      if(!run)return json(res,409,{error:'No Pleo sync is running'});
      syncCancelRequested=run.id;console.log(`[pleo sync] stop requested for run #${run.id} by user #${u.id}`);
      return json(res,200,{ok:true,runId:run.id,status:'STOPPING'});
    }
    if(req.method==='POST'&&url.pathname==='/api/pleo/backfill'){
      const u=requireAuth(req,res,['ADMIN','TEAM_LEAD']);if(!u)return;
      const b=await readJson(req); const dateFrom=String(b.dateFrom||'').trim(); const dateTo=b.dateTo?String(b.dateTo).trim():null;
      if(!dateFrom||isNaN(Date.parse(dateFrom))) return json(res,400,{error:'dateFrom is required and must be a valid date (YYYY-MM-DD)'});
      if(dateTo&&isNaN(Date.parse(dateTo))) return json(res,400,{error:'dateTo must be a valid date (YYYY-MM-DD)'});
      if(cfg.pleoMockMode&&!getMockFixture().accountingEntries?.length) return json(res,400,{error:'Mock fixture has no accountingEntries to backfill from'});
      try{const runId=startSyncPleoHistorical(dateFrom,dateTo,'historical_backfill',u.id);return json(res,200,{ok:true,runId,status:'RUNNING'});}catch(e){return json(res,e.status||e.statusCode||500,{error:e.message});}
    }
    const syncRunMatch=url.pathname.match(/^\/api\/pleo\/sync-runs\/(\d+)$/);
    if(req.method==='GET'&&syncRunMatch){
      const u=requireAuth(req,res,['ADMIN','TEAM_LEAD','FINANCE_QC']);if(!u)return;
      const run=db.prepare('SELECT * FROM pleo_sync_runs WHERE id=?').get(Number(syncRunMatch[1]));
      if(!run) return json(res,404,{error:'Sync run not found'});
      const durationMs=run.finished_at?Date.parse(run.finished_at)-Date.parse(run.started_at):Date.now()-Date.parse(run.started_at);
      return json(res,200,{run,evidence:receiptQueueStats(run.id),durationMs});
    }
    if(req.method==='GET'&&url.pathname==='/api/analytics/expense/monthly'){
      const u=requireAuth(req,res,['ADMIN','TEAM_LEAD','FINANCE_QC']);if(!u)return;
      const project=url.searchParams.get('project')||null;
      const currency=url.searchParams.get('currency')||null;
      const commercial=url.searchParams.get('commercial_classification')||null;
      const rows=db.prepare(`SELECT strftime('%Y-%m',t.transaction_date) AS month, COALESCE(t.resolved_category_name,t.category,'Uncategorised') category, COALESCE(t.currency,'UNKNOWN') currency, COUNT(*) count, COALESCE(SUM(t.amount),0) amount
        FROM transactions t
        WHERE t.transaction_date IS NOT NULL
        AND (?1 IS NULL OR ${EFFECTIVE_PROJECT_SQL}=?1)
        AND (?2 IS NULL OR t.currency=?2)
        AND (?3 IS NULL OR t.commercial_classification=?3)
        GROUP BY 1,2,currency ORDER BY 1,2`).all(project,currency,commercial);
      return json(res,200,{rows});
    }
    if(req.method==='POST'&&url.pathname==='/api/users'){
      const u=requireAuth(req,res,['ADMIN','TEAM_LEAD']);if(!u)return;const b=await readJson(req);const role=u.role==='TEAM_LEAD'?'REVIEWER':String(b.role||'REVIEWER').toUpperCase();if(!['ADMIN','TEAM_LEAD','REVIEWER','FINANCE_QC'].includes(role))return json(res,400,{error:'Invalid role'});const name=clampText(b.name,120).trim(),email=clampText(b.email,200).trim().toLowerCase(),pw=String(b.temporary_password||'');if(!name||!email.includes('@')||pw.length<12)return json(res,400,{error:'Name, valid email and temporary password of at least 12 characters are required'});try{const id=createUser(name,email,role,pw,1);return json(res,201,{ok:true,id});}catch(e){if(String(e).includes('UNIQUE'))return json(res,409,{error:'Email already exists'});throw e;}
    }
    if(req.method==='POST'&&url.pathname==='/api/projects'){
      const u=requireAuth(req,res,['ADMIN','TEAM_LEAD']);if(!u)return;const b=await readJson(req);const code=clampText(b.code,50).trim().toUpperCase(),name=clampText(b.name,180).trim();if(!code||!name)return json(res,400,{error:'Code and name are required'});const t=iso();try{db.prepare('INSERT INTO projects(code,name,customer,created_at,updated_at) VALUES(?,?,?,?,?)').run(code,name,clampText(b.customer,120)||null,t,t);return json(res,201,{ok:true});}catch(e){if(String(e).includes('UNIQUE'))return json(res,409,{error:'Project code already exists'});throw e;}
    }
    if(req.method==='POST'&&url.pathname==='/api/recovery/import'){
      const u=requireAuth(req,res,['ADMIN','TEAM_LEAD']);if(!u)return;if(!cfg.allowRecoveryImport)return json(res,403,{error:'Recovery import is disabled'});const filename=clampText(req.headers['x-filename']||'pleo-recovery.csv',240);const raw=await readBody(req,20_000_000);const rows=parseCsv(raw);let ins=0,upd=0;for(let i=0;i<rows.length;i++){const m=mapRecovery(rows[i],i+1);upsertRaw(m.pleo_accounting_entry_id,cfg.pleoCompanyId,'recovery_csv',null,rows[i]);const r=upsertTransaction(m);r.inserted?ins++:upd++;}db.prepare('INSERT INTO recovery_imports(filename,imported_by,row_count,inserted_count,updated_count,imported_at) VALUES(?,?,?,?,?,?)').run(filename,u.id,rows.length,ins,upd,iso());return json(res,200,{ok:true,rows:rows.length,inserted:ins,updated:upd});
    }
    return json(res,404,{error:'API route not found'});
  }catch(e){console.error('[api]',e);return json(res,e.status||500,{error:e.message||'Internal server error'});}
}

function serveStatic(req,res,url){
  const requested=url.pathname==='/'?'/index.html':url.pathname; const candidate=path.resolve(publicDir,'.'+requested); const rel=path.relative(publicDir,candidate); if(rel.startsWith('..')||path.isAbsolute(rel))return text(res,403,'Forbidden');
  if(fs.existsSync(candidate)&&fs.statSync(candidate).isFile()){
    const ext=path.extname(candidate).toLowerCase();const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.ico':'image/x-icon','.woff2':'font/woff2'};return text(res,200,fs.readFileSync(candidate),types[ext]||'application/octet-stream');
  }
  return text(res,200,fs.readFileSync(path.join(publicDir,'index.html')),'text/html; charset=utf-8');
}

const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url,`http://${req.headers.host||'localhost'}`);
  res.setHeader('Referrer-Policy','same-origin');res.setHeader('X-Frame-Options','SAMEORIGIN');res.setHeader('Permissions-Policy','camera=(), microphone=(), geolocation=()');
  if(url.pathname.startsWith('/api/')) return api(req,res,url); return serveStatic(req,res,url);
});

try{ const n=backfillExportFieldsFromRaw(); if(n) console.log(`Backfilled Excel-export fields (GBP amount, export status, expense type) on ${n} stored transaction(s)`); }catch(e){ console.error('[export-field backfill]',e.message); }
setInterval(sweepStaleSessions,60_000).unref();
setInterval(()=>{receiptWorkerTick().catch(e=>console.error('[receipt worker]',e.message));},3000).unref();
if(cfg.pleoAutoSync){setInterval(()=>{if(pleoConfigured()&&!syncInProgress){try{startSyncPleo('scheduled',null);}catch(e){console.error('[pleo sync]',e.message);}}},cfg.pleoIntervalMinutes*60_000).unref();}
setInterval(()=>{try{dailySyncTick();}catch(e){console.error('[pleo daily sync]',e.message);}},60_000).unref();
server.listen(cfg.port,cfg.host,()=>{
  const cfgStatus=pleoConfigStatus();
  console.log(`JSAN Expensyra listening on http://${cfg.host}:${cfg.port}`);
  console.log(`Database: ${db.dialect} · ${dbLabel}`);
  console.log(`Pleo mode: ${cfg.pleoSyncMode}`);
  console.log(`Mock mode: ${cfg.pleoMockMode}${cfg.pleoMockMode?' (live credentials below are ignored while mock mode is on)':''}`);
  console.log(`API key configured: ${Boolean(cfg.pleoKey)}`);
  console.log(`Company ID configured: ${Boolean(cfg.pleoCompanyId)}${cfg.pleoCompanyId&&!cfg.pleoCompanyIdLooksValid?' (does not look like a valid UUID)':''}`);
  console.log(`API base: ${cfg.pleoBase}`);
  console.log(`Pleo configured: ${pleoConfigured()}${cfg.pleoMockMode?' (via mock mode, not live credentials)':cfgStatus.ok?'':` (${cfgStatus.reason}: ${cfgStatus.message})`}`);
  console.log(`Pleo startup sync: ${cfg.pleoSyncOnStart?'enabled':'disabled'}`);
  console.log(`Pleo scheduled sync: ${cfg.pleoAutoSync?`enabled (every ${cfg.pleoIntervalMinutes}m)`:'disabled'}`);
  const ds=dailySyncSettings();console.log(`Pleo daily sync: ${ds.enabled?`enabled (${ds.time} ${ds.timezone})`:'disabled'}`);
  if(cfg.pleoSyncOnStart&&pleoConfigured())setTimeout(()=>{try{startSyncPleo('startup',null);}catch(e){console.error('[pleo startup sync]',e.message);}},750);
});

function shutdown(signal){
  console.log(`Received ${signal}; shutting down JSAN Expensyra`);
  server.close(()=>{ try{db.close();}catch{} process.exit(0); });
  setTimeout(()=>process.exit(1),10_000).unref();
}
process.on('SIGTERM',()=>shutdown('SIGTERM'));
process.on('SIGINT',()=>shutdown('SIGINT'));
