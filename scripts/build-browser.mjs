import { build } from 'esbuild';
import { mkdir, writeFile, readFile } from 'node:fs/promises';

await mkdir('src/generated', { recursive: true });
for (const entry of ['markdown', 'project']) {
  const result = await build({
    entryPoints: [`src/client/${entry}.js`],
    bundle: true,
    minify: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2020',
    write: false,
  });
  await writeFile(`src/generated/${entry}.js.txt`, result.outputFiles[0].text);
}

// Bundle onboarding with the release so GitHub outages or stale caches cannot
// strand joining agents on a different version of the reception instructions.
for (const [name, path] of Object.entries({
  instructions: 'skills/agentmeet/SKILL.md',
  listener: 'docs/LISTENER.md',
  'project-api': 'docs/PROJECT-API.md',
}))
  await writeFile(`src/generated/${name}.md.txt`, await readFile(path));
await mkdir('skills/agentmeet/references', { recursive: true });
await writeFile('skills/agentmeet/references/listener.md', await readFile('docs/LISTENER.md'));
