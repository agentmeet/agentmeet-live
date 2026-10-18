import {
  projectFail,
  projectJSON,
  projectObject,
  projectString,
  projectBody,
  projectPageSize,
  projectSequence,
  projectCursor,
  projectDecode,
} from './project-protocol.js';
const hashPattern = /^[a-fA-F0-9]{64}$/;
const requestStates = ['requested', 'delivered', 'verified', 'blocked', 'cancelled'];
function recordLink(room, id) {
  return `/project?room=${encodeURIComponent(room)}#${encodeURIComponent(id)}`;
}
function recordData(value, allowed) {
  return projectObject(value, allowed);
}
function requiredHash(value, name) {
  if (typeof value !== 'string' || !hashPattern.test(value))
    projectFail(400, 'invalid_hash', `${name} must be a SHA-256 hex digest`);
}
function httpsURL(value) {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}
function message(room, id) {
  if (typeof id !== 'string' || !id)
    projectFail(400, 'invalid_message_id', 'A message ID is required');
  const row = room.one('SELECT * FROM events WHERE id=?', id);
  if (!row) projectFail(404, 'message_not_found', 'Message does not exist in this room');
  return { ...row, message: JSON.parse(row.json) };
}

export function initializeProjectRecords(room) {
  room.sql.exec(`
    CREATE TABLE IF NOT EXISTS features(name TEXT PRIMARY KEY,version INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS pins(message_id TEXT PRIMARY KEY,name TEXT NOT NULL,seq INTEGER NOT NULL,json TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS pins_history ON pins(name,seq);
    CREATE TABLE IF NOT EXISTS pins_latest(name TEXT PRIMARY KEY,seq INTEGER NOT NULL,json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS requests(message_id TEXT PRIMARY KEY,state TEXT NOT NULL,revision INTEGER NOT NULL,updated_at INTEGER NOT NULL,json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS request_versions(message_id TEXT NOT NULL,revision INTEGER NOT NULL,json TEXT NOT NULL,PRIMARY KEY(message_id,revision));
    CREATE INDEX IF NOT EXISTS requests_state ON requests(state,updated_at);
    CREATE TABLE IF NOT EXISTS decisions(message_id TEXT PRIMARY KEY,selected_message_id TEXT,expires_at INTEGER NOT NULL,json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS message_revisions(target_id TEXT NOT NULL,seq INTEGER NOT NULL,message_id TEXT NOT NULL,PRIMARY KEY(target_id,seq));
    CREATE TABLE IF NOT EXISTS thread_members(message_id TEXT PRIMARY KEY,root_id TEXT NOT NULL,seq INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS thread_range ON thread_members(root_id,seq);
    CREATE TABLE IF NOT EXISTS receipts(message_id TEXT NOT NULL,actor_id TEXT NOT NULL,first_seen_at INTEGER NOT NULL,last_seen_at INTEGER NOT NULL,PRIMARY KEY(message_id,actor_id));
    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(text,data,message_id UNINDEXED);
  `);
  room.state.storage.transactionSync(() => {
    if (!room.one("SELECT version FROM features WHERE name='search'")) {
      room.sql.exec(
        "INSERT INTO messages_fts(rowid,text,data,message_id) SELECT seq,json_extract(json,'$.text'),json_extract(json,'$.data'),id FROM events",
      );
      room.sql.exec("INSERT INTO features(name,version) VALUES('search',1)");
    }
    if (!room.one("SELECT version FROM features WHERE name='threads'")) {
      room.sql.exec(
        'INSERT INTO thread_members(message_id,root_id,seq) WITH RECURSIVE paths(id,root,seq) AS (SELECT id,id,seq FROM events WHERE reply_to IS NULL UNION ALL SELECT e.id,p.root,e.seq FROM events e JOIN paths p ON e.reply_to=p.id) SELECT id,root,seq FROM paths',
      );
      room.sql.exec(
        'INSERT OR IGNORE INTO thread_members(message_id,root_id,seq) SELECT id,id,seq FROM events',
      );
      room.sql.exec("INSERT INTO features(name,version) VALUES('threads',1)");
    }
  });
}

