// Pleo connector diagnostics tests. Uses a local fake Pleo server (never the
// real external.pleo.io, never a real credential) so these run deterministically
// offline and never depend on / touch a live Pleo account.
import { spawn, execSync } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// On Windows, spawn() with shell:true wraps the child in cmd.exe, so proc.kill()
// only terminates that shell — not the actual node.exe grandchild — leaving it
// running and squatting on the port. taskkill /T kills the whole process tree.
function killTree(proc){
  if(process.platform==='win32'){ try{ execSync(`taskkill /PID ${proc.pid} /T /F`,{stdio:'ignore'}); }catch{} }
  else { try{ proc.kill('SIGTERM'); }catch{} }
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const nodeCommand = process.platform === 'win32' ? 'node' : process.execPath;
const FAKE_KEY = 'test-fake-key-not-a-real-credential';
const VALID_UUID = '11111111-1111-4111-8111-111111111111';

let failures = 0;
function check(name, cond, detail=''){
  if(cond){ console.log(`PASS - ${name}`); }
  else { failures++; console.log(`FAIL - ${name}${detail?` (${detail})`:''}`); }
}

// --- Fake Pleo upstream: a tiny local HTTP server standing in for external.pleo.io ---
function startFakePleo(){
  let mode = 'ok';
  let companyMode = 'ok'; let companyName = 'Fake Live Company Ltd';
  const searchBodies=[];let pendingRows=[];
  let entriesPages = null; // null = fall back to legacy single-page 'ok' behaviour
  let receiptMode = 'ok'; // 'ok' | 'fail-always'
  let receiptHits = 0, receiptConcurrent = 0, receiptMaxConcurrent = 0;
  let hits = 0;
  let tagGroups = [{id:'grp-projects',name:'Projects',code:'PROJ',archived:false},{id:'grp-departments',name:'Departments',code:'DEPT',archived:false}];
  let tagsByGroup = { 'grp-projects':[{id:'tag-here-uk',groupId:'grp-projects',name:'HERE UK',code:'HERE-UK',archived:false},{id:'tag-cellnex',groupId:'grp-projects',name:'Cellnex UK',code:'CELLNEX-UK',archived:false}],
    'grp-departments':[{id:'tag-sales',groupId:'grp-departments',name:'Sales',code:'SALES',archived:false}] };
  let categories = [{id:'acct-fuel',name:'Fuel',code:'FUEL',archived:false},{id:'acct-travel',name:'Travel',code:'TRAVEL',archived:false}];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if(req.method === 'POST' && url.pathname === '/_test/set-mode'){
      let body=''; req.on('data',c=>body+=c); req.on('end',()=>{ mode = JSON.parse(body||'{}').mode || 'ok'; res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:true,mode})); });
      return;
    }
    if(req.method === 'POST' && url.pathname === '/_test/set-receipt-mode'){
      let body=''; req.on('data',c=>body+=c); req.on('end',()=>{ receiptMode = JSON.parse(body||'{}').mode || 'ok'; res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:true})); });
      return;
    }
    if(req.method === 'GET' && url.pathname === '/_test/receipt-stats'){
      res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify({hits:receiptHits, maxConcurrent:receiptMaxConcurrent})); return;
    }
    if(req.method === 'POST' && url.pathname === '/_test/set-company-mode'){
      let body=''; req.on('data',c=>body+=c); req.on('end',()=>{ const b=JSON.parse(body||'{}'); companyMode = b.mode || 'ok'; companyName = b.name || companyName; res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:true})); });
      return;
    }
    if(req.method === 'POST' && url.pathname === '/_test/set-entries-pages'){
      let body=''; req.on('data',c=>body+=c); req.on('end',()=>{ entriesPages = JSON.parse(body||'{}').pages || []; res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:true})); });
      return;
    }
    if(req.method === 'GET' && url.pathname === '/_test/hits'){
      res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify({hits})); return;
    }
    if(req.method === 'POST' && url.pathname === '/_test/set-reference-data'){
      let body=''; req.on('data',c=>body+=c); req.on('end',()=>{ const b=JSON.parse(body||'{}'); if(b.tagGroups) tagGroups=b.tagGroups; if(b.tagsByGroup) tagsByGroup=b.tagsByGroup; if(b.categories) categories=b.categories; res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:true})); });
      return;
    }
    // Anything else is treated as a real Pleo API call.
    hits++;
    const send = (status, body) => { res.writeHead(status,{'Content-Type':'application/json'}); res.end(JSON.stringify(body)); };

    if(url.pathname==='/v0/tag-groups') return send(200,{data:tagGroups,pagination:{hasNextPage:false}});
    const tagGroupMatch=url.pathname.match(/^\/v0\/tag-groups\/([^/]+)\/tags$/);
    if(tagGroupMatch) return send(200,{data:tagsByGroup[tagGroupMatch[1]]||[],pagination:{hasNextPage:false}});
    if(url.pathname==='/v1/chart-of-accounts:search') return send(200,{data:categories,pagination:{hasNextPage:false}});

    if(url.pathname.startsWith('/v1/companies/')){
      if(companyMode==='ok') return send(200, {data:{id:url.pathname.split('/').pop(), name:companyName}});
      if(companyMode==='401') return send(401, {type:'UNAUTHORIZED', message:'Invalid API credentials'});
      if(companyMode==='403') return send(403, {type:'FORBIDDEN', message:'Missing scope companies:read'});
      if(companyMode==='404') return send(404, {type:'NOT_FOUND', message:'Company not found'});
      return send(500, {message:'unknown fake company mode'});
    }
    if(url.pathname==='/v1/accounting-entries:search'&&entriesPages!==null){
      let body='';req.on('data',c=>body+=c);req.on('end',()=>{
        const search=JSON.parse(body||'{}');searchBodies.push(search);
        if(search.status?.includes('PENDING'))return send(200,{data:pendingRows,pagination:{hasNextPage:false}});
        const page=entriesPages.shift()||[];
        if(page.error)return send(page.error,{message:'Injected pagination failure'});
        return send(200,{data:page,pagination:{hasNextPage:entriesPages.length>0,endCursor:entriesPages.length>0?'cursor-'+entriesPages.length:null}});
      });return;
    }
    if(/^\/v1\/accounting-entries\/[^/]+\/receipts\/[^/]+$/.test(url.pathname)){
      receiptHits++; receiptConcurrent++; receiptMaxConcurrent=Math.max(receiptMaxConcurrent,receiptConcurrent);
      setTimeout(()=>{
        receiptConcurrent--;
        if(receiptMode==='fail-always') return send(500,{type:'INTERNAL',message:'receipt fetch failed'});
        return send(200,{url:'https://fake-pleo-receipts.test/'+encodeURIComponent(url.pathname),mimeType:'application/pdf',size:1234});
      }, 150); // artificial delay so concurrent requests actually overlap in time
      return;
    }
    if(mode==='ok') return send(200, {data:[{id:'job-1',status:'pending'}], pagination:{hasNextPage:false}});
    if(mode==='401') return send(401, {type:'UNAUTHORIZED', message:'Invalid API credentials'});
    if(mode==='403') return send(403, {type:'FORBIDDEN', message:'Missing scope export-jobs:read'});
    if(mode==='400') return send(400, {type:'INVALID_PARAMETER', message:'query param is invalid'});
    if(mode==='500') return send(500, {type:'INTERNAL', message:'Oops, something went wrong...'});
    return send(500, {message:'unknown fake mode'});
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, searchBodies, setPending:rows=>{pendingRows=rows;}, port: server.address().port, hits: () => hits, receiptHits: () => receiptHits, receiptMaxConcurrent: () => receiptMaxConcurrent })));
}

