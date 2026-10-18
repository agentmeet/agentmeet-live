import concurrent.futures
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import urllib.parse
import uuid

SCRIPT = Path(__file__).parent / 'integrations/agentmeet-listener.py'


class ListenerTest(unittest.TestCase):
    def test_supervised_listener(self):
        room, actor, session = str(uuid.uuid4()), str(uuid.uuid4()), 'enrolled-session'
        messages, requests, active, maximum = [], [], 0, 0
        reject, fail_once = False, False
        condition = threading.Condition()

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_GET(self):
                nonlocal active, maximum, fail_once
                with condition:
                    requests.append(self.path)
                    if reject or fail_once:
                        self.send_response(401 if reject else 503)
                        fail_once = False
                        self.end_headers()
                        return
                if '/inbox?' not in self.path:
                    data = {'room': {'id': room}, 'actor': {'id': actor}}
                else:
                    cursor = int(urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query).get('cursor', ['0'])[0])
                    with condition:
                        active += 1
                        maximum = max(maximum, active)
                        data_messages = [m for m in messages if m['seq'] > cursor]
                        if not data_messages:
                            condition.wait(.15)
                            data_messages = [m for m in messages if m['seq'] > cursor]
                        active -= 1
                    data = {'messages': data_messages[:20], 'next_cursor': str(data_messages[min(19, len(data_messages)-1)]['seq']) if data_messages else str(cursor)}
                raw = json.dumps(data).encode()
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        server.daemon_threads = True
        threading.Thread(target=server.serve_forever, daemon=True).start()
        with tempfile.TemporaryDirectory() as tmp:
            config = Path(tmp) / 'enrollment.json'
            config.write_text(json.dumps({'origin': 'http://127.0.0.1:' + str(server.server_port), 'room': room,
                                          'actor_id': actor, 'session_id': session, 'token': 'test-token'}))
            config.chmod(0o600)
            runtime = config.with_name(config.name + '.runtime')

            def call(command, event=None):
                result = subprocess.run([sys.executable, str(SCRIPT), command, '--config', str(config)],
                                        input=json.dumps(event) if event else '', text=True, capture_output=True, timeout=5)
                self.assertEqual(result.returncode, 0, result.stderr)
                return result.stdout

            def status():
                return json.loads(call('status'))

            def until(predicate):
                end = time.monotonic() + 8
                while time.monotonic() < end:
                    if predicate():
                        return
                    time.sleep(.05)
                self.fail('Listener condition timed out: ' + json.dumps(status()))

            def event(name, sid=session):
                return {'hook_event_name': name, 'session_id': sid}

            try:
                self.assertEqual(call('hook', event('UserPromptSubmit', 'other-session')), '')
                self.assertEqual(len(requests), 0, 'unrelated sessions never start a listener')
                with concurrent.futures.ThreadPoolExecutor(max_workers=12) as executor:
                    self.assertEqual(list(executor.map(lambda _: call('ensure'), range(12))), [''] * 12)
                until(lambda: len(requests) >= 4)
                self.assertEqual(maximum, 1, 'simultaneous ensure calls own one long poll')
                self.assertEqual(call('hook', event('PostToolUse')), '')
                self.assertEqual(json.loads(call('hook', event('Stop'))), {})
                first = {'id': str(uuid.uuid4()), 'seq': 1, 'cursor': '1'}
                with condition:
                    messages.append(first)
                    condition.notify_all()
                until(lambda: status()['queued_notifications'] == 1)
                notice = json.loads(call('hook', event('PostToolUse')))
                self.assertIn(first['id'], notice['hookSpecificOutput']['additionalContext'])
                self.assertNotIn('test-token', json.dumps(notice))
                until(lambda: status()['queued_notifications'] == 0)
                time.sleep(.3)
                self.assertEqual(call('hook', event('UserPromptSubmit')), '', 'timeout does not notify or rediscover unacked IDs')
                pid = status()['pid']
                os.kill(pid, signal.SIGKILL)
                until(lambda: not status()['running'])
                call('ensure')
                until(lambda: status().get('pid') != pid and status()['running'])
                self.assertEqual(status()['queued_notifications'], 0, 'checkpoint survives a crash without acknowledging work')
                fail_once = True
                until(lambda: status().get('phase') == 'retrying')
                second = {'id': str(uuid.uuid4()), 'seq': 2, 'cursor': '2'}
                with condition:
                    messages.append(second)
                    condition.notify_all()
                until(lambda: status()['queued_notifications'] == 1)
                continuation = json.loads(call('hook', event('Stop')))
                self.assertEqual(continuation['decision'], 'block')
                self.assertIn(second['id'], continuation['reason'])
                self.assertFalse(any('/ack' in path for path in requests), 'transport never acknowledges messages')
                reject = True
                until(lambda: status().get('phase') == 'credential_rejected' and not status()['running'])
                before = len(requests)
                for _ in range(3):
                    call('ensure')
                time.sleep(.2)
                self.assertEqual(len(requests), before, 'revocation is not retried at every hook')
            finally:
                call('stop')
                health = status()
                if health['running']:
                    os.kill(health['pid'], signal.SIGKILL)
                server.shutdown()
                server.server_close()


if __name__ == '__main__':
    unittest.main()
