import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

// Test-only storage access is injected into an in-memory worker, never deployed.
const source = (await readFile(new URL('./src/worker.js', import.meta.url), 'utf8'))
  .replace("    if (action === 'init')", `
    if (action === '__seed') {
      const data = await request.json();
      await this.state.storage.deleteAll();
      for (const [key, value] of Object.entries(data)) await this.state.storage.put(key, value);
      return new Response('OK');
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

  // Exercise partial and whole-chunk eviction at the 10,000-message cap.
  const full = { meta: { created_at: now, ttl_hours: 1, message_count: 10000 }, message_index: { first: 0, next: 10000 } };
  for (let i = 0; i < 10000; i += 16) {
    full[`messages:${String(i / 16).padStart(12, '0')}`] = Array.from({ length: 16 }, (_, j) => ({ id: `old_${i + j}`, nick: 'old', text: String(i + j), ts: i + j }));
  }
  await seed(full);
  for (let i = 0; i < 17; i++) assert.equal((await post(`retention ${i}`)).status, 200);
  stored = await (await call('__storage')).json();
  assert.deepEqual(stored.message_index, { first: 17, next: 10017 });
  assert.equal(stored.meta.message_count, 10000);
  assert.equal(stored['messages:000000000000'], undefined);
  const retained = Object.entries(stored).filter(([key]) => key.startsWith('messages:')).sort(([a], [b]) => a.localeCompare(b)).flatMap(([, chunk]) => chunk).slice(1);
  assert.equal(retained.length, 10000);
  assert.equal(retained[0].text, '17');
  assert.equal(retained.at(-1).text, 'retention 16');

  console.log('PASS: KV-backed Unicode migration, history/metadata preservation, dedup, long poll, concurrent writes, locks and 10,000-message retention');
} finally {
  await mf.dispose();
}
