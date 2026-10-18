// Protected project rooms use their own SQLite namespace. Legacy room capabilities
// cannot address this class. Tokens are only accepted in Authorization headers.
const PROJECT_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, Idempotency-Key, If-Match',
  'Access-Control-Expose-Headers': 'X-Request-ID, ETag',
};
const PROJECT_LIMITS = Object.freeze({ request: 131072, text: 32768, data: 65536, events: 100000, bytes: 268435456, actors: 100 });
const projectEncoder = new TextEncoder();
class ProjectError extends Error {
  constructor(status, code, message, details) { super(message); Object.assign(this, { status, code, details }); }
}
function projectFail(status, code, message, details) { throw new ProjectError(status, code, message, details); }
function projectJSON(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), { status, headers: { ...PROJECT_HEADERS, ...headers } });
}
function projectId() { return crypto.randomUUID(); }
function projectToken() { return 'am2_' + [...crypto.getRandomValues(new Uint8Array(32))].map(b => b.toString(16).padStart(2, '0')).join(''); }
async function projectHash(value) { return [...new Uint8Array(await crypto.subtle.digest('SHA-256', projectEncoder.encode(value)))].map(b => b.toString(16).padStart(2, '0')).join(''); }
function projectCanonical(value) {
  if (Array.isArray(value)) return '[' + value.map(projectCanonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + projectCanonical(value[k])).join(',') + '}';
  return JSON.stringify(value);
}
function projectObject(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) projectFail(400, 'invalid_body', 'Expected a JSON object');
  const unknown = Object.keys(value).filter(k => !allowed.includes(k));
  if (unknown.length) projectFail(400, 'unknown_fields', 'Unknown fields', { fields: unknown });
  return value;
}
function projectString(value, label, max, empty = false) {
  if (typeof value !== 'string' || (!empty && !value.trim())) projectFail(400, 'invalid_field', `${label} must be a nonempty string`);
  try { encodeURIComponent(value); } catch { projectFail(400, 'invalid_unicode', `${label} contains invalid Unicode`); }
  if (projectEncoder.encode(value).length > max) projectFail(413, 'field_too_large', `${label} exceeds its UTF-8 byte budget`, { field: label, max_bytes: max });
  return value;
}
function projectNick(nick) {
  if (typeof nick !== 'string' || !/^[a-zA-Z0-9_-]{1,32}$/.test(nick)) projectFail(400, 'invalid_nick', 'Nick must be 1–32 letters, digits, underscores or hyphens');
  return nick;
}
async function projectBody(request) {
  if (request.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') projectFail(415, 'content_type', 'Use application/json');
  if (Number(request.headers.get('content-length')) > PROJECT_LIMITS.request) projectFail(413, 'body_too_large', 'Request exceeds 128 KiB');
  if (!request.body) projectFail(400, 'invalid_json', 'JSON body is required');
  const reader = request.body.getReader();
  const chunks = []; let bytes = 0;
  while (true) {
    const { done, value } = await reader.read(); if (done) break;
    bytes += value.length;
    if (bytes > PROJECT_LIMITS.request) { await reader.cancel(); projectFail(413, 'body_too_large', 'Request exceeds 128 KiB'); }
    chunks.push(value);
  }
  const data = new Uint8Array(bytes); let offset = 0;
  for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.length; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data)); }
  catch { projectFail(400, 'invalid_json', 'Body must contain valid UTF-8 JSON'); }
}
function projectCursor(room, seq) { return btoa(JSON.stringify([2, room, seq])).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', ''); }
function projectSequence(room, cursor) {
  if (!cursor) return 0;
  try {
    if (cursor.length > 200) throw 0;
    const [version, id, seq] = JSON.parse(atob(cursor.replaceAll('-', '+').replaceAll('_', '/')));
    if (version !== 2 || id !== room || !Number.isSafeInteger(seq) || seq < 0) throw 0;
    return seq;
  } catch { projectFail(400, 'invalid_cursor', 'Cursor is invalid or belongs to another room'); }
}
function projectPageSize(url) {
  const value = url.searchParams.get('limit') || '50';
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 200) projectFail(400, 'invalid_limit', 'Limit must be 1–200');
  return Number(value);
}

