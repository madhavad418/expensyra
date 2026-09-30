# JSAN Expensyra — Pleo API Phase 1


### v1.2.1 maintenance fixes

- Mock-mode receipt links now render an in-app local **DEMO receipt** instead of attempting the intentionally invalid fixture URLs.
- Windows smoke-test launcher now resolves the project folder using `fileURLToPath` and starts Node through the Windows command resolver.
- Smoke test now verifies that a mock receipt can be opened successfully.

**Version:** 1.2.0  
**Build date:** 22 September 2026  
**Purpose:** JSAN internal expense validation, allocation and reviewer productivity application.

This is a **runnable dynamic web application**, not a static mock-up. It includes a server-side Pleo connector, SQLite persistence, authenticated users, role-based access, transaction allocation, receipt access, validation sessions, approval/rejection/needs-info decisions, project/commercial classification, audit history and daily reviewer productivity.
## JSAN brand alignment — v1.2.1

The application UI has been rebuilt as a **JSAN-native internal product system**, using the same visual and editorial cues as the current JSAN corporate website: deep ink/navy surfaces, mint operational accents, oversized editorial headings, numbered operating stages, strong whitespace, technical grid treatments, and the `Operate • Map • Intelligence • Engineer` / `Mobilise • Collect • Operate • Process • Validate • Deliver` language system.

Expensyra translates that website language into finance operations:

```text
01 Sync → 02 Allocate → 03 Review → 04 Classify → 05 Validate → 06 Report
```

The UI remains purpose-built for an internal operational application rather than copying website navigation into a dashboard. The package includes a local JSAN Expensyra product mark, responsive desktop/mobile behaviour, branded authentication screens, website-style editorial headers, process rails, KPI blocks, tables, workbench and validation timer treatment. No external font files or website assets are required at runtime.

See [`docs/BRAND_SYSTEM.md`](docs/BRAND_SYSTEM.md) for the design tokens and component mapping.


## Phase 1 workflow

```text
Pleo New External API
        ↓
Server-side Pleo Sync
        ↓
Raw Pleo snapshot + JSAN transaction record
        ↓
Unallocated Queue
        ↓
Team Lead Allocation
        ↓
Reviewer Start / Pause validation
        ↓
Receipt + transaction validation
        ↓
Approve / Reject / Needs Info
        ↓
Project + commercial classification
        ↓
Daily workload / active-time / pending dashboard
```

The default connector is **Pleo Export API V2 (`export_v2`)**, following the Pleo Support guidance provided to JSAN. CSV is retained only under **Recovery & Reconciliation** and is not the normal ingestion path.

## Included

- Server-side Pleo External API connection; no API key is exposed to the browser.
- Export API V2 sync of pending/in-progress export jobs and their export items.
- Optional `accounting_entries_v1` connector for a future requirement to ingest Accounting Entries independent of the export queue.
- Idempotent Pleo sync using Accounting Entry ID to prevent duplicate transactions.
- Separate `pleo_raw_entries` store so source Pleo payloads remain distinct from JSAN review/enrichment fields.
- Receipt/evidence references and optional secure server-side receipt caching.
- First-run administrator creation; no default production credentials.
- Roles: `ADMIN`, `TEAM_LEAD`, `REVIEWER`, `FINANCE_QC`.
- Temporary-password enforcement for administrator-created users.
- Bulk transaction allocation to reviewers.
- Reviewer-specific queue.
- Explicit validation timer with heartbeat and idle auto-pause.
- Decisions: `APPROVED`, `REJECTED`, `NEEDS_INFO`.
- Commercial classification: Customer Billable, Project Cost, JSAN Internal, Shared Cost.
- Project master and project mapping.
- Daily metrics by reviewer: assigned, validations, approved, rejected, needs-info, active validation time, average time, pending.
- Immutable-style audit trail of JSAN actions.
- Manual Sync Now, connection test, scheduled sync and sync history.
- Recovery CSV import hidden under admin/recovery tooling.
- Docker, Docker Compose and Railway deployment configuration.
- Built-in API smoke test using a realistic 18-transaction Pleo V2 fixture.

## Requirements

- Node.js **22.5+** if running directly.
- Or Docker.
- For production Pleo ingestion: a Pleo **Standalone API Key** enabled for the new External API, the Pleo company ID, and the required read scopes for the endpoints you enable.

There are **no third-party npm runtime dependencies** in this Phase-1 build.

## Quick local run — UI without live Pleo

This is useful for application review before adding the production Pleo key:

```bash
PLEO_MOCK_MODE=true \
PLEO_COMPANY_ID=00000000-0000-0000-0000-000000000001 \
PLEO_AUTO_SYNC=false \
COOKIE_SECURE=false \
npm start
```

Open `http://localhost:4173`.

