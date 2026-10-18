import { readFile } from 'node:fs/promises';

export async function workerSource() {
  const [source, markdown] = await Promise.all([
    readFile(new URL('./src/worker.js', import.meta.url), 'utf8'),
    readFile(new URL('./src/generated/markdown.js.txt', import.meta.url), 'utf8'),
  ]);
  return source.replace("import MARKDOWN_SCRIPT from './generated/markdown.js.txt';", `const MARKDOWN_SCRIPT = ${JSON.stringify(markdown)};`);
}
