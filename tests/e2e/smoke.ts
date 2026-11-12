/**
 * Shared parts of the browser smoke tests (`npm run smoke`, playwright.config.ts):
 *
 * - `watch(page)`: collects page errors, console errors and three.js's "multiple instances"
 *   warning, counts Workers created and terminated (an init script wraps `Worker`), and answers
 *   requests to other origins with the local tiles of tests/e2e/server.mjs (anything else from
 *   another origin is aborted and listed), so a run never depends on outside services.
 * - `backendOf(project)`: which renderer backend a project asks for.
 * - `waitForGlobe(...)`: waits until a viewer's globe has tiles on screen and nothing loading.
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

/** Skips the test when the browser has no WebGPU adapter (e.g. headless Linux CI without a GPU). */
export async function requireBackend(page: Page, info: TestInfo): Promise<void> {
  if (backendOf(info) !== 'WebGPU') return;
  const adapter = await page.evaluate(async () => !!(await navigator.gpu?.requestAdapter()));
  info.skip(!adapter, 'no WebGPU adapter in this browser');
}

/** Waits for `window[name]` to be a viewer and checks its backend. */
export async function waitForViewer(page: Page, name: string, backend: 'WebGL2' | 'WebGPU'): Promise<void> {
  // Not just `window[name]`: an element with that id (the container) is a window property too.
  await page.waitForFunction((n) => !!(window as unknown as SmokeWindow)[n]?.info, name, { timeout: 30_000 });
  const actual = await page.evaluate((n) => (window as unknown as SmokeWindow)[n]!.info.backend, name);
  expect(actual, `${name} backend`).toBe(backend);
}

/** Waits until the viewer's globe shows tiles with nothing loading or waiting for imagery. */
export async function waitForGlobe(page: Page, name: string): Promise<void> {
  await page.waitForFunction(
    (n) => {
      const s = (window as unknown as SmokeWindow)[n]!.globe.stats;
      return s.rendered > 0 && s.loading === 0 && s.queued === 0 && s.waitingImagery === 0;
    },
    name,
    { timeout: 150_000, polling: 250 },
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
