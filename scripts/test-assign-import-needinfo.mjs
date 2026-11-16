// Assignment import (Excel/CSV): Need info transactions listed again are
// reassigned and counted as an assignment; approved ones are never assigned
// again; assigned-but-unverified ones are never reassigned. Runs the real app
// on a throwaway database with Pleo mock data — never a live account.
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function killTree(proc){
  if(process.platform==='win32'){ try{ execSync(`taskkill /PID ${proc.pid} /T /F`,{stdio:'ignore'}); }catch{} }
  else { try{ proc.kill('SIGTERM'); }catch{} }
}
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'jsan-assign-import-'));
const port=43931,base=`http://127.0.0.1:${port}`;
const server=spawn(process.platform==='win32'?'node':process.execPath,['server.js'],{
  shell:process.platform==='win32',cwd:root,
  env:{...process.env,HOST:'127.0.0.1',PORT:String(port),DATABASE_PATH:path.join(dir,'app.db'),ATTACHMENT_DIR:path.join(dir,'attachments'),
    COOKIE_SECURE:'false',PLEO_MOCK_MODE:'true',PLEO_COMPANY_ID:'00000000-0000-0000-0000-000000000001',PLEO_SYNC_MODE:'export_v2',
    PLEO_AUTO_SYNC:'false',PLEO_SYNC_ON_START:'false',PLEO_DAILY_SYNC:'false',DEMO_SEED:'false'},
  stdio:['ignore','pipe','pipe']
});
let stderr='';server.stderr.on('data',d=>stderr+=d);
let failures=0;
const check=(name,cond,detail='')=>{if(cond)console.log(`PASS - ${name}`);else{failures++;console.log(`FAIL - ${name}${detail?` (${detail})`:''}`);}};
const cookieFrom=r=>(r.headers.get('set-cookie')||'').split(';')[0];
async function req(url,{method='GET',body,cookie,raw,headers={}}={}){
  const r=await fetch(base+url,{method,headers:{Accept:'application/json',...(body!==undefined?{'Content-Type':'application/json'}:{}),...(cookie?{Cookie:cookie}:{}),...headers},body:raw??(body!==undefined?JSON.stringify(body):undefined)});
  let p;try{p=await r.json()}catch{p={}}
  if(!r.ok)throw new Error(`${method} ${url} -> ${r.status}: ${JSON.stringify(p)}\n${stderr}`);
  return {r,p};
}
async function importCsv(cookie,rows){
  const csv=['Receipt,Owner,Pleo Reviewer,Expense ID',...rows.map(([entry,email])=>`r-${entry},,${email},${entry}`)].join('\n');
  const pre=(await req('/api/assign/import/preview',{method:'POST',cookie,raw:csv,headers:{'Content-Type':'text/csv','x-filename':'assignments.csv'}})).p;
  const done=(await req('/api/assign/import/confirm',{method:'POST',cookie,body:{token:pre.token}})).p;
  return {pre,done,status:entry=>pre.rows.find(r=>r.expenseId===entry)?.status};
}