function spawnApp(port, env, dir){
  return spawn(nodeCommand, ['server.js'], {
    shell: process.platform === 'win32',
    cwd: root,
    // PLEO_CACHE_ATTACHMENTS pinned: these tests exercise the background
    // receipt queue, which must not depend on whatever the local .env says.
    env: { ...process.env, HOST:'127.0.0.1', PORT:String(port), DATABASE_PATH:path.join(dir,'app.db'), ATTACHMENT_DIR:path.join(dir,'attachments'), COOKIE_SECURE:'false', PLEO_CACHE_ATTACHMENTS:'true', ...env },
    stdio: ['ignore','pipe','pipe']
  });
}
async function waitHealth(base, proc){
  let stdout='', stderr='';
  proc.stdout.on('data', d=>stdout+=d); proc.stderr.on('data', d=>stderr+=d);
  for(let i=0;i<80;i++){ try{ const r=await fetch(base+'/api/health'); if(r.ok) return {stdout:()=>stdout, stderr:()=>stderr}; }catch{} await new Promise(r=>setTimeout(r,100)); }
  throw new Error('Server did not become healthy. stderr:\n'+stderr);
}
function cookieFrom(r){ return (r.headers.get('set-cookie')||'').split(';')[0]; }
async function asAdmin(base){
  await fetch(base+'/api/setup/admin',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'Test Admin',email:'admin@jsan.test',password:'AdminPassword!2026'})});
  const r = await fetch(base+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:'admin@jsan.test',password:'AdminPassword!2026'})});
  return cookieFrom(r);
}
function tmpDir(prefix){ return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }
async function stop(proc, dir){
  killTree(proc);
  await new Promise(r=>setTimeout(r,300));
  // Windows can hold the SQLite file handle briefly after the process exits;
  // retry cleanup rather than letting a slow file-handle release fail the run.
  for(let i=0;i<5;i++){
    try{ fs.rmSync(dir,{recursive:true,force:true}); return; }
    catch{ await new Promise(r=>setTimeout(r,300)); }
  }
}

// === Scenario 1: missing key + missing company id -> configured:false, reason MISSING ===
async function testMissingConfig(){
  const dir = tmpDir('jsan-pleo-missing-');
  const port = 41001; const base = `http://127.0.0.1:${port}`;
  const proc = spawnApp(port, { PLEO_MOCK_MODE:'false', PLEO_API_KEY:'', PLEO_COMPANY_ID:'', PLEO_SYNC_ON_START:'false', PLEO_AUTO_SYNC:'false' }, dir);
  try{
    const io = await waitHealth(base, proc);
    const cookie = await asAdmin(base);
    const r = await fetch(base+'/api/pleo/test',{method:'POST',headers:{Cookie:cookie}}); const p = await r.json();
    check('missing config -> 400', r.status===400, `got ${r.status}`);
    check('missing config -> reason MISSING', p.reason==='MISSING', JSON.stringify(p));
    check('missing config -> no secret in response', !JSON.stringify(p).includes(FAKE_KEY));
    check('missing config -> no secret in stdout/stderr', !io.stdout().includes(FAKE_KEY) && !io.stderr().includes(FAKE_KEY));
  } finally { await stop(proc, dir); }
}

// === Scenario 2: valid key, malformed company id -> reason INVALID_COMPANY_ID ===
async function testInvalidCompanyId(){
  const dir = tmpDir('jsan-pleo-badid-');
  const port = 41002; const base = `http://127.0.0.1:${port}`;
  const proc = spawnApp(port, { PLEO_MOCK_MODE:'false', PLEO_API_KEY:FAKE_KEY, PLEO_COMPANY_ID:'REPLACE_WITH_REAL_COMPANY_UUID', PLEO_SYNC_ON_START:'false', PLEO_AUTO_SYNC:'false' }, dir);
  try{
    const io = await waitHealth(base, proc);
    const cookie = await asAdmin(base);
    const r = await fetch(base+'/api/pleo/test',{method:'POST',headers:{Cookie:cookie}}); const p = await r.json();
    check('bad company id -> 400', r.status===400, `got ${r.status}`);
    check('bad company id -> reason INVALID_COMPANY_ID', p.reason==='INVALID_COMPANY_ID', JSON.stringify(p));
    check('bad company id -> no secret leaked', !JSON.stringify(p).includes(FAKE_KEY) && !io.stdout().includes(FAKE_KEY) && !io.stderr().includes(FAKE_KEY));
  } finally { await stop(proc, dir); }
}

// === Scenario 3: startup sync disabled must not call Pleo; then classify 200/401/403/400/500 ===
async function testHttpClassificationAndStartupGate(){
  const dir = tmpDir('jsan-pleo-http-');
  const port = 41003; const base = `http://127.0.0.1:${port}`;
  const fake = await startFakePleo();
  const fakeBase = `http://127.0.0.1:${fake.port}`;
  const proc = spawnApp(port, { PLEO_MOCK_MODE:'false', PLEO_API_KEY:FAKE_KEY, PLEO_COMPANY_ID:VALID_UUID, PLEO_API_BASE:fakeBase, PLEO_SYNC_ON_START:'false', PLEO_AUTO_SYNC:'false' }, dir);
  try{
    const io = await waitHealth(base, proc);
    // Startup gate: no automatic call should have reached the fake Pleo server.
    await new Promise(r=>setTimeout(r,500));
    check('PLEO_SYNC_ON_START=false -> no automatic Pleo call at startup', fake.hits()===0, `hits=${fake.hits()}`);

    const cookie = await asAdmin(base);
    const setMode = async m => { await fetch(fakeBase+'/_test/set-mode',{method:'POST',body:JSON.stringify({mode:m})}); };
    const testConn = async () => { const r=await fetch(base+'/api/pleo/test',{method:'POST',headers:{Cookie:cookie}}); return {status:r.status, body:await r.json()}; };

    await setMode('ok'); let x = await testConn();
    check('200 upstream -> ok:true', x.status===200 && x.body.ok===true, JSON.stringify(x));

    await setMode('401'); x = await testConn();
    check('401 upstream -> reason AUTH_FAILED', x.body.reason==='AUTH_FAILED', JSON.stringify(x));
    check('401 upstream -> statusCode preserved', x.body.statusCode===401, JSON.stringify(x));

    await setMode('403'); x = await testConn();
    check('403 upstream -> reason MISSING_SCOPE', x.body.reason==='MISSING_SCOPE', JSON.stringify(x));

    await setMode('400'); x = await testConn();
    check('400 upstream -> reason BAD_REQUEST', x.body.reason==='BAD_REQUEST', JSON.stringify(x));

    await setMode('500'); x = await testConn();
    check('500 upstream -> reason UPSTREAM_ERROR', x.body.reason==='UPSTREAM_ERROR', JSON.stringify(x));
    check('500 upstream -> statusCode preserved', x.body.statusCode===500, JSON.stringify(x));

    const statusR = await fetch(base+'/api/pleo/status',{headers:{Cookie:cookie}}); const statusP = await statusR.json();
    check('status endpoint never exposes the key', !JSON.stringify(statusP).includes(FAKE_KEY));
    check('status endpoint masks company id', statusP.companyId && !statusP.companyId.includes(VALID_UUID));
    check('status endpoint reports lastTest', statusP.lastTest && statusP.lastTest.reason==='UPSTREAM_ERROR', JSON.stringify(statusP.lastTest));

    check('no secret ever printed to stdout', !io.stdout().includes(FAKE_KEY));
    check('no secret ever printed to stderr', !io.stderr().includes(FAKE_KEY));
  } finally { await stop(proc, dir); fake.server.close(); }
}

// Minimal AccountingEntryV1-shaped row, matching mapAccountingEntry()'s expectations.
function fakeEntry(id, overrides={}){
  return { id, employeeId:null, teamId:null, merchant:{name:'Fake Merchant',address:{country:'GB'}}, splitItems:[{accountCode:'Fuel',tags:[]}], tags:[],
    family:'Travel', subFamily:'Fuel', settledAt:'2026-08-01T10:00:00Z', transactionValue:{value:5000,currency:'GBP'},
    note:null, receiptIds:[], reviewStatus:null, status:'settled', ...overrides };
}

