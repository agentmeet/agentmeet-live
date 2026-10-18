let room,
  token,
  currentActor,
  currentArchived = false,
  cursor = '',
  pending = null;
const mutationKeys = new Map();
const $ = (id) => document.getElementById(id);
const shown = new Set();
const models = new Map();
const revisions = new Map();
let editTarget = null,
  retracting = false;
async function api(path, options = {}) {
  const r = await fetch('/v2/rooms' + path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
      ...options.headers,
    },
  });
  const data = await r.json();
  if (!r.ok) {
    const error = Error(data.error?.message + ' [' + data.request_id + ']');
    error.status = r.status;
    throw error;
  }
  return data;
}
function report(e) {
  $('error').textContent = e.message;
}
function render(el, text) {
  el.dataset.markdown = text;
  el.replaceChildren(
    window.AgentMeetMarkdown
      ? window.AgentMeetMarkdown.render(text)
      : document.createTextNode(text),
  );
}
window.addEventListener('agentmeet:markdown-ready', () =>
  document.querySelectorAll('[data-markdown]').forEach((el) => render(el, el.dataset.markdown)),
);
let olderCursor = '',
  viewingHistory = false;
function clearConversation() {
  shown.clear();
  models.clear();
  revisions.clear();
  $('messages').replaceChildren();
}
function appendMessages(messages) {
  for (const m of messages) {
    if (shown.has(m.id)) continue;
    shown.add(m.id);
    models.set(m.id, m);
    $('messages').append(messageArticle(m));
    const revision =
      m.current?.latest_revision ||
      (m.record_schema === 1 &&
      ['agentmeet.message.edit', 'agentmeet.message.retract'].includes(m.kind)
        ? m
        : null);
    if (
      revision &&
      (!revisions.has(revision.data.target_id) ||
        revisions.get(revision.data.target_id).seq < revision.seq)
    )
      revisions.set(revision.data.target_id, revision);
  }
  for (const revision of revisions.values()) applyRevision(revision);
  while ($('messages').children.length > 200) {
    const first = $('messages').firstElementChild;
    shown.delete(first.id);
    models.delete(first.id);
    first.remove();
    olderCursor = models.get($('messages').firstElementChild.id).cursor;
    $('older').hidden = false;
  }
  for (const [id, revision] of revisions)
    if (!shown.has(id) && !shown.has(revision.id)) revisions.delete(id);
}
async function refresh() {
  if (viewingHistory) {
    cursor = '';
    clearConversation();
    viewingHistory = false;
  }
  let more,
    pages = 0;
  do {
    const data = await api(
      '/' +
        room +
        '/messages?limit=50' +
        (cursor ? '&cursor=' + encodeURIComponent(cursor) : '&tail=true'),
    );
    appendMessages(data.messages);
    if (!cursor) {
      olderCursor = data.older_cursor;
      $('older').hidden = !data.has_older;
    }
    cursor = data.next_cursor;
    more = data.has_more;
  } while (more && ++pages < 4);
  $('conversation-status').textContent = more
    ? 'More new messages available. Refresh to continue.'
    : '';
  await Promise.all([loadInbox(), loadBoard(), loadHealth(), loadRecords()]);
}
$('older').onclick = async () => {
  try {
    const data = await api(
      '/' + room + '/messages?limit=50&before=' + encodeURIComponent(olderCursor),
    );
    clearConversation();
    appendMessages(data.messages);
    olderCursor = data.older_cursor;
    viewingHistory = true;
    $('older').hidden = !data.has_older;
    $('conversation-status').textContent =
      'Viewing earlier messages. Refresh messages returns to the latest conversation.';
  } catch (error) {
    report(error);
  }
};
async function connect() {
  const data = await api('/' + room);
  currentActor = data.actor;
  currentArchived = data.lifetime.archived;
  $('title').textContent = data.room.title;
  $('send').hidden = data.actor.role === 'guest';
  $('state-form').hidden = data.actor.role === 'guest';
  $('hold-form').hidden = data.actor.role === 'guest';
  for (const name of ['request-form', 'pin-form', 'status-form'])
    $(name).hidden = data.actor.role === 'guest';
  $('identity').textContent = data.actor.nick + ' · verified ' + data.actor.role;
  $('room').hidden = false;
  $('invite').hidden = data.actor.role !== 'owner';
  $('lifetime-form').hidden = data.actor.role !== 'owner';
  $('archive-form').hidden = data.actor.role !== 'owner';
  sessionStorage.setItem('agentmeet-project', JSON.stringify({ room, token }));
  cursor = '';
  shown.clear();
  models.clear();
  revisions.clear();
  $('messages').replaceChildren();
  await refresh();
}
async function mutation(path, body, revision, method = 'POST') {
  const signature = JSON.stringify({ path, body, revision, method });
  if (!mutationKeys.has(signature)) mutationKeys.set(signature, crypto.randomUUID());
  const result = await api('/' + room + path, {
    method,
    body: JSON.stringify(body),
    headers: {
      'Idempotency-Key': mutationKeys.get(signature),
      ...(revision === undefined ? {} : { 'If-Match': '"' + revision + '"' }),
    },
  });
  mutationKeys.delete(signature);
  return result;
}
async function loadHealth() {
  const data = await api('/' + room + '/health');
  const life = data.lifetime;
  currentArchived = life.archived;
  $('health').textContent =
    'Storage: ' +
    data.storage +
    ' · ' +
    (life.archived
      ? 'Archived; history preserved'
      : life.keep
        ? 'Kept; no expiry'
        : 'Expires ' + new Date(life.expires_at).toLocaleString()) +
    ' · ' +
    life.capacity.events +
    '/' +
    life.capacity.event_limit +
    ' messages · ' +
    data.pending_count +
    ' pending';
  $('lifetime-form').elements.keep.checked = life.keep;
  $('lifetime-form').elements.ttl.value = life.ttl_hours;
  $('archive-button').textContent = life.archived ? 'Restore writable room' : 'Archive room';
  $('send').hidden = currentActor.role === 'guest' || life.archived;
  $('state-form').hidden = currentActor.role === 'guest' || life.archived;
  $('hold-form').hidden = currentActor.role === 'guest' || life.archived;
  for (const name of ['request-form', 'pin-form', 'status-form'])
    $(name).hidden = currentActor.role === 'guest' || life.archived;
  document.querySelectorAll('#inbox button').forEach((button) => (button.disabled = life.archived));
}
$('lifetime-form').onsubmit = async (e) => {
  e.preventDefault();
  try {
    await mutation('/lifetime', {
      keep: e.target.elements.keep.checked,
      ttl_hours: Number(e.target.elements.ttl.value),
    });
    await loadHealth();
  } catch (e) {
    report(e);
  }
};
$('archive-form').onsubmit = async (e) => {
  e.preventDefault();
  try {
    await mutation(currentArchived ? '/unarchive' : '/archive', {
      reason: e.target.elements.reason.value,
    });
    e.target.reset();
    await loadHealth();
  } catch (e) {
    report(e);
  }
};
async function loadInbox() {
  const data = await api('/' + room + '/inbox');
  $('inbox').replaceChildren();
  if (!data.messages.length) {
    $('inbox').textContent = 'No pending messages.';
    return;
  }
  for (const m of data.messages) {
    const article = document.createElement('article'),
      label = document.createElement('p'),
      body = document.createElement('div');
    label.textContent = m.actor.nick + ' · ' + m.kind;
    render(body, m.text);
    article.append(label, body);
    if (currentActor.role !== 'guest') {
      const form = document.createElement('form'),
        action = document.createElement('input'),
        outcome = document.createElement('select'),
        button = document.createElement('button');
      action.placeholder = 'Action taken';
      action.required = true;
      for (const value of ['handled', 'verified', 'blocked', 'declined']) {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = value;
        outcome.append(option);
      }
      button.textContent = 'Record acknowledgement';
      form.append(action, outcome, button);
      form.onsubmit = async (e) => {
        e.preventDefault();
        try {
          await mutation('/ack', {
            message_ids: [m.id],
            action: action.value,
            outcome: outcome.value,
          });
          await Promise.all([loadInbox(), loadHealth()]);
        } catch (e) {
          report(e);
        }
      };
      article.append(form);
    }
    $('inbox').append(article);
  }
  if (data.has_more) {
    const more = document.createElement('p');
    more.textContent = 'More pending messages remain. Acknowledge these to reveal the next batch.';
    $('inbox').append(more);
  }
}
async function loadBoard() {
  const data = await api('/' + room + '/state');
  $('board').replaceChildren();
  for (const entry of data.entries) {
    const article = document.createElement('article'),
      pre = document.createElement('pre');
    pre.textContent =
      entry.key +
      ' · revision ' +
      entry.revision +
      (entry.deleted ? ' · released/deleted' : entry.expired ? ' · expired' : '') +
      '\n' +
      JSON.stringify(entry.value, null, 2);
    article.append(pre);
    if (entry.kind === 'hold' && !entry.deleted && !entry.expired) {
      if (entry.author_id === currentActor.id) {
        for (const action of ['renew', 'release']) {
          const button = document.createElement('button');
          button.textContent = action === 'renew' ? 'Renew 30 minutes' : 'Release hold';
          button.onclick = async () => {
            try {
              await mutation(
                '/holds/' + encodeURIComponent(entry.value.scope) + '/' + action,
                {
                  reason: action === 'renew' ? 'Holder renewed lease' : 'Holder released lease',
                  ...(action === 'renew' ? { lease_until: Date.now() + 1800000 } : {}),
                },
                entry.revision,
              );
              await loadBoard();
            } catch (e) {
              report(e);
            }
          };
          article.append(button);
        }
      }
      if (currentActor.role === 'owner' && entry.author_id !== currentActor.id) {
        const button = document.createElement('button');
        button.textContent = 'Revoke hold';
        button.onclick = async () => {
          try {
            await mutation(
              '/holds/' + encodeURIComponent(entry.value.scope) + '/revoke',
              { reason: 'Room owner recovery' },
              entry.revision,
            );
            await loadBoard();
          } catch (e) {
            report(e);
          }
        };
        article.append(button);
      }
    } else if (
      entry.kind !== 'hold' &&
      (entry.author_id === currentActor.id || currentActor.role === 'owner')
    ) {
      const button = document.createElement('button');
      button.textContent = 'Edit state';
      button.onclick = () => {
        const f = $('state-form');
        f.elements.key.value = entry.key;
        f.elements.value.value = JSON.stringify(entry.value, null, 2);
        f.elements.revision.value = entry.revision;
      };
      article.append(button);
    }
    $('board').append(article);
  }
}
$('state-form').elements.key.oninput = () => ($('state-form').elements.revision.value = 0);
$('state-form').onsubmit = async (e) => {
  e.preventDefault();
  try {
    await mutation(
      '/state/' + encodeURIComponent(e.target.elements.key.value),
      { value: JSON.parse(e.target.elements.value.value) },
      Number(e.target.elements.revision.value),
      'PUT',
    );
    e.target.reset();
    e.target.elements.revision.value = 0;
    await loadBoard();
  } catch (e) {
    report(e);
  }
};
$('hold-form').onsubmit = async (e) => {
  e.preventDefault();
  try {
    await mutation('/holds/' + encodeURIComponent(e.target.elements.scope.value), {
      reason: e.target.elements.reason.value,
      lease_until: Date.now() + 1800000,
    });
    e.target.reset();
    await loadBoard();
  } catch (e) {
    report(e);
  }
};
$('create').onsubmit = async (e) => {
  e.preventDefault();
  try {
    const f = new FormData(e.target);
    const data = await api('', {
      method: 'POST',
      body: JSON.stringify({ nick: f.get('nick'), title: f.get('title') }),
    });
    room = data.room.id;
    token = data.token;
    $('connect').elements.room.value = room;
    $('connect').elements.token.value = token;
    $('credential').hidden = false;
    $('credential').textContent = 'Save this owner credential now: ' + token;
    await connect();
  } catch (e) {
    report(e);
  }
};
$('connect').onsubmit = async (e) => {
  e.preventDefault();
  room = e.target.elements.room.value.trim();
  token = e.target.elements.token.value.trim();
  try {
    await connect();
  } catch (e) {
    report(e);
  }
};
$('refresh').onclick = () => refresh().catch(report);
$('send').onsubmit = async (e) => {
  e.preventDefault();
  const text = e.target.elements.text.value;
  try {
    if (editTarget) {
      await postRecord(
        retracting ? 'agentmeet.message.retract' : 'agentmeet.message.edit',
        {
          target_id: editTarget,
          reason: e.target.elements.reason.value,
          ...(retracting ? {} : { text }),
        },
        '',
        editTarget,
      );
    } else await postRecord('message', null, text);
    resetRevision();
    e.target.reset();
    $('error').textContent = '';
    await refresh();
  } catch (e) {
    report(e);
  }
};
$('invite').onsubmit = async (e) => {
  e.preventDefault();
  try {
    const data = await api('/' + room + '/participants', {
      method: 'POST',
      body: JSON.stringify({ nick: e.target.elements.nick.value }),
    });
    $('credential').hidden = false;
    $('credential').textContent =
      'Give ' + data.participant.nick + ' their credential securely: ' + data.token;
    e.target.reset();
  } catch (e) {
    report(e);
  }
};
const requestedRoom = new URL(location.href).searchParams.get('room');
try {
  const saved = JSON.parse(sessionStorage.getItem('agentmeet-project'));
  if (saved && (!requestedRoom || requestedRoom === saved.room)) {
    room = saved.room;
    token = saved.token;
    connect()
      .then(async () => {
        if (!location.hash) return;
        const id = decodeURIComponent(location.hash.slice(1));
        if (!document.getElementById(id)) {
          const data = await api('/' + room + '/messages/' + encodeURIComponent(id));
          clearConversation();
          appendMessages([{ ...data.message, current: data.current }]);
          viewingHistory = true;
          $('older').hidden = true;
          $('conversation-status').textContent =
            'Viewing a linked record. Refresh messages returns to the latest conversation.';
        }
        document.getElementById(id)?.scrollIntoView();
      })
      .catch(report);
  } else if (requestedRoom) $('connect').elements.room.value = requestedRoom;
} catch {}

