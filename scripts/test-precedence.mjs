// Unit tests for lib/precedence.mjs — pure functions, no server/DB needed.
// Covers branches that are awkward to reach over HTTP with fixture data,
// e.g. PROJECT_ATTRIBUTION_CONFLICT and mapping-rule matching edge cases.
import { mergeProjectAttribution, mergeCategoryEvidence, computeDqFlags, attributeProjectFromRules, PROJECT_SOURCE_RANK, CATEGORY_SOURCE_RANK } from '../lib/precedence.mjs';

let failures = 0;
function check(name, cond, detail=''){
  if(cond){ console.log(`PASS - ${name}`); }
  else { failures++; console.log(`FAIL - ${name}${detail?` (${detail})`:''}`); }
}

// --- mergeProjectAttribution ---
{
  const existing = { project_id:42, project_attribution_source:'MANUAL', project_attributed_at:'2026-01-01T00:00:00Z', project_attributed_by:1, project_mapping_rule_id:null, project_status:'ASSIGNED' };
  const incoming = { project_id:null, project_attribution_source:'UNMAPPED', project_attributed_at:null, project_attributed_by:null, project_mapping_rule_id:null, project_status:'MISSING_PROJECT' };
  const r = mergeProjectAttribution(existing, incoming);
  check('lower-rank incoming never downgrades a MANUAL assignment', r.project_id===42 && r.project_status==='ASSIGNED' && r.project_attribution_source==='MANUAL', JSON.stringify(r));
}
{
  const existing = null; // brand-new row
  const incoming = { project_id:null, project_attribution_source:'UNMAPPED', project_attributed_at:null, project_attributed_by:null, project_mapping_rule_id:null, project_status:'MISSING_PROJECT' };
  const r = mergeProjectAttribution(existing, incoming);
  check('new row with UNMAPPED incoming -> MISSING_PROJECT (unchanged default behaviour)', r.project_status==='MISSING_PROJECT' && r.project_id===null, JSON.stringify(r));
}
{
  // Same-tier disagreement: two different projects, both APPROVED_MAPPING_RULE.
  const existing = { project_id:10, project_attribution_source:'APPROVED_MAPPING_RULE', project_attributed_at:null, project_attributed_by:null, project_mapping_rule_id:5, project_status:'ASSIGNED' };
  const incoming = { project_id:20, project_attribution_source:'APPROVED_MAPPING_RULE', project_attributed_at:null, project_attributed_by:null, project_mapping_rule_id:9, project_status:'ASSIGNED' };
  const r = mergeProjectAttribution(existing, incoming);
  check('same-tier disagreement -> PROJECT_ATTRIBUTION_CONFLICT, not silently overwritten', r.project_status==='PROJECT_ATTRIBUTION_CONFLICT', JSON.stringify(r));
  check('conflict retains the existing (not incoming) project_id as evidence', r.project_id===10, JSON.stringify(r));
}
{
  // Higher-rank incoming disagreeing with a lower-rank existing -> incoming wins outright (not a conflict).
  const existing = { project_id:10, project_attribution_source:'PLEO_PROJECT_TAG', project_attributed_at:null, project_attributed_by:null, project_mapping_rule_id:null, project_status:'ASSIGNED' };
  const incoming = { project_id:20, project_attribution_source:'MANUAL', project_attributed_at:'2026-01-01T00:00:00Z', project_attributed_by:2, project_mapping_rule_id:null, project_status:'ASSIGNED' };
  const r = mergeProjectAttribution(existing, incoming);
  check('strictly higher-rank incoming overrides a lower-rank existing value', r.project_id===20 && r.project_status==='ASSIGNED', JSON.stringify(r));
}
{
  // Same tier, same project -> no conflict, just re-confirmed.
  const existing = { project_id:10, project_attribution_source:'MANUAL', project_attributed_at:null, project_attributed_by:null, project_mapping_rule_id:null, project_status:'ASSIGNED' };
  const incoming = { project_id:10, project_attribution_source:'MANUAL', project_attributed_at:null, project_attributed_by:null, project_mapping_rule_id:null, project_status:'ASSIGNED' };
  const r = mergeProjectAttribution(existing, incoming);
  check('same tier + same project -> no false conflict', r.project_status==='ASSIGNED', JSON.stringify(r));
}

