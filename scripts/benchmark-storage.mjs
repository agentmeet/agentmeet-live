// Local Cloudflare runtime comparison; never invokes production.
import { Miniflare, convertV4MiniflareOptions, Log, LogLevel } from 'miniflare';
const script = `export default {fetch(){return new Response('bench')}};
export class SQLBench {constructor(s){this.s=s;this.sql=s.storage.sql;this.sql.exec('CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY,json TEXT)');}async fetch(r){if(r.method==='POST'){const start=performance.now();this.s.storage.transactionSync(()=>{for(let i=1;i<=10000;i++)this.sql.exec('INSERT INTO events VALUES(?,?)',i,JSON.stringify({id:'m'+i,text:'a'.repeat(1000)}));});return Response.json({seed_ms:performance.now()-start});}const after=Number(new URL(r.url).searchParams.get('after'));const q=this.sql.exec('SELECT * FROM events WHERE seq>? ORDER BY seq LIMIT 51',after);const rows=q.toArray();return Response.json({count:rows.length,rows_read:q.rowsRead});}}
export class KVBench {constructor(s){this.s=s;}async fetch(r){if(r.method==='POST'){const start=performance.now();for(let i=0;i<10000;i+=16)await this.s.storage.put('messages:'+String(i/16).padStart(12,'0'),Array.from({length:Math.min(16,10000-i)},(_,j)=>({seq:i+j+1,text:'a'.repeat(1000)})));return Response.json({seed_ms:performance.now()-start});}const url=new URL(r.url),after=Number(url.searchParams.get('after'));let chunks;if(url.searchParams.has('bounded'))chunks=await this.s.storage.list({prefix:'messages:',start:'messages:'+String(Math.floor(after/16)).padStart(12,'0'),limit:4});else chunks=await this.s.storage.list({prefix:'messages:'});return Response.json({count:[...chunks.values()].flat().filter(m=>m.seq>after).slice(0,51).length,values_read:chunks.size});}}`;
const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script,durableObjects:{SQL:{className:'SQLBench',useSQLite:true},KV:{className:'KVBench',useSQLite:false}},log:new Log(LogLevel.NONE)}));
try{
  const result={environment:'local Miniflare/workerd; macOS; 10000 events with 1000 ASCII text bytes each; 10 reads per case',measured_at:new Date().toISOString()};
  for(const binding of ['SQL','KV']){
    const ns=await mf.getDurableObjectNamespace(binding),stub=ns.get(ns.idFromName('benchmark'));
    const seeded=await(await stub.fetch('https://bench/',{method:'POST'})).json(); result[binding]={...seeded};
    for(const [name,query] of [['empty','after=10000'],['page','after=5000'],...(binding==='KV'?[['bounded_empty','after=10000&bounded=1'],['bounded_page','after=5000&bounded=1']]:[])]){
      const times=[];let detail;for(let i=0;i<10;i++){const start=performance.now();detail=await(await stub.fetch('https://bench/?'+query)).json();times.push(performance.now()-start);}
      times.sort((a,b)=>a-b); result[binding][name]={median_roundtrip_ms:Number(times[5].toFixed(2)),...detail};
    }
  }
  console.log(JSON.stringify(result,null,2));
}finally{await mf.dispose();}
