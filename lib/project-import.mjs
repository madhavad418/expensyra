// Project Master import from an Excel sheet (Administration → Project import).
// Pure planning: given the sheet rows and the current reference data, work out
// what would change. server.js applies the plan in one transaction.
//
// One row per project (or per project + Pleo team/tag link). A project code
// appearing on several rows is one project with several links.

export const PROJECT_IMPORT_COLUMNS = [
  // [field, header, required, what to enter, example]
  ['code', 'Project code', 'Yes', 'Unique short code. Matches an existing project to update it; a new code creates a project.', 'PRJ-005'],
  ['name', 'Project name', 'For new projects', 'Full project name shown everywhere in Expensyra.', 'PRJ-005-CT-AV-US-Waymo'],
  ['customer', 'Customer', 'No', 'Client the project is for.', 'Waymo'],
  ['project_manager', 'Project manager', 'No', 'Person responsible.', 'Jane Smith'],
  ['country', 'Country', 'No', 'Country of delivery.', 'United States'],
  ['status', 'Status', 'No (default Active)', 'Active, On hold or Closed.', 'Active'],
  ['start_date', 'Start date', 'No', 'Date (YYYY-MM-DD or an Excel date).', '2026-01-15'],
  ['end_date', 'End date', 'No', 'Date (YYYY-MM-DD or an Excel date); on or after the start date.', '2026-12-31'],
  ['commercial_model', 'Commercial model', 'No', 'How the project is billed.', 'Time and materials'],
  ['pleo_team', 'Pleo team', 'No', 'Pleo team name or team ID whose expenses belong to this project. Several teams: separate with ; or add another row with the same code. See the "Pleo teams" sheet.', 'PRJ-005-CT-AV-US-Waymo'],
  ['pleo_tag', 'Pleo tag', 'No', 'A Pleo tag (name, or "Group:Tag") whose expenses belong to this project. Several: separate with ;.', 'Project:Waymo US'],
];
const HEADER_ALIASES = {
  code: ['project code', 'code', 'project id'],
  name: ['project name', 'name', 'project'],
  customer: ['customer', 'client'],
  project_manager: ['project manager', 'manager', 'pm'],
  country: ['country'],
  status: ['status'],
  start_date: ['start date', 'start'],
  end_date: ['end date', 'end'],
  commercial_model: ['commercial model', 'billing model'],
  pleo_team: ['pleo team', 'pleo teams', 'team', 'team id', 'pleo team id'],
  pleo_tag: ['pleo tag', 'pleo tags', 'tag'],
};
const STATUS = { active: 'ACTIVE', 'on hold': 'ON_HOLD', on_hold: 'ON_HOLD', onhold: 'ON_HOLD', closed: 'CLOSED' };
const DETAIL_FIELDS = ['name', 'customer', 'project_manager', 'country', 'status', 'start_date', 'end_date', 'commercial_model'];
const LIMITS = { code: 50, name: 180, customer: 120, project_manager: 120, country: 80, commercial_model: 80 };
// Rows whose code starts with this come from the template and are never imported.
export const EXAMPLE_PREFIX = 'EXAMPLE-';

const str = v => v == null ? '' : String(v).trim();
const norm = v => str(v).toLowerCase().replace(/\s+/g, ' ');
const splitList = v => str(v).split(/[;\n]+/).map(s => s.trim()).filter(Boolean);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Excel stores dates as serial numbers (days since 1899-12-30).
function toDate(v) {
  if (v == null || v === '') return { value: null };
  if (typeof v === 'number' && Number.isFinite(v) && v > 0 && v < 2958466) {
    return { value: new Date(Math.round((v - 25569) * 86400000)).toISOString().slice(0, 10) };
  }
  const s = str(v), m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s) || /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (!m) return { error: `"${s}" is not a date (use YYYY-MM-DD)` };
  const [y, mo, d] = m[0].includes('/') ? [m[3], m[2], m[1]] : [m[1], m[2], m[3]];   // dd/mm/yyyy
  const iso = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const t = Date.parse(iso + 'T00:00:00Z');
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === iso ? { value: iso } : { error: `"${s}" is not a real date` };
}

/**
 * @param rows   sheet rows (arrays); first row = headers
 * @param ctx    { projects: [{id,code,...}], teams: [{team_id, team_name}], rules: [{source_type, source_value, project_code, status}] }
 */
