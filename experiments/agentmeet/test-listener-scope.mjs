// Client-state acceptance checks against a real room. No mock server or model-wake claim.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const script = resolve(process.argv[2] || 'experiments/claude-desktop/listener.mjs');
const room = process.env.AGENTMEET_TEST_ROOM || 'l1i-6ll-vq4';
const directory = await mkdtemp(join(tmpdir(), 'agentmeet-scope-'));
const children = new Set();
const pause = ms => new Promise(r => setTimeout(r, ms));
function start(command, state, session, extra = []) {
  const child = spawn(process.execPath, [script, command, '--room', room, '--nick', 'scope_acceptance', '--session', session, '--state', state, ...extra], { stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child);
  const result = { child, out: '', err: '', ended: false, code: null };
  child.stdout.on('data', b => { result.out = (result.out + b).slice(-65536); });
  child.stderr.on('data', b => { result.err = (result.err + b).slice(-8192); });
  result.done = new Promise((r, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => { result.ended = true; result.code = code; result.signal = signal; children.delete(child); r(result); });
  });
  return result;
}
async function finish(result, limit = 4000) {
  const value = await Promise.race([result.done, pause(limit).then(() => null)]);
  if (!value) { result.child.kill('SIGTERM'); await result.done; throw Error('CLI operation did not complete within its test deadline'); }
  return value;
}
async function exists(path) { try { await access(path); return true; } catch { return false; } }
async function until(predicate, limit = 8000) {
  const end = Date.now() + limit;
  do { if (await predicate()) return; await pause(50); } while (Date.now() < end);
  throw Error('Real-room client did not reach the required state within test deadline');
}
try {
  const invalidState = join(directory, 'invalid-input');
  for (const [command, extra] of [
    ['show', ['msg_../../escape']], ['receipt', ['msg_../../escape']],
    ['run', ['--wait', '0']], ['run', ['--since', '-1']],
    ['run', ['--mode', 'invalid']], ['unknown', []],
  ]) {
    assert.equal((await finish(start(command, invalidState, 'scope-input-check', extra))).code, 64);
    assert.ok(!await exists(invalidState), 'invalid input must fail before creating state');
  }
  console.log('PASS: invalid IDs, waits, cursors, modes and commands fail without touching state');
  const state = join(directory, 'owner');
  const owner = start('run', state, 'scope-session-owner', ['--mode', 'stream', '--wait', '10']);
  await until(async () => {
    if (owner.ended) throw Error('Owner exited before receiving live room history');
    try { return (await readdir(join(state, 'inbox'))).some(f => f.endsWith('.json')); } catch { return false; }
  });
  const id = (await readdir(join(state, 'inbox'))).find(f => f.endsWith('.json')).slice(0, -5);
  for (const command of ['status', 'show', 'receipt', 'unsubscribe', 'resubscribe']) {
    const wrong = await finish(start(command, state, 'scope-session-foreign', command === 'show' || command === 'receipt' ? [id] : []));
    assert.equal(wrong.code, 5, `${command}: another session must be rejected before touching state`);
    assert.ok(!await exists(join(state, 'disabled')), `${command}: must not disable another session`);
    assert.ok(!await exists(join(state, 'received', id + '.json')), `${command}: must not acknowledge another session's delivery`);
    assert.ok(!owner.ended, `${command}: must not stop the live owner`);
  }
  console.log('PASS: every wrong-session control command is refused without side effects');
  const receipt = await finish(start('receipt', state, 'scope-session-owner', [id]));
  assert.equal(receipt.code, 0);
  assert.ok(await exists(join(state, 'received', id + '.json')));
  const stopped = await finish(start('unsubscribe', state, 'scope-session-owner'));
  assert.equal(stopped.code, 0);
  await finish(owner);
  const foreignEnable = await finish(start('resubscribe', state, 'scope-session-foreign'));
  assert.equal(foreignEnable.code, 5);
  assert.ok(await exists(join(state, 'disabled')), 'another session cannot resurrect a disabled subscription');
  console.log('PASS: owner receipt/unsubscribe and disabled-subscription isolation');

  // Simultaneous first enrollment: all processes share one empty state directory.
  const fresh = join(directory, 'first-enrollment');
  const racing = Array.from({ length: 4 }, (_, i) => start('run', fresh, 'scope-racer-' + i, ['--mode', 'stream', '--wait', '10']));
  await until(async () => {
    const living = racing.filter(r => !r.ended);
    if (living.length !== 1) return false;
    try { return (await readdir(join(fresh, 'inbox'))).some(f => f.endsWith('.json')); } catch { return false; }
  });
  const living = racing.filter(r => !r.ended);
  assert.equal(living.length, 1);
  assert.equal(racing.filter(r => r.ended && [3, 5].includes(r.code)).length, 3);
  const cursor = JSON.parse(await readFile(join(fresh, 'cursor.json'), 'utf8'));
  const winner = racing.indexOf(living[0]);
  assert.equal(cursor.session, 'scope-racer-' + winner, 'one session owns all received progress');
  const other = await finish(start('status', fresh, 'scope-racer-' + ((winner + 1) % 4)));
  assert.equal(other.code, 5);
  console.log('PASS: four simultaneous sessions produce one owner and immutable state binding');
} finally {
  for (const child of children) child.kill('SIGTERM');
  await pause(100);
  for (const child of children) child.kill('SIGKILL');
  await pause(50);
  await rm(directory, { recursive: true, force: true });
}
