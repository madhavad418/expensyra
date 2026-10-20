import assert from 'node:assert/strict';
import { planProjectImport, PROJECT_IMPORT_COLUMNS } from '../lib/project-import.mjs';
import { exportSheets } from '../lib/xlsx-export.mjs';
import { readSheet } from '../lib/xlsx.mjs';

const H = PROJECT_IMPORT_COLUMNS.map(c => c[1]);
const row = o => PROJECT_IMPORT_COLUMNS.map(([f]) => o[f] ?? null);
const T1 = '11111111-1111-4111-8111-111111111111', T2 = '22222222-2222-4222-8222-222222222222', T3 = '33333333-3333-4333-8333-333333333333';
const ctx = () => ({
  projects: [{ id: 1, code: 'PRJ-001', name: 'Old name', customer: 'Acme', status: 'ACTIVE', project_manager: null, country: null, start_date: null, end_date: null, commercial_model: null }],
  teams: [{ team_id: T1, team_name: 'PRJ-001-Acme' }, { team_id: T2, team_name: 'Twin' }, { team_id: T3, team_name: 'twin' }, { team_id: '44444444-4444-4444-8444-444444444444', team_name: 'Linked elsewhere' }],
  rules: [{ id: 9, source_type: 'PLEO_TEAM', source_value: '44444444-4444-4444-8444-444444444444', project_code: 'PRJ-OTHER', status: 'APPROVED' }],
});

// Header check
assert.throws(() => planProjectImport([['Name']], ctx()), /Project code/);

// Create, update (only filled cells), link by name / id, example + blank rows skipped
let p = planProjectImport([H,
  row({ code: 'prj-001', name: 'New name', customer: '', status: 'On hold', pleo_team: 'prj-001-acme' }),
  row({ code: 'PRJ-002', name: 'Second', start_date: 46037, end_date: '2026-12-31', pleo_team: T2 }),  // 46037 = Excel serial for 2026-01-15
  row({ code: 'PRJ-002', pleo_tag: 'Project:Two; Project:Two-b' }),
  row({ code: 'EXAMPLE-001', name: 'ignored', pleo_team: 'nope' }),
  row({}),
], ctx());
assert.deepEqual(p.errors, []);
assert.equal(p.examples, 1); assert.equal(p.blank, 1); assert.equal(p.projectCount, 2);
assert.deepEqual(p.projects.update, [{ id: 1, code: 'PRJ-001', changes: { name: 'New name', status: 'ON_HOLD' }, before: { name: 'Old name', status: 'ACTIVE' } }], 'blank customer keeps Acme; code is case-insensitive');
assert.equal(p.projects.create[0].code, 'PRJ-002'); assert.equal(p.projects.create[0].status, 'ACTIVE', 'default status');
assert.equal(p.projects.create[0].start_date, '2026-01-15', 'Excel serial date'); assert.equal(p.projects.create[0].end_date, '2026-12-31');
assert.deepEqual(p.links.create.map(l => [l.code, l.source_type, l.source_value]), [['PRJ-001', 'PLEO_TEAM', T1], ['PRJ-002', 'PLEO_TEAM', T2], ['PRJ-002', 'PLEO_TAG', 'Project:Two'], ['PRJ-002', 'PLEO_TAG', 'Project:Two-b']]);
console.log('PASS: create / partial update / team by name & id / tags / example + blank rows / Excel dates');

// Errors block the import
p = planProjectImport([H,
  row({ code: 'NEW-1' }),                                             // new project without a name
  row({ code: 'NEW-2', name: 'x', status: 'Paused' }),                // bad status
  row({ code: 'NEW-3', name: 'x', start_date: '2026-13-40' }),        // bad date
  row({ code: 'NEW-4', name: 'x', start_date: '2026-05-01', end_date: '2026-04-01' }), // end before start
  row({ code: 'NEW-5', name: 'A' }), row({ code: 'NEW-5', name: 'B' }), // conflicting names
  row({ code: 'NEW-6', name: 'x', pleo_team: 'Unknown team' }),       // unknown team
  row({ code: 'NEW-7', name: 'x', pleo_team: 'Twin' }),               // ambiguous team name
  row({ code: 'NEW-8', name: 'x', pleo_team: T1 }), row({ code: 'NEW-9', name: 'y', pleo_team: 'PRJ-001-Acme' }), // one team, two projects
  row({ name: 'no code' }),
], ctx());
const msgs = p.errors.map(e => e.message).join(' | ');
for (const m of ['Project name is required', 'must be Active, On hold or Closed', 'not a real date', 'End date is before', 'different name', 'Unknown Pleo team', 'use the team ID', 'one Pleo team or tag can belong to one project', 'Project code is empty']) assert.match(msgs, new RegExp(m), m);
console.log('PASS: missing name, bad status/date, end before start, conflicting rows, unknown/ambiguous/duplicate teams, empty code');

// Existing links: never re-pointed; waiting ones get approved; unknown UUID allowed with a warning
const c2 = ctx(); c2.rules.push({ id: 10, source_type: 'PLEO_TEAM', source_value: T1, project_code: 'PRJ-001', status: 'PROPOSED' });
p = planProjectImport([H,
  row({ code: 'PRJ-001', pleo_team: `PRJ-001-Acme; Linked elsewhere` }),
  row({ code: 'PRJ-001', pleo_team: '55555555-5555-4555-8555-555555555555' }),
], c2);
assert.deepEqual(p.errors, []);
assert.deepEqual(p.links.approve.map(l => l.id), [10]);
assert.deepEqual(p.links.conflict, [{ code: 'PRJ-001', label: 'Linked elsewhere', current: 'PRJ-OTHER' }]);
assert.equal(p.links.create.length, 1); assert.equal(p.warnings.length, 1);
assert.equal(p.projects.unchanged, 1);
console.log('PASS: approve waiting link, conflict reported (not moved), unseen team id linked with warning');

// Round trip through a real .xlsx with a "Projects" sheet
const file = exportSheets([{ name: 'Projects', rows: [{ code: 'PRJ-003', name: 'Round trip', pleo_team: 'PRJ-001-Acme' }], columns: PROJECT_IMPORT_COLUMNS.map(([f, h]) => [h, f]) }, { name: 'Instructions', rows: [], columns: [['x', 'x']] }]);
p = planProjectImport(readSheet(file, 'Projects').rows, ctx());
assert.deepEqual(p.errors, []); assert.equal(p.projects.create[0].name, 'Round trip'); assert.equal(p.links.create[0].source_value, T1);
console.log('PASS: .xlsx round trip');
console.log('\nAll project import tests passed.');
