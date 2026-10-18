import { projectHTML } from './project-ui.js';
import { waitForInbox, notifyInboxWaiters } from './project-wait.js';
import {
  initializeProjectRecords,
  validateProjectRecord,
  indexProjectRecord,
  projectRecordRoute,
  projectMessageView,
} from './project-records.js';
// Protected project rooms use their own SQLite namespace. Legacy room capabilities
// cannot address this class. Tokens are only accepted in Authorization headers.
import {
  PROJECT_HEADERS,
  PROJECT_LIMITS,
  projectEncoder,
  ProjectError,
  projectFail,
  projectJSON,
  projectId,
  projectToken,
  projectHash,
  projectCanonical,
  projectObject,
  projectString,
  projectNick,
  projectBody,
  projectCursor,
  projectSequence,
  projectPageSize,
  projectDecode,
} from './project-protocol.js';

export async function handleProjectRequest(request, env, requestId) {
  const url = new URL(request.url);
  if (url.pathname === '/project')
    return request.method === 'GET'
      ? projectHTML()
      : projectJSON(
          {
            error: {
              code: 'client_required',
              message:
                'Open /project with JavaScript enabled. Credentials are accepted only by the authenticated JSON API.',
            },
          },
          405,
        );
  if (request.method === 'OPTIONS')
    return new Response(null, { status: 204, headers: PROJECT_HEADERS });
  let id;
  let suffix;
  if (url.pathname === '/v2/rooms' && request.method === 'POST') {
    id = projectId();
    suffix = '/bootstrap';
  } else {
    const match = url.pathname.match(/^\/v2\/rooms\/([a-f0-9-]{36})(\/.*)?$/);
    if (!match)
      return projectJSON(
        { error: { code: 'not_found', message: 'Route does not exist' }, request_id: requestId },
        404,
      );
    [, id, suffix = ''] = match;
    // Bootstrap is an internal creation operation, never an addressable route.
    if (suffix === '/bootstrap')
      return projectJSON(
        { error: { code: 'not_found', message: 'Route does not exist' }, request_id: requestId },
        404,
      );
  }
  const headers = new Headers(request.headers);
  headers.set('X-Request-ID', requestId);
  return env.PROJECT_ROOMS.get(env.PROJECT_ROOMS.idFromName(id)).fetch(
    new Request(`https://project/${id}${suffix}${url.search}`, {
      method: request.method,
      headers,
      body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
      redirect: 'manual',
    }),
  );
}

