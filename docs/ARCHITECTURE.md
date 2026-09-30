# Architecture

## Components

### Browser SPA

A responsive JSAN-styled single-page web interface served by the same Node service. It never receives the Pleo API key.

### Node API

Uses Node built-ins only. Responsibilities:

- local authentication/session cookies;
- role authorisation;
- Pleo server-to-server API calls;
- sync/de-duplication;
- receipt proxy/cache;
- allocation/review workflow;
- validation-session heartbeat/time calculation;
- team metrics;
- static UI serving.

### SQLite

The Phase-1 persistent store uses Node's built-in SQLite interface and WAL mode.

## Core data separation

```text
PLEO SOURCE                     JSAN WORKFLOW
───────────                     ─────────────
pleo_raw_entries ───────┐
                        ├──> transactions ───> allocation
pleo_attachments ───────┘          │
                                   ├──> work_sessions
                                   ├──> reviews
                                   └──> audit_log

projects ──────────────────────────> commercial/project classification
pleo_sync_runs ────────────────────> sync observability
```

Source refreshes update Pleo-origin fields on `transactions`, but do not overwrite reviewer/allocation/decision/commercial fields.

## Roles

### ADMIN

- all management screens;
- Pleo test/sync;
- users/projects;
- allocate;
- review if operationally required.

### TEAM_LEAD

- Pleo test/sync;
- create reviewer accounts;
- create project masters;
- allocate transactions;
- team performance.

### REVIEWER

- sees only assigned transactions;
- starts/pauses validation;
- views available evidence;
- records decision/classification/project/notes.

### FINANCE_QC

- read management/team views;
- can review transaction detail and record validation decisions for QC/escalation;
- cannot create users or trigger ordinary team allocation.

## Validation timer

```text
Start Validation
      ↓
work_session opened
      ↓
heartbeat every 30 sec
      ↓
Pause / Decision / stale heartbeat
      ↓
work_session closed with measured seconds
      ↓
Review action stores attributable review_seconds
```

Opening a transaction does not count as productive time.

## Sync safety

`pleo_accounting_entry_id` is unique. A repeated Pleo sync refreshes existing source values instead of inserting duplicates. Each source payload is also stored in `pleo_raw_entries` so integration troubleshooting can compare normalised data with Pleo's returned object.

## Attribution & Resolution Precedence

Project attribution and category resolution each separate **source evidence**
(what Pleo/a historical export/an admin most recently said) from the
**precedence-resolved value** actually used — a later sync can add evidence
at a given confidence tier, but can never silently downgrade a higher-tier
value that's already stored. The merge logic lives in `lib/precedence.mjs`
(pure functions, unit-tested in `scripts/test-precedence.mjs`) and is applied
in `upsertTransaction()` on every ingested row, and in `recomputeDerivedFieldsFromRaw()`'s
category re-derivation.

**Project** (`project_attribution_source` rank, high → low):

