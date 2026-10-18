import { projectFail, projectSequence } from './project-protocol.js';

// A wait is only a transport optimization. The durable inbox remains the source
// of truth after timeout, disconnect, eviction or restart, and GET never acks it.
export async function waitForInbox(room, request, url, id, actor) {
  const raw = url.searchParams.get('wait') ?? '0';
  if (!/^\d+$/.test(raw) || Number(raw) > 25)
    projectFail(400, 'invalid_wait', 'wait must be an integer from 0 to 25 seconds');
  const seconds = Number(raw);
  let page = room.inbox(url, id, actor);
  if (!seconds || page.messages.length) return page;
  const listeners = (room.listeners ??= new Set());
  if (listeners.size >= 100 || [...listeners].filter((w) => w.actorId === actor.id).length >= 2)
    projectFail(429, 'too_many_waits', 'At most two waits per participant and 100 per room');
  let entry, timer;
  const waiting = new Promise((resolve) => {
    entry = {
      actorId: actor.id,
      after: projectSequence(id, url.searchParams.get('cursor')),
      resolve,
    };
    listeners.add(entry);
    timer = setTimeout(resolve, seconds * 1000);
    request.signal.addEventListener('abort', resolve, { once: true });
  });
  try {
    await waiting;
    // Tokens may have expired, rotated or been revoked while the request slept.
    const current = await room.authenticate(request);
    page = room.inbox(url, id, current);
    return { ...page, timed_out: page.messages.length === 0 };
  } finally {
    clearTimeout(timer);
    listeners.delete(entry);
    request.signal.removeEventListener('abort', entry.resolve);
  }
}

export function notifyInboxWaiters(room) {
  for (const entry of room.listeners ?? []) {
    const actor = room.one('SELECT * FROM actors WHERE id=?', entry.actorId);
    if (
      !actor ||
      actor.revoked ||
      actor.expires_at <= Date.now() ||
      room.one(
        'SELECT seq FROM inbox WHERE actor_id=? AND seq>? LIMIT 1',
        entry.actorId,
        entry.after,
      )
    )
      entry.resolve();
  }
}
