/**
 * Smoke test of the packed SDK in a host application: scripts/host-fixture installed from the
 * tarball and built by `node scripts/check-package.mjs --keep-host .smoke/host`. Two viewers that
 * do not fill the window (points on the left, the sample building entered on the right), one copy
 * of three, Workers loaded from the package, and disposing one viewer leaves the other running.
 * Imagery and terrain come from the local stand-in tiles (tests/e2e/server.mjs).
 */
import { expect, test, type Page } from '@playwright/test';
import { backendOf, framesOf, liveWorkers, probeBackend, waitForGlobe, waitForViewer, watch, type SmokeWindow } from './smoke';

/** Frames a viewer draws in `ms` milliseconds. */
function frameCount(page: Page, name: string, ms: number): Promise<number> {
  return page.evaluate(
    ([n, duration]) =>
      new Promise<number>((resolve) => {
        let frames = 0;
        const off = (window as unknown as SmokeWindow)[n as string]!.events.on('frame', () => frames++);
        setTimeout(() => {
          off();
          resolve(frames);
        }, duration as number);
      }),
    [name, ms] as const,
  );
}

/** What scripts/host-fixture/main.ts records from the viewers' events. */
interface HostEvents {
  idle: { left: number; right: number };
  errors: string[];
}

test('host: two viewers from the package, dispose one then the other', async ({ page, baseURL }, info) => {
  const w = await watch(page, baseURL!);
  const backend = backendOf(info);
  await page.goto(backend === 'WebGL2' ? '/?webgl' : '/');
  const { software } = await probeBackend(page, info);

  for (const name of ['left', 'right']) await waitForViewer(page, name, backend);
  await waitForGlobe(page, ['left', 'right'], { drained: !software });
  expect(w.served.imagery, 'stand-in imagery tiles').toBeGreaterThan(0);
  expect(w.served.terrain, 'stand-in terrain tiles').toBeGreaterThan(0);
  // The public load state agrees: once the globes drained (GPU only, see waitForGlobe), both
  // viewers report idle through `loadState` and the 'idle' event.
  if (!software) {
    await expect
      .poll(() =>
        page.evaluate(() => {
          const win = window as unknown as SmokeWindow & { hostEvents: HostEvents };
          return ['left', 'right'].every((n) => win[n]!.loadState.idle && win.hostEvents.idle[n as 'left' | 'right'] > 0);
        }),
      )
      .toBe(true);

    // Idle frame-rate throttling (default 10 fps) once the left view has been quiet for a second,
    // and back to the full rate on requestRender().
    await expect.poll(() => page.evaluate(() => (window as unknown as SmokeWindow).left!.stats.throttled), { timeout: 15_000 }).toBe(true);
    const idle = await frameCount(page, 'left', 1000);
    expect(idle, 'frames per second while quiet').toBeLessThanOrEqual(15);
    await page.evaluate(() => (window as unknown as SmokeWindow).left!.requestRender());
    expect(await frameCount(page, 'left', 500), 'frames in 0.5 s after requestRender()').toBeGreaterThan(idle);
  }

  // Right: the sample building is entered. Left: the point in view (the other one lies behind the
  // camera and is culled) has a marker, and markers stay inside their container.
  await page.waitForFunction(() => (window as unknown as SmokeWindow).right!.indoor.current?.type === 'building', undefined, { timeout: 30_000 });
  await expect(page.locator('#left .tv-marker:visible').first()).toBeVisible();
  await framesOf(page, 'left');
  const outside = await page.evaluate(() =>
    ['left', 'right'].flatMap((id) => {
      const box = document.getElementById(id)!.getBoundingClientRect();
      return [...document.querySelectorAll<HTMLElement>(`#${id} .tv-marker`)]
        .filter((m) => m.offsetParent !== null && getComputedStyle(m).visibility !== 'hidden')
        .map((m) => m.getBoundingClientRect())
        .filter((r) => r.width > 0 && (r.right < box.left || r.left > box.right || r.bottom < box.top || r.top > box.bottom))
        .map((r) => `${id}: marker at ${Math.round(r.left)},${Math.round(r.top)}`);
    }),
  );
  expect(outside, 'markers outside their viewer').toEqual([]);
  await framesOf(page, 'right');
  expect(await liveWorkers(page)).toBeGreaterThan(0);

  // A container that is not displayed draws nothing, and draws again once shown.
  await page.evaluate(() => (document.getElementById('right')!.style.display = 'none'));
  await page.waitForTimeout(300);
  expect(await frameCount(page, 'right', 600), 'frames while the container is hidden').toBe(0);
  await page.evaluate(() => (document.getElementById('right')!.style.display = ''));
  await framesOf(page, 'right');

  // Dispose the left viewer: its DOM and container changes go, the right one keeps drawing.
  await page.evaluate(() => (window as unknown as SmokeWindow).left!.dispose());
  await expect(page.locator('#left')).toBeEmpty();
  expect(await page.evaluate(() => document.getElementById('left')!.className)).toBe('map');
  expect(await page.evaluate(() => document.getElementById('left')!.hasAttribute('tabindex'))).toBe(false);
  await framesOf(page, 'right');

  // Dispose the right one: every Worker (shared ones included) is closed.
  await page.evaluate(() => (window as unknown as SmokeWindow).right!.dispose());
  await expect(page.locator('#right')).toBeEmpty();
  await expect.poll(() => liveWorkers(page)).toBe(0);

  // No load failures reported through the viewers' 'error' events (the stand-ins answer everything).
  expect(await page.evaluate(() => (window as unknown as { hostEvents: HostEvents }).hostEvents.errors), 'viewer error events').toEqual([]);
  expect(w.blocked, 'requests to other origins').toEqual([]);
  expect(w.threeCopies, 'one copy of three').toEqual([]);
  expect(w.errors).toEqual([]);
});
