#!/usr/bin/env node
// AgentMeet legacy-room listener for Claude Desktop (Code tab) experiments. Zero dependencies.
// Hosted by a native tracked facility:
//   --mode stream : run under the Monitor tool; one stdout line per real message, never exits on its own.
//   --mode once   : run under Bash run_in_background; exits after the first delivered batch.
// Empty long-poll timeouts, retries and progress go to the state dir only, never to stdout.
//
// Every command takes --room CODE --nick NICK --session ID, where ID is the native agent session this
// subscription belongs to (never inferred; a fork must pass its own ID and state dir).
// Usage: node listener.mjs run ... [--mode stream|once] [--wait 300] [--since TS]
//        node listener.mjs status|unsubscribe|resubscribe ...
//        node listener.mjs receipt ... ID...   (record that the agent received these)
//        node listener.mjs show ... ID...      (print full staged envelopes)
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { createHash, randomUUID } from 'node:crypto';

const argv = process.argv.slice(2);
const cmd = argv[0] || 'run';
const opt = (name, dflt) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 ? argv[i + 1] : dflt;
};
const positional = argv.slice(1).filter((arg, i, args) => !arg.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));
const ids = ['show', 'receipt'].includes(cmd) ? positional : [];
const origin = opt('origin', 'https://agentmeet.live');
const room = opt('room');
const nick = opt('nick');
const mode = opt('mode', 'stream');
const wait = Number(opt('wait', '300'));
const session = opt('session');
const initialSince = Number(opt('since', '0'));
if (!/^[a-z0-9]{3}-[a-z0-9]{3}-[a-z0-9]{3}$/.test(room || '') || !/^[a-zA-Z0-9_-]{1,32}$/.test(nick || '') || !/^[A-Za-z0-9_.:-]{4,128}$/.test(session || '') ||
    !['run', 'status', 'show', 'receipt', 'unsubscribe', 'resubscribe'].includes(cmd) ||
    !['stream', 'once'].includes(mode) || !Number.isInteger(wait) || wait < 1 || wait > 1800 ||
    !Number.isSafeInteger(initialSince) || initialSince < 0 ||
    ids.some(id => !/^msg_[0-9]+$/.test(id)) ||
    (['show', 'receipt'].includes(cmd) ? ids.length === 0 : positional.length > 0)) {
  console.error('Use a supported command, legacy room code, nick, native session, wait 1–1800 and valid msg_<timestamp> IDs for show/receipt');
  process.exit(64);
}
const repo = path.resolve(import.meta.dirname, '../..');
const dir = path.resolve(opt('state', path.join(repo, '.agentmeet-lab/claude-desktop', `${room}--${nick}`)));
const inbox = path.join(dir, 'inbox');

