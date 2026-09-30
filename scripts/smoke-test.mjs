import { spawn, execSync } from 'node:child_process';
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
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsan-spendops-smoke-'));
const port = 43917;
const base = `http://127.0.0.1:${port}`;
const nodeCommand = process.platform === 'win32' ? 'node' : process.execPath;
const server = spawn(nodeCommand, ['server.js'], {
  shell: process.platform === 'win32',
  cwd: root,
  env: {
    ...process.env,
    HOST: '127.0.0.1', PORT: String(port),
    DATABASE_PATH: path.join(dir, 'smoke.db'), ATTACHMENT_DIR: path.join(dir, 'attachments'),
    COOKIE_SECURE: 'false', PLEO_MOCK_MODE: 'true', PLEO_COMPANY_ID: '00000000-0000-0000-0000-000000000001',
    PLEO_SYNC_MODE: 'export_v2', PLEO_AUTO_SYNC: 'false', PLEO_SYNC_ON_START: 'false',
    DEMO_SEED: 'false'
  },
  stdio: ['ignore', 'pipe', 'pipe']
});

let stderr = '';
server.stderr.on('data', d => stderr += d);
function fail(msg){ throw new Error(msg + (stderr ? `\nServer stderr:\n${stderr}` : '')); }
async function waitHealth(){
  for(let i=0;i<80;i++){
    try{ const r=await fetch(base+'/api/health'); if(r.ok) return; }catch{}
    await new Promise(r=>setTimeout(r,100));
  }
  fail('Server did not become healthy');
}
function cookieFrom(r){ return (r.headers.get('set-cookie')||'').split(';')[0]; }
async function req(url,{method='GET',body,cookie,headers={}}={}){
  const r=await fetch(base+url,{method,headers:{Accept:'application/json',...(body!==undefined?{'Content-Type':'application/json'}:{}),...(cookie?{Cookie:cookie}:{}),...headers},body:body!==undefined?JSON.stringify(body):undefined});
  let p; try{p=await r.json()}catch{p={}};
  if(!r.ok) fail(`${method} ${url} -> ${r.status}: ${JSON.stringify(p)}`);
  return {r,p};
}

