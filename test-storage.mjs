import assert from 'node:assert/strict';
import { workerSource } from './test-source.mjs';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

// Test-only storage access is injected into an in-memory worker, never deployed.
const source = (await workerSource())
  .replace("    if (action === 'init')", `
    if (action === '__seed') {
      const data = await request.json();
      await this.state.storage.deleteAll();
      for (const [key, value] of Object.entries(data)) await this.state.storage.put(key, value);
      return new Response('OK');
    }
    if (action === '__bounded') {
      let reads=0;
      const measured=new Proxy(this.state.storage,{get(target,key){
        if(key==='list')return()=>{throw Error('Full history list is forbidden');};
        if(key==='get')return(...args)=>{reads++;return target.get(...args);};
        const value=target[key];return typeof value==='function'?value.bind(target):value;
      }});
      const result=await this.messagePage(Number(url.searchParams.get('since')),Number(url.searchParams.get('limit')),'',measured);
      return Response.json({...result,reads});
    }
    if (action === '__storage') {
      return Response.json(Object.fromEntries(await this.state.storage.list()));
    }
    if (action === 'init')`);
const mf = new Miniflare(convertV4MiniflareOptions({
  modules: true, script: source, compatibilityDate: '2024-12-01',
  durableObjects: { ROOMS: { className: 'RoomDO', useSQLite: false } },
}));

try {
  const ns = await mf.getDurableObjectNamespace('ROOMS');
  const room = ns.get(ns.idFromName('storage-regression'));
  const call = (action, params = {}) => room.fetch(`https://room/abc-def-ghi?${new URLSearchParams({ action, ...params })}`);
  const seed = data => room.fetch('https://room/abc-def-ghi?action=__seed', { method: 'POST', body: JSON.stringify(data) });
  const read = async () => (await (await call('read', { limit: '200' })).json()).messages;
  const post = (msg, nick = 'test') => call('post', { nick, msg });
  const now = Date.now();
  // Unicode forces two-byte structured-clone strings. The next message would
  // overflow a single 128 KiB history value on the production storage backend.
  const legacy = Array.from({ length: 32 }, (_, i) => ({
    id: `msg_${now - 1000 + i}`, nick: 'legacy', text: '漢'.repeat(1990), ts: now - 1000 + i,
  }));
  assert.equal((await seed({ messages: legacy, meta: { created_at: now, ttl_hours: 48, message_count: 32, title: 'Preserve me' } })).status, 200);
  assert.deepEqual(await read(), legacy);
  assert.equal((await post('漢'.repeat(2000))).status, 200);
  assert.deepEqual((await read()).slice(0, -1), legacy);
  let stored = await (await call('__storage')).json();
  assert.equal(stored.messages, undefined);
  assert.equal(stored.meta.title, 'Preserve me');
  assert.equal(stored.meta.ttl_hours, 48);
  assert.equal(stored.meta.message_count, 33);
  assert.deepEqual(stored.message_index, { first: 0, next: 33 });
  assert.ok(Object.entries(stored).filter(([key]) => key.startsWith('messages:')).every(([, chunk]) => chunk.length <= 16));
  assert.equal((await post('漢'.repeat(2000))).status, 200);
  assert.equal((await read()).length, 33, 'deduplicates after migration');

  const since = (await read()).at(-1).ts;
  const waiting = call('read', { since: String(since), wait: '5', exclude_nick: 'reader' });
  await new Promise(resolve => setTimeout(resolve, 150));
  await post('wake long poll');
  assert.equal((await (await waiting).json()).messages.at(-1).text, 'wake long poll');
  await Promise.all(Array.from({ length: 8 }, (_, i) => post(`concurrent ${i}`)));
  const concurrent = (await read()).slice(-8);
  assert.equal(new Set(concurrent.map(m => m.text)).size, 8);
  assert.equal(new Set(concurrent.map(m => m.ts)).size, 8);

  await call('lock', { secret: 'test-secret' });
  assert.equal((await post('blocked')).status, 403);
  await call('unlock', { secret: 'test-secret' });
  assert.equal((await post('unlocked')).status, 200);

  // At capacity, preserve all records and give clients a useful export path.
  const full = { meta: { created_at: now, ttl_hours: 1, message_count: 10000 }, message_index: { first: 0, next: 10000 } };
  for (let i = 0; i < 10000; i += 16) {
    full[`messages:${String(i / 16).padStart(12, '0')}`] = Array.from({ length: 16 }, (_, j) => ({ id: `old_${i + j}`, nick: 'old', text: String(i + j), ts: i + j }));
  }
  await seed(full);
  assert.equal((await post('capacity rejection')).status, 409);
  stored = await (await call('__storage')).json();
  assert.deepEqual(stored, full, 'failed capacity write never evicts or changes expiry');
  let cursor = '0', exported = [], snapshot;
  do {
    const response = await call('export', { cursor, limit: '200', ...(snapshot === undefined ? {} : { snapshot: String(snapshot) }) });
    assert.equal(response.status, 200);
    const page = await response.json(); assert.match(page.checksum.value, /^[a-f0-9]{64}$/);
    exported.push(...page.messages); cursor = page.next_cursor; snapshot = page.snapshot;
    if (!page.has_more) break;
  } while (true);
  assert.equal(exported.length, 10000);assert.equal(exported[0].text, '0');assert.equal(exported.at(-1).text, '9999');
  const delta = await (await call('read', { since: '9950', limit: '20' })).json();
  assert.deepEqual(delta.messages.map(m => m.ts), Array.from({length:20}, (_,i)=>9951+i));assert.equal(delta.has_more, true);
  const tail = await read(); assert.equal(tail.length,200);assert.equal(tail.at(-1).text,'9999');
  const measured = await (await call('__bounded',{since:'9950',limit:'20'})).json();assert.ok(measured.reads<=16,'delta reads stay logarithmic plus page chunks');assert.equal(measured.messages.length,20);
  const empty = await (await call('__bounded',{since:'9999',limit:'20'})).json();assert.ok(empty.reads<=16);assert.equal(empty.messages.length,0);
  const participantInfo = await (await call('info')).json();assert.deepEqual(participantInfo.participants,['old']);assert.equal(participantInfo.participant_count,1);
  await seed({ ...full, message_index: {first:17,next:10000}, meta: {...full.meta,message_count:9983} });
  const gap = await call('export', {cursor:'0'});assert.equal(gap.status,410);assert.equal((await gap.json()).code,'history_gap');

  console.log('PASS: KV-backed Unicode migration, history/metadata preservation, dedup, long poll, concurrent writes, locks and non-destructive capacity, bounded delta reads and complete 10,000-message export');
} finally {
  await mf.dispose();
}
