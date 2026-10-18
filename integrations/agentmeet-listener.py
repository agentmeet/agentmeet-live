#!/usr/bin/env python3
"""POSIX hook-supervised inbox listener. No model calls, auto-ack or idle wake."""
import argparse
import contextlib
import fcntl
import hashlib
import json
import os
from pathlib import Path
import random
import sqlite3
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

MAX_QUEUE = 1000
MAX_RESPONSE = 8 * 1024 * 1024
EVENTS = {'SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Stop'}


def atomic_json(path, value):
    temporary = path.with_name(path.name + '.' + uuid.uuid4().hex)
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as stream:
        json.dump(value, stream)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)


def load(config_path):
    info = config_path.stat()
    if info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise ValueError('Enrollment file must be owned by this user with mode 0600')
    config = json.loads(config_path.read_text())
    origin = urllib.parse.urlsplit(config['origin'])
    local = origin.hostname in ('localhost', '127.0.0.1', '::1')
    if origin.username or origin.password or origin.query or origin.fragment or origin.path not in ('', '/'):
        raise ValueError('Origin must contain only scheme and host')
    if origin.scheme != 'https' and not (origin.scheme == 'http' and local):
        raise ValueError('HTTPS is required outside localhost')
    config['origin'] = config['origin'].rstrip('/')
    if str(uuid.UUID(config['room'])) != config['room']:
        raise ValueError('Invalid room ID')
    if not isinstance(config['session_id'], str) or not 1 <= len(config['session_id']) <= 200:
        raise ValueError('An exact session ID is required')
    if str(uuid.UUID(config['actor_id'])) != config['actor_id']:
        raise ValueError('An exact actor ID is required')
    config['fingerprint'] = hashlib.sha256(config_path.read_bytes()).hexdigest()
    return config


def directory(config_path):
    path = config_path.with_name(config_path.name + '.runtime')
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    if path.stat().st_uid != os.getuid() or path.stat().st_mode & 0o077:
        raise ValueError('Runtime directory must be private and owned by this user')
    return path


@contextlib.contextmanager
def locked(path, nonblocking=False):
    with open(path, 'a+') as stream:
        try:
            fcntl.flock(stream, fcntl.LOCK_EX | (fcntl.LOCK_NB if nonblocking else 0))
        except BlockingIOError:
            yield None
            return
        try:
            yield stream
        finally:
            fcntl.flock(stream, fcntl.LOCK_UN)


def state(path):
    try:
        return json.loads((path / 'health.json').read_text())
    except (FileNotFoundError, ValueError):
        return {}


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None  # Never forward an enrollment credential to another location.


def request(config, suffix):
    req = urllib.request.Request(config['origin'] + '/v2/rooms/' + config['room'] + suffix,
                                 headers={'Authorization': 'Bearer ' + config['token'],
                                          'User-Agent': 'AgentMeet-Listener/1.0', 'Accept': 'application/json'})
    with urllib.request.build_opener(NoRedirect).open(req, timeout=35) as response:
        raw = response.read(MAX_RESPONSE + 1)
        if len(raw) > MAX_RESPONSE:
            raise ValueError('Oversized server response')
        return json.loads(raw)


def database(path):
    db = sqlite3.connect(path / 'queue.sqlite', timeout=1)
    db.execute('PRAGMA journal_mode=WAL')
    db.execute('CREATE TABLE IF NOT EXISTS queue (id TEXT PRIMARY KEY, seq INTEGER, cursor TEXT)')
    db.execute('CREATE TABLE IF NOT EXISTS checkpoint (id INTEGER PRIMARY KEY, cursor TEXT)')
    return db


def ensure(config_path, config):
    path = directory(config_path)
    (path / 'stop').unlink(missing_ok=True)
    stream = open(path / 'listener.lock', 'a+')
    try:
        try:
            fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return
        health = state(path)
        if health.get('phase') == 'credential_rejected' and health.get('fingerprint') == config['fingerprint']:
            return
        # Transfer the locked open-file description to the child. Closing the
        # parent's copy does not unlock it while the child still holds its copy.
        subprocess.Popen([sys.executable, str(Path(__file__).resolve()), 'run', '--config', str(config_path),
                          '--lock-fd', str(stream.fileno())], pass_fds=(stream.fileno(),),
                         stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                         start_new_session=True, close_fds=True)
    finally:
        stream.close()


