/**
 * Level bindings (docs/agents/indoor-bim.md §6.5): the rule that decides when content bound
 * to a level node is shown, the registry (late binding by id, entity opacity, removal), the
 * splat scenes a building document declares, and the heading of an entity frame.
 */
import { PerspectiveCamera, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { Ellipsoid } from '../src/core/Ellipsoid';
import { isTerraViewError } from '../src/core/errors';
import type { BimEntity } from '../src/indoor/BimEntity';
import { IndoorManager, type IndoorHost } from '../src/indoor/IndoorManager';
import { defaultLevelShow, LEVEL_SHOW_MODES, levelRelation, levelShown } from '../src/indoor/levelBinding';
import { parseBuildingDoc, type SplatRef } from '../src/indoor/schema';
import { frameHeading } from '../src/splats/splatPlacement';

/** Two floors: f1 with rooms r1, r2 and a device t1; f2 with room r3. */
function doc(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    format: 'three-geo-building',
    version: '1.0',
    id: 'b1',
    anchor: { longitude: 116.39, latitude: 39.9, height: 50, heading: 30 },
    floors: [
      {
        id: 'f1',
        index: 0,
        elevation: 0,
        height: 4,
        rooms: [
          { id: 'r1', footprint: [[0, 0], [10, 0], [10, 8], [0, 8]] },
          { id: 'r2', footprint: [[10, 0], [20, 0], [20, 8], [10, 8]] },
        ],
        things: [{ id: 't1', position: [5, 4, 0] }],
      },
      { id: 'f2', index: 1, elevation: 4, height: 4, rooms: [{ id: 'r3', footprint: [[0, 0], [10, 0], [10, 8], [0, 8]] }] },
    ],
    ...overrides,
  };
}

function manager(overrides: Partial<IndoorHost> = {}) {
  const camera = new PerspectiveCamera(50, 1.5, 1, 1e8);
  const host: IndoorHost = {
    ellipsoid: Ellipsoid.WGS84,
    camera,
    markers: { add: () => ({ remove: () => undefined }) } as unknown as IndoorHost['markers'],
    groundHeight: () => 40,
    flyToView: () => Promise.resolve(),
    getCameraPose: () => ({ position: camera.position.clone(), heading: 0, pitch: -20 }),
    flyToPose: () => Promise.resolve(),
    setTilesetsVisible: () => undefined,
    loadModel: null,
    createLabelElement: () => ({}) as HTMLElement,
    ...overrides,
  };
  const indoor = new IndoorManager(host);
  const get = (id: string) => indoor.getById(id)!;
  return { indoor, get };
}

describe('level rule', () => {
  const node = (parent: { parent: unknown } | null) => ({ parent }) as { parent: never };

  it('tells where the view is relative to an entity', () => {
    const building = node(null);
    const floor = node(building);
    const room = node(floor);
    const other = node(building);
    expect(levelRelation(floor, floor)).toBe('at');
    expect(levelRelation(floor, room)).toBe('below');
    // The globe, a sibling floor and the entity's own ancestors are all outside it.
    expect(levelRelation(floor, null)).toBe('outside');
    expect(levelRelation(floor, other)).toBe('outside');
    expect(levelRelation(floor, building)).toBe('outside');
    // The globe contains every level.
    expect(levelRelation(null, null)).toBe('at');
    expect(levelRelation(null, room)).toBe('below');
  });

  it('shows content by mode', () => {
    const table: Record<string, boolean[]> = {
      // relation at / below / outside, each with the entity visible, then hidden
      always: [true, true, true, true, true, true],
      entity: [true, true, true, false, false, false],
      inside: [true, true, false, true, true, false],
      current: [true, false, false, true, false, false],
      outside: [false, false, true, false, false, false],
    };
    for (const mode of LEVEL_SHOW_MODES) {
      const got = [true, false].flatMap((visible) => (['at', 'below', 'outside'] as const).map((r) => levelShown(mode, r, visible)));
      expect(got, mode).toEqual(table[mode]);
    }
  });

  it('defaults to the exterior of a building, the interior below, the globe without an entity', () => {
    expect(defaultLevelShow('building')).toBe('outside');
    expect(defaultLevelShow('floor')).toBe('inside');
    expect(defaultLevelShow('thing')).toBe('inside');
    expect(defaultLevelShow(null)).toBe('current');
  });
});