try{
  for(let i=0;i<80;i++){try{if((await fetch(base+'/api/health')).ok)break}catch{} await new Promise(r=>setTimeout(r,100));}
  await req('/api/setup/admin',{method:'POST',body:{name:'Test Admin',email:'admin@jsan.test',password:'AdminPassword!2026'}});
  const admin=cookieFrom((await req('/api/auth/login',{method:'POST',body:{email:'admin@jsan.test',password:'AdminPassword!2026'}})).r);
  const runId=(await req('/api/pleo/sync',{method:'POST',cookie:admin})).p.runId;
  for(let i=0;i<50;i++){const run=(await req(`/api/pleo/sync-runs/${runId}`,{cookie:admin})).p.run;if(run.status!=='RUNNING')break;await new Promise(r=>setTimeout(r,100));}
  const r1=(await req('/api/users',{method:'POST',cookie:admin,body:{name:'Reviewer One',email:'one@jsan.test',role:'REVIEWER',temporary_password:'TempPassword!2026'}})).p.id;
  const r2=(await req('/api/users',{method:'POST',cookie:admin,body:{name:'Reviewer Two',email:'two@jsan.test',role:'REVIEWER',temporary_password:'TempPassword!2026'}})).p.id;
  let one=cookieFrom((await req('/api/auth/login',{method:'POST',body:{email:'one@jsan.test',password:'TempPassword!2026'}})).r);
  await req('/api/auth/change-password',{method:'POST',cookie:one,body:{current_password:'TempPassword!2026',new_password:'ReviewerNew!2026'}});
  one=cookieFrom((await req('/api/auth/login',{method:'POST',body:{email:'one@jsan.test',password:'ReviewerNew!2026'}})).r);

  const txs=(await req('/api/transactions?limit=50&status=UNASSIGNED',{cookie:admin})).p.rows.filter(t=>t.pleo_accounting_entry_id);
  if(txs.length<4)throw new Error('Need at least 4 mock transactions');
  const [A,B,C,D]=txs; // A: assigned, never verified · B: Need info · C: approved · D: new on day 2
  const id=t=>t.id,entry=t=>t.pleo_accounting_entry_id;

  // Import 1: A, B, C to Reviewer One.
  let imp=await importCsv(admin,[[entry(A),'one@jsan.test'],[entry(B),'one@jsan.test'],[entry(C),'one@jsan.test']]);
  check('import 1: three new assignments',imp.done.assigned===3&&!imp.done.reassigned,JSON.stringify(imp.done));

  // Reviewer One: B -> Need info, C -> Approved, A left unverified.
  await req(`/api/transactions/${id(B)}/start`,{method:'POST',cookie:one});
  await req(`/api/transactions/${id(B)}/review`,{method:'POST',cookie:one,body:{decision:'NEEDS_INFO',notes:'Receipt Is Missing'}});
  await req(`/api/transactions/${id(C)}/start`,{method:'POST',cookie:one});
  await req(`/api/transactions/${id(C)}/review`,{method:'POST',cookie:one,body:{decision:'APPROVED',commercial_classification:'JSAN_INTERNAL',notes:''}});

  // Import 2 (next file): all four listed; D goes to Reviewer Two.
  imp=await importCsv(admin,[[entry(A),'one@jsan.test'],[entry(B),'one@jsan.test'],[entry(C),'one@jsan.test'],[entry(D),'two@jsan.test']]);
  check('import 2: unverified assigned row is not reassigned',imp.status(entry(A))==='ALREADY_ASSIGNED',imp.status(entry(A)));
  check('import 2: Need info row will be reassigned',imp.status(entry(B))==='REASSIGN',imp.status(entry(B)));
  check('import 2: approved row is never assigned again',imp.status(entry(C))==='ALREADY_FINAL',imp.status(entry(C)));
  check('import 2: new row will be assigned',imp.status(entry(D))==='READY',imp.status(entry(D)));
  check('import 2: preview summary counts the reassignment',imp.pre.summary.REASSIGN===1&&imp.pre.summary.READY===1,JSON.stringify(imp.pre.summary));
  check('import 2: confirm assigns 1 new + reassigns 1',imp.done.assigned===1&&imp.done.reassigned===1&&imp.done.skipped===0,JSON.stringify(imp.done));
  const b=(await req(`/api/transactions/${id(B)}`,{cookie:admin})).p;
  check('reassigned Need info is back in the Assigned state with its reviewer',b.tx.status==='ASSIGNED'&&b.tx.reviewer_id===r1,JSON.stringify({status:b.tx.status,reviewer:b.tx.reviewer_id}));
  check('reassignment is audited',b.audit.some(a=>a.action==='REASSIGNED_FROM_NEED_INFO'));
  const c=(await req(`/api/transactions/${id(C)}`,{cookie:admin})).p.tx;
  check('approved transaction untouched',c.status==='APPROVED'&&c.reviewer_id===r1);

  // Review Operations / Team Performance: new + reassigned both count.
  const ops=(await req('/api/analytics/reviewers',{cookie:admin})).p.rows;
  const o1=ops.find(r=>r.id===r1),o2=ops.find(r=>r.id===r2);
  check('Review Operations: Reviewer One assigned = 3 new + 1 reassigned',o1?.assigned===4&&o1?.reassigned===1,JSON.stringify(o1));
  check('Review Operations: Reviewer Two assigned = 1',o2?.assigned===1&&!o2?.reassigned,JSON.stringify(o2));
  const team=(await req('/api/team',{cookie:admin})).p.rows.find(r=>r.id===r1);
  check('Team Performance: today counts the reassignment too',team?.assigned_today===4,JSON.stringify(team));

  // Import 3: the same file again changes nothing (B is Assigned now, not Need info).
  imp=await importCsv(admin,[[entry(A),'one@jsan.test'],[entry(B),'one@jsan.test'],[entry(C),'one@jsan.test'],[entry(D),'two@jsan.test']]);
  check('import 3: nothing new or reassigned',imp.done.assigned===0&&imp.done.reassigned===0,JSON.stringify(imp.done));
  const ops2=(await req('/api/analytics/reviewers',{cookie:admin})).p.rows.find(r=>r.id===r1);
  check('import 3: counts unchanged',ops2?.assigned===4,JSON.stringify(ops2));
}catch(e){failures++;console.log('FAIL - unexpected: '+e.message);}
finally{
  killTree(server);await new Promise(r=>setTimeout(r,300));
  for(let i=0;i<5;i++){try{fs.rmSync(dir,{recursive:true,force:true});break}catch{await new Promise(r=>setTimeout(r,300))}}
}
console.log(failures?`\n${failures} assignment import test(s) failed.`:'\nAll assignment import tests passed.');
process.exit(failures?1:0);