// Immutable state-dir binding. The first `run` creates binding.json atomically (link of a complete temp
// file, which fails if one exists); every command checks it before reading or writing any other state.
// A mismatched, malformed or missing binding fails closed with exit 5.
const binding = { origin, room, nick, session };
function checkBinding() {
  const target = path.join(dir, 'binding.json');
  let raw;
  try { raw = fs.readFileSync(target, 'utf8'); } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    if (cmd !== 'run') { console.error(`state dir ${dir} is not bound; start a listener first`); process.exit(5); }
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    let legacy = null;
    try { legacy = JSON.parse(fs.readFileSync(path.join(dir, 'cursor.json'), 'utf8')).session; } catch {}
    if (legacy && legacy !== session) { console.error(`state dir ${dir} holds a cursor for session ${legacy}; refusing`); process.exit(5); }
    const tmp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ ...binding, created: new Date().toISOString() }) + '\n', { mode: 0o600 });
    try { fs.linkSync(tmp, target); } catch (e2) { if (e2.code !== 'EEXIST') throw e2; } finally { fs.rmSync(tmp, { force: true }); }
    return checkBinding();
  }
  let held = null;
  try { held = JSON.parse(raw); } catch {}
  const ok = held && Object.keys(binding).every((k) => typeof held[k] === 'string' && held[k] === binding[k]);
  if (!ok) {
    console.error(`state dir ${dir} is bound to ${held?.session ? `${held.room}/${held.nick}/session ${held.session}` : 'a malformed binding'}; refusing`);
    process.exit(5);
  }
}
checkBinding();
fs.mkdirSync(inbox, { recursive: true, mode: 0o700 });
for (const sub of ['received', 'emitted']) fs.mkdirSync(path.join(dir, sub), { recursive: true, mode: 0o700 });
const file = (n) => path.join(dir, n);
const readJSON = (p, dflt) => {
  try { return JSON.parse(fs.readFileSync(path.isAbsolute(p) ? p : file(p), 'utf8')); } catch { return dflt; }
};
const writeJSON = (p, v) => {
  const target = path.isAbsolute(p) ? p : file(p);
  const tmp = `${target}.${process.pid}.tmp`;
  const fd = fs.openSync(tmp, 'w', 0o600);
  try { fs.writeSync(fd, JSON.stringify(v, null, 2) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, target);
};
const log = (event, extra = {}) => fs.appendFileSync(file('events.jsonl'), JSON.stringify({ t: new Date().toISOString(), pid: process.pid, gen, event, ...extra }) + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Envelopes in inbox/ are immutable once staged. Delivery state is marker files, each written by one party:
// emitted/<id>.json by the listener, received/<id>.json by the receipt command. A receipt can therefore never
// be undone by a concurrent emitter; at worst one extra (deduplicable) emit races a receipt.
const messageID = id => {
  if (typeof id !== 'string' || !/^msg_[0-9]+$/.test(id)) throw new Error('Invalid legacy message ID');
  return id;
};
const envelopePath = (id) => path.join(inbox, `${messageID(id)}.json`);
const marker = (kind, id) => path.join(dir, kind, `${messageID(id)}.json`);
const isReceived = (id) => fs.existsSync(marker('received', id));
const pendingEnvelopes = () => fs.readdirSync(inbox).filter((f) => f.endsWith('.json')).map((f) => readJSON(path.join(inbox, f), null)).filter((e) => e && !isReceived(e.msg.id)).sort((a, b) => a.msg.ts - b.msg.ts || a.msg.id.localeCompare(b.msg.id));
let gen = null;
const subscription = `${origin}|${room}|${nick}|${session}|${dir}`;
// The writer ownership key is the state dir alone, so every user of one state dir is serialized.
const port = 49152 + (parseInt(createHash('sha256').update(fs.realpathSync(dir)).digest('hex').slice(0, 8), 16) % 16000);
// Ask whoever holds the ownership port who they are; null when nobody holds it.
const probeOwner = () => new Promise((resolve) => {
  const sock = net.connect({ port, host: '127.0.0.1' });
  let buf = '';
  const done = (v) => { sock.destroy(); resolve(v); };
  sock.setTimeout(2000, () => done({ foreign: true }));
  sock.on('data', (d) => { buf += d; if (buf.includes('\n')) { try { done(JSON.parse(buf)); } catch { done({ foreign: true }); } } });
  sock.on('error', () => done(null));
  sock.on('end', () => done(buf ? { foreign: true } : null));
});

// --- control commands ---------------------------------------------------------------------
if (cmd === 'status') {
  const events = fs.existsSync(file('events.jsonl')) ? fs.readFileSync(file('events.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  const count = (e) => events.filter((x) => x.event === e).length;
  const owner = await probeOwner();
  const pending = pendingEnvelopes();
  console.log(JSON.stringify({
    dir, port, disabled: fs.existsSync(file('disabled')), owner,
    status: readJSON('status.json', null), cursor: readJSON('cursor.json', null),
    inbox: { staged: pending.filter((e) => !fs.existsSync(marker('emitted', e.msg.id))).length, emitted_unconfirmed: pending.filter((e) => fs.existsSync(marker('emitted', e.msg.id))).length, received: fs.readdirSync(file('received')).length },
    counts: { empty_timeouts: count('timeout'), batches: count('batch'), emits: count('emit'), errors: count('error'), starts: count('start'), stops: count('stop') },
  }, null, 2));
  process.exit(0);
}
if (cmd === 'show') {
  for (const id of ids) console.log(JSON.stringify({ ...(readJSON(envelopePath(id), null) || { id, missing: true }), emitted: readJSON(marker('emitted', id), null), received: readJSON(marker('received', id), null) }, null, 2));
  process.exit(0);
}
if (cmd === 'receipt') {
  for (const id of ids) {
    if (!fs.existsSync(envelopePath(id)) || isReceived(id)) continue;
    writeJSON(marker('received', id), { id, received_at: new Date().toISOString(), session });
  }
  console.log(`receipt recorded for ${ids.length} id(s); this is transport receipt only, not a work acknowledgement`);
  process.exit(0);
}
if (cmd === 'unsubscribe') {
  fs.writeFileSync(file('disabled'), new Date().toISOString() + '\n');
  const owner = await probeOwner();
  if (owner?.subscription === subscription) process.kill(owner.pid, 'SIGTERM');
  console.log(`unsubscribed; ${owner?.pid ? 'signalled pid ' + owner.pid : 'no live listener'}`);
  process.exit(0);
}
if (cmd === 'resubscribe') {
  fs.rmSync(file('disabled'), { force: true });
  console.log('resubscribed (start a listener to arm)');
  process.exit(0);
}

// --- single owner ----------------------------------------------------------------------------
// The listener owns its subscription by holding a loopback TCP port derived from the subscription key.
// The kernel allows one holder and releases it when the process dies (including SIGKILL), so there is no
// stale-lock reclaim step to race and no generation can outlive its process. lock.json is informational.
if (fs.existsSync(file('disabled'))) {
  console.error('subscription disabled; run resubscribe first');
  process.exit(0);
}
gen = randomUUID();
const identity = { subscription, pid: process.pid, gen, mode, started: new Date().toISOString() };
const server = net.createServer((sock) => sock.end(JSON.stringify(identity) + '\n'));
const acquired = await new Promise((resolve, reject) => {
  server.once('error', (e) => (e.code === 'EADDRINUSE' ? resolve(false) : reject(e)));
  server.listen({ port, host: '127.0.0.1', exclusive: true }, () => resolve(true));
});
if (!acquired) {
  const owner = await probeOwner();
  if (owner?.subscription === subscription) console.error(`already armed by pid ${owner.pid} gen ${owner.gen}`);
  else console.error(`ownership port ${port} is held by another program; pass --state to change the subscription key`);
  process.exit(owner?.subscription === subscription ? 3 : 4);
}
server.unref();
if (fs.existsSync(file('disabled'))) { server.close(); console.error('subscription disabled; run resubscribe first'); process.exit(0); }
writeJSON('lock.json', identity);
let stopping = false;
function release(reason) {
  if (readJSON('lock.json', {}).gen === gen) fs.rmSync(file('lock.json'), { force: true });
  server.close();
  setStatus('stopped', { reason });
  log('stop', { reason });
}
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, () => { stopping = true; release(sig); process.exit(0); });

// --- transport ----------------------------------------------------------------------------
let status = { gen, pid: process.pid, mode, room, nick, timeouts: 0, last_contact: null, last_error: null };
function setStatus(state, extra = {}) { status = { ...status, state, updated: new Date().toISOString(), ...extra }; writeJSON('status.json', status); }

async function fetchJSON(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout((wait + 30) * 1000), headers: { 'User-Agent': 'agentmeet-claude-desktop-lab/1' } });
  const rid = res.headers.get('x-request-id');
  if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status, rid, retryAfter: Number(res.headers.get('retry-after')) || 0 });
  return { body: await res.json(), rid };
}
const read = (query) => fetchJSON(`${origin}/${room}?format=json&limit=200&exclude_nick=${encodeURIComponent(nick)}&${query}`);

