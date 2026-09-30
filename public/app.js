const carRentalUi={months:[],companies:[],projects:[],page:1,pageSize:15};
const carRentalFilters=[['months','month','MONTH'],['companies','company','RENTALCOMPANYNAME'],['projects','project','PROJECT Name']];
const carRentalMoney=value=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',minimumFractionDigits:2,maximumFractionDigits:2}).format(Number(value)||0);
function carRentalFilterMarkup(key,label,options,selected,labels={}){const title=selected.length?`${selected.length} selected`:`All ${options.length}`;return `<details class="car-filter" data-filter-key="${key}"><summary><span>${esc(label)}</span><b>${esc(title)}</b></summary><div class="car-filter-menu"><button type="button" class="car-filter-clear" data-car-clear="${key}">Clear selection</button><div class="car-filter-options">${options.map(value=>`<label><input type="checkbox" data-car-filter="${key}" value="${esc(value)}" ${selected.includes(value)?'checked':''}><span>${esc(labels[value]||value||'Unassigned')}</span></label>`).join('')||'<span class="muted small">No values</span>'}</div></div></details>`}
function carRentalVendorRows(items){const max=Math.max(1,...items.map(item=>item.amount));return items.map((item,index)=>`<div class="car-vendor-row"><span class="car-vendor-rank">${String(index+1).padStart(2,'0')}</span><div class="car-vendor-main"><div class="car-vendor-copy"><b>${esc(item.label)}</b><span>${fmtCount(item.count)} rentals</span></div><div class="car-vendor-track"><i style="width:${Math.max(0,Math.min(100,item.amount/max*100))}%"></i></div></div><strong>${carRentalMoney(item.amount)}</strong></div>`).join('')||'<div class="car-empty">No vendor totals for these filters.</div>'}
function carRentalStatusRows(items){const classes={'Active':'active','Invoice Received':'received','Done with No Invoice':'pending','Unclassified':'other'};const max=Math.max(1,...items.map(item=>item.amount));return items.map(item=>`<div class="car-status-row"><div class="car-status-label"><span class="car-status-dot ${classes[item.label]||'other'}"></span><b>${esc(item.label)}</b><span>${fmtCount(item.count)}</span></div><div class="car-status-track"><i class="${classes[item.label]||'other'}" style="width:${Math.max(0,Math.min(100,item.amount/max*100))}%"></i></div><strong>${carRentalMoney(item.amount)}</strong></div>`).join('')||'<div class="car-empty">No rental statuses for these filters.</div>'}
function carRentalMonthBars(items){const max=Math.max(1,...items.map(item=>item.amount));return items.map(item=>`<div class="car-month-column"><div class="car-month-value">${carRentalMoney(item.amount)}</div><div class="car-month-rail"><i style="height:${Math.max(3,item.amount/max*100)}%"></i></div><b>${esc(item.label)}</b><span>${fmtCount(item.count)} cars</span></div>`).join('')||'<div class="car-empty">No monthly totals for these filters.</div>'}
async function renderCarRentals(c,preserveOpen='',refresh=false){
  const params=new URLSearchParams();
  for(const [stateKey,paramKey] of carRentalFilters)for(const value of carRentalUi[stateKey])params.append(paramKey,value);
  if(refresh)params.set('refresh','1');
  const query=params.toString();const d=await api('/api/car-rentals'+(query?`?${query}`:''));
  const pageCount=Math.max(1,Math.ceil(d.rows.length/carRentalUi.pageSize));carRentalUi.page=Math.min(carRentalUi.page,pageCount);
  const start=(carRentalUi.page-1)*carRentalUi.pageSize;const pageRows=d.rows.slice(start,start+carRentalUi.pageSize);
  c.innerHTML=`<div class="car-rentals-page"><header class="car-rentals-hero"><div><div class="car-rentals-eyebrow"><span>Fleet ledger</span><b>2026</b></div><h2>Car Rentals</h2><p>Rental activity, invoice coverage and monthly USD spend from the master register.</p></div><button type="button" class="car-refresh" id="car-refresh">Refresh data</button></header><section class="car-filter-band" aria-label="Car rental filters"><div class="car-filter-heading"><div><b>Refine fleet</b><span>Combine month, rental company and project</span></div><button type="button" class="car-clear-all" id="car-clear-all">Clear all</button></div><div class="car-filter-grid">${carRentalFilters.map(([stateKey,,label])=>carRentalFilterMarkup(stateKey,label,d.filters[stateKey],carRentalUi[stateKey],stateKey==='months'?d.filters.monthLabels:{})).join('')}</div></section><section class="car-kpis" aria-label="Rental summary"><article class="car-kpi car-kpi-total"><span>Total Rental Cars</span><strong>${fmtCount(d.summary.totalCars)}</strong><small>Rows in current selection</small></article><article class="car-kpi car-kpi-active"><span>Active Rental Cars</span><strong>${fmtCount(d.summary.activeCars)}</strong><small>Active status in source sheet</small></article><article class="car-kpi car-kpi-invoice"><span>Total Invoice</span><strong>${carRentalMoney(d.summary.totalInvoice)}</strong><small>All recorded USD amounts</small></article><article class="car-kpi car-kpi-received"><span>Invoice Received</span><strong>${carRentalMoney(d.summary.invoiceReceived)}</strong><small>Marked Done in the master</small></article><article class="car-kpi car-kpi-no-invoice"><span>Done with No Invoice</span><strong>${carRentalMoney(d.summary.doneWithoutInvoice)}</strong><small>Completed rentals without invoice</small></article></section><div class="car-data-stamp"><span>${d.stale?'SharePoint unavailable · showing cached data':`Source: ${esc(d.sheetName)}`}</span><span>Updated ${esc(fmtDate(d.loadedAt))}</span></div><section class="car-chart-grid"><article class="car-chart car-vendors"><div class="car-chart-head"><div><span>01 / Supplier spend</span><h3>Vendor-wise invoice</h3></div><b>${d.vendorInvoices.length} suppliers</b></div><div class="car-vendor-list">${carRentalVendorRows(d.vendorInvoices)}</div></article><article class="car-chart car-invoice-status"><div class="car-chart-head"><div><span>02 / Coverage</span><h3>Invoice status</h3></div><b>USD</b></div><div class="car-status-list">${carRentalStatusRows(d.invoiceStatuses)}</div><div class="car-status-foot"><span>Totals follow the <b>Active &amp;Inactive</b> field.</span></div></article></section><section class="car-chart car-month-chart"><div class="car-chart-head"><div><span>03 / Run rate</span><h3>Month-wise expenses</h3></div><b>${d.monthlyExpenses.length} months</b></div><div class="car-month-bars">${carRentalMonthBars(d.monthlyExpenses)}</div></section><section class="car-records"><div class="car-records-head"><div><span>04 / Register</span><h3>Rental records</h3></div><b>${fmtCount(d.rows.length)} rows</b></div><div class="car-table-scroll"><table><thead><tr><th>Month</th><th>Rental company</th><th>Project</th><th>Car code</th><th>Plate</th><th>Rental status</th><th>Invoice status</th><th class="right">USD amount</th></tr></thead><tbody>${pageRows.map(row=>`<tr><td>${esc(row.monthLabel)}</td><td><b>${esc(row.rentalCompany)}</b></td><td>${esc(row.projectName)}</td><td>${esc(row.carCode)}</td><td>${esc(row.plateNumber)}</td><td><span class="car-record-status ${row.rentalStatus==='Active'?'active':row.rentalStatus==='Invoice Received'?'received':row.rentalStatus==='Done with No Invoice'?'pending':'other'}">${esc(row.rentalStatus)}</span></td><td>${esc(row.invoiceStatus)}</td><td class="right">${carRentalMoney(row.amountUsd)}</td></tr>`).join('')||'<tr><td colspan="8" class="car-empty">No rental records match the selected filters.</td></tr>'}</tbody></table></div><footer class="car-records-foot"><span>Showing ${d.rows.length?fmtCount(start+1):'0'}–${fmtCount(Math.min(start+carRentalUi.pageSize,d.rows.length))} of ${fmtCount(d.rows.length)}</span><div><button type="button" id="car-prev" ${carRentalUi.page<=1?'disabled':''} aria-label="Previous page">Previous</button><span>Page ${fmtCount(carRentalUi.page)} of ${fmtCount(pageCount)}</span><button type="button" id="car-next" ${carRentalUi.page>=pageCount?'disabled':''} aria-label="Next page">Next</button></div></footer></section><p class="car-source-note">Amounts use the master sheet’s USD conversion column. Only the 2026 Car Rental Master Data worksheet is used.</p></div>`;
  const mobileCarNav=document.querySelector('.mobile-nav [data-nav="car-rentals"]');if(mobileCarNav)mobileCarNav.textContent='Car Rentals';
  document.querySelectorAll('[data-car-filter]').forEach(input=>input.onchange=()=>{const key=input.dataset.carFilter;carRentalUi[key]=[...document.querySelectorAll(`[data-car-filter="${key}"]:checked`)].map(item=>item.value);carRentalUi.page=1;renderCarRentals(c,key)});
  document.querySelectorAll('[data-car-clear]').forEach(button=>button.onclick=()=>{const key=button.dataset.carClear;carRentalUi[key]=[];carRentalUi.page=1;renderCarRentals(c,key)});
  document.querySelector('#car-clear-all').onclick=()=>{for(const [key] of carRentalFilters)carRentalUi[key]=[];carRentalUi.page=1;renderCarRentals(c)};
  document.querySelector('#car-refresh').onclick=()=>renderCarRentals(c,document.querySelector('.car-filter[open]')?.dataset.filterKey||'',true);
  document.querySelector('#car-prev').onclick=()=>{if(carRentalUi.page>1){carRentalUi.page--;renderCarRentals(c)}};
  document.querySelector('#car-next').onclick=()=>{if(carRentalUi.page<pageCount){carRentalUi.page++;renderCarRentals(c)}};
  if(preserveOpen)document.querySelector(`.car-filter[data-filter-key="${preserveOpen}"]`)?.setAttribute('open','');
}
const root=document.querySelector('#app');const toastEl=document.querySelector('#toast');
const state={user:null,bootstrap:null,page:(()=>{try{return sessionStorage.getItem('spendops.currentPage')||'dashboard'}catch{return 'dashboard'}})(),selected:new Set(),filters:{status:'',pleo_status:'',q:'',category:'',project:'',currency:'',commercial_classification:'',merchant:'',receipt_status:'',month:'',source:'',project_status:'',classification_status:'',category_status:'',pleo_review:'',dateFrom:'',dateTo:'',new_since:''},filterOptions:null,txView:(()=>{try{return localStorage.getItem('spendops.txView')||'excel'}catch{return'excel'}})(),txPage:1,txPageSize:50,expenseFilters:{month:'',project:'',commercial_classification:'',status:'',receipt_status:'',project_status:''},revopsFilters:{month:''},revopsView:'list',revopsReviewerId:null,modal:null,timer:null,heartbeat:null,sessionStarted:null,activeTx:null};
const esc=v=>String(v??'').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
const fmtMoney=(n,c='GBP')=>{try{return new Intl.NumberFormat('en-GB',{style:'currency',currency:c||'GBP'}).format(Number(n||0));}catch{return `${c||''} ${Number(n||0).toFixed(2)}`}};
const fmtTime=s=>{s=Math.max(0,Number(s||0));const h=Math.floor(s/3600),m=Math.floor((s%3600)/60),x=Math.floor(s%60);return h?`${h}h ${String(m).padStart(2,'0')}m`:`${m}m ${String(x).padStart(2,'0')}s`};
const fmtDate=v=>{if(!v)return'—';try{return new Intl.DateTimeFormat('en-GB',{dateStyle:'medium',timeStyle:v.includes?.('T')?'short':undefined}).format(new Date(v))}catch{return v}};
// Reviewer-chosen commercial classification. Project cost / Shared cost are
// legacy values: still shown on old decisions, no longer offered.
const COMMERCIAL_OPTIONS=['CUSTOMER_BILLABLE','JSAN_INTERNAL','SALARY_DEDUCTION','REFUND','REIMBURSEMENT'];
const COMMERCIAL_LABELS={CUSTOMER_BILLABLE:'Customer billable',JSAN_INTERNAL:'JSAN internal',SALARY_DEDUCTION:'Salary deduction',REFUND:'Refund',REIMBURSEMENT:'Reimbursement',PROJECT_COST:'Project cost (legacy)',SHARED_COST:'Shared cost (legacy)'};
// Net of a salary deduction. The deduction is in the transaction currency, so
// the billed (company-currency) figure is reduced by the same proportion.
function salaryNet(value,r,deduction=r.salary_deduction_amount){const d=Number(deduction)||0,base=Math.abs(Number(r.amount)||0);return d>0&&base&&value!=null?Number(value)*(1-Math.min(d,base)/base):value}
function commercialCell(r){const v=r.commercial_classification;if(!v)return '<span class="muted">—</span>';const label=esc(COMMERCIAL_LABELS[v]||sentenceCase(v));return v==='SALARY_DEDUCTION'&&r.salary_deduction_amount?`${label} · <b>${esc(fmtMoney(r.salary_deduction_amount,r.currency))}</b>`:label}
function netAmountCell(value,currency,r){const net=salaryNet(value,r);return net===value?esc(fmtMoney(value,currency)):`<span title="Before salary deduction: ${esc(fmtMoney(value,currency))}">${esc(fmtMoney(net,currency))}</span>`}
function toast(msg,bad=false){toastEl.textContent=msg;toastEl.className='toast show'+(bad?' bad':'');clearTimeout(toastEl._t);toastEl._t=setTimeout(()=>toastEl.className='toast',3200)}
function loadingMarkup(){return '<div class="loading-placeholder" aria-hidden="true"></div>'}
let activeDataRequests=0, dataLoadingTimer=null;
function beginDataLoading(){
  activeDataRequests++;
  if(activeDataRequests===1)dataLoadingTimer=setTimeout(()=>{
    if(!activeDataRequests||document.querySelector('#data-loading-indicator'))return;
    document.body.insertAdjacentHTML('beforeend','<div id="data-loading-indicator" class="data-loading-indicator" role="status"><span class="app-spinner" aria-hidden="true"></span><span>Loading&hellip;</span></div>');
  },250);
}
function endDataLoading(){
  activeDataRequests=Math.max(0,activeDataRequests-1);
  if(!activeDataRequests){clearTimeout(dataLoadingTimer);dataLoadingTimer=null;document.querySelector('#data-loading-indicator')?.remove();}
}
async function api(url,opt={}){const quiet=/heartbeat|data-version|sync-runs|daily-sync|\/pleo\/status/.test(url);if(!quiet)beginDataLoading();try{const r=await fetch(url,{...opt,headers:{Accept:'application/json',...(opt.headers||{})}});const ct=r.headers.get('content-type')||'';const p=ct.includes('json')?await r.json():await r.text();if(r.status===401&&!url.startsWith('/api/auth/login')){state.user=null;await renderLogin();throw new Error('Session expired')}if(!r.ok){const base=p?.error||p?.message||`HTTP ${r.status}`;throw new Error(p?.statusCode?`${base} (upstream HTTP ${p.statusCode})`:base)}return p}finally{if(!quiet)endDataLoading()}}
async function post(url,data={}){if(url.endsWith('/review'))data={...data,manual_category_name:document.querySelector('#manual-category')?.value||null,xpense_id:document.querySelector('#xpense-id')?.value||null,salary_deduction_amount:data.commercial_classification==='SALARY_DEDUCTION'?(document.querySelector('#salary-deduction')?.value||null):null};return api(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)})}
// The server owns sync/backfill jobs — this polls until the run reaches a
// terminal status, calling onProgress with each snapshot. Closing the browser
// mid-poll does not cancel the server-side job; reopening Pleo Sync and
// polling again would simply pick the same run back up.
async function pollSyncRun(runId,onProgress){
  for(;;){
    const x=await api(`/api/pleo/sync-runs/${runId}`);
    onProgress?.(x);
    if(x.run.status!=='RUNNING') return x;
    await new Promise(r=>setTimeout(r,1500));
  }
}
function brandLockup(context='GLOBAL GEOSPATIAL • FIELD OPERATIONS • TECHNOLOGY'){return `<div class="brand"><div class="brand-plate"><img class="brand-logo" src="/assets/jsan-logo.png" alt="JSAN" width="87" height="35"></div>${context?`<span class="brand-context">${context}</span>`:''}</div>`}

