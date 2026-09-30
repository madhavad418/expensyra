// Attribution & resolution precedence — see docs/ARCHITECTURE.md
// "Attribution & Resolution Precedence" for the documented model.
//
// Pulled out of server.js as pure, side-effect-free functions (no DB access,
// no Pleo calls) specifically so they can be unit-tested directly, including
// branches — like a same-tier attribution conflict — that are hard to set up
// through the HTTP API with fixture data.

export const PROJECT_SOURCE_RANK = {
  MANUAL: 4,
  APPROVED_MAPPING_RULE: 3,
  PLEO_PROJECT_TAG: 2,
  VERIFIED_HISTORICAL: 1,
  UNMAPPED: 0,
};

export const CATEGORY_SOURCE_RANK = {
  MANUAL_REVIEW: 5,
  PLEO_RESOLVED_ACCOUNT: 4,
  VERIFIED_HISTORICAL_EXPORT_CATEGORY: 3,
  APPROVED_MANUAL_MAPPING: 2,
  UNRESOLVED_ACCOUNT: 1,
  MISSING: 0,
};

// A later Pleo sync may only ever *add* project evidence at a rank >= what's
// already stored on the row — it can never downgrade a higher-confidence
// attribution back to UNMAPPED. A strictly-higher-rank source may override a
// lower-rank one outright (that's what the precedence order is for). Only a
// SAME-tier source naming a *different* project than what's already verified
// is ambiguous — there's no principled way to pick a winner between two
// equally-confident sources — so that's recorded as
// PROJECT_ATTRIBUTION_CONFLICT rather than silently picking one.
export function mergeProjectAttribution(existingRow, incoming) {
  const existingSource = existingRow?.project_attribution_source || 'UNMAPPED';
  const incomingSource = incoming.project_attribution_source || 'UNMAPPED';
  const existingRank = PROJECT_SOURCE_RANK[existingSource] ?? 0;
  const incomingRank = PROJECT_SOURCE_RANK[incomingSource] ?? 0;

  if (existingRow && incomingRank < existingRank) {
    return {
      project_id: existingRow.project_id,
      project_attribution_source: existingRow.project_attribution_source,
      project_attributed_at: existingRow.project_attributed_at,
      project_attributed_by: existingRow.project_attributed_by,
      project_mapping_rule_id: existingRow.project_mapping_rule_id,
      project_status: existingRow.project_status,
    };
  }

  // Incoming evidence is itself ambiguous (e.g. two approved mapping rules
  // naming different projects for one transaction). Keep whatever project
  // the row already carries as evidence, but flag the row rather than guess.
  if (incoming.project_status === 'PROJECT_ATTRIBUTION_CONFLICT') {
    const keep = existingRow?.project_id != null ? existingRow : incoming;
    return {
      project_id: keep.project_id ?? null,
      project_attribution_source: keep.project_attribution_source,
      project_attributed_at: keep.project_attributed_at ?? null,
      project_attributed_by: keep.project_attributed_by ?? null,
      project_mapping_rule_id: keep.project_mapping_rule_id ?? null,
      project_status: 'PROJECT_ATTRIBUTION_CONFLICT',
    };
  }

  const sameTierDisagreement = existingRow && existingRank > 0 && incomingRank === existingRank
    && existingRow.project_id != null && incoming.project_id != null;
  if (sameTierDisagreement && existingRow.project_id !== incoming.project_id) {
    return {
      project_id: existingRow.project_id,
      project_attribution_source: existingRow.project_attribution_source,
      project_attributed_at: existingRow.project_attributed_at,
      project_attributed_by: existingRow.project_attributed_by,
      project_mapping_rule_id: existingRow.project_mapping_rule_id,
      project_status: 'PROJECT_ATTRIBUTION_CONFLICT',
    };
  }

  return {
    project_id: incoming.project_id,
    project_attribution_source: incoming.project_attribution_source,
    project_attributed_at: incoming.project_attributed_at,
    project_attributed_by: incoming.project_attributed_by,
    project_mapping_rule_id: incoming.project_mapping_rule_id,
    project_status: incomingRank > 0 ? 'ASSIGNED' : 'MISSING_PROJECT',
  };
}