// --- attributeProjectFromRules ---
{
  const ctx = {
    rules: [
      { id:1, source_type:'PLEO_TEAM', source_value:'TEAM-UUID-1', project_id:10 },
      { id:2, source_type:'PLEO_TAG', source_value:'GSR-2', project_id:20 },
      { id:3, source_type:'PLEO_TAG', source_value:'Project:Cellnex Pilot', project_id:30 },
      { id:4, source_type:'XLSX_TEAM', source_value:'team-uuid-1', project_id:40 },
    ],
    tagNames: new Map([['tag-a','GSR-2'],['tag-b','Cellnex Pilot']]),
    groupNames: new Map([['grp-1','Project']]),
  };
  let r = attributeProjectFromRules({ team_id:'team-uuid-1', team_name:null, tags:'' }, ctx);
  check('PLEO_TEAM rule matches team_id case-insensitively', r.project_id===10 && r.project_mapping_rule_id===1 && r.project_attribution_source==='APPROVED_MAPPING_RULE' && r.project_status==='ASSIGNED', JSON.stringify(r));
  check('XLSX_TEAM rules are never applied to live rows', r.project_mapping_rule_id!==4);
  r = attributeProjectFromRules({ team_id:null, tags:'grp-1:tag-a' }, ctx);
  check('PLEO_TAG rule matches via synced tag name', r.project_id===20, JSON.stringify(r));
  r = attributeProjectFromRules({ team_id:null, tags:'grp-1:tag-b' }, ctx);
  check('PLEO_TAG rule matches "Group Name:Tag Name"', r.project_id===30, JSON.stringify(r));
  r = attributeProjectFromRules({ team_id:null, tags:'PRJ:GSR-2' }, ctx);
  check('PLEO_TAG rule matches export-style group:code token', r.project_id===20, JSON.stringify(r));
  r = attributeProjectFromRules({ team_id:null, tags:'grp-1:tag-x, GSR-20' }, ctx);
  check('no substring / partial matching', r.project_status==='MISSING_PROJECT' && r.project_attribution_source==='UNMAPPED', JSON.stringify(r));
  r = attributeProjectFromRules({ team_id:'team-uuid-1', tags:'grp-1:tag-a' }, ctx);
  check('two rules naming different projects -> PROJECT_ATTRIBUTION_CONFLICT', r.project_status==='PROJECT_ATTRIBUTION_CONFLICT' && r.project_id===null, JSON.stringify(r));
  const agreeCtx = { ...ctx, rules:[{ id:7, source_type:'PLEO_TAG', source_value:'GSR-2', project_id:20 },{ id:5, source_type:'PLEO_TEAM', source_value:'team-uuid-1', project_id:20 }] };
  r = attributeProjectFromRules({ team_id:'team-uuid-1', tags:'grp-1:tag-a' }, agreeCtx);
  check('rules agreeing on one project -> ASSIGNED, lowest rule id recorded', r.project_status==='ASSIGNED' && r.project_id===20 && r.project_mapping_rule_id===5, JSON.stringify(r));
  r = attributeProjectFromRules({ team_id:'team-uuid-1' }, { rules:[] });
  check('no approved rules -> UNMAPPED', r.project_status==='MISSING_PROJECT', JSON.stringify(r));
}
{
  // Rule attribution never overrides a reviewer's MANUAL choice.
  const existing = { project_id:99, project_attribution_source:'MANUAL', project_attributed_at:'2026-09-01T00:00:00Z', project_attributed_by:3, project_mapping_rule_id:null, project_status:'ASSIGNED' };
  const incoming = { project_id:10, project_attribution_source:'APPROVED_MAPPING_RULE', project_attributed_at:null, project_attributed_by:null, project_mapping_rule_id:1, project_status:'ASSIGNED' };
  const r = mergeProjectAttribution(existing, incoming);
  check('approved rule never overrides MANUAL attribution', r.project_id===99 && r.project_attribution_source==='MANUAL', JSON.stringify(r));
  const c = mergeProjectAttribution(existing, { project_id:null, project_attribution_source:'APPROVED_MAPPING_RULE', project_status:'PROJECT_ATTRIBUTION_CONFLICT' });
  check('rule conflict never overrides MANUAL attribution', c.project_id===99 && c.project_status==='ASSIGNED', JSON.stringify(c));
}
{
  const unmapped = { project_id:null, project_attribution_source:'UNMAPPED', project_attributed_at:null, project_attributed_by:null, project_mapping_rule_id:null, project_status:'MISSING_PROJECT' };
  const r = mergeProjectAttribution(unmapped, { project_id:null, project_attribution_source:'APPROVED_MAPPING_RULE', project_status:'PROJECT_ATTRIBUTION_CONFLICT' });
  check('rule conflict on an unmapped row -> PROJECT_ATTRIBUTION_CONFLICT', r.project_status==='PROJECT_ATTRIBUTION_CONFLICT' && r.project_id===null, JSON.stringify(r));
  const existing = { project_id:10, project_attribution_source:'APPROVED_MAPPING_RULE', project_attributed_at:null, project_attributed_by:null, project_mapping_rule_id:1, project_status:'ASSIGNED' };
  const k = mergeProjectAttribution(existing, { project_id:null, project_attribution_source:'APPROVED_MAPPING_RULE', project_status:'PROJECT_ATTRIBUTION_CONFLICT' });
  check('rule conflict keeps the existing project as evidence', k.project_status==='PROJECT_ATTRIBUTION_CONFLICT' && k.project_id===10 && k.project_mapping_rule_id===1, JSON.stringify(k));
}