try{
  await waitHealth();
  let x=await req('/api/setup/admin',{method:'POST',body:{name:'Smoke Admin',email:'admin@jsan.test',password:'AdminPassword!2026'}});
  x=await req('/api/auth/login',{method:'POST',body:{email:'admin@jsan.test',password:'AdminPassword!2026'}});
  const adminCookie=cookieFrom(x.r); if(!adminCookie) fail('Admin login did not set session cookie');

  x=await req('/api/pleo/test',{method:'POST',cookie:adminCookie});
  if(!x.p.ok) fail('Pleo mock connection failed');
  // Sync now returns {runId} immediately (server owns the job) — poll until terminal.
  x=await req('/api/pleo/sync',{method:'POST',cookie:adminCookie});
  const runId=x.p.runId; if(!runId) fail('Sync did not return a runId');
  let run; for(let i=0;i<50;i++){ const r=await req(`/api/pleo/sync-runs/${runId}`,{cookie:adminCookie}); run=r.p.run; if(run.status!=='RUNNING') break; await new Promise(r=>setTimeout(r,100)); }
  if(run.status!=='SUCCESS') fail(`Sync did not complete successfully: ${JSON.stringify(run)}`);
  if(run.inserted_count!==18) fail(`Expected 18 inserted mock transactions, got ${run.inserted_count}`);

  x=await req('/api/users',{method:'POST',cookie:adminCookie,body:{name:'Smoke Reviewer',email:'reviewer@jsan.test',role:'REVIEWER',temporary_password:'TempPassword!2026'}});
  const reviewerId=x.p.id;
  x=await req('/api/transactions?limit=50',{cookie:adminCookie});
  if(x.p.rows.length!==18) fail(`Expected 18 transactions, got ${x.p.rows.length}`);
  let receiptChecked=false;
  for(const candidate of x.p.rows){
    const d=await req(`/api/transactions/${candidate.id}`,{cookie:adminCookie});
    if(d.p.attachments?.length){
      const rr=await fetch(base+`/api/transactions/${candidate.id}/attachments/${d.p.attachments[0].id}`,{headers:{Cookie:adminCookie}});
      const txt=await rr.text();
      if(!rr.ok || !txt.includes('PLEO RECEIPT') || !txt.includes('DEMO')) fail('Mock receipt did not render');
      receiptChecked=true; break;
    }
  }
  if(!receiptChecked) fail('No mock receipt attachment available for verification');
  const txId=x.p.rows[0].id;

  // Approved project mapping rule is applied to already-synced transactions.
  x=await req('/api/admin/projects',{cookie:adminCookie});
  const ruleProject=x.p.rows.find(p=>p.code==='HERE-UK'); if(!ruleProject) fail('HERE-UK project missing');
  const manualProject=x.p.rows.find(p=>p.code!=='HERE-UK'); if(!manualProject) fail('Need a second project for the manual-attribution check');
  x=await req('/api/admin/project-mapping-rules',{method:'POST',cookie:adminCookie,body:{source_type:'PLEO_TEAM',source_value:'HERE UK Field Collection',project_id:ruleProject.id}});
  const ruleId=x.p.id;
  x=await req(`/api/transactions/${txId}`,{cookie:adminCookie});
  if(x.p.tx.project_status!=='MISSING_PROJECT') fail('A PROPOSED (unapproved) rule must not attribute a project');
  x=await req(`/api/admin/project-mapping-rules/${ruleId}/approve`,{method:'POST',cookie:adminCookie});
  if(x.p.applied?.ruleAssigned!==18) fail(`Approved rule should attribute all 18 fixture transactions: ${JSON.stringify(x.p.applied)}`);
  x=await req(`/api/transactions/${txId}`,{cookie:adminCookie});
  if(x.p.tx.project_attribution_source!=='APPROVED_MAPPING_RULE'||x.p.tx.project_id!==ruleProject.id||x.p.tx.project_status!=='ASSIGNED'||x.p.tx.dq_missing_project!==0||x.p.tx.attributed_project_code!=='HERE-UK') fail(`Rule attribution not applied: ${JSON.stringify(x.p.tx)}`);

  await req('/api/assign',{method:'POST',cookie:adminCookie,body:{reviewer_id:reviewerId,transaction_ids:[txId]}});

  x=await req('/api/auth/login',{method:'POST',body:{email:'reviewer@jsan.test',password:'TempPassword!2026'}});
  const reviewerCookie=cookieFrom(x.r); if(!reviewerCookie) fail('Reviewer login did not set session cookie');
  if(!x.p.user.must_change_password) fail('Temporary-password enforcement flag missing');
  await req('/api/auth/change-password',{method:'POST',cookie:reviewerCookie,body:{current_password:'TempPassword!2026',new_password:'ReviewerNew!2026'}});

  x=await req('/api/transactions?limit=50',{cookie:reviewerCookie});
  if(x.p.rows.length!==1) fail(`Reviewer should see 1 assigned transaction, got ${x.p.rows.length}`);
  x=await req(`/api/transactions/${txId}/start`,{method:'POST',cookie:reviewerCookie});
  await new Promise(r=>setTimeout(r,1200));
  await req(`/api/transactions/${txId}/heartbeat`,{method:'POST',cookie:reviewerCookie});
  x=await req(`/api/transactions/${txId}/review`,{method:'POST',cookie:reviewerCookie,body:{decision:'APPROVED',commercial_classification:'PROJECT_COST',project_code:manualProject.code,notes:'Smoke test validation',manual_category_name:'Smoke category override',xpense_id:'XPS-42'}});
  if(x.p.decision!=='APPROVED') fail('Review did not complete');

  // Reviewer's project choice is recorded as MANUAL attribution and survives a re-sync.
  const checkManual=async label=>{
    const d=await req(`/api/transactions/${txId}`,{cookie:adminCookie});
    const t=d.p.tx;
    if(t.project_attribution_source!=='MANUAL'||t.project_id!==manualProject.id||t.project_status!=='ASSIGNED'||t.dq_missing_project!==0||t.project_code!==manualProject.code) fail(`${label}: manual attribution wrong: ${JSON.stringify(t)}`);
    if(t.manual_category_name!=='Smoke category override'||t.resolved_category_name!=='Smoke category override'||t.xpense_id!=='XPS-42') fail(`${label}: manual category or Xpense ID did not persist: ${JSON.stringify(t)}`);
  };
  await checkManual('after review');
  x=await req('/api/pleo/sync',{method:'POST',cookie:adminCookie});
  for(let i=0;i<50;i++){ const r=await req(`/api/pleo/sync-runs/${x.p.runId}`,{cookie:adminCookie}); if(r.p.run.status!=='RUNNING'){ if(r.p.run.status!=='SUCCESS') fail('Re-sync failed'); break; } await new Promise(r=>setTimeout(r,100)); }
  await checkManual('after re-sync');
  x=await req(`/api/admin/project-mapping-rules/${ruleId}/approve`,{method:'POST',cookie:adminCookie});
  await checkManual('after rule re-apply');
  let bad=await fetch(base+`/api/transactions/${txId}/review`,{method:'POST',headers:{'Content-Type':'application/json',Cookie:adminCookie},body:JSON.stringify({decision:'NEEDS_INFO',project_code:'NO-SUCH-PROJECT',notes:'x'})});
  if(bad.status!==400) fail(`Unknown project code should be rejected, got ${bad.status}`);

  // Allocation at scale: filter by project, then "assign all matching".
  x=await req('/api/transactions/filter-options',{cookie:adminCookie});
  const optHere=x.p.projects.find(o=>o.value==='HERE-UK');
  if(!optHere||optHere.count!==17||optHere.unassigned!==17||!optHere.name) fail(`filter-options HERE-UK wrong: ${JSON.stringify(x.p.projects)}`);
  if('teams' in x.p) fail('Pleo teams are projects — no separate team filter expected');
  x=await req('/api/transactions?project=HERE-UK&status=UNASSIGNED&limit=5',{cookie:adminCookie});
  if(x.p.total!==17||x.p.rows[0].effective_project_code!=='HERE-UK'||x.p.rows[0].effective_project_name!==optHere.name) fail(`Project filter should match 17 rule-attributed rows: total=${x.p.total}`);
  x=await req('/api/users',{method:'POST',cookie:adminCookie,body:{name:'Smoke Reviewer Two',email:'reviewer2@jsan.test',role:'REVIEWER',temporary_password:'TempPassword!2026'}});
  const reviewer2Id=x.p.id;
  const bulkFilter={project:'HERE-UK',status:'UNASSIGNED'};
  bad=await fetch(base+'/api/assign',{method:'POST',headers:{'Content-Type':'application/json',Cookie:adminCookie},body:JSON.stringify({reviewer_id:reviewer2Id,filter:bulkFilter,expected_count:99})});
  if(bad.status!==409) fail(`Stale expected_count should be refused with 409, got ${bad.status}`);
  x=await req('/api/assign',{method:'POST',cookie:adminCookie,body:{reviewer_id:reviewer2Id,filter:bulkFilter,expected_count:17}});
  if(x.p.assigned!==17) fail(`Bulk filter allocation should assign 17, got ${JSON.stringify(x.p)}`);
  x=await req(`/api/transactions?reviewer_id=${reviewer2Id}&limit=50`,{cookie:adminCookie});
  if(x.p.total!==17||x.p.rows.some(r=>r.id===txId)) fail('Bulk allocation touched the wrong transactions');
  x=await req('/api/analytics/expense',{cookie:adminCookie});
  const spendHere=(x.p.breakdowns?.spendByProject||[]).find(r=>r.project_code==='HERE-UK');
  if(!spendHere||spendHere.count!==17) fail(`Spend by project should count rule-attributed rows: ${JSON.stringify(x.p.breakdowns?.spendByProject)}`);

  x=await req('/api/team',{cookie:adminCookie});
  const row=x.p.rows.find(r=>r.id===reviewerId);
  if(!row || row.validations_today!==1 || row.approved_today!==1 || row.pending!==0) fail(`Unexpected reviewer metrics: ${JSON.stringify(row)}`);

  x=await req('/api/dashboard',{cookie:adminCookie});
  if(x.p.counts.total!==18) fail('Dashboard transaction total mismatch');

  console.log(JSON.stringify({ok:true,transactions:x.p.counts.total,pleoMockInserted:18,reviewerValidations:row.validations_today,reviewerApproved:row.approved_today,activeSeconds:row.active_seconds_today},null,2));
} finally {
  killTree(server);
  await new Promise(r=>setTimeout(r,300));
  // Windows can hold the SQLite file handle briefly after the process exits;
  // retry cleanup rather than crashing the run (and leaving the port squatted).
  for(let i=0;i<5;i++){
    try{ fs.rmSync(dir,{recursive:true,force:true}); break; }
    catch{ await new Promise(r=>setTimeout(r,300)); }
  }
}
