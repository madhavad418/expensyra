# Deployment Guide

## Production topology (Railway)

```text
HTTPS (Railway domain)
          ↓
One app service (Docker image, code only)
          ↓
Railway Postgres  ← DATABASE_URL
          ↓
Pleo external.pleo.io
```

With `DATABASE_URL` set to a `postgres://` URL the app stores everything in Postgres; without it, it uses a local SQLite file (`DATABASE_PATH`), which is how it runs on a laptop. The same code and SQL serve both: `lib/db.mjs` translates the SQLite dialect for Postgres and runs queries on a dedicated connection in a worker thread. Run **one** app replica.

**No local data is deployed.** The image contains code only. `.dockerignore` and `.railwayignore` exclude `*.db`, `data/`, Excel/CSV exports and `.env`. The Postgres database starts empty, the schema is created on first start, and the data arrives through Pleo syncs run from the deployed app.

## Railway

1. In the Railway project that already has the **Postgres** service, add a new service from this repository or folder (`railway up`). Railway builds the `Dockerfile` via `railway.toml`.
2. In the app service's **Variables**, add:

   ```env
   DATABASE_URL=${{Postgres.DATABASE_URL}}
   PLEO_API_KEY=<secret — never commit>
   PLEO_COMPANY_ID=<Pleo company UUID>
   PLEO_SYNC_MODE=accounting_entries_v1
   BUSINESS_TZ=Asia/Kolkata
   COOKIE_SECURE=true
   PLEO_CACHE_ATTACHMENTS=false
   PLEO_AUTO_SYNC=false
   PLEO_MOCK_MODE=false
   ```

   `${{Postgres.DATABASE_URL}}` is Railway's reference to the Postgres service's private URL; rename `Postgres` if the database service has another name. Railway supplies `PORT` itself. Set `DATABASE_SSL=true` only if you point `DATABASE_URL` at Postgres's *public* TCP proxy.
3. **Do not** add a volume and **do not** set `DATABASE_PATH`: data lives in Postgres.
4. Deploy with one replica, then check that `https://<app>/api/health` returns `"db":"postgres"`.
5. Open the app URL. The empty database shows **first-time setup**: create the administrator.
6. **Pleo Sync → Test connection**, then load data:
   - **Transactions → Sync now** (choose the range, up to 31 days at a time), and/or
   - **Pleo Sync → historical backfill** for whole past months;
   - then switch on **Daily Pleo sync** on the Transactions page.
7. In **Administration**, recreate users; projects and project links come from the Pleo Excel import or can be added by hand.

Receipt caching is off (`PLEO_CACHE_ATTACHMENTS=false`) because the container disk is wiped on every deploy; receipts are fetched from Pleo when a transaction is opened.

## Docker Compose

Create `.env` from `.env.example`, then:

```bash
docker compose up -d --build
```

Check:

```bash
docker compose ps
docker compose logs -f spendops
curl http://localhost:4173/api/health
```

The named volume `spendops_data` persists the SQLite database and cached receipts. To use Postgres with Compose instead, set `DATABASE_URL` in `.env`.

## Bare Node

Node 22.13+ (the Docker image uses Node 24):

```bash
npm run check
npm start
```

Without `DATABASE_PATH`, the application stores the SQLite database under `./data`. For production, use a persistent protected filesystem location.

## Backup

Railway Postgres: enable Railway's database backups, or take `pg_dump` exports on a schedule. At minimum:

- keep a daily restore point and retain several;
- protect backups, because expense metadata may be confidential;
- periodically restore into a non-production database and run the functional checks.

Local SQLite (laptop or docker-compose): copy the file only while the app is stopped, or use the provider's volume snapshots.

## Upgrade procedure

1. Take a Postgres backup.
2. Deploy the new image; the database is untouched and the app adds any new columns on start.
3. Check `/api/health`.
4. Sign in and check the dashboard and transaction access.
5. Test the Pleo connection, run a controlled manual sync and inspect Sync History.
6. Roll back the application image if required; never delete the Postgres service.

## First-production-release checklist

- [ ] HTTPS enabled.
- [ ] `COOKIE_SECURE=true`.
- [ ] Pleo key stored only in deployment secret manager.
- [ ] Minimum Pleo read scopes.
- [ ] `DATABASE_URL` references the Railway Postgres service; `/api/health` reports `"db":"postgres"`.
- [ ] One application replica.
- [ ] Postgres backups configured.
- [ ] First administrator created with an individual JSAN account.
- [ ] Reviewer temporary passwords changed at first sign-in.
- [ ] Pleo Test Connection successful.
- [ ] Live data field mapping spot-checked against Pleo.
- [ ] Receipt access checked.
- [ ] Time-zone confirmed (`Asia/Kolkata` unless JSAN changes it).
- [ ] Team Lead validates allocation/productivity report logic before management use.
