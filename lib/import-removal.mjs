import crypto from 'node:crypto';
export function previewImportRemoval(db,from,to){
 const valid=s=>typeof s==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(s)&&Number.isFinite(Date.parse(s))&&new Date(s).toISOString().slice(0,10)===s;
 if(!valid(from)||!valid(to)||from>to)throw Object.assign(new Error('Choose a valid From and To date, in order.'),{status:400});
 const rows=db.prepare(`SELECT t.*,
 EXISTS(SELECT 1 FROM reviews WHERE transaction_id=t.id) has_reviews,
 EXISTS(SELECT 1 FROM work_sessions WHERE transaction_id=t.id) has_work
 FROM transactions t WHERE substr(t.transaction_date,1,10) BETWEEN ? AND ?
 AND t.source_import_run_id IS NOT NULL AND t.pleo_accounting_entry_id IS NOT NULL ORDER BY t.id`).all(from,to);
 const eligible=rows.filter(t=>t.status==='UNASSIGNED'&&t.reviewer_id==null&&!t.has_reviews&&!t.has_work&&!t.commercial_classification&&!t.manual_category_name&&!t.decision);
 const token=crypto.createHash('sha256').update(JSON.stringify({from,to,rows})).digest('hex');
 return {rows:eligible,token,matched:rows.length,removable:eligible.length,protected:rows.length-eligible.length};
}
export function removeImportedData(db,from,to,token,actorId){
 db.exec('BEGIN IMMEDIATE');
 try{
  const p=previewImportRemoval(db,from,to);
  if(!token||token!==p.token)throw Object.assign(new Error('The records changed. Preview the removal again.'),{status:409});
  const raw=db.prepare('SELECT * FROM pleo_raw_entries WHERE accounting_entry_id=?');
  const delRaw=db.prepare('DELETE FROM pleo_raw_entries WHERE accounting_entry_id=?');
  const del=db.prepare('DELETE FROM transactions WHERE id=?');
  const backup=p.rows.map(t=>({transaction:t,raw:raw.get(t.pleo_accounting_entry_id)||null}));
  db.prepare('INSERT INTO audit_log(transaction_id,actor_id,action,detail,created_at) VALUES(NULL,?,?,?,?)').run(actorId,'REMOVE_IMPORTED_DATA',JSON.stringify({from,to,count:p.removable,backup}),new Date().toISOString());
  for(const t of p.rows){del.run(t.id);delRaw.run(t.pleo_accounting_entry_id);}
  db.exec('COMMIT');return {removed:p.removable,protected:p.protected};
 }catch(e){db.exec('ROLLBACK');throw e;}
}
