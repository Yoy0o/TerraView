/**
 * Smoke test of the packed SDK in a host application: scripts/host-fixture installed from the
 * tarball and built by `node scripts/check-package.mjs --keep-host .smoke/host`. Two viewers that
 * do not fill the window (points on the left, the sample building entered on the right), one copy
 * of three, Workers loaded from the package, and disposing one viewer leaves the other running.
 * Imagery and terrain come from the local stand-in tiles (tests/e2e/server.mjs).
 */
import { expect, test } from '@playwright/test';
import { backendOf, framesOf, liveWorkers, probeBackend, waitForGlobe, waitForViewer, watch, type SmokeWindow } from './smoke';

test('host: two viewers from the package, dispose one then the other', async ({ page, baseURL }, info) => {
  const w = await watch(page, baseURL!);
  const backend = backendOf(info);
  await page.goto(backend === 'WebGL2' ? '/?webgl' : '/');
  const { software } = await probeBackend(page, info);

  for (const name of ['left', 'right']) await waitForViewer(page, name, backend);
  await waitForGlobe(page, ['left', 'right'], { drained: !software });
  expect(w.served.imagery, 'stand-in imagery tiles').toBeGreaterThan(0);
  expect(w.served.terrain, 'stand-in terrain tiles').toBeGreaterThan(0);

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

  expect(w.blocked, 'requests to other origins').toEqual([]);
  expect(w.threeCopies, 'one copy of three').toEqual([]);
  expect(w.errors).toEqual([]);
});
