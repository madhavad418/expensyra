import zipfile,re,hashlib,json,sys
from pathlib import Path
from xml.sax.saxutils import escape
from datetime import datetime
import openpyxl
sys.stdout.reconfigure(encoding='utf-8')
src=Path(r'C:\Users\Madhavrao\Downloads\JSAN_Engineering_Leadership_Review_Dashboard.xlsx')
out=Path('artifacts/JSAN_Engineering_Leadership_Review_Dashboard.xlsx')
ns='http://schemas.openxmlformats.org/spreadsheetml/2006/main'
updates={
'xl/worksheets/sheet2.xml':{
'B9':'Finance Operations / Pleo Validation (UI: JSAN Expensyra)',
'C9':'Phase 1 implemented; live status to confirm',
'D9':'Package v1.2.1 + subsequent enhancements',
'N9':'Reconcile current Pleo counts; close tag/project backlog; obtain UAT and restore evidence.',
'O9':'Confirm accountable owner, adoption scope, current hosting and readiness scores.',
'R9':46314},
'xl/worksheets/sheet3.xml':{
'D12':'Reconcile Pleo totals and tag/project backlog; confirm reviewer SLA, hosting, UAT and backup/restore evidence.',
'I12':'Dated live counts and tag definitions; named owner/SLA; hosting evidence; successful restore and UAT sign-off.',
'J12':'Reviewed 2026-10-19 against local source. Historical counts and 83% readiness not independently verified. See SpendOps_Evidence.'},
'xl/worksheets/sheet8.xml':{
'A3':'SpendOps (application brand: JSAN Expensyra) | Expense validation, allocation, classification and auditable reporting.',
'C6':'Sync/backfill Pleo expenses; allocate reviewers; validate receipts; classify projects and spending; report expense and reviewer metrics.',
'C7':'Phase 1 implemented; live status to confirm',
'C8':'Package v1.2.1; later enhancements in source',
'C10':'83% / Green - prior assessment, not revalidated',
'C16':'Prior score retained; adoption evidence needed',
'C17':'Prior score retained; production checks needed',
'C18':'Prior score retained; owner remains TBD',
'C19':'Prior score retained; restore evidence needed',
'C20':'Prior score retained; signed UAT needed',
'C21':'Runbooks exist; README has stale details',
'E19':'Prior scores retained; not a production certification. See SpendOps_Evidence.',
'A24':'Implemented: Pleo sync/backfill, daily scheduler, receipt review, allocation, audit trail and project attribution.',
'A25':'Prior snapshot: 40,107 entries = 30,900 tagged + 9,207 untagged. Arithmetic matches; live totals and tag definition unverified.',
'A26':'Current docs: Railway + PostgreSQL, local SQLite fallback. Prior Contabo claim needs confirmation; Billing Status alone is not JSAN classification.',
'I24':'Reconcile live totals and separate tags, project attribution, commercial classification and review status.',
'I25':'Name an owner; agree reviewer SLA, exception handling and UAT acceptance criteria.',
'I26':'Confirm actual hosting; capture backup/restore and monitoring evidence; refresh release documentation.',
'A30':'Data completeness / definitions',
'D30':'Tag completeness, project mapping and JSAN review are separate dimensions; historical counts may be stale.',
'I30':'Dated live extract with explicit filters; approved project rules; owner and backlog SLA.',
'I31':'Audit/review history implemented; obtain retention and export evidence. Tamper-proof storage is not established.',
'I32':'Document actual host/DB; schedule protected backups; retain successful restore-test evidence.',
'D37':'Assign owner; close reconciliation, SLA, UAT and restore evidence; revalidate readiness scores.',
'D41':'Live usage report required; not derivable from source code.',
'D42':'Current issue register required; local tests do not establish zero defects.',
'D43':'Release/deployment history required; package declares 1.2.1.',
'D44':'Production monitoring and Pleo sync-run evidence required.',
'D45':'Hosting/provider invoice required; not checked in local source.',
'D46':'Signed stakeholder UAT record required.',
'A50':'2026-10-19','C50':'Source review','E50':'Updated implemented scope; added SpendOps_Evidence with sources and verification gaps.','K50':'TBD','O50':'Reviewed',
'A51':'2026-10-19','C51':'Evidence gap','E51':'Historical counts, Contabo/live status and 83% health retained as prior claims, not certified current.','K51':'TBD','O51':'Open'
}}
# Use the correct Excel date serial for the workbook update.
from openpyxl.utils.datetime import to_excel
updates['xl/worksheets/sheet2.xml']['R9']=int(to_excel(datetime(2026,10,19)))
evidence=[
['Topic','Finding / matching status','Verified detail or required follow-up','Evidence / source','Status'],
['Review scope','Local source review on 2026-10-19','Project name remains SpendOps; user-facing application is JSAN Expensyra. Production service and Pleo account were not queried.','package.json; public/app.js; workbook A05_SpendOps','Reviewed'],
['Business purpose','Matches','Pleo expense ingestion, allocation, receipt validation, project/commercial classification and finance/reviewer reporting are implemented.','server.js; public/app.js; docs/OPERATIONS.md','Implemented'],
['Version / completion','Qualification added','package.json declares 1.2.1. Current source includes later enhancements; Phase 1 complete is not proof of release approval or production acceptance.','package.json; workbook C8','Needs release evidence'],
['Live ingestion / company verified','Not independently verifiable','Workbook reports company verification/live ingestion. Connector exists, but current credentials, company status and last successful production sync need a dated operational check.','server.js; docs/PLEO_SETUP.md; original A24','Needs live evidence'],
['Historical counts','Arithmetic matches; currency unverified','40,107 = 30,900 + 9,207; tagged 77.04%, untagged 22.96%. Preserve as historical snapshot only. Confirm snapshot date, scope and tag definition before replacing totals.','Original A05_SpendOps!A25; no live query performed','Needs live evidence'],
['Hosting / database','Documentation mismatch','Workbook says Contabo VPS. Current deployment guide specifies Railway + PostgreSQL using DATABASE_URL; SQLite fallback uses DATABASE_PATH. Confirm actual production deployment.','docs/DEPLOYMENT.md; lib/db.mjs; server.js','Needs host confirmation'],
['Architecture image','Preserved; not re-certified','Existing embedded architecture artwork is preserved. Verified logical path: browser SPA -> Node API -> PostgreSQL or SQLite; server -> Pleo API; separate raw source, review/session and audit records.','lib/db.mjs; server.js; docs/ARCHITECTURE.md','Architecture detail added'],
['Operational tag vs classification','Clarified','Pleo Billing Status/source tags do not replace JSAN commercial classification, project attribution or reviewer status. Report these as distinct dimensions.','server.js; lib/precedence.mjs; public/app.js','Clarified'],
['Commercial classes','Missing detail added','Current classes: CUSTOMER_BILLABLE, JSAN_INTERNAL, SALARY_DEDUCTION, REFUND, REIMBURSEMENT. PROJECT_COST and SHARED_COST are retained only for legacy data.','server.js COMMERCIAL_CLASSIFICATIONS and LEGACY_COMMERCIAL_CLASSIFICATIONS','Implemented'],
['Salary deductions','Missing feature added','Salary-deduction amounts and split reporting are present; record the deduction alongside the applicable commercial classification.','lib/expense-summary.mjs; server.js; public/app.js','Implemented'],
['Ingestion / historical backfill','Matches; expanded','Export V2 and Accounting Entries connectors; settlement-based backfill/checkpoints; idempotent updates. Source refresh preserves reviewer/allocation/decision fields.','server.js; docs/OPERATIONS.md','Implemented'],
['Daily sync / pending entries','Missing detail added','Business-timezone daily schedule, missed-slot catch-up and new-row filtering; independent pending refresh; missing pending records are looked up rather than assumed settled.','lib/daily-sync.mjs; server.js; docs/OPERATIONS.md','Implemented'],
['Project / category evidence','Missing detail added','Approved Team/Tag mapping, conflict flags and manual-review precedence; source and reviewer evidence remain distinct.','lib/precedence.mjs; docs/ARCHITECTURE.md','Implemented; unit tests passed'],
['Allocation / review','Matches; expanded','Bulk and filtered allocation; reviewer queues; validation start/pause and heartbeat; approve/reject/needs-info; explicit reopen/re-check and audit history.','server.js; public/app.js; docs/OPERATIONS.md','Implemented'],
['Reporting / expense intelligence','Missing feature added','Settlement/billing-currency reporting, signed refunds, validated splits and wallet carry-forward; pending/deleted entries excluded. Zero opening balance remains an estimate.','lib/expense-summary.mjs; docs/OPERATIONS.md','Implemented; reconciliation needed'],
['Car-rental ledger','Missing feature added','Car-rental ledger/API and cache-import tooling exist; data freshness and operational adoption require separate validation.','lib/car-rentals.mjs; scripts/build-car-rental-cache.mjs; public/app.js','Implemented'],
['Authentication / access','Matches; expanded','Local accounts, ADMIN/TEAM_LEAD/REVIEWER/FINANCE_QC roles, temporary-password change, session cookies and salted password hashing. SSO is recommended, not established as implemented.','server.js; docs/SECURITY.md','Implemented'],
['Login UX / branding','Missing feature added','Light animated login, responsive layout, password visibility, loading feedback and transparent JSAN/Expensyra logos; reduced-motion styling exists.','public/app.js; public/app.css','Implemented; UAT needed'],
['Audit / finance controls','Claim qualified','Review and audit records exist. Do not equate application history with independently verified immutable/tamper-proof storage. Confirm retention/access/export controls.','server.js; original A05_SpendOps!I31','Operational evidence needed'],
['Backups / disaster recovery','Not established','Deployment guide describes backups and restore checks; snapshot tooling exists. No successful production restore evidence was verified in this review.','docs/DEPLOYMENT.md; scripts/create-reconciliation-snapshot.mjs','Open'],
['Readiness / health','Numerically consistent; not re-scored','Scores 5,4,4,4,4,4 average to 83% rounded. Prior Green and scores retained; this review does not certify business adoption, security/DR or UAT readiness.','01_Portfolio!G9:M9; A05_SpendOps!B16:B21; 00_CEO_Dashboard!T6','Leadership revalidation needed'],
['Owners / dates / cost / usage','Unverified fields preserved','Owner and operational metric targets remain TBD. Obtain named owner, milestone dates, active-user/defect reports, availability, costs and signed UAT.','A05_SpendOps!C11 and rows 41:46; 02_Review_Actions!12','Open'],
['Documentation consistency','Mismatch found','README still lists older classes, no npm dependencies and Node 22.5+. Current package requires Node >=22.13.0 and pg; deployment guide describes PostgreSQL. Refresh README/architecture/security documentation.','README.md; package.json; docs/DEPLOYMENT.md; lib/db.mjs','Documentation action'],
['Validation performed','Passed on 2026-10-19','npm run check; npm run test:precedence; npm run test:daily-sync. These checks do not certify production connectivity, full regression coverage or UAT.','Local command results from this review','Passed'],
['Workbook preservation','Existing layout/charts preserved','Updated only SpendOps-related cells in Portfolio, Review Actions and SpendOps sheet; added this evidence sheet. Prior scores and other applications were not changed.','ZIP package-level validation','Verified']
]
def cell_xml(ref,val,style=None):
 a=f' r="{ref}"'+(f' s="{style}"' if style is not None else '')
 if isinstance(val,(int,float)):return f'<c{a}><v>{val}</v></c>'
 return f'<c{a} t="inlineStr"><is><t xml:space="preserve">{escape(val)}</t></is></c>'