// === Scenario 4: company test (mock mode short-circuit, then real 200/401/403/404) ===
async function testCompanyTest(){
  const dir = tmpDir('jsan-pleo-company-');
  const port = 41004; const base = `http://127.0.0.1:${port}`;
  const fake = await startFakePleo();
  const fakeBase = `http://127.0.0.1:${fake.port}`;
  const proc = spawnApp(port, { PLEO_MOCK_MODE:'false', PLEO_API_KEY:FAKE_KEY, PLEO_COMPANY_ID:VALID_UUID, PLEO_API_BASE:fakeBase, PLEO_SYNC_ON_START:'false', PLEO_AUTO_SYNC:'false' }, dir);
  try{
    await waitHealth(base, proc);
    const cookie = await asAdmin(base);
    const companyTest = async () => { const r=await fetch(base+'/api/pleo/company-test',{method:'POST',headers:{Cookie:cookie}}); return {status:r.status, body:await r.json()}; };
    const setCompanyMode = async (m,name) => { await fetch(fakeBase+'/_test/set-company-mode',{method:'POST',body:JSON.stringify({mode:m,name})}); };

    await setCompanyMode('ok','Fake Live Company Ltd');
    let x = await companyTest();
    check('company-test: 200 -> PASS with company name', x.status===200 && x.body.ok===true && x.body.companyName==='Fake Live Company Ltd', JSON.stringify(x));

    await setCompanyMode('401'); x = await companyTest();
    check('company-test: 401 -> AUTH_FAILED', x.body.reason==='AUTH_FAILED', JSON.stringify(x));

    await setCompanyMode('403'); x = await companyTest();
    check('company-test: 403 -> MISSING_SCOPE', x.body.reason==='MISSING_SCOPE', JSON.stringify(x));

    await setCompanyMode('404'); x = await companyTest();
    check('company-test: 404 -> COMPANY_NOT_FOUND', x.body.reason==='COMPANY_NOT_FOUND', JSON.stringify(x));
  } finally { await stop(proc, dir); fake.server.close(); }
}

// === Scenario 5: company test never calls the real endpoint in mock mode ===
async function testCompanyTestMockMode(){
  const dir = tmpDir('jsan-pleo-company-mock-');
  const port = 41005; const base = `http://127.0.0.1:${port}`;
  const fake = await startFakePleo();
  const fakeBase = `http://127.0.0.1:${fake.port}`;
  const proc = spawnApp(port, { PLEO_MOCK_MODE:'true', PLEO_COMPANY_ID:'00000000-0000-0000-0000-000000000001', PLEO_API_BASE:fakeBase, PLEO_SYNC_ON_START:'false', PLEO_AUTO_SYNC:'false' }, dir);
  try{
    await waitHealth(base, proc);
    const cookie = await asAdmin(base);
    const r = await fetch(base+'/api/pleo/company-test',{method:'POST',headers:{Cookie:cookie}}); const p = await r.json();
    check('company-test: mock mode returns ok without calling real endpoint', p.ok===true && p.mock===true, JSON.stringify(p));
    check('company-test: mock mode never hit the fake upstream', fake.hits()===0, `hits=${fake.hits()}`);
  } finally { await stop(proc, dir); fake.server.close(); }
}

// === Scenario 6: live-shaped Accounting Entries fetch — pagination, provenance, and the hard fixture-exclusion gate ===
async function testLiveAccountingEntriesProvenanceAndPagination(){
  const dir = tmpDir('jsan-pleo-entries-');
  const port = 41006; const base = `http://127.0.0.1:${port}`;
  const fake = await startFakePleo();
  const fakeBase = `http://127.0.0.1:${fake.port}`;
  const proc = spawnApp(port, { PLEO_MOCK_MODE:'false', PLEO_API_KEY:FAKE_KEY, PLEO_COMPANY_ID:VALID_UUID, PLEO_API_BASE:fakeBase, PLEO_SYNC_ON_START:'false', PLEO_AUTO_SYNC:'false' }, dir);
  try{
    await waitHealth(base, proc);
    const cookie = await asAdmin(base);
    // Backfill returns {runId} immediately now (server owns the job) — trigger,
    // then poll /api/pleo/sync-runs/:runId until terminal.
    const backfill = async (dateFrom,dateTo) => {
      const start = await fetch(base+'/api/pleo/backfill',{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify({dateFrom,dateTo})});
      const startBody = await start.json();
      if(start.status!==200) return {status:start.status, body:startBody};
      let run; for(let i=0;i<50;i++){ const r=await fetch(base+`/api/pleo/sync-runs/${startBody.runId}`,{headers:{Cookie:cookie}}); const p=await r.json(); run=p.run; if(run.status!=='RUNNING') break; await new Promise(res=>setTimeout(res,100)); }
      const status = run.status==='SUCCESS'?200:(run.status==='FAILED'||run.status==='INTERRUPTED'?500:202);
      return {status, body:{...run, pagesRequested:run.pages_fetched, recordsFetched:run.items_seen, recordsInserted:run.inserted_count, recordsUpdated:run.updated_count, realCount:run.real_count, demoFixtureCount:run.demo_fixture_count, sampleExternalIds:JSON.parse(run.sample_external_ids||'[]')}};
    };
    const setPages = async pages => { await fetch(fakeBase+'/_test/set-entries-pages',{method:'POST',body:JSON.stringify({pages})}); };

    // --- 3-page pagination with real-looking (non-fixture) IDs ---
    await setPages([
      [fakeEntry('real-entry-aaaa1111')],
      [fakeEntry('real-entry-bbbb2222')],
      [fakeEntry('real-entry-cccc3333')],
    ]);
    let x = await backfill('2026-08-01','2026-08-01');
    check('live entries: 3-page fetch succeeds', x.status===200, JSON.stringify(x));
    check('live entries: pagesRequested is 3', x.body.pagesRequested===3, JSON.stringify(x.body));
    check('live entries: recordsFetched is 3', x.body.recordsFetched===3, JSON.stringify(x.body));
    check('live entries: recordsInserted is 3', x.body.recordsInserted===3, JSON.stringify(x.body));
    check('live entries: demoFixtureCount is 0', x.body.demoFixtureCount===0, JSON.stringify(x.body));
    check('live entries: realCount is 3', x.body.realCount===3, JSON.stringify(x.body));
    check('live entries: sample external IDs are the real ones, not fixture IDs', x.body.sampleExternalIds.every(id=>id.startsWith('real-entry-')), JSON.stringify(x.body.sampleExternalIds));

    // --- provenance persisted correctly on the actual DB row ---
    const txList = await fetch(base+'/api/transactions?limit=10',{headers:{Cookie:cookie}}).then(r=>r.json());
    const row = txList.rows.find(r=>r.pleo_accounting_entry_id==='real-entry-aaaa1111');
    check('live entries: row exists', Boolean(row));
    check('live entries: source_system=PLEO', row?.source_system==='PLEO', JSON.stringify(row));
    check('live entries: source_channel=ACCOUNTING_ENTRIES_API', row?.source_channel==='ACCOUNTING_ENTRIES_API', JSON.stringify(row));
    check('live entries: source_environment=PRODUCTION', row?.source_environment==='PRODUCTION', JSON.stringify(row));
    check('live entries: source_kind=HISTORICAL_API', row?.source_kind==='HISTORICAL_API', JSON.stringify(row));
    check('live entries: source_period recorded', row?.source_period==='2026-08-01_2026-08-01', JSON.stringify(row));

    // --- idempotent re-run of the same range: no duplicates ---
    await setPages([[fakeEntry('real-entry-aaaa1111')],[fakeEntry('real-entry-bbbb2222')],[fakeEntry('real-entry-cccc3333')]]);
    x = await backfill('2026-08-01','2026-08-01');
    check('live entries: re-run updates, does not duplicate', x.body.recordsInserted===0 && x.body.recordsUpdated===3, JSON.stringify(x.body));

    await setPages([[fakeEntry('outside-september',{performedAt:'2026-08-31T12:00:00Z',settledAt:'2026-09-01T12:00:00Z'}),fakeEntry('july-settled-august',{performedAt:'2026-07-31T12:00:00Z',settledAt:'2026-08-01T12:00:00Z'})]]);
    x=await backfill('2026-08-01','2026-08-31');
    check('settlement range: includes July purchase settled August and skips September without stopping early',x.body.recordsFetched===1&&x.body.recordsInserted===1,JSON.stringify(x.body));
    const searchBody=fake.searchBodies.filter(b=>b.settledAtStart).at(-1);
    check('settlement range: upstream receives settledAt filters, not performedAt',searchBody?.settledAtStart==='2026-08-01T00:00:00.000Z'&&searchBody?.settledAtEnd==='2026-08-31T23:59:59.999Z'&&!searchBody.performedAtStart,JSON.stringify(searchBody));

    // --- hard fixture-exclusion gate: a demo-hist-* ID in a "live" (mock-off) run must FAIL, not insert ---
    await setPages([[fakeEntry('demo-hist-2026-08-0099')]]);
    x = await backfill('2026-08-01','2026-08-01');
    check('fixture exclusion: live run encountering a demo ID fails loudly', x.status>=500, `got ${x.status}: ${JSON.stringify(x.body)}`);
    const afterList = await fetch(base+'/api/transactions?limit=50',{headers:{Cookie:cookie}}).then(r=>r.json());
    check('fixture exclusion: the demo-shaped id was never inserted', !afterList.rows.some(r=>r.pleo_accounting_entry_id==='demo-hist-2026-08-0099'));
  } finally { await stop(proc, dir); fake.server.close(); }
}

