/**
 * Demo application (`npm run dev`, `npm run build:demo`). It imports the SDK by
 * its package name, resolved to the sources here, so it uses the same public
 * entry a host application would.
 *
 * Draco / Basis (KTX2) decoders are referenced by three.js loaders through
 * `new URL(..., import.meta.url)`, so Vite bundles them automatically.
 */
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const fromRoot = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  root: fromRoot('./demo'),
  base: './',
  resolve: {
    alias: [
      { find: /^terra-view\/style\.css$/, replacement: fromRoot('./src/style.css') },
      { find: /^terra-view$/, replacement: fromRoot('./src/index.ts') },
    ],
  },
  build: {
    target: 'es2022',
    outDir: fromRoot('./dist-demo'),
    emptyOutDir: true,
    chunkSizeWarningLimit: 2500,
  },
  worker: {
    format: 'es',
  },
  server: {
    host: true,
    fs: { allow: [fromRoot('.')] },
  },
});