export function planProjectImport(rows, ctx) {
  const header = (rows[0] || []).map(norm);
  const col = {};
  for (const [field, aliases] of Object.entries(HEADER_ALIASES)) { const i = header.findIndex(h => aliases.includes(h)); if (i >= 0) col[field] = i; }
  if (col.code == null) throw Object.assign(new Error('Missing a "Project code" column. Download the template to see the expected layout.'), { status: 400 });

  const errors = [], warnings = [], byCode = new Map(); let examples = 0, blank = 0;
  const cell = (r, f) => col[f] == null ? null : r[col[f]];
  rows.slice(1).forEach((r, i) => {
    const line = i + 2;
    if (!r || r.every(v => str(v) === '')) { blank++; return; }
    const code = str(cell(r, 'code')).toUpperCase();
    if (!code) { errors.push({ row: line, message: 'Project code is empty' }); return; }
    if (code.startsWith(EXAMPLE_PREFIX)) { examples++; return; }
    if (code.length > LIMITS.code) { errors.push({ row: line, code, message: `Project code is longer than ${LIMITS.code} characters` }); return; }
    const p = byCode.get(code) || { code, rows: [], fields: {}, teams: [], tags: [] };
    p.rows.push(line);
    for (const f of DETAIL_FIELDS) {
      let v = cell(r, f), out;
      if (f === 'status') {
        if (str(v) === '') continue;
        out = STATUS[norm(v)];
        if (!out) { errors.push({ row: line, code, message: `Status "${str(v)}" must be Active, On hold or Closed` }); continue; }
      } else if (f === 'start_date' || f === 'end_date') {
        const d = toDate(v); if (d.error) { errors.push({ row: line, code, message: `${f === 'start_date' ? 'Start' : 'End'} date ${d.error}` }); continue; }
        out = d.value; if (out == null) continue;
      } else {
        out = str(v); if (!out) continue;
        if (out.length > LIMITS[f]) { errors.push({ row: line, code, message: `${f.replace('_', ' ')} is longer than ${LIMITS[f]} characters` }); continue; }
      }
      if (p.fields[f] != null && p.fields[f] !== out) errors.push({ row: line, code, message: `Rows ${p.rows[0]} and ${line} give different ${f.replace('_', ' ')} for ${code}` });
      else p.fields[f] = out;
    }
    for (const t of splitList(cell(r, 'pleo_team'))) p.teams.push({ input: t, row: line });
    for (const t of splitList(cell(r, 'pleo_tag'))) p.tags.push({ input: t, row: line });
    byCode.set(code, p);
  });

  // Reference lookups.
  const projectByCode = new Map(ctx.projects.map(p => [String(p.code).toUpperCase(), p]));
  const teamById = new Map(), teamsByName = new Map();
  for (const t of ctx.teams) {
    if (!t.team_id) continue;
    teamById.set(String(t.team_id).toLowerCase(), t);
    if (t.team_name) { const k = norm(t.team_name); const ids = teamsByName.get(k) || new Set(); ids.add(t.team_id); teamsByName.set(k, ids); }
  }
  const ruleBySource = new Map(ctx.rules.map(r => [`${r.source_type}|${norm(r.source_value)}`, r]));

  const projects = { create: [], update: [], unchanged: 0 }, links = { create: [], approve: [], unchanged: 0, conflict: [] };
  const seenSource = new Map();
  for (const p of byCode.values()) {
    const existing = projectByCode.get(p.code);
    if (p.fields.start_date && p.fields.end_date && p.fields.end_date < p.fields.start_date) errors.push({ row: p.rows[0], code: p.code, message: 'End date is before the start date' });
    if (!existing) {
      if (!p.fields.name) errors.push({ row: p.rows[0], code: p.code, message: 'Project name is required for a new project' });
      else projects.create.push({ code: p.code, ...p.fields, status: p.fields.status || 'ACTIVE' });
    } else {
      // Only non-empty cells change anything; a blank cell keeps what's there.
      const changes = {};
      for (const [f, v] of Object.entries(p.fields)) if ((existing[f] ?? null) !== v) changes[f] = v;
      if (Object.keys(changes).length) projects.update.push({ id: existing.id, code: p.code, changes, before: Object.fromEntries(Object.keys(changes).map(f => [f, existing[f] ?? null])) });
      else projects.unchanged++;
    }
    const addLink = (source_type, source_value, label, row) => {
      const key = `${source_type}|${norm(source_value)}`;
      const prior = seenSource.get(key);
      if (prior && prior !== p.code) { errors.push({ row, code: p.code, message: `${label} is also given for ${prior} — one Pleo team or tag can belong to one project` }); return; }
      seenSource.set(key, p.code);
      if (prior) return; // same project twice
      const rule = ruleBySource.get(key);
      if (!rule) links.create.push({ code: p.code, source_type, source_value, label });
      else if (String(rule.project_code).toUpperCase() !== p.code) links.conflict.push({ code: p.code, label, current: rule.project_code });
      else if (rule.status !== 'APPROVED') links.approve.push({ id: rule.id, code: p.code, label });
      else links.unchanged++;
    };
    for (const t of p.teams) {
      let team = teamById.get(t.input.toLowerCase());
      if (!team) {
        const ids = teamsByName.get(norm(t.input));
        if (ids?.size > 1) { errors.push({ row: t.row, code: p.code, message: `Pleo team "${t.input}" matches ${ids.size} teams — use the team ID instead` }); continue; }
        if (ids?.size === 1) team = teamById.get(String([...ids][0]).toLowerCase());
      }
      if (!team) {
        if (UUID.test(t.input)) { warnings.push({ row: t.row, code: p.code, message: `Pleo team ID ${t.input} has no transactions yet — linked anyway` }); addLink('PLEO_TEAM', t.input.toLowerCase(), t.input, t.row); }
        else errors.push({ row: t.row, code: p.code, message: `Unknown Pleo team "${t.input}" — check the "Pleo teams" sheet, or use the team ID` });
        continue;
      }
      addLink('PLEO_TEAM', team.team_id, team.team_name || team.team_id, t.row);
    }
    for (const t of p.tags) addLink('PLEO_TAG', t.input, `Pleo tag "${t.input}"`, t.row);
  }
  return { errors, warnings, examples, blank, projects, links, projectCount: byCode.size };
}