// === Scenario 7: a sync run stuck RUNNING when the process dies must become
// INTERRUPTED on the next startup, never look permanently active ===
async function testStaleRunningSweep(){
  const dir = tmpDir('jsan-pleo-stale-');
  const port = 41007; const base = `http://127.0.0.1:${port}`;
  let proc = spawnApp(port, { PLEO_MOCK_MODE:'true', PLEO_COMPANY_ID:'00000000-0000-0000-0000-000000000001', PLEO_SYNC_ON_START:'false', PLEO_AUTO_SYNC:'false' }, dir);
  try{
    await waitHealth(base, proc);
    const dbPath = path.join(dir,'app.db');
    // Simulate a process that died mid-sync: insert a RUNNING row directly.
    killTree(proc);
    await new Promise(r=>setTimeout(r,400));
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(dbPath);
    db.prepare("INSERT INTO pleo_sync_runs(mode,trigger_type,triggered_by,status,started_at) VALUES(?,?,?,?,?)").run('accounting_entries_v1','manual',null,'RUNNING',new Date().toISOString());
    db.close();
    // Restart against the same DB — the stale RUNNING row must not survive.
    proc = spawnApp(port, { PLEO_MOCK_MODE:'true', PLEO_COMPANY_ID:'00000000-0000-0000-0000-000000000001', PLEO_SYNC_ON_START:'false', PLEO_AUTO_SYNC:'false' }, dir);
    await waitHealth(base, proc);
    const cookie = await asAdmin(base);
    const status = await fetch(base+'/api/pleo/status',{headers:{Cookie:cookie}}).then(r=>r.json());
    check('stale sweep: no RUNNING run survives a restart', !status.history.some(r=>r.status==='RUNNING'), JSON.stringify(status.history.map(r=>r.status)));
    check('stale sweep: the orphaned run became INTERRUPTED', status.history.some(r=>r.status==='INTERRUPTED'), JSON.stringify(status.history.map(r=>r.status)));
  } finally { await stop(proc, dir); }
}

// === Scenario 8: receipt enrichment is decoupled from ingestion — a receipt
// failure must never fail the sync, cached receipts are never refetched, and
// failures are bounded ===
async function testReceiptEnrichmentDecoupling(){
  const dir = tmpDir('jsan-pleo-receipts-');
  const port = 41008; const base = `http://127.0.0.1:${port}`;
  const fake = await startFakePleo();
  const fakeBase = `http://127.0.0.1:${fake.port}`;
  const proc = spawnApp(port, { PLEO_MOCK_MODE:'false', PLEO_API_KEY:FAKE_KEY, PLEO_COMPANY_ID:VALID_UUID, PLEO_API_BASE:fakeBase, PLEO_SYNC_ON_START:'false', PLEO_AUTO_SYNC:'false', PLEO_RECEIPT_CONCURRENCY:'2', PLEO_RECEIPT_MAX_ATTEMPTS:'1' }, dir);
  try{
    await waitHealth(base, proc);
    const cookie = await asAdmin(base);
    const backfill = async (dateFrom,dateTo) => {
      const start = await fetch(base+'/api/pleo/backfill',{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify({dateFrom,dateTo})});
      const startBody = await start.json();
      let run; for(let i=0;i<50;i++){ const r=await fetch(base+`/api/pleo/sync-runs/${startBody.runId}`,{headers:{Cookie:cookie}}); const p=await r.json(); run=p.run; if(run.status!=='RUNNING') break; await new Promise(res=>setTimeout(res,100)); }
      return run;
    };
    const setPages = async pages => { await fetch(fakeBase+'/_test/set-entries-pages',{method:'POST',body:JSON.stringify({pages})}); };
    const setReceiptMode = async m => { await fetch(fakeBase+'/_test/set-receipt-mode',{method:'POST',body:JSON.stringify({mode:m})}); };
    const { DatabaseSync } = await import('node:sqlite');

    // --- Ingestion must succeed even though every receipt fetch fails ---
    await setReceiptMode('fail-always');
    await setPages([[fakeEntry('recpt-entry-0001',{receiptIds:['r1','r2']})]]);
    let run = await backfill('2026-08-01','2026-08-01');
    check('decoupling: transaction sync SUCCEEDS despite every receipt failing', run.status==='SUCCESS', JSON.stringify(run));
    check('decoupling: the transaction itself was inserted', run.inserted_count===1, JSON.stringify(run));

    await new Promise(r=>setTimeout(r,3500)); // let the background worker's next tick process the queue
    let db = new DatabaseSync(path.join(dir,'app.db'));
    let jobs = db.prepare("SELECT * FROM receipt_jobs WHERE pleo_accounting_entry_id='recpt-entry-0001'").all();
    check('decoupling: a receipt_jobs row was created per receipt', jobs.length===2, JSON.stringify(jobs.map(j=>j.receipt_id)));
    check('decoupling: both jobs reached terminal FAILED (bounded, maxAttempts=1)', jobs.every(j=>j.status==='FAILED'), JSON.stringify(jobs.map(j=>j.status)));
    db.close();

    // --- Endpoint recovers; a fresh sync run is a deliberate retry of failed jobs ---
    await setReceiptMode('ok');
    await setPages([[fakeEntry('recpt-entry-0001',{receiptIds:['r1','r2']})]]);
    run = await backfill('2026-08-01','2026-08-01');
    check('decoupling: re-run still SUCCESS', run.status==='SUCCESS');
    await new Promise(r=>setTimeout(r,3500));
    db = new DatabaseSync(path.join(dir,'app.db'));
    jobs = db.prepare("SELECT * FROM receipt_jobs WHERE pleo_accounting_entry_id='recpt-entry-0001'").all();
    check('decoupling: previously-failed jobs succeed once the endpoint recovers', jobs.every(j=>j.status==='AVAILABLE'), JSON.stringify(jobs.map(j=>j.status)));
    db.close();
    const hitsAfterRecovery = fake.receiptHits();

    // --- Cached-skip: a later sync must not refetch already-AVAILABLE receipts ---
    await setPages([[fakeEntry('recpt-entry-0001',{receiptIds:['r1','r2']})]]);
    await backfill('2026-08-01','2026-08-01');
    await new Promise(r=>setTimeout(r,1000));
    check('decoupling: cached receipts are not refetched on a later sync', fake.receiptHits()===hitsAfterRecovery, `before=${hitsAfterRecovery} after=${fake.receiptHits()}`);
  } finally { await stop(proc, dir); fake.server.close(); }
}

// === Scenario 9: controlled concurrency — never fetch all receipts at once ===
async function testReceiptConcurrency(){
  const dir = tmpDir('jsan-pleo-concurrency-');
  const port = 41009; const base = `http://127.0.0.1:${port}`;
  const fake = await startFakePleo();
  const fakeBase = `http://127.0.0.1:${fake.port}`;
  const CONCURRENCY = 2;
  const proc = spawnApp(port, { PLEO_MOCK_MODE:'false', PLEO_API_KEY:FAKE_KEY, PLEO_COMPANY_ID:VALID_UUID, PLEO_API_BASE:fakeBase, PLEO_SYNC_ON_START:'false', PLEO_AUTO_SYNC:'false', PLEO_RECEIPT_CONCURRENCY:String(CONCURRENCY) }, dir);
  try{
    await waitHealth(base, proc);
    const cookie = await asAdmin(base);
    const backfill = async (dateFrom,dateTo) => {
      const start = await fetch(base+'/api/pleo/backfill',{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify({dateFrom,dateTo})});
      const startBody = await start.json();
      let run; for(let i=0;i<50;i++){ const r=await fetch(base+`/api/pleo/sync-runs/${startBody.runId}`,{headers:{Cookie:cookie}}); const p=await r.json(); run=p.run; if(run.status!=='RUNNING') break; await new Promise(res=>setTimeout(res,100)); }
      return run;
    };
    const setPages = async pages => { await fetch(fakeBase+'/_test/set-entries-pages',{method:'POST',body:JSON.stringify({pages})}); };
    // One entry with 6 receipts — enough that a naive implementation would fire all 6 at once.
    await setPages([[fakeEntry('concurrency-entry-0001',{receiptIds:['a','b','c','d','e','f']})]]);
    const run = await backfill('2026-08-01','2026-08-01');
    check('concurrency: ingestion succeeds', run.status==='SUCCESS');
    await new Promise(r=>setTimeout(r,10000)); // drain 6 jobs at concurrency 2, ~150ms/job, across a few 3s worker ticks
    check('concurrency: never exceeded the configured limit', fake.receiptMaxConcurrent()<=CONCURRENCY, `max observed=${fake.receiptMaxConcurrent()} limit=${CONCURRENCY}`);
    check('concurrency: all 6 receipts were eventually fetched', fake.receiptHits()===6, `got ${fake.receiptHits()}`);
  } finally { await stop(proc, dir); fake.server.close(); }
}

