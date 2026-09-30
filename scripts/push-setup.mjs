// Copy the Project Master set-up from one Expensyra database into another —
// typically the local SQLite file into production (Railway Postgres):
//
//   DATABASE_URL=postgres://… node scripts/push-projects.mjs --from ./data/spendops-live-2.db           (dry run)
//   DATABASE_URL=postgres://… node scripts/push-projects.mjs --from ./data/spendops-live-2.db --apply   (write)
//
// (--to <sqlite file> targets a SQLite database instead of DATABASE_URL, for testing.)
//
// What moves, matched by natural keys — never by database id, which differs
// between databases:
//   projects               by code
//   pleo_team_names        by team_id
//   project_mapping_rules  by (source_type, source_value), pointed at the
//                          target's project with the same code
// Additive only: rows the target already has are left exactly as they are and
// reported (a differing link is reported as a conflict and skipped). Then the
// approved links are applied to the target's transactions through the same
// precedence merge as the app (lib/precedence.mjs), so MANUAL reviewer
// choices are never overwritten. Everything is one DB transaction plus an
// audit_log entry. Restart the target app afterwards: it caches mapping rules
// in memory until a rule changes or it restarts.
import { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../lib/db.mjs';
import { attributeProjectFromRules, mergeProjectAttribution } from '../lib/precedence.mjs';

const args = process.argv.slice(2);
const opt = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const from = opt('--from'), toPath = opt('--to'), apply = args.includes('--apply');
const url = toPath ? null : process.env.DATABASE_URL;
if (!from) { console.error('Usage: node scripts/push-projects.mjs --from <local sqlite file> [--to <sqlite file>] [--apply]  (target: DATABASE_URL)'); process.exit(2); }
if (!toPath && !/^postgres(ql)?:\/\//i.test(url || '')) { console.error('Set DATABASE_URL to the target postgres:// URL (or pass --to <sqlite file>).'); process.exit(2); }

const src = new DatabaseSync(from, { readOnly: true });
const dst = openDatabase({ path: toPath, url });
const iso = () => new Date().toISOString();
const where = toPath ? `SQLite ${toPath}` : `Postgres ${new URL(url).host}${new URL(url).pathname}`;
console.log(`${apply ? 'APPLY' : 'DRY RUN'} — from ${from} → ${where}\n`);

for (const t of ['projects', 'project_mapping_rules', 'pleo_team_names', 'transactions', 'audit_log']) {
  try { dst.prepare(`SELECT COUNT(*) n FROM ${t}`).get(); }
  catch { console.error(`Target has no "${t}" table — start the app against it once so it creates its schema.`); process.exit(1); }
}

const PROJECT_COLS = ['code', 'name', 'customer', 'active', 'status', 'project_manager', 'country', 'start_date', 'end_date', 'pleo_project_tag_id', 'pleo_project_tag_name', 'commercial_model'];
const srcProjects = src.prepare('SELECT * FROM projects ORDER BY code').all();
const srcCodeById = new Map(srcProjects.map(p => [p.id, p.code]));
const srcRules = src.prepare('SELECT * FROM project_mapping_rules ORDER BY id').all();
const srcTeams = src.prepare('SELECT team_id, team_name FROM pleo_team_names ORDER BY team_id').all();

const dstProject = dst.prepare('SELECT * FROM projects WHERE code=?');
const dstRule = dst.prepare('SELECT r.*, p.code project_code FROM project_mapping_rules r LEFT JOIN projects p ON p.id=r.project_id WHERE r.source_type=? AND r.source_value=?');
const dstTeam = dst.prepare('SELECT team_name FROM pleo_team_names WHERE team_id=?');

const plan = { projectsNew: [], projectsSame: 0, projectsDiffer: [], teamsNew: [], teamsDiffer: [], rulesNew: [], rulesSame: 0, rulesConflict: [], rulesOrphan: [] };
for (const p of srcProjects) {
  const d = dstProject.get(p.code);
  if (!d) { plan.projectsNew.push(p); continue; }
  const diff = PROJECT_COLS.filter(c => (p[c] ?? null) !== (d[c] ?? null) && !(c === 'active' && Number(p[c]) === Number(d[c])));
  diff.length ? plan.projectsDiffer.push({ code: p.code, fields: diff }) : plan.projectsSame++;
}
for (const t of srcTeams) {
  const d = dstTeam.get(t.team_id);
  if (!d) plan.teamsNew.push(t); else if (d.team_name !== t.team_name) plan.teamsDiffer.push({ team_id: t.team_id, local: t.team_name, target: d.team_name });
}
for (const r of srcRules) {
  const code = srcCodeById.get(r.project_id);
  if (!code) { plan.rulesOrphan.push(r.id); continue; }
  const d = dstRule.get(r.source_type, r.source_value);
  if (!d) plan.rulesNew.push({ ...r, code });
  else if (d.project_code !== code) plan.rulesConflict.push({ source: `${r.source_type}:${r.source_value}`, local: code, target: d.project_code, target_status: d.status });
  else plan.rulesSame++;
}

const show = (label, list, f = x => x) => { console.log(`${label}: ${list.length}`); for (const x of list.slice(0, 40)) console.log('   ', f(x)); if (list.length > 40) console.log(`    … ${list.length - 40} more`); };
show('Projects to add', plan.projectsNew, p => `${p.code}  ${p.name}${p.customer ? `  (${p.customer})` : ''}`);
console.log(`Projects already identical: ${plan.projectsSame}`);
show('Projects already in target but different (left as they are)', plan.projectsDiffer, x => `${x.code}: ${x.fields.join(', ')}`);
show('Team names to add', plan.teamsNew, t => `${t.team_id}  ${t.team_name}`);
show('Team names that differ (left as they are)', plan.teamsDiffer, x => `${x.team_id}: local "${x.local}" / target "${x.target}"`);
show('Project links to add', plan.rulesNew, r => `${r.source_type} ${r.source_value} → ${r.code} [${r.status}]`);
console.log(`Project links already identical: ${plan.rulesSame}`);
show('Project links pointing elsewhere in target (skipped)', plan.rulesConflict, x => `${x.source}: local ${x.local} / target ${x.target} [${x.target_status}]`);
if (plan.rulesOrphan.length) console.log(`Local links without a local project (ignored): ${plan.rulesOrphan.length}`);

// Attribution preview/apply over every target transaction.
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

const nothing = !plan.projectsNew.length && !plan.teamsNew.length && !plan.rulesNew.length;
if (!apply) {
  console.log(`\nDry run only — nothing written.${nothing ? ' (Target is already up to date.)' : ' Re-run with --apply to write these changes.'}`);
  console.log('Transactions in target:', dst.prepare('SELECT COUNT(*) n FROM transactions').get().n, '— links are applied to them on --apply.');
  dst.close?.(); process.exit(0);
}

const t = iso(); let attribution;
dst.exec('BEGIN');
try {
  const insProject = dst.prepare(`INSERT INTO projects(${PROJECT_COLS.join(',')},created_at,updated_at) VALUES(${PROJECT_COLS.map(() => '?').join(',')},?,?)`);
  for (const p of plan.projectsNew) insProject.run(...PROJECT_COLS.map(c => p[c] ?? (c === 'active' ? 1 : c === 'status' ? 'ACTIVE' : null)), t, t);
  const insTeam = dst.prepare('INSERT INTO pleo_team_names(team_id,team_name,rows_seen,share,import_id,updated_at) VALUES(?,?,0,1,NULL,?) ON CONFLICT(team_id) DO NOTHING');
  const fillTeam = dst.prepare("UPDATE transactions SET team_name=?,updated_at=? WHERE team_id=? AND (team_name IS NULL OR team_name='')");
  for (const tm of plan.teamsNew) { insTeam.run(tm.team_id, tm.team_name, t); fillTeam.run(tm.team_name, t, tm.team_id); }
  // created_by/approved_by stay NULL: user ids don't carry across databases.
  const insRule = dst.prepare('INSERT INTO project_mapping_rules(source_type,source_value,project_id,status,created_by,approved_by,approved_at,created_at,updated_at) VALUES(?,?,?,?,NULL,NULL,?,?,?)');
  for (const r of plan.rulesNew) insRule.run(r.source_type, r.source_value, dstProject.get(r.code).id, r.status, r.status === 'APPROVED' ? (r.approved_at || t) : null, t, t);
  attribution = attribute(true);
  dst.prepare('INSERT INTO audit_log(transaction_id,actor_id,action,detail,created_at) VALUES(NULL,NULL,?,?,?)').run('PROJECTS_PUSHED_FROM_LOCAL', JSON.stringify({
    from, projects_added: plan.projectsNew.map(p => p.code), team_names_added: plan.teamsNew.length, links_added: plan.rulesNew.map(r => `${r.source_type}:${r.source_value}→${r.code}`),
    skipped: { projects_differ: plan.projectsDiffer, links_conflict: plan.rulesConflict }, attribution,
  }), t);
  dst.exec('COMMIT');
} catch (e) { dst.exec('ROLLBACK'); console.error('\nFAILED — rolled back, nothing written:', e.message); process.exit(1); }

console.log(`\nWritten: ${plan.projectsNew.length} project(s), ${plan.teamsNew.length} team name(s), ${plan.rulesNew.length} link(s).`);
console.log(`Transactions: ${attribution.scanned} scanned, ${attribution.changed} updated, ${attribution.nowAssigned} newly given a project, ${attribution.manualKept} reviewer choices kept, ${attribution.conflicts} conflicts.`);
console.log('Now restart the target app (e.g. redeploy/restart the Railway service) so it reloads the project links.');
dst.close?.();