// --- mergeCategoryEvidence ---
{
  const existing = { manual_category_name:'Travel' };
  const incoming = { category:'Meals', category_resolution_status:'CATEGORY_RESOLVED' };
  const r = mergeCategoryEvidence(existing, incoming, 'Office');
  check('reviewer-entered category survives later Pleo and mapping evidence', r.resolved_category_name==='Travel' && r.category_resolution_source==='MANUAL_REVIEW', JSON.stringify(r));
}
{
  const existing = { historical_category_name:'Fuel' };
  const incoming = { category:null, category_resolution_status:'ACCOUNT_ID_NOT_IN_REFERENCE_DATA' };
  const r = mergeCategoryEvidence(existing, incoming);
  check('unresolved live category falls back to historical evidence', r.resolved_category_name==='Fuel' && r.category_resolution_source==='VERIFIED_HISTORICAL_EXPORT_CATEGORY', JSON.stringify(r));
}
{
  const existing = { historical_category_name:'Old Label' };
  const incoming = { category:'Travel', category_resolution_status:'CATEGORY_RESOLVED' };
  const r = mergeCategoryEvidence(existing, incoming);
  check('a live-resolved category wins over historical evidence', r.resolved_category_name==='Travel' && r.category_resolution_source==='PLEO_RESOLVED_ACCOUNT', JSON.stringify(r));
}
{
  const existing = null;
  const incoming = { category:null, category_resolution_status:'MISSING_ACCOUNT_ID' };
  const r = mergeCategoryEvidence(existing, incoming);
  check('no evidence anywhere -> MISSING, not a fabricated value', r.resolved_category_name===null && r.category_resolution_source==='MISSING', JSON.stringify(r));
}

