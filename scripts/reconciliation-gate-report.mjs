// Prints the reconciliation "snapshot gate report" against a FROZEN snapshot
// file (never the live DB), so hard-gate counts are never computed against a
// moving target. Query set mirrors GET /api/analytics/data-quality-gate in
// server.js — keep the two in sync if the schema/precedence model changes.
//
// Usage: node scripts/reconciliation-gate-report.mjs data/backups/spendops-live-gate-YYYYMMDD-HHMM.db
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const snapshotArg = process.argv[2];
if (!snapshotArg) {
  console.error('Usage: node scripts/reconciliation-gate-report.mjs <snapshot.db>');
  process.exit(1);
}
const snapshotPath = path.resolve(snapshotArg);
if (!fs.existsSync(snapshotPath)) {
  console.error(`Snapshot not found: ${snapshotPath}`);
  process.exit(1);
}
const metaPath = snapshotPath.replace(/\.db$/, '.snapshot.json');
const meta = fs.existsSync(metaPath) ? JSON.parse(fs.readFileSync(metaPath, 'utf8')) : null;

const db = new DatabaseSync(snapshotPath, { readOnly: true });
const count = (sql, ...args) => db.prepare(sql).get(...args).n;
const liveWhere = "(source_kind='LIVE_API' OR source_kind='HISTORICAL_API')";

function resolveTagGroupIdByName(name) {
  const row = db.prepare('SELECT id FROM pleo_tag_groups WHERE name=? ORDER BY archived ASC, updated_at DESC LIMIT 1').get(name);
  return row?.id || null;
}

const billingGroupId = resolveTagGroupIdByName('Billing Status');
const billingTagCount = billingGroupId ? count('SELECT COUNT(*) n FROM pleo_tags WHERE group_id=?', billingGroupId) : 0;
const billingMappedCount = billingGroupId ? count('SELECT COUNT(*) n FROM pleo_tags pt JOIN billing_status_mapping bsm ON bsm.pleo_tag_id=pt.id WHERE pt.group_id=?', billingGroupId) : 0;

const report = {
  snapshot: {
    path: snapshotPath,
    timestamp: meta?.snapshotTimestamp ?? null,
    sourceDbPath: meta?.sourceDbPath ?? null,
    totalRealTransactions: count(`SELECT COUNT(*) n FROM transactions WHERE ${liveWhere}`),
    latestTransactionTimestamp: meta?.latestTransactionTimestamp ?? null,
    latestSyncRunId: meta?.latestSyncRunId ?? null,
  },
  project: {
    activeJsanProjects: count('SELECT COUNT(*) n FROM projects WHERE active=1'),
    verifiedProjectAssignments: count(`SELECT COUNT(*) n FROM transactions WHERE ${liveWhere} AND project_status='ASSIGNED'`),
    pleoProjectTagAssignments: count(`SELECT COUNT(*) n FROM transactions WHERE ${liveWhere} AND project_attribution_source='PLEO_PROJECT_TAG'`),
    approvedRuleAssignments: count(`SELECT COUNT(*) n FROM transactions WHERE ${liveWhere} AND project_attribution_source='APPROVED_MAPPING_RULE'`),
    manualAssignments: count(`SELECT COUNT(*) n FROM transactions WHERE ${liveWhere} AND project_attribution_source='MANUAL'`),
    missingProject: count(`SELECT COUNT(*) n FROM transactions WHERE ${liveWhere} AND project_status='MISSING_PROJECT'`),
    projectConflicts: count(`SELECT COUNT(*) n FROM transactions WHERE ${liveWhere} AND project_status='PROJECT_ATTRIBUTION_CONFLICT'`),
  },
  commercialClassification: {
    billingStatusTagCoverage: billingTagCount,
    mappedClassification: billingMappedCount,
    missingClassification: count(`SELECT COUNT(*) n FROM transactions WHERE ${liveWhere} AND dq_missing_classification=1`),
    ambiguousUnmappedBillingStatuses: billingTagCount - billingMappedCount,
  },
  category: {
    pleoResolved: count(`SELECT COUNT(*) n FROM transactions WHERE ${liveWhere} AND category_resolution_source='PLEO_RESOLVED_ACCOUNT'`),
    historicalResolved: count(`SELECT COUNT(*) n FROM transactions WHERE ${liveWhere} AND category_resolution_source='VERIFIED_HISTORICAL_EXPORT_CATEGORY'`),
    manualResolved: count(`SELECT COUNT(*) n FROM transactions WHERE ${liveWhere} AND category_resolution_source='APPROVED_MANUAL_MAPPING'`),
    accountIdNotFound: count(`SELECT COUNT(*) n FROM transactions WHERE ${liveWhere} AND category_resolution_status='ACCOUNT_ID_NOT_IN_REFERENCE_DATA'`),
    missingAccountId: count(`SELECT COUNT(*) n FROM transactions WHERE ${liveWhere} AND category_resolution_status='MISSING_ACCOUNT_ID'`),
    conflicts: 0, // no category-level conflict state exists yet — see docs/ARCHITECTURE.md
  },
  evidence: {
    receiptAvailable: count(`SELECT COUNT(*) n FROM transactions WHERE ${liveWhere} AND receipt_count>0`),
    receiptMissing: count(`SELECT COUNT(*) n FROM transactions WHERE ${liveWhere} AND receipt_count=0`),
  },
  qualityFlags: {
    missingProject: count(`SELECT COUNT(*) n FROM transactions WHERE ${liveWhere} AND dq_missing_project=1`),
    missingClassification: count(`SELECT COUNT(*) n FROM transactions WHERE ${liveWhere} AND dq_missing_classification=1`),
    categoryUnresolved: count(`SELECT COUNT(*) n FROM transactions WHERE ${liveWhere} AND dq_unresolved_category=1`),
    missingReceipt: count(`SELECT COUNT(*) n FROM transactions WHERE ${liveWhere} AND dq_missing_receipt=1`),
    sourceConflict: count(`SELECT COUNT(*) n FROM transactions WHERE ${liveWhere} AND project_status='PROJECT_ATTRIBUTION_CONFLICT'`),
  },
};
db.close();

