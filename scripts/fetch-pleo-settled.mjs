// Read-only API capture. Uses settlement dates, not purchase dates.
import fs from 'node:fs';
const from=process.argv[2],to=process.argv[3],output=process.argv[4];
if(!from||!to||!output)throw Error('Usage: node --env-file=.env scripts/fetch-pleo-settled.mjs FROM TO OUTPUT');
const headers={Authorization:'Basic '+Buffer.from(process.env.PLEO_API_KEY+':').toString('base64'),Accept:'application/json','Content-Type':'application/json'};
const body={includeDeleted:false,settledAtStart:from+'T00:00:00Z',settledAtEnd:to+'T23:59:59.999Z'};
const entries=[],seen=new Set();let after=null,complete=false;
for(let page=1;page<=500;page++){
 const url=new URL((process.env.PLEO_API_BASE||'https://external.pleo.io')+'/v1/accounting-entries:search');
 url.searchParams.set('company_id',process.env.PLEO_COMPANY_ID);url.searchParams.set('limit','100');if(after)url.searchParams.set('after',after);
 const response=await fetch(url,{method:'POST',headers,body:JSON.stringify(body),signal:AbortSignal.timeout(60000)});
 if(!response.ok)throw Error('Pleo search HTTP '+response.status);
 const data=await response.json();
 for(const row of data.data||[]){if(seen.has(row.id))throw Error('Duplicate API ID');seen.add(row.id);entries.push(row);}
 if(page%20===0)console.log('Pages',page,'entries',entries.length);
 if(!data.pagination?.hasNextPage){complete=true;break;}
 if(!data.pagination.endCursor||data.pagination.endCursor===after)throw Error('Invalid pagination cursor');after=data.pagination.endCursor;
}
if(!complete)throw Error('Pagination incomplete');
if(entries.some(r=>!r.settledAt||r.settledAt.slice(0,10)<from||r.settledAt.slice(0,10)>to))throw Error('API did not honor settlement range');
fs.writeFileSync(output,JSON.stringify({fetched_at:new Date().toISOString(),filter:body,entries}));
console.log('Completed API download:',entries.length);