describe('level bindings', () => {
  it('shows content with the level the view is in', async () => {
    const { indoor, get } = manager();
    indoor.add(doc());
    const exterior = indoor.bindings.bind({}, { entity: 'b1' });
    const floorScan = indoor.bindings.bind({}, { entity: get('f1') });
    const roomScan = indoor.bindings.bind({}, { entity: 'r1', show: 'current' });
    const context = indoor.bindings.bind({}, {});
    const shown = () => [exterior, floorScan, roomScan, context].map((b) => b.shown);
    // On the globe: the building's exterior capture and the globe-level layer.
    expect(shown()).toEqual([true, false, false, true]);
    await indoor.enter(get('b1'), { fly: false });
    expect(shown()).toEqual([false, false, false, false]);
    await indoor.enter(get('f1'), { fly: false });
    expect(shown()).toEqual([false, true, false, false]);
    await indoor.enter(get('r1'), { fly: false });
    expect(shown()).toEqual([false, true, true, false]);
    // A sibling room: still inside the floor, no longer in the room.
    await indoor.enter(get('r2'), { fly: false });
    expect(shown()).toEqual([false, true, false, false]);
    await indoor.enter(get('f2'), { fly: false });
    expect(shown()).toEqual([false, false, false, false]);
    await indoor.enter(null, { fly: false });
    expect(shown()).toEqual([true, false, false, true]);
  });

  it('switches bound content before the level events fire', async () => {
    const { indoor, get } = manager();
    indoor.add(doc());
    const scan = indoor.bindings.bind({}, { entity: 'f1' });
    const seen: string[] = [];
    indoor.events.on('enterLevel', (e) => seen.push(`enter:${e.object?.id ?? 'globe'}:${scan.shown}`));
    indoor.events.on('leaveLevel', (e) => seen.push(`leave:${e.object?.id}:${scan.shown}`));
    await indoor.enter(get('f1'), { fly: false });
    await indoor.enter(null, { fly: false });
    expect(seen).toEqual(['enter:b1:false', 'enter:f1:true', 'leave:f1:false', 'leave:b1:false', 'enter:globe:false']);
  });

  it('follows the entity with show: entity, and a predicate with anything else', async () => {
    const { indoor, get } = manager();
    indoor.add(doc());
    const withFloor = indoor.bindings.bind({}, { entity: 'f2', show: 'entity' });
    const states: string[] = [];
    const custom = indoor.bindings.bind({}, {
      entity: 'f1',
      show: (s) => {
        states.push(`${s.current?.id ?? 'globe'}:${s.relation}:${s.visible}`);
        return s.current?.type === 'building';
      },
    });
    // Floors are hidden on the globe.
    expect([withFloor.shown, custom.shown]).toEqual([false, false]);
    await indoor.enter(get('b1'), { fly: false });
    expect([withFloor.shown, custom.shown]).toEqual([true, true]);
    await indoor.enter(get('f1'), { fly: false });
    // Only floor 1 is shown inside it.
    expect([withFloor.shown, custom.shown]).toEqual([false, false]);
    expect(states).toContain('globe:outside:false');
    expect(states).toContain('b1:outside:true');
    expect(states).toContain('f1:at:true');
    // Hidden from code: picked up by the per-frame evaluation.
    await indoor.enter(get('b1'), { fly: false });
    get('f2').visible = false;
    expect(indoor.update(0.016)).toBe(true);
    expect(withFloor.shown).toBe(false);
  });

  it('binds by id before the building is loaded, and again when it comes back', () => {
    const { indoor } = manager();
    const changes: string[] = [];
    const binding = indoor.bindings.bind({}, { entity: 'b1', show: 'always' }, { onChange: (b) => changes.push(`${b.entity?.id ?? 'none'}:${b.shown}`) });
    expect([binding.entity, binding.unresolved, binding.shown]).toEqual([null, true, false]);
    const b = indoor.add(doc());
    indoor.update(0.016);
    expect([binding.entity, binding.unresolved, binding.shown]).toEqual([b, false, true]);
    indoor.remove(b);
    expect([binding.entity, binding.unresolved, binding.shown]).toEqual([null, true, false]);
    const again = indoor.add(doc());
    indoor.update(0.016);
    expect(binding.entity).toBe(again);
    // One report per change, none for the state `bind()` returned.
    expect(changes).toEqual(['b1:true', 'none:false', 'b1:true']);
    // An entity object of a building that is gone does not resolve.
    const stale = indoor.bindings.bind({}, { entity: b, show: 'always' });
    expect([stale.unresolved, stale.shown]).toEqual([true, false]);
  });

  it('fades the geometry of the entity and what is below it while the content is on screen', async () => {
    const { indoor, get } = manager();
    indoor.add(doc());
    let ready = false;
    const scan = {};
    indoor.bindings.bind(scan, { entity: 'f1', entityOpacity: 0 }, { showing: () => ready });
    const opacity = () => ['b1', 'f1', 'r1', 't1', 'f2', 'r3'].map((id) => get(id).bindingOpacity);
    await indoor.enter(get('f1'), { fly: false });
    // Shown by the level, but not loaded yet: the model stays.
    expect(opacity()).toEqual([1, 1, 1, 1, 1, 1]);
    ready = true;
    expect(indoor.update(0.016)).toBe(true);
    expect(opacity()).toEqual([1, 0, 0, 0, 1, 1]);
    // Level fading of siblings is a separate factor and survives.
    await indoor.enter(get('r1'), { fly: false });
    expect(get('r2').levelOpacity).toBeLessThan(1);
    expect(opacity()).toEqual([1, 0, 0, 0, 1, 1]);
    // A second binding on a room inside: the lowest factor wins on the overlap.
    const roomScan = {};
    indoor.bindings.bind(roomScan, { entity: 'r1', show: 'always', entityOpacity: 0.3 });
    indoor.bindings.bind(scan, { entity: 'f1', entityOpacity: 0.6 }, { showing: () => ready });
    expect(opacity()).toEqual([1, 0.6, 0.3, 0.6, 1, 1]);
    indoor.bindings.unbind(scan);
    expect(opacity()).toEqual([1, 1, 0.3, 1, 1, 1]);
    // Leaving the level gives the geometry back.
    indoor.bindings.bind(roomScan, { entity: 'r1', entityOpacity: 0.3 });
    await indoor.enter(null, { fly: false });
    expect(opacity()).toEqual([1, 1, 1, 1, 1, 1]);
  });

  it('lists, replaces and clears bindings', () => {
    const { indoor, get } = manager();
    indoor.add(doc());
    const a = {};
    const first = indoor.bindings.bind(a, { entity: 'f1' });
    const second = indoor.bindings.bind(a, { entity: 'f2', show: 'always' });
    expect(indoor.bindings.get(a)).toBe(second);
    expect(indoor.bindings.get(first.content)).toBe(second);
    expect(indoor.bindings.of(get('f2'))).toEqual([second]);
    expect(indoor.bindings.of(get('f1'))).toEqual([]);
    expect(indoor.bindings.all()).toHaveLength(1);
    indoor.dispose();
    expect(indoor.bindings.all()).toEqual([]);
    expect(indoor.bindings.get(a)).toBeNull();
  });
});

