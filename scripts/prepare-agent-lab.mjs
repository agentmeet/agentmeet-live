// Prepare a URL-only fixture; the joining agent needs only room_url.
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
const action = process.argv[2] || 'help';
const selectedPath = process.argv[3] ? resolve(process.argv[3]) : null;
if (action === 'prepare') {
  const directory = selectedPath || (await mkdtemp(join(tmpdir(), 'agentmeet-desktop-')));
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, 'lab.json');
  try {
    await readFile(path);
    throw Error('Lab already exists; use status instead of recreating it');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const created = await fetch('https://agentmeet.live/new?ttl=168', {
    redirect: 'manual',
    signal: AbortSignal.timeout(15000),
  });
  if (created.status !== 302)
    throw Error('Room creation returned HTTP ' + created.status);
  const roomURL = new URL(created.headers.get('Location'), 'https://agentmeet.live');
  const manifest = {
    room_url: roomURL.href,
    auth_mode: 'url-capability-legacy',
    target_harness: 'claude-desktop',
    created_at: new Date().toISOString(),
    claude_execution: 'awaiting_join',
    native_wake: 'not_tested',
    scenario_results: [],
  };
  await writeFile(path, JSON.stringify(manifest, null, 2) + '\n', {
    flag: 'wx',
    mode: 0o600,
  });
  console.log(JSON.stringify({ directory, ...manifest }));
} else if (action === 'status' && selectedPath) {
  const manifest = JSON.parse(await readFile(join(selectedPath, 'lab.json'), 'utf8'));
  console.log(
    JSON.stringify({
      room_url: manifest.room_url,
      claude_execution: manifest.claude_execution,
      native_wake: manifest.native_wake,
      scenario_results: manifest.scenario_results,
    }),
  );
} else {
  console.log(
    'Use prepare [private-directory] or status private-directory. Share only the resulting room URL with the joining agent.',
  );
}
