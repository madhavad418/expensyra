import assert from 'node:assert/strict';
import {expandApiExpenseSplits,summarizeExpenses} from '../lib/expense-summary.mjs';
const base={transaction_date:'2026-08-01',currency:'GBP',source_system:'PLEO',source_environment:'PRODUCTION',effective_project_code:'P1',effective_project_name:'Project One',category:'Travel'};
const rows=[
 {...base,pleo_family:'WALLET',expense_type:'WALLET / LOAD',amount:1000},
 {...base,pleo_family:'CARD_PURCHASE',expense_type:'CARD_PURCHASE / ONLINE',amount:120},
 {...base,pleo_family:'CASHBACK',expense_type:'CASHBACK',amount:-20},
 {...base,pleo_family:'REIMBURSEMENT',expense_type:'REIMBURSEMENT',amount:30},
 {...base,pleo_family:'CARD_PURCHASE',amount:80,currency:'USD',effective_project_code:null,effective_project_name:null},
 {...base,pleo_family:'CARD_PURCHASE',amount:50,transaction_date:'2026-09-01'},
 {...base,pleo_family:'CARD_PURCHASE',amount:99999,source_system:'DEMO'}
];
const billed=rows.map(r=>({...r,bill_currency:r.currency,bill_amount:r.pleo_family==='WALLET'?r.amount:-r.amount}));
const d=summarizeExpenses(billed);
const aug=d.monthly.find(r=>r.month==='2026-08'&&r.currency==='GBP');
assert.equal(aug.wallet_load,1000);assert.equal(aug.spending,130);assert.equal(aug.spending_count,3);
assert.equal(d.monthly.find(r=>r.currency==='USD').spending,80);
assert.equal(d.monthly.find(r=>r.month==='2026-09').spending,50);
for(const m of d.monthly){
 for(const key of ['categories','projects','projectCategories']){
   assert.equal(d[key].filter(r=>r.month===m.month&&r.currency===m.currency).reduce((s,r)=>s+r.amount,0),m.spending,key+' reconciles');
 }
}
assert(d.projects.some(r=>r.project==='Missing project'));
assert.deepEqual(summarizeExpenses([]),{nonWalletEntries:[],excluded:[],balances:[],monthly:[],categories:[],projects:[],projectCategories:[]});
console.log('PASS: wallet separation, signed spending, currencies, months, demo exclusion, project/category reconciliation and empty data');

const balance=(month,currency='GBP')=>d.balances.find(r=>r.month===month&&r.currency===currency);
assert.equal(balance('2026-08').opening_balance,0);
assert.equal(balance('2026-08').remaining_balance,870);
assert.equal(balance('2026-09').opening_balance,870);
assert.equal(balance('2026-09').total_monthly_balance,870);
assert.equal(balance('2026-09').remaining_balance,820);
assert.equal(balance('2026-09','USD').remaining_balance,-80);
const gap=summarizeExpenses([
 {...base,transaction_date:'2026-12-01',pleo_family:'WALLET',amount:200,bill_currency:'GBP',bill_amount:200},
 {...base,transaction_date:'2027-02-01',pleo_family:'CARD_PURCHASE',amount:30,bill_currency:'GBP',bill_amount:-30}
]).balances;
assert.equal(gap.length,3);
assert.equal(gap[1].month,'2027-01');assert.equal(gap[1].remaining_balance,200);
assert.equal(gap[2].opening_balance,200);assert.equal(gap[2].remaining_balance,170);
console.log('PASS: zero opening, monthly carry-forward, currency isolation, negative balances, empty months and year boundary');

// Foreign purchases must share their billed currency with the wallet load.
const fx=summarizeExpenses([
 {...base,pleo_family:'WALLET',bill_currency:'GBP',bill_amount:1000,amount:1000},
 {...base,pleo_family:'CARD_PURCHASE',bill_currency:'GBP',bill_amount:-80.12,amount:100,currency:'USD'},
 {...base,pleo_family:'CARD_PURCHASE',bill_currency:'GBP',bill_amount:10.01,amount:12,currency:'EUR'},
 {...base,pleo_family:'CASHBACK',bill_currency:'GBP',bill_amount:5,amount:-5},
 {...base,pleo_family:'CARD_PURCHASE',bill_currency:null,bill_amount:null,amount:999,currency:'USD',pleo_status:'PENDING'},
 {...base,pleo_family:'CARD_PURCHASE',bill_currency:'GBP',bill_amount:0,amount:20,currency:'USD'},
 {...base,transaction_date:'2026-09-01',pleo_family:'WALLET',bill_currency:'GBP',bill_amount:200,amount:200},
 {...base,transaction_date:'2026-09-01',pleo_family:'CARD_PURCHASE',bill_currency:'GBP',bill_amount:-20.11,amount:40,currency:'USD'}
]);
assert.equal(fx.balances.length,2,'original currencies must not create separate wallet balances');
assert.equal(fx.balances[0].spending,65.11);
assert.equal(fx.balances[0].remaining_balance,934.89);
assert.equal(fx.balances[1].opening_balance,934.89);
assert.equal(fx.balances[1].total_monthly_balance,1134.89);
assert.equal(fx.balances[1].remaining_balance,1114.78);
assert.equal(fx.balances[0].spending_count,4,'zero billed amounts remain valid');
assert.deepEqual(fx.excluded,[{month:'2026-08',count:1,pending_count:1}]);
for(const key of ['categories','projects','projectCategories'])assert.equal(Math.round(fx[key].filter(r=>r.month==='2026-08').reduce((n,r)=>n+r.amount,0)*100),6511);
console.log('PASS: billed-currency reconciliation, debit/credit signs, foreign purchases, pending exclusions and exact carry-forward');

