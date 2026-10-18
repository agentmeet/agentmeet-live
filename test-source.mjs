import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

// Apply fault hooks to raw source before bundling the same module graph used by
// deployment. Production source never contains these injected test routes.
export async function workerSource(transforms = {}) {
  const source = await readFile(new URL('./src/worker.js', import.meta.url), 'utf8');
  const result = await build({
    stdin: {
      contents: transforms.worker ? transforms.worker(source) : source,
      resolveDir: fileURLToPath(new URL('./src/', import.meta.url)),
      sourcefile: 'worker.js',
    },
    bundle: true,
    format: 'esm',
    write: false,
    loader: { '.txt': 'text' },
    plugins: [
      {
        name: 'test-project-faults',
        setup(plugin) {
          plugin.onLoad({ filter: /[\\/]src[\\/]project\.js$/ }, async ({ path }) => {
            const text = await readFile(path, 'utf8');
            return { contents: transforms.project ? transforms.project(text) : text, loader: 'js' };
          });
        },
      },
    ],
  });
  return result.outputFiles[0].text;
}
