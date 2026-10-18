import assert from 'node:assert/strict';
import { mkdtemp, cp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Miniflare, convertV4MiniflareOptions, Log, LogLevel } from 'miniflare';
import { workerSource } from './test-source.mjs';
const directory = await mkdtemp(join(tmpdir(), 'agentmeet-recovery-'));
const live = join(directory, 'live'),
  backup = join(directory, 'backup');
// Faults/metadata mutations are injected only in this test build.
const script = await workerSource({
  project: (source) =>
    source.replace(
      '  async fetch(request) {',
      `  async fetch(request) {
const url = new URL(request.url);
if(url.pathname.endsWith('/__rollback')){try{this.state.storage.transactionSync(()=>{this.sql.exec("INSERT INTO audit(ts,actor_id,action,json) VALUES(0,'test','rolled-back','{}')");throw Error('injected failure');});}catch{}return Response.json({rows:this.rows("SELECT * FROM audit WHERE action='rolled-back'")});}
if(url.pathname.endsWith('/__audit'))return Response.json(this.rows('SELECT * FROM audit ORDER BY seq'));
`,
    ),
});
let mf;
const start = () =>
  (mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script,
      compatibilityDate: '2024-12-01',
      resourcePersistencePath: live,
      durableObjects: {
        ROOMS: { className: 'RoomDO', useSQLite: false },
        PROJECT_ROOMS: { className: 'ProjectRoomDO', useSQLite: true },
      },
      log: new Log(LogLevel.NONE),
    }),
  ));
const request = async (path, token, method = 'GET', body, key, revision) => {
  const response = await mf.dispatchFetch('http://localhost/v2/rooms' + path, {
    method,
    headers: {
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(key ? { 'Idempotency-Key': key } : {}),
      ...(revision === undefined ? {} : { 'If-Match': '"' + revision + '"' }),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, data: await response.json() };
};
try {
  start();
  const creation = await request('', null, 'POST', { nick: 'recovery-owner' });
  assert.equal(creation.status, 201);
  const root = '/' + creation.data.room.id,
    token = creation.data.token;
  const sent = await request(
    root + '/messages',
    token,
    'POST',
    { text: 'recover this message' },
    'recovery-message',
  );
  assert.equal(sent.status, 201);
  const member = (await request(root + '/participants', token, 'POST', { nick: 'recovery-member' }))
    .data;
  const incoming = (
    await request(
      root + '/messages',
      member.token,
      'POST',
      { text: 'owner please check' },
      'recovery-incoming',
    )
  ).data.message;
  await request(
    root + '/ack',
    token,
    'POST',
    { message_ids: [incoming.id], action: 'checked the evidence', outcome: 'verified' },
    'recovery-ack',
  );
  await request(
    root + '/state/pin',
    token,
    'PUT',
    { value: { sha256: 'a'.repeat(64) } },
    'recovery-state',
    0,
  );
  const coordination = (await request(root + '/export?section=coordination', token)).data;
  const pending = (await request(root + '/inbox', member.token)).data;
  const before = (await request(root + '/export', token)).data;
  assert.deepEqual(
    (await request(root + '/__rollback', token)).data.rows,
    [],
    'SQL transaction rolls back all writes',
  );
  await mf.dispose();
  mf = null;
  assert.ok((await readdir(live)).length > 0, 'state actually exists on disk');
  await cp(live, backup, { recursive: true });
  start();
  const restored = (await request(root + '/export', token)).data;
  assert.deepEqual(restored, before, 'restart preserves all IDs, actors, checksums and metadata');
  const retry = await request(
    root + '/messages',
    token,
    'POST',
    { text: 'recover this message' },
    'recovery-message',
  );
  assert.equal(retry.status, 200);
  assert.equal(retry.data.message.id, sent.data.message.id);
  await request(root + '/messages', token, 'POST', { text: 'after snapshot' }, 'after-snapshot');
  await mf.dispose();
  mf = null;
  await rm(live, { recursive: true });
  await cp(backup, live, { recursive: true });
  start();
  assert.deepEqual(
    (await request(root + '/export', token)).data,
    before,
    'snapshot recovery preserves protected owner and immutable history',
  );
  assert.equal(
    (
      await request(
        root + '/messages',
        token,
        'POST',
        { text: 'recover this message' },
        'recovery-message',
      )
    ).data.message.id,
    sent.data.message.id,
    'snapshot preserves retry records',
  );
  assert.deepEqual(
    (await request(root + '/export?section=coordination', token)).data,
    coordination,
  );
  assert.deepEqual((await request(root + '/inbox', member.token)).data, pending);
  assert.equal((await request(root + '/inbox', token)).data.pending_count, 0);
  assert.equal((await request(root + '/state/pin', token)).data.entry.revision, 1);
  console.log(
    'PASS: SQLite restart, disk snapshot recovery, actor credentials, immutable IDs/checksums, idempotency and interrupted transaction rollback',
  );
} finally {
  if (mf) await mf.dispose();
  await rm(directory, { recursive: true, force: true });
}
