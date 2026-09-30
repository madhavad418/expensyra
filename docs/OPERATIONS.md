# Phase-1 Operations Runbook

## Team Lead — daily flow

1. Open **Transactions**. The **Daily Pleo sync** bar at the top shows the last run, how many rows were new and when the next run is due. Switch it on once (Admin/Team Lead) and choose a time in the business timezone (`BUSINESS_TZ`); the server then pulls from Pleo once per day at that time. If the server was off at that time, it catches up when it starts again. A **Sync now** after the scheduled time counts as that day's run. Defaults before anyone uses the switch: `PLEO_DAILY_SYNC` and `PLEO_DAILY_SYNC_TIME` (HH:MM, default 06:00).
2. If required, select **Sync now** in that bar. When the run finishes, **Show N new** filters the list to rows first seen in the latest sync. That is the day's worklist. Re-syncs never change allocation, review status or decisions.
3. Set status `UNASSIGNED`, and narrow the queue with the work-queue filters: **Project** (the reviewer's choice, otherwise the approved Team → Project rule), **Pleo team**, **Pleo review status** and a **From/To** date range. Select **Apply**.
4. Choose a reviewer, then either tick rows and use **Allocate selected**, or use **Assign all N matching** to allocate the whole filtered set. If a sync changed the set after you loaded the list, the assignment is refused and you are asked to refresh. Approved/rejected transactions are never re-allocated.

One-time setup (Admin): **Administration → Pleo Excel import** with a Pleo expense export, then **Approve all proposed** Team → Project rules. See docs/ARCHITECTURE.md.
5. Monitor **Team Performance** for assigned, validations, active time and pending.
6. Investigate large pending queues, high Needs Info volume or sync errors rather than judging workload only from raw transaction count.

## Reviewer — daily flow

1. Sign in to **My Queue**.
2. Open an assigned expense.
3. Review Pleo transaction fields and receipt/evidence.
4. Select **Start validation** when active review begins.
5. Pause if work is interrupted.
6. Classify the expense/project where appropriate.
7. Complete with **Approve**, **Need info**, or **Reject**.
8. Add useful notes for Need Info/Reject decisions.

## Management metrics

The Phase-1 team table should be read as a set:

- Assigned today — workload allocation.
- Validations — review actions completed today.
- Approved / Rejected / Need Info — decision mix.
- Active validation time — explicit measured handling time.
- Average / validation — handling-time indicator.
- Pending — current backlog.

No single number should be used alone as a staff-utilisation conclusion. Complexity and later QC accuracy should be added to Phase 1B if management will use the dashboard for capacity decisions.

## Pleo sync incident

If a sync fails:

1. Open **Pleo Sync → Sync History** and capture the error (never the API key).
2. Use **Test connection**.
3. Confirm key is still active and the deployment has the correct company ID/scopes.
4. Confirm Pleo has an appropriate Export Job if using `export_v2`.
5. Retry **Sync now**.
6. CSV Recovery Import is a last-resort reconciliation path, not the normal operating workflow.

## Settlement-based imports and wallet calculations

All Accounting Entries imports (Sync now, scheduled sync when enabled, and historical backfill) use settlement dates. Historical backfill retrieves the selected settlement range. The daily sync and a default **Sync now** fetch everything settled since the last successful run, with a 1-hour overlap. The very first run fetches only the last `PLEO_INITIAL_LOOKBACK_HOURS` (default 24). **Sync now** on the Transactions page also offers Last 24 hours, Last 7 days or Last 30 days (max 31 days), and confirms the date range before starting. **Stop sync** halts a running sync and removes every transaction it inserted. Existing rows keep their refreshed Pleo fields. Refresh older corrections with historical backfill.

Normal sync uses a separate settlement checkpoint, ignoring legacy purchase-date checkpoints. It advances that checkpoint only after every page succeeds. Missing/repeated pagination cursors or a page-limit cutoff fail the run; reruns safely upsert partial rows without duplicates.

Expense Intelligence uses API data and Pleo billed amounts in the billing currency. It replaces parent amounts with validated split details for reporting, includes signed refunds/cashback, excludes OUT_OF_POCKET and BILL_INVOICE records from wallet spending, and carries each month's remaining balance forward. Unbilled/pending entries are explicitly excluded. The zero opening balance remains an estimate. No workbook snapshot participates in calculations.

Pending entries are refreshed independently using Pleo's `status: [PENDING]` API filter after each regular/daily sync. Entries that leave that feed are looked up through API search to refresh their actual settled/cancelled/deleted status; disappearance alone is never treated as completion. Transactions includes a Pleo status filter and pending shortcut, and shows original provisional amounts with purchase dates until settlement. Pending and API-deleted entries do not contribute to Expense Intelligence balances. Historical backfill retains its settlement-date scope.
