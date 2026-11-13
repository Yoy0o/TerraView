/**
 * Shared parts of the browser smoke tests (`npm run smoke`, playwright.config.ts):
 *
 * - `watch(page)`: collects page errors, console errors and three.js's "multiple instances"
 *   warning, counts Workers created and terminated (an init script wraps `Worker`), and answers
 *   requests to other origins with the local tiles of tests/e2e/server.mjs (anything else from
 *   another origin is aborted and listed), so a run never depends on outside services.
 * - `backendOf(project)`: which renderer backend a project asks for.
 * - `probeBackend(page, info)`: skips when that backend is missing, tells whether it renders in
 *   software (SwiftShader: CI, `SMOKE_NO_GPU=1`).
 * - `waitForGlobe(...)`: waits until the viewers' globes are ready (stricter on a real GPU).
 *
 * Code inside `page.evaluate` runs in the browser: it may use imported types, not imported values.
 */
import { expect, type Page, type TestInfo } from '@playwright/test';
import type { GeoViewer } from 'terra-view';

/** Counters the init script keeps on `window.__smoke`. */
export interface SmokeState {
  workers: { created: number; terminated: number };
  /** Indoor level events in order, `type:id` (`globe` for null). */
  levels: string[];
}

/** The page's globals as the smoke tests use them. */
export type SmokeWindow = Window & { __smoke: SmokeState } & Record<string, GeoViewer | undefined>;

export interface Watch {
  /** Uncaught exceptions and `console.error` lines. */
  errors: string[];
  /** Requests to other origins that had no stand-in and were aborted. */
  blocked: string[];
  /** Stand-in tiles served, by kind. */
  served: { imagery: number; terrain: number };
  /** Lines of the "Multiple instances of Three.js" warning. */
  threeCopies: string[];
}