1. Create the first administrator.
2. Open **Pleo Sync**.
3. Select **Sync now** to load the bundled 18-transaction fixture.
4. Create reviewers under **Administration**.
5. Allocate transactions.
6. Sign in as a reviewer, change the temporary password, start validation and complete decisions.

## Production environment

Do **not** put the Pleo key into source code, frontend JavaScript, Git, screenshots or chat messages. Set it in your hosting platform's secret/environment-variable manager.

Minimum production settings:

```env
COOKIE_SECURE=true
DATABASE_PATH=/data/spendops.db
ATTACHMENT_DIR=/data/attachments
PLEO_API_BASE=https://external.pleo.io
PLEO_API_KEY=<set in hosting secret manager>
PLEO_COMPANY_ID=<your Pleo company UUID>
PLEO_SYNC_MODE=export_v2
PLEO_AUTO_SYNC=true
PLEO_SYNC_ON_START=true
PLEO_SYNC_INTERVAL_MINUTES=15
PLEO_CACHE_ATTACHMENTS=true
```

Copy `.env.example` only for private/local administration. Never commit a populated `.env`.

## Deployment

### Docker Compose

```bash
cp .env.example .env
# Edit .env locally and add your production settings.
docker compose up -d --build
```

The Compose file creates a persistent volume for `/data`.

### Railway

The included `railway.toml` and `Dockerfile` are ready for a single-service deployment. In Railway:

1. Deploy the repository/package.
2. Add a **persistent volume mounted at `/data`**.
3. Add the production environment variables/secrets.
4. Leave Railway's `PORT` environment variable in place; the server reads it automatically.
5. Health check endpoint: `/api/health`.
6. Use one running replica while using SQLite.

See [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) for the full checklist.

## Pleo connector choice

### Default: `export_v2`

This matches JSAN's Pleo Support guidance and reads entries that are in Pleo Export Jobs. The application discovers pending/in-progress jobs, retrieves their export items, stores the source record, and places new transactions in JSAN's unallocated queue.

### Optional: `accounting_entries_v1`

Use this only after validating the requirement with the Pleo tenant if JSAN needs accounting entries even when they have not been placed in an Export Job. This mode uses the Accounting Entries search API plus employee/receipt endpoints and has its own incremental sync cursor.

Switch using:

```env
PLEO_SYNC_MODE=accounting_entries_v1
```

See [`docs/PLEO_SETUP.md`](docs/PLEO_SETUP.md).

## Validation-time measurement

Expensyra intentionally does **not** use browser-tab-open time. A reviewer must select **Start validation**. The backend records a work session and the UI sends heartbeats while the review is active. The reviewer can pause manually, and the server auto-pauses a stale session after the configured idle threshold.

```env
VALIDATION_IDLE_TIMEOUT_SECONDS=150
```

Daily active time is calculated from completed validation sessions and associated review actions.

## Data model and auditability

Pleo-sourced data and JSAN decisions are separated:

```text
pleo_raw_entries      Original source payload snapshot
transactions          Normalised Pleo fields + current JSAN state
pleo_attachments      Receipt/evidence references/cache
work_sessions         Start/pause/idle-protected review time
reviews               Every JSAN review decision/action
projects              Project master
pleo_sync_runs        Sync observability
recovery_imports      Exceptional CSV reconciliation imports
audit_log             Allocation/review history
```

The Pleo sync refreshes source fields but does not overwrite JSAN reviewer allocation, decisions or commercial classification.

## Smoke test

```bash
npm run check
npm run test:smoke
```

The smoke test starts an isolated server/database in Pleo mock mode and verifies:

- first-admin setup;
- login/session creation;
- Pleo connection test;
- 18-item API sync;
- reviewer creation;
- transaction allocation;
- enforced temporary-password change;
- validation start/heartbeat;
- approval + project classification;
- reviewer metrics and dashboard counts.

## Production boundary for Phase 1

This package is deployment-ready as a **single-instance internal Phase-1 service**. Before company-wide production rollout, JSAN should validate the real Pleo key/scopes and field mappings against its own tenant, confirm receipt behaviour, place the service behind the company's normal access controls/reverse proxy, enable backups, and complete an internal security review.

Phase 2 is intentionally not mixed into this build. The schema/application can later add customer-approved UKM, pricing rules, earned revenue, invoicing and project P&L without changing the Phase-1 validation workflow.

## Documentation

- [`docs/PLEO_SETUP.md`](docs/PLEO_SETUP.md) — Pleo key, connector and live-validation checklist.
- [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) — Docker/Railway production deployment.
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — components, database and workflow.
- [`docs/SECURITY.md`](docs/SECURITY.md) — credentials, sessions and operational controls.
- [`docs/OPERATIONS.md`](docs/OPERATIONS.md) — team-lead/reviewer runbook.

