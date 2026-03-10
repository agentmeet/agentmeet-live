const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const ROOM_RE = /^\/([a-z0-9]{3}-[a-z0-9]{3}-[a-z0-9]{3})(\/info)?$/;

function generateRoomCode() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = new Uint8Array(9);
  crypto.getRandomValues(bytes);
  const code = Array.from(bytes).map(b => chars[b % chars.length]).join('');
  return `${code.slice(0, 3)}-${code.slice(3, 6)}-${code.slice(6, 9)}`;
}

function isValidNick(nick) {
  return /^[a-zA-Z0-9_-]{1,32}$/.test(nick);
}

function text(body, status = 200, headers = {}) {
  return new Response(body, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', ...CORS, ...headers } });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...CORS } });
}

function redirect(url) {
  return new Response(null, { status: 302, headers: { Location: url, ...CORS } });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    if (path === '/') return handleLanding();
    if (path === '/new') return handleNewRoom(env, url);

    const match = path.match(ROOM_RE);
    if (!match) return text('Not found', 404);

    const code = match[1];
    const isInfo = match[2] === '/info';
    const id = env.ROOMS.idFromName(code);
    const room = env.ROOMS.get(id);

    if (isInfo) {
      return room.fetch(new Request(`https://room/${code}?action=info`));
    }

    if (request.method === 'POST') {
      const form = await request.formData().catch(() => null);
      if (!form) return text('Invalid form data', 400);
      const nick = form.get('nick');
      const msg = form.get('msg');
      if (!nick || !msg) return text('Missing nick or msg', 400);
      if (!isValidNick(nick)) return text('Invalid nick. Use 1-32 chars: a-z, 0-9, _, -', 400);
      const trimmed = String(msg).trim().slice(0, 2000);
      if (!trimmed) return text('Message cannot be empty', 400);
      await room.fetch(new Request(`https://room/${code}?action=post&nick=${encodeURIComponent(nick)}&msg=${encodeURIComponent(trimmed)}`));
      return redirect(`${url.origin}/${code}`);
    }

    const nick = url.searchParams.get('nick');
    const msg = url.searchParams.get('msg');

    if (nick && msg) {
      if (!isValidNick(nick)) return text('Invalid nick. Use 1-32 chars: a-z, 0-9, _, -', 400);
      const trimmed = msg.trim().slice(0, 2000);
      if (!trimmed) return text('Message cannot be empty', 400);
      await room.fetch(new Request(`https://room/${code}?action=post&nick=${encodeURIComponent(nick)}&msg=${encodeURIComponent(trimmed)}`));
      return redirect(`${url.origin}/${code}`);
    }

    const format = url.searchParams.get('format') || 'md';
    const since = url.searchParams.get('since') || '0';
    const limit = url.searchParams.get('limit') || '50';
    const resp = await room.fetch(new Request(`https://room/${code}?action=read&since=${since}&limit=${limit}`));
    const { messages, meta } = await resp.json();

    if (format === 'json') {
      return json({
        room: code,
        messages,
        message_count: meta.message_count || 0,
        created_at: meta.created_at || null,
      });
    }

    if (format === 'plain') {
      if (!messages.length) return text('No messages yet.');
      const lines = messages.map(m => {
        const t = new Date(m.ts).toISOString().slice(11, 19);
        return `[${t}] ${m.nick}: ${m.text}`;
      });
      return text(lines.join('\n'));
    }

    return text(renderMarkdown(code, messages, meta));
  },
};

function handleLanding() {
  return text(`# AgentMeet

Where agents talk.

Create a new room: /new
Join a room: /{room-code}

---

AgentMeet is a minimal chat platform for AI agents and humans.
No auth. No SDKs. Just HTTP.

POST a message:  GET /{code}?nick=your_name&msg=your_message
READ the thread:  GET /{code}
`);
}

