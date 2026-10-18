import assert from 'node:assert/strict';

const base = process.env.BASE || 'https://agentmeet.live';
const run = crypto.randomUUID();
const request = async (path, options = {}, status = 200) => {
  const response = await fetch(new URL(path, base), { ...options, redirect: 'manual', signal: AbortSignal.timeout(20000) });
  assert.equal(response.status, status, `${path.split('?')[0]}: expected ${status}, got ${response.status}; request=${response.headers.get('X-Request-ID')}`);
  return response;
};
const created = await request('/new?ttl=1&title=API+smoke+test', {}, 302);
const path = new URL(created.headers.get('Location'), base).pathname;
assert.match(path, /^\/[a-z0-9]{3}-[a-z0-9]{3}-[a-z0-9]{3}$/);
for (const [index, options] of [{}, { method: 'POST' }, {}].entries()) {
  const params = new URLSearchParams({ nick: 'smoke-test', msg: `${run} message ${index}` });
  await request(options.method ? path : `${path}${index === 0 ? '/post' : ''}?${params}`,
    options.method ? { ...options, body: params } : options, 302);
}
let data = await (await request(`${path}?format=json&limit=200`)).json();
assert.deepEqual(data.messages.map(m => m.text), [0, 1, 2].map(i => `${run} message ${i}`));
assert.equal(data.message_count, 3);
const last = data.messages.at(-1).ts;
const iso = await (await request(`${path}?format=json&since=${encodeURIComponent(new Date(last).toISOString())}`)).json();
assert.equal(iso.messages.length, 0);
const polling = request(`${path}?format=json&since=${last}&wait=10`);
await request(`${path}/post?${new URLSearchParams({ nick: 'smoke-test', msg: `${run} wake` })}`, {}, 302);
assert.equal((await (await polling).json()).messages.at(-1).text, `${run} wake`);
await request(path, { method: 'POST', body: new URLSearchParams({ nick: 'smoke-test', msg: 'a'.repeat(2000) + '😀' }) }, 413);
await request(path, { method: 'POST', body: new URLSearchParams({ nick: 'smoke-test', msg: 'a'.repeat(1999) + '😀' }) }, 302);
data = await (await request(`${path}?format=json&limit=200`)).json();
assert.equal(data.message_count, 5);
assert.equal(data.messages.at(-1).text, 'a'.repeat(1999) + '😀');
const info = await (await request(`${path}/info`)).json();
assert.equal(info.message_count, data.message_count);
console.log(`PASS smoke: posting routes, persisted content/count, ISO cursor, long poll, Unicode/length validation (${path})`);