// === Scenario 10: Tag Groups/Tags + Chart of Accounts reference-data sync,
// and that a real accountId (not splitItems, always empty on real data)
// resolves the transaction's category once synced. ===
async function testReferenceDataSync(){
  const dir = tmpDir('jsan-pleo-refdata-');
  const port = 41010; const base = `http://127.0.0.1:${port}`;
  const fake = await startFakePleo();
  const fakeBase = `http://127.0.0.1:${fake.port}`;
  const proc = spawnApp(port, { PLEO_MOCK_MODE:'false', PLEO_API_KEY:FAKE_KEY, PLEO_COMPANY_ID:VALID_UUID, PLEO_API_BASE:fakeBase, PLEO_SYNC_ON_START:'false', PLEO_AUTO_SYNC:'false' }, dir);
  try{
    await waitHealth(base, proc);
    const cookie = await asAdmin(base);

    const r = await fetch(base+'/api/pleo/sync-reference-data',{method:'POST',headers:{Cookie:cookie}}); const p = await r.json();
    check('reference-data sync -> 200 OK', r.status===200, JSON.stringify(p));
    check('reference-data sync -> tagGroups OK, 2 fetched', p.tagGroups.status==='OK' && p.tagGroups.recordsFetched===2 && p.tagGroups.inserted===2, JSON.stringify(p.tagGroups));
    check('reference-data sync -> tags OK, 3 fetched', p.tags.status==='OK' && p.tags.recordsFetched===3 && p.tags.inserted===3, JSON.stringify(p.tags));
    check('reference-data sync -> chartOfAccounts OK, 2 fetched', p.chartOfAccounts.status==='OK' && p.chartOfAccounts.recordsFetched===2 && p.chartOfAccounts.inserted===2, JSON.stringify(p.chartOfAccounts));

    // Re-running must report updates, not duplicate inserts (idempotency).
    const r2 = await fetch(base+'/api/pleo/sync-reference-data',{method:'POST',headers:{Cookie:cookie}}); const p2 = await r2.json();
    check('reference-data sync: re-run updates, does not duplicate', p2.tagGroups.updated===2 && p2.tags.updated===3 && p2.chartOfAccounts.updated===2, JSON.stringify(p2));

    const reportR = await fetch(base+'/api/pleo/reference-data-report',{headers:{Cookie:cookie}}); const report = await reportR.json();
    check('reference-data report -> 200 OK', reportR.status===200, JSON.stringify(report));
    check('reference-data report -> lists both tag groups by name', report.tagGroups.map(g=>g.name).sort().join(',')==='Departments,Projects', JSON.stringify(report.tagGroups.map(g=>g.name)));
    const projGroup = report.tagGroups.find(g=>g.name==='Projects');
    check('reference-data report -> Projects group has 2 sample tags', projGroup && projGroup.tagCount===2, JSON.stringify(projGroup));
    check('reference-data report -> categoryCount is 2', report.categoryCount===2, JSON.stringify(report));

    // Backfill a real accounting entry whose accountId matches a synced
    // category — category must resolve via Chart of Accounts, never via the
    // (always-empty-on-real-data) splitItems[].accountCode fallback.
    const setPages = async pages => { await fetch(fakeBase+'/_test/set-entries-pages',{method:'POST',body:JSON.stringify({pages})}); };
    await setPages([[fakeEntry('refdata-entry-0001',{accountId:'acct-fuel',splitItems:[]})]]);
    const start = await fetch(base+'/api/pleo/backfill',{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify({dateFrom:'2026-08-01',dateTo:'2026-08-01'})});
    const startBody = await start.json();
    let run; for(let i=0;i<50;i++){ const rr=await fetch(base+`/api/pleo/sync-runs/${startBody.runId}`,{headers:{Cookie:cookie}}); const pp=await rr.json(); run=pp.run; if(run.status!=='RUNNING') break; await new Promise(res=>setTimeout(res,100)); }
    check('backfill with empty splitItems still succeeds', run.status==='SUCCESS', JSON.stringify(run));
    const txR = await fetch(base+'/api/transactions?limit=50',{headers:{Cookie:cookie}}); const txP = await txR.json();
    const tx = txP.rows.find(t=>t.pleo_accounting_entry_id==='refdata-entry-0001');
    check('category resolves via accountId -> Chart of Accounts, not splitItems', Boolean(tx) && tx.category==='Fuel', JSON.stringify(tx));
  } finally { await stop(proc, dir); fake.server.close(); }
}

