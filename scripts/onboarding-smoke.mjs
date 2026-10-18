import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { AGENT_ONBOARDING } from '../src/onboarding.js';
const base = process.env.BASE || 'https://agentmeet.live';
const fetchChecked = async (path, options = {}) => {
  const r = await fetch(base + path, {
    ...options,
    signal: AbortSignal.timeout(15000),
  });
  assert.ok(r.ok, 'HTTP ' + r.status + ' on ' + path);
  assert.ok(r.headers.get('X-Request-ID'));
  return r;
};
const skill = await readFile('skills/agentmeet/SKILL.md', 'utf8'),
  contract = await readFile('docs/LISTENER.md', 'utf8');
for (const [path, expected] of Object.entries({
  '/quickstart': skill,
  '/instructions': skill,
  '/listener-instructions': contract,
  '/references/listener.md': contract,
  '/project-api': await readFile('docs/PROJECT-API.md', 'utf8'),
})) {
  const response = await fetchChecked(path);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal(
    await response.text(),
    expected,
    'deployed onboarding must equal the released source',
  );
}
const revision = process.env.SKILL_REVISION || 'main';
for (const [path, expected] of Object.entries({
  'agentmeet/SKILL.md': skill,
  'agentmeet/references/listener.md': contract,
})) {
  const response = await fetch(
    'https://raw.githubusercontent.com/agentmeet/skill/' + revision + '/' + path,
    { signal: AbortSignal.timeout(15000) },
  );
  assert.ok(response.ok);
  assert.equal(
    await response.text(),
    expected,
    'published installable skill must match live onboarding',
  );
}
const creation = await fetch(base + '/new', {
  redirect: 'manual',
  signal: AbortSignal.timeout(15000),
});
assert.equal(creation.status, 302);
const legacy = new URL(creation.headers.get('Location'), base).pathname;
const json = await (await fetchChecked(legacy + '?format=json')).json(),
  onboarding = json.agent_onboarding;
assert.deepEqual(json.messages, [], 'new room has no custom opening brief');
assert.equal(onboarding.room_url, base + legacy);
assert.equal(onboarding.protocol, 'legacy-url-capability');
assert.equal(onboarding.listener_instructions_url, base + '/listener-instructions');
assert.deepEqual(
  (await (await fetchChecked(legacy + '/info')).json()).agent_onboarding,
  onboarding,
);
for (const format of ['md', 'plain'])
  assert.ok(
    (await (await fetchChecked(legacy + '?format=' + format)).text()).includes(
      onboarding.listener_instructions_url,
    ),
  );
// Join and post using only metadata fetched from the empty room URL.
const ep = onboarding.endpoints;
const payload = 'URL-only onboarding E2E: **Markdown**, # & + 😀';
const sent = await fetch(ep.post.url, {
  method: ep.post.method,
  headers: { 'Content-Type': ep.post.content_type },
  body: new URLSearchParams({ nick: 'url-only-agent', msg: payload }),
  redirect: 'manual',
  signal: AbortSignal.timeout(15000),
});
assert.equal(sent.status, 302);
const history = await (
  await fetchChecked(new URL(ep.read).pathname + new URL(ep.read).search)
).json();
assert.equal(history.messages[0].text, payload);
const poll = new URL(history.next, ep.read);
poll.searchParams.set('wait', '2');
const waiting = fetch(poll, { signal: AbortSignal.timeout(15000) });
await new Promise((resolve) => setTimeout(resolve, 300));
const peerPost = await fetch(ep.post.url, {
  method: ep.post.method,
  headers: { 'Content-Type': ep.post.content_type },
  body: new URLSearchParams({
    nick: 'url-only-peer',
    msg: 'live onboarding arrival',
  }),
  redirect: 'manual',
  signal: AbortSignal.timeout(15000),
});
assert.equal(peerPost.status, 302);
const delivered = await (await waiting).json();
assert.equal(delivered.messages[0].text, 'live onboarding arrival');
const project = await (
  await fetchChecked('/v2/rooms', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      nick: 'onboarding-smoke',
      title: 'Isolated onboarding E2E',
    }),
  })
).json();
assert.deepEqual(project.agent_onboarding, AGENT_ONBOARDING);
const root = '/v2/rooms/' + project.room.id,
  headers = { Authorization: 'Bearer ' + project.token };
for (const suffix of ['', '/messages', '/inbox'])
  assert.deepEqual(
    (await (await fetchChecked(root + suffix, { headers })).json()).agent_onboarding,
    AGENT_ONBOARDING,
  );
await fetchChecked(root + '/archive', {
  method: 'POST',
  headers: {
    ...headers,
    'Content-Type': 'application/json',
    'Idempotency-Key': crypto.randomUUID(),
  },
  body: JSON.stringify({ reason: 'isolated onboarding E2E complete' }),
});
console.log(
  'PASS production onboarding: release-bundled skill, full contract and API; published skill/reference; empty-room URL-only join, encoded post, catch-up and live arrival; protected discovery and archived isolated project (' +
    project.room.id +
    ', ' +
    legacy +
    ').',
);
