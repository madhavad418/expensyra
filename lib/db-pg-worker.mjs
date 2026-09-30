// Postgres side of the synchronous database bridge (see lib/db.mjs).
// Runs in a worker thread with one dedicated connection, so BEGIN/COMMIT
// issued by the main thread always land on the same session. Each request
// is answered on the MessagePort, then the shared flag is flipped so the
// blocked main thread wakes up.
import { workerData } from 'node:worker_threads';
import pg from 'pg';

const { url, port, flag, ssl } = workerData;
const signal = new Int32Array(flag);

// SQLite hands back plain JS numbers; keep that contract.
pg.types.setTypeParser(20, v => (v === null ? null : Number(v)));        // int8 (COUNT(*), SUM(int))
pg.types.setTypeParser(1700, v => (v === null ? null : Number(v)));      // numeric (SUM/AVG)
for (const oid of [1082, 1114, 1184]) pg.types.setTypeParser(oid, v => v); // date/timestamps stay text

// SQLite built-ins the app relies on, recreated with SQLite semantics:
// timestamps are ISO-8601 TEXT, anything unparseable becomes NULL, and
// comparisons (e.g. SUM(status='APPROVED')) count as 0/1.
const SQLITE_COMPAT = `
SET TimeZone = 'UTC';
CREATE OR REPLACE FUNCTION sqlite_ts(v text) RETURNS timestamptz LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN v IS NULL THEN NULL
    WHEN lower(v) = 'now' THEN now()
    WHEN v ~ '^\\d{4}-\\d{2}-\\d{2}([T ]\\d{2}:\\d{2}(:\\d{2}(\\.\\d+)?)?)?(Z|[+-]\\d{2}(:?\\d{2})?)?$' THEN v::timestamptz
    ELSE NULL END $$;
CREATE OR REPLACE FUNCTION sqlite_date(v text) RETURNS text LANGUAGE sql STABLE AS $$
  SELECT to_char(sqlite_ts(v) AT TIME ZONE 'UTC', 'YYYY-MM-DD') $$;
CREATE OR REPLACE FUNCTION sqlite_julianday(v text) RETURNS double precision LANGUAGE sql STABLE AS $$
  SELECT extract(epoch FROM sqlite_ts(v)) / 86400.0 + 2440587.5 $$;
CREATE OR REPLACE FUNCTION sqlite_strftime(f text, v text) RETURNS text LANGUAGE sql STABLE AS $$
  SELECT to_char(sqlite_ts(v) AT TIME ZONE 'UTC',
    replace(replace(replace(replace(replace(replace(f,'%Y','YYYY'),'%m','MM'),'%d','DD'),'%H','HH24'),'%M','MI'),'%S','SS')) $$;
CREATE OR REPLACE FUNCTION sqlite_sum_bool(acc bigint, v boolean) RETURNS bigint LANGUAGE sql IMMUTABLE AS $$
  SELECT acc + CASE WHEN v THEN 1 ELSE 0 END $$;
CREATE OR REPLACE AGGREGATE sum(boolean) (SFUNC = sqlite_sum_bool, STYPE = bigint, INITCOND = '0');
`;

const client = new pg.Client({ connectionString: url, ...(ssl ? { ssl: { rejectUnauthorized: false } } : {}) });
let ready = null;

async function handle(msg) {
  if (msg.op === 'init') {
    ready ??= client.connect().then(() => client.query(SQLITE_COMPAT));
    await ready;
    return { ok: true };
  }
  await ready;
  if (msg.op === 'exec') { await client.query(msg.sql); return null; }
  if (msg.op === 'query') {
    const r = await client.query(msg.sql, msg.params);
    if (msg.mode === 'all') return r.rows;
    if (msg.mode === 'get') return r.rows[0];
    return { changes: r.rowCount ?? 0, lastInsertRowid: r.rows?.[0]?.id ?? null };
  }
  if (msg.op === 'close') { await client.end(); return null; }
  throw new Error(`Unknown db op ${msg.op}`);
}

port.on('message', async msg => {
  let reply;
  try { reply = { result: await handle(msg) }; }
  catch (e) { reply = { error: { message: e.message, code: e.code, detail: e.detail } }; }
  port.postMessage(reply);
  Atomics.store(signal, 0, 1);
  Atomics.notify(signal, 0);
});
