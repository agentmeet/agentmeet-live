import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';

const result = await build({
  entryPoints: ['src/client/markdown.js'], bundle: true, minify: true,
  format: 'iife', platform: 'browser', target: 'es2020', write: false,
});
await mkdir('src/generated', { recursive: true });
await writeFile('src/generated/markdown.js.txt', result.outputFiles[0].text);
