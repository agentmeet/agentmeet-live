import assert from 'node:assert/strict';
const base=process.env.BASE||'https://agentmeet.live';
async function call(path,token,method='GET',body,key){
 const response=await fetch(base+'/v2/rooms'+path,{method,headers:{...(token?{Authorization:'Bearer '+token}:{}),...(body!==undefined?{'Content-Type':'application/json'}:{}),...(key?{'Idempotency-Key':key}:{})},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(20000)});
 assert.match(response.headers.get('X-Request-ID')||'',/^[a-f0-9-]{36}$/);return{status:response.status,data:await response.json()};
}
const creation=await call('',null,'POST',{nick:'smoke-owner',title:'Isolated project API regression'});assert.equal(creation.status,201,JSON.stringify(creation));
const root='/'+creation.data.room.id,token=creation.data.token;
assert.equal((await call(root)).status,401);
const invited=await call(root+'/participants',token,'POST',{nick:'smoke-member'});assert.equal(invited.status,201);
const body={text:'**Structured handoff**\n'+('漢'.repeat(2100)),kind:'MAP_READY',data:{types:Array.from({length:21},(_,i)=>({name:'type'+i,sha256:'a'.repeat(64)}))},to:[invited.data.participant.id]};
const sent=await call(root+'/messages',token,'POST',body,'production-handoff');assert.equal(sent.status,201);
const retry=await call(root+'/messages',token,'POST',body,'production-handoff');assert.equal(retry.status,200);assert.equal(retry.data.message.id,sent.data.message.id);
assert.equal((await call(root+'/messages',token,'POST',{text:'conflict'},'production-handoff')).status,409);
const received=await call(root+'/messages?for='+invited.data.participant.id,invited.data.token);assert.equal(received.data.messages.length,1);assert.deepEqual(received.data.messages[0].data,body.data);
assert.equal((await call(root+'/messages?cursor='+encodeURIComponent(received.data.next_cursor),token)).data.messages.length,0);
const reply=await call(root+'/messages',invited.data.token,'POST',{text:'Verified inputs',kind:'VERIFIED',reply_to:sent.data.message.id},'production-reply');assert.equal(reply.status,201);
const exported=await call(root+'/export',token);assert.equal(exported.data.messages.length,2);assert.match(exported.data.checksum.value,/^[a-f0-9]{64}$/);assert.ok(!JSON.stringify(exported.data).includes(token));
assert.equal((await call(root+'/participants/'+invited.data.participant.id+'/revoke',token,'POST',{})).status,200);
assert.equal((await call(root,invited.data.token)).status,401);
console.log('PASS project smoke: protected actors, large structured handoff, durable retry/conflict, sequence resume, reply, export and revocation ('+creation.data.room.id+')');
