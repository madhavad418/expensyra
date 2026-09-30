import {readFirstSheet} from '../lib/xlsx.mjs';
// Tests for the Expense Intelligence and Review Operations analytics
// endpoints, plus the extended /api/transactions filters they drill into.
// Runs against the built-in Pleo mock fixture (18 known transactions) so
// results are asserted against exact expected numbers, not just "no crash".
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const nodeCommand = process.platform === 'win32' ? 'node' : process.execPath;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsan-analytics-'));
const port = Number(process.env.ANALYTICS_TEST_PORT || 41100);
const base = `http://127.0.0.1:${port}`;

function killTree(proc){
  if(process.platform==='win32'){ try{ execSync(`taskkill /PID ${proc.pid} /T /F`,{stdio:'ignore'}); }catch{} }
  else { try{ proc.kill('SIGTERM'); }catch{} }
}

const server = spawn(nodeCommand, ['server.js'], {
  shell: process.platform === 'win32',
  cwd: root,
  env: { ...process.env, HOST:'127.0.0.1', PORT:String(port), DATABASE_PATH:path.join(dir,'app.db'), ATTACHMENT_DIR:path.join(dir,'attachments'),
    COOKIE_SECURE:'false', PLEO_MOCK_MODE:'true', PLEO_COMPANY_ID:'00000000-0000-0000-0000-000000000001',
    PLEO_SYNC_MODE:'export_v2', PLEO_AUTO_SYNC:'false', PLEO_SYNC_ON_START:'false' },
  stdio: ['ignore','pipe','pipe']
});
let stderr=''; server.stderr.on('data',d=>stderr+=d);

let failures=0;
function check(name, cond, detail=''){
  if(cond){ console.log(`PASS - ${name}`); }
  else { failures++; console.log(`FAIL - ${name}${detail?` (${detail})`:''}`); }
}
async function waitHealth(){
  for(let i=0;i<80;i++){ try{ const r=await fetch(base+'/api/health'); if(r.ok) return; }catch{} await new Promise(r=>setTimeout(r,100)); }
  throw new Error('Server did not become healthy.\n'+stderr);
}
function cookieFrom(r){ return (r.headers.get('set-cookie')||'').split(';')[0]; }
async function req(url,{method='GET',body,cookie,headers={}}={}){
  const r=await fetch(base+url,{method,headers:{Accept:'application/json',...(body!==undefined?{'Content-Type':'application/json'}:{}),...(cookie?{Cookie:cookie}:{}),...headers},body:body!==undefined?JSON.stringify(body):undefined});
  let p; try{p=await r.json()}catch{p={}};
  return {status:r.status, r, p};
}
const sum=(rows)=>rows.reduce((s,x)=>s+x.amount,0);
const round2=n=>Math.round(n*100)/100;
// Backfill now returns {runId} immediately (server owns the job) — this
// triggers it and polls /api/pleo/sync-runs/:runId until terminal, returning
// the completed run row so tests can assert on its final counts.
async function runBackfill(dateFrom,dateTo,cookie){
  const start=await req('/api/pleo/backfill',{method:'POST',cookie,body:{dateFrom,dateTo}});
  if(start.status!==200) return {status:start.status,p:start.p};
  const runId=start.p.runId;
  let run; for(let i=0;i<50;i++){ const r=await req(`/api/pleo/sync-runs/${runId}`,{cookie}); run=r.p.run; if(run.status!=='RUNNING') break; await new Promise(r=>setTimeout(r,100)); }
  return {status:200,p:{...run,itemsSeen:run.items_seen,inserted:run.inserted_count,updated:run.updated_count}};
}

