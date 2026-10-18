import assert from 'node:assert/strict';
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
  const call = async (path, token, method = 'GET', body, key, revision) => {
    const response = await mf.dispatchFetch('http://localhost/v2/rooms' + path, {
      method,
      headers: {
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(key ? { 'Idempotency-Key': key } : {}),
        ...(revision === undefined ? {} : { 'If-Match': '"' + revision + '"' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, data: await response.json() };
  };
  const c = (await call('', null, 'POST', { nick: 'owner' })).data,
    root = '/' + c.room.id,
    o = c.token;
  const invite = async (nick, role) =>
    (await call(root + '/participants', o, 'POST', { nick, ...(role ? { role } : {}) })).data;
  const producer = await invite('producer'),
    consumer = await invite('consumer'),
    guest = await invite('reader', 'guest');
  const post = (actor, kind, data, text = '', reply_to, to, key = crypto.randomUUID()) =>
    call(
      root + '/messages',
      actor.token,
      'POST',
      { kind, data, text, ...(reply_to ? { reply_to } : {}), ...(to ? { to } : {}) },
      key,
    );
  const request = await post(
    consumer,
    'agentmeet.request',
    { subject: 'Girpilis package', acceptance: '21 hashes checked' },
    'Please deliver',
    null,
    [producer.participant.id],
  );
  assert.equal(request.status, 201, JSON.stringify(request));
  const rid = request.data.message.id;
  const material = await post(
    producer,
    'agentmeet.material',
    {
      settlement_id: 'Girpilis',
      version: '1',
      manifest_sha256: 'a'.repeat(64),
      maps: Array.from({ length: 21 }, (_, i) => ({ name: 'map' + i, sha256: 'b'.repeat(64) })),
      reference_photo_ids: ['ref1'],
      checks: ['producer checks passed'],
      known_gaps: ['consumer verification pending'],
    },
    'Ready for consumer checks',
    rid,
  );
  assert.equal(material.status, 201);
  const transition = (actor, state, revision, key) =>
    call(
      root + '/requests/' + rid + '/transition',
      actor.token,
      'POST',
      { state, reason: 'linked evidence checked', evidence_ids: [material.data.message.id] },
      key,
      revision,
    );
  assert.equal((await transition(producer, 'verified', 1, 'producer-not-consumer')).status, 403);
  assert.equal((await transition(producer, 'delivered', 1, 'producer-delivered')).status, 200);
  assert.equal((await transition(consumer, 'verified', 1, 'consumer-stale')).status, 412);
  assert.equal((await transition(consumer, 'verified', 2, 'consumer-verified')).status, 200);
  assert.equal(
    (await call(root + '/inbox', consumer.token)).data.pending_count,
    1,
    'verification transition never acknowledges delivery implicitly',
  );
  assert.equal((await call(root + '/requests?state=verified', o)).data.requests.length, 1);
  const thread = (await call(root + '/threads/' + material.data.message.id, o)).data;
  assert.equal(thread.root.id, rid);
  assert.equal(thread.messages.length, 2);
  assert.equal(thread.request.state, 'verified');
  const pinData = {
    name: 'materials',
    version: '1',
    sha256: 'c'.repeat(64),
    url: 'https://example.com/manifest.json',
  };
  const pin1 = await post(producer, 'agentmeet.pin', pinData);
  assert.equal(pin1.status, 201);
  const pin2 = await post(producer, 'agentmeet.pin', {
    ...pinData,
    version: '2',
    sha256: 'd'.repeat(64),
  });
  assert.equal(pin2.status, 201);
  assert.equal((await call(root + '/pins', o)).data.pins[0].message_id, pin2.data.message.id);
  assert.equal(
    (await post(producer, 'agentmeet.pin', { ...pinData, sha256: 'invalid' })).status,
    400,
  );
  assert.equal(
    (
      await post(
        producer,
        'agentmeet.message.edit',
        { target_id: pin1.data.message.id, text: 'replace hash', reason: 'changed' },
        '',
        pin1.data.message.id,
      )
    ).status,
    409,
  );
  const before = (await call(root, o)).data.room.event_count;
  assert.equal(
    (
      await call(
        root + '/roles/publication',
        producer.token,
        'PUT',
        { actor_id: producer.participant.id, description: 'publish' },
        'forbidden-role',
        0,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await call(
        root + '/roles/publication',
        o,
        'PUT',
        { actor_id: producer.participant.id, description: 'coordinates publication' },
        'owner-role',
        0,
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await call(
        root + '/state/role:forged',
        producer.token,
        'PUT',
        { value: { actor_id: producer.participant.id } },
        'bypass-role',
        0,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await call(
        root + '/status',
        producer.token,
        'PUT',
        { text: 'suite running', eta: Date.now() + 60000, expires_at: Date.now() + 120000 },
        'producer-status',
        0,
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await call(
        root + '/state/status:' + producer.participant.id,
        o,
        'PUT',
        { value: 'impersonate' },
        'owner-forged-status',
        1,
      )
    ).status,
    403,
  );
  assert.equal((await call(root + '/status', o)).data.entries[0].value.text, 'suite running');
  assert.equal(
    (await call(root, o)).data.room.event_count,
    before,
    'roles/status do not spam the conversation',
  );
  const decisionData = {
    action: 'Select material integration plan',
    scope: 'Girpilis package v2',
    options: [
      { id: 'a', label: 'Plan A' },
      { id: 'b', label: 'Plan B' },
    ],
    recommended: 'b',
    expires_at: Date.now() + 60000,
  };
  const decision = await post(
    consumer,
    'agentmeet.decision.request',
    decisionData,
    'Owner choice required',
    null,
    [c.participant.id],
  );
  assert.equal(decision.status, 201);
  const selection = { request_id: decision.data.message.id, option_id: 'b' };
  assert.equal(
    (await post(producer, 'agentmeet.decision.selected', selection, '', decision.data.message.id))
      .status,
    403,
  );
  const selected = await post(
    { token: o },
    'agentmeet.decision.selected',
    selection,
    '',
    decision.data.message.id,
    undefined,
    'owner-selected',
  );
  assert.equal(selected.status, 201);
  assert.equal(
    (
      await post(
        { token: o },
        'agentmeet.decision.selected',
        selection,
        '',
        decision.data.message.id,
        undefined,
        'owner-selected',
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await post(
        { token: o },
        'agentmeet.decision.selected',
        { ...selection, option_id: 'a' },
        '',
        decision.data.message.id,
      )
    ).status,
    409,
  );
  assert.equal(
    (await call(root + '/decisions', o)).data.decisions[0].selected.actor.id,
    c.participant.id,
  );
  assert.equal((await post({ token: o }, 'agentmeet.decision.selected', {})).status, 400);
  const original = await post(producer, 'message', null, 'Girpilis count six');
  const target = original.data.message.id;
  assert.equal(
    (
      await post(
        { token: o },
        'agentmeet.message.edit',
        { target_id: target, text: 'owner spoof', reason: 'bad' },
        '',
        target,
      )
    ).status,
    403,
  );
  const edited = await post(
    producer,
    'agentmeet.message.edit',
    { target_id: target, text: 'Girpilis count five', reason: 'corrected count' },
    '',
    target,
  );
  assert.equal(edited.status, 201);
  assert.equal(
    (await call(root + '/messages/' + target + '/revisions', o)).data.revisions.length,
    1,
  );
  assert.equal(
    (await call(root + '/messages/' + target, o)).data.message.text,
    'Girpilis count six',
    'original remains immutable',
  );
  const retracted = await post(
    producer,
    'agentmeet.message.retract',
    { target_id: target, reason: 'superseded' },
    '',
    target,
  );
  assert.equal(retracted.status, 201);
  assert.equal(
    (await call(root + '/messages/' + target + '/revisions', o)).data.revisions.length,
    2,
  );
  const pending = (await call(root + '/inbox', consumer.token)).data.pending_count;
  assert.equal(
    (await call(root + '/seen', guest.token, 'POST', { message_ids: [target] }, 'guest-seen'))
      .status,
    200,
  );
  assert.equal(
    (await call(root + '/messages/' + target + '/receipts', o)).data.receipts[0].actor_id,
    guest.participant.id,
  );
  assert.equal(
    (await call(root + '/inbox', consumer.token)).data.pending_count,
    pending,
    'seen receipt does not acknowledge',
  );
  assert.ok((await call(root + '/search?q=Girpilis', o)).data.messages.length >= 4);
  for (const q of ['" OR *', 'NEAR(x)', '-', '"'])
    assert.equal(
      (await call(root + '/search?q=' + encodeURIComponent(q), o)).status,
      200,
      'search syntax is literal data',
    );
  const digest = (await call(root + '/digest', consumer.token)).data;
  assert.equal(digest.method, 'deterministic_navigation');
  assert.equal(digest.open_requests.length, 0);
  assert.ok(digest.unread.every((m) => m.evidence.includes('/project?room=')));
  assert.equal(digest.latest_pins[0].version, '2');
  const latest = (await call(root + '/messages?tail=true&limit=2', o)).data;
  assert.equal(latest.messages.length, 2);
  assert.equal(latest.has_older, true);
  assert.equal(latest.has_more, false);
  assert.deepEqual(
    latest.messages.map((m) => m.id),
    [edited.data.message.id, retracted.data.message.id],
  );
  const previous = (
    await call(root + '/messages?before=' + encodeURIComponent(latest.older_cursor) + '&limit=2', o)
  ).data;
  assert.ok(previous.messages.every((m) => m.seq < latest.messages[0].seq));
  assert.equal((await call(root + '/messages/' + target, o)).data.current.retracted, true);
  assert.equal(
    (await call(root + '/pins?name=materials', o)).data.pins.length,
    2,
    'pin history retains superseded versions',
  );
  assert.equal((await call(root + '/requests/' + rid + '/history', o)).data.entries.length, 3);
  const exported = (await call(root + '/export', o)).data;
  assert.ok(exported.messages.some((m) => m.id === target && m.text === 'Girpilis count six'));
  assert.ok(exported.messages.some((m) => m.id === edited.data.message.id));
  console.log(
    'PASS: typed material/pins, consumer-verified request lifecycle and threads, scoped roles/status, owner-only immutable decisions, audited edits/retractions, independent seen receipts, search and evidence-linked digest',
  );
} finally {
  await mf.dispose();
}
