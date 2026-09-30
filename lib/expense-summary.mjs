// Use Pleo company-currency billed amounts (Transactions: Amount), never original purchase values.
// Pleo billed debits are negative; spending is their negation so credits reduce spend.
export function summarizeExpenses(rows) {
  const addMoney=(a,b)=>(Math.round(a*100)+Math.round(b*100))/100;
  const excludedByMonth=new Map();
  const nonWalletByMonth=new Map();
  const monthly=new Map(), categories=new Map(), projects=new Map(), projectCategories=new Map();
  function add(map, dimensions, amount) {
    const key=JSON.stringify(dimensions);
    const item=map.get(key)||{...dimensions,amount:0,count:0};
    item.amount=addMoney(item.amount,amount); item.count++; map.set(key,item);
  }
  for(const r of rows){
    if(r.pleo_status==='DELETED')continue;
    if(r.source_system==='DEMO'||r.source_environment==='MOCK'||r.source_kind==='DEMO')continue;
    const month=r.transaction_date?.slice(0,7)||'Undated';
    if(r.pleo_status==='PENDING' || !r.bill_currency || r.bill_amount==null || !Number.isFinite(Number(r.bill_amount))){
      const excluded=excludedByMonth.get(month)||{month,count:0,pending_count:0};
      excluded.count++;if(r.pleo_status==='PENDING')excluded.pending_count++;
      excludedByMonth.set(month,excluded);continue;
    }
    // These expense records do not represent a posted wallet movement.
    // Reimbursements are represented separately when money leaves the wallet.
    if(['OUT_OF_POCKET','BILL_INVOICE'].includes(r.pleo_family)){
      const key=month+'|'+r.bill_currency;
      const e=nonWalletByMonth.get(key)||{month,currency:r.bill_currency,count:0,amount:0};
      e.count++;e.amount=addMoney(e.amount,-Number(r.bill_amount));nonWalletByMonth.set(key,e);continue;
    }
    const currency=r.bill_currency;
    const billed=Number(r.bill_amount);
    const family=r.pleo_family||r.expense_type?.split(' / ')[0]||'UNKNOWN';
    const wallet=family==='WALLET'||/^wallet load$/i.test(family);
    const key=JSON.stringify([month,currency]);
    const m=monthly.get(key)||{month,currency,wallet_load:0,spending:0,wallet_count:0,spending_count:0};
    if(wallet){m.wallet_load=addMoney(m.wallet_load,billed);m.wallet_count++;}
    else {
      m.spending=addMoney(m.spending,-billed);m.spending_count++;
      const expense_type=r.expense_type||family;
      const category=r.resolved_category_name||r.category||'Category unresolved';
      const project_code=r.effective_project_code||null;
      const project=r.effective_project_name||r.team_name||'Missing project';
      add(categories,{month,currency,expense_type,category},-billed);
      add(projects,{month,currency,project_code,project},-billed);
      add(projectCategories,{month,currency,project_code,project,expense_type,category},-billed);
    }
    monthly.set(key,m);
  }
  const sorted=map=>[...map.values()].sort((a,b)=>b.month.localeCompare(a.month)||a.currency.localeCompare(b.currency)||(a.project||'').localeCompare(b.project||'')||(a.expense_type||'').localeCompare(b.expense_type||'')||(a.category||'').localeCompare(b.category||''));
  // Calculate carry-forward chronologically, before any display filtering.
  const valid=[...monthly.values()].filter(r=>/^\d{4}-\d{2}$/.test(r.month));
  const months=[...new Set(valid.map(r=>r.month))].sort();
  const currencies=[...new Set(valid.map(r=>r.currency))].sort();
  const balances=[];
  if(months.length){
    const [year,month]=months[0].split('-').map(Number);
    const cursor=new Date(Date.UTC(year,month-1,1));
    const carry=new Map(currencies.map(c=>[c,0]));
    while(cursor.toISOString().slice(0,7)<=months.at(-1)){
      const period=cursor.toISOString().slice(0,7);
      for(const currency of currencies){
        const row=monthly.get(JSON.stringify([period,currency]))||{month:period,currency,wallet_load:0,spending:0,wallet_count:0,spending_count:0};
        const opening_balance=carry.get(currency);
        const total_monthly_balance=addMoney(opening_balance,row.wallet_load);
        const remaining_balance=addMoney(total_monthly_balance,-row.spending);
        balances.push({...row,opening_balance,total_monthly_balance,remaining_balance});
        carry.set(currency,remaining_balance);
      }
      cursor.setUTCMonth(cursor.getUTCMonth()+1);
    }
  }
  return {nonWalletEntries:[...nonWalletByMonth.values()],excluded:[...excludedByMonth.values()].sort((a,b)=>a.month.localeCompare(b.month)),balances,monthly:sorted(monthly),categories:sorted(categories),projects:sorted(projects),projectCategories:sorted(projectCategories)};
}