function line(label, value) { console.log(`${label}: ${value}`); }
console.log('SNAPSHOT');
line('Path', report.snapshot.path);
line('Timestamp', report.snapshot.timestamp);
line('Source DB path', report.snapshot.sourceDbPath);
line('Total real transactions', report.snapshot.totalRealTransactions);
line('Latest transaction timestamp', report.snapshot.latestTransactionTimestamp);
line('Latest sync run ID', report.snapshot.latestSyncRunId);
console.log('\nPROJECT');
line('Active JSAN projects', report.project.activeJsanProjects);
line('Verified project assignments', report.project.verifiedProjectAssignments);
line('Pleo project-tag assignments', report.project.pleoProjectTagAssignments);
line('Approved rule assignments', report.project.approvedRuleAssignments);
line('Manual assignments', report.project.manualAssignments);
line('Missing project', report.project.missingProject);
line('Project conflicts', report.project.projectConflicts);
console.log('\nCOMMERCIAL CLASSIFICATION');
line('Billing Status tag coverage', report.commercialClassification.billingStatusTagCoverage);
line('Mapped classification', report.commercialClassification.mappedClassification);
line('Missing classification', report.commercialClassification.missingClassification);
line('Ambiguous/unmapped billing statuses', report.commercialClassification.ambiguousUnmappedBillingStatuses);
console.log('\nCATEGORY');
line('Pleo-resolved', report.category.pleoResolved);
line('Historical-resolved', report.category.historicalResolved);
line('Manual-resolved', report.category.manualResolved);
line('Account ID not found', report.category.accountIdNotFound);
line('Missing account ID', report.category.missingAccountId);
line('Conflicts', report.category.conflicts);
console.log('\nEVIDENCE');
line('Receipt available', report.evidence.receiptAvailable);
line('Receipt missing', report.evidence.receiptMissing);
console.log('\nQUALITY FLAGS');
line('Missing project', report.qualityFlags.missingProject);
line('Missing classification', report.qualityFlags.missingClassification);
line('Category unresolved', report.qualityFlags.categoryUnresolved);
line('Missing receipt', report.qualityFlags.missingReceipt);
line('Source conflict', report.qualityFlags.sourceConflict);

console.log('\n--- JSON ---');
console.log(JSON.stringify(report, null, 2));
