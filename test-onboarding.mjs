import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Miniflare, convertV4MiniflareOptions, Log, LogLevel } from 'miniflare';
import { workerSource } from './test-source.mjs';
import { AGENT_ONBOARDING } from './src/onboarding.js';
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
  const roomResponse = await mf.dispatchFetch('http://localhost/new', {
    redirect: 'manual',
  });
  const legacy = new URL(roomResponse.headers.get('Location'), 'http://localhost')
    .pathname;
  const legacyJSON = await (await get(legacy + '?format=json')).json();
  assert.deepEqual(legacyJSON.messages, [], 'no opening brief or participant posts');
  const expected = legacyJSON.agent_onboarding;
  assert.equal(expected.protocol, 'legacy-url-capability');
  assert.equal(expected.authorization.source, 'template_only_not_authorization');
  assert.ok(expected.authorization.owner_invitation.includes('I approve you to use AgentMeet at http://localhost' + legacy));
  assert.ok(expected.authorization.owner_invitation.includes('existing permissions'));
  assert.ok(!expected.authorization.guidance.includes('mock'));
  const human = await (await get(legacy + '/human')).text();
  assert.ok(human.includes('Copy agent invitation'));
  assert.ok(human.includes('Owner invitation'));
  assert.ok(human.includes('I approve you to use AgentMeet at http://localhost' + legacy));
  assert.equal(expected.room_url, 'http://localhost' + legacy);
  assert.equal(expected.endpoints.post.method, 'POST');
  assert.equal(expected.endpoints.post.fields.nick, 'your chosen nick');
  assert.equal(expected.limits.message_unicode_code_points, 2000);
  assert.ok(expected.instructions.some((step) => step.includes('timestamp tie')));
  assert.deepEqual(
    (await (await get(legacy + '/info')).json()).agent_onboarding,
    expected,
  );
  assert.equal(expected.instructions_url, 'https://agentmeet.live/instructions');
  assert.equal(
    expected.listener_instructions_url,
    'https://agentmeet.live/listener-instructions',
  );
  for (const format of ['md', 'plain'])
    assert.ok(
      (await (await get(legacy + '?format=' + format)).text()).includes(
        expected.listener_instructions_url,
      ),
      'direct room readers discover reception setup',
    );
  // Bootstrap using only the room's service-authored metadata, never a seed post.
  const ep = expected.endpoints;
  const payload = 'URL-only **join** # & + 😀';
  const sent = await mf.dispatchFetch(ep.post.url, {
    method: ep.post.method,
    headers: { 'Content-Type': ep.post.content_type },
    body: new URLSearchParams({
      nick: 'bootstrap-agent',
      msg: payload,
    }).toString(),
    redirect: 'manual',
  });
  assert.equal(sent.status, 302);
  const history = await (await mf.dispatchFetch(ep.read)).json();
  assert.equal(history.messages.length, 1);
  assert.equal(history.messages[0].text, payload);
  const poll = new URL(history.next, ep.read);
  poll.searchParams.set('wait', '1');
  const waiting = mf.dispatchFetch(poll);
  await new Promise((resolve) => setTimeout(resolve, 100));
  await mf.dispatchFetch(ep.post.url, {
    method: ep.post.method,
    headers: { 'Content-Type': ep.post.content_type },
    body: new URLSearchParams({
      nick: 'peer',
      msg: 'second arrival',
    }).toString(),
    redirect: 'manual',
  });
  const arrival = await (await waiting).json();
  assert.equal(arrival.messages[0].text, 'second arrival');
  const lockURL = new URL(legacy + '/lock', ep.read);
  lockURL.searchParams.set('secret', 'onboarding-test-secret');
  assert.equal((await mf.dispatchFetch(lockURL)).status, 200);
  const archive = await (await mf.dispatchFetch(ep.read)).json();
  assert.equal(archive.agent_onboarding.endpoints.post, null);
  assert.equal(archive.agent_onboarding.lifetime.locked, true);
  assert.ok(archive.agent_onboarding.authorization.owner_invitation.includes('read-only'));
  assert.ok(!archive.agent_onboarding.authorization.owner_invitation.includes('post and receive'));
  assert.deepEqual(
    (await (await mf.dispatchFetch(ep.info)).json()).agent_onboarding,
    archive.agent_onboarding,
  );
  assert.ok(!(await (await get(legacy)).text()).includes('Compatibility GET write:'));
  const created = await (
    await mf.dispatchFetch('http://localhost/v2/rooms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nick: 'onboarding-owner' }),
    })
  ).json();
  assert.deepEqual(created.agent_onboarding, AGENT_ONBOARDING);
  const root = '/v2/rooms/' + created.room.id;
  const invitation = await (
    await mf.dispatchFetch('http://localhost' + root + '/participants', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + created.token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ nick: 'onboarding-member' }),
    })
  ).json();
  assert.deepEqual(invitation.agent_onboarding, AGENT_ONBOARDING);

  for (const suffix of ['', '/messages', '/inbox']) {
    const r = await mf.dispatchFetch('http://localhost' + root + suffix, {
      headers: { Authorization: 'Bearer ' + created.token },
    });
    assert.equal(r.status, 200);
    assert.deepEqual(
      (await r.json()).agent_onboarding,
      AGENT_ONBOARDING,
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
    'PASS: bundled skill/contract/API, resolvable packaged reference, code-free reception instructions and empty-room URL-only bootstrap, encoded form post, catch-up, live arrival, read-only archive and protected discovery without altering export evidence',
  );
} finally {
  await mf.dispose();
}
