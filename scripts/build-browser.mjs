import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';

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