{
  const incoming = { category:null, category_resolution_status:'ACCOUNT_ID_NOT_IN_REFERENCE_DATA' };
  let r = mergeCategoryEvidence(null, incoming, 'Fuel (Gas)');
  check('account mapping names an unresolved account', r.resolved_category_name==='Fuel (Gas)' && r.category_resolution_source==='APPROVED_MANUAL_MAPPING', JSON.stringify(r));
  r = mergeCategoryEvidence({ historical_category_name:'Parking' }, incoming, 'Fuel (Gas)');
  check('per-row historical evidence outranks the account mapping', r.resolved_category_name==='Parking', JSON.stringify(r));
  r = mergeCategoryEvidence(null, { category:'Travel', category_resolution_status:'CATEGORY_RESOLVED' }, 'Fuel (Gas)');
  check('live Pleo resolution outranks the account mapping', r.resolved_category_name==='Travel', JSON.stringify(r));
}

// --- computeDqFlags ---
{
  const dq = computeDqFlags({ hasResolvedCategory:false, classification_status:'MISSING_CLASSIFICATION', project_status:'MISSING_PROJECT', receipt_count:0, employeeUnknown:true });
  check('all-missing input -> all six flags set correctly', dq.dq_missing_project===1 && dq.dq_missing_classification===1 && dq.dq_unresolved_category===1 && dq.dq_missing_receipt===1 && dq.dq_unknown_employee===1, JSON.stringify(dq));
}
{
  const dq = computeDqFlags({ hasResolvedCategory:true, classification_status:'CLASSIFIED', project_status:'ASSIGNED', receipt_count:2, employeeUnknown:false });
  check('all-resolved input -> all six flags clear', dq.dq_missing_project===0 && dq.dq_missing_classification===0 && dq.dq_unresolved_category===0 && dq.dq_missing_receipt===0 && dq.dq_unknown_employee===0, JSON.stringify(dq));
}
{
  const dq = computeDqFlags({ hasResolvedCategory:true, classification_status:'CLASSIFIED', project_status:'PROJECT_ATTRIBUTION_CONFLICT', receipt_count:1, employeeUnknown:false });
  check('PROJECT_ATTRIBUTION_CONFLICT is not treated as MISSING_PROJECT', dq.dq_missing_project===0, JSON.stringify(dq));
}

// --- rank tables sanity ---
check('project rank tables: MANUAL is the highest tier', PROJECT_SOURCE_RANK.MANUAL > PROJECT_SOURCE_RANK.APPROVED_MAPPING_RULE && PROJECT_SOURCE_RANK.APPROVED_MAPPING_RULE > PROJECT_SOURCE_RANK.PLEO_PROJECT_TAG && PROJECT_SOURCE_RANK.PLEO_PROJECT_TAG > PROJECT_SOURCE_RANK.VERIFIED_HISTORICAL && PROJECT_SOURCE_RANK.VERIFIED_HISTORICAL > PROJECT_SOURCE_RANK.UNMAPPED);
check('category rank tables: MANUAL_REVIEW is the highest tier', CATEGORY_SOURCE_RANK.MANUAL_REVIEW > CATEGORY_SOURCE_RANK.PLEO_RESOLVED_ACCOUNT && CATEGORY_SOURCE_RANK.PLEO_RESOLVED_ACCOUNT > CATEGORY_SOURCE_RANK.VERIFIED_HISTORICAL_EXPORT_CATEGORY && CATEGORY_SOURCE_RANK.VERIFIED_HISTORICAL_EXPORT_CATEGORY > CATEGORY_SOURCE_RANK.APPROVED_MANUAL_MAPPING && CATEGORY_SOURCE_RANK.APPROVED_MANUAL_MAPPING > CATEGORY_SOURCE_RANK.UNRESOLVED_ACCOUNT && CATEGORY_SOURCE_RANK.UNRESOLVED_ACCOUNT > CATEGORY_SOURCE_RANK.MISSING);

console.log(failures===0 ? `\nAll precedence unit tests passed.` : `\n${failures} precedence unit test(s) failed.`);
process.exit(failures===0 ? 0 : 1);