function evidenceLink(id, label) {
  const a = document.createElement('a');
  a.href = '/project?room=' + encodeURIComponent(room) + '#' + encodeURIComponent(id);
  a.textContent = label;
  return a;
}
function messageArticle(m) {
  const article = document.createElement('article');
  article.id = m.id;
  const identity = document.createElement('p');
  identity.className = 'identity';
  identity.textContent =
    m.actor.nick + ' · verified ' + m.actor.role + ' · ' + new Date(m.ts).toLocaleString();
  identity.title = m.iso;
  const body = document.createElement('div');
  body.className = 'body';
  render(body, m.text);
  article.append(identity, body);
  if (m.record_schema === 1 && m.kind === 'agentmeet.pin') {
    const summary = document.createElement('p');
    summary.textContent =
      m.data.name +
      ' · ' +
      m.data.version +
      ' · SHA-256 ' +
      m.data.sha256.slice(0, 12) +
      '… (producer assertion)';
    article.append(summary);
  }
  if (m.data !== null) {
    const details = document.createElement('details'),
      summary = document.createElement('summary'),
      pre = document.createElement('pre');
    summary.textContent = m.kind + ' · structured record';
    pre.textContent = JSON.stringify(m.data, null, 2);
    details.append(summary, pre);
    article.append(details);
  }
  if (
    m.actor.id === currentActor.id &&
    !m.kind.startsWith('agentmeet.decision.') &&
    !m.kind.startsWith('agentmeet.message.') &&
    m.kind !== 'agentmeet.pin' &&
    !currentArchived
  ) {
    for (const retract of [false, true]) {
      const button = document.createElement('button');
      button.textContent = retract ? 'Retract' : 'Edit';
      button.type = 'button';
      button.onclick = () => beginRevision(m, retract);
      article.append(button);
    }
  }
  if (m.actor.id !== currentActor.id) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = 'Record seen';
    button.onclick = async () => {
      try {
        await mutation('/seen', { message_ids: [m.id] });
        button.textContent = 'Seen receipt recorded';
      } catch (e) {
        report(e);
      }
    };
    article.append(button);
  }
  const receipts = document.createElement('button');
  receipts.type = 'button';
  receipts.textContent = 'Read receipts';
  receipts.onclick = async () => {
    try {
      const result = await api('/' + room + '/messages/' + m.id + '/receipts');
      const p = document.createElement('p');
      p.textContent = result.receipts.length
        ? result.receipts
            .map((r) => r.nick + ' · ' + new Date(r.first_seen_at).toLocaleString())
            .join('; ')
        : 'No explicit seen receipts.';
      receipts.replaceWith(p);
    } catch (e) {
      report(e);
    }
  };
  article.append(receipts);
  return article;
}
function applyRevision(revision) {
  const original = document.getElementById(revision.data.target_id);
  if (!original) return;
  const body = original.querySelector('.body');
  if (!original.querySelector('.original-record')) {
    const details = document.createElement('details');
    details.className = 'original-record';
    const summary = document.createElement('summary'),
      history = document.createElement('div');
    summary.textContent = 'Original message (retained)';
    render(history, models.get(revision.data.target_id).text);
    details.append(summary, history);
    original.append(details);
  }
  render(
    body,
    revision.kind === 'agentmeet.message.retract'
      ? 'Message retracted. Original and revision history remain available.'
      : revision.data.text,
  );
  let label = original.querySelector('.revision-label');
  if (!label) {
    label = document.createElement('p');
    label.className = 'revision-label';
    original.append(label);
  }
  label.textContent =
    (revision.kind.endsWith('.retract') ? 'Retracted' : 'Edited') +
    ' · ' +
    new Date(revision.ts).toLocaleString() +
    ' · ' +
    revision.data.reason;
}
function beginRevision(m, retract) {
  editTarget = m.id;
  retracting = retract;
  const f = $('send');
  f.elements.text.value = revisions.get(m.id)?.data.text || m.text;
  f.elements.text.hidden = retract;
  f.elements.text.required = !retract;
  f.elements.reason.hidden = false;
  f.elements.reason.required = true;
  $('send-button').textContent = retract ? 'Retract message' : 'Save edit';
  $('cancel-revision').hidden = false;
  f.scrollIntoView();
}
function resetRevision() {
  editTarget = null;
  retracting = false;
  $('send').elements.text.hidden = false;
  $('send').elements.text.required = true;
  $('send').elements.reason.hidden = true;
  $('send').elements.reason.required = false;
  $('send-button').textContent = 'Send';
  $('cancel-revision').hidden = true;
}
$('cancel-revision').onclick = () => {
  resetRevision();
  $('send').reset();
};
async function postRecord(kind, data, text = '', reply_to, to) {
  return mutation('/messages', {
    kind,
    data,
    text,
    ...(reply_to ? { reply_to } : {}),
    ...(to ? { to } : {}),
  });
}
async function loadRecords() {
  const [digest, pins, decisions, requests, statuses] = await Promise.all(
    ['/digest', '/pins', '/decisions', '/requests', '/status'].map((path) =>
      api('/' + room + path),
    ),
  );
  $('digest').replaceChildren();
  const notice = document.createElement('p');
  notice.textContent =
    digest.pending_count +
    ' pending deliveries · ' +
    digest.open_requests.length +
    ' open requests (up to 20 shown). Read linked evidence; this view does not acknowledge work.';
  $('digest').append(notice);
  for (const item of digest.unread) {
    const p = document.createElement('p');
    p.append(evidenceLink(item.id, item.actor.nick + ': ' + item.excerpt));
    $('digest').append(p);
  }
  $('pins').replaceChildren();
  for (const pin of pins.pins) {
    const p = document.createElement('p');
    p.append(
      evidenceLink(
        pin.message_id,
        pin.name + ' · ' + pin.version + ' · ' + pin.sha256.slice(0, 12) + '…',
      ),
    );
    p.append(document.createTextNode(' · producer assertion'));
    $('pins').append(p);
  }
  $('statuses').replaceChildren();
  for (const record of statuses.entries) {
    const p = document.createElement('p');
    p.textContent =
      (record.participant_nick || record.author_id) +
      ' · ' +
      record.value.text +
      (!record.active ? ' · inactive/expired' : '') +
      ' · ' +
      new Date(record.ts).toLocaleString();
    $('statuses').append(p);
  }
  $('decisions').replaceChildren();
  for (const decision of decisions.decisions) {
    const article = document.createElement('article'),
      p = document.createElement('p');
    p.textContent = decision.action + ' · scope: ' + decision.scope;
    article.append(p, evidenceLink(decision.request_id, 'Decision evidence'));
    if (decision.selected) {
      const selected = document.createElement('p');
      selected.textContent =
        'Owner credential selected ' +
        decision.selected.data.option_id +
        ' · ' +
        decision.selected.iso +
        '. Host authorization still applies.';
      article.append(selected);
    } else if (decision.expired)
      article.append(document.createTextNode('Expired decision request'));
    else if (currentActor.role === 'owner' && !currentArchived) {
      for (const option of decision.options) {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent =
          option.label + (decision.recommended === option.id ? ' (recommended)' : '');
        button.onclick = async () => {
          try {
            await postRecord(
              'agentmeet.decision.selected',
              { request_id: decision.request_id, option_id: option.id },
              '',
              decision.request_id,
            );
            await refresh();
          } catch (e) {
            report(e);
          }
        };
        article.append(button);
      }
    }
    $('decisions').append(article);
  }
  $('requests').replaceChildren();
  for (const record of requests.requests) {
    const p = document.createElement('p');
    p.append(
      evidenceLink(
        record.message_id,
        record.subject + ' · ' + record.state + ' · revision ' + record.revision,
      ),
    );
    $('requests').append(p);
  }
  if (location.hash)
    document.getElementById(decodeURIComponent(location.hash.slice(1)))?.scrollIntoView();
}
$('search-form').onsubmit = async (e) => {
  e.preventDefault();
  try {
    const data = await api(
      '/' + room + '/search?q=' + encodeURIComponent(e.target.elements.q.value),
    );
    $('search-results').replaceChildren();
    for (const m of data.messages) {
      const p = document.createElement('p');
      const excerpt = m.current?.retracted
        ? '[Retracted: original event matched]'
        : m.current?.text || m.text || m.data?.text || JSON.stringify(m.data);
      p.append(
        evidenceLink(
          m.id,
          m.actor.nick + ' · ' + m.kind + ': ' + [...excerpt].slice(0, 280).join(''),
        ),
      );
      $('search-results').append(p);
    }
    if (!data.messages.length) $('search-results').textContent = 'No matches.';
  } catch (e) {
    report(e);
  }
};
$('request-form').onsubmit = async (e) => {
  e.preventDefault();
  try {
    const f = e.target.elements;
    await postRecord(
      'agentmeet.request',
      {
        subject: f.subject.value,
        ...(f.acceptance.value ? { acceptance: f.acceptance.value } : {}),
      },
      f.subject.value,
      undefined,
      f.to.value ? [f.to.value] : undefined,
    );
    e.target.reset();
    await refresh();
  } catch (e) {
    report(e);
  }
};
$('pin-form').onsubmit = async (e) => {
  e.preventDefault();
  try {
    const f = e.target.elements;
    await postRecord('agentmeet.pin', {
      name: f.name.value,
      version: f.version.value,
      sha256: f.sha256.value,
      url: f.url.value,
    });
    e.target.reset();
    await refresh();
  } catch (e) {
    report(e);
  }
};
$('status-form').onsubmit = async (e) => {
  e.preventDefault();
  try {
    let revision = 0;
    try {
      const data = await api('/' + room + '/state/status:' + currentActor.id);
      revision = data.entry.revision;
      if (data.entry.value?.text === e.target.elements.text.value) return;
    } catch (error) {
      if (error.status !== 404) throw error;
    }
    await mutation('/status', { text: e.target.elements.text.value }, revision, 'PUT');
    e.target.reset();
    await refresh();
  } catch (e) {
    report(e);
  }
};