export function validateProjectRecord(room, actor, record) {
  const { kind, data, reply_to } = record;
  if (!kind.startsWith('agentmeet.')) return;
  if (kind === 'agentmeet.pin') {
    recordData(data, ['name', 'version', 'sha256', 'url']);
    projectString(data.name, 'name', 128);
    projectString(data.version, 'version', 128);
    requiredHash(data.sha256, 'sha256');
    if (!httpsURL(data.url)) projectFail(400, 'invalid_url', 'Pin URL must use HTTPS');
    const existing = room.one('SELECT json FROM pins_latest WHERE name=?', data.name);
    if (existing && JSON.parse(existing.json).actor_id !== actor.id && actor.role !== 'owner')
      projectFail(
        403,
        'pin_publisher_required',
        'Only the original publisher or room owner may publish a successor for this pin name',
      );
  } else if (kind === 'agentmeet.material') {
    recordData(data, [
      'settlement_id',
      'version',
      'generator_commit',
      'manifest_sha256',
      'maps',
      'frame_sha256',
      'reference_photo_ids',
      'checks',
      'known_gaps',
    ]);
    projectString(data.settlement_id, 'settlement_id', 128);
    projectString(data.version, 'version', 128);
    if (data.generator_commit !== undefined)
      projectString(data.generator_commit, 'generator_commit', 128);
    requiredHash(data.manifest_sha256, 'manifest_sha256');
    if (data.frame_sha256 !== undefined) requiredHash(data.frame_sha256, 'frame_sha256');
    if (!Array.isArray(data.maps) || data.maps.length > 200 || data.maps.length < 1)
      projectFail(400, 'invalid_maps', 'Provide 1–200 map records');
    for (const map of data.maps) {
      recordData(map, ['name', 'sha256', 'url']);
      projectString(map.name, 'map name', 128);
      requiredHash(map.sha256, 'map sha256');
      if (map.url !== undefined && !httpsURL(map.url))
        projectFail(400, 'invalid_url', 'Map URL must use HTTPS');
    }
    for (const field of ['reference_photo_ids', 'checks', 'known_gaps'])
      if (
        data[field] !== undefined &&
        (!Array.isArray(data[field]) ||
          data[field].some((v) => typeof v !== 'string') ||
          data[field].length > 200)
      )
        projectFail(400, 'invalid_material', 'Material lists must contain up to 200 strings');
  } else if (kind === 'agentmeet.request') {
    recordData(data, ['subject', 'acceptance', 'due_at']);
    projectString(data.subject, 'subject', 200);
    if (data.acceptance !== undefined) projectString(data.acceptance, 'acceptance', 4000);
    if (
      data.due_at !== undefined &&
      (!Number.isSafeInteger(data.due_at) || data.due_at <= Date.now())
    )
      projectFail(400, 'invalid_due_at', 'due_at must be a future epoch timestamp');
  } else if (kind === 'agentmeet.decision.request') {
    recordData(data, ['action', 'scope', 'options', 'recommended', 'expires_at']);
    projectString(data.action, 'action', 1000);
    projectString(data.scope, 'scope', 1000);
    if (!Array.isArray(data.options) || data.options.length < 2 || data.options.length > 8)
      projectFail(400, 'invalid_options', 'Provide 2–8 decision options');
    for (const option of data.options) {
      recordData(option, ['id', 'label', 'description']);
      projectString(option.id, 'option id', 64);
      projectString(option.label, 'option label', 200);
      if (option.description !== undefined)
        projectString(option.description, 'option description', 1000);
    }
    if (new Set(data.options.map((o) => o.id)).size !== data.options.length)
      projectFail(400, 'duplicate_options', 'Decision option IDs must be distinct');
    if (data.recommended !== undefined && !data.options.some((o) => o.id === data.recommended))
      projectFail(400, 'invalid_recommendation', 'Recommended option must exist');
    if (
      !Number.isSafeInteger(data.expires_at) ||
      data.expires_at <= Date.now() ||
      data.expires_at > Date.now() + 366 * 86400000
    )
      projectFail(400, 'invalid_expiry', 'Decision expiry must be within the next year');
  } else if (kind === 'agentmeet.decision.selected') {
    room.owner(actor);
    recordData(data, ['request_id', 'option_id', 'rationale']);
    if (data.rationale !== undefined) projectString(data.rationale, 'rationale', 2000);
    projectString(data.request_id, 'request_id', 64);
    projectString(data.option_id, 'option_id', 64);
    const decision = room.one('SELECT * FROM decisions WHERE message_id=?', data.request_id);
    if (!decision || reply_to !== data.request_id)
      projectFail(400, 'invalid_decision', 'Reply to an existing decision request');
    if (decision.selected_message_id)
      projectFail(409, 'decision_already_selected', 'Decision already has an immutable selection');
    if (decision.expires_at <= Date.now())
      projectFail(409, 'decision_expired', 'Decision request has expired');
    if (!JSON.parse(decision.json).options.some((o) => o.id === data.option_id))
      projectFail(400, 'invalid_option', 'Selected option does not exist');
  } else if (['agentmeet.message.edit', 'agentmeet.message.retract'].includes(kind)) {
    recordData(
      data,
      kind.endsWith('.edit') ? ['target_id', 'text', 'reason'] : ['target_id', 'reason'],
    );
    const original = message(room, data.target_id);
    if (original.actor_id !== actor.id)
      projectFail(403, 'message_author_required', 'Only the original author may edit or retract');
    if (
      original.kind.startsWith('agentmeet.decision.') ||
      original.kind.startsWith('agentmeet.message.') ||
      original.kind === 'agentmeet.pin'
    )
      projectFail(
        409,
        'immutable_record',
        'Pins, decisions and revision records are immutable; publish a successor record',
      );
    if (reply_to !== data.target_id)
      projectFail(400, 'invalid_revision', 'Revision must reply to its target');
    projectString(data.reason, 'reason', 1000);
    if (kind.endsWith('.edit')) projectString(data.text, 'text', 32768);
  } else
    projectFail(
      400,
      'reserved_kind',
      'Unknown agentmeet.* kind; custom protocols must use another namespace',
    );
}