// Accounting-entry parents already include their splits. Replace parents with
// their API split detail for reporting, never add the detail on top of parents.
export function expandApiExpenseSplits(rows,categoryNames=new Map()){
  return rows.flatMap(row=>{
    const raw=row.raw_json?JSON.parse(row.raw_json):null;
    const splits=raw?.splitItems||[];
    if(!splits.length||splits.some(s=>!s.id||s.totalBillValue?.minors==null))return [row];
    const ids=new Set(splits.map(s=>s.id));
    const total=splits.reduce((n,s)=>n+Number(s.totalBillValue.minors),0);
    if(ids.size!==splits.length||splits.some(s=>s.totalBillValue.currency!==row.bill_currency)||total!==Math.round(row.bill_amount*100))throw new Error('API split amounts do not reconcile for '+row.pleo_accounting_entry_id);
    return splits.map(split=>{
      // A reviewer-entered category covers the whole expense, so it wins over
      // per-split account mappings (same precedence as mergeCategoryEvidence).
      const category=row.manual_category_name||categoryNames.get(split.accountId)||(split.accountId===raw.accountId?row.resolved_category_name||row.category:null);
      return {...row,pleo_accounting_entry_id:split.id,parent_accounting_entry_id:raw.id,bill_amount:Number(split.totalBillValue.minors)/100,
        resolved_category_name:category||null,category:category||null,raw_json:undefined};
    });
  });
}

// Aggregate canonical transactions before split expansion: classifications and deductions
// belong to the parent transaction and must only be counted once.
export function summarizeCommercialExpenses(rows){
  const groups=new Map();
  const fields={CUSTOMER_BILLABLE:'customer_billable',JSAN_INTERNAL:'jsan_internal',REFUND:'refund',REIMBURSEMENT:'reimbursement'};
  const add=(r,k,n)=>r[k]=(Math.round(r[k]*100)+Math.round(n*100))/100;
  for(const t of rows){
    const family=t.pleo_family||t.expense_type?.split(' / ')[0];
    if(['PENDING','DELETED'].includes(t.pleo_status)||t.source_system==='DEMO'||t.source_environment==='MOCK'||t.source_kind==='DEMO')continue;
    if(!t.bill_currency||t.bill_amount==null||!Number.isFinite(Number(t.bill_amount)))continue;
    if(['WALLET','OUT_OF_POCKET','BILL_INVOICE'].includes(family)||/^wallet load$/i.test(family||''))continue;
    const month=t.transaction_date?.slice(0,7)||'Undated',currency=t.bill_currency;
    const project_code=t.effective_project_code||null;
    const project=t.effective_project_name||project_code||t.team_name||'Missing project';
    const key=JSON.stringify([month,currency,project_code,project]);
    const r=groups.get(key)||{month,currency,project_code,project,customer_billable:0,jsan_internal:0,refund:0,reimbursement:0,salary_deduction:0,unclassified:0,count:0,missing_deductions:0};
    const spending=-Number(t.bill_amount),classification=t.commercial_classification;
    r.count++;
    if(classification==='SALARY_DEDUCTION'){
      const original=Math.abs(Number(t.amount)),deduction=Number(t.salary_deduction_amount);
      if(t.salary_deduction_amount==null||!Number.isFinite(deduction)||deduction<=0||!original||deduction>original){
        r.missing_deductions++;add(r,'unclassified',spending);
      }else{
        const converted=Math.round(Math.abs(spending)*deduction/original*100)/100;
        add(r,'salary_deduction',Math.sign(spending)*converted);
        add(r,'jsan_internal',spending-Math.sign(spending)*converted);
      }
    }else if(fields[classification]){
      // Refund credits are displayed as positive recoveries; refund reversals are negative.
      add(r,fields[classification],classification==='REFUND'?-spending:spending);
    }else add(r,'unclassified',spending);
    groups.set(key,r);
  }
  return [...groups.values()].sort((a,b)=>b.month.localeCompare(a.month)||a.currency.localeCompare(b.currency)||a.project.localeCompare(b.project));
}