def patch(xml,changes):
 for ref,val in changes.items():
  pattern=rf'<c\b[^>]*\br="{ref}"[^>]*(?:/>|>.*?</c>)'
  match=re.search(pattern,xml,re.S)
  if not match:raise RuntimeError('Cell missing '+ref)
  st=re.search(r'\bs="(\d+)"',match.group())
  xml=xml[:match.start()]+cell_xml(ref,val,st.group(1) if st else None)+xml[match.end():]
 return xml
with zipfile.ZipFile(src) as zin:
 entries={n:zin.read(n) for n in zin.namelist()}
 for name,changes in updates.items():entries[name]=patch(entries[name].decode(),changes).encode()
 # Increase row heights for readable wrapped text in existing merged cells.
 for name,rows in {'xl/worksheets/sheet2.xml':{9:75},'xl/worksheets/sheet3.xml':{12:95},'xl/worksheets/sheet8.xml':{6:60,7:36,8:36,10:36,24:48,25:60,26:66,30:60,31:48,32:48,37:40,50:60,51:60}}.items():
  text=entries[name].decode()
  for n,h in rows.items():
   def height(m):
    tag=re.sub(r'\s(?:ht|customHeight)="[^"]*"','',m.group())
    return tag[:-1]+f' ht="{h}" customHeight="1">'
   text=re.sub(rf'<row\b[^>]*\br="{n}"[^>]*>',height,text)
  entries[name]=text.encode()
 # Use existing workbook styles for the new evidence grid.
 src_sheet=zin.read('xl/worksheets/sheet2.xml').decode()
 def style(ref):return re.search(rf'<c\b[^>]*r="{ref}"[^>]*s="(\d+)"',src_sheet).group(1)
 hs,bs=style('B4'),style('B9')
 rows=[]
 for n,record in enumerate(evidence,1):
  cells=''.join(cell_xml(f'{chr(65+i)}{n}',v,hs if n==1 else bs) for i,v in enumerate(record))
  rows.append(f'<row r="{n}" ht="{30 if n==1 else 90}" customHeight="1">{cells}</row>')
 new=f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="{ns}"><dimension ref="A1:E{len(rows)}"/><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="18"/><cols><col min="1" max="1" width="29" customWidth="1"/><col min="2" max="2" width="36" customWidth="1"/><col min="3" max="3" width="95" customWidth="1"/><col min="4" max="4" width="56" customWidth="1"/><col min="5" max="5" width="30" customWidth="1"/></cols><sheetData>{"".join(rows)}</sheetData><autoFilter ref="A1:E{len(rows)}"/><pageMargins left="0.25" right="0.25" top="0.5" bottom="0.5" header="0.2" footer="0.2"/></worksheet>'
 entries['xl/worksheets/sheet15.xml']=new.encode()
 text=entries['xl/workbook.xml'].decode().replace('</sheets>','<sheet name="SpendOps_Evidence" sheetId="15" r:id="rId22"/></sheets>')
 entries['xl/workbook.xml']=text.encode()
 key='xl/_rels/workbook.xml.rels'
 entries[key]=entries[key].decode().replace('</Relationships>','<Relationship Id="rId22" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet15.xml"/></Relationships>').encode()
 key='[Content_Types].xml'
 entries[key]=entries[key].decode().replace('</Types>','<Override PartName="/xl/worksheets/sheet15.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>').encode()
 with zipfile.ZipFile(out,'w',zipfile.ZIP_DEFLATED) as zout:
  for info in zin.infolist():zout.writestr(info,entries.pop(info.filename))
  for name,data in entries.items():zout.writestr(name,data)