export class ProjectRoomDO {
  constructor(state) {
    this.state = state;
    this.sql = state.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS room (id INTEGER PRIMARY KEY CHECK(id=1), json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS actors (id TEXT PRIMARY KEY, nick TEXT NOT NULL COLLATE NOCASE UNIQUE, role TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, expires_at INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS rotations (actor_id TEXT PRIMARY KEY, token_hash TEXT NOT NULL, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, actor_id TEXT NOT NULL, kind TEXT NOT NULL, ts INTEGER NOT NULL, reply_to TEXT, bytes INTEGER NOT NULL, json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS events_kind ON events(kind,seq);
      CREATE INDEX IF NOT EXISTS events_reply ON events(reply_to,seq);
      CREATE TABLE IF NOT EXISTS recipients (seq INTEGER NOT NULL, actor_id TEXT NOT NULL, PRIMARY KEY(actor_id,seq));
      CREATE INDEX IF NOT EXISTS recipients_seq ON recipients(seq);
      CREATE TABLE IF NOT EXISTS idempotency (actor_id TEXT NOT NULL, key_hash TEXT NOT NULL, fingerprint TEXT NOT NULL, event_id TEXT NOT NULL, PRIMARY KEY(actor_id,key_hash));
      CREATE TABLE IF NOT EXISTS audit (seq INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, actor_id TEXT NOT NULL, action TEXT NOT NULL, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS inbox (actor_id TEXT NOT NULL, seq INTEGER NOT NULL, PRIMARY KEY(actor_id,seq));
      CREATE INDEX IF NOT EXISTS inbox_seq ON inbox(seq);
      CREATE TABLE IF NOT EXISTS inbox_initialized (actor_id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS inbox_stats (actor_id TEXT PRIMARY KEY, pending INTEGER NOT NULL DEFAULT 0, last_ack_at INTEGER);
      CREATE TABLE IF NOT EXISTS acknowledgements (actor_id TEXT NOT NULL, seq INTEGER NOT NULL, action TEXT NOT NULL, outcome TEXT NOT NULL, ts INTEGER NOT NULL, PRIMARY KEY(actor_id,seq));
      CREATE TABLE IF NOT EXISTS mutations (actor_id TEXT NOT NULL, scope TEXT NOT NULL, key_hash TEXT NOT NULL, fingerprint TEXT NOT NULL, json TEXT NOT NULL, PRIMARY KEY(actor_id,scope,key_hash));
      CREATE TABLE IF NOT EXISTS board (key TEXT PRIMARY KEY, revision INTEGER NOT NULL, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS board_versions (key TEXT NOT NULL, revision INTEGER NOT NULL, json TEXT NOT NULL, PRIMARY KEY(key,revision));
    `);
    initializeProjectRecords(this);
    // Additive upgrade: pre-existing actors get all still-unacknowledged relevant
    // history. The marker and backfill commit together across interrupted starts.
    state.storage.transactionSync(() => {
      for (const actor of this.rows(
        'SELECT id FROM actors WHERE id NOT IN (SELECT actor_id FROM inbox_initialized)',
      ))
        this.initializeInbox(actor.id);
      for (const actor of this.rows(
        'SELECT id FROM actors WHERE id NOT IN (SELECT actor_id FROM inbox_stats)',
      ))
        this.sql.exec(
          'INSERT INTO inbox_stats(actor_id,pending,last_ack_at) SELECT ?, (SELECT COUNT(*) FROM inbox WHERE actor_id=?), (SELECT MAX(ts) FROM acknowledgements WHERE actor_id=?)',
          actor.id,
          actor.id,
          actor.id,
        );
    });
  }
  rows(query, ...values) {
    return this.sql.exec(query, ...values).toArray();
  }
  one(query, ...values) {
    return this.rows(query, ...values)[0];
  }
  meta() {
    const row = this.one('SELECT json FROM room WHERE id=1');
    return row ? JSON.parse(row.json) : null;
  }
  save(meta) {
    this.sql.exec('INSERT OR REPLACE INTO room(id,json) VALUES(1,?)', JSON.stringify(meta));
  }
  audit(actor, action, data) {
    this.sql.exec(
      'INSERT INTO audit(ts,actor_id,action,json) VALUES(?,?,?,?)',
      Date.now(),
      actor.id,
      action,
      JSON.stringify(data),
    );
  }
  initializeInbox(id) {
    this.sql.exec(
      'INSERT OR IGNORE INTO inbox(actor_id,seq) SELECT ?,e.seq FROM events e WHERE e.actor_id<>? AND (NOT EXISTS(SELECT 1 FROM recipients r WHERE r.seq=e.seq) OR EXISTS(SELECT 1 FROM recipients r WHERE r.seq=e.seq AND r.actor_id=?))',
      id,
      id,
      id,
    );
    this.sql.exec('INSERT OR IGNORE INTO inbox_initialized(actor_id) VALUES(?)', id);
    this.sql.exec(
      'INSERT OR REPLACE INTO inbox_stats(actor_id,pending,last_ack_at) SELECT ?,COUNT(*),NULL FROM inbox WHERE actor_id=?',
      id,
      id,
    );
  }
  publicActor(actor) {
    return {
      id: actor.id,
      nick: actor.nick,
      role: actor.role,
      verified: true,
      revoked: Boolean(actor.revoked),
      credential_expires_at: actor.expires_at,
    };
  }
  async authenticate(request) {
    const token = request.headers.get('authorization')?.match(/^Bearer (am2_[a-f0-9]{64})$/)?.[1];
    if (!token)
      projectFail(401, 'authentication_required', 'A participant Bearer token is required');
    const hash = await projectHash(token);
    const actor = this.one('SELECT * FROM actors WHERE token_hash=?', hash);
    if (!actor || actor.revoked || actor.expires_at <= Date.now())
      projectFail(401, 'invalid_credential', 'Credential is invalid, expired or revoked');
    return actor;
  }
  owner(actor) {
    if (actor.role !== 'owner')
      projectFail(403, 'owner_required', 'This operation requires the authenticated room owner');
  }
  writer(actor) {
    if (actor.role === 'guest') projectFail(403, 'write_forbidden', 'Guests have read access only');
  }
  async fetch(request) {
    const requestId = request.headers.get('X-Request-ID') || projectId();
    const started = Date.now();
    try {
      const url = new URL(request.url);
      const [, room, ...parts] = url.pathname.split('/');
      const path = '/' + parts.join('/');
      let response;
      if (path === '/bootstrap' && request.method === 'POST')
        response = await this.bootstrap(request, room);
      else {
        let meta = this.meta();
        if (!meta) projectFail(404, 'room_not_found', 'Project room does not exist');
        const actor = await this.authenticate(request);
        // Recheck revocation and role after async JSON/hash operations at each write.
        if (path === '/' && request.method === 'GET')
          response = projectJSON({
            room: meta,
            lifetime: this.lifetimeStatus(meta),
            actor: this.publicActor(actor),
            limits: PROJECT_LIMITS,
            latest_cursor: projectCursor(room, meta.latest_seq),
            request_id: requestId,
          });
        else if (path === '/health' && request.method === 'GET')
          response = projectJSON(this.health(actor));
        else if (path === '/lifetime' && request.method === 'POST')
          response = await this.configureLifetime(request, actor);
        else if (['/archive', '/unarchive'].includes(path) && request.method === 'POST')
          response = await this.archive(request, actor, path === '/archive');
        else if (path === '/participants' && request.method === 'GET')
          response = projectJSON({
            participants: this.rows('SELECT * FROM actors ORDER BY nick').map((a) =>
              this.publicActor(a),
            ),
          });
        else if (path === '/participants' && request.method === 'POST')
          response = await this.addActor(request, actor);
        else if (/^\/participants\/[^/]+\/(revoke|rotate)$/.test(path) && request.method === 'POST')
          response = await this.changeActor(request, actor, parts[1], parts[2]);
        else if (/^\/participants\/[^/]+\/rotate\/confirm$/.test(path) && request.method === 'POST')
          response = await this.confirmRotation(request, actor, parts[1]);
        else if (path === '/messages' && request.method === 'POST')
          response = await this.post(request, actor, room);
        else if (path === '/messages' && request.method === 'GET')
          response = projectJSON(this.page(url, room));
        else if (path === '/inbox' && request.method === 'GET')
          response = projectJSON(await waitForInbox(this, request, url, room, actor));
        else if (path === '/ack' && request.method === 'POST')
          response = await this.acknowledge(request, actor);
        else if (path === '/state' && request.method === 'GET')
          response = projectJSON(this.boardPage(url));
        else if (/^\/state\/[^/]+(?:\/history)?$/.test(path))
          response = await this.stateEntry(
            request,
            actor,
            projectDecode(parts[1]),
            parts[2] === 'history',
            url,
          );
        else if (/^\/holds\/[^/]+(?:\/(?:renew|release|revoke))?$/.test(path))
          response = await this.hold(
            request,
            actor,
            projectDecode(parts[1]),
            parts[2] || 'acquire',
          );
        else if (/^\/messages\/[^/]+$/.test(path) && request.method === 'GET') {
          const row = this.one('SELECT json FROM events WHERE id=?', parts[1]);
          if (!row) projectFail(404, 'message_not_found', 'Message does not exist in this room');
          const original = JSON.parse(row.json);
          response = projectJSON({
            message: original,
            current: projectMessageView(this, original),
          });
        } else if (path === '/export' && request.method === 'GET')
          response = await this.exportPage(url, room);
        else {
          response = await projectRecordRoute(this, request, actor, room, path, parts, url);
          if (!response) projectFail(404, 'not_found', 'Route does not exist');
        }
      }
      if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) notifyInboxWaiters(this);
      if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method))
        console.info({
          event: 'project.operation_completed',
          request_id: requestId,
          room_id: this.state.id.toString(),
          operation: ['bootstrap', 'participants', 'messages', 'ack', 'state', 'holds'].includes(
            parts[0],
          )
            ? parts[0]
            : 'write',
          status: response.status,
          duration_ms: Date.now() - started,
        });
      return new Response(response.body, {
        status: response.status,
        headers: { ...Object.fromEntries(response.headers), 'X-Request-ID': requestId },
      });
    } catch (error) {
      // Small rejected uploads must reach EOF to preserve HTTP keep-alive.
      // Bound both bytes and time; cancelling a larger/slow upload may close it.
      if (request.body && !request.bodyUsed) {
        const reader = request.body.getReader();
        let timeout;
        try {
          await Promise.race([
            (async () => {
              let bytes = 0;
              while (bytes <= PROJECT_LIMITS.request) {
                const { done, value } = await reader.read();
                if (done) return;
                bytes += value.length;
              }
              void reader.cancel().catch(() => {});
            })(),
            new Promise((resolve) => {
              timeout = setTimeout(() => {
                void reader.cancel().catch(() => {});
                resolve();
              }, 500);
            }),
          ]);
        } catch {
        } finally {
          clearTimeout(timeout);
        }
      }
      const expected = error instanceof ProjectError;
      console[expected ? 'warn' : 'error']({
        event: expected ? 'project.rejected' : 'project.failed',
        request_id: requestId,
        room_id: this.state.id.toString(),
        status: expected ? error.status : 500,
        duration_ms: Date.now() - started,
        error_code: expected ? error.code : 'project_storage_or_runtime_failure',
      });
      return projectJSON(
        {
          error: {
            code: expected ? error.code : 'internal_error',
            message: expected ? error.message : 'Project operation failed',
            ...(expected && error.details ? { details: error.details } : {}),
          },
          request_id: requestId,
        },
        expected ? error.status : 500,
        { 'X-Request-ID': requestId },
      );
    }
  }
  current(actor) {
    const current = this.one('SELECT * FROM actors WHERE id=?', actor.id);
    if (
      !current ||
      current.revoked ||
      current.expires_at <= Date.now() ||
      current.token_hash !== actor.token_hash
    )
      projectFail(
        401,
        'invalid_credential',
        'Credential changed while the request was in progress',
      );
    return current;
  }
  async bootstrap(request, room) {
    const body = projectObject(await projectBody(request), ['nick', 'title']);
    const nick = projectNick(body.nick);
    const title = projectString(
      body.title === undefined ? 'Project room' : body.title,
      'title',
      200,
    );
    const token = projectToken();
    const token_hash = await projectHash(token);
    const id = projectId();
    const now = Date.now();
    return this.state.storage.transactionSync(() => {
      if (this.meta())
        projectFail(409, 'already_initialized', 'Project room is already initialized');
      const meta = {
        schema_version: 2,
        id: room,
        title,
        created_at: now,
        created_at_iso: new Date(now).toISOString(),
        owner_id: id,
        latest_seq: 0,
        event_count: 0,
        stored_bytes: 0,
        retention: 'preserved',
        keep: true,
        ttl_hours: 168,
        expires_at: null,
        archived: false,
      };
      this.save(meta);
      this.sql.exec(
        'INSERT INTO actors(id,nick,role,token_hash,expires_at) VALUES(?,?,?,?,?)',
        id,
        nick,
        'owner',
        token_hash,
        now + 90 * 86400000,
      );
      const actor = this.one('SELECT * FROM actors WHERE id=?', id);
      this.audit(actor, 'room.created', {});
      this.initializeInbox(id);
      return projectJSON(
        {
          room: meta,
          participant: this.publicActor(actor),
          token,
          credential_notice:
            'Save this credential now. It is returned only once. Verified room identity does not grant agent execution authority.',
        },
        201,
      );
    });
  }
  async addActor(request, actor) {
    this.owner(actor);
    const body = projectObject(await projectBody(request), ['nick', 'role', 'expires_at']);
    const nick = projectNick(body.nick);
    const role = body.role === undefined ? 'member' : body.role;
    if (!['guest', 'member'].includes(role))
      projectFail(
        400,
        'invalid_role',
        'Invitations support guest or member; owner transfer is not implicit',
      );
    const expires = body.expires_at ?? Date.now() + 90 * 86400000;
    if (
      !Number.isSafeInteger(expires) ||
      expires <= Date.now() ||
      expires > Date.now() + 366 * 86400000
    )
      projectFail(400, 'invalid_expiry', 'Credential expiry must be within the next year');
    const token = projectToken();
    const hash = await projectHash(token);
    const id = projectId();
    return this.state.storage.transactionSync(() => {
      this.owner(this.current(actor));
      if (this.one('SELECT id FROM actors WHERE nick=?', nick))
        projectFail(409, 'nick_taken', 'That nick is already reserved');
      if (this.one('SELECT COUNT(*) AS n FROM actors').n >= PROJECT_LIMITS.actors)
        projectFail(409, 'participant_capacity', 'Participant capacity reached');
      this.sql.exec(
        'INSERT INTO actors(id,nick,role,token_hash,expires_at) VALUES(?,?,?,?,?)',
        id,
        nick,
        role,
        hash,
        expires,
      );
      this.initializeInbox(id);
      this.audit(actor, 'participant.invited', { participant_id: id, role });
      return projectJSON(
        { participant: this.publicActor(this.one('SELECT * FROM actors WHERE id=?', id)), token },
        201,
      );
    });
  }
  async changeActor(request, actor, id, action) {
    if (actor.id !== id) this.owner(actor);
    const body = projectObject(await projectBody(request), []);
    void body;
    const token = projectToken();
    const hash = await projectHash(token);
    return this.state.storage.transactionSync(() => {
      this.current(actor);
      const target = this.one('SELECT * FROM actors WHERE id=?', id);
      if (!target) projectFail(404, 'participant_not_found', 'Participant does not exist');
      if (action === 'revoke' && target.role === 'owner')
        projectFail(409, 'owner_lockout', 'The sole owner cannot be revoked');
      if (action === 'rotate' && target.revoked)
        projectFail(409, 'participant_revoked', 'Revoked participants cannot rotate credentials');
      if (action === 'revoke') this.sql.exec('UPDATE actors SET revoked=1 WHERE id=?', id);
      else
        this.sql.exec(
          'INSERT OR REPLACE INTO rotations(actor_id,token_hash,expires_at) VALUES(?,?,?)',
          id,
          hash,
          Date.now() + 300000,
        );
      this.audit(actor, 'participant.' + (action === 'rotate' ? 'rotation_prepared' : action), {
        participant_id: id,
      });
      return projectJSON({
        participant: this.publicActor(this.one('SELECT * FROM actors WHERE id=?', id)),
        ...(action === 'rotate'
          ? { token, activation_required: true, confirm_path: `/participants/${id}/rotate/confirm` }
          : {}),
      });
    });
  }
  async confirmRotation(request, actor, id) {
    if (actor.id !== id) this.owner(actor);
    const body = projectObject(await projectBody(request), ['token']);
    if (typeof body.token !== 'string' || !/^am2_[a-f0-9]{64}$/.test(body.token))
      projectFail(400, 'invalid_token', 'Supply the prepared credential');
    const hash = await projectHash(body.token);
    return this.state.storage.transactionSync(() => {
      this.current(actor);
      const pending = this.one('SELECT * FROM rotations WHERE actor_id=?', id);
      const target = this.one('SELECT * FROM actors WHERE id=?', id);
      if (
        !pending ||
        pending.token_hash !== hash ||
        pending.expires_at <= Date.now() ||
        !target ||
        target.revoked
      )
        projectFail(
          409,
          'rotation_not_pending',
          'No valid prepared rotation matches this credential',
        );
      this.sql.exec(
        'UPDATE actors SET token_hash=?,expires_at=? WHERE id=?',
        hash,
        Date.now() + 90 * 86400000,
        id,
      );
      this.sql.exec('DELETE FROM rotations WHERE actor_id=?', id);
      this.audit(actor, 'participant.rotation_activated', { participant_id: id });
      return projectJSON({
        participant: this.publicActor(this.one('SELECT * FROM actors WHERE id=?', id)),
        activated: true,
      });
    });
  }
  async post(request, actor, room) {
    this.writer(actor);
    const body = projectObject(await projectBody(request), [
      'text',
      'kind',
      'data',
      'to',
      'reply_to',
      'references',
    ]);
    const text = projectString(
      body.text === undefined ? '' : body.text,
      'text',
      PROJECT_LIMITS.text,
      true,
    );
    const kind = body.kind === undefined ? 'message' : body.kind;
    if (typeof kind !== 'string' || !/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(kind))
      projectFail(400, 'invalid_kind', 'Kind must be a short protocol label');
    const data = body.data ?? null;
    projectString(JSON.stringify(data), 'data', PROJECT_LIMITS.data, true);
    if (!text.trim() && data === null)
      projectFail(400, 'empty_message', 'Provide text or structured data');
    const requestedRecipients = body.to === undefined ? [] : body.to;
    if (
      !Array.isArray(requestedRecipients) ||
      requestedRecipients.length > 50 ||
      requestedRecipients.some((id) => typeof id !== 'string')
    )
      projectFail(
        400,
        'invalid_recipients',
        'to must contain up to 50 distinct participant IDs or @nicks',
      );
    const to = requestedRecipients.map((id) => {
      if (!id.startsWith('@')) return id;
      const actor = this.one('SELECT id FROM actors WHERE nick=? AND revoked=0', id.slice(1));
      if (!actor)
        projectFail(400, 'unknown_recipient', 'Recipient nick is not active in this room');
      return actor.id;
    });
    if (new Set(to).size !== to.length)
      projectFail(400, 'invalid_recipients', 'Recipients must resolve to distinct participants');
    const reply = body.reply_to ?? null;
    if (reply !== null && typeof reply !== 'string')
      projectFail(400, 'invalid_reply', 'reply_to must identify a message in this room');
    const references = body.references === undefined ? [] : body.references;
    if (
      !Array.isArray(references) ||
      references.length > 50 ||
      references.some((r) => typeof r !== 'string' || r.length > 2048 || !/^https:\/\//.test(r))
    )
      projectFail(400, 'invalid_references', 'References must be up to 50 HTTPS links');
    const key = request.headers.get('idempotency-key');
    if (!key || !/^[A-Za-z0-9_.:-]{8,128}$/.test(key))
      projectFail(
        400,
        'idempotency_required',
        'Supply an Idempotency-Key of 8–128 letters, digits, dots, colons, underscores or hyphens',
      );
    const canonical = projectCanonical({
      text,
      kind,
      data,
      to: [...to].sort(),
      reply_to: reply,
      references,
    });
    const fingerprint = await projectHash(canonical);
    const keyHash = await projectHash(key);
    const response = this.state.storage.transactionSync(() => {
      this.writer(this.current(actor));
      const existing = this.one(
        'SELECT * FROM idempotency WHERE actor_id=? AND key_hash=?',
        actor.id,
        keyHash,
      );
      if (existing) {
        if (existing.fingerprint !== fingerprint)
          projectFail(
            409,
            'idempotency_conflict',
            'This key was already used with a different payload',
          );
        return projectJSON({
          message: JSON.parse(
            this.one('SELECT json FROM events WHERE id=?', existing.event_id).json,
          ),
          replayed: true,
        });
      }
      const meta = this.meta();
      const bytes = projectEncoder.encode(canonical).length;
      if (meta.archived)
        projectFail(409, 'room_archived', 'Room is archived; export remains available');
      if (
        meta.event_count >= PROJECT_LIMITS.events ||
        meta.stored_bytes + bytes > PROJECT_LIMITS.bytes
      )
        projectFail(
          409,
          'room_capacity',
          'Room capacity reached; history is preserved. Export before continuing in a successor room.',
          { export: `/v2/rooms/${room}/export`, limits: PROJECT_LIMITS },
        );
      for (const id of to)
        if (!this.one('SELECT id FROM actors WHERE id=? AND revoked=0', id))
          projectFail(
            400,
            'unknown_recipient',
            'Recipient is not an active participant in this room',
          );
      if (reply && !this.one('SELECT id FROM events WHERE id=?', reply))
        projectFail(400, 'invalid_reply', 'Reply target does not exist in this room');
      validateProjectRecord(this, actor, { kind, data, reply_to: reply, to });
      const seq = meta.latest_seq + 1;
      const id = projectId();
      const ts = Date.now();
      const message = {
        schema_version: 2,
        record_schema: kind.startsWith('agentmeet.') ? 1 : null,
        id,
        seq,
        cursor: projectCursor(room, seq),
        actor: { id: actor.id, nick: actor.nick, role: actor.role, verified: true },
        text,
        kind,
        data,
        to,
        reply_to: reply,
        references,
        ts,
        iso: new Date(ts).toISOString(),
      };
      this.sql.exec(
        'INSERT INTO events(seq,id,actor_id,kind,ts,reply_to,bytes,json) VALUES(?,?,?,?,?,?,?,?)',
        seq,
        id,
        actor.id,
        kind,
        ts,
        reply,
        bytes,
        JSON.stringify(message),
      );
      indexProjectRecord(this, actor, message);
      for (const recipient of to)
        this.sql.exec('INSERT INTO recipients(seq,actor_id) VALUES(?,?)', seq, recipient);
      this.sql.exec(
        'INSERT INTO inbox(actor_id,seq) SELECT id,? FROM actors WHERE revoked=0 AND id<>? AND (?=0 OR id IN (SELECT actor_id FROM recipients WHERE seq=?))',
        seq,
        actor.id,
        to.length,
        seq,
      );
      this.sql.exec(
        'UPDATE inbox_stats SET pending=pending+1 WHERE actor_id IN (SELECT actor_id FROM inbox WHERE seq=?)',
        seq,
      );
      this.sql.exec(
        'INSERT INTO idempotency(actor_id,key_hash,fingerprint,event_id) VALUES(?,?,?,?)',
        actor.id,
        keyHash,
        fingerprint,
        id,
      );
      meta.latest_seq = seq;
      meta.event_count++;
      meta.stored_bytes += bytes;
      meta.last_activity = ts;
      if (meta.keep === false) meta.expires_at = ts + meta.ttl_hours * 3600000;
      this.save(meta);
      return projectJSON({ message, replayed: false }, 201);
    });
    const latest = this.meta();
    if (latest.keep === false && !latest.archived)
      await this.state.storage.setAlarm(latest.expires_at);
    return response;
  }
  lifetimeStatus(meta) {
    const expires = meta.keep !== false || meta.archived ? null : meta.expires_at;
    return {
      keep: meta.keep !== false,
      archived: Boolean(meta.archived),
      ttl_hours: meta.ttl_hours || 168,
      expires_at: expires,
      expires_at_iso: expires ? new Date(expires).toISOString() : null,
      retention: 'preserved',
      earliest_cursor: projectCursor(meta.id, 0),
      latest_cursor: projectCursor(meta.id, meta.latest_seq),
      capacity: {
        events: meta.event_count,
        event_limit: PROJECT_LIMITS.events,
        payload_bytes: meta.stored_bytes,
        payload_byte_limit: PROJECT_LIMITS.bytes,
        exhausted:
          meta.event_count >= PROJECT_LIMITS.events || meta.stored_bytes >= PROJECT_LIMITS.bytes,
      },
    };
  }
  health(actor) {
    this.sql.exec('SELECT 1').toArray();
    const meta = this.meta();
    const stats = this.one('SELECT * FROM inbox_stats WHERE actor_id=?', actor.id);
    return {
      status: meta.archived ? 'archived' : 'ok',
      storage: 'ok',
      schema_version: 2,
      checked_at: new Date().toISOString(),
      lifetime: this.lifetimeStatus(meta),
      pending_count: stats.pending,
      last_acknowledged_at: stats.last_ack_at,
      last_acknowledged_at_iso: stats.last_ack_at
        ? new Date(stats.last_ack_at).toISOString()
        : null,
      transport: { wake_integration: 'not_enrolled', receipt: 'unknown' },
      sqlite_bytes: this.sql.databaseSize,
    };
  }
  async configureLifetime(request, actor) {
    this.owner(actor);
    const body = projectObject(await projectBody(request), ['keep', 'ttl_hours']);
    if (
      typeof body.keep !== 'boolean' ||
      (body.ttl_hours !== undefined &&
        (!Number.isInteger(body.ttl_hours) || body.ttl_hours < 1 || body.ttl_hours > 168))
    )
      projectFail(400, 'invalid_lifetime', 'Supply keep and an optional ttl_hours from 1 to 168');
    const response = await this.mutate(
      request,
      actor,
      'lifetime',
      body,
      () => {
        const meta = this.meta();
        meta.keep = body.keep;
        meta.ttl_hours = body.ttl_hours || meta.ttl_hours || 168;
        meta.expires_at = meta.keep || meta.archived ? null : Date.now() + meta.ttl_hours * 3600000;
        this.save(meta);
        this.audit(actor, 'room.lifetime_changed', {
          keep: meta.keep,
          ttl_hours: meta.ttl_hours,
          expires_at: meta.expires_at,
        });
        return { lifetime: this.lifetimeStatus(meta) };
      },
      { allowArchived: true },
    );
    await this.syncAlarm();
    return response;
  }
  async archive(request, actor, archived) {
    this.owner(actor);
    const body = projectObject(await projectBody(request), ['reason']);
    projectString(body.reason, 'reason', 1000);
    const response = await this.mutate(
      request,
      actor,
      archived ? 'archive' : 'unarchive',
      body,
      () => {
        const meta = this.meta();
        meta.archived = archived;
        meta.archived_at = archived ? Date.now() : null;
        meta.expires_at =
          archived || meta.keep !== false ? null : Date.now() + meta.ttl_hours * 3600000;
        this.save(meta);
        this.audit(actor, archived ? 'room.archived' : 'room.unarchived', {
          reason: body.reason,
          archived,
        });
        return { lifetime: this.lifetimeStatus(meta) };
      },
      { allowArchived: true },
    );
    await this.syncAlarm();
    return response;
  }
  async syncAlarm() {
    const meta = this.meta();
    if (meta.keep !== false || meta.archived || !meta.expires_at)
      await this.state.storage.deleteAlarm();
    else await this.state.storage.setAlarm(meta.expires_at);
  }
  async alarm() {
    const meta = this.meta();
    if (!meta || meta.archived || meta.keep !== false || !meta.expires_at) return;
    if (meta.expires_at > Date.now()) {
      await this.state.storage.setAlarm(meta.expires_at);
      return;
    }
    this.state.storage.transactionSync(() => {
      const current = this.meta();
      if (
        !current ||
        current.archived ||
        current.keep !== false ||
        !current.expires_at ||
        current.expires_at > Date.now()
      )
        return;
      current.archived = true;
      current.archived_at = Date.now();
      current.archive_reason = 'inactivity_expiry';
      current.expires_at = null;
      this.save(current);
      this.audit({ id: 'system' }, 'room.archived', {
        reason: 'inactivity_expiry',
        records_preserved: true,
      });
    });
  }
  inbox(url, room, actor) {
    const limit = projectPageSize(url);
    const after = projectSequence(room, url.searchParams.get('cursor'));
    const rows = this.rows(
      'SELECT e.json FROM inbox i JOIN events e ON e.seq=i.seq WHERE i.actor_id=? AND i.seq>? ORDER BY i.seq LIMIT ?',
      actor.id,
      after,
      limit + 1,
    );
    const messages = rows.slice(0, limit).map((r) => JSON.parse(r.json));
    const first = this.one('SELECT seq FROM inbox WHERE actor_id=? ORDER BY seq LIMIT 1', actor.id);
    const highwater = first ? first.seq - 1 : this.meta().latest_seq;
    return {
      messages,
      has_more: rows.length > limit,
      next_cursor: projectCursor(room, messages.at(-1)?.seq ?? after),
      acknowledged_through: projectCursor(room, highwater),
      pending_count: this.one('SELECT pending FROM inbox_stats WHERE actor_id=?', actor.id).pending,
      acknowledgement_required: true,
      lifetime: this.lifetimeStatus(this.meta()),
    };
  }
  async mutate(request, actor, scope, body, apply, options = {}) {
    if (!options.allowGuest) this.writer(actor);
    const key = request.headers.get('idempotency-key');
    if (!key || !/^[A-Za-z0-9_.:-]{8,128}$/.test(key))
      projectFail(
        400,
        'idempotency_required',
        'Supply an Idempotency-Key of 8–128 safe characters',
      );
    const hash = await projectHash(key);
    const fingerprint = await projectHash(
      projectCanonical({ body, precondition: request.headers.get('if-match') }),
    );
    return this.state.storage.transactionSync(() => {
      const currentActor = this.current(actor);
      if (!options.allowGuest) this.writer(currentActor);
      const prior = this.one(
        'SELECT * FROM mutations WHERE actor_id=? AND scope=? AND key_hash=?',
        actor.id,
        scope,
        hash,
      );
      if (prior) {
        if (prior.fingerprint !== fingerprint)
          projectFail(409, 'idempotency_conflict', 'This key was used with a different request');
        return projectJSON({ ...JSON.parse(prior.json), replayed: true });
      }
      if (this.meta().archived && !options.allowArchived)
        projectFail(409, 'room_archived', 'Room is archived');
      const result = apply();
      this.sql.exec(
        'INSERT INTO mutations(actor_id,scope,key_hash,fingerprint,json) VALUES(?,?,?,?,?)',
        actor.id,
        scope,
        hash,
        fingerprint,
        JSON.stringify(result),
      );
      return projectJSON({ ...result, replayed: false });
    });
  }
  async acknowledge(request, actor) {
    const body = projectObject(await projectBody(request), ['message_ids', 'action', 'outcome']);
    const ids = body.message_ids;
    if (
      !Array.isArray(ids) ||
      ids.length < 1 ||
      ids.length > 100 ||
      ids.some((id) => typeof id !== 'string') ||
      new Set(ids).size !== ids.length
    )
      projectFail(400, 'invalid_messages', 'Provide 1–100 distinct message IDs');
    const action = projectString(body.action, 'action', 1000);
    const outcome = body.outcome;
    if (!['handled', 'blocked', 'verified', 'declined'].includes(outcome))
      projectFail(400, 'invalid_outcome', 'Outcome must be handled, blocked, verified or declined');
    return this.mutate(request, actor, 'ack', body, () => {
      const now = Date.now();
      const messages = ids.map((id) => {
        const event = this.one('SELECT seq FROM events WHERE id=?', id);
        if (
          !event ||
          (!this.one('SELECT seq FROM inbox WHERE actor_id=? AND seq=?', actor.id, event.seq) &&
            !this.one(
              'SELECT seq FROM acknowledgements WHERE actor_id=? AND seq=?',
              actor.id,
              event.seq,
            ))
        )
          projectFail(400, 'not_in_inbox', 'Only messages in your own inbox can be acknowledged');
        return event;
      });
      for (const event of messages) {
        this.sql.exec(
          'INSERT OR REPLACE INTO acknowledgements(actor_id,seq,action,outcome,ts) VALUES(?,?,?,?,?)',
          actor.id,
          event.seq,
          action,
          outcome,
          now,
        );
        const removed = this.one(
          'SELECT seq FROM inbox WHERE actor_id=? AND seq=?',
          actor.id,
          event.seq,
        )
          ? 1
          : 0;
        this.sql.exec('DELETE FROM inbox WHERE actor_id=? AND seq=?', actor.id, event.seq);
        this.sql.exec(
          'UPDATE inbox_stats SET pending=pending-?,last_ack_at=? WHERE actor_id=?',
          removed,
          now,
          actor.id,
        );
      }
      const acknowledgement = {
        actor_id: actor.id,
        message_ids: ids,
        action,
        outcome,
        ts: now,
        iso: new Date(now).toISOString(),
      };
      this.audit(actor, 'messages.acknowledged', acknowledgement);
      return { acknowledgement };
    });
  }
  boardKey(key) {
    if (!/^[A-Za-z0-9_.:-]{1,100}$/.test(key))
      projectFail(400, 'invalid_state_key', 'State key must contain 1–100 safe characters');
    return key;
  }
  boardRecord(key) {
    const row = this.one('SELECT json FROM board WHERE key=?', key);
    return row ? JSON.parse(row.json) : null;
  }
  boardWrite(record, actor, action) {
    this.sql.exec(
      'INSERT OR REPLACE INTO board(key,revision,json) VALUES(?,?,?)',
      record.key,
      record.revision,
      JSON.stringify(record),
    );
    this.sql.exec(
      'INSERT INTO board_versions(key,revision,json) VALUES(?,?,?)',
      record.key,
      record.revision,
      JSON.stringify(record),
    );
    this.audit(actor, action, record);
    return record;
  }
  boardVisible(record) {
    return { ...record, expired: record.expires_at !== null && record.expires_at <= Date.now() };
  }
  boardPage(url) {
    const limit = projectPageSize(url);
    const after = url.searchParams.get('after') || '';
    const rows = this.rows(
      'SELECT json FROM board WHERE key>? ORDER BY key LIMIT ?',
      after,
      limit + 1,
    );
    const entries = rows.slice(0, limit).map((r) => this.boardVisible(JSON.parse(r.json)));
    return { entries, has_more: rows.length > limit, next_after: entries.at(-1)?.key || after };
  }
  precondition(request, current) {
    const header = request.headers.get('if-match');
    if (!header)
      projectFail(
        428,
        'precondition_required',
        'Supply If-Match with the quoted current revision ("0" to create)',
      );
    const match = header.match(/^(?:"(0|[1-9][0-9]*)"|(0|[1-9][0-9]*))$/);
    const revision = match ? Number(match[1] ?? match[2]) : NaN;
    if (!Number.isSafeInteger(revision) || revision !== (current?.revision || 0))
      projectFail(
        412,
        'revision_conflict',
        'State changed; read the current revision before retrying',
        { revision: current?.revision || 0 },
      );
  }
  async stateEntry(request, actor, key, history, url) {
    this.boardKey(key);
    if (request.method === 'GET') {
      if (history) {
        const after = Number(url.searchParams.get('after') || 0);
        if (!Number.isSafeInteger(after) || after < 0)
          projectFail(400, 'invalid_cursor', 'History after must be a nonnegative revision');
        const rows = this.rows(
          'SELECT json FROM board_versions WHERE key=? AND revision>? ORDER BY revision LIMIT ?',
          key,
          after,
          projectPageSize(url) + 1,
        );
        const entries = rows.slice(0, projectPageSize(url)).map((r) => JSON.parse(r.json));
        return projectJSON({
          entries,
          has_more: rows.length > projectPageSize(url),
          next_after: entries.at(-1)?.revision || after,
        });
      }
      const entry = this.boardRecord(key);
      if (!entry) projectFail(404, 'state_not_found', 'State entry does not exist');
      return projectJSON({ entry: this.boardVisible(entry) }, 200, {
        ETag: '"' + entry.revision + '"',
      });
    }
    if (history || !['PUT', 'DELETE'].includes(request.method))
      projectFail(405, 'method_not_allowed', 'Use GET, PUT or DELETE');
    if (key.startsWith('hold:'))
      projectFail(403, 'reserved_key', 'Use the hold endpoint for scoped holds');
    if (key.startsWith('role:')) this.owner(actor);
    if (
      key.startsWith('status:') &&
      key !== 'status:' + actor.id &&
      !(request.method === 'DELETE' && actor.role === 'owner')
    )
      projectFail(403, 'status_author_required', 'Only a participant may set their own status');
    const body = projectObject(
      await projectBody(request),
      request.method === 'DELETE' ? [] : ['value', 'kind', 'expires_at'],
    );
    if (request.method === 'PUT' && !Object.hasOwn(body, 'value'))
      projectFail(400, 'value_required', 'State value is required');
    const expires = body.expires_at ?? null;
    if (
      body.kind !== undefined &&
      (typeof body.kind !== 'string' || !/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(body.kind))
    )
      projectFail(400, 'invalid_kind', 'State kind must be a short label');
    if (
      (body.kind === 'role' && !key.startsWith('role:')) ||
      (body.kind === 'status' && !key.startsWith('status:'))
    )
      projectFail(403, 'reserved_kind', 'Role and status kinds require their scoped keys');
    projectString(JSON.stringify(body.value ?? null), 'value', PROJECT_LIMITS.data, true);
    return this.mutate(request, actor, 'state:' + key, { method: request.method, ...body }, () => {
      if (
        expires !== null &&
        (!Number.isSafeInteger(expires) ||
          expires <= Date.now() ||
          expires > Date.now() + 366 * 86400000)
      )
        projectFail(400, 'invalid_expiry', 'State expiry must be within the next year');
      const current = this.boardRecord(key);
      this.precondition(request, current);
      const scopedRole = key.startsWith('role:');
      const scopedStatus = key.startsWith('status:');
      if (request.method === 'PUT' && scopedRole) {
        projectObject(body.value, ['actor_id', 'description', 'advisory']);
        projectString(body.value.description, 'description', 2000);
        if (
          typeof body.value.actor_id !== 'string' ||
          !this.one('SELECT id FROM actors WHERE id=? AND revoked=0', body.value.actor_id)
        )
          projectFail(400, 'unknown_actor', 'Role holder must be an active room participant');
      }
      if (request.method === 'PUT' && scopedStatus) {
        projectObject(body.value, ['text', 'eta', 'blocked_by']);
        projectString(body.value.text, 'text', 1000);
        if (body.value.eta !== undefined && !Number.isSafeInteger(body.value.eta))
          projectFail(400, 'invalid_eta', 'ETA must be an epoch timestamp');
        if (
          body.value.blocked_by !== undefined &&
          (typeof body.value.blocked_by !== 'string' ||
            !this.one('SELECT id FROM actors WHERE id=?', body.value.blocked_by))
        )
          projectFail(400, 'unknown_actor', 'Blocking actor must belong to this room');
      }
      if (current && current.author_id !== actor.id && actor.role !== 'owner' && !scopedStatus)
        projectFail(
          403,
          'state_author_required',
          'Only the author or room owner may edit this state',
        );
      const entry = {
        key,
        revision: (current?.revision || 0) + 1,
        author_id: scopedStatus
          ? key.slice('status:'.length)
          : scopedRole
            ? actor.id
            : current?.author_id || actor.id,
        changed_by: actor.id,
        kind: scopedRole ? 'role' : scopedStatus ? 'status' : body.kind || current?.kind || 'fact',
        value:
          request.method === 'DELETE'
            ? null
            : scopedRole
              ? { ...body.value, advisory: true }
              : body.value,
        ...(scopedRole || scopedStatus ? { record_schema: 1, attested_by: actor.id } : {}),
        expires_at: expires,
        deleted: request.method === 'DELETE',
        ts: Date.now(),
      };
      return {
        entry: this.boardWrite(entry, actor, entry.deleted ? 'state.deleted' : 'state.updated'),
      };
    });
  }
  async hold(request, actor, scope, action) {
    this.boardKey(scope);
    const key = 'hold:' + scope;
    if (request.method === 'GET') {
      const entry = this.boardRecord(key);
      if (!entry) projectFail(404, 'hold_not_found', 'Hold does not exist');
      return projectJSON({ hold: this.boardVisible(entry), advisory: true });
    }
    if (request.method !== 'POST') projectFail(405, 'method_not_allowed', 'Use GET or POST');
    const body = projectObject(await projectBody(request), ['reason', 'lease_until']);
    const reason = projectString(body.reason, 'reason', 1000);
    return this.mutate(request, actor, 'hold:' + scope + ':' + action, body, () => {
      if (
        ['acquire', 'renew'].includes(action) &&
        (!Number.isSafeInteger(body.lease_until) ||
          body.lease_until <= Date.now() ||
          body.lease_until > Date.now() + 86400000)
      )
        projectFail(400, 'invalid_lease', 'Lease must end within the next 24 hours');
      const current = this.boardRecord(key);
      const now = Date.now();
      const active = current && !current.deleted && current.expires_at > now;
      if (action === 'acquire') {
        if (active)
          projectFail(409, 'hold_conflict', 'Resource is already held', {
            holder: current.author_id,
            expires_at: current.expires_at,
            revision: current.revision,
          });
      } else {
        this.precondition(request, current);
        if (!current) projectFail(404, 'hold_not_found', 'Hold does not exist');
        if (action === 'revoke') this.owner(actor);
        else if (current.author_id !== actor.id)
          projectFail(403, 'hold_owner_required', 'Only the current holder may renew or release');
        if (action === 'renew' && !active)
          projectFail(409, 'hold_expired', 'Expired/released holds must be acquired again');
      }
      const entry = {
        key,
        revision: (current?.revision || 0) + 1,
        author_id: action === 'acquire' ? actor.id : current.author_id,
        changed_by: actor.id,
        kind: 'hold',
        value: { scope, reason, advisory: true },
        expires_at: ['release', 'revoke'].includes(action) ? now : body.lease_until,
        deleted: ['release', 'revoke'].includes(action),
        ts: now,
      };
      return { hold: this.boardWrite(entry, actor, 'hold.' + action), advisory: true };
    });
  }
  page(url, room, snapshot) {
    const after = projectSequence(room, url.searchParams.get('cursor'));
    const limit = projectPageSize(url);
    const meta = this.meta();
    const until = snapshot ?? meta.latest_seq;
    const backwards =
      snapshot === undefined &&
      (url.searchParams.get('tail') === 'true' || url.searchParams.has('before'));
    if (backwards && url.searchParams.has('cursor'))
      projectFail(400, 'mixed_cursors', 'Use either cursor or before/tail');
    const before = url.searchParams.has('before')
      ? projectSequence(room, url.searchParams.get('before'))
      : until + 1;
    if (backwards && before > until + 1)
      projectFail(409, 'cursor_ahead', 'Cursor is ahead of available history');
    if (after > until) projectFail(409, 'cursor_ahead', 'Cursor is ahead of the available history');
    const conditions = ['e.seq>?', 'e.seq<=?'];
    const values = [after, until];
    if (backwards) {
      conditions.push('e.seq<?');
      values.push(before);
    }
    const kind = url.searchParams.get('kind');
    if (kind) {
      conditions.push('e.kind=?');
      values.push(kind);
    }
    const recipient = url.searchParams.get('for');
    if (recipient) {
      conditions.push(
        '(NOT EXISTS(SELECT 1 FROM recipients r WHERE r.seq=e.seq) OR EXISTS(SELECT 1 FROM recipients r WHERE r.seq=e.seq AND r.actor_id=?))',
      );
      values.push(recipient);
    }
    const rows = this.rows(
      `SELECT e.seq,e.json FROM events e WHERE ${conditions.join(' AND ')} ORDER BY e.seq ${backwards ? 'DESC' : 'ASC'} LIMIT ?`,
      ...values,
      limit + 1,
    );
    const has_more = rows.length > limit;
    const selected = rows.slice(0, limit);
    if (backwards) selected.reverse();
    const messages = selected.map((r) => {
      const original = JSON.parse(r.json);
      return snapshot === undefined
        ? { ...original, current: projectMessageView(this, original) }
        : original;
    });
    return {
      messages,
      next_cursor: projectCursor(room, !backwards && has_more ? messages.at(-1).seq : until),
      has_more: !backwards && has_more,
      ...(backwards
        ? { has_older: has_more, older_cursor: projectCursor(room, messages[0]?.seq ?? before) }
        : {}),
      snapshot_seq: until,
      retention: meta.retention,
      lifetime: this.lifetimeStatus(meta),
    };
  }
  async exportPage(url, room) {
    if (url.searchParams.get('section') === 'coordination') {
      const latest = this.one('SELECT COALESCE(MAX(seq),0) AS n FROM audit').n;
      const snapshot = url.searchParams.has('snapshot')
        ? Number(url.searchParams.get('snapshot'))
        : latest;
      const after = Number(url.searchParams.get('after') || 0);
      if (
        !Number.isSafeInteger(snapshot) ||
        snapshot < 0 ||
        snapshot > latest ||
        !Number.isSafeInteger(after) ||
        after < 0 ||
        after > snapshot
      )
        projectFail(400, 'invalid_snapshot', 'Coordination export cursor is invalid');
      const limit = projectPageSize(url);
      const rows = this.rows(
        'SELECT * FROM audit WHERE seq>? AND seq<=? ORDER BY seq LIMIT ?',
        after,
        snapshot,
        limit + 1,
      );
      const records = rows.slice(0, limit).map((r) => ({
        seq: r.seq,
        ts: r.ts,
        actor_id: r.actor_id,
        action: r.action,
        data: JSON.parse(r.json),
      }));
      const content = {
        schema_version: 2,
        section: 'coordination',
        room_id: room,
        snapshot_seq: snapshot,
        records,
        next_after: records.at(-1)?.seq || after,
        has_more: rows.length > limit,
      };
      return projectJSON({
        ...content,
        checksum: {
          algorithm: 'SHA-256',
          encoding: 'canonical-json',
          value: await projectHash(projectCanonical(content)),
        },
      });
    }
    if (url.searchParams.has('section') && url.searchParams.get('section') !== 'messages')
      projectFail(400, 'invalid_section', 'Export section must be messages or coordination');
    const requested = url.searchParams.get('snapshot');
    const latest = this.meta().latest_seq;
    const snapshot = requested === null ? latest : Number(requested);
    if (!Number.isSafeInteger(snapshot) || snapshot < 0 || snapshot > latest)
      projectFail(400, 'invalid_snapshot', 'Snapshot must refer to an available sequence');
    if (url.searchParams.has('kind') || url.searchParams.has('for'))
      projectFail(400, 'filtered_export', 'Exports must include complete history');
    const page = this.page(url, room, snapshot);
    const totals = this.one(
      'SELECT COUNT(*) AS count, COALESCE(SUM(bytes),0) AS bytes FROM events WHERE seq<=?',
      snapshot,
    );
    const content = {
      schema_version: 2,
      coordination_export: `/v2/rooms/${room}/export?section=coordination&snapshot=${this.one('SELECT COALESCE(MAX(seq),0) AS n FROM audit').n}`,
      room: {
        ...this.meta(),
        latest_seq: snapshot,
        event_count: totals.count,
        stored_bytes: totals.bytes,
      },
      participants: this.rows('SELECT * FROM actors ORDER BY id').map((a) => this.publicActor(a)),
      ...page,
    };
    return projectJSON({
      ...content,
      checksum: {
        algorithm: 'SHA-256',
        encoding: 'canonical-json',
        value: await projectHash(projectCanonical(content)),
      },
    });
  }
}
