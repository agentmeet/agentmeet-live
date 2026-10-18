import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
const base = process.env.BASE || 'https://agentmeet.live';
const call = async (path, token, method = 'GET', body) => {
  const response = await fetch(base + '/v2/rooms' + path, {
    method,
    headers: {
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
      ...(body === undefined
        ? {}
        : { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(40000),
  });
  const result = await response.json();
  assert.ok(
    response.ok,
    JSON.stringify({
      status: response.status,
      code: result.error?.code,
      request_id: result.request_id,
    }),
  );
  return result;
};
const created = await call('', null, 'POST', {
    nick: 'listener-owner',
    title: 'Isolated listener component E2E',
  }),
  root = '/' + created.room.id;
const member = await call(root + '/participants', created.token, 'POST', {
  nick: 'listener-member',
});
const session = 'component-e2e-' + crypto.randomUUID(),
  temp = await mkdtemp(join(tmpdir(), 'agentmeet-listener-')),
  config = join(temp, 'enrollment.json');
await writeFile(
  config,
  JSON.stringify({
    origin: base,
    room: created.room.id,
    actor_id: member.participant.id,
    session_id: session,
    token: member.token,
  }),
  { mode: 0o600 },
);
const command = async (name, input) => {
  const child = execFile(
    'python3',
    ['integrations/agentmeet-listener.py', name, '--config', config],
    { timeout: 5000, maxBuffer: 20000 },
  );
  const output = new Promise((resolve, reject) => {
    let stdout = '',
      stderr = '';
    child.stdout.on('data', (v) => (stdout += v));
    child.stderr.on('data', (v) => (stderr += v));
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0 ? resolve(stdout) : reject(Error('listener command failed: ' + stderr)),
    );
  });
  child.stdin.end(input ? JSON.stringify(input) : '');
  return output;
};
const status = async () => JSON.parse(await command('status'));
const until = async (predicate, seconds = 15) => {
  const end = Date.now() + seconds * 1000;
  while (Date.now() < end) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw Error('listener condition timed out: ' + JSON.stringify(await status()));
};
const hook = (name) => command('hook', { hook_event_name: name, session_id: session });
try {
  assert.equal(await hook('SessionStart'), '');
  await until(
    async () =>
      ['waiting', 'connected'].includes((await status()).phase) && (await status()).running,
  );
  // Exercise a real empty production long-poll timeout and internal re-arm.
  await new Promise((r) => setTimeout(r, 27000));
  assert.equal(await hook('PostToolUse'), '');
  const first = (
    await call(root + '/messages', created.token, 'POST', {
      text: 'targeted delivery after an empty timeout',
      to: [member.participant.id],
    })
  ).message;
  await until(async () => (await status()).queued_notifications === 1);
  assert.ok((await hook('PostToolUse')).includes(first.id));
  assert.equal((await call(root + '/inbox', member.token)).pending_count, 1);
  const second = (
    await call(root + '/messages', created.token, 'POST', {
      text: 'automatic re-arm after first delivery',
      to: [member.participant.id],
    })
  ).message;
  await until(async () => (await status()).queued_notifications === 1);
  const stop = JSON.parse(await hook('Stop'));
  assert.equal(stop.decision, 'block');
  assert.ok(stop.reason.includes(second.id));
  assert.equal((await call(root + '/inbox', member.token)).pending_count, 2);
  assert.equal(
    JSON.parse(await hook('Stop')).decision,
    undefined,
    'no-work Stop allows completion',
  );
  await call(
    root + '/participants/' + member.participant.id + '/revoke',
    created.token,
    'POST',
    {},
  );
  await until(
    async () => (await status()).phase === 'credential_rejected' && !(await status()).running,
    35,
  );
  await call(root + '/archive', created.token, 'POST', {
    reason: 'isolated listener component E2E complete',
  });
  console.log(
    'PASS listener production component: empty timeout stays quiet, automatic re-arm before/after real messages, hook ID handoff, Stop continuation only for queued work, explicit pending delivery and revocation (' +
      created.room.id +
      '). No idle model turn was started.',
  );
} finally {
  await command('stop').catch(() => {});
  const health = await status().catch(() => ({}));
  if (health.running && health.pid) {
    try {
      process.kill(health.pid, 'SIGTERM');
    } catch {}
  }
  await rm(temp, { recursive: true, force: true });
}