async function init(){try{const s=await api('/api/setup/status');if(s.setupRequired)return renderSetup();const me=await api('/api/me');state.user=me.user;if(state.user.must_change_password)return renderPasswordChange();await loadBootstrap();renderShell()}catch(e){if(!state.user)renderLogin()}}
function authFrame(inner){root.innerHTML=`<div class="auth-wrap"><section class="auth-hero"><div class="hero-topline">${brandLockup()}<div class="hero-sector">Internal Operations Platform<br>Finance • Validation • Governance</div></div><div class="hero-copy"><div class="kicker">JSAN Expensyra / Expense Intelligence &amp; Validation</div><h1>Validate spend.<br><em>Control delivery.</em></h1><p>From Pleo source evidence to accountable review: sync, allocate, validate, classify and govern field-operation expenses through one controlled JSAN workflow.</p><div class="hero-process"><div class="hero-step"><b>01</b><span>Sync</span></div><div class="hero-step"><b>02</b><span>Allocate</span></div><div class="hero-step"><b>03</b><span>Review</span></div><div class="hero-step"><b>04</b><span>Classify</span></div><div class="hero-step"><b>05</b><span>Validate</span></div><div class="hero-step"><b>06</b><span>Report</span></div></div></div><div class="hero-foot"><span><strong>JSAN Expensyra</strong> · Phase 1</span><span>Mobilise · Collect · Operate · Process · Validate · Deliver</span></div></section><section class="auth-panel">${inner}</section></div>`}
function renderSetup(){authFrame(`<div class="kicker">First-time setup</div><h2>Create the application administrator</h2><p>No default password is shipped with this build. Create the first JSAN admin account to initialise access.</p><form id="setup" class="form-grid"><div class="field"><label>Name</label><input name="name" required value="JSAN Expensyra Admin"></div><div class="field"><label>JSAN email</label><input name="email" type="email" required placeholder="name@jsanconsulting.com"></div><div class="field"><label>Password</label><input name="password" type="password" minlength="12" required placeholder="At least 12 characters"></div><button class="btn btn-primary">Create administrator</button><div id="auth-error"></div></form>`);document.querySelector('#setup').onsubmit=async e=>{e.preventDefault();const f=new FormData(e.currentTarget);try{await post('/api/setup/admin',Object.fromEntries(f));toast('Administrator created');renderLogin()}catch(x){document.querySelector('#auth-error').innerHTML=`<div class="error-box">${esc(x.message)}</div>`}}}
function renderPasswordChange(){authFrame(`<div class="kicker">Security requirement</div><h2>Change your temporary password</h2><p>Your administrator created this account with a temporary password. Set a new password before accessing Expensyra.</p><form id="change-password" class="form-grid"><div class="field"><label>Current temporary password</label><input name="current_password" type="password" required autocomplete="current-password"></div><div class="field"><label>New password</label><input name="new_password" type="password" minlength="12" required autocomplete="new-password"></div><div class="field"><label>Confirm new password</label><input name="confirm_password" type="password" minlength="12" required autocomplete="new-password"></div><button class="btn btn-primary">Change password & continue</button><button id="change-signout" type="button" class="btn btn-soft">Sign out</button><div id="auth-error"></div></form>`);document.querySelector('#change-password').onsubmit=async e=>{e.preventDefault();const f=Object.fromEntries(new FormData(e.currentTarget));if(f.new_password!==f.confirm_password)return document.querySelector('#auth-error').innerHTML='<div class="error-box">New passwords do not match.</div>';try{await post('/api/auth/change-password',{current_password:f.current_password,new_password:f.new_password});state.user.must_change_password=false;await loadBootstrap();renderShell();toast('Password changed')}catch(x){document.querySelector('#auth-error').innerHTML=`<div class="error-box">${esc(x.message)}</div>`}};document.querySelector('#change-signout').onclick=async()=>{await post('/api/auth/logout');state.user=null;renderLogin()}}
async function renderLogin(){authFrame(`<div class="kicker">Secure access</div><h2>Sign in to Expensyra</h2><p>Use the JSAN account created by your administrator.</p><form id="login" class="form-grid"><div class="field"><label>Email</label><input name="email" type="email" required autocomplete="username"></div><div class="field"><label>Password</label><input name="password" type="password" required autocomplete="current-password"></div><button class="btn btn-primary">Sign in</button><div id="auth-error"></div></form>`);document.querySelector('#login').onsubmit=async e=>{e.preventDefault();const f=new FormData(e.currentTarget);try{const p=await post('/api/auth/login',Object.fromEntries(f));state.user=p.user;if(state.user.must_change_password)return renderPasswordChange();await loadBootstrap();renderShell()}catch(x){document.querySelector('#auth-error').innerHTML=`<div class="error-box">${esc(x.message)}</div>`}}}
async function loadBootstrap(){state.bootstrap=await api('/api/bootstrap')}
const canManage=()=>['ADMIN','TEAM_LEAD'].includes(state.user?.role);const canSeeTeam=()=>['ADMIN','TEAM_LEAD','FINANCE_QC'].includes(state.user?.role);
function sidebarIcon(name){
  const paths={
    dashboard:'<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
    transactions:'<path d="M4 7h16m-4-4 4 4-4 4M20 17H4m4-4-4 4 4 4"/>',
    'car-rentals':'<path d="m5 7 2-4h10l2 4 2 3v8H3v-8l2-3Zm0 0h14M3 12h18M6 16h2m8 0h2M5 18v3m14-3v3"/>',
    pleo:'<path d="M20 7a9 9 0 0 0-15-2L2 8m0-5v5h5M4 17a9 9 0 0 0 15 2l3-3m0 5v-5h-5"/>',
    expense:'<path d="M4 3v18h17M8 16v-5m5 5V7m5 9V4"/>',
    revops:'<path d="M9 4H5v17h14V4h-4M9 3h6v4H9zM8 12h8m-8 4h5"/>',
    team:'<circle cx="9" cy="8" r="3"/><path d="M3 21v-3a6 6 0 0 1 12 0v3M16 5a3 3 0 0 1 0 6m2 4a5 5 0 0 1 3 5"/>',
    admin:'<path d="m12 3 8 4v5c0 5-8 9-8 9s-8-4-8-9V7l8-4Z"/><path d="m8 12 3 3 5-6"/>'
  };
  return '<svg class="nav-icon" width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'+(paths[name]||paths.dashboard)+'</svg>';
}
function navItems(){const a=[['dashboard','Overview'],['transactions',state.user.role==='REVIEWER'?'My Queue':'Transactions']];if(canManage())a.push(['pleo','Pleo Sync']);if(canSeeTeam())a.push(['expense','Expense Intelligence']);if(canSeeTeam())a.push(['revops','Review Operations']);if(canSeeTeam())a.push(['team','Team Performance']);if(canManage())a.push(['admin','Administration']);return a}
function renderShell(){const items=navItems();if(!items.some(([id])=>id===state.page))state.page='dashboard';try{sessionStorage.setItem('spendops.currentPage',state.page)}catch{}root.innerHTML=`<div class="shell"><aside class="sidebar"><div class="sidebar-branding"><div class="product-lockup"><h2 class="expensyra-brand"><img src="/assets/expensyra-logo-v1.png" alt="Expensyra" width="2172" height="724"></h2><div class="product">Expense Intelligence &amp; Validation</div></div></div><nav class="nav">${items.map(([id,l],i)=>`<button data-nav="${id}" data-index="${String(i+1).padStart(2,'0')}" class="${state.page===id?'active':''}">${sidebarIcon(id)}<span>${l}</span></button>`).join('')}</nav><div class="sidebar-spacer"></div><div class="user-card"><div class="user-name">${esc(state.user.name)}</div><div class="user-role">${esc(state.user.role.replaceAll('_',' '))}</div><button id="logout" class="logout">Sign out →</button></div></aside><main class="main"><header class="topbar"><div class="topbar-left"><span class="topbar-kicker">Operate • Finance • Validate</span><span class="topbar-divider"></span><h1 id="page-title">Expensyra</h1></div><div class="topbar-brand-group"><div id="sync-mini" class="sync-mini"><span class="dot"></span><span>Pleo status</span></div><div class="topbar-jsan"><img src="/assets/jsan-logo-transparent.png" alt="JSAN" width="87" height="35"></div></div></header><section id="content" class="content"></section></main><nav class="mobile-nav">${items.slice(0,4).map(([id,l])=>`<button data-nav="${id}" class="${state.page===id?'active':''}">${sidebarIcon(id)}<span>${l.split(' ')[0]}</span></button>`).join('')}</nav></div>`;document.querySelectorAll('[data-nav]').forEach(b=>b.onclick=()=>{closeModal(false);state.page=b.dataset.nav;state.revopsView='list';state.revopsReviewerId=null;renderShell();window.scrollTo(0,0)});document.querySelector('#logout').onclick=async()=>{await post('/api/auth/logout');state.user=null;renderLogin()};renderPage();updateSyncMini()}
async function updateSyncMini(){const el=document.querySelector('#sync-mini');if(!el||!canSeeTeam())return;try{const p=await api('/api/pleo/status');el.innerHTML=`<span class="dot ${p.configured?'ok':'warn'}"></span><span>${p.configured?(p.latest?.status==='FAILED'?'Pleo sync needs attention':'Pleo connected'):'Pleo not configured'}</span>`}catch{}}
function pageHead(title,sub,actions=''){document.querySelector('#page-title').textContent=title;return `<div class="page-head"><div class="page-head-copy"><div class="page-eyebrow">JSAN Expensyra / Internal Operations</div><h2>${esc(title)}</h2><p>${sub}</p></div>${actions?`<div class="actions">${actions}</div>`:''}</div>`}
async function renderPage(){const c=document.querySelector('#content');if(!c)return;c.innerHTML=loadingMarkup();try{if(state.page==='dashboard')await renderDashboard(c);else if(state.page==='transactions')await renderTransactions(c);else if(state.page==='car-rentals')await renderCarRentals(c);else if(state.page==='pleo')await renderPleo(c);else if(state.page==='team')await renderTeam(c);else if(state.page==='expense')await renderExpense(c);else if(state.page==='revops')await renderRevops(c);else if(state.page==='admin')await renderAdmin(c)}catch(e){c.innerHTML=`<div class="notice danger">${esc(e.message)}</div>`}}
async function renderDashboard(c){
  const d=await api('/api/dashboard');if(state.page!=='dashboard')return;
  document.querySelector('#page-title').textContent='Overview';
  const n=v=>fmtCount(Number(v)||0), counts=d.counts||{};
  const total=Number(counts.total)||0,completed=(Number(counts.approved)||0)+(Number(counts.rejected)||0);
  const rate=total?Math.min(100,Math.round(completed/total*100)):0;
  const stages=[['Unallocated','unassigned','#8094b0'],['Assigned','assigned','#477cdb'],['In review','in_review','#67b6cd'],['Needs information','needs_info','#d7a455'],['Approved','approved','#348a78'],['Rejected','rejected','#bf7278']];
  const metric=(label,value,note,accent='')=>`<article class="ov-metric ${accent}"><span>${label}</span><strong>${value}</strong><small>${note}</small></article>`;
  const sync=d.latestSync;
  const syncLabel=sync?sentenceCase(sync.status):'Not synced yet';
  const syncTone=sync?.status==='SUCCESS'?'ok':sync?.status==='RUNNING'?'running':'neutral';
  c.innerHTML=`<div class="overview-premium">
    <header class="ov-heading"><div><span class="ov-eyebrow">JSAN / FINANCE OPERATIONS</span><h2>Operations overview</h2><p>A clear view of your spending workflow.</p></div><span class="ov-date">${esc(new Date().toLocaleDateString('en-GB',{weekday:'long',day:'numeric',month:'long'}))}</span></header>
    <section class="ov-hero"><div class="ov-hero-copy"><span class="ov-eyebrow">YOUR WORKSPACE AT A GLANCE</span><h3>Every expense.<br>A clearer picture.</h3><p>Track your queue, focus your team's attention,<br>and keep reviews moving.</p><div class="ov-actions"><button class="btn" data-overview-page="transactions">${state.user.role==='REVIEWER'?'Open my queue':'View transactions'} <span aria-hidden="true">&rarr;</span></button>${canSeeTeam()?'<button class="ov-secondary" data-overview-page="expense">Expense intelligence <span aria-hidden="true">&rarr;</span></button>':''}</div></div><div class="ov-hero-stat"><span class="ov-eyebrow">REVIEW COMPLETION</span><div class="ov-ring" style="--progress:${rate}%"><div><strong>${rate}<span>%</span></strong><small>of all transactions</small></div></div><p><b>${n(completed)}</b> of ${n(total)} completed</p><small>Approved and rejected decisions</small></div></section>
    <section class="ov-metrics" aria-label="Operational metrics">${metric('Synced transactions',n(total),'Total records in your workspace')}${metric('Awaiting action',n(d.pending),'Transactions still to complete','ov-metric-accent')}${metric('Completed today',n(d.completedToday),'Approved + rejected')}${metric('Active review time',esc(fmtTime(d.activeSecondsToday||0)),'Recorded today')}</section>
    <div class="ov-bottom"><section class="ov-panel"><div class="ov-panel-heading"><div><span class="ov-eyebrow">WORKFLOW</span><h3>Queue health</h3></div><span class="ov-caption">All transactions</span></div><div class="ov-distribution" role="img" aria-label="Transaction status distribution">${stages.map(([label,key,color])=>`<span style="width:${total?(Number(counts[key])||0)/total*100:0}%;background:${color}" title="${label}: ${n(counts[key])}"></span>`).join('')}</div><div class="ov-stage-grid">${stages.map(([label,key,color])=>`<div class="ov-stage"><span><i style="background:${color}"></i>${label}</span><strong>${n(counts[key])}</strong></div>`).join('')}</div><div class="ov-panel-foot"><span>Keep the next review moving.</span><button data-overview-page="transactions">Open queue <span aria-hidden="true">&rarr;</span></button></div></section>
    <section class="ov-panel"><div class="ov-panel-heading"><div><span class="ov-eyebrow">DATA CONNECTION</span><h3>Latest Pleo sync</h3></div><span class="ov-sync-badge ${syncTone}"><i></i>${esc(syncLabel)}</span></div>${sync?`<p class="ov-sync-date">${esc(fmtDate(sync.started_at))}</p><div class="ov-sync-count"><strong>${n(sync.items_seen)}</strong><span>items processed</span></div><div class="ov-sync-split"><div><b>${n(sync.inserted_count)}</b><span>New records</span></div><div><b>${n(sync.updated_count)}</b><span>Refreshed records</span></div></div>`:'<div class="ov-no-sync"><b>Your connection starts here.</b><p>Run your first Pleo sync to bring transactions into the workspace.</p></div>'}<div class="ov-panel-foot"><span>Source: Pleo</span>${canManage()?'<button data-overview-page="pleo">View sync activity <span aria-hidden="true">&rarr;</span></button>':''}</div></section></div>
    <footer class="ov-footer"><span><b>${n(d.validationsToday)}</b> review actions today</span><span><b>${n(counts.needs_info)}</b> awaiting clarification</span><span>Active time counts recorded work sessions.</span></footer>
  </div>`;
  c.querySelectorAll('[data-overview-page]').forEach(button=>button.onclick=()=>{state.page=button.dataset.overviewPage;renderShell();window.scrollTo(0,0)});
}
const DRILL_FILTER_LABELS={category:'Category',project:'Project',currency:'Currency',commercial_classification:'Commercial type',merchant:'Merchant',receipt_status:'Evidence',month:'Month',source:'Source',project_status:'Project status',classification_status:'Classification status',category_status:'Category status',pleo_review:'Pleo review',dateFrom:'From',dateTo:'To'};
const PLEO_REVIEW_LABELS={OK:'Approved in Pleo',WAITING_FOR_REVIEWER:'Awaiting review in Pleo',WAITING_FOR_EXPENSE_OWNER:'Awaiting details from employee',NOT_REQUIRED:'No review required',NOT_OK:'Marked not OK in Pleo',NOT_SET:'Review not set'};
const SOURCE_LABELS={LIVE_API:'Live Pleo API',HISTORICAL_API:'Historical Pleo API',HISTORICAL_IMPORT:'Historical XLSX',DEMO:'Demo / fixture'};
function renderFilterChips(c){
  const active=Object.entries(state.filters).filter(([k,v])=>DRILL_FILTER_LABELS[k]&&v);
  if(!active.length)return'';
  return `<div class="toolbar" style="margin-bottom:10px">${active.map(([k,v])=>`<span class="status s-ASSIGNED" style="cursor:pointer" data-clear-chip="${k}">${esc(DRILL_FILTER_LABELS[k])}: ${esc(v)} ×</span>`).join('')}<button class="btn btn-ghost" id="clear-all-chips">Clear all</button></div>`;
}
// Transactions table: "Excel view" mirrors the Pleo expense export columns the
// finance team worked from (plus JSAN workflow columns); "Compact" is the
// original reviewer-oriented layout.
const PLEO_FAMILY_LABELS={CARD_PURCHASE:'Card Purchase',WALLET:'Wallet Load',REIMBURSEMENT:'Reimbursement',OUT_OF_POCKET:'Out of Pocket',BILL_INVOICE:'Bill Invoice',PLEO_INVOICE:'Pleo Invoice',CASHBACK:'Cashback'};
function expenseTypeLabel(r){
  if(!r.pleo_family)return r.expense_type||'—';
  const sub=r.pleo_sub_family;
  if(r.pleo_family==='CARD_PURCHASE'&&sub==='ATM')return'ATM Withdrawal';
  if(r.pleo_family==='REIMBURSEMENT')return sub==='REIMBURSEMENT_TO_EMPLOYEE_REFUND'?`Refund from ${r.employee_name||'employee'}`:`Reimbursement to ${r.employee_name||'employee'}`;
  return PLEO_FAMILY_LABELS[r.pleo_family]||r.pleo_family;
}
const pleoStatusChip=r=>'<span class="status '+(r.pleo_status==='PENDING'?'s-NEEDS_INFO':'s-UNASSIGNED')+'">'+esc(r.pleo_status||'Unknown')+'</span>';
const transactionAmount=r=>r.pleo_status==='PENDING'?'<b>'+esc(fmtMoney(r.amount,r.currency))+'</b><div class="small muted">Provisional - awaiting settlement</div>':r.bill_currency&&r.bill_amount!=null?esc(fmtMoney(r.bill_amount,r.bill_currency)):esc(fmtMoney(r.amount,r.currency));
const statusChip=r=>`<span class="status s-${r.status}">${r.status.replaceAll('_',' ')}</span>`;
// A Pleo team IS the JSAN project; the name shown is the Pleo team name.
const projectCell=r=>esc(r.effective_project_name||r.team_name||'—');
const TX_COLUMNS={
  compact:[
    ['Status',statusChip],['Pleo status',pleoStatusChip],['Date',r=>esc(fmtDate(r.transaction_date))],
    ['Employee',r=>`<b>${esc(r.employee_name||r.employee_id||'—')}</b>`],
    ['Merchant',r=>esc(r.merchant||'—'),'clip'],['Project',projectCell,'clip'],
    ['Category',r=>esc(r.resolved_category_name||r.category||r.expense_type||'—'),'clip'],
    ['Commercial Classification',commercialCell,'clip'],
    ['Amount',transactionAmount,'money'],
    ['Reviewer',r=>esc(r.reviewer_name||'Unallocated')],
  ],
  excel:[
    ['Date',r=>esc(fmtDate(r.transaction_date))],
    ['Expense Type',r=>esc(expenseTypeLabel(r))],
    ['Pleo status',pleoStatusChip],
    ['Amount',transactionAmount,'money'],
    ['Orig. amount',r=>netAmountCell(r.amount,r.currency,r),'money'],
    ['Source description',r=>esc(r.merchant||'—'),'clip'],
    ['Category',r=>esc(r.resolved_category_name||r.category||'—'),'clip'],
    ['Commercial Classification',commercialCell,'clip'],
    ['Owner',r=>esc(r.employee_name||'—')],
    ['Note',r=>`<span class="small">${esc(r.note||'')}</span>`,'clip'],
    ['Project',projectCell,'clip'],
    ['Receipts',r=>r.receipt_count?`${r.receipt_count}`:'<span class="muted">none</span>'],
    ['Employee Code',r=>esc(r.employee_code||'—')],
    ['Review Status',r=>esc(PLEO_REVIEW_LABELS[r.pleo_review_status]||r.pleo_review_status||'—')],
    ['Reviewer (Pleo)',r=>`<span class="small">${esc(r.pleo_reviewer_names||'')}</span>`,'clip'],
    ['Review Note',r=>`<span class="small">${esc(r.pleo_review_note||'')}</span>`,'clip'],
    ['Merchant Country',r=>esc(r.merchant_country||'—')],
    ['Expense ID',r=>`<span class="small muted">${esc(r.pleo_accounting_entry_id)}</span>`],
    ['Export Status',r=>esc(r.pleo_export_status||'—')],
    ['Billing Status',r=>esc(r.pleo_billing_status_tag_name||'—')],
    ['JSAN Status',statusChip],
    ['JSAN Reviewer',r=>esc(r.reviewer_name||'Unallocated')],
  ],
};
function renderTxTable(rows){
  const cols=TX_COLUMNS[state.txView]||TX_COLUMNS.excel;
  const head=`${canManage()?'<th><input id="tx-check-all" class="check" type="checkbox" aria-label="Select all on this page"></th>':''}${cols.map(([h,,cls])=>`<th${cls?` class="${cls}"`:''} style="white-space:nowrap">${esc(h)}</th>`).join('')}`;
  const body=rows.length?rows.map(r=>`<tr class="clickable" data-open="${r.id}">${canManage()?`<td><input class="check tx-check" data-id="${r.id}" type="checkbox" ${state.selected.has(r.id)?'checked':''}></td>`:''}${cols.map(([,cell,cls])=>{const html=cell(r);return `<td${cls?` class="${cls}"`:''}${cls==='clip'?` title="${html.replace(/<[^>]*>/g,'')}"`:''}>${html}</td>`}).join('')}</tr>`).join(''):`<tr><td colspan="${cols.length+1}"><div class="empty">No transactions match this filter.</div></td></tr>`;
  return `<div class="table-wrap"><table class="table tx-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}
// Transactions page. The filter + allocation shell renders once; any filter
// change re-queries and swaps only #tx-results — no "Apply" step, and typing
// in the search box is never interrupted by a re-render.
const TX_FILTER_KEYS=['status','pleo_status','q','source','category','project','currency','commercial_classification','merchant','receipt_status','month','project_status','classification_status','category_status','pleo_review','dateFrom','dateTo','new_since'];
const TX_STATUSES=['UNASSIGNED','ASSIGNED','IN_REVIEW','NEEDS_INFO','APPROVED','REJECTED'];
const TX_FILTER_NAMES={...DRILL_FILTER_LABELS,pleo_status:'Pleo transaction status',status:'Status',q:'Search',project_status:'Project',dateFrom:'From',dateTo:'To',new_since:'New since'};
const ICON_SEARCH='<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" stroke-width="2"/><path d="m20 20-3.5-3.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
const fmtCount=n=>Number(n||0).toLocaleString('en-GB');
const sentenceCase=v=>String(v).replaceAll('_',' ').toLowerCase().replace(/^./,m=>m.toUpperCase());
let txLoadSeq=0;
function txFilterValueLabel(k,v){
  if(k==='project')return state.filterOptions?.projects.find(o=>o.value===v)?.name||v;
  if(k==='pleo_review')return PLEO_REVIEW_LABELS[v]||v;
  if(k==='project_status')return v==='MISSING_PROJECT'?'No project':sentenceCase(v);
  if(k==='status')return sentenceCase(v);
  if(k==='dateFrom'||k==='dateTo'||k==='new_since')return fmtDate(v);
  if(k==='source')return SOURCE_LABELS[v]||v;
  return v;
}
async function renderTransactions(c){
  const manage=canManage(),f=state.filters;
  if(manage&&!state.filterOptions)state.filterOptions=await api('/api/transactions/filter-options').catch(()=>null);
  const fo=state.filterOptions;
  const reviewers=(state.bootstrap.users||[]).filter(u=>u.role==='REVIEWER');
  const opt=(v,label,sel)=>`<option value="${esc(v)}" ${sel?'selected':''}>${esc(label)}</option>`;
  const projectSel=f.project_status==='MISSING_PROJECT'?'__missing':f.project;
  c.innerHTML=pageHead(state.user.role==='REVIEWER'?'My validation queue':'Transaction allocation & validation','Pleo expenses are synced into a controlled queue. Allocation and JSAN validation remain separate from the raw Pleo record.','<button id="tx-open-export" type="button" class="btn btn-primary">Export Excel</button>'+(canSeeTeam()?'<button id="tx-open-removal" type="button" class="btn btn-soft">Remove imported data</button>':''))+`
  ${canSeeTeam()?'<section id="tx-sync" class="tx-sync" aria-label="Daily Pleo sync"></section>':''}
  <details id="tx-export-panel" class="panel tx-export"><summary class="panel-head" style="cursor:pointer"><h3>Export Excel</h3><span class="small muted">Download by date range</span></summary><div class="panel-body"><p class="small muted">Exports all transaction columns and all rows in the selected dates, regardless of the table filters. Reviewers can export their assigned transactions. Dates follow the Transactions date column.</p><div class="toolbar"><label>From <input type="date" id="export-from" value="${esc(f.dateFrom)}"></label><label>To <input type="date" id="export-to" value="${esc(f.dateTo)}"></label><button type="button" id="tx-export-excel" class="btn btn-primary">Export Excel</button></div></div></details>
  <section class="tx-filters" aria-label="Filter transactions">
    <div class="tx-filter-heading"><div><h3>Find transactions</h3><span>Search your records or narrow the selection.</span></div><button type="button" id="tx-more-toggle" class="tx-more-toggle" aria-controls="tx-more-fields" aria-expanded="${Boolean(f.pleo_status||f.pleo_review||f.dateFrom||f.dateTo||f.source)}">More filters <span aria-hidden="true">+</span></button></div>
    <div class="tx-filter-grid">
      <label class="tx-search"><span class="tx-search-caption">Search transactions</span><div class="tx-search-control">${ICON_SEARCH}<input id="tx-search" type="search" placeholder="Search merchant, employee or Pleo ID" value="${esc(f.q)}" autocomplete="off" aria-label="Search transactions"></div></label>
      ${fo?`<label class="tx-field"><span>Project</span><select id="tx-project" data-filter>${opt('','All projects',!projectSel)}${opt('__missing',`No project · ${fmtCount(fo.missingProject.count)}`,projectSel==='__missing')}${fo.projects.map(o=>opt(o.value,`${o.name} · ${fmtCount(o.count)}`,projectSel===o.value)).join('')}</select></label>`:''}
      <label class="tx-field"><span>Evidence</span><select id="tx-evidence" data-filter title="Receipt evidence reported by Pleo. Counts follow the other filters.">${opt('','All transactions',!f.receipt_status)}${opt('present','With evidence',f.receipt_status==='present')}${opt('missing','Without evidence',f.receipt_status==='missing')}</select></label>
      <label class="tx-field"><span>JSAN status</span><select id="tx-status" data-filter>${opt('','Any status',!f.status)}${TX_STATUSES.map(s=>opt(s,sentenceCase(s),f.status===s)).join('')}</select></label>
    </div>
    <div id="tx-more-fields" class="tx-more-fields" ${f.pleo_status||f.pleo_review||f.dateFrom||f.dateTo||f.source?'':'hidden'}>
      <label class="tx-field"><span>Pleo status</span><select id="tx-pleo-status" data-filter>${opt('','All entries',!f.pleo_status)}${['PENDING','COMPLETED','DRAFT','CANCELLED','DECLINED','DELETED'].map(v=>opt(v,sentenceCase(v),f.pleo_status===v)).join('')}</select></label>
      ${fo?`<label class="tx-field"><span>Pleo review</span><select id="tx-pleo-review" data-filter>${opt('','Any Pleo review',!f.pleo_review)}${fo.pleoReview.map(o=>opt(o.value,`${PLEO_REVIEW_LABELS[o.value]||o.value} · ${fmtCount(o.count)}`,f.pleo_review===o.value)).join('')}</select></label>`:''}
      <div class="tx-field tx-dates"><span>Date range</span><div class="tx-date-range"><input id="tx-from" type="date" data-filter value="${esc(f.dateFrom)}" aria-label="From date"><span aria-hidden="true">→</span><input id="tx-to" type="date" data-filter value="${esc(f.dateTo)}" aria-label="To date"></div></div>
      <label class="tx-field"><span>Source</span><select id="tx-source" data-filter>${opt('','All sources',!f.source)}${Object.entries(SOURCE_LABELS).map(([v,l])=>opt(v,l,f.source===v)).join('')}</select></label>
      <p class="tx-date-note">Dates use settlement date, or purchase date for pending entries.</p>
    </div>
    <div class="tx-filter-foot"><div id="tx-chips" class="tx-chips"></div><button type="button" id="tx-show-pending" class="btn btn-soft">Pending Pleo entries</button><div id="tx-count" class="tx-count" aria-live="polite"></div></div>
  </section>
  ${manage?`<section class="tx-alloc" aria-label="Allocate work">
    <div><div class="kicker">Allocate work</div><div class="tx-alloc-meta"><b id="tx-sel-count">${fmtCount(state.selected.size)}</b> selected <span aria-hidden="true">·</span> <b id="tx-match-count">—</b> matching filters</div></div>
    <div class="tx-alloc-actions"><select id="bulk-reviewer" aria-label="Reviewer">${reviewers.length?`<option value="">Choose reviewer…</option>${reviewers.map(r=>`<option value="${r.id}">${esc(r.name)}</option>`).join('')}`:'<option value="">No reviewers yet — add one in Administration</option>'}</select>
    <button id="bulk-assign" class="btn btn-ghost-dark">Allocate selected</button><button id="bulk-assign-all" class="btn btn-accent" disabled>Assign all matching</button></div>
  </section>`:''}
  ${state.user.role==='ADMIN'?`<details id="tx-import-removal" class="panel"><summary class="panel-head" style="cursor:pointer">Remove imported data</summary><div class="panel-body"><p>Remove unassigned, unreviewed imports for a transaction date range. Assigned or reviewed records are protected. This uses transaction dates, not the date you ran the sync, and ignores table filters. Pleo itself is unchanged; syncing these dates again can import the records again.</p><div class="toolbar"><label>From <input id="remove-import-from" type="date"></label><label>To <input id="remove-import-to" type="date"></label><button id="remove-import-preview" class="btn btn-soft">Preview removal</button></div><div id="remove-import-result" aria-live="polite"></div></div></details>`:''}
  <div id="tx-results" class="tx-results"></div>`;

  c.querySelector('#tx-open-export').addEventListener('click',()=>{
    const panel=c.querySelector('#tx-export-panel');panel.open=true;panel.scrollIntoView({behavior:'smooth',block:'center'});c.querySelector('#export-from').focus({preventScroll:true});
  });
  c.querySelector('#tx-export-excel').addEventListener('click',async e=>{
    const button=e.currentTarget,from=c.querySelector('#export-from').value,to=c.querySelector('#export-to').value;
    if(!from||!to||from>to)return toast('Choose a valid From and To date.',true);
    button.disabled=true;beginDataLoading();
    try{
      const response=await fetch('/api/transactions/export?'+new URLSearchParams({dateFrom:from,dateTo:to}));
      if(!response.ok){const error=await response.json();throw Error(error.error||'Export failed');}
      const blob=await response.blob(),url=URL.createObjectURL(blob),link=document.createElement('a');
      link.href=url;link.download='PleoExported_Data_'+from+'_to_'+to+'.xlsx';document.body.appendChild(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);
      toast('Excel export downloaded');
    }catch(error){toast(error.message,true)}finally{button.disabled=false;endDataLoading();}
  });
  c.querySelector('#tx-more-toggle').addEventListener('click',e=>{
    const button=e.currentTarget,panel=c.querySelector('#tx-more-fields');panel.hidden=!panel.hidden;
    button.setAttribute('aria-expanded',String(!panel.hidden));button.innerHTML=(panel.hidden?'More filters':'Fewer filters')+' <span aria-hidden="true">'+(panel.hidden?'+':'&minus;')+'</span>';
  });
  c.querySelector('#tx-open-removal')?.addEventListener('click',()=>{
    const panel=c.querySelector('#tx-import-removal');
    if(!panel){toast('Removing imported data requires an Admin account. Please sign in as an admin or ask your admin to remove the date range.',true);return;}
    panel.open=true;panel.scrollIntoView({behavior:'smooth',block:'start'});c.querySelector('#remove-import-from').focus({preventScroll:true});
  });
  c.querySelector('#remove-import-preview')?.addEventListener('click',async()=>{
    const result=c.querySelector('#remove-import-result'),button=c.querySelector('#remove-import-preview');
    const dateFrom=c.querySelector('#remove-import-from').value,dateTo=c.querySelector('#remove-import-to').value;
    button.disabled=true;result.innerHTML='';
    try{
      const p=await post('/api/transactions/import-removal/preview',{dateFrom,dateTo});
      result.innerHTML='<p><b>'+fmtCount(p.removable)+' transactions can be removed</b> from '+esc(dateFrom)+' to '+esc(dateTo)+'. '+fmtCount(p.protected)+' protected records will be kept.</p>'+
        (p.sample.length?'<p class="small">First matching transaction IDs: '+p.sample.map(t=>esc(t.id)).join(', ')+'</p>':'')+
        (p.removable?'<button id="remove-import-confirm" class="btn btn-dark">Confirm removal of '+fmtCount(p.removable)+' transactions</button>':'');
      c.querySelector('#remove-import-confirm')?.addEventListener('click',async e=>{
        e.target.disabled=true;
        try{const r=await post('/api/transactions/import-removal/confirm',{dateFrom,dateTo,token:p.token});state.selected.clear();state.filterOptions=null;state.txPage=1;toast(fmtCount(r.removed)+' imported transactions removed');await renderTransactions(c)}
        catch(err){result.textContent=err.message+' Preview again before retrying.'}
      });
    }catch(e){result.textContent=e.message}finally{button.disabled=false}
  });
  for(const id of ['#remove-import-from','#remove-import-to'])c.querySelector(id)?.addEventListener('change',()=>{c.querySelector('#remove-import-result').innerHTML=''});

  c.querySelector('#tx-show-pending').onclick=()=>{for(const k of TX_FILTER_KEYS)f[k]='';f.pleo_status='PENDING';state.txPage=1;state.selected.clear();renderTransactions(c)};
  const refresh=()=>{state.txPage=1;state.selected.clear();loadTxResults(c)};
  c.querySelectorAll('[data-filter]').forEach(el=>el.addEventListener('change',()=>{
    const pj=document.querySelector('#tx-project');
    if(pj){if(pj.value==='__missing'){f.project='';f.project_status='MISSING_PROJECT'}else{f.project=pj.value;if(f.project_status==='MISSING_PROJECT')f.project_status=''}}
    f.pleo_status=document.querySelector('#tx-pleo-status').value;f.status=document.querySelector('#tx-status').value;f.source=document.querySelector('#tx-source').value;
    f.receipt_status=document.querySelector('#tx-evidence').value;
    const pr=document.querySelector('#tx-pleo-review');if(pr)f.pleo_review=pr.value;
    f.dateFrom=document.querySelector('#tx-from').value;f.dateTo=document.querySelector('#tx-to').value;
    refresh();
  }));
  const search=document.querySelector('#tx-search');let debounce;
  const runSearch=()=>{clearTimeout(debounce);const v=search.value.trim();if(v!==f.q){f.q=v;refresh()}};
  search.addEventListener('input',()=>{clearTimeout(debounce);debounce=setTimeout(runSearch,350)});
  search.addEventListener('keydown',e=>{if(e.key==='Enter')runSearch()});

  if(manage){
    const chosenReviewer=()=>{const rid=Number(document.querySelector('#bulk-reviewer').value);if(!rid)toast('Choose a reviewer first',true);return rid};
    document.querySelector('#bulk-assign-all').onclick=async()=>{
      const rid=chosenReviewer();if(!rid)return;const who=reviewers.find(r=>r.id===rid)?.name||'reviewer';const total=state.txTotal||0;
      const filter={};for(const k of TX_FILTER_KEYS)if(f[k])filter[k]=f[k];
      const warn=f.status==='UNASSIGNED'?'':'\n\nJSAN status is not "Unassigned", so transactions already allocated to other reviewers will be re-allocated. Approved/rejected ones are skipped.';
      if(!confirm(`Assign all ${fmtCount(total)} matching transaction(s) to ${who}?${warn}`))return;
      try{const r=await post('/api/assign',{reviewer_id:rid,filter,expected_count:total});state.selected.clear();state.filterOptions=null;toast(`${fmtCount(r.assigned)} transaction(s) allocated to ${who}${r.skippedFinal?` · ${r.skippedFinal} already final, skipped`:''}`);renderTransactions(c)}catch(e){toast(e.message,true)}
    };
    document.querySelector('#bulk-assign').onclick=async()=>{
      const rid=chosenReviewer();if(!rid)return;if(!state.selected.size)return toast('Tick at least one transaction',true);
      try{const r=await post('/api/assign',{reviewer_id:rid,transaction_ids:[...state.selected]});state.selected.clear();state.filterOptions=null;toast(`${fmtCount(r.assigned)} transaction(s) allocated`);renderTransactions(c)}catch(e){toast(e.message,true)}
    };
  }
  if(canSeeTeam())renderTxSync(c).catch(e=>{const el=document.querySelector('#tx-sync');if(el)el.innerHTML=`<div class="tx-sync-status"><span class="dot warn"></span>${esc(e.message)}</div>`});
  await loadTxResults(c);
}
// Daily Pleo sync bar. Admins/team leads can switch the daily run on, pick
// the time and run it on demand; Finance QC sees the status read-only.
// "Show new" filters the list to rows first seen by the latest sync, which is
// the day's allocation/approval worklist.
const TX_SYNC_RANGES=[['24h','Last 24 hours'],['since','Since last sync'],['7d','Last 7 days'],['30d','Last 30 days'],['custom','Custom date range…']];
// YYYY-MM-DD for today + offset days, in the browser's local calendar.
const localDay=(offset=0)=>{const x=new Date();x.setDate(x.getDate()+offset);return `${x.getFullYear()}-${String(x.getMonth()+1).padStart(2,'0')}-${String(x.getDate()).padStart(2,'0')}`};
const syncTzLabel=tz=>String(tz||'').split('/').pop().replaceAll('_',' ')+' time';
function txSyncStatus(d,live){
  if(live)return `<span class="dot busy"></span><span><b>Syncing from Pleo…</b> ${fmtCount(live.items_seen)} read · ${fmtCount(live.inserted_count)} new so far</span>`;
  if(!d.configured)return '<span class="dot warn"></span><span>Pleo credentials are not configured — see Pleo Sync.</span>';
  const r=d.lastRun,ok=d.lastSuccess;
  const failed=r&&r.status!=='SUCCESS'&&r.status!=='RUNNING'?`<span class="tx-sync-err" title="${esc(r.error_message||'')}">Last attempt ${esc(sentenceCase(r.status))} ${esc(fmtDate(r.started_at))}</span>`:'';
  const last=ok?`Last synced <b>${esc(fmtDate(ok.finished_at||ok.started_at))}</b> · ${fmtCount(ok.inserted_count)} new · ${fmtCount(ok.updated_count)} refreshed`:'Never synced';
  const next=d.enabled?` · Next ${d.next.due?'<b>due now</b>':`${esc(d.next.day)} ${esc(d.next.time)}`}`:' · Daily sync is off';
  return `<span class="dot ${failed?'warn':ok?'ok':''}"></span><span>${last}${next}${failed?` · ${failed}`:''}</span>`;
}
async function renderTxSync(c,live=null){
  const el=document.querySelector('#tx-sync');if(!el)return;
  const d=await api('/api/pleo/daily-sync');if(!document.body.contains(el))return;
  const manage=canManage(),busy=Boolean(live||d.running);
  el.innerHTML=`<div class="tx-sync-main">
      <label class="tx-switch"><input id="ds-enabled" type="checkbox" role="switch" ${d.enabled?'checked':''} ${manage&&d.configured?'':'disabled'}><span class="tx-switch-track" aria-hidden="true"></span><span class="tx-switch-label">Daily Pleo sync</span></label>
      <label class="tx-sync-time"><span>at</span><input id="ds-time" type="time" value="${esc(d.time)}" ${manage?'':'disabled'} aria-label="Daily sync time"><span class="muted small">${esc(syncTzLabel(d.timezone))}</span></label>
    </div>
    <div id="ds-status" class="tx-sync-status" aria-live="polite">${txSyncStatus(d,live||d.running)}</div>
    <div class="tx-sync-actions">
      ${d.newSinceLastSync&&d.lastSuccess?`<button id="ds-show-new" type="button" class="btn btn-soft">${state.filters.new_since?'Showing':'Show'} ${fmtCount(d.newSinceLastSync)} new</button>`:''}
      ${manage?(busy
        ?`<button id="ds-stop" type="button" class="btn btn-danger" ${d.stopping?'disabled':''}>${d.stopping?'Stopping…':'Stop sync'}</button>`
        :`<select id="ds-range" class="tx-sync-range" aria-label="Sync range" ${d.configured?'':'disabled'}>${TX_SYNC_RANGES.filter(([v])=>v!=='since'||d.checkpoint).map(([v,l])=>`<option value="${v}" ${state.txSyncRange===v?'selected':''}>${esc(v==='since'?`${l} (${fmtDate(d.checkpoint)})`:l)}</option>`).join('')}</select>
          <span id="ds-custom" class="tx-sync-custom" ${state.txSyncRange==='custom'?'':'hidden'}><input id="ds-from" type="date" max="${localDay(0)}" value="${esc(state.txSyncFrom||localDay(-7))}" aria-label="Sync from date"><span aria-hidden="true">→</span><input id="ds-to" type="date" max="${localDay(0)}" value="${esc(state.txSyncTo||localDay(0))}" aria-label="Sync to date"></span>
          <button id="ds-now" type="button" class="btn btn-primary" ${d.configured?'':'disabled'}>Sync now</button>`):''}
    </div>`;
  const rangeSel=el.querySelector('#ds-range'),custom=el.querySelector('#ds-custom');
  rangeSel?.addEventListener('change',()=>{state.txSyncRange=rangeSel.value;custom.hidden=rangeSel.value!=='custom'});
  el.querySelectorAll('#ds-from,#ds-to').forEach(i=>i.addEventListener('change',()=>{state.txSyncFrom=el.querySelector('#ds-from').value;state.txSyncTo=el.querySelector('#ds-to').value}));
  const save=async body=>{try{await post('/api/pleo/daily-sync',body);toast(body.enabled===false?'Daily sync turned off':'Daily sync saved');renderTxSync(c)}catch(e){toast(e.message,true);renderTxSync(c)}};
  const en=el.querySelector('#ds-enabled'),tm=el.querySelector('#ds-time');
  if(manage){
    en.onchange=()=>save({enabled:en.checked,time:tm.value});
    tm.onchange=()=>{if(tm.value)save({time:tm.value})};
  }
  el.querySelector('#ds-show-new')?.addEventListener('click',()=>{state.filters.new_since=d.lastSuccess.started_at;state.txPage=1;state.selected.clear();renderTransactions(c)});
  el.querySelector('#ds-now')?.addEventListener('click',async()=>{
    const range=el.querySelector('#ds-range').value,hours={'24h':24,'7d':168,'30d':720}[range];
    let from=hours?new Date(Date.now()-hours*3600_000).toISOString():null,to=null;
    if(range==='custom'){
      const f=el.querySelector('#ds-from').value,t=el.querySelector('#ds-to').value;
      if(!f||!t)return toast('Choose both a From and a To date',true);
      if(t<f)return toast('To date must be on or after the From date',true);
      // Whole local days: From 00:00 to the end of the To day (capped at now by the server).
      from=new Date(f+'T00:00:00').toISOString();to=new Date(t+'T23:59:59.999').toISOString();
      if((Date.parse(to)-Date.parse(from))/86400_000>d.maxRangeDays+1)return toast(`Choose at most ${d.maxRangeDays} days. Use Pleo Sync → historical backfill for longer periods.`,true);
    }
    const dayLabel=v=>new Intl.DateTimeFormat('en-GB',{dateStyle:'medium'}).format(new Date(v+'T00:00:00'));
    const span=range==='custom'?`${dayLabel(el.querySelector('#ds-from').value)} to ${dayLabel(el.querySelector('#ds-to').value)} (whole days)`:`${fmtDate(from||d.checkpoint)} to now`;
    if(!confirm(`Fetch Pleo transactions settled from ${span}?\n\nNew rows are added to Transactions; existing rows are refreshed without changing assignments or approvals. You can stop the sync while it runs — anything it added is then removed.`))return;
    try{const r=await post('/api/pleo/sync',from?{from,...(to?{to}:{})}:{});renderTxSync(c,{items_seen:0,inserted_count:0});await followTxSync(c,r.runId)}catch(e){toast(e.message,true);renderTxSync(c)}
  });
  el.querySelector('#ds-stop')?.addEventListener('click',async()=>{
    if(!confirm('Stop the Pleo sync?\n\nTransactions this sync has added so far will be removed.'))return;
    const b=el.querySelector('#ds-stop');b.disabled=true;b.textContent='Stopping…';
    try{await post('/api/pleo/sync/stop')}catch(e){toast(e.message,true);renderTxSync(c)}
  });
  if(d.running&&!live)followTxSync(c,d.running.id).catch(()=>{});
}
let txSyncFollowing=null;
async function followTxSync(c,runId){
  const btn=document.querySelector('#ds-now');if(btn){btn.disabled=true;btn.textContent='Syncing…'}
  if(txSyncFollowing===runId)return;txSyncFollowing=runId;
  let x;try{x=await pollSyncRun(runId,p=>{const s=document.querySelector('#ds-status');if(s)s.innerHTML=txSyncStatus({},p.run)})}finally{txSyncFollowing=null}
  if(!document.querySelector('#tx-sync'))return; // user left the page; the server keeps syncing regardless
  if(x.run.status==='SUCCESS')toast(`Pleo sync complete · ${fmtCount(x.run.inserted_count)} new, ${fmtCount(x.run.updated_count)} refreshed`);else if(x.run.status==='CANCELLED')toast(x.run.error_message||'Pleo sync stopped');else toast(`Pleo sync ${sentenceCase(x.run.status)}: ${x.run.error_message||'see Pleo Sync'}`,true);
  // A sync can create projects for new Pleo teams — refresh the project list too.
  state.filterOptions=null;await loadBootstrap().catch(()=>{});renderTransactions(c);
}
async function loadTxResults(c){
  const out=document.querySelector('#tx-results');if(!out)return;
  const seq=++txLoadSeq,f=state.filters,manage=canManage();
  const q=new URLSearchParams();for(const k of TX_FILTER_KEYS)if(f[k])q.set(k,f[k]);
  q.set('limit',state.txPageSize);q.set('offset',(state.txPage-1)*state.txPageSize);
  out.classList.add('is-loading');if(!out.innerHTML)out.innerHTML=loadingMarkup();
  let p;
  try{p=await api('/api/transactions?'+q)}catch(e){if(seq===txLoadSeq){out.classList.remove('is-loading');out.innerHTML=`<div class="error-box">${esc(e.message)}</div>`}return}
  if(seq!==txLoadSeq||!document.body.contains(out))return; // a newer filter change superseded this request
  state.txTotal=p.total;const rows=p.rows;
  const evidence=c.querySelector('#tx-evidence');
  if(evidence&&p.evidenceCounts){for(const option of evidence.options){const key=option.value||'total';option.textContent=({'':'All transactions',present:'With evidence',missing:'Without evidence'}[option.value])+' ('+fmtCount(p.evidenceCounts[key])+')';}}

  document.querySelector('#tx-show-pending').textContent='Pending Pleo entries ('+fmtCount(p.pendingTotal)+')';
  const pageStart=rows.length?p.offset+1:0,pageEnd=p.offset+rows.length;

  const active=TX_FILTER_KEYS.filter(k=>f[k]);
  document.querySelector('#tx-chips').innerHTML=active.length
    ?active.map(k=>`<button type="button" class="tx-chip" data-clear="${k}" aria-label="Remove filter ${esc(TX_FILTER_NAMES[k]||k)}"><span>${esc(TX_FILTER_NAMES[k]||k)}</span>${esc(txFilterValueLabel(k,f[k]))}<i aria-hidden="true">×</i></button>`).join('')+'<button type="button" class="tx-reset" id="tx-reset">Reset all</button>'
    :'<span class="tx-hint">No filters applied — showing every transaction</span>';
  document.querySelector('#tx-count').innerHTML=`<b>${fmtCount(p.total)}</b> transaction${p.total===1?'':'s'}`;
  if(manage){
    document.querySelector('#tx-match-count').textContent=fmtCount(p.total);
    const all=document.querySelector('#bulk-assign-all');all.disabled=!p.total;all.textContent=`Assign all ${fmtCount(p.total)} matching`;
  }
  out.classList.remove('is-loading');
  out.innerHTML=`<div class="panel"><div class="panel-head"><h3>Showing ${fmtCount(pageStart)}–${fmtCount(pageEnd)} of ${fmtCount(p.total)}</h3><div class="seg" role="group" aria-label="Table layout"><button type="button" data-view="excel" class="${state.txView==='excel'?'on':''}">Excel view</button><button type="button" data-view="compact" class="${state.txView==='compact'?'on':''}">Compact</button></div></div>${renderTxTable(rows)}<div class="tx-pager"><select id="tx-pagesize" aria-label="Rows per page">${[25,50,100].map(n=>`<option value="${n}" ${state.txPageSize===n?'selected':''}>${n} per page</option>`).join('')}</select><div class="tx-pager-nav"><button id="tx-prev" class="btn btn-ghost" ${p.page<=1?'disabled':''}>← Previous</button><span class="small muted">Page ${fmtCount(p.page)} of ${fmtCount(p.totalPages)}</span><button id="tx-next" class="btn btn-ghost" ${p.page>=p.totalPages?'disabled':''}>Next →</button></div></div></div>`;

  document.querySelectorAll('#tx-chips [data-clear]').forEach(b=>b.onclick=()=>{const k=b.dataset.clear;f[k]='';state.txPage=1;state.selected.clear();renderTransactions(c)});
  document.querySelector('#tx-reset')?.addEventListener('click',()=>{for(const k of TX_FILTER_KEYS)f[k]='';state.txPage=1;state.selected.clear();renderTransactions(c)});
  const selCount=()=>{const el=document.querySelector('#tx-sel-count');if(el)el.textContent=fmtCount(state.selected.size)};
  document.querySelectorAll('.tx-check').forEach(x=>x.onclick=e=>{e.stopPropagation();const id=Number(x.dataset.id);x.checked?state.selected.add(id):state.selected.delete(id);selCount()});
  const checkAll=document.querySelector('#tx-check-all');
  if(checkAll){const boxes=[...document.querySelectorAll('.tx-check')];checkAll.checked=boxes.length>0&&boxes.every(b=>b.checked);
    checkAll.onclick=e=>{e.stopPropagation();for(const b of boxes){b.checked=checkAll.checked;const id=Number(b.dataset.id);checkAll.checked?state.selected.add(id):state.selected.delete(id)}selCount()}}
  document.querySelectorAll('[data-open]').forEach(tr=>tr.onclick=e=>{if(e.target.classList.contains('tx-check'))return;openTransaction(Number(tr.dataset.open))});
  document.querySelectorAll('.seg [data-view]').forEach(b=>b.onclick=()=>{state.txView=b.dataset.view;try{localStorage.setItem('spendops.txView',state.txView)}catch{}loadTxResults(c)});
  document.querySelector('#tx-pagesize').onchange=e=>{state.txPageSize=Number(e.target.value);state.txPage=1;loadTxResults(c)};
  document.querySelector('#tx-prev').onclick=()=>{if(state.txPage>1){state.txPage--;loadTxResults(c)}};
  document.querySelector('#tx-next').onclick=()=>{if(state.txPage<p.totalPages){state.txPage++;loadTxResults(c)}};
}
async function openTransaction(id){const p=await api(`/api/transactions/${id}`);state.modal=p;const tx=p.tx;const active=p.sessions.find(s=>!s.ended_at&&s.user_id===state.user.id);const canWork=tx.reviewer_id===state.user.id||canSeeTeam();const final=['APPROVED','REJECTED'].includes(tx.status);const projects=state.bootstrap.projects||[];document.body.insertAdjacentHTML('beforeend',`<div id="tx-modal" class="modal-wrap"><div class="modal"><div class="modal-head"><div><div class="kicker">Pleo ${esc(tx.source_mode)}</div><h3>${esc(tx.pleo_reconciliation_id||tx.pleo_accounting_entry_id)}</h3></div><button id="modal-close" class="close">×</button></div><div class="modal-body"><div class="workbench"><section><div class="tx-title"><div><h2>${esc(tx.merchant||'Expense')}</h2><div class="muted">${esc(tx.employee_name||tx.employee_id||'Unknown employee')} · ${esc(fmtDate(tx.transaction_date))}</div></div><div class="amount-big">${transactionAmount(tx)}</div></div><div class="meta-grid"><div class="meta"><span>Status</span><b><span class="status s-${tx.status}">${tx.status.replaceAll('_',' ')}</span></b></div><div class="meta"><span>Reviewer</span><b>${esc(tx.reviewer_name||'Unallocated')}</b></div><div class="meta"><span>Category</span><b>${esc(tx.resolved_category_name||tx.category||'—')}</b></div><div class="meta"><span>Pleo transaction status</span><b>${pleoStatusChip(tx)}</b></div><div class="meta"><span>Type</span><b>${esc(tx.expense_type||'—')}</b></div><div class="meta"><span>Tags</span><b>${esc(tx.tags||'—')}</b></div><div class="meta"><span>Pleo review</span><b>${esc(tx.pleo_review_status_label||tx.pleo_review_status||'—')}</b></div><div class="meta"><span>Project</span><b>${esc(tx.project_code?(tx.project_code===tx.attributed_project_code?tx.attributed_project_name:tx.project_code):(tx.attributed_project_name||tx.team_name||(tx.project_status==='PROJECT_ATTRIBUTION_CONFLICT'?'Conflicting project evidence':'Not set')))}</b></div></div><div class="panel"><div class="panel-head"><h3>Receipt evidence</h3><span class="small muted">${(p.receipts||[]).length} file(s) · loaded live from Pleo</span></div><div class="panel-body">${(p.receipts||[]).length?`<div class="receipt-grid">${p.receipts.map(r=>`<a class="receipt-card${r.error?' is-doc':''}" target="_blank" rel="noopener" href="${esc(r.url)}" title="Open ${esc(r.label)} in a new tab"><span class="receipt-thumb"><span class="receipt-wait">Loading from Pleo…</span>${r.error?'':`<img src="${esc(r.url)}" alt="${esc(r.label)}" loading="lazy" onerror="this.closest('.receipt-card').classList.add('is-doc')">`}<span class="receipt-doc"><b>PDF / document</b><span>Click to open</span></span></span><span class="receipt-meta"><b>${esc(r.label)}</b><span>${r.error?esc('Unavailable'):'Open ↗'}</span></span></a>`).join('')}</div>`:'<div class="muted small">Pleo has no receipt attached to this expense.</div>'}</div></div>${tx.note?`<div class="notice" style="margin-top:14px"><b>Pleo note:</b> ${esc(tx.note)}</div>`:''}${tx.pleo_reviewer_names||tx.pleo_review_note?`<div class="notice" style="margin-top:14px"><b>Pleo review history:</b> ${esc(tx.pleo_review_status_label||'')}${tx.pleo_reviewer_names?` · ${esc(tx.pleo_reviewer_names)}`:''}${tx.pleo_review_note?`<div style="margin-top:6px">${esc(tx.pleo_review_note)}</div>`:''}</div>`:''}<div class="divider"></div><div><div class="kicker">Audit trail</div><div class="audit-list" style="margin-top:10px">${p.audit.length?p.audit.slice(0,15).map(a=>`<div class="audit-entry"><b>${esc(a.action.replaceAll('_',' '))}</b> · ${esc(a.actor_name||'System')} · ${esc(fmtDate(a.created_at))}${a.action==='DECISION_REOPENED'?(()=>{try{const d=typeof a.detail==='string'?JSON.parse(a.detail):a.detail;return d?.reason?`<div class="small muted">Was ${esc(sentenceCase(d.previous_status||''))} · Reason: ${esc(d.reason)}</div>`:''}catch{return ''}})():''}</div>`).join(''):'<div class="muted small">No JSAN actions yet.</div>'}</div></div></section><aside><div class="timer-card"><div class="timer-row"><div><div class="kicker">Active validation</div><div id="timer" class="timer">00:00</div></div><span class="status ${active?'s-IN_REVIEW':'s-UNASSIGNED'}">${active?'RUNNING':'PAUSED'}</span></div><p>Time is heartbeat-verified and auto-pauses after ${Math.max(1,Math.round((state.bootstrap?.config?.idleTimeoutSeconds||150)/60))} minutes without heartbeat activity.</p><div class="timer-actions"><button id="start-work" class="btn btn-primary" ${!canWork||final||active?'disabled':''}>Start validation</button><button id="pause-work" class="btn btn-ghost" style="color:white;border-color:#31505d" ${!active?'disabled':''}>Pause</button></div></div><div class="panel"><div class="panel-head"><h3>JSAN validation</h3></div><div class="panel-body"><div class="form-grid"><div class="field"><label>Commercial classification</label><select id="classification" ${final?'disabled':''}><option value="">Select classification</option>${[...COMMERCIAL_OPTIONS,...(tx.commercial_classification&&!COMMERCIAL_OPTIONS.includes(tx.commercial_classification)?[tx.commercial_classification]:[])].map(v=>`<option value="${v}" ${tx.commercial_classification===v?'selected':''} ${COMMERCIAL_OPTIONS.includes(v)?'':'disabled'}>${esc(COMMERCIAL_LABELS[v]||sentenceCase(v))}</option>`).join('')}</select></div><div class="field"><label>Project</label><select id="project" ${final?'disabled':''}><option value="">Select project</option>${projects.map(v=>`<option value="${v.code}" ${(tx.project_code||tx.attributed_project_code)===v.code?'selected':''}>${esc(v.name)}</option>`).join('')}</select></div><div class="field"><label>Reviewer notes</label><textarea id="review-notes" ${final?'disabled':''} placeholder="Reason, policy exception, clarification required…">${esc(tx.reviewer_notes||'')}</textarea></div>${final?`<div class="notice final-decision"><div><b>Final decision:</b> ${esc(sentenceCase(tx.decision||tx.status))}${tx.completed_at?` · ${esc(fmtDate(tx.completed_at))}`:''}</div>${tx.reviewer_id===state.user.id||canSeeTeam()?'<button id="reopen-tx" type="button" class="btn btn-soft">Edit &amp; re-check</button>':''}</div>`:`<div class="decision-row"><button data-decision="APPROVED" class="btn btn-primary">Approve</button><button data-decision="NEEDS_INFO" class="btn btn-soft">Need info</button><button data-decision="REJECTED" class="btn btn-danger">Reject</button></div>`}</div></div></div></aside></div></div></div></div>`);document.querySelector('#modal-close').onclick=()=>closeModal(true);if(active)startLocalTimer(tx.id,active.started_at);document.querySelector('#start-work')?.addEventListener('click',async()=>{try{const r=await post(`/api/transactions/${tx.id}/start`);toast('Validation started');startLocalTimer(tx.id,r.startedAt);document.querySelector('#start-work').disabled=true;document.querySelector('#pause-work').disabled=false}catch(e){toast(e.message,true)}});document.querySelector('#pause-work')?.addEventListener('click',async()=>{try{await pauseCurrent();toast('Validation paused');document.querySelector('#start-work').disabled=false;document.querySelector('#pause-work').disabled=true}catch(e){toast(e.message,true)}});document.querySelectorAll('[data-decision]').forEach(b=>b.onclick=async()=>{const decision=b.dataset.decision;try{const payload={decision,commercial_classification:document.querySelector('#classification').value||null,project_code:document.querySelector('#project').value||null,notes:document.querySelector('#review-notes').value};const r=await post(`/api/transactions/${tx.id}/review`,payload);stopLocalTimer();toast(`${decision.replace('_',' ')} · ${fmtTime(r.reviewSeconds)} active time`);document.querySelector('#tx-modal')?.remove();state.modal=null;await renderPage()}catch(e){toast(e.message,true)}})}
const renderTransactionExtraFields=openTransaction;
openTransaction=async function(id){await renderTransactionExtraFields(id);const tx=state.modal?.tx;if(!tx)return;const notesField=document.querySelector('#review-notes')?.closest('.field');if(!notesField)return;const final=['APPROVED','REJECTED'].includes(tx.status);if(!tx.manual_category_name&&!tx.resolved_category_name&&!tx.category)notesField.insertAdjacentHTML('beforebegin',`<div class="field"><label for="manual-category">Category</label><select id="manual-category" ${final?'disabled':''}><option value="">Select a category</option>${(state.modal.categoryOptions||[]).map(name=>`<option value="${esc(name)}">${esc(name)}</option>`).join('')}</select></div>`);notesField.insertAdjacentHTML('beforebegin',`<div class="field"><label for="xpense-id">Xpense ID</label><textarea id="xpense-id" maxlength="500" placeholder="Enter Xpense ID" ${final?'disabled':''}>${esc(tx.xpense_id||'')}</textarea></div>`)};
// Salary deduction: choosing it asks how much is deducted from salary, and
// the modal's total updates live to the net amount the company bears.
const openTransactionBase=openTransaction;
openTransaction=async function(id){
  await openTransactionBase(id);
  const tx=state.modal?.tx,sel=document.querySelector('#classification');if(!tx||!sel)return;
  // Edit & re-check: reopen a final decision (reason required, audited), then
  // show the same transaction again with its saved values editable.
  document.querySelector('#reopen-tx')?.addEventListener('click',async()=>{
    const reason=prompt(`Reopen this ${sentenceCase(tx.status).toLowerCase()} transaction for editing?\n\nReason (saved in the audit trail):`);
    if(reason===null)return;if(!reason.trim())return toast('A reason is required to reopen a decision',true);
    try{
      await post(`/api/transactions/${tx.id}/reopen`,{reason:reason.trim()});
      document.querySelector('#tx-modal')?.remove();state.modal=null;
      toast('Reopened. Make your changes, then approve or reject again.');
      await renderPage();await openTransaction(tx.id);
    }catch(e){toast(e.message,true)}
  });
  const final=['APPROVED','REJECTED'].includes(tx.status),max=Math.abs(Number(tx.amount)||0);
  sel.closest('.field').insertAdjacentHTML('afterend',`<div class="field" id="salary-deduction-field" hidden><label for="salary-deduction">Salary deduction amount${tx.currency?` (${esc(tx.currency)})`:''}</label><input id="salary-deduction" type="number" min="0.01" max="${max}" step="0.01" inputmode="decimal" placeholder="How much is deducted from salary?" value="${esc(tx.salary_deduction_amount??'')}" ${final?'disabled':''}><small class="muted">Expense total ${esc(fmtMoney(max,tx.currency))}. The rest stays a company cost.</small></div>`);
  const box=document.querySelector('#salary-deduction-field'),input=document.querySelector('#salary-deduction'),amountEl=document.querySelector('#tx-modal .amount-big');
  const paint=()=>{
    const on=sel.value==='SALARY_DEDUCTION';box.hidden=!on;
    const d=on?Math.min(Number(input.value)||0,max):0;
    if(amountEl)amountEl.innerHTML=d>0?`${esc(fmtMoney(salaryNet(tx.amount,tx,d),tx.currency))}<div class="amount-sub">Original ${esc(fmtMoney(tx.amount,tx.currency))} · salary deduction −${esc(fmtMoney(d,tx.currency))}</div>`:esc(fmtMoney(tx.amount,tx.currency));
  };
  sel.addEventListener('change',()=>{paint();if(sel.value==='SALARY_DEDUCTION'&&!final)input.focus()});
  input.addEventListener('input',paint);paint();updateValidationLock();
};
function updateValidationLock(){
  const tx=state.modal?.tx;if(!tx)return;
  const final=['APPROVED','REJECTED'].includes(tx.status),locked=final||state.activeTx!==tx.id;
  document.querySelectorAll('#classification,#project,#review-notes,#manual-category,#xpense-id,#salary-deduction,#tx-modal [data-decision]').forEach(el=>el.disabled=locked);
  const form=document.querySelector('#classification')?.closest('.panel-body');
  if(form&&!form.querySelector('.validation-lock-note'))form.insertAdjacentHTML('afterbegin','<p class="validation-lock-note muted small" role="status">Click Start validation to edit and submit your review.</p>');
  const note=form?.querySelector('.validation-lock-note');if(note)note.hidden=!locked||final;
  const start=document.querySelector('#start-work'),pause=document.querySelector('#pause-work');
  if(start)start.disabled=final||!locked||!(tx.reviewer_id===state.user.id||canSeeTeam());
  if(pause)pause.disabled=locked;
  const badge=document.querySelector('#tx-modal .timer-row .status');if(badge){badge.textContent=locked?'PAUSED':'RUNNING';badge.className='status '+(locked?'s-UNASSIGNED':'s-IN_REVIEW');}
}
function startLocalTimer(txId,startedAt){stopLocalTimer();state.activeTx=txId;updateValidationLock();state.sessionStarted=Date.parse(startedAt)||Date.now();const el=()=>document.querySelector('#timer');const tick=()=>{const x=el();if(x)x.textContent=clock(Math.floor((Date.now()-state.sessionStarted)/1000))};tick();state.timer=setInterval(tick,1000);state.heartbeat=setInterval(()=>post(`/api/transactions/${txId}/heartbeat`).catch(()=>{stopLocalTimer();toast('Validation paused. Click Start validation to continue.',true)}),30000)}
function clock(s){const h=Math.floor(s/3600),m=Math.floor((s%3600)/60),x=s%60;return h?`${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(x).padStart(2,'0')}`:`${String(m).padStart(2,'0')}:${String(x).padStart(2,'0')}`}
function stopLocalTimer(){if(state.timer)clearInterval(state.timer);if(state.heartbeat)clearInterval(state.heartbeat);state.timer=state.heartbeat=null;state.sessionStarted=null;state.activeTx=null;updateValidationLock()}
async function pauseCurrent(){if(!state.activeTx)return;const id=state.activeTx;stopLocalTimer();await post(`/api/transactions/${id}/pause`)}
async function closeModal(pause=true){if(pause&&state.activeTx){try{await pauseCurrent()}catch{}}else stopLocalTimer();document.querySelector('#tx-modal')?.remove();state.modal=null}
async function renderPleo(c){const p=await api('/api/pleo/status');
  // "Connected" must mean a verified live connection, not merely that
  // credentials/config exist — mock mode or an unverified config never counts.
  const pleoVerified=!p.mockMode&&p.lastCompanyTest?.ok===true;
  const pleoStatusLabel=p.mockMode?'MOCK MODE':pleoVerified?'CONNECTED':(p.configured?'CONFIGURED · NOT VERIFIED':'SETUP REQUIRED');
  const pleoStatusClass=p.mockMode?'s-IN_REVIEW':pleoVerified?'s-APPROVED':'s-NEEDS_INFO';
  c.innerHTML=pageHead('Pleo API sync','Server-side Pleo ingestion using the new External API. Credentials remain deployment secrets and never enter browser code.',`<button id="test-company" class="btn btn-ghost">Test company</button> `+`<button id="test-pleo" class="btn btn-soft">Test connection</button> <button id="sync-pleo" class="btn btn-primary" ${!p.configured||p.syncInProgress?'disabled':''}>${p.syncInProgress?'Sync running…':'Sync now'}</button>`)+`<div id="sync-progress" class="small muted" style="margin-bottom:${p.syncInProgress?'10px':'0'}">${p.syncInProgress?'A sync is already running — progress will appear here once you trigger Sync now/Run backfill, or reload to check.':''}</div>${!p.configured?`<div class="notice warning">Pleo is not configured yet. Add <span class="code">PLEO_API_KEY</span> and <span class="code">PLEO_COMPANY_ID</span> to the deployment environment, then redeploy/restart.</div>`:''}<div class="panel" style="margin-top:16px"><div class="panel-head"><h3>Connection</h3><span class="status ${pleoStatusClass}">${pleoStatusLabel}</span></div><div class="panel-body"><div class="sync-status"><div class="sync-cell"><b>API base</b><span>${esc(p.baseUrl)}</span></div><div class="sync-cell"><b>Company</b><span>${p.lastCompanyTest?.ok&&p.lastCompanyTest?.companyName?esc(p.lastCompanyTest.companyName):esc(p.companyId||'Not set')}</span></div><div class="sync-cell"><b>Connector</b><span>${esc(p.syncMode)}</span></div><div class="sync-cell"><b>Last verified</b><span>${pleoVerified?esc(fmtDate(p.lastCompanyTest.at)):'Not yet verified — run Test company'}</span></div></div><div class="divider"></div>${p.syncMode==='accounting_entries_v1'?`<div class="notice"><b>PRIMARY TRANSACTION INGESTION · Accounting Entries API</b><br>Retrieves Pleo accounting entries directly for Expensyra review/allocation — independent of the export queue, so it can answer for any date range, not only currently-queued items.</div><div class="notice" style="margin-top:10px"><b>Export API V2 · secondary</b><br>Reconciliation / accounting export status only. Not used as the transaction feed while this connector is configured.</div>`:`<div class="notice"><b>PRIMARY TRANSACTION INGESTION · Export API V2</b><br>Ingests pending/in-progress Export Jobs without writing approval decisions back to Pleo. JSAN validation remains an independent audit layer.</div><div class="notice warning" style="margin-top:10px">Export V2 only returns entries currently queued for export. The <span class="code">accounting_entries_v1</span> connector is available as an alternative primary source that can retrieve accounting entries for any date range, independent of the export queue.</div>`}</div></div><div class="panel" style="margin-top:16px"><div class="panel-head"><h3>Historical backfill</h3><span class="small muted">Accounting Entries API (v1)</span></div><div class="panel-body"><div class="notice">Export V2 (used above for live sync) only ever exposes entries currently queued for export. Historical backfill uses a separate connector (Accounting Entries v1) for an explicit date range and does not change your live sync mode.</div><div class="toolbar" style="margin-top:14px"><input id="backfill-from" type="date" title="From"><input id="backfill-to" type="date" title="To (optional)"><button id="run-backfill" class="btn btn-dark">Run backfill</button></div></div></div><div class="panel" style="margin-top:16px"><div class="panel-head"><h3>Sync history</h3><span class="small muted">Latest 20 runs</span></div><div class="table-wrap"><table class="table"><thead><tr><th>Started</th><th>Trigger</th><th>Status</th><th class="right">Pages</th><th class="right">Fetched</th><th class="right">New</th><th class="right">Updated</th><th>Evidence</th><th>Duration</th><th>Error</th></tr></thead><tbody>${p.history.length?p.history.map(r=>{const durMs=r.finished_at?Date.parse(r.finished_at)-Date.parse(r.started_at):null;const dur=durMs!=null?fmtTime(Math.round(durMs/1000)):(r.status==='RUNNING'?'running…':'—');return `<tr><td>${esc(fmtDate(r.started_at))}</td><td>${esc(r.trigger_type)}</td><td><span class="status ${r.status==='SUCCESS'?'s-APPROVED':(r.status==='FAILED'||r.status==='INTERRUPTED')?'s-REJECTED':'s-IN_REVIEW'}">${esc(r.status)}</span></td><td class="right">${r.pages_fetched||r.jobs_seen||0}</td><td class="right">${r.items_seen}</td><td class="right">${r.inserted_count}</td><td class="right">${r.updated_count}</td><td class="small">${r.evidence.available} ok · ${r.evidence.pending+r.evidence.retrying} pending · ${r.evidence.failed} failed</td><td class="small">${dur}</td><td class="small">${esc(r.error_message||'')}</td></tr>`}).join(''):`<tr><td colspan="10"><div class="empty">No sync runs yet.</div></td></tr>`}</tbody></table></div></div>${state.bootstrap.config.allowRecoveryImport?`<details class="panel" style="margin-top:16px"><summary class="panel-head" style="cursor:pointer"><h3>Recovery & reconciliation import</h3><span class="small muted">CSV fallback only</span></summary><div class="panel-body"><div class="notice warning">This is not the normal ingestion path. Use only for outage recovery or reconciliation against an official Pleo export.</div><div class="field" style="margin-top:14px"><label>Recovery CSV</label><input id="recovery-file" type="file" accept=".csv,text/csv"></div><button id="recovery-upload" class="btn btn-ghost" style="margin-top:10px">Import recovery file</button></div></details>`:''}`;document.querySelector('#test-company').onclick=async()=>{try{const x=await post('/api/pleo/company-test');toast(x.mock?'Mock mode — no real Pleo call made':`Company PASS: ${x.companyName||'verified'}`);renderPleo(c)}catch(e){toast(e.message,true)}};document.querySelector('#test-pleo').onclick=async()=>{try{const x=await post('/api/pleo/test');toast(x.message)}catch(e){toast(e.message,true)}};document.querySelector('#sync-pleo').onclick=async()=>{const b=document.querySelector('#sync-pleo');b.disabled=true;try{const start=await post('/api/pleo/sync');const prog=document.querySelector('#sync-progress');const final=await pollSyncRun(start.runId,x=>{b.textContent=`Page ${x.run.pages_fetched||0}… ${x.run.items_seen||0} fetched`;if(prog)prog.textContent=`Page ${x.run.pages_fetched||0} — ${x.run.items_seen||0} fetched, evidence: ${x.evidence.available} available / ${x.evidence.pending+x.evidence.retrying} pending / ${x.evidence.failed} failed`});if(final.run.status==='SUCCESS')toast(`Sync complete: ${final.run.inserted_count} new, ${final.run.updated_count} refreshed`);else toast(`Sync ${final.run.status.toLowerCase()}: ${final.run.error_message||''}`,true);await loadBootstrap();renderPleo(c);updateSyncMini()}catch(e){toast(e.message,true);b.disabled=false;b.textContent='Sync now'}};document.querySelector('#run-backfill').onclick=async()=>{const from=document.querySelector('#backfill-from').value;const to=document.querySelector('#backfill-to').value;if(!from)return toast('Choose a From date',true);const b=document.querySelector('#run-backfill');b.disabled=true;try{const start=await post('/api/pleo/backfill',{dateFrom:from,dateTo:to||null});const prog=document.querySelector('#sync-progress');const final=await pollSyncRun(start.runId,x=>{b.textContent=`Page ${x.run.pages_fetched||0}…`;if(prog)prog.textContent=`Page ${x.run.pages_fetched||0} — ${x.run.items_seen||0} fetched, evidence: ${x.evidence.available} available / ${x.evidence.pending+x.evidence.retrying} pending / ${x.evidence.failed} failed`});if(final.run.status==='SUCCESS')toast(`Backfill complete: ${final.run.inserted_count} new, ${final.run.updated_count} refreshed (${final.run.items_seen} in range)`);else toast(`Backfill ${final.run.status.toLowerCase()}: ${final.run.error_message||''}`,true);renderPleo(c)}catch(e){toast(e.message,true);b.disabled=false;b.textContent='Run backfill'}};const recovery=document.querySelector('#recovery-upload');if(recovery)recovery.onclick=async()=>{const f=document.querySelector('#recovery-file').files[0];if(!f)return toast('Choose a CSV file',true);try{const r=await fetch('/api/recovery/import',{method:'POST',headers:{'Content-Type':'text/csv','X-Filename':f.name},body:await f.text()});const p=await r.json();if(!r.ok)throw new Error(p.error);toast(`Recovery import: ${p.inserted} new, ${p.updated} refreshed`)}catch(e){toast(e.message,true)}}}
async function renderTeam(c){const p=await api('/api/team');c.innerHTML=pageHead('Team performance','Reviewer workload and measured validation effort for the current JSAN business day.')+`<div class="panel"><div class="panel-head"><h3>${esc(p.day)} productivity</h3><span class="small muted">Active time excludes idle tab time</span></div><div class="table-wrap"><table class="table"><thead><tr><th>Reviewer</th><th class="right">Assigned today</th><th class="right">Validations</th><th class="right">Approved</th><th class="right">Rejected</th><th class="right">Need info</th><th class="right">Active time</th><th class="right">Avg / validation</th><th class="right">Pending</th></tr></thead><tbody>${p.rows.map(r=>`<tr><td><b>${esc(r.name)}</b><div class="small muted">${esc(r.email)}</div></td><td class="right">${r.assigned_today}</td><td class="right"><b>${r.validations_today}</b></td><td class="right">${r.approved_today}</td><td class="right">${r.rejected_today}</td><td class="right">${r.needs_info_today}</td><td class="right">${fmtTime(r.active_seconds_today)}</td><td class="right">${fmtTime(r.avg_seconds)}</td><td class="right"><span class="status ${r.pending>20?'s-NEEDS_INFO':'s-ASSIGNED'}">${r.pending}</span></td></tr>`).join('')}</tbody></table></div></div><div class="notice" style="margin-top:16px">Use these measures together. Transaction count alone is not enough to conclude whether a reviewer is under-utilised: active handling time, pending complexity, reject/clarification volume and later QC accuracy should be considered together.</div>`}
function isPlaceholderValue(v){return['Category Unresolved','Missing Project','Unknown','UNCLASSIFIED'].includes(v)}
function moneyList(rows){return rows.length?rows.map(r=>`<div>${esc(fmtMoney(r.amount,r.currency))}<span class="small muted"> · ${r.count} tx</span></div>`).join(''):'<div class="muted small">—</div>'}
function breakdownPanel(title,rows,valueField,drillKey,colLabel){
  return `<div class="panel"><div class="panel-head"><h3>${esc(title)}</h3></div><div class="table-wrap"><table class="table"><thead><tr><th>${esc(colLabel)}</th><th>Currency</th><th class="right">Transactions</th><th class="right">Amount</th></tr></thead><tbody>${rows.length?rows.map(r=>{const v=r[valueField];const clickable=!isPlaceholderValue(v);return `<tr class="${clickable?'clickable':''}" ${clickable?`data-drill="${drillKey}" data-value="${esc(v)}"`:''}><td>${esc(v)}</td><td>${esc(r.currency)}</td><td class="right">${r.count}</td><td class="right money">${esc(fmtMoney(r.amount,r.currency))}</td></tr>`}).join(''):'<tr><td colspan="4"><div class="empty">No data for this filter.</div></td></tr>'}</tbody></table></div></div>`;
}
function renderMonthlyPivot(rows){
  if(!rows.length) return '<div class="panel"><div class="panel-head"><h3>Spend by category × month</h3></div><div class="panel-body"><div class="empty">No dated transactions yet.</div></div></div>';
  const currencies=[...new Set(rows.map(r=>r.currency))];
  return currencies.map(cur=>{
    const curRows=rows.filter(r=>r.currency===cur);
    const months=[...new Set(curRows.map(r=>r.month))].sort();
    const totalFor=cat=>curRows.filter(r=>r.category===cat).reduce((s,r)=>s+r.amount,0);
    const categories=[...new Set(curRows.map(r=>r.category))].sort((a,b)=>totalFor(b)-totalFor(a));
    const cell=(cat,month)=>{const r=curRows.find(x=>x.category===cat&&x.month===month);return r?fmtMoney(r.amount,cur):'—'};
    return `<div class="panel"><div class="panel-head"><h3>Spend by category × month</h3><span class="small muted">${esc(cur)}</span></div><div class="table-wrap"><table class="table"><thead><tr><th>Category</th>${months.map(m=>`<th class="right">${esc(m)}</th>`).join('')}</tr></thead><tbody>${categories.map(cat=>`<tr><td>${esc(cat)}</td>${months.map(m=>`<td class="right money">${esc(cell(cat,m))}</td>`).join('')}</tr>`).join('')}</tbody></table></div></div>`;
  }).join('');
}
// Live Expense Intelligence: while the page is open, poll a cheap server-side
// fingerprint of the underlying data and redraw only when it changes — a
// review, allocation, sync, rollback or mapping change made here, in another
// tab or by another user shows up within seconds, with filters kept.
const EXPENSE_LIVE_MS=10_000;
let expenseLiveTimer=null;
function expenseLiveBadge(){const t=state.expenseLoadedAt?new Intl.DateTimeFormat('en-GB',{timeStyle:'short'}).format(state.expenseLoadedAt):'';return `<span id="expense-live" class="live-pill" title="Updates by itself when transactions, reviews, syncs or mappings change"><span class="dot ok"></span>Live${t?` · updated ${esc(t)}`:''}</span>`}
async function checkExpenseLive(c){
  if(state.page!=='expense'){clearInterval(expenseLiveTimer);expenseLiveTimer=null;return}
  // Don't redraw under the user's hands (an open dropdown or a focused field).
  if(document.hidden||state.expenseRefreshing||c.contains(document.activeElement)&&/^(SELECT|INPUT|TEXTAREA)$/.test(document.activeElement.tagName))return;
  try{
    const {version}=await api('/api/data-version');
    if(!version||version===state.expenseVersion||state.page!=='expense')return;
    state.expenseRefreshing=true;
    const y=window.scrollY,open=[...c.querySelectorAll('details')].map(x=>x.open);
    await renderExpense(c);
    c.querySelectorAll('details').forEach((x,i)=>{if(open[i])x.open=true});
    window.scrollTo(0,y);
  }catch{}finally{state.expenseRefreshing=false}
}
document.addEventListener('visibilitychange',()=>{const c=document.querySelector('#content');if(!document.hidden&&c&&state.page==='expense')checkExpenseLive(c)});
async function renderExpense(c){
  const d=await api('/api/analytics/expense/summary');
  if(state.page!=='expense')return;
  state.expenseVersion=d.version;state.expenseLoadedAt=Date.now();
  clearInterval(expenseLiveTimer);expenseLiveTimer=setInterval(()=>checkExpenseLive(c),EXPENSE_LIVE_MS);
  const periods=[...new Set([...d.balances,...(d.excluded||[])].map(r=>r.month))].sort().reverse();
  const currencies=[...new Set(d.balances.map(r=>r.currency))].sort();
  const f=state.expenseFilters;
  let month=periods.includes(f.month)?f.month:periods[0];
  let currency=currencies.includes(f.currency)?f.currency:currencies.includes('GBP')?'GBP':currencies[0];
  let section=f.section||'overview', project=f.project||'';
  const money=v=>currency==='UNKNOWN'?Number(v).toFixed(2)+' (unknown currency)':fmtMoney(v,currency);
  const monthLabel=m=>/^\d{4}-\d{2}$/.test(m)?new Date(m+'-01T00:00:00Z').toLocaleDateString('en-GB',{month:'long',year:'numeric',timeZone:'UTC'}):m;
  const typeLabel=t=>t.split(' / ').map(v=>PLEO_FAMILY_LABELS[v]||v.toLowerCase().replaceAll('_',' ').replace(/^./,x=>x.toUpperCase())).join(' / ');
  const table=(headers,rows)=>'<div class="table-wrap"><table class="table"><thead><tr>'+headers.map(h=>'<th>'+esc(h)+'</th>').join('')+'</tr></thead><tbody>'+(rows.join('')||'<tr><td colspan="'+headers.length+'"><div class="empty">No spending for this selection.</div></td></tr>')+'</tbody></table></div>';
  const panel=(title,body)=>'<section class="panel expense-panel"><div class="panel-head"><h3>'+esc(title)+'</h3></div>'+body+'</section>';
  const categoriesTable=rows=>table(['Expense type','Category','Transactions','Spending'],rows.map(r=>'<tr><td>'+esc(typeLabel(r.expense_type))+'</td><td>'+esc(r.category)+'</td><td>'+fmtCount(r.count)+'</td><td class="money">'+esc(money(r.amount))+'</td></tr>'));
  function draw(){
    state.expenseFilters={month,currency,section,project};
    if(!d.balances.length){c.innerHTML=pageHead('Expense Intelligence','Monthly balances and spending.')+'<div class="empty">No billed transactions available yet. Pending transactions are excluded until Pleo provides a billed amount.</div>';return;}
    const prior=d.balances.filter(x=>x.month<month&&x.currency===currency).at(-1);
    const r=d.balances.find(x=>x.month===month&&x.currency===currency)||{opening_balance:prior?.remaining_balance||0,total_monthly_balance:prior?.remaining_balance||0,remaining_balance:prior?.remaining_balance||0,wallet_load:0,spending:0,wallet_count:0,spending_count:0};
    const excluded=(d.excluded||[]).find(x=>x.month===month);
    const nonWallet=(d.nonWalletEntries||[]).find(x=>x.month===month&&x.currency===currency);
    const cats=d.categories.filter(x=>x.month===month&&x.currency===currency);
    const projects=d.projects.filter(x=>x.month===month&&x.currency===currency);
    const projectCats=d.projectCategories.filter(x=>x.month===month&&x.currency===currency&&(!project||x.project===project));
    const card=(label,value,sub,cls='',action=false)=>'<'+(action?'button type="button" id="expense-spending-card"':'div')+' class="expense-balance-card '+cls+'"><span class="expense-card-label">'+label+'</span><strong>'+esc(money(value))+'</strong><span class="expense-card-sub">'+sub+'</span></'+(action?'button':'div')+'>';
    c.innerHTML=pageHead('Expense Intelligence','Your monthly balance, spending and project expenses in one place.',expenseLiveBadge())+
      '<div class="expense-period-bar"><div><span class="kicker">MONTHLY OVERVIEW</span><h2>'+esc(monthLabel(month))+'</h2></div><div class="expense-selectors"><label>Month<select id="expense-month">'+periods.map(m=>'<option value="'+m+'" '+(m===month?'selected':'')+'>'+esc(monthLabel(m))+'</option>').join('')+'</select></label><label>Billing currency<select id="expense-currency">'+currencies.map(cur=>'<option '+(cur===currency?'selected':'')+'>'+esc(cur)+'</option>').join('')+'</select></label></div></div>'+
      '<div class="expense-balance-grid">'+card('Total monthly balance',r.total_monthly_balance,'Opening balance + wallet loads','expense-card-total')+card('Total wallet load',r.wallet_load,fmtCount(r.wallet_count)+' wallet transactions')+card('Total spending',r.spending,'View expense types and categories &rarr;','expense-card-spend',true)+card('Remaining balance',r.remaining_balance,'Carried into the next month','expense-card-remaining')+'</div>'+
      '<div class="expense-carry"><span><b>Opening balance</b> '+esc(money(r.opening_balance))+'</span><span>'+ (month===periods.at(-1)?'Starting from zero':'Carried forward from the previous month')+'</span><span class="expense-estimate">Estimated balance</span></div>'+
      '<p class="expense-balance-note">Estimate starts at zero in '+esc(monthLabel(periods.at(-1)))+' and uses Pleo billed amounts in '+esc(currency)+', from API transactions only. Purchases are grouped by settlement month; API split items are counted once. Refunds and cashback reduce spending. This is not a reconciled Pleo wallet balance.</p>'+
      (nonWallet?.count?'<div class="notice expense-excluded">Wallet spending excludes '+fmtCount(nonWallet.count)+' out-of-pocket and bill-invoice records ('+esc(money(nonWallet.amount))+'). Reimbursement payments are included when posted to the wallet.</div>':'')+
      (excluded?.count?'<div class="notice expense-excluded"><b>'+fmtCount(excluded.count)+' transactions excluded</b> because Pleo has not provided a billed amount'+(excluded.pending_count?' ('+fmtCount(excluded.pending_count)+' pending)':'')+'. They are not treated as zero spending.</div>':'')+
      '<nav class="expense-tabs" aria-label="Expense sections">'+[['overview','Balance history'],['spending','Spending breakdown'],['projects','Project expenses'],['categories','Project categories'],['commercial','Commercial classification']].map(([id,label])=>'<button type="button" data-exp-section="'+id+'" class="'+(id===section?'active':'')+'" aria-pressed="'+(id===section)+'">'+label+'</button>').join('')+'</nav><div id="expense-section"></div>';
    const target=c.querySelector('#expense-section');
    if(section==='overview'){
      target.innerHTML=panel('Monthly balance history',table(['Month','Opening balance','Wallet loads','Total monthly balance','Spending','Remaining balance'],d.balances.filter(x=>x.currency===currency).map(x=>'<tr class="'+(x.month===month?'expense-current-month':'')+'"><td><button class="expense-text-button" data-exp-month="'+x.month+'">'+esc(monthLabel(x.month))+'</button></td><td class="money">'+esc(money(x.opening_balance))+'</td><td class="money">'+esc(money(x.wallet_load))+'</td><td class="money">'+esc(money(x.total_monthly_balance))+'</td><td class="money">'+esc(money(x.spending))+'</td><td class="money"><b>'+esc(money(x.remaining_balance))+'</b></td></tr>')));
    }else if(section==='spending'){
      const types=[...new Set(cats.map(x=>x.expense_type))];
      target.innerHTML='<div class="expense-section-intro"><h3>Spending breakdown</h3><p>Expand an expense type to see its categories. Cashback and refunds reduce spending.</p></div>'+ (types.map(type=>{const rows=cats.filter(x=>x.expense_type===type);return '<details class="expense-type-group"><summary><span>'+esc(typeLabel(type))+'<small>'+fmtCount(rows.reduce((n,x)=>n+x.count,0))+' transactions</small></span><b>'+esc(money(rows.reduce((n,x)=>n+x.amount,0)))+'</b></summary>'+categoriesTable(rows)+'</details>';}).join('')||'<div class="empty">No spending this month.</div>');
    }else if(section==='projects'){
      target.innerHTML=panel('Project expenses - '+monthLabel(month),table(['Project','Transactions','Total spending',''],projects.map((x,i)=>'<tr><td><b>'+esc(x.project)+'</b></td><td>'+fmtCount(x.count)+'</td><td class="money">'+esc(money(x.amount))+'</td><td><button class="expense-text-button" data-exp-project="'+i+'">View categories &rarr;</button></td></tr>')));
    }else if(section==='commercial'){
      const rows=(d.commercialProjects||[]).filter(x=>x.month===month&&x.currency===currency);
      const projectKey=x=>JSON.stringify([x.project_code,x.project]);
      const names=new Map(rows.map(x=>[projectKey(x),x.project+(x.project_code?' ('+x.project_code+')':'')]));
      if(project&&!names.has(project)){project='';state.expenseFilters.project='';}
      const selected=rows.filter(x=>!project||projectKey(x)===project);
      const fields=[['customer_billable','Customer billable'],['jsan_internal','JSAN internal cost'],['refund','Refunds'],['reimbursement','Reimbursement'],['salary_deduction','Salary deducted']];
      const sum=(items,key)=>items.reduce((n,x)=>n+Math.round(x[key]*100),0)/100;
      const totalRow=(label,items)=>'<tr class="expense-current-month"><td><b>'+esc(label)+'</b></td>'+fields.map(([key])=>'<td class="money"><b>'+esc(money(sum(items,key)))+'</b></td>').join('')+'<td class="money">'+esc(money(sum(items,'unclassified')))+'</td></tr>';
      target.innerHTML='<div class="expense-section-intro"><h3>Commercial classification</h3><label>Project<select id="expense-project"><option value="">All projects</option>'+[...names].map(([key,label])=>'<option value="'+esc(key)+'" '+(key===project?'selected':'')+'>'+esc(label)+'</option>').join('')+'</select></label></div>'+
        '<p class="expense-balance-note">Based on the Commercial classification saved in Transactions, for posted wallet expenses in the selected month and billing currency. Refund credits are positive recoveries; reversals reduce their totals. Salary deductions use the recorded amount converted at the transaction?s billed exchange ratio; the remaining cost is included in JSAN internal cost. Pending, deleted, wallet loads, out-of-pocket and bill-invoice records are excluded.</p>'+
        '<h3>All projects totals</h3><div class="expense-commercial-grid">'+fields.map(([key,label])=>card(label,sum(rows,key),'All projects ? '+esc(monthLabel(month)))).join('')+'</div>'+
        panel((project?names.get(project):'All projects')+' ? '+monthLabel(month),table(['Project',...fields.map(x=>x[1]),'Unclassified / other'],[
          ...selected.map(x=>'<tr><td><b>'+esc(names.get(projectKey(x)))+'</b></td>'+fields.map(([key])=>'<td class="money">'+esc(money(x[key]))+'</td>').join('')+'<td class="money">'+esc(money(x.unclassified))+'</td></tr>'),
          ...(selected.length?[totalRow(project?'Selected project total':'All projects total',selected)]:[])
        ]))+
        (rows.some(x=>x.missing_deductions)?'<div class="notice">Some salary-classified transactions have no valid deduction amount. Their spending appears under Unclassified / other until the deduction is recorded.</div>':'');
    }else{
      const names=[...new Set(projects.map(x=>x.project))].sort();
      if(project&&!names.includes(project)){project='';state.expenseFilters.project='';}
      target.innerHTML='<div class="expense-section-intro"><h3>Project category spending</h3><label>Project<select id="expense-project"><option value="">All projects</option>'+names.map(name=>'<option value="'+esc(name)+'" '+(name===project?'selected':'')+'>'+esc(name)+'</option>').join('')+'</select></label></div>'+panel(monthLabel(month)+' - '+currency,table(['Project','Expense type','Category','Transactions','Spending'],projectCats.map(x=>'<tr><td>'+esc(x.project)+'</td><td>'+esc(typeLabel(x.expense_type))+'</td><td>'+esc(x.category)+'</td><td>'+fmtCount(x.count)+'</td><td class="money">'+esc(money(x.amount))+'</td></tr>')));
    }
    c.querySelector('#expense-month').onchange=e=>{month=e.target.value;project='';draw()};
    c.querySelector('#expense-currency').onchange=e=>{currency=e.target.value;project='';draw()};
    const showSection=id=>{section=id;draw();c.querySelector('#expense-section').scrollIntoView({behavior:'smooth',block:'start'})};
    c.querySelector('#expense-spending-card').onclick=()=>showSection('spending');
    c.querySelectorAll('[data-exp-section]').forEach(b=>b.onclick=()=>showSection(b.dataset.expSection));
    c.querySelectorAll('[data-exp-month]').forEach(b=>b.onclick=()=>{month=b.dataset.expMonth;draw()});
    c.querySelectorAll('[data-exp-project]').forEach(b=>b.onclick=()=>{project=projects[Number(b.dataset.expProject)].project;showSection('categories')});
    c.querySelector('#expense-project')?.addEventListener('change',e=>{project=e.target.value;draw()});
  }
  draw();
}
async function renderRevops(c){
  if(state.revopsView==='detail'&&state.revopsReviewerId)return renderRevopsDetail(c);
  const q=new URLSearchParams();if(state.revopsFilters.month)q.set('month',state.revopsFilters.month);
  const d=await api('/api/analytics/reviewers?'+q);
  c.innerHTML=pageHead('Review Operations','Reviewer workload, decision mix and validation effort. Active validation time (recorded work sessions) is always shown separately from elapsed turnaround time (allocation-to-completion timestamps).')+
  `<div class="panel"><div class="panel-body"><div class="toolbar"><input id="rev-month" type="month" value="${esc(state.revopsFilters.month)}"><button id="rev-apply" class="btn btn-soft">Apply</button><button id="rev-clear" class="btn btn-ghost">Clear</button></div></div></div>
  <div class="panel"><div class="panel-head"><h3>${d.rows.length} reviewer${d.rows.length===1?'':'s'}</h3></div><div class="table-wrap"><table class="table"><thead><tr><th>Reviewer</th><th class="right">Assigned</th><th class="right">Completed</th><th class="right">Pending</th><th class="right">Approved</th><th class="right">Rejected</th><th class="right">Need info</th><th class="right">Amount reviewed</th><th class="right" title="Source: recorded Expensyra validation sessions">Active time</th><th class="right" title="Source: assignment/completion timestamps — not recorded session time">Elapsed TAT</th><th class="right">Oldest pending</th></tr></thead><tbody>${d.rows.length?d.rows.map(r=>`<tr class="clickable" data-reviewer="${r.id}"><td><b>${esc(r.name)}</b><div class="small muted">${esc(r.email)}</div></td><td class="right">${r.assigned}</td><td class="right"><b>${r.completed}</b></td><td class="right"><span class="status ${r.pending>10?'s-NEEDS_INFO':'s-ASSIGNED'}">${r.pending}</span></td><td class="right">${r.approved}</td><td class="right">${r.rejected}</td><td class="right">${r.needs_info}</td><td class="right money">${esc(fmtMoney(r.amount_reviewed_total,'GBP'))}</td><td class="right">${fmtTime(r.active_seconds)}</td><td class="right">${fmtTime(r.elapsed_tat_avg_seconds)}</td><td class="right">${r.oldest_pending_age_days!=null?r.oldest_pending_age_days+'d':'—'}</td></tr>`).join(''):'<tr><td colspan="11"><div class="empty">No active reviewers.</div></td></tr>'}</tbody></table></div></div>
  <div class="notice" style="margin-top:16px"><b>Active time</b> is measured from recorded Start/Pause validation sessions (heartbeat-verified). <b>Elapsed TAT</b> is the wall-clock gap between allocation and completion and does not mean the reviewer was actively working that whole time. The two are never combined.</div>`;
  document.querySelector('#rev-apply').onclick=()=>{state.revopsFilters={month:document.querySelector('#rev-month').value};renderRevops(c)};
  document.querySelector('#rev-clear').onclick=()=>{state.revopsFilters={month:''};renderRevops(c)};
  document.querySelectorAll('[data-reviewer]').forEach(tr=>tr.onclick=()=>{state.revopsReviewerId=Number(tr.dataset.reviewer);state.revopsView='detail';renderPage()});
}
async function renderRevopsDetail(c){
  const id=state.revopsReviewerId;const q=new URLSearchParams();if(state.revopsFilters.month)q.set('month',state.revopsFilters.month);
  const d=await api(`/api/analytics/reviewers/${id}?`+q);
  c.innerHTML=pageHead(d.reviewer.name,`Reviewer detail · ${esc(d.reviewer.email)}`,`<button id="rev-back" class="btn btn-ghost">← All reviewers</button>`)+
  `<div class="grid-2">
    <div class="panel"><div class="panel-head"><h3>Daily throughput</h3></div><div class="table-wrap"><table class="table"><thead><tr><th>Day</th><th class="right">Completed</th><th class="right">Approved</th><th class="right">Rejected</th></tr></thead><tbody>${d.dailyThroughput.map(r=>`<tr><td>${esc(r.day)}</td><td class="right">${r.completed}</td><td class="right">${r.approved}</td><td class="right">${r.rejected}</td></tr>`).join('')||'<tr><td colspan="4"><div class="empty">No completed reviews in this range.</div></td></tr>'}</tbody></table></div></div>
    <div class="panel"><div class="panel-head"><h3>Decision mix</h3></div><div class="table-wrap"><table class="table"><thead><tr><th>Decision</th><th class="right">Count</th></tr></thead><tbody>${d.decisionMix.map(r=>`<tr><td><span class="status s-${r.decision}">${r.decision.replaceAll('_',' ')}</span></td><td class="right">${r.count}</td></tr>`).join('')||'<tr><td colspan="2"><div class="empty">No decisions in this range.</div></td></tr>'}</tbody></table></div></div>
  </div>
  <div class="grid-2">
    ${breakdownPanel('Categories reviewed',d.categoriesReviewed,'category','','Category').replace(/ class="clickable"| data-drill="[^"]*"| data-value="[^"]*"/g,'')}
    ${breakdownPanel('Projects reviewed',d.projectsReviewed,'project_code','','Project').replace(/ class="clickable"| data-drill="[^"]*"| data-value="[^"]*"/g,'')}
  </div>
  <div class="grid-2">
    <div class="panel"><div class="panel-head"><h3>Current queue</h3><span class="small muted">${d.currentQueue.length} pending</span></div><div class="table-wrap"><table class="table"><thead><tr><th>Merchant</th><th class="right">Amount</th><th>Status</th><th>Allocated</th></tr></thead><tbody>${d.currentQueue.map(r=>`<tr class="clickable" data-open="${r.id}"><td>${esc(r.merchant||'—')}</td><td class="right money">${esc(fmtMoney(r.amount,r.currency))}</td><td><span class="status s-${r.status}">${r.status.replaceAll('_',' ')}</span></td><td>${esc(fmtDate(r.allocated_at))}</td></tr>`).join('')||'<tr><td colspan="4"><div class="empty">Nothing pending.</div></td></tr>'}</tbody></table></div></div>
    <div class="panel"><div class="panel-head"><h3>Completed queue</h3></div><div class="table-wrap"><table class="table"><thead><tr><th>Merchant</th><th class="right">Amount</th><th>Decision</th><th>Completed</th></tr></thead><tbody>${d.completedQueue.map(r=>`<tr class="clickable" data-open="${r.id}"><td>${esc(r.merchant||'—')}</td><td class="right money">${esc(fmtMoney(r.amount,r.currency))}</td><td><span class="status s-${r.status}">${r.status}</span></td><td>${esc(fmtDate(r.completed_at))}</td></tr>`).join('')||'<tr><td colspan="4"><div class="empty">Nothing completed yet.</div></td></tr>'}</tbody></table></div></div>
  </div>
  <div class="panel"><div class="panel-head"><h3>Actual validation sessions</h3><span class="small muted">Source: recorded start/pause/heartbeat sessions</span></div><div class="table-wrap"><table class="table"><thead><tr><th>Merchant</th><th>Started</th><th class="right">Duration</th><th>End reason</th></tr></thead><tbody>${d.sessions.map(r=>`<tr><td>${esc(r.merchant||'—')}</td><td>${esc(fmtDate(r.started_at))}</td><td class="right">${fmtTime(r.seconds||0)}</td><td class="small muted">${esc(r.end_reason||(r.ended_at?'—':'In progress'))}</td></tr>`).join('')||'<tr><td colspan="4"><div class="empty">No sessions recorded.</div></td></tr>'}</tbody></table></div></div>
  <div class="notice" style="margin-top:16px"><b>Elapsed TAT</b> below is allocation-to-completion wall-clock time, sourced from timestamps — not the same as active validation session time above.</div>
  <div class="panel"><div class="panel-head"><h3>Elapsed TAT by transaction</h3></div><div class="table-wrap"><table class="table"><thead><tr><th>Merchant</th><th>Allocated</th><th>Completed</th><th class="right">Elapsed TAT</th></tr></thead><tbody>${d.elapsedTat.map(r=>`<tr><td>${esc(r.merchant||'—')}</td><td>${esc(fmtDate(r.allocated_at))}</td><td>${esc(fmtDate(r.completed_at))}</td><td class="right">${fmtTime(r.elapsed_seconds)}</td></tr>`).join('')||'<tr><td colspan="4"><div class="empty">No completed transactions with both timestamps.</div></td></tr>'}</tbody></table></div></div>
  `;
  document.querySelector('#rev-back').onclick=()=>{state.revopsView='list';state.revopsReviewerId=null;renderPage()};
  document.querySelectorAll('[data-open]').forEach(tr=>tr.onclick=()=>openTransaction(Number(tr.dataset.open)));
}
const BILLING_CLASSIFICATIONS=['CUSTOMER_BILLABLE','PROJECT_NON_BILLABLE','PERSONAL_NON_BILLABLE','JSAN_INTERNAL','REFUND','OTHER'];
// Reviewer first: it is the safe default in the "Add a user" role picker.
const ADMIN_ROLE_LABELS={REVIEWER:'Reviewer',TEAM_LEAD:'Team lead',FINANCE_QC:'Finance QC',ADMIN:'Admin'};
const ADMIN_ROLE_SHORT={REVIEWER:['reviewer','reviewers'],TEAM_LEAD:['lead','leads'],FINANCE_QC:['QC','QC'],ADMIN:['admin','admins']};
const ADMIN_SOURCE_LABELS={PLEO_TEAM:'Pleo team',PLEO_TAG:'Pleo tag',XLSX_TEAM:'Historical XLSX team',OTHER:'Other'};
const adminInitials=name=>String(name||'?').trim().split(/\s+/).slice(0,2).map(w=>w[0]).join('').toUpperCase();
// Administration: one summary band plus a tab per area. Every section is
// rendered (inactive ones hidden) so each form keeps its handler; the chosen
// tab survives re-renders after a save.
async function renderAdmin(c){
  const isAdmin=state.user.role==='ADMIN';
  const [usersResp,projectsResp,billingResp,rulesResp,gateResp]=await Promise.all([
    api('/api/admin/users'),
    api('/api/admin/projects'),
    api('/api/admin/billing-status-mapping'),
    api('/api/admin/project-mapping-rules'),
    api('/api/analytics/data-quality-gate').catch(()=>null),
  ]);
  const allUsers=usersResp.rows,users=allUsers.filter(u=>u.active),inactiveUsers=allUsers.length-users.length;
  const projects=projectsResp.rows,rules=rulesResp.rows;
  // Team leads manage reviewers only; approved links are admin-only (server enforces both).
  const canEditUser=u=>isAdmin||u.role==='REVIEWER',canEditRule=r=>isAdmin||r.status==='PROPOSED';
  const send=(method,url,body)=>api(url,{method,headers:{'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
  const afterSave=async msg=>{toast(msg);await loadBootstrap();state.filterOptions=null;renderAdmin(c)};
  const activeProjects=projects.filter(p=>p.status==='ACTIVE').length;
  const proposed=rules.filter(r=>r.status==='PROPOSED').length,approved=rules.length-proposed;
  const tags=billingResp.groupFound?billingResp.tags:[],mapped=tags.filter(t=>t.spendops_classification).length;
  const roleCounts=Object.keys(ADMIN_ROLE_LABELS).map(r=>[r,users.filter(u=>u.role===r).length]).filter(([,n])=>n);
  const tabs=[['users','Users',users.length],['projects','Projects',projects.length],['links','Project links',proposed?`${proposed} to approve`:rules.length],['classification','Classification',billingResp.groupFound?`${mapped}/${tags.length}`:''],...(isAdmin?[['import','Pleo import','']]:[]),...(gateResp?[['health','Data health','']]:[])];
  if(!tabs.some(([id])=>id===state.adminTab))state.adminTab='users';
  const tab=state.adminTab;
  const tile=(id,label,value,sub,warn)=>`<button type="button" class="adm-tile ${warn?'warn':''}" data-adm-tab="${id}"><span>${esc(label)}</span><strong>${value}</strong><small>${sub}</small></button>`;
  const search=(id,ph)=>`<label class="adm-search">${ICON_SEARCH}<input id="${id}" type="search" placeholder="${esc(ph)}" autocomplete="off" aria-label="${esc(ph)}"></label>`;
  const card=(title,sub,body,actions='')=>`<section class="adm-card"><header class="adm-card-head"><div><h3>${esc(title)}</h3>${sub?`<p>${sub}</p>`:''}</div>${actions}</header>${body}</section>`;
  const empty=(msg)=>`<div class="adm-empty">${esc(msg)}</div>`;
  const stat=(label,value,tone='')=>`<div class="adm-stat ${tone==='ok'&&!value?'':tone}"><span>${esc(label)}</span><strong>${fmtCount(value)}</strong></div>`;

  const usersSection=`<div class="adm-split">
    ${card('Application users',`${fmtCount(users.length)} people with access${inactiveUsers?` · ${fmtCount(inactiveUsers)} deactivated`:''} · select a person to edit`,`${search('adm-user-search','Search name, email or role')}
      <div class="adm-list" data-adm-filter="adm-user-search">${allUsers.map(u=>`<${canEditUser(u)?`button type="button" data-edit-user="${u.id}"`:'div'} class="adm-row ${u.active?'':'is-inactive'} ${canEditUser(u)?'is-editable':''}" data-search="${esc(`${u.name} ${u.email} ${ADMIN_ROLE_LABELS[u.role]||u.role} ${u.active?'':'inactive deactivated'}`.toLowerCase())}"><span class="adm-avatar role-${esc(u.role)}">${esc(adminInitials(u.name))}</span><span class="adm-row-main"><b>${esc(u.name)}${u.id===state.user.id?' <small class="muted">(you)</small>':''}</b><span>${esc(u.email)}${u.open_assigned?` · ${fmtCount(u.open_assigned)} open`:''}${u.must_change_password&&u.active?' · must change password':''}</span></span>${u.active?'':'<span class="adm-role inactive">Deactivated</span>'}<span class="adm-role role-${esc(u.role)}">${esc(ADMIN_ROLE_LABELS[u.role]||u.role)}</span></${canEditUser(u)?'button':'div'}>`).join('')||empty('No users yet.')}</div>`)}
    <div>${card('Add a user','They must change the temporary password at first sign-in.',`<form id="add-user" class="adm-form"><div class="field"><label>Full name</label><input name="name" required autocomplete="off"></div><div class="field"><label>Work email</label><input name="email" type="email" required placeholder="name@jsanconsulting.com" autocomplete="off"></div>${isAdmin?`<div class="field"><label>Role</label><select name="role">${Object.entries(ADMIN_ROLE_LABELS).map(([v,l])=>`<option value="${v}">${esc(l)}</option>`).join('')}</select></div>`:'<div class="hint">Team leads can add reviewers.</div>'}<div class="field"><label>Temporary password</label><input name="temporary_password" type="password" minlength="12" required autocomplete="new-password" placeholder="At least 12 characters"></div><button class="btn btn-primary">Create user</button></form>`)}<div id="edit-user-slot"></div></div>
  </div>`;

  const projectsSection=`<div class="adm-split">
    ${card('JSAN Project Master',`${fmtCount(activeProjects)} active of ${fmtCount(projects.length)} · select a project to edit it`,`${search('adm-project-search','Search code, project, customer or manager')}
      <div class="table-wrap adm-table"><table class="table"><thead><tr><th>Project</th><th>Customer</th><th>Manager</th><th>Country</th><th>Status</th><th>Pleo tag</th></tr></thead><tbody data-adm-filter="adm-project-search">${projects.map(p=>`<tr class="clickable" data-edit-project="${p.id}" data-search="${esc(`${p.code} ${p.name} ${p.customer||''} ${p.project_manager||''} ${p.country||''}`.toLowerCase())}"><td><span class="adm-code">${esc(p.code)}</span><div class="adm-cell-title">${esc(p.name)}</div></td><td>${esc(p.customer||'—')}</td><td>${esc(p.project_manager||'—')}</td><td>${esc(p.country||'—')}</td><td><span class="status ${p.status==='ACTIVE'?'s-APPROVED':p.status==='ON_HOLD'?'s-NEEDS_INFO':'s-REJECTED'}">${esc(sentenceCase(p.status||''))}</span></td><td class="adm-nowrap">${p.pleo_project_tag_name?esc(p.pleo_project_tag_name):'<span class="muted small">Not linked</span>'}</td></tr>`).join('')||`<tr><td colspan="6">${empty('No projects yet. Add one, or run the Pleo Excel import.')}</td></tr>`}</tbody></table></div>`)}
    <div id="adm-project-side">
      ${card('Add a project','Pleo teams become projects automatically through the Excel import.',`<form id="add-project" class="adm-form"><div class="field"><label>Project code</label><input name="code" required placeholder="e.g. PRJ-005" autocomplete="off"></div><div class="field"><label>Project name</label><input name="name" required autocomplete="off"></div><div class="field"><label>Customer</label><input name="customer" autocomplete="off"></div><button class="btn btn-primary">Add project</button></form>`)}
      <div id="edit-project-slot"></div>
    </div>
  </div>`;

  const linksSection=`<div class="adm-split">
    ${card('Project links',`Pleo team or tag → JSAN project · ${fmtCount(approved)} approved${proposed?`, <b>${fmtCount(proposed)} waiting for approval</b>`:''}`,`${search('adm-rule-search','Search team, tag or project')}
      <div class="table-wrap adm-table"><table class="table"><thead><tr><th>Source</th><th>Project</th><th>Status</th><th></th></tr></thead><tbody data-adm-filter="adm-rule-search">${rules.map(r=>`<tr data-search="${esc(`${r.source_label||''} ${r.source_value} ${r.project_code} ${r.project_name}`.toLowerCase())}"><td><div class="adm-cell-title">${esc(r.source_label||r.source_value)}</div><div class="small muted">${esc(ADMIN_SOURCE_LABELS[r.source_type]||r.source_type)}${r.source_label?` · ${esc(r.source_value)}`:''}${r.team_transactions!=null?` · ${fmtCount(r.team_transactions)} transaction(s)`:''}</div></td><td><span class="adm-code">${esc(r.project_code)}</span><div class="small">${esc(r.project_name)}</div></td><td><span class="status ${r.status==='APPROVED'?'s-APPROVED':'s-NEEDS_INFO'}">${esc(sentenceCase(r.status))}</span></td><td class="right adm-nowrap">${r.status==='PROPOSED'&&isAdmin?`<button class="btn btn-soft adm-btn-sm" data-approve-rule="${r.id}">Approve</button> `:''}${canEditRule(r)?`<button class="btn btn-ghost adm-btn-sm" data-edit-rule="${r.id}">Edit</button>`:''}</td></tr>`).join('')||`<tr><td colspan="4">${empty('No project links yet. Run the Pleo Excel import or propose one.')}</td></tr>`}</tbody></table></div>`,
      isAdmin&&proposed?`<button id="approve-all-rules" class="btn btn-primary">Approve all ${fmtCount(proposed)}</button>`:'')}
    <div>${card('Propose a link','Links apply once approved; later syncs follow them automatically.',`<form id="add-rule" class="adm-form"><div class="field"><label>Source type</label><select name="source_type">${Object.entries(ADMIN_SOURCE_LABELS).map(([v,l])=>`<option value="${v}">${esc(l)}</option>`).join('')}</select></div><div class="field"><label>Source value</label><input name="source_value" required placeholder="Pleo team ID or tag name" autocomplete="off"></div><div class="field"><label>JSAN project</label><select name="project_id" required>${projects.map(p=>`<option value="${p.id}">${esc(p.code)} · ${esc(p.name)}</option>`).join('')}</select></div><button class="btn btn-primary" ${projects.length?'':'disabled'}>Propose link</button></form>`)}<div id="edit-rule-slot"></div></div>
  </div>`;

  const classificationSection=card('Pleo Billing Status mapping','Maps each Pleo Billing Status tag to a Expensyra classification. Changes apply to existing transactions straight away; the original Pleo tag is always kept.',
    billingResp.groupFound?`<div class="table-wrap adm-table"><table class="table"><thead><tr><th>Pleo Billing Status tag</th><th>Expensyra classification</th></tr></thead><tbody>${tags.map(t=>`<tr><td><div class="adm-cell-title">${esc(t.name)}</div>${t.archived?'<span class="small muted">Archived in Pleo</span>':''}</td><td><select class="adm-select ${t.spendops_classification?'':'missing'}" data-billing-tag="${esc(t.id)}"><option value="">Not mapped</option>${BILLING_CLASSIFICATIONS.map(v=>`<option value="${v}" ${t.spendops_classification===v?'selected':''}>${esc(sentenceCase(v))}</option>`).join('')}</select></td></tr>`).join('')}</tbody></table></div>`
    :`<div class="adm-pad"><div class="notice warning">No "Billing Status" tag group has been synced from Pleo yet. Open <b>Pleo Sync</b> and run <b>Sync reference data</b> first.</div></div>`,
    billingResp.groupFound?`<span class="adm-pill ${mapped===tags.length?'ok':'warn'}">${fmtCount(mapped)} of ${fmtCount(tags.length)} mapped</span>`:'');

  const importSection=isAdmin?card('Pleo Excel import','Bootstraps Expensyra from the Pleo expense export the team used to work from.',`<div class="adm-pad">
    <ul class="adm-checks"><li>Rows are matched to live transactions by Expense ID; nothing new is created.</li><li>Every Pleo team becomes a project (e.g. <span class="adm-code">PRJ-005-CT-AV-US-Waymo</span>) and its transactions are linked.</li><li>Account → category names are learned, and Pleo's review status, reviewer and note are kept for reference.</li><li>No JSAN decision is ever overwritten.</li></ul>
    <label class="adm-drop" for="xl-file"><input id="xl-file" type="file" accept=".xlsx"><span class="adm-drop-icon" aria-hidden="true">⬆</span><b id="xl-file-name">Choose a Pleo export (.xlsx)</b><small>Preview first — nothing is written until you import.</small></label>
    <div class="adm-actions"><button id="xl-preview" class="btn btn-soft">Preview</button><button id="xl-import" class="btn btn-primary" disabled>Import</button></div>
    <div id="xl-result"></div></div>`):'';

  const g=gateResp;
  const healthSection=g?`<div class="adm-health">
    ${card('Commercial classification','From the Pleo Billing Status tag group.',`<div class="adm-stats">${stat('Billing Status tags',g.commercialClassification.billingStatusTags)}${stat('Mapped',g.commercialClassification.mapped,'ok')}${stat('Missing',g.commercialClassification.missing,g.commercialClassification.missing?'warn':'ok')}</div>`)}
    ${card('Projects','Live and historical transactions.',`<div class="adm-stats">${stat('Projects in master',g.project.projectMasterCount)}${stat('Approved links',g.project.historicalMappingRules)}${stat('Mapped transactions',g.project.mappedRealTransactions,'ok')}${stat('Missing project',g.project.missingProject,g.project.missingProject?'warn':'ok')}</div>`)}
    ${card('Categories','Resolved through the Pleo chart of accounts.',`<div class="adm-stats">${stat('Resolved',g.category.resolved,'ok')}${stat('Missing account ID',g.category.missingAccountId,g.category.missingAccountId?'warn':'')}${stat('Account not found',g.category.accountIdNotFound,g.category.accountIdNotFound?'warn':'')}${stat('Pending mapping',g.category.pendingMapping,g.category.pendingMapping?'warn':'')}</div>`)}
  </div>`:'';

  const sections={users:usersSection,projects:projectsSection,links:linksSection,classification:classificationSection,import:importSection,health:healthSection};
  document.querySelector('#page-title').textContent='Administration';
  c.innerHTML=`<div class="adm">
    <header class="adm-hero">
      <div class="adm-hero-copy"><span class="adm-eyebrow">JSAN Expensyra · Workspace settings</span><h2>Administration</h2><p>People, projects and the rules that connect Pleo spend to JSAN projects and classifications.</p></div>
      <div class="adm-tiles">
        ${tile('users','Users',fmtCount(users.length),roleCounts.map(([r,n])=>`${n} ${esc((ADMIN_ROLE_SHORT[r]||[r,r])[n===1?0:1])}`).join(' · ')||'No users')}
        ${tile('projects','Projects',fmtCount(projects.length),`${fmtCount(activeProjects)} active`)}
        ${tile('links','Project links',fmtCount(approved),proposed?`${fmtCount(proposed)} waiting for approval`:'All approved',proposed)}
        ${tile('classification','Classification',billingResp.groupFound?`${fmtCount(mapped)}/${fmtCount(tags.length)}`:'—',billingResp.groupFound?(mapped===tags.length?'All tags mapped':`${fmtCount(tags.length-mapped)} not mapped`):'Sync reference data first',billingResp.groupFound&&mapped<tags.length)}
      </div>
    </header>
    <nav class="adm-tabs" role="tablist" aria-label="Administration sections">${tabs.map(([id,label,badge])=>`<button type="button" role="tab" data-adm-tab="${id}" aria-selected="${id===tab}" class="${id===tab?'on':''}">${esc(label)}${badge!==''?`<span>${esc(String(badge))}</span>`:''}</button>`).join('')}</nav>
    ${Object.entries(sections).filter(([,html])=>html).map(([id,html])=>`<div class="adm-panel" data-adm-panel="${id}" role="tabpanel" ${id===tab?'':'hidden'}>${html}</div>`).join('')}
  </div>`;

  const showTab=id=>{state.adminTab=id;c.querySelectorAll('[data-adm-panel]').forEach(p=>p.hidden=p.dataset.admPanel!==id);c.querySelectorAll('.adm-tabs [data-adm-tab]').forEach(b=>{const on=b.dataset.admTab===id;b.classList.toggle('on',on);b.setAttribute('aria-selected',on)})};
  c.querySelectorAll('[data-adm-tab]').forEach(b=>b.onclick=()=>{showTab(b.dataset.admTab);if(b.classList.contains('adm-tile'))c.querySelector('.adm-tabs').scrollIntoView({behavior:'smooth',block:'start'})});
  c.querySelectorAll('.adm-search input').forEach(input=>input.addEventListener('input',()=>{const q=input.value.trim().toLowerCase();c.querySelectorAll(`[data-adm-filter="${input.id}"] [data-search]`).forEach(r=>{r.hidden=Boolean(q)&&!r.dataset.search.includes(q)})}));

  document.querySelector('#add-user').onsubmit=async e=>{e.preventDefault();const f=Object.fromEntries(new FormData(e.currentTarget));try{await post('/api/users',f);toast('User created');await loadBootstrap();renderAdmin(c)}catch(x){toast(x.message,true)}};
  document.querySelector('#add-project').onsubmit=async e=>{e.preventDefault();try{await post('/api/projects',Object.fromEntries(new FormData(e.currentTarget)));toast('Project added');await loadBootstrap();renderAdmin(c)}catch(x){toast(x.message,true)}};
  document.querySelectorAll('[data-billing-tag]').forEach(sel=>sel.onchange=async()=>{
    if(!sel.value)return;
    try{await post('/api/admin/billing-status-mapping',{pleo_tag_id:sel.dataset.billingTag,classification:sel.value});sel.classList.remove('missing');toast('Classification mapping saved and applied to existing transactions')}catch(x){toast(x.message,true)}
  });
  document.querySelectorAll('[data-approve-rule]').forEach(b=>b.onclick=async()=>{
    try{await post(`/api/admin/project-mapping-rules/${b.dataset.approveRule}/approve`,{});toast('Mapping rule approved');renderAdmin(c)}catch(x){toast(x.message,true)}
  });
  document.querySelector('#approve-all-rules')?.addEventListener('click',async e=>{
    e.currentTarget.disabled=true;
    try{const r=await post('/api/admin/project-mapping-rules/approve-all',{});toast(`${r.approved} rule(s) approved · ${r.applied?.ruleAssigned??0} transaction(s) now mapped to a project`);renderAdmin(c)}catch(x){toast(x.message,true);e.currentTarget.disabled=false}
  });
  const xlUpload=async dryRun=>{
    const file=document.querySelector('#xl-file').files[0];if(!file)return toast('Choose a Pleo export .xlsx file',true);
    const out=document.querySelector('#xl-result');out.innerHTML=`<div class="muted small">${dryRun?'Analysing':'Importing'} ${esc(file.name)}…</div>`;
    const r=await api(`/api/admin/pleo-excel-import${dryRun?'?dry_run=1':''}`,{method:'POST',headers:{'Content-Type':'application/octet-stream','X-Filename':file.name},body:file});
    const s=r.summary;const li=(k,v)=>`<tr><td>${k}</td><td class="right"><b>${v}</b></td></tr>`;
    out.innerHTML=`<div class="notice" style="margin-top:16px"><b>${dryRun?'Preview — nothing written yet':'Import complete'}</b> · sheet “${esc(s.sheetName)}”</div><div class="table-wrap"><table class="table"><tbody>${li('Rows in file',s.rows)}${li('Matched to live transactions',s.matched)}${li('Not found in Expensyra (skipped)',s.unmatched)}${li('Teams named',s.teams.named)}${li('Projects to create',s.projects.toCreate.length?esc(s.projects.toCreate.join(', ')):'0')}${li('Pleo teams linked as projects',s.projects.linked)}${li('Accounts given a category name',s.categories.accounts)}${li('Unresolved-category transactions this names',s.categories.unresolvedTransactionsThisWillName)}${li('Rows with Pleo review history',s.reviewHistoryRows)}</tbody></table></div>${s.teams.ambiguous.length||s.categories.ambiguous.length?`<div class="notice warning" style="margin-top:8px">Skipped as ambiguous (under 90% agreement): ${s.teams.ambiguous.length} team(s), ${s.categories.ambiguous.length} account(s).</div>`:''}${dryRun?'':'<div class="hint">Every Pleo team is now a project, and its transactions are linked to it.</div>'}`;
    return r;
  };
  document.querySelector('#xl-file')?.addEventListener('change',e=>{document.querySelector('#xl-import').disabled=true;document.querySelector('#xl-result').innerHTML='';const f=e.currentTarget.files[0];document.querySelector('#xl-file-name').textContent=f?f.name:'Choose a Pleo export (.xlsx)';document.querySelector('.adm-drop').classList.toggle('has-file',Boolean(f))});
  document.querySelector('#xl-preview')?.addEventListener('click',async()=>{try{await xlUpload(true);document.querySelector('#xl-import').disabled=false}catch(x){document.querySelector('#xl-result').innerHTML=`<div class="error-box">${esc(x.message)}</div>`}});
  document.querySelector('#xl-import')?.addEventListener('click',async e=>{e.currentTarget.disabled=true;try{await xlUpload(false);toast('Pleo Excel imported');const html=document.querySelector('#xl-result').innerHTML;await loadBootstrap();await renderAdmin(c);const slot=document.querySelector('#xl-result');if(slot)slot.innerHTML=html}catch(x){document.querySelector('#xl-result').innerHTML=`<div class="error-box">${esc(x.message)}</div>`}});
  document.querySelector('#add-rule').onsubmit=async e=>{e.preventDefault();const f=Object.fromEntries(new FormData(e.currentTarget));try{await post('/api/admin/project-mapping-rules',{...f,project_id:Number(f.project_id)});toast('Mapping rule proposed — pending approval');renderAdmin(c)}catch(x){toast(x.message,true)}};
  document.querySelectorAll('[data-edit-project]').forEach(tr=>tr.onclick=()=>{
    const p=projects.find(x=>x.id===Number(tr.dataset.editProject));if(!p)return;
    c.querySelectorAll('[data-edit-project]').forEach(r=>r.classList.toggle('adm-selected',r===tr));
    const use=p.usage||{transactions:0,links:0,reviews:0},inUse=use.transactions||use.links||use.reviews;
    document.querySelector('#edit-project-slot').innerHTML=card(`Edit ${p.code}`,`Code can't change: past decisions refer to it.${inUse?` Used by ${[use.transactions&&`${fmtCount(use.transactions)} transaction(s)`,use.links&&`${fmtCount(use.links)} link(s)`].filter(Boolean).join(' and ')}.`:''}`,`<form id="edit-project" class="adm-form"><div class="field"><label>Project name</label><input name="name" required value="${esc(p.name)}" autocomplete="off"></div><div class="field"><label>Customer</label><input name="customer" value="${esc(p.customer||'')}" autocomplete="off"></div><div class="field"><label>Project manager</label><input name="project_manager" value="${esc(p.project_manager||'')}" autocomplete="off"></div><div class="field"><label>Country</label><input name="country" value="${esc(p.country||'')}" autocomplete="off"></div><div class="field"><label>Status</label><select name="status">${[['ACTIVE','Active'],['ON_HOLD','On hold'],['CLOSED','Closed']].map(([v,l])=>`<option value="${v}" ${p.status===v?'selected':''}>${l}</option>`).join('')}</select></div><div class="field"><label>Commercial model</label><input name="commercial_model" value="${esc(p.commercial_model||'')}" placeholder="e.g. Time and materials" autocomplete="off"></div><div class="adm-actions"><button class="btn btn-primary">Save changes</button><button type="button" id="edit-project-cancel" class="btn btn-ghost">Cancel</button></div>${isAdmin?`<div class="adm-danger"><div><b>Delete project</b><span>${inUse?'In use, so it can’t be deleted. Set the status to Closed to retire it.':'Not used anywhere yet, so it can be deleted.'}</span></div><button type="button" id="delete-project" class="btn btn-danger adm-btn-sm" ${inUse?'disabled':''}>Delete</button></div>`:''}</form>`);
    const addProject=document.querySelector('#edit-project-slot').previousElementSibling;addProject.hidden=true;document.querySelector('#edit-project-slot').scrollIntoView({behavior:'smooth',block:'nearest'});
    document.querySelector('#edit-project-cancel').onclick=()=>{document.querySelector('#edit-project-slot').innerHTML='';addProject.hidden=false;tr.classList.remove('adm-selected')};
    document.querySelector('#edit-project').onsubmit=async e=>{e.preventDefault();const f=Object.fromEntries(new FormData(e.currentTarget));try{await send('PATCH',`/api/admin/projects/${p.id}`,f);afterSave('Project updated')}catch(x){toast(x.message,true)}};
    document.querySelector('#delete-project')?.addEventListener('click',async()=>{if(!confirm(`Delete project ${p.code} · ${p.name}? This can't be undone.`))return;try{await send('DELETE',`/api/admin/projects/${p.id}`);afterSave(`Project ${p.code} deleted`)}catch(x){toast(x.message,true)}});
  });
  // Edit a user: details, role, password reset, deactivate/reactivate, delete.
  document.querySelectorAll('[data-edit-user]').forEach(row=>row.onclick=()=>{
    const u=allUsers.find(x=>x.id===Number(row.dataset.editUser));if(!u)return;const self=u.id===state.user.id;
    c.querySelectorAll('[data-edit-user]').forEach(r=>r.classList.toggle('adm-selected',r===row));
    const slot=document.querySelector('#edit-user-slot');
    slot.innerHTML=card(`Edit ${u.name}`,`${u.active?'Active':'Deactivated'} · ${fmtCount(u.reviews)} review(s) on record${u.last_seen_at?` · last seen ${esc(fmtDate(u.last_seen_at))}`:''}`,`<form id="edit-user" class="adm-form">
      <div class="field"><label>Full name</label><input name="name" required value="${esc(u.name)}" autocomplete="off"></div>
      <div class="field"><label>Work email</label><input name="email" type="email" required value="${esc(u.email)}" autocomplete="off"></div>
      ${isAdmin?`<div class="field"><label>Role</label><select name="role" ${self?'disabled title="You cannot change your own role"':''}>${Object.entries(ADMIN_ROLE_LABELS).map(([v,l])=>`<option value="${v}" ${u.role===v?'selected':''}>${esc(l)}</option>`).join('')}</select></div>`:''}
      <div class="field"><label>Reset password <span class="muted small">(optional)</span></label><input name="temporary_password" type="password" minlength="12" autocomplete="new-password" placeholder="New temporary password"></div>
      <div class="adm-actions"><button class="btn btn-primary">Save changes</button><button type="button" id="edit-user-cancel" class="btn btn-ghost">Cancel</button></div>
      ${self?'':`<div class="adm-danger"><div><b>${u.active?'Deactivate':'Reactivate'} account</b><span>${u.active?`Blocks sign-in and keeps their history.${u.open_assigned?` Their ${fmtCount(u.open_assigned)} open transaction(s) go back to Unassigned.`:''}`:'Lets them sign in again.'}</span></div><button type="button" id="toggle-user" class="btn ${u.active?'btn-danger':'btn-soft'} adm-btn-sm">${u.active?'Deactivate':'Reactivate'}</button></div>
      <div class="adm-danger"><div><b>Delete account</b><span>${u.reviews?'Has review history, so it can only be deactivated.':'Only possible for accounts with no history.'}</span></div><button type="button" id="delete-user" class="btn btn-danger adm-btn-sm" ${u.reviews?'disabled':''}>Delete</button></div>`}
    </form>`);
    slot.previousElementSibling.hidden=true;slot.scrollIntoView({behavior:'smooth',block:'nearest'});
    document.querySelector('#edit-user-cancel').onclick=()=>{slot.innerHTML='';slot.previousElementSibling.hidden=false;row.classList.remove('adm-selected')};
    document.querySelector('#edit-user').onsubmit=async e=>{e.preventDefault();const f=Object.fromEntries(new FormData(e.currentTarget));if(!f.temporary_password)delete f.temporary_password;try{const r=await send('PATCH',`/api/admin/users/${u.id}`,f);afterSave(`${f.name} updated${f.temporary_password?' · they must set a new password at next sign-in':''}${r.unassigned?` · ${r.unassigned} open transaction(s) unassigned`:''}`)}catch(x){toast(x.message,true)}};
    document.querySelector('#toggle-user')?.addEventListener('click',async()=>{
      if(u.active&&!confirm(`Deactivate ${u.name}? They will be signed out and can't sign in.${u.open_assigned?`\n\nTheir ${u.open_assigned} open transaction(s) go back to Unassigned.`:''}`))return;
      try{const r=await send('PATCH',`/api/admin/users/${u.id}`,{active:!u.active});afterSave(`${u.name} ${u.active?'deactivated':'reactivated'}${r.unassigned?` · ${r.unassigned} transaction(s) unassigned`:''}`)}catch(x){toast(x.message,true)}
    });
    document.querySelector('#delete-user')?.addEventListener('click',async()=>{
      if(!confirm(`Delete ${u.name} (${u.email})? This can't be undone.`))return;
      try{await send('DELETE',`/api/admin/users/${u.id}`);afterSave(`${u.name} deleted`)}
      catch(x){if(/deactivated/.test(x.message)&&u.active&&confirm(`${x.message}\n\nDeactivate ${u.name} instead?`)){try{await send('PATCH',`/api/admin/users/${u.id}`,{active:false});afterSave(`${u.name} deactivated`)}catch(y){toast(y.message,true)}}else toast(x.message,true)}
    });
  });
  // Edit or delete a project link; approved changes re-map its transactions.
  document.querySelectorAll('[data-edit-rule]').forEach(b=>b.onclick=()=>{
    const r=rules.find(x=>x.id===Number(b.dataset.editRule));if(!r)return;
    c.querySelectorAll('[data-edit-rule]').forEach(x=>x.closest('tr').classList.toggle('adm-selected',x===b));
    const slot=document.querySelector('#edit-rule-slot');
    slot.innerHTML=card('Edit project link',`${esc(r.source_label||r.source_value)} · ${r.status==='APPROVED'?`approved${r.team_transactions?`, ${fmtCount(r.team_transactions)} transaction(s) follow it`:''}`:'waiting for approval'}`,`<form id="edit-rule" class="adm-form">
      <div class="field"><label>Source type</label><select name="source_type">${Object.entries(ADMIN_SOURCE_LABELS).map(([v,l])=>`<option value="${v}" ${r.source_type===v?'selected':''}>${esc(l)}</option>`).join('')}</select></div>
      <div class="field"><label>Source value</label><input name="source_value" required value="${esc(r.source_value)}" autocomplete="off"></div>
      <div class="field"><label>JSAN project</label><select name="project_id">${projects.map(p=>`<option value="${p.id}" ${p.id===r.project_id?'selected':''}>${esc(p.code)} · ${esc(p.name)}</option>`).join('')}</select></div>
      ${r.status==='APPROVED'?'<div class="hint">Saving moves the transactions this link assigned to the new project. Projects picked by a reviewer are never changed.</div>':''}
      <div class="adm-actions"><button class="btn btn-primary">Save changes</button><button type="button" id="edit-rule-cancel" class="btn btn-ghost">Cancel</button></div>
      <div class="adm-danger"><div><b>Delete link</b><span>${r.status==='APPROVED'?'Transactions it assigned go back to “No project” unless another link covers them.':'Removes the proposal.'}</span></div><button type="button" id="delete-rule" class="btn btn-danger adm-btn-sm">Delete</button></div>
    </form>`);
    slot.previousElementSibling.hidden=true;slot.scrollIntoView({behavior:'smooth',block:'nearest'});
    document.querySelector('#edit-rule-cancel').onclick=()=>{slot.innerHTML='';slot.previousElementSibling.hidden=false;b.closest('tr').classList.remove('adm-selected')};
    document.querySelector('#edit-rule').onsubmit=async e=>{e.preventDefault();const f=Object.fromEntries(new FormData(e.currentTarget));try{const x=await send('PATCH',`/api/admin/project-mapping-rules/${r.id}`,{...f,project_id:Number(f.project_id)});afterSave(`Project link updated${x.cleared?` · ${fmtCount(x.cleared)} transaction(s) re-mapped`:''}`)}catch(x){toast(x.message,true)}};
    document.querySelector('#delete-rule').onclick=async()=>{
      if(!confirm(`Delete the link ${r.source_label||r.source_value} → ${r.project_code}?${r.status==='APPROVED'&&r.team_transactions?`\n\nIts ${r.team_transactions} transaction(s) go back to “No project” unless another link covers them.`:''}`))return;
      try{const x=await send('DELETE',`/api/admin/project-mapping-rules/${r.id}`);afterSave(`Project link deleted${x.cleared?` · ${fmtCount(x.cleared)} transaction(s) unlinked`:''}`)}catch(x){toast(x.message,true)}
    };
  });
}

init();
