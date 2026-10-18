import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Miniflare, convertV4MiniflareOptions, Log, LogLevel } from 'miniflare';
import { workerSource } from './test-source.mjs';
const mf = new Miniflare(
  convertV4MiniflareOptions({
    modules: true,
    script: await workerSource(),
    compatibilityDate: '2024-12-01',
    durableObjects: {
      ROOMS: { className: 'RoomDO', useSQLite: false },
      PROJECT_ROOMS: { className: 'ProjectRoomDO', useSQLite: true },
    },
    log: new Log(LogLevel.NONE),
  }),
);
try {
  const get = (path) => mf.dispatchFetch('http://localhost' + path);
  const instruction = await readFile('skills/agentmeet/SKILL.md', 'utf8'),
    contract = await readFile('docs/LISTENER.md', 'utf8');
  for (const [path, expected] of Object.entries({
    '/instructions': instruction,
    '/quickstart': instruction,
    '/listener-instructions': contract,
    '/references/listener.md': contract,
    '/project-api': await readFile('docs/PROJECT-API.md', 'utf8'),
  })) {
    const r = await get(path);
    assert.equal(r.status, 200);
    assert.equal(
      await r.text(),
      expected,
      'public onboarding must serve the exact released source',
    );
    assert.ok(r.headers.get('X-Request-ID'));
    assert.equal(r.headers.get('Cache-Control'), 'no-store');
  }
  assert.equal(
    await readFile('skills/agentmeet/references/listener.md', 'utf8'),
    contract,
    'installed skill carries the same full contract',
  );
  assert.ok(
    !instruction.includes('```') && !contract.includes('```'),
    'reception instructions contain no scripts/configuration snippets',
  );
  // Resolve the packaged relative link as it appears in served quickstart text.
  assert.equal(
    await (
      await get(new URL('references/listener.md', 'http://localhost/quickstart').pathname)
    ).text(),
    contract,
  );
  const onboarding = (await (await get('/quickstart')).text()).length;
  assert.ok(onboarding > 0);
  const roomResponse = await mf.dispatchFetch('http://localhost/new', { redirect: 'manual' });
  const legacy = new URL(roomResponse.headers.get('Location'), 'http://localhost').pathname;
  const legacyJSON = await (await get(legacy + '?format=json')).json();
  const expected = legacyJSON.agent_onboarding;
  assert.deepEqual((await (await get(legacy + '/info')).json()).agent_onboarding, expected);
  assert.equal(expected.instructions_url, 'https://agentmeet.live/instructions');
  assert.equal(expected.listener_instructions_url, 'https://agentmeet.live/listener-instructions');
  for (const format of ['md', 'plain'])
    assert.ok(
      (await (await get(legacy + '?format=' + format)).text()).includes(
        expected.listener_instructions_url,
      ),
      'direct room readers discover reception setup',
    );
  const created = await (
    await mf.dispatchFetch('http://localhost/v2/rooms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nick: 'onboarding-owner' }),
    })
  ).json();
  assert.deepEqual(created.agent_onboarding, expected);
  const root = '/v2/rooms/' + created.room.id;
  const invitation = await (
    await mf.dispatchFetch('http://localhost' + root + '/participants', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + created.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ nick: 'onboarding-member' }),
    })
  ).json();
  assert.deepEqual(invitation.agent_onboarding, expected);

  for (const suffix of ['', '/messages', '/inbox']) {
    const r = await mf.dispatchFetch('http://localhost' + root + suffix, {
      headers: { Authorization: 'Bearer ' + created.token },
    });
    assert.equal(r.status, 200);
    assert.deepEqual(
      (await r.json()).agent_onboarding,
      expected,
      'protected room entrypoints advertise identical service-authored onboarding',
    );
  }
  const exported = await (
    await mf.dispatchFetch('http://localhost' + root + '/export', {
      headers: { Authorization: 'Bearer ' + created.token },
    })
  ).json();
  assert.equal(
    exported.agent_onboarding,
    undefined,
    'portable event exports retain their canonical shape',
  );
  console.log(
    'PASS: bundled skill/contract/API, resolvable packaged reference, code-free reception instructions and direct legacy/project discovery without altering export evidence',
  );
} finally {
  await mf.dispose();
}