describe('splat scenes declared in a building document', () => {
  const splats: SplatRef[] = [{ uri: 'scans/lobby.spz', position: [5, 4, 0], rotation: 90, scale: 2, upAxis: '+y', show: 'entity', entityOpacity: 0.2 }];

  it('parses them on any entity and keeps absent fields absent', () => {
    const parsed = parseBuildingDoc(
      doc({
        splats: [{ uri: 'exterior.ply' }],
        floors: [{ id: 'f1', index: 0, elevation: 0, height: 4, splats, rooms: [{ id: 'r1', footprint: [[0, 0], [1, 0], [1, 1]], splats: [{ uri: 'r1.splat', pivot: [1, 2, 3], format: 'splat' }] }] }],
      }),
    );
    expect(parsed.splats).toEqual([{ uri: 'exterior.ply' }]);
    expect(parsed.floors[0].splats).toEqual(splats);
    expect(parsed.floors[0].rooms![0].splats).toEqual([{ uri: 'r1.splat', pivot: [1, 2, 3], format: 'splat' }]);
    expect(parsed.floors[0].rooms![0].splats![0]).not.toHaveProperty('show');
    // A document without any: unchanged.
    expect(parseBuildingDoc(doc()).splats).toBeUndefined();
  });

  it('reports the path of a bad field', () => {
    const bad = (s: unknown, path: string) => {
      try {
        parseBuildingDoc(doc({ splats: s }));
        expect.unreachable();
      } catch (e) {
        expect(isTerraViewError(e, 'building-invalid')).toBe(true);
        expect((e as { details: { path: string } }).details.path).toBe(path);
      }
    };
    bad({}, '$.splats');
    bad([{}], '$.splats[0]');
    bad([{ uri: 'a.ply', show: 'sometimes' }], '$.splats[0].show');
    bad([{ uri: 'a.ply', upAxis: 'y' }], '$.splats[0].upAxis');
    bad([{ uri: 'a.ply', scale: 0 }], '$.splats[0].scale');
    bad([{ uri: 'a.ply', entityOpacity: 2 }], '$.splats[0].entityOpacity');
    bad([{ uri: 'a.ply', position: [1, 2] }], '$.splats[0].position');
    bad([{ uri: 'a.ply', pivot: 'top' }], '$.splats[0].pivot');
    bad([{ uri: 'a.ply' }, { uri: 'b.ply', format: 'ksplat' }], '$.splats[1].format');
  });

  it('hands them to the host with their entity and removes them with the building', () => {
    const added: string[] = [];
    const removed: string[] = [];
    const { indoor } = manager({
      addSplats: (entity: BimEntity, def: SplatRef, baseUrl?: string) => {
        added.push(`${entity.id}:${def.uri}:${baseUrl}`);
        return () => removed.push(`${entity.id}:${def.uri}`);
      },
    });
    const b = indoor.add(
      doc({
        splats: [{ uri: 'exterior.ply' }],
        floors: [{ id: 'f1', index: 0, elevation: 0, height: 4, splats, things: [{ id: 't1', position: [1, 1, 0], splats: [{ uri: 'pump.spz' }, { uri: 'pump-detail.spz' }] }] }],
      }),
      'https://example.com/site/b1.building.json',
    );
    const base = 'https://example.com/site/b1.building.json';
    expect(added).toEqual([`b1:exterior.ply:${base}`, `f1:scans/lobby.spz:${base}`, `t1:pump.spz:${base}`, `t1:pump-detail.spz:${base}`]);
    indoor.remove(b);
    expect(removed).toEqual(['b1:exterior.ply', 'f1:scans/lobby.spz', 't1:pump.spz', 't1:pump-detail.spz']);
    // Without the hook the field is ignored.
    expect(() => manager().indoor.add(doc({ splats }))).not.toThrow();
  });
});

describe('entity frames', () => {
  it('measures the heading of a frame against north', () => {
    const east = [1, 0, 0];
    const north = [0, 1, 0];
    expect(frameHeading(north, east, north)).toBeCloseTo(0, 12);
    expect(frameHeading(east, east, north)).toBeCloseTo(90, 12);
    expect(frameHeading([0, -1, 0], east, north)).toBeCloseTo(180, 12);
    // A building with heading 30: its +Y points 30 degrees east of north; a tilt out of the plane does not matter.
    const r = (30 * Math.PI) / 180;
    expect(frameHeading([Math.sin(r), Math.cos(r), 0.2], east, north)).toBeCloseTo(30, 12);
  });

  it('gives a building frame the heading of its anchor', () => {
    const { indoor } = manager();
    const b = indoor.add(doc());
    b.group.updateWorldMatrix(true, false);
    const m = b.group.matrixWorld;
    const e = new Vector3();
    const n = new Vector3();
    Ellipsoid.WGS84.eastNorthUp(new Vector3().setFromMatrixPosition(m), e, n, new Vector3());
    expect(frameHeading(new Vector3().setFromMatrixColumn(m, 1).toArray(), e.toArray(), n.toArray())).toBeCloseTo(30, 9);
  });
});