const apiParent={...base,pleo_accounting_entry_id:'parent',bill_currency:'GBP',bill_amount:-100,pleo_family:'CARD_PURCHASE',category:'Parent category',raw_json:JSON.stringify({id:'parent',accountId:'a',splitItems:[{id:'parent',accountId:'a',totalBillValue:{currency:'GBP',minors:-6000}},{id:'child',accountId:'b',totalBillValue:{currency:'GBP',minors:-4000}}]})};
const expanded=expandApiExpenseSplits([apiParent],new Map([['a','Fuel'],['b','Parking']]));
assert.equal(expanded.length,2);assert.equal(expanded[1].category,'Parking');
assert.equal(summarizeExpenses(expanded).balances[0].spending,100);
assert.throws(()=>expandApiExpenseSplits([{...apiParent,bill_amount:-200}]),/reconcile/);
const walletOnly=summarizeExpenses([...expanded,{...apiParent,raw_json:null,pleo_family:'OUT_OF_POCKET'},{...apiParent,raw_json:null,pleo_family:'BILL_INVOICE'}]);
assert.equal(walletOnly.balances[0].spending,100);
assert.equal(walletOnly.nonWalletEntries[0].count,2);
const manual=expandApiExpenseSplits([{...apiParent,manual_category_name:'Team lunch'}],new Map([['a','Fuel']]));
assert.deepEqual(manual.map(r=>r.category),['Team lunch','Team lunch'],'reviewer-entered category applies to every split');
console.log('PASS: API parent/split replacement, category resolution, reviewer category precedence, mismatched split rejection and non-wallet exclusions');

const {summarizeCommercialExpenses}=await import('../lib/expense-summary.mjs');
const commercialBase={...apiParent,amount:125,currency:'USD',commercial_classification:'SALARY_DEDUCTION',salary_deduction_amount:25};
const commercial=summarizeCommercialExpenses([
 commercialBase,
 {...commercialBase,commercial_classification:'CUSTOMER_BILLABLE',bill_amount:-50,salary_deduction_amount:null},
 {...commercialBase,commercial_classification:'JSAN_INTERNAL',bill_amount:-10,salary_deduction_amount:null},
 {...commercialBase,commercial_classification:'REFUND',bill_amount:12},
 {...commercialBase,commercial_classification:'REFUND',bill_amount:-2},
 {...commercialBase,commercial_classification:'REIMBURSEMENT',bill_amount:-15},
 {...commercialBase,commercial_classification:null,bill_amount:-3},
 {...commercialBase,pleo_status:'PENDING'},
 {...commercialBase,pleo_status:'DELETED'},
 {...commercialBase,source_system:'DEMO'},
 {...commercialBase,pleo_family:'WALLET'},
 {...commercialBase,pleo_family:'OUT_OF_POCKET'},
 {...commercialBase,bill_currency:'EUR'},
 {...commercialBase,effective_project_code:'P2',effective_project_name:'Project Two'},
 {...commercialBase,transaction_date:'2026-09-01'}
]);
const p=commercial.find(x=>x.month==='2026-08'&&x.currency==='GBP'&&x.project_code==='P1');
assert.equal(p.customer_billable,50);assert.equal(p.jsan_internal,90);
assert.equal(p.refund,10);assert.equal(p.reimbursement,15);
assert.equal(p.salary_deduction,20,'convert actual deduction once, despite parent splits');
assert.equal(p.unclassified,3);assert.equal(p.count,7);
assert.equal(p.customer_billable+p.jsan_internal+p.reimbursement+p.salary_deduction+p.unclassified-p.refund,168);
assert.equal(commercial.length,4,'separate projects, currencies and months');
const missing=summarizeCommercialExpenses([{...commercialBase,salary_deduction_amount:null}])[0];
assert.equal(missing.salary_deduction,0);assert.equal(missing.missing_deductions,1);assert.equal(missing.unclassified,100);
assert.deepEqual(summarizeCommercialExpenses([]),[]);
// Salary deduction recorded on Customer billable / JSAN internal: split, never double-counted.
const split=summarizeCommercialExpenses([
 {...commercialBase,commercial_classification:'CUSTOMER_BILLABLE',salary_deduction_amount:25},   // 25 of 125 USD → 20 of 100 GBP
 {...commercialBase,commercial_classification:'JSAN_INTERNAL',salary_deduction_amount:125},      // all of it
 {...commercialBase,commercial_classification:'CUSTOMER_BILLABLE',salary_deduction_amount:0},    // none
 {...commercialBase,commercial_classification:'JSAN_INTERNAL',salary_deduction_amount:500},      // impossible → ignored
])[0];
assert.equal(split.salary_deduction,120);assert.equal(split.customer_billable,180);assert.equal(split.jsan_internal,100);
assert.equal(split.customer_billable+split.jsan_internal+split.salary_deduction,400,'every expense still adds up to its full amount');
assert.equal(split.missing_deductions,0);
console.log('PASS: commercial classifications, partial salary FX, split deduplication, signed refunds, scope and project/month/currency isolation');