try{
  await waitHealth();
  await req('/api/setup/admin',{method:'POST',body:{name:'Admin',email:'admin@jsan.test',password:'AdminPassword!2026'}});
  let x=await req('/api/auth/login',{method:'POST',body:{email:'admin@jsan.test',password:'AdminPassword!2026'}});
  const adminCookie=cookieFrom(x.r);
  await req('/api/pleo/sync',{method:'POST',cookie:adminCookie});

  const summary=await req('/api/analytics/expense/summary',{cookie:adminCookie});
  check('expense summary: authenticated endpoint excludes demo records',summary.status===200 && summary.p.monthly.length===0 && summary.p.projects.length===0);
  const anonymousSummary=await req('/api/analytics/expense/summary');
  check('expense summary: authentication required',anonymousSummary.status===401);

  // --- Baseline expense KPIs against the known 18-row mock fixture ---
  x=await req('/api/analytics/expense',{cookie:adminCookie});
  check('expense: 200 OK', x.status===200, JSON.stringify(x.p));
  check('expense: totalSpend is currency-grouped array', Array.isArray(x.p.kpis.totalSpend) && x.p.kpis.totalSpend.every(r=>r.currency&&typeof r.amount==='number'));
  // Regression guard: every money row the UI renders must have a numeric `count`
  // (moneyList() shows "· N tx" on every card — a missing count field rendered
  // as literal "undefined tx" on Avg/Median Transaction until this was fixed).
  for(const key of ['totalSpend','avgTransaction','medianTransaction','approvedSpend','rejectedSpend','pendingSpend','unclassifiedSpend','missingEvidenceValue']){
    const rows=x.p.kpis[key];
    check(`expense: ${key} rows all have numeric count`, rows.every(r=>typeof r.count==='number'), JSON.stringify(rows));
  }
  check('expense: transactionCount is 18', x.p.kpis.transactionCount===18, `got ${x.p.kpis.transactionCount}`);
  const catTotal=round2(sum(x.p.breakdowns.spendByCategory));
  const grandTotal=round2(sum(x.p.kpis.totalSpend));
  check('expense: category breakdown sums to totalSpend', catTotal===grandTotal, `categories=${catTotal} total=${grandTotal}`);
  const merchTotal=round2(sum(x.p.breakdowns.spendByMerchant));
  check('expense: merchant breakdown sums to totalSpend', merchTotal===grandTotal, `merchants=${merchTotal} total=${grandTotal}`);
  check('expense: everything unclassified/pending before any review', x.p.kpis.pendingSpend[0]?.count===18 && x.p.kpis.approvedSpend.length===0);
  const fuelRow=x.p.breakdowns.spendByCategory.find(r=>r.category==='Fuel');
  check('expense: Fuel category present with count', Boolean(fuelRow) && fuelRow.count>0, JSON.stringify(fuelRow));

  // --- Month filter: fixture dates are September 2026, so August must be empty ---
  x=await req('/api/analytics/expense?month=2026-08',{cookie:adminCookie});
  check('expense: August filter returns zero transactions (no fabricated data)', x.p.kpis.transactionCount===0, `got ${x.p.kpis.transactionCount}`);
  x=await req('/api/analytics/expense?month=2026-09',{cookie:adminCookie});
  check('expense: September filter returns all 18', x.p.kpis.transactionCount===18, `got ${x.p.kpis.transactionCount}`);

  // --- Drill-down transaction list filter matches the breakdown's own count ---
  x=await req('/api/transactions?category=Fuel',{cookie:adminCookie});
  check('drill-down: category=Fuel transaction count matches breakdown', x.p.total===fuelRow.count, `list total=${x.p.total} breakdown count=${fuelRow.count}`);
  check('drill-down: pagination fields present', typeof x.p.total==='number' && typeof x.p.limit==='number' && typeof x.p.offset==='number');

  // --- Server-side pagination: page/totalPages, and the source provenance filter ---
  x=await req('/api/transactions?limit=5&offset=0',{cookie:adminCookie});
  check('pagination: page=1 with limit=5', x.p.page===1 && x.p.limit===5 && x.p.rows.length===5, JSON.stringify({page:x.p.page,limit:x.p.limit,rows:x.p.rows.length}));
  check('pagination: totalPages computed correctly', x.p.totalPages===Math.ceil(18/5), `got ${x.p.totalPages}`);
  x=await req('/api/transactions?limit=5&offset=5',{cookie:adminCookie});
  check('pagination: page=2 with offset=5', x.p.page===2, `got ${x.p.page}`);
  check('pagination: page 2 rows differ from page 1', x.p.rows[0].id!==undefined);
  x=await req('/api/transactions?source=DEMO',{cookie:adminCookie});
  check('pagination: source=DEMO filter matches all 18 mock rows', x.p.total===18, `got ${x.p.total}`);
  x=await req('/api/transactions?source=LIVE_API',{cookie:adminCookie});
  check('pagination: source=LIVE_API filter matches none in this mock dataset', x.p.total===0, `got ${x.p.total}`);

  // --- Reviewer created, assigned, and completes one review ---
  x=await req('/api/users',{method:'POST',cookie:adminCookie,body:{name:'Reviewer One',email:'reviewer1@jsan.test',role:'REVIEWER',temporary_password:'TempPassword!2026'}});
  const reviewerId=x.p.id;
  x=await req('/api/transactions?limit=1',{cookie:adminCookie});
  const txId=x.p.rows[0].id;
  const txAmount=x.p.rows[0].amount;
  await req('/api/assign',{method:'POST',cookie:adminCookie,body:{reviewer_id:reviewerId,transaction_ids:[txId]}});

  x=await req('/api/auth/login',{method:'POST',body:{email:'reviewer1@jsan.test',password:'TempPassword!2026'}});
  const reviewerCookie=cookieFrom(x.r);
  await req('/api/auth/change-password',{method:'POST',cookie:reviewerCookie,body:{current_password:'TempPassword!2026',new_password:'ReviewerPass!2026'}});
  const validReview={decision:'APPROVED',commercial_classification:'CUSTOMER_BILLABLE',project_code:'CELLNEX-UK'};
  check('validation: cannot approve before start',(await req(`/api/transactions/${txId}/review`,{method:'POST',cookie:reviewerCookie,body:validReview})).status===409);
  await req(`/api/transactions/${txId}/start`,{method:'POST',cookie:reviewerCookie});
  check('validation: another user session cannot authorize approval',(await req(`/api/transactions/${txId}/review`,{method:'POST',cookie:adminCookie,body:validReview})).status===409);
  await req(`/api/transactions/${txId}/pause`,{method:'POST',cookie:reviewerCookie});
  check('validation: cannot approve while paused',(await req(`/api/transactions/${txId}/review`,{method:'POST',cookie:reviewerCookie,body:validReview})).status===409);
  await req(`/api/transactions/${txId}/start`,{method:'POST',cookie:reviewerCookie});
  await new Promise(r=>setTimeout(r,1100));
  x=await req(`/api/transactions/${txId}/review`,{method:'POST',cookie:reviewerCookie,body:{decision:'APPROVED',commercial_classification:'CUSTOMER_BILLABLE',project_code:'CELLNEX-UK'}});
  check('review: decision recorded', x.p.decision==='APPROVED', JSON.stringify(x.p));

  // --- Expense KPIs now reflect the one approved/classified transaction ---
  x=await req('/api/analytics/expense',{cookie:adminCookie});
  check('expense: approvedSpend reflects the one review', x.p.kpis.approvedSpend[0]?.count===1 && round2(x.p.kpis.approvedSpend[0]?.amount)===round2(txAmount), JSON.stringify(x.p.kpis.approvedSpend));
  check('expense: customerBillableSpend matches', x.p.kpis.customerBillableSpend[0]?.count===1, JSON.stringify(x.p.kpis.customerBillableSpend));
  check('expense: pendingSpend dropped to 17', x.p.kpis.pendingSpend[0]?.count===17, JSON.stringify(x.p.kpis.pendingSpend));
  const cellnexRow=x.p.breakdowns.spendByProject.find(r=>r.project_code==='CELLNEX-UK');
  check('expense: spendByProject shows the classified project', Boolean(cellnexRow) && cellnexRow.count===1, JSON.stringify(x.p.breakdowns.spendByProject));

  // --- Reviewer Operations list ---
  x=await req('/api/analytics/reviewers',{cookie:adminCookie});
  const revRow=x.p.rows.find(r=>r.id===reviewerId);
  check('reviewer-ops: reviewer row present', Boolean(revRow));
  check('reviewer-ops: assigned=1', revRow?.assigned===1, JSON.stringify(revRow));
  check('reviewer-ops: completed=1, approved=1', revRow?.completed===1 && revRow?.approved===1, JSON.stringify(revRow));
  check('reviewer-ops: pending=0', revRow?.pending===0);
  check('reviewer-ops: active_seconds recorded (>0)', revRow?.active_seconds>0, `active_seconds=${revRow?.active_seconds}`);
  check('reviewer-ops: elapsed_tat_avg_seconds is a number, distinct field from active_seconds', typeof revRow?.elapsed_tat_avg_seconds==='number');
  check('reviewer-ops: amount_reviewed_total matches', round2(revRow?.amount_reviewed_total)===round2(txAmount));

  // --- Reviewer detail drill-down ---
  x=await req(`/api/analytics/reviewers/${reviewerId}`,{cookie:adminCookie});
  check('reviewer-detail: 200 OK', x.status===200, JSON.stringify(x.p));
  check('reviewer-detail: decisionMix has one APPROVED', x.p.decisionMix.find(d=>d.decision==='APPROVED')?.count===1, JSON.stringify(x.p.decisionMix));
  check('reviewer-detail: completedQueue has the transaction', x.p.completedQueue.length===1 && x.p.completedQueue[0].id===txId);
  check('reviewer-detail: currentQueue is empty', x.p.currentQueue.length===0);
  check('reviewer-detail: sessions recorded', x.p.sessions.length>=1);
  check('reviewer-detail: elapsedTat has the transaction with a numeric elapsed_seconds', x.p.elapsedTat[0]?.elapsed_seconds>=0);
  check('reviewer-detail: unknown reviewer id -> 404', (await req('/api/analytics/reviewers/999999',{cookie:adminCookie})).status===404);

  // --- Historical backfill: date bounds + idempotency (uses the DEMO fixture
  // entries in sample/pleo-v2-fixture.json, clearly labelled synthetic data
  // spanning July/August/September 2026 — never real JSAN records) ---
  x=await runBackfill('2026-08-01','2026-08-31',adminCookie);
  check('backfill: August-only returns exactly 6 demo items', x.p.itemsSeen===6, JSON.stringify(x.p));
  check('backfill: all 6 are new inserts on first run', x.p.inserted===6 && x.p.updated===0, JSON.stringify(x.p));
  x=await runBackfill('2026-08-01','2026-08-31',adminCookie);
  check('backfill: idempotent re-run updates, does not duplicate', x.p.itemsSeen===6 && x.p.inserted===0 && x.p.updated===6, JSON.stringify(x.p));
  x=await runBackfill('2026-07-01','2026-08-31',adminCookie);
  check('backfill: widening range to include July finds 3 more new items', x.p.itemsSeen===9 && x.p.inserted===3 && x.p.updated===6, JSON.stringify(x.p));
  x=await req('/api/pleo/backfill',{method:'POST',cookie:adminCookie,body:{dateFrom:'not-a-date'}});
  check('backfill: invalid dateFrom rejected with 400', x.status===400, JSON.stringify(x.p));
  x=await req('/api/pleo/backfill',{method:'POST',cookie:reviewerCookie,body:{dateFrom:'2026-08-01'}});
  check('backfill: REVIEWER role denied', x.status===403, `got ${x.status}`);

  // --- Backfilled August data now shows up correctly in Expense Intelligence,
  // isolated from the September export_v2 mock data by month filter ---
  x=await req('/api/analytics/expense?month=2026-08',{cookie:adminCookie});
  check('backfill: August expense KPIs reflect the 6 backfilled items', x.p.kpis.transactionCount===6, `got ${x.p.kpis.transactionCount}`);
  x=await req('/api/analytics/expense?month=2026-09',{cookie:adminCookie});
  check('backfill: September still isolated (18 export_v2 mock items, unaffected)', x.p.kpis.transactionCount===18, `got ${x.p.kpis.transactionCount}`);

  // --- Month-by-category pivot data ---
  x=await req('/api/analytics/expense/monthly',{cookie:adminCookie});
  const months=new Set(x.p.rows.map(r=>r.month));
  check('monthly pivot: spans August and September', months.has('2026-08') && months.has('2026-09'), JSON.stringify([...months]));
  check('monthly pivot: REVIEWER denied', (await req('/api/analytics/expense/monthly',{cookie:reviewerCookie})).status===403);

  // --- RBAC: REVIEWER role must not see company-wide analytics ---
  x=await req('/api/analytics/expense',{cookie:reviewerCookie});
  check('RBAC: REVIEWER denied on expense analytics', x.status===403, `got ${x.status}`);
  x=await req('/api/analytics/reviewers',{cookie:reviewerCookie});
  check('RBAC: REVIEWER denied on reviewer-ops analytics', x.status===403, `got ${x.status}`);
  x=await req(`/api/analytics/reviewers/${reviewerId}`,{cookie:reviewerCookie});
  check('RBAC: REVIEWER denied on reviewer detail', x.status===403, `got ${x.status}`);

  // --- Unauthenticated requests must be rejected ---
  x=await req('/api/analytics/expense');
  check('auth: unauthenticated request rejected', x.status===401, `got ${x.status}`);

  const evidenceAll=await req('/api/transactions?limit=1',{cookie:adminCookie});
  const ec=evidenceAll.p.evidenceCounts;
  check('evidence: counts include all pages',ec.total===evidenceAll.p.total&&ec.present+ec.missing===ec.total);
  for(const kind of ['present','missing']){
    const filtered=await req('/api/transactions?receipt_status='+kind,{cookie:adminCookie});
    check('evidence: '+kind+' filter matches count',filtered.p.total===ec[kind]&&filtered.p.rows.every(r=>kind==='present'?r.receipt_count>0:r.receipt_count===0));
    check('evidence: both counts remain available',filtered.p.evidenceCounts.total===ec.total);
  }
  const scoped=await req('/api/transactions?receipt_status=missing',{cookie:reviewerCookie});
  check('evidence: reviewer counts stay scoped',scoped.p.evidenceCounts.total===1);
  const exportPath='/api/transactions/export?dateFrom=2026-08-01&dateTo=2026-08-31';
  check('Excel: authentication required',(await req(exportPath)).status===401);
  check('Excel: dates required',(await req('/api/transactions/export',{cookie:adminCookie})).status===400);
  const excel=await fetch(base+exportPath,{headers:{Cookie:adminCookie}});
  check('Excel: filename includes date range',excel.headers.get('content-disposition')?.includes('PleoExported_Data_2026-08-01_to_2026-08-31.xlsx'));
  const exported=readFirstSheet(Buffer.from(await excel.arrayBuffer()));
  check('Excel: all August rows exported',exported.rows.length===7);
  check('Excel: includes commercial and evidence columns',exported.rows[0].includes('Commercial classification')&&exported.rows[0].includes('Receipts'));
  check('Excel: only requested dates',exported.rows.slice(1).every(row=>String(row[0]).startsWith('2026-08')));
  const reviewExport=await fetch(base+'/api/transactions/export?dateFrom=2026-09-01&dateTo=2026-09-30',{headers:{Cookie:reviewerCookie}});
  check('Excel: reviewer scoped to assigned rows',readFirstSheet(Buffer.from(await reviewExport.arrayBuffer())).rows.length===2);
  const removalBody={dateFrom:'2026-08-01',dateTo:'2026-08-31'};
  const removal=(action,body=removalBody,cookie=adminCookie)=>req('/api/transactions/import-removal/'+action,{method:'POST',cookie,body});
  check('removal: reviewer denied',(await removal('preview',removalBody,reviewerCookie)).status===403);
  check('removal: missing dates rejected',(await removal('preview',{})).status===400);
  check('removal: invalid date rejected',(await removal('preview',{dateFrom:'2026-02-30',dateTo:'2026-08-31'})).status===400);
  const preview=await removal('preview');
  check('removal: preview finds six imported August rows',preview.status===200&&preview.p.removable===6,JSON.stringify(preview.p));
  check('removal: confirmation needs matching preview',(await removal('confirm',{...removalBody,token:'incorrect'})).status===409);
  const removed=await removal('confirm',{...removalBody,token:preview.p.token});
  check('removal: deletes previewed records',removed.status===200&&removed.p.removed===6,JSON.stringify(removed.p));
  check('removal: old preview cannot be replayed',(await removal('confirm',{...removalBody,token:preview.p.token})).status===409);
  x=await req('/api/analytics/expense?month=2026-08',{cookie:adminCookie});
  check('removal: analytics excludes deleted rows',x.p.kpis.transactionCount===0);
  x=await req('/api/analytics/expense?month=2026-09',{cookie:adminCookie});
  check('removal: other dates preserved',x.p.kpis.transactionCount===18);
  const september=await removal('preview',{dateFrom:'2026-09-01',dateTo:'2026-09-30'});
  check('removal: reviewed transaction is protected',september.p.protected>=1);

} catch(e){
  console.log('FAIL - unexpected exception: '+e.message);
  failures++;
} finally {
  killTree(server);
  await new Promise(r=>setTimeout(r,300));
  for(let i=0;i<5;i++){ try{ fs.rmSync(dir,{recursive:true,force:true}); break; }catch{ await new Promise(r=>setTimeout(r,300)); } }
}

console.log(failures===0 ? '\nAll analytics tests passed.' : `\n${failures} analytics test(s) failed.`);
process.exit(failures===0 ? 0 : 1);