// Evaluates APPROVED project_mapping_rules against one transaction's stored
// Pleo evidence and returns an "incoming" attribution for
// mergeProjectAttribution(). Only source types with real data behind them
// are matched:
//   PLEO_TEAM — team_id, or team_name when present (live accounting-entry
//               rows carry team_id only).
//   PLEO_TAG  — any tag on the row, by raw "group:tag" token, tag id/code,
//               tag name, or "Group Name:Tag Name".
// XLSX_TEAM/OTHER have no ingested field to match yet and never fire.
// Matching is case-insensitive and exact (no substring guessing). Several
// rules agreeing on one project is fine; rules naming different projects is
// PROJECT_ATTRIBUTION_CONFLICT.
// ctx: { rules:[{id,source_type,source_value,project_id}], tagNames:Map(tagId→name), groupNames:Map(groupId→name) }
export function attributeProjectFromRules(tx, ctx) {
  const unmapped = { project_id:null, project_attribution_source:'UNMAPPED', project_attributed_at:null, project_attributed_by:null, project_mapping_rule_id:null, project_status:'MISSING_PROJECT' };
  if (!ctx?.rules?.length) return unmapped;
  const norm = v => String(v ?? '').trim().toLowerCase();

  const teamKeys = new Set([tx.team_id, tx.team_name].map(norm).filter(Boolean));
  const tagKeys = new Set();
  for (const token of String(tx.tags || '').split(',').map(s => s.trim()).filter(Boolean)) {
    tagKeys.add(norm(token));
    const i = token.indexOf(':');
    const groupPart = i >= 0 ? token.slice(0, i) : '';
    const tagPart = i >= 0 ? token.slice(i + 1) : token;
    tagKeys.add(norm(tagPart));
    const tagName = ctx.tagNames?.get(tagPart);
    if (tagName) {
      tagKeys.add(norm(tagName));
      const groupName = ctx.groupNames?.get(groupPart);
      if (groupName) tagKeys.add(norm(`${groupName}:${tagName}`));
    }
  }

  const hits = ctx.rules.filter(r => {
    const value = norm(r.source_value);
    if (!value) return false;
    if (r.source_type === 'PLEO_TEAM') return teamKeys.has(value);
    if (r.source_type === 'PLEO_TAG') return tagKeys.has(value);
    return false;
  });
  if (!hits.length) return unmapped;

  const projectIds = new Set(hits.map(r => r.project_id));
  if (projectIds.size > 1) {
    return { project_id:null, project_attribution_source:'APPROVED_MAPPING_RULE', project_attributed_at:null, project_attributed_by:null, project_mapping_rule_id:null, project_status:'PROJECT_ATTRIBUTION_CONFLICT' };
  }
  // Deterministic: lowest rule id wins when several rules agree.
  const rule = hits.reduce((a, b) => (a.id <= b.id ? a : b));
  return { project_id:rule.project_id, project_attribution_source:'APPROVED_MAPPING_RULE', project_attributed_at:null, project_attributed_by:null, project_mapping_rule_id:rule.id, project_status:'ASSIGNED' };
}

// `incoming.category`/`incoming.category_resolution_status` reflect ONLY the
// current live Pleo/Chart-of-Accounts resolution and are always legitimate
// to refresh. `existingRow.historical_category_name` is a separate,
// ingestion-immune column (never written by this merge) — it is the fallback
// evidence when live resolution can't or no longer can name the category.
// `mappedCategoryName` is the account-level mapping (account_category_mappings,
// learned from a Pleo expense export) for incoming.pleo_account_id — it names
// every month's rows for that account, but ranks below per-row evidence.
export function mergeCategoryEvidence(existingRow, incoming, mappedCategoryName = null) {
  const manualCategoryName = existingRow?.manual_category_name || null;
  if (manualCategoryName) {
    return { resolved_category_name: manualCategoryName, category_resolution_source: 'MANUAL_REVIEW' };
  }
  const historicalCategoryName = existingRow?.historical_category_name || null;
  if (incoming.category_resolution_status === 'CATEGORY_RESOLVED' && incoming.category) {
    return { resolved_category_name: incoming.category, category_resolution_source: 'PLEO_RESOLVED_ACCOUNT' };
  }
  if (historicalCategoryName) {
    return { resolved_category_name: historicalCategoryName, category_resolution_source: 'VERIFIED_HISTORICAL_EXPORT_CATEGORY' };
  }
  if (mappedCategoryName) {
    return { resolved_category_name: mappedCategoryName, category_resolution_source: 'APPROVED_MANUAL_MAPPING' };
  }
  if (incoming.category_resolution_status === 'ACCOUNT_ID_NOT_IN_REFERENCE_DATA' || incoming.category_resolution_status === 'CATEGORY_MAPPING_PENDING') {
    return { resolved_category_name: null, category_resolution_source: 'UNRESOLVED_ACCOUNT' };
  }
  return { resolved_category_name: null, category_resolution_source: 'MISSING' };
}

// Single authority for the six dq_* flags. Takes already-resolved canonical
// state (post-merge project_status, whether a category actually resolved
// from any source, classification_status, receipt_count, employee lookup) —
// never re-derives it from a sync source alone, so a flag always reflects
// what's actually stored on the row.
export function computeDqFlags({ hasResolvedCategory, classification_status, project_status, receipt_count, employeeUnknown }) {
  return {
    dq_missing_project: project_status === 'MISSING_PROJECT' ? 1 : 0,
    dq_missing_classification: classification_status === 'MISSING_CLASSIFICATION' ? 1 : 0,
    dq_unresolved_category: hasResolvedCategory ? 0 : 1,
    dq_missing_receipt: receipt_count > 0 ? 0 : 1,
    dq_unmapped_historical_project: 0,
    dq_unknown_employee: employeeUnknown ? 1 : 0,
  };
}
