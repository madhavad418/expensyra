# Pleo API Setup for JSAN Expensyra

## 1. Connector used by default

The package defaults to:

```env
PLEO_SYNC_MODE=export_v2
PLEO_API_BASE=https://external.pleo.io
```

This follows the Pleo Support note supplied by JSAN recommending Export V2 unless multi-currency requirements justify V3.

The Export V2 flow used by Expensyra is:

```text
GET /v2/export-jobs
        ↓
filter pending / in_progress
        ↓
GET /v2/export-items?job_id=<job UUID>
        ↓
normalise + de-duplicate by accountingEntryId
        ↓
cache/reference files[] receipts
        ↓
JSAN Unallocated Queue
```

Export items can only be retrieved from pending/in-progress jobs. Therefore this connector imports entries that have been selected/queued for export in Pleo; it does not claim to be an all-expenses endpoint.

## 2. Create the key in Pleo

Use the **new Pleo External API / Standalone API Key** capability enabled for JSAN by Pleo Support.

When creating the key:

- Use the production environment only when you are ready for live Pleo data.
- Grant only the read scopes required by the APIs being used.
- For `export_v2`, include the read permissions Pleo shows for Export Jobs/Export Items.
- If switching to `accounting_entries_v1`, also grant the read permissions Pleo requires for Accounting Entries, receipts and Employees.
- Record the company UUID separately.
- Do not store the key in the frontend or source repository.

Pleo's new External API is company-scoped, so the correct `company_id` must be supplied.

## 3. Configure deployment secrets

Set these in Railway/Docker/your secret manager:

```env
PLEO_API_BASE=https://external.pleo.io
PLEO_API_KEY=<secret>
PLEO_COMPANY_ID=<company UUID>
PLEO_SYNC_MODE=export_v2
PLEO_AUTO_SYNC=true
PLEO_SYNC_ON_START=true
PLEO_SYNC_INTERVAL_MINUTES=15
```

The server uses Standalone API Key Basic HTTP authentication with the API key as username and an empty password. The credential is generated into the outbound `Authorization` header only on the server.

## 4. Test safely

After deployment:

1. Sign in as `ADMIN` or `TEAM_LEAD`.
2. Open **Pleo Sync**.
3. Confirm company ID is masked and the API key itself is never displayed.
4. Select **Test connection**.
5. If successful, select **Sync now**.
6. Confirm the sync history records items seen/inserted/refreshed.
7. Open several imported transactions and validate the expected merchant, date, employee, amount/currency, category/tags and receipts against Pleo.
8. Only then enable/retain scheduled sync.

## 5. If Sync Now returns 0 items

For `export_v2`, first check whether Pleo currently has `pending` or `in_progress` Export Jobs containing entries. A successful API connection with zero export items is not automatically an integration failure.

If JSAN's requirement is instead "bring every accounting entry into Expensyra irrespective of export queue", test the alternate connector:

```env
PLEO_SYNC_MODE=accounting_entries_v1
PLEO_INITIAL_LOOKBACK_DAYS=90
```

Restart/redeploy after changing connector mode.

## 6. Accounting Entries alternate mode

The alternate flow is:

```text
GET /v2/employees
        ↓
POST /v1/accounting-entries:search
        ↓
retrieve receipt references/files
        ↓
incremental cursor with 15-minute overlap
        ↓
JSAN transaction queue
```

The overlap intentionally re-reads a small period. De-duplication by Accounting Entry ID prevents duplicates while allowing changed source metadata to refresh.

## 5a. Ingestion vs. evidence enrichment (two independent stages)

Transaction ingestion (Stage A: paginate Accounting Entries, normalize, upsert) and receipt/evidence enrichment (Stage B: fetch each receipt file) are fully decoupled. Stage A only ever creates rows in a durable `receipt_jobs` queue — it never makes a receipt HTTP call itself, so a receipt failure can never fail the financial sync. A background worker (`PLEO_RECEIPT_CONCURRENCY` parallel workers, default 4) drains that queue independently, with bounded retry (`PLEO_RECEIPT_MAX_ATTEMPTS`, default 5, exponential backoff + jitter, honours `Retry-After`). Already-`AVAILABLE` receipts are never refetched on a later sync.