export function indexProjectRecord(room, actor, event) {
  const root = event.reply_to
    ? room.one('SELECT root_id FROM thread_members WHERE message_id=?', event.reply_to)?.root_id
    : event.id;
  room.sql.exec(
    'INSERT INTO thread_members(message_id,root_id,seq) VALUES(?,?,?)',
    event.id,
    root || event.id,
    event.seq,
  );
  room.sql.exec(
    'INSERT INTO messages_fts(rowid,text,data,message_id) VALUES(?,?,?,?)',
    event.seq,
    event.text,
    JSON.stringify(event.data),
    event.id,
  );
  if (event.kind === 'agentmeet.pin') {
    const pin = {
      ...event.data,
      message_id: event.id,
      actor_id: actor.id,
      seq: event.seq,
      ts: event.ts,
      verification: 'producer_assertion',
    };
    room.sql.exec(
      'INSERT INTO pins(message_id,name,seq,json) VALUES(?,?,?,?)',
      event.id,
      pin.name,
      event.seq,
      JSON.stringify(pin),
    );
    room.sql.exec(
      'INSERT OR REPLACE INTO pins_latest(name,seq,json) VALUES(?,?,?)',
      pin.name,
      event.seq,
      JSON.stringify(pin),
    );
  } else if (event.kind === 'agentmeet.request') {
    const record = {
      message_id: event.id,
      requester_id: actor.id,
      producer_ids: event.to,
      state: 'requested',
      revision: 1,
      subject: event.data.subject,
      acceptance: event.data.acceptance || null,
      updated_at: event.ts,
    };
    room.sql.exec(
      'INSERT INTO requests(message_id,state,revision,updated_at,json) VALUES(?,?,?,?,?)',
      event.id,
      'requested',
      1,
      event.ts,
      JSON.stringify(record),
    );
    room.sql.exec(
      'INSERT INTO request_versions(message_id,revision,json) VALUES(?,?,?)',
      event.id,
      1,
      JSON.stringify(record),
    );
    room.audit(actor, 'request.created', record);
  } else if (event.kind === 'agentmeet.decision.request') {
    room.sql.exec(
      'INSERT INTO decisions(message_id,expires_at,json) VALUES(?,?,?)',
      event.id,
      event.data.expires_at,
      JSON.stringify({ ...event.data, requester_id: actor.id }),
    );
  } else if (event.kind === 'agentmeet.decision.selected') {
    room.sql.exec(
      'UPDATE decisions SET selected_message_id=? WHERE message_id=?',
      event.id,
      event.data.request_id,
    );
    room.audit(actor, 'decision.selected', {
      request_id: event.data.request_id,
      selection_message_id: event.id,
      option_id: event.data.option_id,
      authority: 'authenticated_room_owner_credential',
      execution_authorization: false,
    });
  } else if (event.kind.startsWith('agentmeet.message.')) {
    room.sql.exec(
      'INSERT INTO message_revisions(target_id,seq,message_id) VALUES(?,?,?)',
      event.data.target_id,
      event.seq,
      event.id,
    );
    room.audit(actor, event.kind, { message_id: event.id, ...event.data });
  }
}

