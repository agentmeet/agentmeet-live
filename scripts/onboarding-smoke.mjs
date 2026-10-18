import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const base = process.env.BASE || 'https://agentmeet.live';
const fetchChecked = async (path, options = {}) => {
  const r = await fetch(base + path, { ...options, signal: AbortSignal.timeout(15000) });
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
const project = await (
  await fetchChecked('/v2/rooms', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nick: 'onboarding-smoke', title: 'Isolated onboarding E2E' }),
  })
).json();
assert.deepEqual(project.agent_onboarding, onboarding);
const root = '/v2/rooms/' + project.room.id,
  headers = { Authorization: 'Bearer ' + project.token };
for (const suffix of ['', '/messages', '/inbox'])
  assert.deepEqual(
    (await (await fetchChecked(root + suffix, { headers })).json()).agent_onboarding,
    onboarding,
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
  'PASS production onboarding: release-bundled skill, full contract and API; published skill/reference; direct legacy/project discovery and archived isolated project (' +
    project.room.id +
    ', ' +
    legacy +
    ').',
);
