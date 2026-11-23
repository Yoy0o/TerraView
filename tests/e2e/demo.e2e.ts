/**
 * Smoke test of the demo application (dist-demo/, built with `npm run build:demo`): starts with the
 * offline debug imagery and the demo office building, walks building → floor → room and back to
 * the globe, then disposes the viewer. Further tests: a local scene, and a Gaussian splat layer
 * (load from a URL in its Worker, pick, crop, move, remove). Each fails on any page error,
 * console error or request to another origin.
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

test('demo: volumetric clouds near the ground, cloud shadows, dispose', async ({ page, baseURL }, info) => {
  const w = await watch(page, baseURL!);
  const backend = backendOf(info);
  // 800 m above Beijing looking at the horizon, clouds on (volumetric forced on: the tier may be low).
  await page.goto(`/?imagery=debug&noterrain&intro=0&clouds=1&cloudVolumetric=1${backend === 'WebGL2' ? '&webgl' : ''}#116.39,39.9,800,0,5`);
  const { software } = await probeBackend(page, info);
  await waitForViewer(page, 'viewer', backend);
  await waitForGlobe(page, ['viewer'], { drained: !software });

  // Sun lighting at mid-morning: cloud shadows go into every lit material's shadow node.
  await page.evaluate(() => {
    const v = (window as unknown as SmokeWindow).viewer!;
    v.date = new Date('2026-06-21T02:00:00Z');
    v.lighting = true;
  });
  // The noise volume comes from a Worker; the effect takes part once it is there.
  await page.waitForFunction(() => (window as unknown as SmokeWindow).viewer!.postProcessing.get('volumetric-clouds')?.active === true, undefined, {
    timeout: 60_000,
  });
  await framesOf(page, 'viewer', 6);
  const state = await page.evaluate(() => {
    const v = (window as unknown as SmokeWindow).viewer!;
    const fx = v.postProcessing.get('volumetric-clouds')!;
    return { gpuBytes: fx.gpuBytes ?? 0, castShadow: v.sunLight.castShadow, volumetric: v.clouds.getOptions().volumetric.enabled };
  });
  expect(state.volumetric).toBe(true);
  expect(state.castShadow).toBe(true);
  expect(state.gpuBytes).toBeGreaterThan(1_000_000);

  // Up through the fade: the clouds stop taking part, the shell shows.
  await page.evaluate(() => {
    const v = (window as unknown as SmokeWindow).viewer!;
    v.setView({ ...v.getView(), height: 2_000_000, pitch: -90 });
  });
  await framesOf(page, 'viewer', 3);
  expect(await page.evaluate(() => (window as unknown as SmokeWindow).viewer!.postProcessing.get('volumetric-clouds')!.active)).toBe(false);

  // The noise Worker is gone once its volume arrived; dispose closes the rest.
  await page.evaluate(() => (window as unknown as SmokeWindow).viewer!.dispose());
  await expect.poll(() => liveWorkers(page)).toBe(0);

  expect(w.blocked, 'requests to other origins').toEqual([]);
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

test('demo: Gaussian splats load, pick, crop, move, remove', async ({ page, baseURL }, info) => {
  const w = await watch(page, baseURL!);
  const backend = backendOf(info);
  // ?splats loads a generated .splat file (tests/e2e/server.mjs) and flies to it.
  await page.goto(`/?imagery=debug&noterrain&intro=0&clouds=0&splats=/__splats/ball.splat&splatsAt=116.39,39.91&splatsScale=20${backend === 'WebGL2' ? '&webgl' : ''}`);
  await probeBackend(page, info);
  await waitForViewer(page, 'viewer', backend);
  await page.waitForFunction(
    () => {
      const v = (window as unknown as SmokeWindow).viewer!;
      const layer = v.splatLayers[0];
      return !!layer && (layer.ready || layer.error !== null) && !v.controller.isFlying;
    },
    undefined,
    { timeout: 60_000 },
  );
  await framesOf(page, 'viewer');
  // The Worker of a load is closed when its answer arrives: only the viewer's own Workers stay.
  const workers = await liveWorkers(page);

  const loaded = await page.evaluate(() => {
    const v = (window as unknown as SmokeWindow).viewer!;
    const layer = v.splatLayers[0];
    const rect = v.canvas.getBoundingClientRect();
    const c = layer.boundingSphere.center.clone().project(v.camera);
    const x = rect.left + ((c.x + 1) / 2) * rect.width;
    const y = rect.top + ((1 - c.y) / 2) * rect.height;
    const pick = v.pickAt(x, y);
    const place = layer.placement;
    return {
      error: layer.error,
      stats: layer.stats && { format: layer.stats.format, sourceCount: layer.stats.sourceCount, count: layer.stats.count, shDegree: layer.stats.shDegree },
      active: layer.active,
      radius: layer.boundingSphere.radius,
      memory: v.memory.splats,
      snapshot: v.snapshot().splats.map((s) => s.ready),
      reference: place.heightReference,
      // The ball stands on the ground: its center is one radius (20 m) above it.
      centerHeight: v.ellipsoid.cartesianToCartographic(layer.boundingSphere.center)!.height - layer.ellipsoidHeight,
      kind: pick.kind,
      sameLayer: pick.splats === layer,
      // The hit is on the near side of the ball, in front of its center.
      nearer: pick.point !== null && pick.point.distanceTo(v.camera.position) < layer.boundingSphere.center.distanceTo(v.camera.position),
      beside: v.pickAt(rect.left + 4, rect.bottom - 4).kind,
      x,
      y,
    };
  });
  expect(loaded).toMatchObject({
    error: null,
    stats: { format: 'splat', sourceCount: 3000, count: 3000, shDegree: 0 },
    active: true,
    snapshot: [true],
    reference: 'ground',
    kind: 'splats',
    sameLayer: true,
    nearer: true,
    beside: 'globe',
  });
  expect(loaded.memory).toBe(3000 * 60);
  expect(loaded.radius).toBeGreaterThan(15);
  expect(loaded.centerHeight).toBeGreaterThan(15);
  expect(loaded.centerHeight).toBeLessThan(25);

  // A real click on the scene reaches interaction listeners as a pick on the layer.
  await page.evaluate(() => {
    const win = window as unknown as SmokeWindow;
    win.viewer!.interaction.on('click', (e) => win.__smoke.levels.push(`click:${e.kind}:${e.splats?.name ?? ''}`), { tag: 'smoke' });
  });
  await page.mouse.click(loaded.x, loaded.y);
  await expect.poll(() => page.evaluate(() => (window as unknown as SmokeWindow).__smoke.levels)).toEqual(['click:splats:ball.splat']);

  const edited = await page.evaluate(async () => {
    const v = (window as unknown as SmokeWindow).viewer!;
    const layer = v.splatLayers[0];
    const frames = (n: number) =>
      new Promise<void>((resolve) => {
        const off = v.events.on('frame', () => {
          if (--n > 0) return;
          off();
          resolve();
        });
      });
    const rect = v.canvas.getBoundingClientRect();
    const c = layer.boundingSphere.center.clone().project(v.camera);
    const x = rect.left + ((c.x + 1) / 2) * rect.width;
    const y = rect.top + ((1 - c.y) / 2) * rect.height;
    // Crop to the upper half: fewer splats drawn and counted, picks on the lower half fall through.
    const box = layer.localBounds!;
    const mid = (box.min[2] + box.max[2]) / 2;
    layer.crop = { type: 'box', min: [box.min[0] - 1, box.min[1] - 1, mid], max: [box.max[0] + 1, box.max[1] + 1, box.max[2] + 1] };
    await frames(3);
    const cropped = { count: layer.stats!.count, memory: v.memory.splats, active: layer.active };
    layer.crop = null;
    // Moved away: nothing of it under the old spot.
    const before = layer.boundingSphere.center.clone();
    layer.setPlacement({ longitude: 116.4, heading: 90, scale: 10 });
    await frames(3);
    const moved = { distance: before.distanceTo(layer.boundingSphere.center), radius: layer.boundingSphere.radius, pick: v.pickAt(x, y).kind, count: layer.stats!.count };
    // A second layer from bytes, and a file that is no splat file.
    const bytes = await (await fetch('/__splats/ball.splat')).arrayBuffer();
    const second = v.addSplats({ data: bytes, name: 'bytes.splat', position: { longitude: 116.39, latitude: 39.91, height: 150 } });
    const errors: string[] = [];
    v.events.on('error', (e) => errors.push(`${e.source}:${(e.error as { code?: string }).code}`));
    const broken = v.addSplats({ data: new ArrayBuffer(33), name: 'broken.bin', position: { longitude: 116.39, latitude: 39.91 } });
    // Missing options fail at the call, with a code.
    const invalid: string[] = [];
    for (const options of [{ url: '/__splats/ball.splat' }, { position: { longitude: 116.39, latitude: 39.91 } }]) {
      try {
        v.addSplats(options as never);
      } catch (e) {
        invalid.push(`${(e as { code?: string }).code}:${(e as { details?: { option?: string } }).details?.option}`);
      }
    }
    await new Promise<void>((resolve) => {
      const check = () => (second.ready && broken.error !== null ? resolve() : setTimeout(check, 50));
      check();
    });
    await frames(3);
    const added = { layers: v.splatLayers.length, reference: second.placement.heightReference, height: second.ellipsoidHeight, memory: v.memory.splats, errors, invalid, pending: v.loadState.layers };
    for (const l of [...v.splatLayers]) v.removeSplats(l);
    await frames(3);
    return { cropped, moved, added, removed: { layers: v.splatLayers.length, memory: v.memory.splats } };
  });
  expect(edited.cropped.count).toBeGreaterThan(1000);
  expect(edited.cropped.count).toBeLessThan(2000);
  expect(edited.cropped.memory).toBe(edited.cropped.count * 60);
  expect(edited.moved.distance).toBeGreaterThan(500);
  expect(edited.moved.radius).toBeCloseTo(loaded.radius / 2, 3);
  expect(edited.moved).toMatchObject({ pick: 'globe', count: 3000 });
  expect(edited.added).toEqual({ layers: 3, reference: 'ellipsoid', height: 150, memory: 2 * 3000 * 60, errors: ['splats:splat-format-unsupported'], invalid: ['option-invalid:position', 'option-invalid:url'], pending: 0 });
  expect(edited.removed).toEqual({ layers: 0, memory: 0 });
  expect(await liveWorkers(page)).toBe(workers);

  expect(w.blocked, 'requests to other origins').toEqual([]);
  expect(w.errors).toEqual([]);
});

test('demo: splats bound to levels (declared, lazy, framed, picked as entities)', async ({ page, baseURL }, info) => {
  const w = await watch(page, baseURL!);
  const backend = backendOf(info);
  await page.goto(`/?imagery=debug&noterrain&intro=0&clouds=0&demo${backend === 'WebGL2' ? '&webgl' : ''}`);
  await probeBackend(page, info);
  await waitForViewer(page, 'viewer', backend);
  // ?demo enters the office building, whose document declares a capture on its lobby.
  await page.waitForFunction(
    () => {
      const v = (window as unknown as SmokeWindow).viewer!;
      return v.indoor.current?.type === 'building' && !v.controller.isFlying && v.splatLayers[0]?.ready === true;
    },
    undefined,
    { timeout: 60_000 },
  );

  const result = await page.evaluate(async () => {
    const v = (window as unknown as SmokeWindow).viewer!;
    const indoor = v.indoor;
    const frames = (n: number) =>
      new Promise<void>((resolve) => {
        const off = v.events.on('frame', () => {
          if (--n > 0) return;
          off();
          resolve();
        });
      });
    const until = async (test: () => boolean) => {
      for (let i = 0; i < 600 && !test(); i++) await new Promise((r) => setTimeout(r, 50));
      return test();
    };
    const quick = { duration: 0.2 };
    const building = indoor.current!;
    const [f1, f2] = building.children.filter((c) => c.type === 'floor');

    // 1. Declared in the document: bound to the lobby, placed in its frame, shown with the room.
    const plant = v.splatLayers[0];
    const lobby = indoor.bindings.get(plant)!.entity!;
    const declared = { room: lobby.type, floor: lobby.parent === f1, position: plant.level?.position?.length, show: plant.level?.show, shown: indoor.bindings.get(plant)!.shown };

    // 2. Bound by id to the second floor: nothing is loaded until that floor is entered.
    const scan = v.addSplats({ url: '/__splats/ball.splat', name: 'scan', scale: 4, level: { entity: f2.id, position: [0, 0, 0], entityOpacity: 0 } });
    await frames(3);
    const waiting = { ready: scan.ready, loading: scan.loading, shown: indoor.bindings.get(scan)!.shown, pending: v.loadState.layers, snapshot: v.snapshot().splats.find((s) => s.id === scan.id)!.level };
    await indoor.enter(f2, quick);
    const loaded = await until(() => scan.ready);
    await frames(3);
    const room = f2.children.find((c) => c.type === 'room')!;
    const rect = v.canvas.getBoundingClientRect();
    const at = (world: { clone(): { project(c: unknown): { x: number; y: number } } }) => {
      const p = world.clone().project(v.camera);
      return v.pickAt(rect.left + ((p.x + 1) / 2) * rect.width, rect.top + ((1 - p.y) / 2) * rect.height);
    };
    const onScan = at(scan.boundingSphere.center);
    // The room farthest from the capture: its model is fully transparent now, and still picked.
    const rooms = f2.children.filter((c) => c.type === 'room' && c.worldBounds());
    const far = rooms.sort((a, b) => b.worldBounds()!.center.distanceTo(scan.boundingSphere.center) - a.worldBounds()!.center.distanceTo(scan.boundingSphere.center))[0];
    const onRoom = at(far.worldBounds()!.center);
    // 3D Tiles follow the same bindings: the reality mesh of this building, one kept indoors, one unbound.
    const tiles = {
      exterior: v.addTileset({ source: { type: 'url', url: '/__tiles3d/empty/tileset.json' }, name: 'exterior', level: { entity: building.id } }),
      kept: v.addTileset({ source: { type: 'url', url: '/__tiles3d/empty/tileset.json' }, name: 'kept', level: { show: 'always' } }),
      context: v.addTileset({ source: { type: 'url', url: '/__tiles3d/empty/tileset.json' }, name: 'context' }),
    };
    await frames(2);
    const tilesInside = [tiles.exterior.suppressed, tiles.kept.suppressed, tiles.context.suppressed];
    const inside = {
      loaded,
      active: scan.active,
      plantShown: indoor.bindings.get(plant)!.shown,
      // The model of the floor steps back completely, the other floor keeps its own.
      opacity: [f2.bindingOpacity, room.bindingOpacity, f1.bindingOpacity],
      // The ball stands on the slab of the second floor.
      aboveSlab: scan.ellipsoidHeight - v.ellipsoid.cartesianToCartographic(f2.group.getWorldPosition(scan.boundingSphere.center.clone()))!.height,
      pick: onScan.kind,
      // A pick on the capture is a pick on the floor or on what is in it.
      pickInFloor: !!onScan.entity && (onScan.entity === f2 || onScan.entity.isDescendantOf(f2)),
      pickLayer: onScan.splats === scan,
      roomPick: onRoom.kind,
      roomPickInFloor: !!onRoom.entity && onRoom.entity.isDescendantOf(f2),
      tiles: tilesInside,
    };

    // 3. Shown with the entity: it follows the floors spreading apart at the building level.
    scan.setLevel({ ...scan.level!, show: 'entity', entityOpacity: 1 });
    await indoor.enter(building, quick);
    await frames(3);
    const before = scan.ellipsoidHeight;
    indoor.expandFloors = true;
    await until(() => !(building as unknown as { isExpanding: boolean }).isExpanding);
    await frames(3);
    const spread = { shown: indoor.bindings.get(scan)!.shown, lifted: scan.ellipsoidHeight - before, opacity: f2.bindingOpacity };
    indoor.expandFloors = false;
    await until(() => !(building as unknown as { isExpanding: boolean }).isExpanding);

    // 4. A layer on the globe taken over into the building's frame where it stands, and released again.
    const free = v.addSplats({ url: '/__splats/ball.splat', name: 'free', position: { longitude: 116.3935, latitude: 39.9996, height: 80 }, heading: 20, showIndoors: true });
    await until(() => free.ready);
    await frames(2);
    const world = free.boundingSphere.center.clone();
    const placed = free.placement;
    free.setLevel({ entity: building.id, follow: true, show: 'always' });
    await frames(3);
    const framed = { position: free.level?.position?.length, moved: free.boundingSphere.center.distanceTo(world), heading: free.placement.heading };
    free.setLevel(null);
    await frames(2);
    const released = {
      level: free.level,
      moved: free.boundingSphere.center.distanceTo(world),
      longitude: Math.abs(free.placement.longitude - placed.longitude),
      latitude: Math.abs(free.placement.latitude - placed.latitude),
      heading: free.placement.heading,
      reference: free.placement.heightReference,
    };

    // On the globe the building's own tileset and the unbound one are drawn again.
    await indoor.enter(null, { fly: false });
    await frames(2);
    const tilesOutside = [tiles.exterior.suppressed, tiles.kept.suppressed, tiles.context.suppressed];
    for (const t of Object.values(tiles)) v.removeTileset(t);

    // 5. Removing the building takes its declared capture along; the layer bound by id waits for it.
    indoor.remove(building as never);
    await frames(3);
    const removed = { layers: v.splatLayers.map((l) => l.name), unresolved: indoor.bindings.get(scan)!.unresolved, shown: indoor.bindings.get(scan)!.shown, active: scan.active };
    for (const l of [...v.splatLayers]) v.removeSplats(l);
    return { declared, waiting, inside, spread, framed, released, removed, tilesOutside, bindings: indoor.bindings.all().length };
  });

  expect(result.declared).toEqual({ room: 'room', floor: true, position: 3, show: 'entity', shown: true });
  expect(result.waiting).toMatchObject({ ready: false, loading: false, shown: false, pending: 0 });
  expect(result.waiting.snapshot).toMatchObject({ shown: false });
  expect(result.inside).toMatchObject({
    loaded: true,
    active: true,
    plantShown: false,
    opacity: [0, 0, 1],
    pick: 'splats',
    pickInFloor: true,
    pickLayer: true,
    roomPick: 'entity',
    roomPickInFloor: true,
    // Inside the building: its exterior mesh and the unbound context are hidden, the one bound "always" stays.
    tiles: [true, false, true],
  });
  expect(result.tilesOutside).toEqual([false, false, false]);
  expect(Math.abs(result.inside.aboveSlab)).toBeLessThan(0.01);
  expect(result.spread).toMatchObject({ shown: true, opacity: 1 });
  // One storey up at 7 m per storey.
  expect(result.spread.lifted).toBeGreaterThan(6.5);
  expect(result.spread.lifted).toBeLessThan(7.5);
  expect(result.framed.position).toBe(3);
  expect(result.framed.moved).toBeLessThan(0.01);
  expect(result.released).toMatchObject({ level: null, reference: 'ellipsoid' });
  expect(result.released.moved).toBeLessThan(0.01);
  expect(result.released.longitude).toBeLessThan(1e-7);
  expect(result.released.latitude).toBeLessThan(1e-7);
  expect(result.released.heading).toBeCloseTo(20, 6);
  expect(result.removed).toEqual({ layers: ['scan', 'free'], unresolved: true, shown: false, active: false });
  expect(result.bindings).toBe(0);

  expect(w.blocked, 'requests to other origins').toEqual([]);
  expect(w.errors).toEqual([]);
});