// Full export drain, used only when a full page is a single timestamp tie (no cursor progress possible).
async function exportFrom(ts) {
  const out = [];
  let page = (await fetchJSON(`${origin}/${room}/export?limit=200`)).body;
  const snapshot = page.snapshot;
  for (;;) {
    out.push(...page.messages.filter((m) => m.ts >= ts && m.nick !== nick));
    if (!page.has_more) break;
    page = (await fetchJSON(`${origin}/${room}/export?limit=200&cursor=${encodeURIComponent(page.next_cursor)}&snapshot=${snapshot}`)).body;
  }
  log('export_reconcile', { ts, snapshot, n: out.length });
  return out;
}

// Drain everything after the cursor with wait=0 pages, overlapping by 1 ms and deduplicating stable IDs.
async function drain(cursor) {
  const all = new Map();
  let since = cursor.since;
  for (;;) {
    const { body } = await read(`since=${Math.max(0, since - 1)}`);
    body.messages.forEach((m) => all.set(m.id, m));
    if (!body.has_more || !body.messages.length) break;
    const max = Math.max(...body.messages.map((m) => m.ts));
    if (max <= since) { (await exportFrom(since)).forEach((m) => all.set(m.id, m)); break; }
    since = max;
  }
  const known = new Set(cursor.ids_at_since);
  return [...all.values()].filter((m) => m.nick !== nick && (m.ts > cursor.since || (m.ts === cursor.since && !known.has(m.id))));
}

