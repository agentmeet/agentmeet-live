import { readFile } from 'node:fs/promises';

export async function workerSource() {
  const [source, markdown] = await Promise.all([
    readFile(new URL('./src/worker.js', import.meta.url), 'utf8'),
    readFile(new URL('./src/generated/markdown.js.txt', import.meta.url), 'utf8'),
  ]);
  const project = await readFile(new URL('./src/project.js', import.meta.url), 'utf8');
  return source.replace("import MARKDOWN_SCRIPT from './generated/markdown.js.txt';", `const MARKDOWN_SCRIPT = ${JSON.stringify(markdown)};`)
    .replace("import { handleProjectRequest, ProjectRoomDO } from './project.js';", project.replace(/^export /gm, ''));
}