1. `MANUAL` — the project a reviewer selects when recording a review decision. Applied directly (a re-review replaces the reviewer's earlier choice); no sync or rule can override it.
2. `APPROVED_MAPPING_RULE` — an approved row in `project_mapping_rules`, matched by `attributeProjectFromRules()` in `lib/precedence.mjs`: `PLEO_TEAM` matches `team_id` or team name, and `PLEO_TAG` matches a tag's id, code, name or `Group:Tag`. Matching is exact and case-insensitive. `XLSX_TEAM`/`OTHER` never match yet. Rules are evaluated on every ingested row, backfilled over all stored transactions when a rule is approved, and re-run after reference-data sync. Two matching rules that name different projects produce `PROJECT_ATTRIBUTION_CONFLICT`.
3. `PLEO_PROJECT_TAG` — a live, active Pleo Project tag group (none exists on this tenant today).
4. `VERIFIED_HISTORICAL` — carried over from a verified historical import.
5. `UNMAPPED` — nothing has ever named a project (`project_status='MISSING_PROJECT'`).

A same-or-lower-rank incoming source is discarded, never applied over a
higher-rank existing value. A **same-tier** source naming a *different*
project than what's already stored is ambiguous — there's no principled way
to pick a winner between two equally-confident sources — so `project_status`
becomes `PROJECT_ATTRIBUTION_CONFLICT` and both pieces of evidence are kept
rather than one overwriting the other. A strictly higher-rank source may
override a lower-rank one outright; that's what the ranking is for.

**Category** (`category_resolution_source` rank, high → low):

1. `PLEO_RESOLVED_ACCOUNT` — `accountId` resolves against the currently-synced `pleo_categories` (Chart of Accounts).
2. `VERIFIED_HISTORICAL_EXPORT_CATEGORY` — `historical_category_name`, a column ingestion never writes to.
3. `APPROVED_MANUAL_MAPPING` — an admin-entered category override.
4. `UNRESOLVED_ACCOUNT` — an `accountId` exists but isn't in the reference data (or the reference data is incomplete).
5. `MISSING` — no `accountId` at all.

`category`/`category_resolution_status` always reflect the *current live*
Pleo/Chart-of-Accounts resolution and are legitimately overwritten on every
sync — they are diagnostic, not the display value. `resolved_category_name`
is the precedence-resolved value: live-resolved wins when available, else it
falls back to `historical_category_name`, else `null`. This means a
reference-data regression (e.g. an incomplete Chart-of-Accounts sync) can
never blank out an already-known category — it can only add a live
resolution on top of, or alongside, whatever's already there.

**Quality flags** (`dq_missing_project`, `dq_missing_classification`,
`dq_unresolved_category`, `dq_missing_receipt`, `dq_unmapped_historical_project`,
`dq_unknown_employee`) are derived, never authoritative on their own —
`computeDqFlags()` in `lib/precedence.mjs` is the single place that computes
them, always from a transaction's current canonical stored state (post-merge
project/category/classification), never from a sync source in isolation.
`recalculateTransactionQuality(transactionId)` rebuilds one row;
`recalculateAllTransactionQuality()` (also `POST /api/admin/recalculate-quality-flags`)
rebuilds the whole table in one SQL statement — this is the mechanism for
correcting flags that went stale before a column/rule existed, which is
exactly what happened live: `dq_missing_project` was found stuck at `0` for
every row despite `project_status='MISSING_PROJECT'` on all of them, because
nothing had ever backfilled it after the column was added.

## Expense Intelligence & Review Operations analytics

`GET /api/analytics/expense` and `GET /api/analytics/reviewers` (+ `/api/analytics/reviewers/:id` detail) are read-only aggregation endpoints over the existing `transactions`/`reviews`/`work_sessions` tables — no schema changes. Gated to `ADMIN`/`TEAM_LEAD`/`FINANCE_QC`, matching `/api/team`.

Shared filters: `month=YYYY-MM` (expands to first/last day of month, e.g. for an August 2026 baseline) or explicit `dateFrom`/`dateTo`, plus `project`, `category`, `currency`, `commercial_classification`, `status`, `reviewer_id`, `merchant`, `receipt_status`. The same dimension names are accepted by `GET /api/transactions` so dashboard drill-down (click a category/project/reviewer row) lands on a correspondingly-filtered transaction list; `/api/transactions` now also returns `total`/`limit`/`offset` for real pagination (previously capped at 500 rows with no way to page further).

**Multi-currency**: every money figure is returned as an array of `{currency, amount, count}` grouped per currency — amounts in different currencies are never summed into one total, since no FX conversion model exists in this codebase.

**Active validation time vs. Elapsed TAT**: `active_seconds` (reviewer-ops) comes only from recorded `work_sessions` (heartbeat-verified start/pause). `elapsed_tat_avg_seconds` is the wall-clock gap between `allocated_at` and `completed_at`. These are always separate fields, never combined, and the UI labels them accordingly.

**Known scale limitation**: median-transaction and the `app_kv`-based patterns elsewhere in this codebase load matching rows into application memory rather than using an indexed SQL aggregate (SQLite has no `MEDIAN`). This is correct and fine at current data volumes; it would need revisiting before hundreds of thousands of transactions.

`GET /api/analytics/expense/monthly` returns flat `{month, category, currency, count, amount}` rows (no date filter — spans everything imported) for a category-by-month pivot view, rendered client-side as one table per currency. See [PLEO_SETUP.md §6a](PLEO_SETUP.md) for the historical backfill mechanism (`POST /api/pleo/backfill`) that populates months beyond what live sync ever sees.

## Phase 2 extension points

Phase 2 can add, without replacing this workflow:

- operational project/country/vehicle mapping;
- UKM achieved / QA approved / customer approved;
- pricing rules and rate bands;
- earned revenue;
- invoiced revenue;
- direct and shared project costs;
- project contribution/margin and exception alerts.
