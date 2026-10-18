import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { Miniflare, convertV4MiniflareOptions, Log, LogLevel } from 'miniflare';
import { workerSource } from './test-source.mjs';

const source = (await workerSource()).replace("    if (action === 'init')", `
    if (action === '__seed') {
      await this.state.storage.deleteAll();
      const data = await request.json();
      for (const [key, value] of Object.entries(data)) await this.state.storage.put(key, value);
      return new Response('OK');
    }
    if (action === '__flush') { await this.flushWaiters(); return new Response('OK'); }
    if (action === 'init')`);
const mf = new Miniflare(convertV4MiniflareOptions({
  modules: true, script: source, compatibilityDate: '2024-12-01',
  durableObjects: { ROOMS: { className: 'RoomDO', useSQLite: false } }, log: new Log(LogLevel.NONE),
}));
try {
  const ns = await mf.getDurableObjectNamespace('ROOMS');
  const room = ns.get(ns.idFromName('pag-tst-001'));
  const start = Date.now() - 100000;
  const messages = Array.from({ length: 75 }, (_, i) => ({ id: `msg_${start + i}`, nick: 'reader-test', text: `message ${i}`, ts: start + i }));
  const seed = list => room.fetch('https://room/pag-tst-001?action=__seed', {
    method: 'POST', body: JSON.stringify({ messages: list, meta: { created_at: start, message_count: list.length, ttl_hours: 24 } }),
  });
  await seed(messages);
  const read = async query => (await mf.dispatchFetch(`http://localhost/pag-tst-001?format=json&${query}`)).json();
  const first = await read(`since=${start}&limit=50`);
  assert.deepEqual(first.messages, messages.slice(1, 51));
  assert.equal(first.has_more, true);
  const second = await read(`since=${first.messages.at(-1).ts}&limit=50`);
  assert.deepEqual(second.messages, messages.slice(51));
  assert.equal(second.has_more, false);
  assert.deepEqual((await read(`since=${encodeURIComponent(new Date(messages.at(-1).ts).toISOString())}`)).messages, []);
  assert.equal((await mf.dispatchFetch('http://localhost/pag-tst-001?since=bad')).status, 400);
  assert.equal((await mf.dispatchFetch('http://localhost/pag-tst-001?since=2026-02-30T00:00:00Z')).status, 400);
  assert.equal((await mf.dispatchFetch('http://localhost/pag-tst-001?limit=-1')).status, 400);
  const offset = new Date(messages.at(-1).ts).toISOString().replace('Z', '+00:00');
  const offsetRead = await read(`since=${encodeURIComponent(offset)}&limit=2`);
  assert.deepEqual(offsetRead.messages, []);
  assert.equal(new URL(offsetRead.next, 'http://localhost').searchParams.get('since'), offset);
  assert.equal(new URL(offsetRead.next, 'http://localhost').searchParams.get('limit'), '2');
  await seed([messages[0]]);
  const pending = read(`since=${start}&limit=2&wait=5`);
  await new Promise(resolve => setTimeout(resolve, 100));
  await seed(messages);
  await room.fetch('https://room/pag-tst-001?action=__flush');
  const flushed = await pending;
  assert.deepEqual(flushed.messages, messages.slice(1, 3));
  assert.equal(flushed.has_more, true);

  const valid = 'a'.repeat(1999) + '😀';
  const tooLong = 'a'.repeat(2000) + '😀';
  for (const mode of ['suffix', 'legacy', 'form']) {
    for (const [msg, status] of [[tooLong, 413], [valid, 302]]) {
      const params = new URLSearchParams({ nick: 'unicode', msg });
      const response = await mf.dispatchFetch(`http://localhost/uni-${mode.slice(0, 3)}-001${mode === 'suffix' ? '/post' : ''}${mode === 'form' ? '' : '?' + params}`,
        mode === 'form' ? { method: 'POST', body: params, redirect: 'manual' } : { redirect: 'manual' });
      assert.equal(response.status, status, mode);
    }
  }
  // The largest supported Unicode body must remain below the storage value
  // limit even when all 16 slots in a chunk are occupied.
  for (let i = 0; i < 17; i++) {
    const response = await mf.dispatchFetch('http://localhost/emo-max-001', {
      method: 'POST', body: new URLSearchParams({ nick: 'n'.repeat(29) + i, msg: '😀'.repeat(2000) }), redirect: 'manual',
    });
    assert.equal(response.status, 302);
  }
  const emoji = await (await mf.dispatchFetch('http://localhost/emo-max-001?format=json&limit=200')).json();
  assert.equal(emoji.message_count, 17);
  assert.ok(emoji.messages.every(message => message.text === '😀'.repeat(2000)));
} finally { await mf.dispose(); }

const failing = createServer((req, res) => {
  if (req.url.startsWith('/new')) { res.writeHead(302, { Location: '/bad-srv-001' }); res.end(); }
  else { res.writeHead(500); res.end('Failed'); }
});
await new Promise(resolve => failing.listen(0, '127.0.0.1', resolve));
try {
  const child = spawn(process.execPath, ['scripts/smoke.mjs'], {
    env: { ...process.env, BASE: `http://127.0.0.1:${failing.address().port}` }, stdio: 'ignore',
  });
  assert.notEqual(await new Promise(resolve => child.on('exit', resolve)), 0, 'smoke must fail against broken writes');
} finally { await new Promise(resolve => failing.close(resolve)); }
console.log('PASS API: complete delta pages, pending batches, ISO offsets, invalid cursors, Unicode boundaries, maximum-size storage and failing smoke detection');