// Persist envelopes first, then advance the cursor. Envelopes stay in inbox/ until an explicit receipt.
function stage(messages, cursor) {
  const fresh = [];
  for (const m of messages) {
    if (fs.existsSync(envelopePath(m.id)) || isReceived(m.id)) continue;
    writeJSON(envelopePath(m.id), { staged_at: new Date().toISOString(), gen, session, msg: { id: m.id, nick: m.nick, ts: m.ts, iso: m.iso, text: m.text } });
    fresh.push(m.id);
  }
  const maxTs = Math.max(cursor.since, ...messages.map((m) => m.ts));
  const idsAt = new Set(maxTs === cursor.since ? cursor.ids_at_since : []);
  messages.filter((m) => m.ts === maxTs).forEach((m) => idsAt.add(m.id));
  const next = { since: maxTs, ids_at_since: [...idsAt], session, updated: new Date().toISOString() };
  writeJSON('cursor.json', next);
  return { fresh, cursor: next };
}

// One compact stdout line per envelope not yet emitted by this generation. The hosting tool may truncate
// long events, so identity and the full-record pointer come before the excerpt. Stdout is not a receipt.
const emittedThisGen = new Set();
function emit() {
  const pending = pendingEnvelopes().filter((e) => !emittedThisGen.has(e.msg.id));
  for (const env of pending) {
    const m = env.msg;
    if (fs.existsSync(file('disabled'))) { release('unsubscribed'); process.exit(0); }
    if (isReceived(m.id)) continue;
    const prior = readJSON(marker('emitted', m.id), { count: 0 });
    const excerpt = m.text.replace(/\s+/g, ' ').slice(0, 240);
    const replay = prior.count > 0 ? ' replay=1' : '';
    process.stdout.write(`AGENTMEET id=${m.id} from=${m.nick} at=${m.iso}${replay} full=${path.relative(repo, envelopePath(m.id))} :: ${excerpt}${m.text.length > 240 ? ' …' : ''}\n`);
    writeJSON(marker('emitted', m.id), { count: prior.count + 1, last_emit: new Date().toISOString(), gen });
    emittedThisGen.add(m.id);
  }
  if (pending.length) log('emit', { ids: pending.map((e) => e.msg.id) });
  return pending.length;
}

// --- main loop -------------------------------------------------------------------------------
let cursor = readJSON('cursor.json', null);
if (!cursor) {
  cursor = { since: initialSince, ids_at_since: [], session, updated: new Date().toISOString() };
  writeJSON('cursor.json', cursor);
  log('enroll', { since: cursor.since });
}
log('start', { mode, wait, since: cursor.since });
let failures = 0, reportedFailure = null;
if (emit() && mode === 'once') { release('delivered'); process.exit(0); } // recover unconfirmed envelopes first

while (!stopping) {
  if (fs.existsSync(file('disabled'))) { release('unsubscribed'); process.exit(0); }
  setStatus('waiting', { since: cursor.since });
  const t0 = Date.now();
  try {
    let msgs = await drain(cursor);
    let rid = null;
    if (!msgs.length) {
      const res = await read(`since=${cursor.since}&wait=${wait}`);
      rid = res.rid;
      if (res.body.messages.length) msgs = await drain(cursor);
    }
    failures = 0;
    if (reportedFailure) { log('recovered', { after: reportedFailure }); reportedFailure = null; }
    status.last_contact = new Date().toISOString();
    const r = stage(msgs, cursor);
    cursor = r.cursor;
    if (!r.fresh.length) {
      status.timeouts++;
      log('timeout', { ms: Date.now() - t0, rid, since: cursor.since });
      continue;
    }
    log('batch', { ms: Date.now() - t0, rid, ids: r.fresh });
    if (mode === 'once') { await sleep(1500); cursor = stage(await drain(cursor), cursor).cursor; } // coalesce a burst
    emit();
    if (mode === 'once') { release('delivered'); process.exit(0); }
  } catch (e) {
    failures++;
    const category = e.status ? `http_${e.status}` : e.name === 'TimeoutError' ? 'timeout' : 'network';
    status.last_error = { category, message: String(e.message), rid: e.rid || null, at: new Date().toISOString() };
    log('error', status.last_error);
    if (e.status === 404 || e.status === 410) {
      process.stdout.write(`AGENTMEET_FAILURE room=${room} category=${category} rid=${e.rid} action=room-gone-listener-stopped\n`);
      release(category);
      process.exit(2);
    }
    // Report an actionable failure once per category after ~5 min of consecutive failures.
    if (failures >= 8 && reportedFailure !== category) {
      reportedFailure = category;
      process.stdout.write(`AGENTMEET_FAILURE room=${room} category=${category} rid=${e.rid || '-'} failures=${failures} action=still-retrying-check-network\n`);
    }
    const backoff = Math.min(60000, 1000 * 2 ** Math.min(failures, 6));
    setStatus('retrying', { failures });
    await sleep(Math.max(e.retryAfter * 1000, backoff / 2 + Math.random() * backoff / 2));
  }
}
