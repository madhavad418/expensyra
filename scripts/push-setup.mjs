// Copy Expensyra's set-up data from one database into another — typically the
// local SQLite file into production (Railway Postgres):
//
//   DATABASE_URL=postgres://… node scripts/push-setup.mjs --from ./data/spendops-live-2.db           (dry run)
//   DATABASE_URL=postgres://… node scripts/push-setup.mjs --from ./data/spendops-live-2.db --apply   (write)
//
// (--to <sqlite file> targets a SQLite database instead of DATABASE_URL, for testing.)
//
// What moves, matched by natural keys — never by database id, which differs
// between databases:
//   projects                   by code
//   pleo_team_names            by team_id
//   project_mapping_rules      by (source_type, source_value), pointed at the
//                              target's project with the same code
//   pleo_tag_groups/pleo_tags  by Pleo id   (incl. the "Billing Status" group)
//   pleo_categories            by Pleo id   (chart of accounts)
//   billing_status_mapping     by Pleo tag id
//   account_category_mappings  by Pleo account id (names learned from the Pleo Excel export)
//   per-transaction Excel evidence (historical category, Pleo review label /
//   reviewers / note) by Pleo accounting entry id — only where the target's
//   field is empty. JSAN review decisions are never copied.
// Additive only: rows the target already has are left exactly as they are and
// reported (a differing project link is reported as a conflict and skipped).
// Approved project links are then applied to the target's transactions through
// the app's precedence merge (lib/precedence.mjs), so MANUAL reviewer choices
// are never overwritten. One DB transaction plus an audit_log entry.
//
// Afterwards, in the target app: Pleo Sync → "Sync reference data". That
// re-derives every transaction's category and commercial classification from
// this data (and refreshes it from Pleo), and reloads the project links.
import { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../lib/db.mjs';
import { attributeProjectFromRules, mergeProjectAttribution } from '../lib/precedence.mjs';

const args = process.argv.slice(2);
const opt = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const from = opt('--from'), toPath = opt('--to'), apply = args.includes('--apply');
const url = toPath ? null : process.env.DATABASE_URL;
if (!from) { console.error('Usage: node scripts/push-setup.mjs --from <local sqlite file> [--to <sqlite file>] [--apply]  (target: DATABASE_URL)'); process.exit(2); }
if (!toPath && !/^postgres(ql)?:\/\//i.test(url || '')) { console.error('Set DATABASE_URL to the target postgres:// URL (or pass --to <sqlite file>).'); process.exit(2); }

const src = new DatabaseSync(from, { readOnly: true });
const dst = openDatabase({ path: toPath, url });
const iso = () => new Date().toISOString();
const where = toPath ? `SQLite ${toPath}` : `Postgres ${new URL(url).host}${new URL(url).pathname}`;
console.log(`${apply ? 'APPLY' : 'DRY RUN'} — from ${from} → ${where}\n`);

for (const t of ['projects', 'project_mapping_rules', 'pleo_team_names', 'pleo_tag_groups', 'pleo_tags', 'pleo_categories', 'billing_status_mapping', 'account_category_mappings', 'transactions', 'audit_log']) {
  try { dst.prepare(`SELECT COUNT(*) n FROM ${t}`).get(); }
  catch { console.error(`Target has no "${t}" table — start the app against it once so it creates its schema.`); process.exit(1); }
}

const show = (label, list, f = x => x, max = 30) => { console.log(`${label}: ${list.length}`); for (const x of list.slice(0, max)) console.log('   ', f(x)); if (list.length > max) console.log(`    … ${list.length - max} more`); };

// ---- Projects, team names, project links ----
const PROJECT_COLS = ['code', 'name', 'customer', 'active', 'status', 'project_manager', 'country', 'start_date', 'end_date', 'pleo_project_tag_id', 'pleo_project_tag_name', 'commercial_model'];
const srcProjects = src.prepare('SELECT * FROM projects ORDER BY code').all();
const srcCodeById = new Map(srcProjects.map(p => [p.id, p.code]));
const dstProject = dst.prepare('SELECT * FROM projects WHERE code=?');
const dstRule = dst.prepare('SELECT r.*, p.code project_code FROM project_mapping_rules r LEFT JOIN projects p ON p.id=r.project_id WHERE r.source_type=? AND r.source_value=?');
const plan = { projectsNew: [], projectsSame: 0, projectsDiffer: [], rulesNew: [], rulesSame: 0, rulesConflict: [] };
for (const p of srcProjects) {
  const d = dstProject.get(p.code);
  if (!d) { plan.projectsNew.push(p); continue; }
  const diff = PROJECT_COLS.filter(c => (p[c] ?? null) !== (d[c] ?? null) && !(c === 'active' && Number(p[c]) === Number(d[c])));
  diff.length ? plan.projectsDiffer.push({ code: p.code, fields: diff }) : plan.projectsSame++;
}
for (const r of src.prepare('SELECT * FROM project_mapping_rules ORDER BY id').all()) {
  const code = srcCodeById.get(r.project_id); if (!code) continue;
  const d = dstRule.get(r.source_type, r.source_value);
  if (!d) plan.rulesNew.push({ ...r, code });
  else if (d.project_code !== code) plan.rulesConflict.push({ source: `${r.source_type}:${r.source_value}`, local: code, target: d.project_code, target_status: d.status });
  else plan.rulesSame++;
}
show('Projects to add', plan.projectsNew, p => `${p.code}  ${p.name}${p.customer ? `  (${p.customer})` : ''}`);
console.log(`Projects already identical: ${plan.projectsSame}`);
show('Projects already in target but different (left as they are)', plan.projectsDiffer, x => `${x.code}: ${x.fields.join(', ')}`);
show('Project links to add', plan.rulesNew, r => `${r.source_type} ${r.source_value} → ${r.code} [${r.status}]`, 10);
console.log(`Project links already identical: ${plan.rulesSame}`);
show('Project links pointing elsewhere in target (skipped)', plan.rulesConflict, x => `${x.source}: local ${x.local} / target ${x.target} [${x.target_status}]`);

// ---- Reference tables copied by primary key (insert-if-missing) ----
const REF = [
  { table: 'pleo_team_names', key: 'team_id', label: 'Pleo team names', cols: ['team_id', 'team_name', 'rows_seen', 'share', 'updated_at'], show: r => `${r.team_name}` },
  { table: 'pleo_tag_groups', key: 'id', label: 'Pleo tag groups', cols: ['id', 'company_id', 'name', 'code', 'archived', 'created_at', 'updated_at', 'source_system', 'source_environment', 'synced_at'], show: r => `${r.name}${r.archived ? ' (archived)' : ''}` },
  { table: 'pleo_tags', key: 'id', label: 'Pleo tags', cols: ['id', 'group_id', 'name', 'code', 'archived', 'created_at', 'updated_at', 'source_system', 'source_environment', 'synced_at'], show: r => r.name },
  { table: 'pleo_categories', key: 'id', label: 'Chart of accounts', cols: ['id', 'company_id', 'name', 'code', 'archived', 'created_at', 'updated_at', 'source_system', 'source_environment', 'synced_at'], show: r => `${r.code || ''} ${r.name}` },
  { table: 'billing_status_mapping', key: 'pleo_tag_id', label: 'Billing Status → classification', cols: ['pleo_tag_id', 'pleo_tag_name', 'spendops_classification', 'created_at', 'updated_at'], show: r => `${r.pleo_tag_name} → ${r.spendops_classification}`, compare: 'spendops_classification' },
  { table: 'account_category_mappings', key: 'pleo_account_id', label: 'Account → category names', cols: ['pleo_account_id', 'category_name', 'source', 'rows_seen', 'updated_at'], show: r => `${r.pleo_account_id} → ${r.category_name}`, compare: 'category_name' },
];
for (const ref of REF) {
  const exists = dst.prepare(`SELECT * FROM ${ref.table} WHERE ${ref.key}=?`);
  ref.rows = src.prepare(`SELECT * FROM ${ref.table}`).all();
  ref.new = []; ref.differ = [];
  for (const r of ref.rows) {
    const d = exists.get(r[ref.key]);
    if (!d) ref.new.push(r);
    else if (ref.compare && d[ref.compare] !== r[ref.compare]) ref.differ.push(`${ref.show(r)}  (target: ${d[ref.compare]})`);
  }
  show(`${ref.label} to add (${ref.rows.length} local)`, ref.new, ref.show, ref.table === 'pleo_tags' ? 5 : 30);
  if (ref.differ.length) show(`${ref.label} that differ in target (left as they are)`, ref.differ);
}

// ---- Per-transaction Excel evidence ----
const EVIDENCE = ['historical_category_name', 'pleo_review_status_label', 'pleo_reviewer_names', 'pleo_review_note'];
const srcEvidence = src.prepare(`SELECT pleo_accounting_entry_id id,${EVIDENCE.join(',')} FROM transactions WHERE ${EVIDENCE.map(c => `${c} IS NOT NULL`).join(' OR ')}`).all();
const dstEvidence = dst.prepare(`SELECT ${EVIDENCE.join(',')} FROM transactions WHERE pleo_accounting_entry_id=?`);
let evidenceFill = 0, evidenceMissing = 0; const evidenceRows = [];
for (const r of srcEvidence) {
  const d = dstEvidence.get(r.id);
  if (!d) { evidenceMissing++; continue; }
  if (EVIDENCE.some(c => r[c] != null && d[c] == null)) { evidenceFill++; evidenceRows.push(r); }
}
console.log(`Transactions to receive Excel evidence (historical category / Pleo review): ${evidenceFill} of ${srcEvidence.length} local${evidenceMissing ? ` (${evidenceMissing} not in target yet — sync them first, then re-run)` : ''}`);

// ---- Project attribution over every target transaction ----
function attribute(write) {
  const ctx = {
    rules: dst.prepare("SELECT id,source_type,source_value,project_id FROM project_mapping_rules WHERE status='APPROVED'").all(),
    tagNames: new Map(dst.prepare('SELECT id,name FROM pleo_tags').all().map(t => [t.id, t.name])),
    groupNames: new Map(dst.prepare('SELECT id,name FROM pleo_tag_groups').all().map(g => [g.id, g.name])),
  };
  const teamNames = new Map(dst.prepare('SELECT team_id,team_name FROM pleo_team_names').all().map(r => [r.team_id, r.team_name]));
  const rows = dst.prepare('SELECT id,team_id,team_name,tags,project_id,project_attribution_source,project_attributed_at,project_attributed_by,project_mapping_rule_id,project_status FROM transactions').all();
  const upd = write && dst.prepare('UPDATE transactions SET project_id=?,project_attribution_source=?,project_attributed_at=?,project_attributed_by=?,project_mapping_rule_id=?,project_status=?,dq_missing_project=?,updated_at=? WHERE id=?');
  const t = iso(); const out = { scanned: rows.length, changed: 0, nowAssigned: 0, conflicts: 0, manualKept: 0 };
  for (const row of rows) {
    const tx = { ...row, team_name: row.team_name || teamNames.get(row.team_id) || null };
    const p = mergeProjectAttribution(row, attributeProjectFromRules(tx, ctx));
    if (row.project_attribution_source === 'MANUAL') out.manualKept++;
    if (p.project_status === 'PROJECT_ATTRIBUTION_CONFLICT') out.conflicts++;
    if (p.project_id === row.project_id && p.project_attribution_source === row.project_attribution_source && p.project_mapping_rule_id === row.project_mapping_rule_id && p.project_status === row.project_status) continue;
    out.changed++; if (p.project_status === 'ASSIGNED' && row.project_status !== 'ASSIGNED') out.nowAssigned++;
    if (write) upd.run(p.project_id, p.project_attribution_source, p.project_attributed_at, p.project_attributed_by, p.project_mapping_rule_id, p.project_status, p.project_status === 'MISSING_PROJECT' ? 1 : 0, t, row.id);
  }
  return out;
}

const nothing = !plan.projectsNew.length && !plan.rulesNew.length && REF.every(r => !r.new.length) && !evidenceFill;
if (!apply) {
  console.log(`\nDry run only — nothing written.${nothing ? ' (Target is already up to date.)' : ' Re-run with --apply to write these changes.'}`);
  console.log('Transactions in target:', dst.prepare('SELECT COUNT(*) n FROM transactions').get().n, '— project links are applied to them on --apply.');
  dst.close?.(); process.exit(0);
}

const t = iso(); let attribution;
dst.exec('BEGIN');
try {
  const insProject = dst.prepare(`INSERT INTO projects(${PROJECT_COLS.join(',')},created_at,updated_at) VALUES(${PROJECT_COLS.map(() => '?').join(',')},?,?)`);
  for (const p of plan.projectsNew) insProject.run(...PROJECT_COLS.map(c => p[c] ?? (c === 'active' ? 1 : c === 'status' ? 'ACTIVE' : null)), t, t);
  for (const ref of REF) {
    const ins = dst.prepare(`INSERT INTO ${ref.table}(${ref.cols.join(',')}) VALUES(${ref.cols.map(() => '?').join(',')}) ON CONFLICT(${ref.key}) DO NOTHING`);
    for (const r of ref.new) ins.run(...ref.cols.map(c => r[c] ?? null));
  }
  const fillTeam = dst.prepare("UPDATE transactions SET team_name=?,updated_at=? WHERE team_id=? AND (team_name IS NULL OR team_name='')");
  for (const tm of REF[0].new) fillTeam.run(tm.team_name, t, tm.team_id);
  // created_by/approved_by stay NULL: user ids don't carry across databases.
  const insRule = dst.prepare('INSERT INTO project_mapping_rules(source_type,source_value,project_id,status,created_by,approved_by,approved_at,created_at,updated_at) VALUES(?,?,?,?,NULL,NULL,?,?,?)');
  for (const r of plan.rulesNew) insRule.run(r.source_type, r.source_value, dstProject.get(r.code).id, r.status, r.status === 'APPROVED' ? (r.approved_at || t) : null, t, t);
  const fillEvidence = dst.prepare(`UPDATE transactions SET ${EVIDENCE.map(c => `${c}=COALESCE(${c},?)`).join(',')},updated_at=? WHERE pleo_accounting_entry_id=?`);
  for (const r of evidenceRows) fillEvidence.run(...EVIDENCE.map(c => r[c]), t, r.id);
  attribution = attribute(true);
  dst.prepare('INSERT INTO audit_log(transaction_id,actor_id,action,detail,created_at) VALUES(NULL,NULL,?,?,?)').run('SETUP_PUSHED_FROM_LOCAL', JSON.stringify({
    from, projects_added: plan.projectsNew.map(p => p.code), links_added: plan.rulesNew.length,
    reference_added: Object.fromEntries(REF.map(r => [r.table, r.new.length])), evidence_filled: evidenceFill,
    skipped: { projects_differ: plan.projectsDiffer, links_conflict: plan.rulesConflict }, attribution,
  }), t);
  dst.exec('COMMIT');
} catch (e) { dst.exec('ROLLBACK'); console.error('\nFAILED — rolled back, nothing written:', e.message); process.exit(1); }

console.log(`\nWritten: ${plan.projectsNew.length} project(s), ${plan.rulesNew.length} link(s), ${REF.map(r => `${r.new.length} ${r.label.toLowerCase()}`).join(', ')}, evidence on ${evidenceFill} transaction(s).`);
console.log(`Project attribution: ${attribution.scanned} transactions scanned, ${attribution.nowAssigned} newly given a project, ${attribution.manualKept} reviewer choices kept, ${attribution.conflicts} conflicts.`);
console.log('\nNext, in the production app: Pleo Sync → "Sync reference data". It rebuilds every transaction\'s category and commercial classification from this data and reloads the project links.');
dst.close?.();