`POST /api/pleo/sync` and `POST /api/pleo/backfill` both return `{runId}` immediately — the server owns the job, closing the browser does not cancel it. Poll `GET /api/pleo/sync-runs/:runId` for live progress (`run` = ingestion status/counts, `evidence` = `{available, pending, fetching, retrying, failed}` for that run's receipts). This is why `pleo_sync_runs.status` (`SUCCESS`/`FAILED`/`INTERRUPTED`) reflects transaction ingestion only — receipt outcomes are a separate, independently-reported dimension, never rolled into that status.

Live sync uses a time-based high-watermark, not Pleo cursor persistence across process restarts (`after`/`endCursor` reuse across independent sessions isn't documented as safe, so this deliberately doesn't rely on it). The watermark (`pleo_accounting_entries_last_success`, a KV entry) is updated after every successfully-committed page, not just at the end — a crash on page 6 resumes near page 5's watermark (with a 15-minute overlap) rather than re-reading the full `PLEO_INITIAL_LOOKBACK_DAYS` window from scratch.

## 6a. Historical backfill (e.g. "what happened in August")

`POST /api/pleo/backfill` (Admin/Team Lead, from the Pleo Sync screen's "Historical backfill" panel) is a **separate, explicit, one-off action** from the live sync above. It always uses the Accounting Entries API (v1) with an explicit `dateFrom`/`dateTo` range, regardless of which `PLEO_SYNC_MODE` is configured for live sync — Export V2 only ever exposes entries currently queued for export, so it cannot answer questions about a past month. Running backfill never changes your live `PLEO_SYNC_MODE`.

It is idempotent (same `pleo_accounting_entry_id` de-duplication as live sync — re-running the same range updates existing rows rather than duplicating them) and records a normal `pleo_sync_runs` row with `trigger_type='historical_backfill'` for audit visibility.

**Status as of this build**: not yet run against a real JSAN Pleo account. The connector code path is tested end-to-end against a clearly-labelled synthetic fixture (`sample/pleo-v2-fixture.json`'s `accountingEntries` array, spanning July–September 2026 demo records only — never real JSAN financial data). Real historical import is blocked on the same `/v2/export-jobs` connectivity issue documented for live sync; `accounting_entries_v1` hits a different endpoint and has not been verified against the real account yet. Once Pleo Support resolves connectivity (or if `accounting_entries_v1` turns out to work even while `export_v2` doesn't), this same code path pulls real data with no changes needed.

## 7. Receipt validation

Expensyra stores attachment metadata. When `PLEO_CACHE_ATTACHMENTS=true`, the backend attempts to cache receipt files under `ATTACHMENT_DIR` so expiring source URLs do not interrupt validation.

For the first live tenant test, explicitly verify at least:

- PDF receipts;
- image receipts;
- a transaction with no receipt;
- multiple files/receipts;
- an older transaction whose receipt link may have expired.

## 6b. Category/tag reference data (Chart of Accounts, Tag Groups, Tags)

Real Pleo accounting entries do not populate `splitItems[].accountCode` (observed empty on 100% of a 20-record real sample) — the category-bearing field is `accountId`, which only resolves against Pleo's own Chart of Accounts, not against the entry payload itself. Likewise, `tags[].tagGroupId`/`tagId` only become human-readable (and only become known to be "the Project dimension" as opposed to Department/Location/Cost Centre) once the corresponding Tag Groups/Tags are synced.

`POST /api/pleo/sync-reference-data` (Admin/Team Lead) fetches:
- `GET /v0/tag-groups` then `GET /v0/tag-groups/{id}/tags` for each group → `pleo_tag_groups` / `pleo_tags`
- `POST /v1/chart-of-accounts:search` → `pleo_categories`

and then retroactively resolves `category`/`pleo_category_id` on every already-ingested `accounting_entries_v1` transaction from its stored raw payload (no re-sync needed). Category resolution during normal ingestion reads only this local reference table — it never calls Pleo inline mid-sync.

`GET /api/pleo/reference-data-report` (Admin/Team Lead) returns every synced tag group with its tag count/samples, category count/samples, and real-transaction category/tag coverage — the evidence needed to identify which Tag Group (if any) represents "Project" before building the Project Master/admin mapping screen. **Do not guess which Tag Group is Project** — pick it from this report's real output.

## 8. What Expensyra does not write back to Pleo in Phase 1

JSAN allocation, validation status, project classification and customer/internal classification remain in Expensyra. The app does not mark Pleo expenses approved/rejected through the Pleo API. This keeps Phase 1 low-risk and preserves a separate JSAN audit layer.