export async function projectRecordRoute(room, request, actor, id, path, parts, url) {
  if (path === '/pins' && request.method === 'GET') {
    if (url.searchParams.has('name')) {
      const name = projectString(url.searchParams.get('name'), 'name', 128);
      const after = projectSequence(id, url.searchParams.get('cursor'));
      const limit = projectPageSize(url);
      const rows = room.rows(
        'SELECT seq,json FROM pins WHERE name=? AND seq>? ORDER BY seq LIMIT ?',
        name,
        after,
        limit + 1,
      );
      return projectJSON({
        pins: rows
          .slice(0, limit)
          .map((r) => ({
            ...JSON.parse(r.json),
            evidence: recordLink(id, JSON.parse(r.json).message_id),
          })),
        has_more: rows.length > limit,
        next_cursor: projectCursor(id, rows.slice(0, limit).at(-1)?.seq ?? after),
      });
    }
    const limit = projectPageSize(url),
      after = url.searchParams.get('after') || '';
    const rows = room.rows(
        'SELECT name,json FROM pins_latest WHERE name>? ORDER BY name LIMIT ?',
        after,
        limit + 1,
      ),
      pins = rows.slice(0, limit).map((r) => ({
        ...JSON.parse(r.json),
        evidence: recordLink(id, JSON.parse(r.json).message_id),
      }));
    return projectJSON({
      pins,
      has_more: rows.length > limit,
      next_after: pins.at(-1)?.name || after,
    });
  }
  if (path === '/search' && request.method === 'GET') {
    const q = projectString(url.searchParams.get('q'), 'q', 200),
      limit = projectPageSize(url);
    const before = url.searchParams.get('cursor')
      ? projectSequence(id, url.searchParams.get('cursor'))
      : room.meta().latest_seq + 1;
    const query = q
      .trim()
      .split(/\s+/)
      .map((word) => '"' + word.replaceAll('"', '""') + '"')
      .join(' AND ');
    const rows = room.rows(
      'SELECT e.json FROM messages_fts JOIN events e ON e.seq=messages_fts.rowid WHERE messages_fts MATCH ? AND e.seq<? ORDER BY e.seq DESC LIMIT ?',
      query,
      before,
      limit + 1,
    );
    const messages = rows.slice(0, limit).map((r) => {
      const original = JSON.parse(r.json);
      return { ...original, current: projectMessageView(room, original) };
    });
    return projectJSON({
      messages,
      has_more: rows.length > limit,
      next_cursor: projectCursor(id, messages.at(-1)?.seq || 0),
    });
  }
  if (path === '/requests' && request.method === 'GET') {
    const state = url.searchParams.get('state');
    if (state && !requestStates.includes(state))
      projectFail(400, 'invalid_state', 'Unknown request state');
    const limit = projectPageSize(url),
      after = url.searchParams.get('after') || '';
    const rows = room.rows(
      `SELECT message_id,json FROM requests WHERE message_id>? ${state ? 'AND state=?' : ''} ORDER BY message_id LIMIT ?`,
      after,
      ...(state ? [state] : []),
      limit + 1,
    );
    const records = rows
      .slice(0, limit)
      .map((r) => ({ ...JSON.parse(r.json), evidence: recordLink(id, r.message_id) }));
    return projectJSON({
      requests: records,
      has_more: rows.length > limit,
      next_after: records.at(-1)?.message_id || after,
    });
  }
  if (/^\/requests\/[^/]+\/history$/.test(path) && request.method === 'GET') {
    const after = Number(url.searchParams.get('after') || 0),
      limit = projectPageSize(url);
    if (!Number.isSafeInteger(after) || after < 0)
      projectFail(400, 'invalid_cursor', 'after must be a nonnegative revision');
    const rows = room.rows(
        'SELECT json FROM request_versions WHERE message_id=? AND revision>? ORDER BY revision LIMIT ?',
        parts[1],
        after,
        limit + 1,
      ),
      entries = rows.slice(0, limit).map((r) => JSON.parse(r.json));
    return projectJSON({
      entries,
      has_more: rows.length > limit,
      next_after: entries.at(-1)?.revision || after,
    });
  }
  if (/^\/requests\/[^/]+\/transition$/.test(path) && request.method === 'POST') {
    const body = projectObject(await projectBody(request), ['state', 'reason', 'evidence_ids']);
    if (!requestStates.includes(body.state))
      projectFail(400, 'invalid_state', 'Unknown request state');
    projectString(body.reason, 'reason', 2000);
    if (
      !Array.isArray(body.evidence_ids) ||
      body.evidence_ids.length > 20 ||
      body.evidence_ids.some((v) => typeof v !== 'string')
    )
      projectFail(400, 'invalid_evidence', 'Provide up to 20 message IDs as evidence');
    return room.mutate(request, actor, 'request:' + parts[1], body, () => {
      const row = room.one('SELECT * FROM requests WHERE message_id=?', parts[1]);
      if (!row) projectFail(404, 'request_not_found', 'Request does not exist');
      const current = JSON.parse(row.json);
      room.precondition(request, current);
      const requester = current.requester_id === actor.id,
        producer = current.producer_ids.length === 0 || current.producer_ids.includes(actor.id);
      if (body.state === 'verified' && !requester)
        projectFail(
          403,
          'consumer_verification_required',
          'Only the requesting consumer can verify delivery',
        );
      if (body.state === 'delivered' && !producer)
        projectFail(403, 'producer_required', 'Only an addressed producer can deliver');
      if (['requested', 'cancelled'].includes(body.state) && !requester && actor.role !== 'owner')
        projectFail(403, 'requester_required', 'Only the requester or owner can reopen/cancel');
      if (body.state === 'blocked' && !requester && !producer)
        projectFail(
          403,
          'participant_required',
          'Only the requester or producer can report blocked',
        );
      if (body.state === 'verified' && current.state !== 'delivered')
        projectFail(
          409,
          'delivery_required',
          'A producer must deliver before the consumer verifies',
        );
      if (body.state === 'delivered' && ['verified', 'cancelled'].includes(current.state))
        projectFail(409, 'request_closed', 'Reopen the request before another delivery');
      if (['delivered', 'verified'].includes(body.state) && body.evidence_ids.length === 0)
        projectFail(
          400,
          'evidence_required',
          'Delivery and verification require linked message evidence',
        );
      for (const evidence of body.evidence_ids) message(room, evidence);
      const next = {
        ...current,
        state: body.state,
        revision: current.revision + 1,
        changed_by: actor.id,
        reason: body.reason,
        evidence_ids: body.evidence_ids,
        updated_at: Date.now(),
      };
      room.sql.exec(
        'UPDATE requests SET state=?,revision=?,updated_at=?,json=? WHERE message_id=?',
        next.state,
        next.revision,
        next.updated_at,
        JSON.stringify(next),
        parts[1],
      );
      room.sql.exec(
        'INSERT INTO request_versions(message_id,revision,json) VALUES(?,?,?)',
        parts[1],
        next.revision,
        JSON.stringify(next),
      );
      room.audit(actor, 'request.transitioned', next);
      return { request: next };
    });
  }
  if (/^\/threads\/[^/]+$/.test(path) && request.method === 'GET') {
    message(room, parts[1]);
    const root = message(
      room,
      room.one('SELECT root_id FROM thread_members WHERE message_id=?', parts[1]).root_id,
    );
    const after = projectSequence(id, url.searchParams.get('cursor')),
      limit = projectPageSize(url);
    const rows = room.rows(
      'SELECT e.json FROM thread_members t JOIN events e ON e.id=t.message_id WHERE t.root_id=? AND t.seq>? ORDER BY t.seq LIMIT ?',
      root.id,
      after,
      limit + 1,
    );
    const messages = rows.slice(0, limit).map((r) => JSON.parse(r.json));
    const requestState = room.one('SELECT json FROM requests WHERE message_id=?', root.id);
    return projectJSON({
      root: root.message,
      messages,
      request: requestState ? JSON.parse(requestState.json) : null,
      has_more: rows.length > limit,
      next_cursor: projectCursor(id, messages.at(-1)?.seq || after),
    });
  }
  if (path === '/decisions' && request.method === 'GET') {
    const limit = projectPageSize(url),
      after = url.searchParams.get('after') || '';
    const rows = room.rows(
      'SELECT * FROM decisions WHERE message_id>? ORDER BY message_id LIMIT ?',
      after,
      limit + 1,
    );
    const decisions = rows.slice(0, limit).map((r) => ({
      request_id: r.message_id,
      ...JSON.parse(r.json),
      expired: r.expires_at <= Date.now(),
      selected: r.selected_message_id ? message(room, r.selected_message_id).message : null,
      evidence: recordLink(id, r.message_id),
    }));
    return projectJSON({
      decisions,
      has_more: rows.length > limit,
      next_after: decisions.at(-1)?.request_id || after,
    });
  }
  if (/^\/messages\/[^/]+\/(revisions|receipts)$/.test(path) && request.method === 'GET') {
    message(room, parts[1]);
    const limit = projectPageSize(url);
    if (parts[2] === 'revisions') {
      const after = projectSequence(id, url.searchParams.get('cursor'));
      const rows = room.rows(
        'SELECT e.json FROM message_revisions r JOIN events e ON e.id=r.message_id WHERE r.target_id=? AND r.seq>? ORDER BY r.seq LIMIT ?',
        parts[1],
        after,
        limit + 1,
      );
      const revisions = rows.slice(0, limit).map((r) => JSON.parse(r.json));
      return projectJSON({
        revisions,
        has_more: rows.length > limit,
        next_cursor: projectCursor(id, revisions.at(-1)?.seq || after),
      });
    }
    const after = url.searchParams.get('after') || '';
    const rows = room.rows(
      'SELECT r.actor_id,a.nick,r.first_seen_at,r.last_seen_at FROM receipts r JOIN actors a ON a.id=r.actor_id WHERE r.message_id=? AND r.actor_id>? ORDER BY r.actor_id LIMIT ?',
      parts[1],
      after,
      limit + 1,
    );
    return projectJSON({
      receipts: rows.slice(0, limit),
      has_more: rows.length > limit,
      next_after: rows.slice(0, limit).at(-1)?.actor_id || after,
    });
  }
  if (path === '/seen' && request.method === 'POST') {
    const body = projectObject(await projectBody(request), ['message_ids']);
    if (
      !Array.isArray(body.message_ids) ||
      body.message_ids.length < 1 ||
      body.message_ids.length > 100 ||
      body.message_ids.some((id) => typeof id !== 'string')
    )
      projectFail(400, 'invalid_messages', 'Provide 1–100 message IDs');
    return room.mutate(
      request,
      actor,
      'seen',
      body,
      () => {
        const now = Date.now();
        for (const id of body.message_ids) {
          message(room, id);
          room.sql.exec(
            'INSERT INTO receipts(message_id,actor_id,first_seen_at,last_seen_at) VALUES(?,?,?,?) ON CONFLICT(message_id,actor_id) DO UPDATE SET last_seen_at=excluded.last_seen_at',
            id,
            actor.id,
            now,
            now,
          );
        }
        room.audit(actor, 'messages.seen', { message_ids: body.message_ids, seen_at: now });
        return { seen: { actor_id: actor.id, message_ids: body.message_ids, seen_at: now } };
      },
      { allowGuest: true, allowArchived: true },
    );
  }
  if (['/roles', '/status'].includes(path) && request.method === 'GET') {
    const prefix = path === '/roles' ? 'role:' : 'status:',
      limit = projectPageSize(url),
      after = url.searchParams.get('after') || prefix;
    const rows = room.rows(
        "SELECT json FROM board WHERE key>=? AND key<? AND key>? AND json_extract(json,'$.record_schema')=1 AND json_extract(json,'$.deleted')=0 ORDER BY key LIMIT ?",
        prefix,
        prefix + '~',
        after,
        limit + 1,
      ),
      entries = rows.slice(0, limit).map((r) => {
        const entry = room.boardVisible(JSON.parse(r.json));
        const participant = room.one(
          'SELECT nick,revoked FROM actors WHERE id=?',
          prefix === 'role:' ? entry.value.actor_id : entry.author_id,
        );
        return {
          ...entry,
          participant_nick: participant?.nick || null,
          active: !entry.expired && !participant?.revoked,
        };
      });
    return projectJSON({
      entries,
      has_more: rows.length > limit,
      next_after: entries.at(-1)?.key || after,
      advisory: true,
    });
  }
  if ((/^\/roles\/[^/]+$/.test(path) || path === '/status') && request.method === 'PUT') {
    const status = path === '/status';
    const body = projectObject(
      await projectBody(request),
      status
        ? ['text', 'eta', 'blocked_by', 'expires_at']
        : ['actor_id', 'description', 'expires_at'],
    );
    if (!status) room.owner(actor);
    if (status) {
      projectString(body.text, 'text', 1000);
      if (body.eta !== undefined && !Number.isSafeInteger(body.eta))
        projectFail(400, 'invalid_eta', 'ETA must be an epoch timestamp');
    } else {
      projectString(body.description, 'description', 2000);
      if (
        typeof body.actor_id !== 'string' ||
        !room.one('SELECT id FROM actors WHERE id=? AND revoked=0', body.actor_id)
      )
        projectFail(400, 'unknown_actor', 'Role holder must be an active room participant');
    }
    if (
      body.blocked_by !== undefined &&
      (typeof body.blocked_by !== 'string' ||
        !room.one('SELECT id FROM actors WHERE id=?', body.blocked_by))
    )
      projectFail(400, 'unknown_actor', 'Blocking actor must belong to this room');
    const key = status ? 'status:' + actor.id : 'role:' + projectDecode(parts[1]);
    room.boardKey(key);
    const value = status
      ? {
          text: body.text,
          ...(body.eta === undefined ? {} : { eta: body.eta }),
          ...(body.blocked_by === undefined ? {} : { blocked_by: body.blocked_by }),
        }
      : { actor_id: body.actor_id, description: body.description, advisory: true };
    const normalizedHeaders = new Headers(request.headers);
    // This is a different body: carrying the caller's byte length can truncate
    // the internal upload or poison an HTTP keep-alive connection.
    normalizedHeaders.delete('Content-Length');
    const normalized = new Request(request.url, {
      method: 'PUT',
      headers: normalizedHeaders,
      body: JSON.stringify({
        value,
        kind: status ? 'status' : 'role',
        ...(body.expires_at === undefined ? {} : { expires_at: body.expires_at }),
      }),
    });
    return room.stateEntry(normalized, actor, key, false, url);
  }
  if (path === '/digest' && request.method === 'GET') {
    const pending = room.inbox(new URL('https://room/?limit=20'), id, actor);
    const open = room
      .rows(
        "SELECT json FROM requests WHERE state NOT IN ('verified','cancelled') ORDER BY updated_at DESC LIMIT 20",
      )
      .map((r) => JSON.parse(r.json));
    const pins = room
      .rows('SELECT json FROM pins_latest ORDER BY seq DESC LIMIT 20')
      .map((r) => JSON.parse(r.json));
    return projectJSON({
      generated_at: new Date().toISOString(),
      method: 'deterministic_navigation',
      pending_count: pending.pending_count,
      unread: pending.messages.map((m) => ({
        id: m.id,
        kind: m.kind,
        actor: m.actor,
        excerpt: [...m.text].slice(0, 280).join(''),
        evidence: recordLink(id, m.id),
      })),
      open_requests: open.map((r) => ({ ...r, evidence: recordLink(id, r.message_id) })),
      latest_pins: pins.map((p) => ({ ...p, evidence: recordLink(id, p.message_id) })),
      notice:
        'Navigation only. Read the linked evidence; a digest is not an approval or replacement for the record.',
    });
  }
  return null;
}

export function projectMessageView(room, original) {
  const row = room.one(
    'SELECT e.json FROM message_revisions r JOIN events e ON e.id=r.message_id WHERE r.target_id=? ORDER BY r.seq DESC LIMIT 1',
    original.id,
  );
  const latest = row ? JSON.parse(row.json) : null;
  return {
    text:
      latest?.kind === 'agentmeet.message.retract'
        ? null
        : latest?.kind === 'agentmeet.message.edit'
          ? latest.data.text
          : original.text,
    retracted: latest?.kind === 'agentmeet.message.retract',
    latest_revision: latest,
  };
}