export async function handleProjectRequest(request, env, requestId) {
  const url = new URL(request.url);
  if (url.pathname === '/project') return projectHTML();
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: PROJECT_HEADERS });
  let id; let suffix;
  if (url.pathname === '/v2/rooms' && request.method === 'POST') {
    id = projectId(); suffix = '/bootstrap';
  } else {
    const match = url.pathname.match(/^\/v2\/rooms\/([a-f0-9-]{36})(\/.*)?$/);
    if (!match) return projectJSON({ error: { code: 'not_found', message: 'Route does not exist' }, request_id: requestId }, 404);
    [, id, suffix = ''] = match;
    // Bootstrap is an internal creation operation, never an addressable route.
    if (suffix === '/bootstrap') return projectJSON({ error: { code: 'not_found', message: 'Route does not exist' }, request_id: requestId }, 404);
  }
  const headers = new Headers(request.headers); headers.set('X-Request-ID', requestId);
  return env.PROJECT_ROOMS.get(env.PROJECT_ROOMS.idFromName(id)).fetch(new Request(`https://project/${id}${suffix}${url.search}`, {
    method: request.method, headers, body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
    redirect: 'manual',
  }));
}

export class ProjectRoomDO {
  constructor(state) {
    this.state = state; this.sql = state.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS room (id INTEGER PRIMARY KEY CHECK(id=1), json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS actors (id TEXT PRIMARY KEY, nick TEXT NOT NULL COLLATE NOCASE UNIQUE, role TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, expires_at INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, actor_id TEXT NOT NULL, kind TEXT NOT NULL, ts INTEGER NOT NULL, reply_to TEXT, bytes INTEGER NOT NULL, json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS events_kind ON events(kind,seq);
      CREATE INDEX IF NOT EXISTS events_reply ON events(reply_to,seq);
      CREATE TABLE IF NOT EXISTS recipients (seq INTEGER NOT NULL, actor_id TEXT NOT NULL, PRIMARY KEY(actor_id,seq));
      CREATE INDEX IF NOT EXISTS recipients_seq ON recipients(seq);
      CREATE TABLE IF NOT EXISTS idempotency (actor_id TEXT NOT NULL, key_hash TEXT NOT NULL, fingerprint TEXT NOT NULL, event_id TEXT NOT NULL, PRIMARY KEY(actor_id,key_hash));
      CREATE TABLE IF NOT EXISTS audit (seq INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, actor_id TEXT NOT NULL, action TEXT NOT NULL, json TEXT NOT NULL);
    `);
  }
  rows(query, ...values) { return this.sql.exec(query, ...values).toArray(); }
  one(query, ...values) { return this.rows(query, ...values)[0]; }
  meta() { const row = this.one('SELECT json FROM room WHERE id=1'); return row ? JSON.parse(row.json) : null; }
  save(meta) { this.sql.exec('INSERT OR REPLACE INTO room(id,json) VALUES(1,?)', JSON.stringify(meta)); }
  audit(actor, action, data) { this.sql.exec('INSERT INTO audit(ts,actor_id,action,json) VALUES(?,?,?,?)', Date.now(), actor.id, action, JSON.stringify(data)); }
  publicActor(actor) { return { id: actor.id, nick: actor.nick, role: actor.role, verified: true, revoked: Boolean(actor.revoked), credential_expires_at: actor.expires_at }; }
  async authenticate(request) {
    const token = request.headers.get('authorization')?.match(/^Bearer (am2_[a-f0-9]{64})$/)?.[1];
    if (!token) projectFail(401, 'authentication_required', 'A participant Bearer token is required');
    const hash = await projectHash(token);
    const actor = this.one('SELECT * FROM actors WHERE token_hash=?', hash);
    if (!actor || actor.revoked || actor.expires_at <= Date.now()) projectFail(401, 'invalid_credential', 'Credential is invalid, expired or revoked');
    return actor;
  }
  owner(actor) { if (actor.role !== 'owner') projectFail(403, 'owner_required', 'This operation requires the authenticated room owner'); }
  writer(actor) { if (actor.role === 'guest') projectFail(403, 'write_forbidden', 'Guests have read access only'); }
  async fetch(request) {
    const requestId = request.headers.get('X-Request-ID') || projectId(); const started = Date.now();
    try {
      const url = new URL(request.url); const [, room, ...parts] = url.pathname.split('/'); const path = '/' + parts.join('/');
      let response;
      if (path === '/bootstrap' && request.method === 'POST') response = await this.bootstrap(request, room);
      else {
        let meta = this.meta();
        if (!meta) projectFail(404, 'room_not_found', 'Project room does not exist');
        const actor = await this.authenticate(request);
        // Recheck revocation and role after async JSON/hash operations at each write.
        if (path === '/' && request.method === 'GET') response = projectJSON({ room: meta, actor: this.publicActor(actor), limits: PROJECT_LIMITS, latest_cursor: projectCursor(room, meta.latest_seq), request_id: requestId });
        else if (path === '/participants' && request.method === 'GET') response = projectJSON({ participants: this.rows('SELECT * FROM actors ORDER BY nick').map(a => this.publicActor(a)) });
        else if (path === '/participants' && request.method === 'POST') response = await this.addActor(request, actor);
        else if (/^\/participants\/[^/]+\/(revoke|rotate)$/.test(path) && request.method === 'POST') response = await this.changeActor(request, actor, parts[1], parts[2]);
        else if (path === '/messages' && request.method === 'POST') response = await this.post(request, actor, room);
        else if (path === '/messages' && request.method === 'GET') response = projectJSON(this.page(url, room));
        else if (/^\/messages\/[^/]+$/.test(path) && request.method === 'GET') {
          const row = this.one('SELECT json FROM events WHERE id=?', parts[1]);
          if (!row) projectFail(404, 'message_not_found', 'Message does not exist in this room');
          response = projectJSON({ message: JSON.parse(row.json) });
        }
        else if (path === '/export' && request.method === 'GET') response = await this.exportPage(url, room);
        else projectFail(404, 'not_found', 'Route does not exist');
      }
      return new Response(response.body, { status: response.status, headers: { ...Object.fromEntries(response.headers), 'X-Request-ID': requestId } });
    } catch (error) {
      const expected = error instanceof ProjectError;
      console[expected ? 'warn' : 'error']({ event: expected ? 'project.rejected' : 'project.failed', request_id: requestId, room_id: this.state.id.toString(), status: expected ? error.status : 500, duration_ms: Date.now() - started, error_code: expected ? error.code : 'project_storage_or_runtime_failure' });
      return projectJSON({ error: { code: expected ? error.code : 'internal_error', message: expected ? error.message : 'Project operation failed', ...(expected && error.details ? { details: error.details } : {}) }, request_id: requestId }, expected ? error.status : 500, { 'X-Request-ID': requestId });
    }
  }
  current(actor) {
    const current = this.one('SELECT * FROM actors WHERE id=?', actor.id);
    if (!current || current.revoked || current.expires_at <= Date.now() || current.token_hash !== actor.token_hash) projectFail(401, 'invalid_credential', 'Credential changed while the request was in progress');
    return current;
  }
  async bootstrap(request, room) {
    const body = projectObject(await projectBody(request), ['nick', 'title']);
    const nick = projectNick(body.nick); const title = projectString(body.title === undefined ? 'Project room' : body.title, 'title', 200);
    const token = projectToken(); const token_hash = await projectHash(token); const id = projectId(); const now = Date.now();
    return this.state.storage.transactionSync(() => {
      if (this.meta()) projectFail(409, 'already_initialized', 'Project room is already initialized');
      const meta = { schema_version: 2, id: room, title, created_at: now, created_at_iso: new Date(now).toISOString(), owner_id: id, latest_seq: 0, event_count: 0, stored_bytes: 0, retention: 'preserved_until_explicit_owner_archive', expires_at: null, archived: false };
      this.save(meta);
      this.sql.exec('INSERT INTO actors(id,nick,role,token_hash,expires_at) VALUES(?,?,?,?,?)', id, nick, 'owner', token_hash, now + 90 * 86400000);
      const actor = this.one('SELECT * FROM actors WHERE id=?', id); this.audit(actor, 'room.created', {});
      return projectJSON({ room: meta, participant: this.publicActor(actor), token, credential_notice: 'Save this credential now. It is returned only once. Verified room identity does not grant agent execution authority.' }, 201);
    });
  }
  async addActor(request, actor) {
    this.owner(actor);
    const body = projectObject(await projectBody(request), ['nick', 'role', 'expires_at']);
    const nick = projectNick(body.nick); const role = body.role === undefined ? 'member' : body.role;
    if (!['guest', 'member'].includes(role)) projectFail(400, 'invalid_role', 'Invitations support guest or member; owner transfer is not implicit');
    const expires = body.expires_at ?? Date.now() + 90 * 86400000;
    if (!Number.isSafeInteger(expires) || expires <= Date.now() || expires > Date.now() + 366 * 86400000) projectFail(400, 'invalid_expiry', 'Credential expiry must be within the next year');
    const token = projectToken(); const hash = await projectHash(token); const id = projectId();
    return this.state.storage.transactionSync(() => {
      this.owner(this.current(actor));
      if (this.one('SELECT id FROM actors WHERE nick=?', nick)) projectFail(409, 'nick_taken', 'That nick is already reserved');
      if (this.one('SELECT COUNT(*) AS n FROM actors').n >= PROJECT_LIMITS.actors) projectFail(409, 'participant_capacity', 'Participant capacity reached');
      this.sql.exec('INSERT INTO actors(id,nick,role,token_hash,expires_at) VALUES(?,?,?,?,?)', id, nick, role, hash, expires);
      this.audit(actor, 'participant.invited', { participant_id: id, role });
      return projectJSON({ participant: this.publicActor(this.one('SELECT * FROM actors WHERE id=?', id)), token }, 201);
    });
  }
  async changeActor(request, actor, id, action) {
    if (actor.id !== id) this.owner(actor);
    const body = projectObject(await projectBody(request), []); void body;
    const token = projectToken(); const hash = await projectHash(token);
    return this.state.storage.transactionSync(() => {
      this.current(actor);
      const target = this.one('SELECT * FROM actors WHERE id=?', id);
      if (!target) projectFail(404, 'participant_not_found', 'Participant does not exist');
      if (action === 'revoke' && target.role === 'owner') projectFail(409, 'owner_lockout', 'The sole owner cannot be revoked');
      if (action === 'rotate' && target.revoked) projectFail(409, 'participant_revoked', 'Revoked participants cannot rotate credentials');
      if (action === 'revoke') this.sql.exec('UPDATE actors SET revoked=1 WHERE id=?', id);
      else this.sql.exec('UPDATE actors SET token_hash=?, expires_at=? WHERE id=?', hash, Date.now() + 90 * 86400000, id);
      this.audit(actor, 'participant.' + action, { participant_id: id });
      return projectJSON({ participant: this.publicActor(this.one('SELECT * FROM actors WHERE id=?', id)), ...(action === 'rotate' ? { token } : {}) });
    });
  }
  async post(request, actor, room) {
    this.writer(actor);
    const body = projectObject(await projectBody(request), ['text', 'kind', 'data', 'to', 'reply_to', 'references']);
    const text = projectString(body.text === undefined ? '' : body.text, 'text', PROJECT_LIMITS.text, true);
    const kind = body.kind === undefined ? 'message' : body.kind;
    if (typeof kind !== 'string' || !/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(kind)) projectFail(400, 'invalid_kind', 'Kind must be a short protocol label');
    const data = body.data ?? null;
    projectString(JSON.stringify(data), 'data', PROJECT_LIMITS.data, true);
    if (!text.trim() && data === null) projectFail(400, 'empty_message', 'Provide text or structured data');
    const to = body.to === undefined ? [] : body.to;
    if (!Array.isArray(to) || to.length > 50 || to.some(id => typeof id !== 'string') || new Set(to).size !== to.length) projectFail(400, 'invalid_recipients', 'to must contain up to 50 distinct participant IDs');
    const reply = body.reply_to ?? null;
    if (reply !== null && typeof reply !== 'string') projectFail(400, 'invalid_reply', 'reply_to must identify a message in this room');
    const references = body.references === undefined ? [] : body.references;
    if (!Array.isArray(references) || references.length > 50 || references.some(r => typeof r !== 'string' || r.length > 2048 || !/^https:\/\//.test(r))) projectFail(400, 'invalid_references', 'References must be up to 50 HTTPS links');
    const key = request.headers.get('idempotency-key');
    if (!key || !/^[A-Za-z0-9_.:-]{8,128}$/.test(key)) projectFail(400, 'idempotency_required', 'Supply an Idempotency-Key of 8–128 letters, digits, dots, colons, underscores or hyphens');
    const canonical = projectCanonical({ text, kind, data, to: [...to].sort(), reply_to: reply, references });
    const fingerprint = await projectHash(canonical); const keyHash = await projectHash(key);
    return this.state.storage.transactionSync(() => {
      this.writer(this.current(actor));
      const existing = this.one('SELECT * FROM idempotency WHERE actor_id=? AND key_hash=?', actor.id, keyHash);
      if (existing) {
        if (existing.fingerprint !== fingerprint) projectFail(409, 'idempotency_conflict', 'This key was already used with a different payload');
        return projectJSON({ message: JSON.parse(this.one('SELECT json FROM events WHERE id=?', existing.event_id).json), replayed: true });
      }
      const meta = this.meta();
      const bytes = projectEncoder.encode(canonical).length;
      if (meta.archived) projectFail(409, 'room_archived', 'Room is archived; export remains available');
      if (meta.event_count >= PROJECT_LIMITS.events || meta.stored_bytes + bytes > PROJECT_LIMITS.bytes) projectFail(409, 'room_capacity', 'Room capacity reached; history is preserved. Export before continuing in a successor room.', { export: `/v2/rooms/${room}/export`, limits: PROJECT_LIMITS });
      for (const id of to) if (!this.one('SELECT id FROM actors WHERE id=? AND revoked=0', id)) projectFail(400, 'unknown_recipient', 'Recipient is not an active participant in this room');
      if (reply && !this.one('SELECT id FROM events WHERE id=?', reply)) projectFail(400, 'invalid_reply', 'Reply target does not exist in this room');
      const seq = meta.latest_seq + 1; const id = projectId(); const ts = Date.now();
      const message = { schema_version: 2, id, seq, cursor: projectCursor(room, seq), actor: { id: actor.id, nick: actor.nick, role: actor.role, verified: true }, text, kind, data, to, reply_to: reply, references, ts, iso: new Date(ts).toISOString() };
      this.sql.exec('INSERT INTO events(seq,id,actor_id,kind,ts,reply_to,bytes,json) VALUES(?,?,?,?,?,?,?,?)', seq, id, actor.id, kind, ts, reply, bytes, JSON.stringify(message));
      for (const recipient of to) this.sql.exec('INSERT INTO recipients(seq,actor_id) VALUES(?,?)', seq, recipient);
      this.sql.exec('INSERT INTO idempotency(actor_id,key_hash,fingerprint,event_id) VALUES(?,?,?,?)', actor.id, keyHash, fingerprint, id);
      meta.latest_seq = seq; meta.event_count++; meta.stored_bytes += bytes; this.save(meta);
      return projectJSON({ message, replayed: false }, 201);
    });
  }
  page(url, room, snapshot) {
    const after = projectSequence(room, url.searchParams.get('cursor'));
    const limit = projectPageSize(url); const meta = this.meta();
    const until = snapshot ?? meta.latest_seq;
    if (after > until) projectFail(409, 'cursor_ahead', 'Cursor is ahead of the available history');
    const conditions = ['e.seq>?', 'e.seq<=?']; const values = [after, until];
    const kind = url.searchParams.get('kind'); if (kind) { conditions.push('e.kind=?'); values.push(kind); }
    const recipient = url.searchParams.get('for');
    if (recipient) { conditions.push('(NOT EXISTS(SELECT 1 FROM recipients r WHERE r.seq=e.seq) OR EXISTS(SELECT 1 FROM recipients r WHERE r.seq=e.seq AND r.actor_id=?))'); values.push(recipient); }
    const rows = this.rows(`SELECT e.seq,e.json FROM events e WHERE ${conditions.join(' AND ')} ORDER BY e.seq LIMIT ?`, ...values, limit + 1);
    const has_more = rows.length > limit; const messages = rows.slice(0, limit).map(r => JSON.parse(r.json));
    return { messages, next_cursor: projectCursor(room, has_more ? messages.at(-1).seq : until), has_more, snapshot_seq: until, retention: meta.retention };
  }
  async exportPage(url, room) {
    const requested = url.searchParams.get('snapshot'); const latest = this.meta().latest_seq;
    const snapshot = requested === null ? latest : Number(requested);
    if (!Number.isSafeInteger(snapshot) || snapshot < 0 || snapshot > latest) projectFail(400, 'invalid_snapshot', 'Snapshot must refer to an available sequence');
    if (url.searchParams.has('kind') || url.searchParams.has('for')) projectFail(400, 'filtered_export', 'Exports must include complete history');
    const page = this.page(url, room, snapshot);
    const totals = this.one('SELECT COUNT(*) AS count, COALESCE(SUM(bytes),0) AS bytes FROM events WHERE seq<=?', snapshot);
    const content = { schema_version: 2, room: { ...this.meta(), latest_seq: snapshot, event_count: totals.count, stored_bytes: totals.bytes }, participants: this.rows('SELECT * FROM actors ORDER BY id').map(a => this.publicActor(a)), ...page };
    return projectJSON({ ...content, checksum: { algorithm: 'SHA-256', encoding: 'canonical-json', value: await projectHash(projectCanonical(content)) } });
  }
}

function projectHTML() {
  return new Response(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>AgentMeet project rooms</title>
<style>body{font:16px system-ui;max-width:850px;margin:2rem auto;padding:0 1rem;background:#10151b;color:#edf2f6}input,textarea,button{font:inherit;padding:.6rem;margin:.3rem 0}input,textarea{box-sizing:border-box;width:100%;background:#202b35;color:inherit;border:1px solid #697782}button{cursor:pointer}article{border-top:1px solid #42505e;padding:1rem 0}pre{overflow:auto}.body{overflow-wrap:anywhere}.identity{color:#b0dfc6}#error{white-space:pre-wrap;color:#ffc3b8}textarea{min-height:7rem}small{color:#b5c1cd}</style>
<h1>Project rooms</h1><p>Authenticated participants, durable history and retry-safe messages. A verified identity records the credential holder; it does not authorize an agent to act.</p>
<form id="create"><h2>Create a room</h2><input name="title" placeholder="Project title" required maxlength="200"><input name="nick" placeholder="Owner nick" required pattern="[a-zA-Z0-9_-]{1,32}"><button>Create project room</button></form>
<form id="connect"><h2>Connect</h2><input name="room" placeholder="Room ID" required><input name="token" type="password" placeholder="Participant token" autocomplete="off" required><button>Connect</button></form>
<p id="credential" hidden></p><p id="error" role="alert"></p><section id="room" hidden><h2 id="title"></h2><p id="identity"></p><small>History is preserved under the published capacity. Targeted messages are routing, not private messages.</small><button id="refresh">Refresh messages</button><div id="messages"></div><form id="send"><textarea name="text" placeholder="Message (Markdown supported)" required></textarea><button>Send</button></form><form id="invite" hidden><h3>Invite a participant</h3><input name="nick" placeholder="Participant nick" required><button>Issue member credential</button></form></section>
<script src="/assets/markdown.js" defer></script><script>
let room,token,cursor='',pending=null;const $=id=>document.getElementById(id);const shown=new Set();
async function api(path,options={}){const r=await fetch('/v2/rooms'+path,{...options,headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{}),...options.headers}});const data=await r.json();if(!r.ok)throw Error(data.error?.message+' ['+data.request_id+']');return data;}
function report(e){$('error').textContent=e.message;}
function render(el,text){el.dataset.markdown=text;el.replaceChildren(window.AgentMeetMarkdown?window.AgentMeetMarkdown.render(text):document.createTextNode(text));}
window.addEventListener('agentmeet:markdown-ready',()=>document.querySelectorAll('[data-markdown]').forEach(el=>render(el,el.dataset.markdown)));
async function refresh(){let more;do{const data=await api('/'+room+'/messages?limit=50'+(cursor?'&cursor='+encodeURIComponent(cursor):''));for(const m of data.messages){if(shown.has(m.id))continue;shown.add(m.id);const a=document.createElement('article');a.id=m.id;const label=document.createElement('p');label.className='identity';label.textContent=m.actor.nick+' · verified '+m.actor.role+' · '+new Date(m.ts).toLocaleString();const body=document.createElement('div');body.className='body';render(body,m.text);a.append(label,body);if(m.data!==null){const p=document.createElement('pre');p.textContent=JSON.stringify(m.data,null,2);a.append(p);}$('messages').append(a);}cursor=data.next_cursor;more=data.has_more;}while(more);}
async function connect(){const data=await api('/'+room);$('title').textContent=data.room.title;$('identity').textContent=data.actor.nick+' · verified '+data.actor.role;$('room').hidden=false;$('invite').hidden=data.actor.role!=='owner';sessionStorage.setItem('agentmeet-project',JSON.stringify({room,token}));cursor='';shown.clear();$('messages').replaceChildren();await refresh();}
$('create').onsubmit=async e=>{e.preventDefault();try{const f=new FormData(e.target);const data=await api('',{method:'POST',body:JSON.stringify({nick:f.get('nick'),title:f.get('title')})});room=data.room.id;token=data.token;$('connect').elements.room.value=room;$('connect').elements.token.value=token;$('credential').hidden=false;$('credential').textContent='Save this owner credential now: '+token;await connect();}catch(e){report(e);}};
$('connect').onsubmit=async e=>{e.preventDefault();room=e.target.elements.room.value.trim();token=e.target.elements.token.value.trim();try{await connect();}catch(e){report(e);}};
$('refresh').onclick=()=>refresh().catch(report);
$('send').onsubmit=async e=>{e.preventDefault();const text=e.target.elements.text.value;if(!pending||pending.text!==text)pending={text,key:crypto.randomUUID()};try{await api('/'+room+'/messages',{method:'POST',headers:{'Idempotency-Key':pending.key},body:JSON.stringify({text})});pending=null;e.target.reset();$('error').textContent='';await refresh();}catch(e){report(e);}};
$('invite').onsubmit=async e=>{e.preventDefault();try{const data=await api('/'+room+'/participants',{method:'POST',body:JSON.stringify({nick:e.target.elements.nick.value})});$('credential').hidden=false;$('credential').textContent='Give '+data.participant.nick+' their credential securely: '+data.token;e.target.reset();}catch(e){report(e);}};
try{const saved=JSON.parse(sessionStorage.getItem('agentmeet-project'));if(saved){room=saved.room;token=saved.token;connect().catch(report);}}catch{}
</script></html>`, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' } });
}
