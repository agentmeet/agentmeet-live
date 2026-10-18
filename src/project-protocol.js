const PROJECT_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, Idempotency-Key, If-Match',
  'Access-Control-Expose-Headers': 'X-Request-ID, ETag',
};
const PROJECT_LIMITS = Object.freeze({
  request: 131072,
  text: 32768,
  data: 65536,
  events: 100000,
  bytes: 268435456,
  actors: 100,
});
const projectEncoder = new TextEncoder();
class ProjectError extends Error {
  constructor(status, code, message, details) {
    super(message);
    Object.assign(this, { status, code, details });
  }
}
function projectFail(status, code, message, details) {
  throw new ProjectError(status, code, message, details);
}
function projectJSON(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { ...PROJECT_HEADERS, ...headers },
  });
}
function projectId() {
  return crypto.randomUUID();
}
function projectToken() {
  return (
    'am2_' +
    [...crypto.getRandomValues(new Uint8Array(32))]
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
  );
}
async function projectHash(value) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', projectEncoder.encode(value)))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
function projectCanonical(value) {
  if (Array.isArray(value)) return '[' + value.map(projectCanonical).join(',') + ']';
  if (value && typeof value === 'object')
    return (
      '{' +
      Object.keys(value)
        .sort()
        .map((k) => JSON.stringify(k) + ':' + projectCanonical(value[k]))
        .join(',') +
      '}'
    );
  return JSON.stringify(value);
}
function projectObject(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    projectFail(400, 'invalid_body', 'Expected a JSON object');
  const unknown = Object.keys(value).filter((k) => !allowed.includes(k));
  if (unknown.length) projectFail(400, 'unknown_fields', 'Unknown fields', { fields: unknown });
  return value;
}
function projectString(value, label, max, empty = false) {
  if (typeof value !== 'string' || (!empty && !value.trim()))
    projectFail(400, 'invalid_field', `${label} must be a nonempty string`);
  try {
    encodeURIComponent(value);
  } catch {
    projectFail(400, 'invalid_unicode', `${label} contains invalid Unicode`);
  }
  if (projectEncoder.encode(value).length > max)
    projectFail(413, 'field_too_large', `${label} exceeds its UTF-8 byte budget`, {
      field: label,
      max_bytes: max,
    });
  return value;
}
function projectNick(nick) {
  if (typeof nick !== 'string' || !/^[a-zA-Z0-9_-]{1,32}$/.test(nick))
    projectFail(400, 'invalid_nick', 'Nick must be 1–32 letters, digits, underscores or hyphens');
  return nick;
}
async function projectBody(request) {
  if (request.headers.get('content-type')?.split(';')[0].trim() !== 'application/json')
    projectFail(415, 'content_type', 'Use application/json');
  if (Number(request.headers.get('content-length')) > PROJECT_LIMITS.request)
    projectFail(413, 'body_too_large', 'Request exceeds 128 KiB');
  if (!request.body) projectFail(400, 'invalid_json', 'JSON body is required');
  const reader = request.body.getReader();
  const chunks = [];
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.length;
    if (bytes > PROJECT_LIMITS.request) {
      await reader.cancel();
      projectFail(413, 'body_too_large', 'Request exceeds 128 KiB');
    }
    chunks.push(value);
  }
  const data = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    data.set(chunk, offset);
    offset += chunk.length;
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data));
  } catch {
    projectFail(400, 'invalid_json', 'Body must contain valid UTF-8 JSON');
  }
}
function projectCursor(room, seq) {
  return btoa(JSON.stringify([2, room, seq]))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
}
function projectSequence(room, cursor) {
  if (!cursor) return 0;
  try {
    if (cursor.length > 200) throw 0;
    const [version, id, seq] = JSON.parse(atob(cursor.replaceAll('-', '+').replaceAll('_', '/')));
    if (version !== 2 || id !== room || !Number.isSafeInteger(seq) || seq < 0) throw 0;
    return seq;
  } catch {
    projectFail(400, 'invalid_cursor', 'Cursor is invalid or belongs to another room');
  }
}
function projectPageSize(url) {
  const value = url.searchParams.get('limit') || '50';
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 200)
    projectFail(400, 'invalid_limit', 'Limit must be 1–200');
  return Number(value);
}
function projectDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    projectFail(400, 'invalid_path', 'Path contains invalid encoding');
  }
}

export {
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
};
