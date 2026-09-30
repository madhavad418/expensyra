// Daily Pleo sync scheduling. Pure decision logic, kept out of server.js so
// it can be tested without a database or a clock. All "day" and "time"
// comparisons happen in the business timezone (BUSINESS_TZ), never UTC — a
// 06:00 IST sync must fire at 06:00 IST, not 06:00 UTC.

export const DAILY_SYNC_DEFAULT_TIME = '06:00';
// After a failed daily run, wait this long before the scheduler retries.
export const DAILY_SYNC_RETRY_MS = 30 * 60_000;
// Only these trigger types count as "today's data is in". A historical
// backfill of an old month does not bring in yesterday's spend.
export const INCREMENTAL_TRIGGERS = ['daily', 'manual', 'scheduled', 'startup'];

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
export function normalizeSyncTime(v) {
  const s = String(v ?? '').trim();
  return TIME_RE.test(s) ? s : null;
}

export function businessParts(date, tz) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date);
  const get = t => parts.find(p => p.type === t)?.value;
  return { day: `${get('year')}-${get('month')}-${get('day')}`, time: `${get('hour')}:${get('minute')}` };
}

// Decides whether the scheduler should start a daily run right now.
//   lastSuccessAt  — started_at of the newest SUCCESS incremental run (ISO)
//   lastAttemptAt  — started_at of the newest daily-triggered run (ISO)
//   lastAttemptOk  — whether that daily run succeeded (null while running)
// A manual "Sync now" after the scheduled time counts as today's sync, so the
// scheduler does not fetch the same data twice.
export function dailySyncDecision({ enabled, time, tz, now = new Date(), configured = true, busy = false, lastSuccessAt = null, lastAttemptAt = null, lastAttemptOk = null }) {
  const at = normalizeSyncTime(time) || DAILY_SYNC_DEFAULT_TIME;
  const cur = businessParts(now, tz);
  const doneToday = (() => {
    if (!lastSuccessAt) return false;
    const p = businessParts(new Date(lastSuccessAt), tz);
    return p.day === cur.day && p.time >= at;
  })();
  const next = doneToday || cur.time < at ? { day: doneToday ? 'tomorrow' : 'today', time: at } : { day: 'today', time: at, due: true };
  const base = { run: false, doneToday, next };
  if (!enabled) return { ...base, reason: 'disabled' };
  if (!configured) return { ...base, reason: 'not_configured' };
  if (doneToday) return { ...base, reason: 'already_synced_today' };
  if (cur.time < at) return { ...base, reason: 'before_scheduled_time' };
  if (busy) return { ...base, reason: 'sync_in_progress' };
  if (lastAttemptAt && lastAttemptOk === false && now.getTime() - Date.parse(lastAttemptAt) < DAILY_SYNC_RETRY_MS) return { ...base, reason: 'retry_backoff' };
  return { ...base, run: true, reason: 'due' };
}