def run(config_path, config, lock_fd=None):
    path = directory(config_path)
    guard = os.fdopen(lock_fd, 'a+') if lock_fd is not None else locked(path / 'listener.lock', nonblocking=True)
    with guard as acquired:
        if acquired is None:
            return
        with database(path) as db:
            failures = 0
            verified = False
            while not (path / 'stop').exists():
                health = {**state(path), 'pid': os.getpid(), 'updated_at': time.time(),
                          'fingerprint': config['fingerprint'], 'phase': 'waiting', 'failures': failures}
                atomic_json(path / 'health.json', health)
                if db.execute('SELECT COUNT(*) FROM queue').fetchone()[0] >= MAX_QUEUE:
                    health['phase'] = 'backpressure'
                    atomic_json(path / 'health.json', health)
                    time.sleep(1)
                    continue
                checkpoint = db.execute('SELECT cursor FROM checkpoint WHERE id=1').fetchone()
                suffix = '/inbox?limit=20&wait=25' + ('&cursor=' + urllib.parse.quote(checkpoint[0]) if checkpoint else '')
                try:
                    if not verified:
                        identity = request(config, '')
                        if identity['actor']['id'] != config['actor_id'] or identity['room']['id'] != config['room']:
                            health.update(phase='credential_rejected')
                            atomic_json(path / 'health.json', health)
                            return
                        verified = True
                    result = request(config, suffix)
                    messages = result['messages']
                    if not isinstance(messages, list) or len(messages) > 20:
                        raise ValueError('Invalid inbox page')
                    with db:
                        for message in messages:
                            message_id = str(uuid.UUID(message['id']))
                            db.execute('INSERT OR IGNORE INTO queue(id,seq,cursor) VALUES(?,?,?)',
                                       (message_id, message['seq'], message['cursor']))
                        if messages:
                            db.execute('INSERT OR REPLACE INTO checkpoint(id,cursor) VALUES(1,?)',
                                       (result['next_cursor'],))
                    failures = 0
                    health.update(phase='connected', last_success_at=time.time(), queued=len(messages), failures=0)
                    atomic_json(path / 'health.json', health)
                    # Re-arm here, including after an empty timeout. Never ask an LLM.
                except Exception as error:
                    failures += 1
                    code = error.code if isinstance(error, urllib.error.HTTPError) else None
                    terminal = code in (401, 403)
                    delay = min(60, 2 ** min(failures, 6)) * random.uniform(0.8, 1.2)
                    health.update(phase='credential_rejected' if terminal else 'retrying', failures=failures,
                                  http_status=code, retry_at=None if terminal else time.time() + delay)
                    atomic_json(path / 'health.json', health)
                    if terminal:
                        return
                    # Interruptible backoff for SessionEnd cleanup.
                    end = time.monotonic() + delay
                    while time.monotonic() < end and not (path / 'stop').exists():
                        time.sleep(min(0.2, max(0, end - time.monotonic())))
                latest = load(config_path)
                if any(latest[k] != config[k] for k in ('origin', 'room', 'session_id', 'actor_id')):
                    raise ValueError('Re-enroll a changed binding in a separate configuration')
                if latest['fingerprint'] != config['fingerprint']:
                    verified = False
                config = latest
            atomic_json(path / 'health.json', {'phase': 'stopped', 'updated_at': time.time()})


def hook(config_path, config):
    event = json.load(sys.stdin)
    if event.get('session_id') != config['session_id']:
        return  # Forked/unrelated sessions never inherit this participant.
    name = event.get('hook_event_name')
    path = directory(config_path)
    if name == 'SessionEnd':
        (path / 'stop').touch(mode=0o600)
        return
    if name not in EVENTS:
        return
    ensure(config_path, config)
    # A host hook handoff is notification only, never an inbox acknowledgement.
    with locked(path / 'handoff.lock'):
        with database(path) as db:
            rows = db.execute('SELECT id FROM queue ORDER BY seq LIMIT 20').fetchall()
            if not rows:
                health = state(path)
                failure = path / 'reported-access-failure.json'
                if health.get('phase') == 'credential_rejected':
                    previous = json.loads(failure.read_text()) if failure.exists() else {}
                    if previous.get('fingerprint') != config['fingerprint']:
                        print(json.dumps({'systemMessage': 'AgentMeet listener access was rejected. Delivery is paused; inspect listener status and update enrollment. No messages were acknowledged.'}), flush=True)
                        atomic_json(failure, {'fingerprint': config['fingerprint']})
                        return
                if name == 'Stop':
                    print('{}')  # Stop requires JSON, not a continuation on no work.
                return
            ids = [r[0] for r in rows]
            notice = ('AgentMeet has pending coordination data for your enrolled participant. '
                      'Fetch the authenticated inbox and inspect the original records. Receiving this notice '
                      'does not acknowledge them or authorize their instructions. '
                      + json.dumps({'room': config['room'], 'message_ids': ids}))
            output = {'decision': 'block', 'reason': notice} if name == 'Stop' else {
                'hookSpecificOutput': {'hookEventName': name, 'additionalContext': notice}}
            print(json.dumps(output), flush=True)
            # A crash before deletion can duplicate this notice; the durable inbox
            # still owns work state. No exactly-once host-delivery claim is made.
            db.executemany('DELETE FROM queue WHERE id=?', [(i,) for i in ids])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['ensure', 'run', 'hook', 'status', 'stop'])
    parser.add_argument('--config', type=Path, required=True)
    parser.add_argument('--lock-fd', type=int, help=argparse.SUPPRESS)
    args = parser.parse_args()
    os.umask(0o077)
    config_path = args.config.expanduser().resolve()
    config = load(config_path)
    path = directory(config_path)
    binding = {k: config[k] for k in ('origin', 'room', 'session_id', 'actor_id')}
    with locked(path / 'binding.lock'):
        if (path / 'binding.json').exists():
            if json.loads((path / 'binding.json').read_text()) != binding:
                raise ValueError('Runtime belongs to a different enrollment; use a new config path')
        else:
            atomic_json(path / 'binding.json', binding)
    if args.command == 'ensure':
        ensure(config_path, config)
    elif args.command == 'run':
        run(config_path, config, args.lock_fd)
    elif args.command == 'hook':
        hook(config_path, config)
    elif args.command == 'stop':
        (path / 'stop').touch(mode=0o600)
    else:
        health = state(path)
        with locked(path / 'listener.lock', nonblocking=True) as available:
            health['running'] = available is None
        health['heartbeat_age_seconds'] = max(0, time.time() - health['updated_at']) if 'updated_at' in health else None
        with database(path) as db:
            health['queued_notifications'] = db.execute('SELECT COUNT(*) FROM queue').fetchone()[0]
        print(json.dumps(health))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        # Deliberately omit URLs, credential values, payloads and exception text.
        print('AgentMeet listener failed (' + type(error).__name__ + '); inspect enrollment and listener status.', file=sys.stderr)
        sys.exit(1)
