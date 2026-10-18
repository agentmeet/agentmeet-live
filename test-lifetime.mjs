import assert from 'node:assert/strict';
import { Miniflare, convertV4MiniflareOptions, Log, LogLevel } from 'miniflare';
import { workerSource } from './test-source.mjs';
const script = await workerSource({
  project: (source) =>
    source.replace(
      '  async fetch(request) {',
      `  async fetch(request) {
if(new URL(request.url).pathname.endsWith('/__expire')){const meta=this.meta();meta.keep=false;meta.expires_at=Date.now()-1;this.save(meta);return Response.json({ok:true});}
if(new URL(request.url).pathname.endsWith('/__alarm')){await this.alarm();return Response.json({ok:true});}
`,
    ),
});
const mf = new Miniflare(
  convertV4MiniflareOptions({
    modules: true,
    script,
    compatibilityDate: '2024-12-01',
    durableObjects: {
      ROOMS: { className: 'RoomDO', useSQLite: false },
      PROJECT_ROOMS: { className: 'ProjectRoomDO', useSQLite: true },
    },
    log: new Log(LogLevel.NONE),
  }),
);
try {
  const call = async (path, token, method = 'GET', body, key) => {
    const response = await mf.dispatchFetch('http://localhost/v2/rooms' + path, {
      method,
      headers: {
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(key ? { 'Idempotency-Key': key } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, data: await response.json() };
  };
  const created = (await call('', null, 'POST', { nick: 'owner' })).data;
  const root = '/' + created.room.id,
    o = created.token;
  const member = (await call(root + '/participants', o, 'POST', { nick: 'member' })).data;
  let info = (await call(root, o)).data;
  assert.equal(info.lifetime.keep, true);
  assert.equal(info.lifetime.expires_at, null);
  assert.equal((await call(root + '/health')).status, 401);
  assert.equal(
    (
      await call(
        root + '/lifetime',
        member.token,
        'POST',
        { keep: false, ttl_hours: 1 },
        'forbidden-lifetime',
      )
    ).status,
    403,
  );
  assert.equal(
    (await call(root + '/lifetime', o, 'POST', { keep: false, ttl_hours: 0 }, 'invalid-lifetime'))
      .status,
    400,
  );
  let changed = await call(
    root + '/lifetime',
    o,
    'POST',
    { keep: false, ttl_hours: 1 },
    'one-hour-lifetime',
  );
  assert.equal(changed.status, 200);
  assert.equal(changed.data.lifetime.keep, false);
  assert.ok(changed.data.lifetime.expires_at > Date.now() + 3500000);
  const first = await call(
    root + '/messages',
    member.token,
    'POST',
    { text: 'pending owner work' },
    'lifetime-message',
  );
  assert.equal(first.status, 201);
  assert.equal((await call(root + '/health', o)).data.pending_count, 1);
  const ack = {
    message_ids: [first.data.message.id],
    action: 'reviewed retained record',
    outcome: 'handled',
  };
  await call(root + '/ack', o, 'POST', ack, 'lifetime-ack');
  await call(root + '/ack', o, 'POST', ack, 'lifetime-ack-again');
  const health = (await call(root + '/health', o)).data;
  assert.equal(health.pending_count, 0);
  assert.ok(health.last_acknowledged_at);
  assert.equal(health.storage, 'ok');
  assert.equal(health.transport.wake_integration, 'not_enrolled');
  await call(root + '/__alarm', o);
  assert.equal(
    (await call(root, o)).data.lifetime.archived,
    false,
    'early alarm cannot archive renewed room',
  );
  await call(root + '/lifetime', o, 'POST', { keep: true }, 'keep-standing-room');
  await call(root + '/__alarm', o);
  assert.equal(
    (await call(root, o)).data.lifetime.archived,
    false,
    'stale alarm cannot archive kept room',
  );
  assert.equal(
    (
      await call(
        root + '/archive',
        member.token,
        'POST',
        { reason: 'unauthorized' },
        'forbidden-archive',
      )
    ).status,
    403,
  );
  const archived = await call(
    root + '/archive',
    o,
    'POST',
    { reason: 'project complete' },
    'explicit-archive',
  );
  assert.equal(archived.status, 200);
  assert.equal(archived.data.lifetime.archived, true);
  assert.equal(
    (await call(root + '/messages', o, 'POST', { text: 'blocked' }, 'archive-blocked')).status,
    409,
  );
  assert.equal((await call(root + '/export', o)).data.messages.length, 1);
  assert.equal(
    (
      await call(
        root + '/messages',
        member.token,
        'POST',
        { text: 'pending owner work' },
        'lifetime-message',
      )
    ).status,
    200,
    'original idempotent result remains recoverable while archived',
  );
  await call(root + '/unarchive', o, 'POST', { reason: 'resume work' }, 'explicit-unarchive');
  assert.equal(
    (await call(root + '/messages', o, 'POST', { text: 'resumed' }, 'after-unarchive')).status,
    201,
  );
  await call(root + '/__expire', o);
  await call(root + '/__alarm', o);
  assert.equal((await call(root, o)).data.lifetime.archived, true);
  assert.equal(
    (await call(root + '/export', o)).data.messages.length,
    2,
    'expiry preserves all records',
  );
  const audit = (await call(root + '/export?section=coordination', o)).data;
  assert.ok(
    audit.records.some(
      (r) => r.action === 'room.archived' && r.data.reason === 'inactivity_expiry',
    ),
  );
  await call(root + '/unarchive', o, 'POST', { reason: 'owner recovery' }, 'expiry-recovery');
  await call(root + '/lifetime', o, 'POST', { keep: true }, 'keep-after-recovery');
  await call(root + '/__alarm', o);
  assert.equal((await call(root + '/health', o)).data.status, 'ok');
  console.log(
    'PASS: health metadata and bounded pending counters, explicit keep/archive/unarchive, preserved expiry, stale alarm checks, protected permissions and idempotent recovery',
  );
} finally {
  await mf.dispose();
}
