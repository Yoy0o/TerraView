/**
 * Runnable examples (`npm run examples:dev`, `npm run build:examples`): one page per folder under
 * `examples/` plus the gallery (`examples/index.html`), listed in `examples/catalog.ts`.
 *
 * Like the demo, the examples import the SDK by its package name, resolved to the sources here,
 * so they use the same public entry a host application would. `base: './'` keeps every link
 * relative: the build works at any path (GitHub Pages publishes it under `<site>/examples/`).
 * A `--outDir` given on the command line is resolved against `root` (examples/), hence
 * `--outDir ../dist-site/examples` in `npm run site:build`.
 */
import { readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const fromRoot = (path: string) => fileURLToPath(new URL(path, import.meta.url));
const root = fromRoot('./examples');

/** The gallery and every `examples/<id>/index.html`. */
const pages: Record<string, string> = { index: `${root}/index.html` };
for (const entry of readdirSync(root, { withFileTypes: true })) {
  if (entry.isDirectory() && existsSync(`${root}/${entry.name}/index.html`)) pages[entry.name] = `${root}/${entry.name}/index.html`;
}

export default defineConfig({
  root,
  base: './',
  resolve: {
    alias: [
      { find: /^terra-viewer\/style\.css$/, replacement: fromRoot('./src/style.css') },
      { find: /^terra-viewer$/, replacement: fromRoot('./src/index.ts') },
    ],
  },
  build: {
    // Top-level await in the examples' main.ts.
    target: 'es2022',
    outDir: fromRoot('./dist-examples'),
    emptyOutDir: true,
    chunkSizeWarningLimit: 2500,
    rollupOptions: { input: pages },
  },
  worker: {
    format: 'es',
  },
  server: {
    host: true,
    port: 5175,
    fs: { allow: [fromRoot('.')] },
  },
});
