/**
 * Smoke test of the demo application (dist-demo/, built with `npm run build:demo`): starts with the
 * offline debug imagery and the demo office building, walks building → floor → room and back to
 * the globe, then disposes the viewer. Fails on any page error, console error or request to
 * another origin.
 */
import { expect, test } from '@playwright/test';
import { backendOf, framesOf, liveWorkers, probeBackend, waitForGlobe, waitForViewer, watch, type SmokeWindow } from './smoke';

test('demo: globe, building levels, dispose', async ({ page, baseURL }, info) => {
  const w = await watch(page, baseURL!);
  const backend = backendOf(info);
  await page.goto(`/?imagery=debug&noterrain&intro=0&clouds=0&demo${backend === 'WebGL2' ? '&webgl' : ''}`);
  const { software } = await probeBackend(page, info);

  await waitForViewer(page, 'viewer', backend);
  await waitForGlobe(page, ['viewer'], { drained: !software });

  // ?demo adds the office building and enters it.
  await page.waitForFunction(() => (window as unknown as SmokeWindow).viewer!.indoor.current?.type === 'building', undefined, { timeout: 30_000 });
  const ids = await page.evaluate(async () => {
    const win = window as unknown as SmokeWindow;
    const indoor = win.viewer!.indoor;
    const building = indoor.current!;
    for (const type of ['beforeEnterLevel', 'enterLevel', 'leaveLevel'] as const) {
      indoor.events.on(type, (e) => win.__smoke.levels.push(`${type}:${e.object?.id ?? 'globe'}`));
    }
    const floor = building.children.find((c) => c.type === 'floor')!;
    const room = floor.children.find((c) => c.type === 'room')!;
    const quick = { duration: 0.3 };
    const steps = [
      await indoor.enter(floor, quick),
      await indoor.enter(room, quick),
      indoor.current === room && indoor.selected === room,
    ];
    return { building: building.id, floor: floor.id, room: room.id, steps };
  });
  expect(ids.steps).toEqual([true, true, true]);
  await framesOf(page, 'viewer');
  // Room labels are DOM markers inside the viewer container.
  await expect(page.locator('#viewer .tv-marker').first()).toBeAttached();

  const backSteps = await page.evaluate(async () => {
    const indoor = (window as unknown as SmokeWindow).viewer!.indoor;
    const steps: boolean[] = [];
    while (indoor.current) steps.push(await indoor.back());
    return steps;
  });
  expect(backSteps).toEqual([true, true, true]);

  const { building: b, floor: f, room: r } = ids;
  expect(await page.evaluate(() => (window as unknown as SmokeWindow).__smoke.levels)).toEqual([
    `beforeEnterLevel:${f}`,
    `enterLevel:${f}`,
    `beforeEnterLevel:${r}`,
    `enterLevel:${r}`,
    // Going up re-enters the parent (level effects are absolute states).
    `leaveLevel:${r}`,
    `beforeEnterLevel:${f}`,
    `enterLevel:${f}`,
    `leaveLevel:${f}`,
    `beforeEnterLevel:${b}`,
    `enterLevel:${b}`,
    `leaveLevel:${b}`,
    'beforeEnterLevel:globe',
    'enterLevel:globe',
  ]);
  await framesOf(page, 'viewer');

  // Dispose: canvas gone, every Worker the SDK started is closed.
  expect(await liveWorkers(page)).toBeGreaterThan(0);
  await page.evaluate(() => (window as unknown as SmokeWindow).viewer!.dispose());
  await expect(page.locator('#viewer canvas')).toHaveCount(0);
  await expect.poll(() => liveWorkers(page)).toBe(0);
  await page.waitForTimeout(1500); // the demo UI keeps polling the viewer: it must not throw

  expect(w.blocked, 'requests to other origins').toEqual([]);
  expect(w.threeCopies).toEqual([]);
  expect(w.errors).toEqual([]);
});

test('demo: local scene (sandbox) enter, pick, exit', async ({ page, baseURL }, info) => {
  const w = await watch(page, baseURL!);
  const backend = backendOf(info);
  // ?region enters a local scene of a 2 km circle on startup.
  await page.goto(`/?imagery=debug&noterrain&intro=0&clouds=0&region=circle:116.39,39.91,2${backend === 'WebGL2' ? '&webgl' : ''}`);
  const { software } = await probeBackend(page, info);
  await waitForViewer(page, 'viewer', backend);
  await page.waitForFunction(
    () => {
      const v = (window as unknown as SmokeWindow).viewer!;
      return v.localScene.active && !v.controller.isFlying;
    },
    undefined,
    { timeout: 60_000 },
  );
  await waitForGlobe(page, ['viewer'], { drained: !software });
  await framesOf(page, 'viewer');

  const inside = await page.evaluate(() => {
    const v = (window as unknown as SmokeWindow).viewer!;
    const r = v.localScene.region!;
    // The region center on screen (client pixels).
    const center = r.toWorld(v.camera.position.clone().set(0, 0, 0)).project(v.camera);
    const rect = v.canvas.getBoundingClientRect();
    const x = rect.left + ((center.x + 1) / 2) * rect.width;
    const y = rect.top + ((1 - center.y) / 2) * rect.height;
    return {
      kind: r.kind,
      radius: r.radius,
      centerPick: v.pickAt(x, y).kind,
      // A corner of the view: studio background around the area.
      cornerPick: v.pickAt(rect.left + 4, rect.top + 4).kind,
      outsideGround: v.surfaceHeight(116.6, 39.91).reliable,
      contains: [v.localScene.contains(116.39, 39.91), v.localScene.contains(116.6, 39.91)],
      tiles: v.globe.stats.rendered,
    };
  });
  expect(inside).toMatchObject({ kind: 'circle', radius: 2000, centerPick: 'globe', cornerPick: 'none', outsideGround: true, contains: [true, false] });
  expect(inside.tiles).toBeGreaterThan(0);

  // Leaving brings the whole globe back.
  await page.evaluate(() => (window as unknown as SmokeWindow).viewer!.localScene.exit({ restoreView: false }));
  const after = await page.evaluate(() => {
    const v = (window as unknown as SmokeWindow).viewer!;
    return { active: v.localScene.active, region: v.localScene.region, bounds: v.controller.bounds };
  });
  expect(after).toEqual({ active: false, region: null, bounds: null });
  await framesOf(page, 'viewer');

  expect(w.blocked, 'requests to other origins').toEqual([]);
  expect(w.errors).toEqual([]);
});