# Validate expected cell values and exact preservation of every other original package member.
w=openpyxl.load_workbook(out,read_only=True)
assert w['SpendOps_Evidence'].max_row==len(evidence)
for name,sheet in [('xl/worksheets/sheet2.xml','01_Portfolio'),('xl/worksheets/sheet3.xml','02_Review_Actions'),('xl/worksheets/sheet8.xml','A05_SpendOps')]:
 for ref,val in updates[name].items():
  actual=w[sheet][ref].value
  assert actual==val or (ref=='R9' and actual==datetime(2026,10,19)),(sheet,ref,actual,val)
w.close()
allowed=set(updates)|{'xl/workbook.xml','xl/_rels/workbook.xml.rels','[Content_Types].xml'}
with zipfile.ZipFile(src) as a,zipfile.ZipFile(out) as b:
 assert b.testzip() is None
 unchanged=[n for n in a.namelist() if n not in allowed]
 assert all(a.read(n)==b.read(n) for n in unchanged)
manifest={'source':str(src),'source_sha256':hashlib.sha256(src.read_bytes()).hexdigest(),'updated':str(out.resolve()),'updated_sha256':hashlib.sha256(out.read_bytes()).hexdigest(),'changed_cells':sum(map(len,updates.values())),'preserved_package_members':len(unchanged),'evidence_rows':len(evidence)-1}
Path('artifacts/spendops-workbook-review.json').write_text(json.dumps(manifest,indent=2))
print(json.dumps(manifest,indent=2))
