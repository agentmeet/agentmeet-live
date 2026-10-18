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
  const call = async (path, token, method = 'GET', body) => {
    const r = await mf.dispatchFetch('http://localhost/v2/rooms' + path, {
      method,
      headers: {
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
        ...(body
          ? { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() }
          : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: r.status, ...(await r.json()) };
  };
  const room = await call('', null, 'POST', { nick: 'owner' }),
    root = '/' + room.room.id;
  const a = await call(root + '/participants', room.token, 'POST', { nick: 'a' }),
    b = await call(root + '/participants', room.token, 'POST', { nick: 'b' });
  let finished = false;
  const wait = call(root + '/inbox?wait=2', a.token).then((r) => {
    finished = true;
    return r;
  });
  await new Promise((r) => setTimeout(r, 100));
  await call(root + '/messages', room.token, 'POST', { text: 'unrelated', to: [b.participant.id] });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(finished, false, 'unrelated targeted traffic does not complete the wait');
  const message = (
    await call(root + '/messages', room.token, 'POST', { text: 'for a', to: [a.participant.id] })
  ).message;
  const received = await wait;
  assert.equal(received.status, 200);
  assert.equal(received.messages[0].id, message.id);
  assert.equal(
    (await call(root + '/inbox', a.token)).pending_count,
    1,
    'notification leaves work pending',
  );
  const query = '/inbox?wait=1&cursor=' + encodeURIComponent(received.next_cursor);
  const waits = [call(root + query, a.token), call(root + query, a.token)];
  await new Promise((r) => setTimeout(r, 100));
  assert.equal((await call(root + query, a.token)).status, 429);
  for (const response of await Promise.all(waits)) {
    assert.equal(response.timed_out, true);
    assert.deepEqual(response.messages, []);
  }
  assert.equal((await call(root + '/inbox?wait=26', a.token)).status, 400);
  const revoked = call(
    root + '/inbox?wait=2&cursor=' + encodeURIComponent(received.next_cursor),
    a.token,
  );
  await new Promise((r) => setTimeout(r, 100));
  await call(root + '/participants/' + a.participant.id + '/revoke', room.token, 'POST', {});
  assert.equal(
    (await revoked).status,
    401,
    'revocation is rechecked before a sleeping request returns',
  );
  console.log(
    'PASS: inbox waits wake only for relevant pending events, never ack, time out quietly, bound concurrency and recheck revocation',
  );
} finally {
  await mf.dispose();
}