// === Scenario 11: Billing Status -> Commercial Classification mapping,
// JSAN Project Master, project mapping rules, and the data-quality-gate
// evidence endpoint. Billing Status is the real, actively-used tag group on
// production (confirmed by the reference-data gate) — never "Project". ===
async function testBillingStatusAndProjectMaster(){
  const dir = tmpDir('jsan-pleo-billing-');
  const port = 41011; const base = `http://127.0.0.1:${port}`;
  const fake = await startFakePleo();
  const fakeBase = `http://127.0.0.1:${fake.port}`;
  const proc = spawnApp(port, { PLEO_MOCK_MODE:'false', PLEO_API_KEY:FAKE_KEY, PLEO_COMPANY_ID:VALID_UUID, PLEO_API_BASE:fakeBase, PLEO_SYNC_ON_START:'false', PLEO_AUTO_SYNC:'false' }, dir);
  try{
    await waitHealth(base, proc);
    const cookie = await asAdmin(base);
    // Mirror the real tenant's actual (non-archived, actively-used) tag group.
    await fetch(fakeBase+'/_test/set-reference-data',{method:'POST',body:JSON.stringify({
      tagGroups:[{id:'grp-billing',name:'Billing Status',code:'Region',archived:false}],
      tagsByGroup:{'grp-billing':[
        {id:'tag-billable',groupId:'grp-billing',name:'Billable to Customer · 1',code:'1',archived:false},
        {id:'tag-jsan-internal',groupId:'grp-billing',name:'JSAN Internal Expense · 5',code:'5',archived:false},
        {id:'tag-refund',groupId:'grp-billing',name:'Refund · 8',code:'8',archived:false},
        // Regression guard: this real tag name contains "Billable to Customer"
        // as a substring — a naive un-anchored /billable to customer/i pattern
        // wrongly classified this as CUSTOMER_BILLABLE instead of
        // PROJECT_NON_BILLABLE (caught via the real production gate run).
        {id:'tag-project-nonbillable',groupId:'grp-billing',name:'Project Expense – Non-Billable to Customer · 2',code:'2',archived:false},
      ]},
    })});
    const syncR = await fetch(base+'/api/pleo/sync-reference-data',{method:'POST',headers:{Cookie:cookie}}); const syncP = await syncR.json();
    check('billing sync: tags OK', syncP.tags.status==='OK' && syncP.tags.recordsFetched===4, JSON.stringify(syncP.tags));
    check('billing sync: auto-seeds 4 known mappings', syncP.billingStatusSeed?.seeded===4, JSON.stringify(syncP.billingStatusSeed));

    const mapR = await fetch(base+'/api/admin/billing-status-mapping',{headers:{Cookie:cookie}}); const mapP = await mapR.json();
    check('billing-status-mapping: group found', mapP.groupFound===true, JSON.stringify(mapP));
    check('billing-status-mapping: all 4 tags mapped', mapP.tags.every(t=>t.spendops_classification), JSON.stringify(mapP.tags));
    const projectNonBillable = mapP.tags.find(t=>t.name.includes('Non-Billable to Customer'));
    check('billing-status-mapping: Non-Billable-to-Customer -> PROJECT_NON_BILLABLE, not CUSTOMER_BILLABLE', projectNonBillable?.spendops_classification==='PROJECT_NON_BILLABLE', JSON.stringify(projectNonBillable));
    const billable = mapP.tags.find(t=>t.name.includes('Billable to Customer'));
    check('billing-status-mapping: Billable to Customer -> CUSTOMER_BILLABLE', billable?.spendops_classification==='CUSTOMER_BILLABLE', JSON.stringify(billable));

    // An admin can override a seeded mapping; this must trigger a recompute.
    const overrideR = await fetch(base+'/api/admin/billing-status-mapping',{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify({pleo_tag_id:'tag-refund',classification:'REFUND_OVERRIDDEN'})});
    const overrideP = await overrideR.json();
    check('billing-status-mapping: admin override accepted', overrideR.status===200 && overrideP.ok===true, JSON.stringify(overrideP));

    // Ingest a real-shaped entry carrying the Billing Status tag — its derived
    // classification must come from the mapping, and the raw tag preserved.
    const setPages = async pages => { await fetch(fakeBase+'/_test/set-entries-pages',{method:'POST',body:JSON.stringify({pages})}); };
    await setPages([[fakeEntry('billing-entry-0001',{tags:[{tagGroupId:'grp-billing',tagId:'tag-billable'}],splitItems:[]})]]);
    const start = await fetch(base+'/api/pleo/backfill',{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify({dateFrom:'2026-08-01',dateTo:'2026-08-01'})});
    const startBody = await start.json();
    let run; for(let i=0;i<50;i++){ const rr=await fetch(base+`/api/pleo/sync-runs/${startBody.runId}`,{headers:{Cookie:cookie}}); const pp=await rr.json(); run=pp.run; if(run.status!=='RUNNING') break; await new Promise(res=>setTimeout(res,100)); }
    check('billing ingestion: backfill succeeds', run.status==='SUCCESS', JSON.stringify(run));
    const txR = await fetch(base+'/api/transactions?limit=50',{headers:{Cookie:cookie}}); const txP = await txR.json();
    const tx = txP.rows.find(t=>t.pleo_accounting_entry_id==='billing-entry-0001');
    check('billing ingestion: classification_status CLASSIFIED', tx?.classification_status==='CLASSIFIED', JSON.stringify(tx));
    check('billing ingestion: derived classification CUSTOMER_BILLABLE', tx?.commercial_classification_derived==='CUSTOMER_BILLABLE', JSON.stringify(tx));
    check('billing ingestion: raw Pleo tag name preserved', tx?.pleo_billing_status_tag_name==='Billable to Customer · 1', JSON.stringify(tx));
    check('billing ingestion: dq_missing_classification is 0', tx?.dq_missing_classification===0, JSON.stringify(tx));
    check('billing ingestion: dq_missing_project is 1 (no active Project tag group)', tx?.dq_missing_project===1, JSON.stringify(tx));
    check('billing ingestion: project_status MISSING_PROJECT', tx?.project_status==='MISSING_PROJECT', JSON.stringify(tx));

    // A transaction with no Billing Status tag at all -> MISSING_CLASSIFICATION,
    // never silently "Uncategorized".
    await setPages([[fakeEntry('billing-entry-0002',{tags:[],splitItems:[]})]]);
    const start2 = await fetch(base+'/api/pleo/backfill',{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify({dateFrom:'2026-08-01',dateTo:'2026-08-01'})});
    const startBody2 = await start2.json();
    for(let i=0;i<50;i++){ const rr=await fetch(base+`/api/pleo/sync-runs/${startBody2.runId}`,{headers:{Cookie:cookie}}); const pp=await rr.json(); if(pp.run.status!=='RUNNING') break; await new Promise(res=>setTimeout(res,100)); }
    const txR2 = await fetch(base+'/api/transactions?limit=50',{headers:{Cookie:cookie}}); const txP2 = await txR2.json();
    const tx2 = txP2.rows.find(t=>t.pleo_accounting_entry_id==='billing-entry-0002');
    check('no-tag entry: classification_status MISSING_CLASSIFICATION', tx2?.classification_status==='MISSING_CLASSIFICATION', JSON.stringify(tx2));
    check('no-tag entry: dq_missing_classification is 1', tx2?.dq_missing_classification===1, JSON.stringify(tx2));

    // === JSAN Project Master + mapping rules framework ===
    const createProjR = await fetch(base+'/api/projects',{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify({code:'GSR',name:'GSR Engagement',customer:'Acme'})});
    check('project master: create -> 201', createProjR.status===201, JSON.stringify(await createProjR.json()));
    const listProjR = await fetch(base+'/api/admin/projects',{headers:{Cookie:cookie}}); const listProjP = await listProjR.json();
    const gsr = listProjP.rows.find(p=>p.code==='GSR');
    check('project master: list includes new project with default status ACTIVE', gsr?.status==='ACTIVE', JSON.stringify(gsr));

    const patchR = await fetch(base+`/api/admin/projects/${gsr.id}`,{method:'PATCH',headers:{Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify({project_manager:'J. Doe',country:'GB',commercial_model:'TIME_AND_MATERIALS'})});
    const patchP = await patchR.json();
    check('project master: PATCH accepted', patchR.status===200 && patchP.ok===true, JSON.stringify(patchP));
    const listProjR2 = await fetch(base+'/api/admin/projects',{headers:{Cookie:cookie}}); const gsr2 = (await listProjR2.json()).rows.find(p=>p.code==='GSR');
    check('project master: PATCH persisted project_manager', gsr2?.project_manager==='J. Doe', JSON.stringify(gsr2));

    const proposeR = await fetch(base+'/api/admin/project-mapping-rules',{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify({source_type:'PLEO_TEAM',source_value:'GSR-2',project_id:gsr.id})});
    const proposeP = await proposeR.json();
    check('project mapping rule: propose -> 201', proposeR.status===201, JSON.stringify(proposeP));
    const rulesR = await fetch(base+'/api/admin/project-mapping-rules',{headers:{Cookie:cookie}}); const rulesP = await rulesR.json();
    const rule = rulesP.rows.find(r=>r.id===proposeP.id);
    check('project mapping rule: listed as PROPOSED', rule?.status==='PROPOSED', JSON.stringify(rule));
    const approveR = await fetch(base+`/api/admin/project-mapping-rules/${proposeP.id}/approve`,{method:'POST',headers:{Cookie:cookie}});
    check('project mapping rule: approve -> 200', approveR.status===200, JSON.stringify(await approveR.json()));
    const rulesR2 = await fetch(base+'/api/admin/project-mapping-rules',{headers:{Cookie:cookie}}); const rule2 = (await rulesR2.json()).rows.find(r=>r.id===proposeP.id);
    check('project mapping rule: now APPROVED with approver recorded', rule2?.status==='APPROVED' && Boolean(rule2.approved_by), JSON.stringify(rule2));

    // === Hard-gate evidence endpoint ===
    const gateR = await fetch(base+'/api/analytics/data-quality-gate',{headers:{Cookie:cookie}}); const gateP = await gateR.json();
    check('data-quality-gate: 200 OK', gateR.status===200, JSON.stringify(gateP));
    check('data-quality-gate: commercialClassification tags=4 mapped=4', gateP.commercialClassification.billingStatusTags===4 && gateP.commercialClassification.mapped===4, JSON.stringify(gateP.commercialClassification));
    check('data-quality-gate: category counts present', typeof gateP.category.resolved==='number' && typeof gateP.category.accountIdNotFound==='number', JSON.stringify(gateP.category));
    check('data-quality-gate: dataQuality.missingProject counts live rows', gateP.dataQuality.missingProject>=2, JSON.stringify(gateP.dataQuality));
    check('data-quality-gate: dataQuality.missingClassification is 1', gateP.dataQuality.missingClassification===1, JSON.stringify(gateP.dataQuality));
  } finally { await stop(proc, dir); fake.server.close(); }
}

// === Scenario 12: attribution & resolution precedence — ingestion must never
// downgrade a verified project assignment or blank a historical category,
// and stale dq_* flags must rebuild correctly from current canonical state.
// This is a direct regression test for the exact live bug found: 55,774/55,774
// live rows had dq_missing_project=0 despite project_status='MISSING_PROJECT'
// on all of them, because nothing had ever backfilled the flag. ===
async function testAttributionPrecedenceAndQualityFlags(){
  const dir = tmpDir('jsan-pleo-precedence-');
  const port = 41012; const base = `http://127.0.0.1:${port}`;
  const fake = await startFakePleo();
  const fakeBase = `http://127.0.0.1:${fake.port}`;
  const proc = spawnApp(port, { PLEO_MOCK_MODE:'false', PLEO_API_KEY:FAKE_KEY, PLEO_COMPANY_ID:VALID_UUID, PLEO_API_BASE:fakeBase, PLEO_SYNC_ON_START:'false', PLEO_AUTO_SYNC:'false' }, dir);
  try{
    await waitHealth(base, proc);
    const cookie = await asAdmin(base);
    // Populate pleo_categories from the fake upstream's defaults (acct-fuel
    // -> "Fuel", acct-travel -> "Travel") so 12d can exercise a real
    // live-resolves case, not just the unresolved-accountId cases.
    await fetch(base+'/api/pleo/sync-reference-data',{method:'POST',headers:{Cookie:cookie}});
    const { DatabaseSync } = await import('node:sqlite');
    const dbPath = path.join(dir,'app.db');
    const setPages = async pages => { await fetch(fakeBase+'/_test/set-entries-pages',{method:'POST',body:JSON.stringify({pages})}); };
    const backfill = async (dateFrom,dateTo) => {
      const start = await fetch(base+'/api/pleo/backfill',{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify({dateFrom,dateTo})});
      const startBody = await start.json();
      let run; for(let i=0;i<50;i++){ const r=await fetch(base+`/api/pleo/sync-runs/${startBody.runId}`,{headers:{Cookie:cookie}}); const p=await r.json(); run=p.run; if(run.status!=='RUNNING') break; await new Promise(res=>setTimeout(res,100)); }
      return run;
    };
    const txByEntry = async entryId => {
      const p = await fetch(base+'/api/transactions?limit=50',{headers:{Cookie:cookie}}).then(r=>r.json());
      return p.rows.find(r=>r.pleo_accounting_entry_id===entryId);
    };

    // --- 12a: a MANUAL project assignment survives a resync that carries no
    // project evidence at all (incoming is always UNMAPPED — no manual-assign
    // or rule-application endpoint exists yet, so this simulates the future
    // state directly via the DB, same technique as testStaleRunningSweep). ---
    await setPages([[fakeEntry('precedence-manual-0001',{accountId:null,splitItems:[]})]]);
    let run = await backfill('2026-08-01','2026-08-01');
    check('precedence: initial ingest succeeds (manual case)', run.status==='SUCCESS', JSON.stringify(run));
    let tx = await txByEntry('precedence-manual-0001');
    check('precedence: freshly ingested row starts MISSING_PROJECT', tx?.project_status==='MISSING_PROJECT', JSON.stringify(tx));
    {
      const db = new DatabaseSync(dbPath);
      db.prepare("UPDATE transactions SET project_id=?,project_attribution_source='MANUAL',project_status='ASSIGNED',project_attributed_at=?,project_attributed_by=1 WHERE id=?")
        .run(9001, new Date().toISOString(), tx.id);
      db.close();
    }
    await setPages([[fakeEntry('precedence-manual-0001',{accountId:null,splitItems:[]})]]);
    run = await backfill('2026-08-01','2026-08-01');
    check('precedence: resync after MANUAL assignment succeeds', run.status==='SUCCESS', JSON.stringify(run));
    tx = await txByEntry('precedence-manual-0001');
    check('precedence: MANUAL project_id survives a resync with no project evidence', tx?.project_id===9001, JSON.stringify(tx));
    check('precedence: MANUAL project_status survives (still ASSIGNED, not reset)', tx?.project_status==='ASSIGNED', JSON.stringify(tx));
    check('precedence: MANUAL attribution_source survives', tx?.project_attribution_source==='MANUAL', JSON.stringify(tx));

    // --- 12b: same, for an APPROVED_MAPPING_RULE-sourced assignment ---
    await setPages([[fakeEntry('precedence-rule-0001',{accountId:null,splitItems:[]})]]);
    run = await backfill('2026-08-01','2026-08-01');
    tx = await txByEntry('precedence-rule-0001');
    {
      const db = new DatabaseSync(dbPath);
      db.prepare("UPDATE transactions SET project_id=?,project_attribution_source='APPROVED_MAPPING_RULE',project_status='ASSIGNED',project_mapping_rule_id=7 WHERE id=?").run(9002, tx.id);
      db.close();
    }
    await setPages([[fakeEntry('precedence-rule-0001',{accountId:null,splitItems:[]})]]);
    run = await backfill('2026-08-01','2026-08-01');
    tx = await txByEntry('precedence-rule-0001');
    check('precedence: APPROVED_MAPPING_RULE project_id survives a resync', tx?.project_id===9002 && tx?.project_status==='ASSIGNED', JSON.stringify(tx));
    check('precedence: APPROVED_MAPPING_RULE rule id survives', tx?.project_mapping_rule_id===7, JSON.stringify(tx));

    // --- 12c: an unresolved live category cannot erase historical evidence;
    // both facts stay visible (historical value shown, live gap still named). ---
    await setPages([[fakeEntry('precedence-hist-0001',{accountId:'acct-unknown-xyz',splitItems:[]})]]);
    run = await backfill('2026-08-01','2026-08-01');
    tx = await txByEntry('precedence-hist-0001');
    check('precedence: unresolved accountId -> ACCOUNT_ID_NOT_IN_REFERENCE_DATA', tx?.category_resolution_status==='ACCOUNT_ID_NOT_IN_REFERENCE_DATA', JSON.stringify(tx));
    check('precedence: no historical evidence yet -> resolved_category_name null', tx?.resolved_category_name==null, JSON.stringify(tx));
    {
      const db = new DatabaseSync(dbPath);
      db.prepare("UPDATE transactions SET historical_category_name='Fuel' WHERE id=?").run(tx.id);
      db.close();
    }
    await setPages([[fakeEntry('precedence-hist-0001',{accountId:'acct-unknown-xyz',splitItems:[]})]]);
    run = await backfill('2026-08-01','2026-08-01');
    tx = await txByEntry('precedence-hist-0001');
    check('precedence: historical evidence NOT erased by unresolved live sync', tx?.historical_category_name==='Fuel', JSON.stringify(tx));
    check('precedence: resolved_category_name falls back to historical value', tx?.resolved_category_name==='Fuel', JSON.stringify(tx));
    check('precedence: resolution source is VERIFIED_HISTORICAL_EXPORT_CATEGORY', tx?.category_resolution_source==='VERIFIED_HISTORICAL_EXPORT_CATEGORY', JSON.stringify(tx));
    check('precedence: live diagnostic status still names the real gap', tx?.category_resolution_status==='ACCOUNT_ID_NOT_IN_REFERENCE_DATA', JSON.stringify(tx));

    // --- 12d: when live DOES resolve, it wins over historical, but historical
    // evidence is still retained (not overwritten, just outranked). ---
    await setPages([[fakeEntry('precedence-hist-0002',{accountId:'acct-unknown-abc',splitItems:[]})]]);
    run = await backfill('2026-08-01','2026-08-01');
    tx = await txByEntry('precedence-hist-0002');
    {
      const db = new DatabaseSync(dbPath);
      db.prepare("UPDATE transactions SET historical_category_name='Old Travel Label' WHERE id=?").run(tx.id);
      db.close();
    }
    await setPages([[fakeEntry('precedence-hist-0002',{accountId:'acct-fuel',splitItems:[]})]]);
    run = await backfill('2026-08-01','2026-08-01');
    tx = await txByEntry('precedence-hist-0002');
    check('precedence: live-resolved category wins over historical', tx?.resolved_category_name==='Fuel', JSON.stringify(tx));
    check('precedence: resolution source is PLEO_RESOLVED_ACCOUNT', tx?.category_resolution_source==='PLEO_RESOLVED_ACCOUNT', JSON.stringify(tx));
    check('precedence: historical evidence still retained, just outranked', tx?.historical_category_name==='Old Travel Label', JSON.stringify(tx));

    // --- 12e: stale dq flags rebuild correctly via the bulk recalculation
    // endpoint — this is the direct regression test for the live bug found. ---
    await setPages([[fakeEntry('precedence-stale-0001',{accountId:null,splitItems:[]})]]);
    run = await backfill('2026-08-01','2026-08-01');
    tx = await txByEntry('precedence-stale-0001');
    check('precedence: fresh ingest already has correct dq_missing_project', tx?.dq_missing_project===1, JSON.stringify(tx));
    {
      // Simulate the exact live drift found: dq_missing_project stuck at 0
      // despite project_status='MISSING_PROJECT' (e.g. a column added after
      // the row was first written, never backfilled).
      const db = new DatabaseSync(dbPath);
      db.prepare("UPDATE transactions SET dq_missing_project=0 WHERE id=?").run(tx.id);
      db.close();
    }
    tx = await txByEntry('precedence-stale-0001');
    check('precedence: stale flag confirmed forced to 0 before recalculation', tx?.dq_missing_project===0, JSON.stringify(tx));
    const recalcR = await fetch(base+'/api/admin/recalculate-quality-flags',{method:'POST',headers:{Cookie:cookie}});
    const recalcP = await recalcR.json();
    check('precedence: recalculate-quality-flags -> 200 OK', recalcR.status===200 && recalcP.ok===true, JSON.stringify(recalcP));
    tx = await txByEntry('precedence-stale-0001');
    check('precedence: dq_missing_project rebuilt to 1 from current project_status', tx?.dq_missing_project===1, JSON.stringify(tx));

    // --- 12f: regression guard — reviewer/workflow fields already correctly
    // ingestion-safe (server.js section 8) must stay that way. ---
    await setPages([[fakeEntry('precedence-workflow-0001',{accountId:null,splitItems:[]})]]);
    run = await backfill('2026-08-01','2026-08-01');
    tx = await txByEntry('precedence-workflow-0001');
    {
      const db = new DatabaseSync(dbPath);
      db.prepare("UPDATE transactions SET reviewer_id=1,status='APPROVED',decision='APPROVED',commercial_classification='CUSTOMER_BILLABLE',project_code='HERE-UK',reviewer_notes='Verified by QC' WHERE id=?").run(tx.id);
      db.close();
    }
    await setPages([[fakeEntry('precedence-workflow-0001',{accountId:null,splitItems:[]})]]);
    run = await backfill('2026-08-01','2026-08-01');
    tx = await txByEntry('precedence-workflow-0001');
    check('precedence: reviewer_id survives resync', tx?.reviewer_id===1, JSON.stringify(tx));
    check('precedence: status survives resync', tx?.status==='APPROVED', JSON.stringify(tx));
    check('precedence: decision survives resync', tx?.decision==='APPROVED', JSON.stringify(tx));
    check('precedence: manual commercial_classification survives resync', tx?.commercial_classification==='CUSTOMER_BILLABLE', JSON.stringify(tx));
    check('precedence: legacy project_code survives resync', tx?.project_code==='HERE-UK', JSON.stringify(tx));
    check('precedence: reviewer_notes survives resync', tx?.reviewer_notes==='Verified by QC', JSON.stringify(tx));
  } finally { await stop(proc, dir); fake.server.close(); }
}

async function testLiveSettlementCheckpoint(){
  const dir=tmpDir('jsan-live-settlement-'),port=41013,base='http://127.0.0.1:'+port;
  const fake=await startFakePleo(),fakeBase='http://127.0.0.1:'+fake.port;
  const proc=spawnApp(port,{PLEO_MOCK_MODE:'false',PLEO_API_KEY:FAKE_KEY,PLEO_COMPANY_ID:VALID_UUID,PLEO_API_BASE:fakeBase,PLEO_SYNC_MODE:'accounting_entries_v1',PLEO_AUTO_SYNC:'false',PLEO_SYNC_ON_START:'false'},dir);
  let db;
  try{
    await waitHealth(base,proc);const cookie=await asAdmin(base);
    const {DatabaseSync}=await import('node:sqlite');db=new DatabaseSync(path.join(dir,'app.db'));
    db.prepare('INSERT INTO app_kv(key,value,updated_at) VALUES(?,?,?)').run('pleo_accounting_entries_last_success','2099-01-01T00:00:00Z',new Date().toISOString());
    const setPages=async pages=>{await fetch(fakeBase+'/_test/set-entries-pages',{method:'POST',body:JSON.stringify({pages})})};
    const run=async()=>{
      const start=await fetch(base+'/api/pleo/sync',{method:'POST',headers:{Cookie:cookie}}).then(r=>r.json());
      for(let i=0;i<100;i++){
        const p=await fetch(base+'/api/pleo/sync-runs/'+start.runId,{headers:{Cookie:cookie}}).then(r=>r.json());
        if(p.run.status!=='RUNNING')return p.run;
        await new Promise(r=>setTimeout(r,50));
      }throw Error('Live sync timed out');
    };
    const entry=fakeEntry('live-late-settlement',{performedAt:'2020-01-01T00:00:00Z',settledAt:new Date(Date.now()-1800000).toISOString()});
    await setPages([[entry],{error:500}]);let result=await run();
    check('live checkpoint: failed page marks run FAILED',result.status==='FAILED');
    check('live checkpoint: partial import never advances checkpoint',!db.prepare('SELECT value FROM app_kv WHERE key=?').get('pleo_accounting_entries_settled_last_success'));
    await setPages([[entry],[fakeEntry('live-second-page',{settledAt:entry.settledAt})]]);result=await run();
    check('live checkpoint: retry refreshes partial row without duplicating',result.status==='SUCCESS'&&result.inserted_count===1&&result.updated_count===1,JSON.stringify(result));
    const checkpoint=db.prepare('SELECT value FROM app_kv WHERE key=?').get('pleo_accounting_entries_settled_last_success').value;
    const body=fake.searchBodies.filter(b=>b.settledAtStart).at(-1);
    check('live sync: purchase-date checkpoint ignored; settlement bounds used',Boolean(body.settledAtStart&&body.settledAtEnd&&!body.performedAtStart)&&Date.parse(body.settledAtStart)<Date.parse(entry.settledAt));
    check('live checkpoint: complete range checkpoint equals upper bound',checkpoint===body.settledAtEnd);
    await setPages([[entry]]);result=await run();
    const refreshed=fake.searchBodies.filter(b=>b.settledAtStart).at(-1),now=new Date();
    check('live sync: retains configured incremental overlap',Date.parse(refreshed.settledAtStart)===Date.parse(checkpoint)-3600000);
    check('live sync: repeated import remains idempotent',result.inserted_count===0&&result.updated_count===1);
    fake.setPending([fakeEntry('new-pending-entry',{status:'PENDING',settledAt:null,performedAt:'2026-08-15T10:00:00Z',totalBillValue:null})]);
    await setPages([]);result=await run();
    check('pending sync: imports entries outside settlement window',result.status==='SUCCESS'&&result.inserted_count===1,JSON.stringify(result));
    let pending=await fetch(base+'/api/transactions?pleo_status=PENDING',{headers:{Cookie:cookie}}).then(r=>r.json());
    check('pending filter: pending entry details and provisional amount returned',pending.total===1&&pending.rows[0].amount===50&&pending.rows[0].bill_amount==null&&pending.rows[0].merchant==='Fake Merchant',JSON.stringify(pending));
    check('pending count: shortcut has accessible pending total',pending.pendingTotal===1);
    await setPages([]);result=await run();
    check('pending sync: idempotent refresh',result.inserted_count===0&&result.updated_count===1);
    fake.setPending([]);await setPages([[fakeEntry('new-pending-entry',{status:'COMPLETED',settledAt:new Date(Date.now()-1000).toISOString(),totalBillValue:{minors:-5000,currency:'GBP'}})]]);result=await run();
    pending=await fetch(base+'/api/transactions?pleo_status=PENDING',{headers:{Cookie:cookie}}).then(r=>r.json());
    check('pending sync: settled entry leaves pending filter without duplicate',pending.total===0&&result.inserted_count===0);

  }finally{db?.close();await stop(proc,dir);fake.server.close();}
}

try{
  await testMissingConfig();
  await testInvalidCompanyId();
  await testHttpClassificationAndStartupGate();
  await testCompanyTest();
  await testCompanyTestMockMode();
  await testLiveAccountingEntriesProvenanceAndPagination();
  await testLiveSettlementCheckpoint();
  await testStaleRunningSweep();
  await testReceiptEnrichmentDecoupling();
  await testReceiptConcurrency();
  await testReferenceDataSync();
  await testBillingStatusAndProjectMaster();
  await testAttributionPrecedenceAndQualityFlags();
} catch(e){
  console.log('FAIL - unexpected exception: ' + e.message);
  failures++;
}

console.log(failures===0 ? `\nAll Pleo connector tests passed.` : `\n${failures} Pleo connector test(s) failed.`);
process.exit(failures===0 ? 0 : 1);
