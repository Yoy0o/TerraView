/**
 * Library build of the SDK (`npm run build:lib`) and the Vitest setup.
 * The demo application has its own config: vite.demo.config.ts.
 *
 * - three and 3d-tiles-renderer stay external (peer dependencies), including
 *   their sub paths (`three/webgpu`, `three/tsl`, `three/addons/*`,
 *   `3d-tiles-renderer/plugins`), so a host that uses three itself gets one copy.
 * - Workers are emitted as separate files next to the entry and referenced with
 *   `new URL(..., import.meta.url)`, which Vite, webpack 5 and Rollup hosts resolve.
 * - The stylesheet is copied as dist/terraview.css (`terraview/style.css`).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';

const entry = fileURLToPath(new URL('./src/index.ts', import.meta.url));
const styleSheet = fileURLToPath(new URL('./src/style.css', import.meta.url));

/** Emits the hand-written SDK stylesheet unchanged: hosts import it on their own. */
function sdkStyleSheet(): Plugin {
  return {
    name: 'terraview:style',
    apply: 'build',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'terraview.css', source: readFileSync(styleSheet, 'utf8') });
    },
  };
}

export default defineConfig({
  base: './',
  resolve: {
    alias: { terraview: entry },
  },
  plugins: [sdkStyleSheet()],
  build: {
    target: 'es2022',
    outDir: 'dist',
    sourcemap: true,
    minify: false,
    lib: {
      entry,
      formats: ['es'],
      fileName: 'terraview',
    },
    rollupOptions: {
      external: [/^three($|\/)/, /^3d-tiles-renderer($|\/)/],
    },
  },
  worker: {
    format: 'es',
  },
});