/** Other origins answered with a local tile (tests/e2e/server.mjs). */
const STAND_INS: { kind: keyof Watch['served']; test: RegExp; path: string }[] = [
  { kind: 'terrain', test: /elevation-tiles-prod\/terrarium\//, path: '/__tiles/terrain.png' },
  { kind: 'imagery', test: /arcgisonline\.com\/.*\/tile\/|tile\.openstreetmap\.org|basemaps\.cartocdn\.com/, path: '/__tiles/imagery.png' },
];

export async function watch(page: Page, baseURL: string): Promise<Watch> {
  const w: Watch = { errors: [], blocked: [], served: { imagery: 0, terrain: 0 }, threeCopies: [] };
  page.on('pageerror', (err) => w.errors.push(`pageerror: ${err.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error') w.errors.push(`console.error: ${msg.text()}`);
    if (/Multiple instances of Three\.js/i.test(msg.text())) w.threeCopies.push(msg.text());
  });

  await page.addInitScript(() => {
    const state = { workers: { created: 0, terminated: 0 }, levels: [] as string[] };
    const Native = window.Worker;
    class TrackedWorker extends Native {
      private live = true;
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        state.workers.created++;
      }
      override terminate(): void {
        if (this.live) state.workers.terminated++;
        this.live = false;
        super.terminate();
      }
    }
    Object.assign(window, { Worker: TrackedWorker, __smoke: state });
  });

  const local = new URL(baseURL).origin;
  // Context-level, so requests made by Workers are routed too.
  await page.context().route('**/*', async (route) => {
    const url = route.request().url();
    if (url.startsWith(local) || url.startsWith('data:') || url.startsWith('blob:')) return route.continue();
    const standIn = STAND_INS.find((s) => s.test.test(url));
    if (!standIn) {
      w.blocked.push(url);
      return route.abort('blockedbyclient');
    }
    w.served[standIn.kind]++;
    return route.fulfill({ response: await route.fetch({ url: local + standIn.path }) });
  });
  return w;
}

/** The backend a project tests: its name ends in `webgl` or `webgpu`. */
export function backendOf(info: TestInfo): 'WebGL2' | 'WebGPU' {
  return info.project.name.endsWith('webgpu') ? 'WebGPU' : 'WebGL2';
}

/**
 * Skips the test when the browser has no adapter for the project's backend, and returns whether
 * that backend renders in software (SwiftShader / llvmpipe / WARP): GPU-less CI runners, or
 * `SMOKE_NO_GPU=1` locally. Asks the browser rather than reading the environment, so a runner
 * that does have a GPU gets the strict checks.
 */
export async function probeBackend(page: Page, info: TestInfo): Promise<{ software: boolean }> {
  const probe = await page.evaluate(async (backend) => {
    const SOFTWARE = /swiftshader|llvmpipe|softpipe|software|warp|microsoft basic render/i;
    if (backend === 'WebGPU') {
      const adapter = await navigator.gpu?.requestAdapter();
      if (!adapter) return null;
      const a = adapter.info as GPUAdapterInfo & { isFallbackAdapter?: boolean };
      return { software: a.isFallbackAdapter === true || SOFTWARE.test(`${a.vendor} ${a.architecture} ${a.description}`) };
    }
    const gl = document.createElement('canvas').getContext('webgl2');
    if (!gl) return null;
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const renderer = String(gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER));
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return { software: SOFTWARE.test(renderer) };
  }, backendOf(info));
  info.skip(!probe, `no ${backendOf(info)} adapter in this browser`);
  info.annotations.push({ type: 'renderer', description: probe!.software ? 'software' : 'hardware' });
  return probe!;
}

/** Waits for `window[name]` to be a viewer and checks its backend. */
export async function waitForViewer(page: Page, name: string, backend: 'WebGL2' | 'WebGPU'): Promise<void> {
  // Not just `window[name]`: an element with that id (the container) is a window property too.
  await page.waitForFunction((n) => !!(window as unknown as SmokeWindow)[n]?.info, name, { timeout: 30_000 });
  const actual = await page.evaluate((n) => (window as unknown as SmokeWindow)[n]!.info.backend, name);
  expect(actual, `${name} backend`).toBe(backend);
}

/**
 * Waits until the globes of the named viewers (all at once) are ready:
 *
 * - every tile on screen shows its own imagery (none magnified from an ancestor or blank);
 * - `drained` (on a real GPU, a few seconds): also nothing loading or queued, so the scheduler
 *   runs dry instead of stalling.
 *
 * In software rendering, imagery takes about a second per tile to decode while SwiftShader keeps
 * the CPU busy, and the low-priority loads left after the screen is complete (ancestor imagery kept
 * as fallbacks, a third of the slots by design) took longer than the whole on-screen part on a
 * 2-core runner. That measures SwiftShader, not the SDK, so it is checked on a GPU only.
 */
export async function waitForGlobe(page: Page, names: string[], { drained }: { drained: boolean }): Promise<void> {
  await page.waitForFunction(
    ([ns, all]) =>
      (ns as string[]).every((n) => {
        const s = (window as unknown as SmokeWindow)[n]!.globe.stats;
        return s.rendered > 0 && s.waitingImagery === 0 && (!all || (s.loading === 0 && s.queued === 0));
      }),
    [names, drained] as const,
    { timeout: 180_000, polling: 250 },
  );
}

/** Resolves after the viewer has drawn `count` more frames. */
export async function framesOf(page: Page, name: string, count = 3): Promise<void> {
  await page.evaluate(
    ([n, c]) =>
      new Promise<void>((resolve) => {
        const viewer = (window as unknown as SmokeWindow)[n as string]!;
        let left = c as number;
        const off = viewer.events.on('frame', () => {
          if (--left > 0) return;
          off();
          resolve();
        });
      }),
    [name, count] as const,
  );
}

/** Live Workers: created minus terminated. */
export async function liveWorkers(page: Page): Promise<number> {
  return page.evaluate(() => {
    const w = (window as unknown as SmokeWindow).__smoke.workers;
    return w.created - w.terminated;
  });
}
