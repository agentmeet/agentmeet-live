import assert from 'node:assert/strict';
import { workerSource } from './test-source.mjs';

// Exercise real handlers with controlled storage/network faults and inspect the
// structured console arguments directly. Storage behavior is covered separately
// by test-storage.mjs on Cloudflare's runtime.
const source = await workerSource({ worker: source => source + '\nexport { errorDetails, instructionsCache };' });
const { default: worker, RoomDO, errorDetails, instructionsCache } = await import(
  `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
);
class Storage {
  values = new Map();
  failGet = false;
  failTransaction = false;
  async get(key) {
    if (this.failGet) throw new Error('Storage unavailable PRIVATE_ERROR_TEXT');
    return structuredClone(this.values.get(key));
  }
  async put(key, value) {
    if (typeof key === 'object') { for (const [name, item] of Object.entries(key)) this.values.set(name, structuredClone(item)); }
    else this.values.set(key, structuredClone(value));
  }
  async delete(key) { return this.values.delete(key); }
  async deleteAll() { this.values.clear(); }
  async setAlarm(value) { this.alarm = value; }
  async deleteAlarm() { this.alarm = null; }
  async list({ prefix }) {
    return new Map([...this.values].filter(([key]) => key.startsWith(prefix)).sort()
      .map(([key, value]) => [key, structuredClone(value)]));
  }
  async transaction(fn) {
    if (this.failTransaction) throw new RangeError('Values cannot be larger than 131072 bytes. PRIVATE_ERROR_TEXT');
    const before = structuredClone(this.values);
    try { return await fn(this); } catch (error) { this.values = before; throw error; }
  }
}
const rooms = new Map();
const env = { ROOMS: {
  idFromName: code => code,
  get(code) {
    if (!rooms.has(code)) rooms.set(code, new RoomDO({
      storage: new Storage(), id: { toString: () => String(rooms.size).padStart(64, '0') },
    }));
    return rooms.get(code);
  },
} };
const tasks = [];
const ctx = { waitUntil: task => tasks.push(task) };
const call = (path, options) => worker.fetch(new Request(`https://example.test${path}`, options), env, ctx);
const logs = [];
const original = { info: console.info, warn: console.warn, error: console.error, fetch: globalThis.fetch };
for (const level of ['info', 'warn', 'error']) console[level] = value => logs.push({ level, ...structuredClone(value) });

try {
  const path = '/log-tst-001';
  const privateParams = new URLSearchParams({ nick: 'PRIVATE_NICK', msg: 'PRIVATE_MESSAGE' });
  let response = await call(`${path}/post?${privateParams}`);
  assert.equal(response.status, 302);
  const requestId = response.headers.get('X-Request-ID');
  assert.match(requestId, /^[a-f0-9-]{36}$/);
  assert.equal(response.headers.get('Access-Control-Expose-Headers'), 'X-Request-ID');
  assert.ok(logs.some(log => log.event === 'room.message_posted' && log.request_id === requestId && log.message_count === 1));
  assert.ok(logs.some(log => log.event === 'request.completed' && log.request_id === requestId));

  const count = logs.length;
  await call(`${path}?format=json`);
  await call(`${path}/info`);
  assert.equal(logs.length, count, 'routine reads stay quiet');
  await call(`${path}/post?${privateParams}`);
  assert.ok(logs.some(log => log.event === 'room.message_deduplicated'));
  await call(`${path}/rename?title=PRIVATE_TITLE`);
  await call(`${path}/lock?secret=PRIVATE_SECRET`);
  assert.equal((await call(`${path}/post?${privateParams}`)).status, 403);
  await call(`${path}/unlock?secret=PRIVATE_SECRET`);
  assert.ok(logs.some(log => log.event === 'room.lock'));
  assert.ok(logs.some(log => log.event === 'room.unlock'));

  const room = rooms.get('log-tst-001');
  room.state.storage.failTransaction = true;
  response = await call(`${path}/post?nick=PRIVATE_NICK&msg=PRIVATE_FAILED_MESSAGE`);
  assert.equal(response.status, 500, 'internal failure must not become a 302');
  const failureId = response.headers.get('X-Request-ID');
  assert.ok((await response.text()).includes(failureId));
  assert.ok(logs.some(log => log.event === 'room.operation_failed' && log.request_id === failureId && log.error_code === 'storage_value_limit'));
  assert.ok(logs.some(log => log.event === 'request.failed' && log.request_id === failureId));
  room.state.storage.failTransaction = false;

  const last = (await (await call(`${path}?format=json`)).json()).messages.at(-1).ts;
  const polling = call(`${path}?format=json&since=${last}&wait=5`);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(room.waiters.length, 1);
  room.state.storage.failGet = true;
  await room.flushWaiters();
  assert.equal((await polling).status, 500, 'failed background flush is not an empty successful poll');
  assert.ok(logs.some(log => log.event === 'room.waiter_flush_failed' && log.waiter_count === 1));
  await assert.rejects(room.alarm(), /Room expiration failed/);
  assert.ok(logs.some(log => log.event === 'room.expiration_failed' && log.error_code === 'storage_failure'));
  room.state.storage.failGet = false;

  globalThis.fetch = async () => new Response('PRIVATE_UPSTREAM_BODY', { status: 503 });
  assert.equal((await call('/instructions')).status, 502);
  assert.ok(logs.some(log => log.event === 'instructions.fetch_failed' && log.upstream_status === 503));
  globalThis.fetch = async () => new Response('instructions');
  await call('/instructions');
  instructionsCache.fetchedAt = 0;
  globalThis.fetch = async () => { throw new Error('PRIVATE_UPSTREAM_ERROR'); };
  assert.equal((await call('/instructions')).status, 200, 'stale instructions remain available');
  await Promise.all(tasks);
  assert.ok(logs.some(log => log.event === 'instructions.refresh_failed'));
  assert.equal(instructionsCache.revalidating, false);

  response = await call('/uni-cod-001/post?' + new URLSearchParams({ nick: 'PRIVATE_NICK', msg: 'a'.repeat(2000) + '😀' }));
  assert.equal(response.status, 413);
  assert.ok(logs.some(log => log.event === 'request.rejected' && log.status === 413));
  for (let i = 0; i < 31; i++) response = await call('/rat-lim-001/post', { headers: { 'cf-connecting-ip': 'PRIVATE_IP' } });
  assert.equal(response.status, 429);
  assert.ok(logs.some(log => log.event === 'request.rejected' && log.status === 429));

  const diagnostic = errorDetails({ name: 'PRIVATE_ERROR_NAME', message: 'PRIVATE_ERROR_TEXT',
    stack: 'Error: PRIVATE_ERROR_TEXT\n    at functionName (worker.js:12:34)\n    at PRIVATE_STACK_LINE' });
  assert.deepEqual(diagnostic.error_frames, ['worker.js:12:34']);
  logs.push(diagnostic);
  const serialized = JSON.stringify(logs);
  for (const value of ['PRIVATE_', 'log-tst-001', 'uni-cod-001', 'rat-lim-001', 'example.test', 'https://', '?nick=']) {
    assert.equal(serialized.includes(value), false, `logs must not contain ${value}`);
  }
} finally {
  Object.assign(console, { info: original.info, warn: original.warn, error: original.error });
  globalThis.fetch = original.fetch;
}
console.log('PASS: correlated events, redaction, quiet reads, rate limits, storage failures, failed polls, alarm retries and upstream refresh faults');
