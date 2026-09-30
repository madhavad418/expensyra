import assert from 'node:assert/strict';
import {dailySyncDecision,normalizeSyncTime,businessParts} from '../lib/daily-sync.mjs';
const tz='Asia/Kolkata'; // UTC+05:30 — 06:00 IST is 00:30 UTC
const at=(iso)=>new Date(iso);
const base={enabled:true,time:'06:00',tz,configured:true};

assert.equal(normalizeSyncTime('06:00'),'06:00');assert.equal(normalizeSyncTime('23:59'),'23:59');
for(const bad of ['6:00','24:00','06:60','','x',null])assert.equal(normalizeSyncTime(bad),null,String(bad));
assert.deepEqual(businessParts(at('2026-09-28T00:30:00Z'),tz),{day:'2026-09-28',time:'06:00'});
assert.deepEqual(businessParts(at('2026-09-27T20:00:00Z'),tz),{day:'2026-09-28',time:'01:30'},'IST day rolls over before UTC day');
console.log('PASS: time parsing and business-timezone day/time');

// Before the slot: wait, and report today's slot as next.
let d=dailySyncDecision({...base,now:at('2026-09-28T00:29:00Z')});
assert.equal(d.run,false);assert.equal(d.reason,'before_scheduled_time');assert.deepEqual(d.next,{day:'today',time:'06:00'});
// At/after the slot with nothing synced today: run.
d=dailySyncDecision({...base,now:at('2026-09-28T00:30:00Z'),lastSuccessAt:'2026-09-27T00:31:00Z'});
assert.equal(d.run,true);assert.equal(d.next.due,true);
// Missed slot (server was off at 06:00) is caught up later the same day.
assert.equal(dailySyncDecision({...base,now:at('2026-09-28T06:00:00Z'),lastSuccessAt:'2026-09-27T00:31:00Z'}).run,true);
console.log('PASS: runs at the slot, waits before it, catches up a missed slot');

// Already synced today after the slot (daily or a manual "Sync now"): don't repeat.
d=dailySyncDecision({...base,now:at('2026-09-28T09:00:00Z'),lastSuccessAt:'2026-09-28T02:00:00Z'});
assert.equal(d.run,false);assert.equal(d.reason,'already_synced_today');assert.deepEqual(d.next,{day:'tomorrow',time:'06:00'});
// A manual sync earlier today but BEFORE the slot does not count — new spend may have settled since.
assert.equal(dailySyncDecision({...base,now:at('2026-09-28T01:00:00Z'),lastSuccessAt:'2026-09-27T23:00:00Z'}).run,true,'04:30 IST sync is before the 06:00 slot');
console.log('PASS: one run per business day; pre-slot manual sync does not suppress it');

// Guards.
const due={...base,now:at('2026-09-28T01:00:00Z')};
assert.equal(dailySyncDecision({...due,enabled:false}).reason,'disabled');
assert.equal(dailySyncDecision({...due,configured:false}).reason,'not_configured');
assert.equal(dailySyncDecision({...due,busy:true}).reason,'sync_in_progress');
// Failed daily attempt: back off 30 minutes, then retry.
assert.equal(dailySyncDecision({...due,lastAttemptAt:'2026-09-28T00:45:00Z',lastAttemptOk:false}).reason,'retry_backoff');
assert.equal(dailySyncDecision({...due,lastAttemptAt:'2026-09-28T00:30:00Z',lastAttemptOk:false}).run,true);
// Invalid stored time falls back to the default rather than never firing.
assert.equal(dailySyncDecision({...due,time:'bogus'}).run,true);
console.log('PASS: disabled / unconfigured / busy / retry backoff / bad time fallback');