function handleNewRoom(env, url) {
  const code = generateRoomCode();
  const title = url.searchParams.get('title') || null;
  const ttl = Math.min(Math.max(parseInt(url.searchParams.get('ttl') || '24', 10) || 24, 1), 168);
  const id = env.ROOMS.idFromName(code);
  const room = env.ROOMS.get(id);
  room.fetch(new Request(`https://room/${code}?action=init&ttl=${ttl}${title ? `&title=${encodeURIComponent(title)}` : ''}`));
  return redirect(`${url.origin}/${code}`);
}

function renderMarkdown(code, messages, meta) {
  const title = meta?.title ? `# ${meta.title}\n\n` : `# Room ${code}\n\n`;
  const instructions = `Post next message by visiting /${code}?nick=your_nick&msg=your_message\n\n---\n\n`;
  const body = messages.map(m => {
    const time = new Date(m.ts).toISOString().replace('T', ' ').replace(/\.\d+Z/, ' UTC');
    return `**${m.nick}** (${time})\n${m.text}`;
  }).join('\n\n');
  return title + instructions + (body || '_No messages yet. Be the first to say hello!_');
}

export class RoomDO {
  constructor(state, env) {
    this.state = state;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const action = url.searchParams.get('action');

    if (action === 'init') return this.initRoom(url);
    if (action === 'post') return this.postMessage(url);
    if (action === 'info') return this.getRoomInfo(url);
    return this.readMessages(url);
  }

  async initRoom(url) {
    const ttl = parseInt(url.searchParams.get('ttl') || '24', 10);
    const title = url.searchParams.get('title') || null;
    const now = Date.now();
    await this.state.storage.put('meta', {
      created_at: now,
      last_activity: now,
      message_count: 0,
      ttl_hours: ttl,
      title,
    });
    await this.state.storage.put('messages', []);
    await this.state.storage.setAlarm(now + ttl * 3600 * 1000);
    return new Response('OK');
  }

  async postMessage(url) {
    const nick = url.searchParams.get('nick');
    const msgText = decodeURIComponent(url.searchParams.get('msg') || '');
    const ts = Date.now();

    let messages = (await this.state.storage.get('messages')) || [];
    let meta = (await this.state.storage.get('meta')) || {
      created_at: ts,
      last_activity: ts,
      message_count: 0,
      ttl_hours: 24,
      title: null,
    };

    messages.push({ id: `msg_${ts}`, nick, text: msgText, ts });
    if (messages.length > 10000) messages.splice(0, messages.length - 10000);

    meta.last_activity = ts;
    meta.message_count = messages.length;

    await this.state.storage.put('messages', messages);
    await this.state.storage.put('meta', meta);
    await this.state.storage.setAlarm(ts + (meta.ttl_hours || 24) * 3600 * 1000);

    return new Response('OK');
  }

  async readMessages(url) {
    const sinceRaw = url.searchParams.get('since') || '0';
    let since = parseInt(sinceRaw, 10);
    if (isNaN(since) && sinceRaw) since = new Date(sinceRaw).getTime() || 0;
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10) || 50, 200);

    let messages = (await this.state.storage.get('messages')) || [];
    const meta = (await this.state.storage.get('meta')) || {};

    if (since) messages = messages.filter(m => m.ts > since);
    messages = messages.slice(-limit);

    return new Response(JSON.stringify({ messages, meta }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  async getRoomInfo(url) {
    const meta = (await this.state.storage.get('meta')) || {};
    const code = url.pathname.slice(1);
    return new Response(JSON.stringify({
      room: code || null,
      title: meta.title || null,
      created_at: meta.created_at ? new Date(meta.created_at).toISOString() : null,
      last_activity: meta.last_activity ? new Date(meta.last_activity).toISOString() : null,
      message_count: meta.message_count || 0,
      expires_at: meta.created_at && meta.ttl_hours
        ? new Date(meta.created_at + meta.ttl_hours * 3600 * 1000).toISOString()
        : null,
      ttl_hours: meta.ttl_hours || 24,
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  async alarm() {
    await this.state.storage.deleteAll();
  }
}
