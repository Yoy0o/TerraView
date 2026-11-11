import sampleBuildingJson from '../docs/examples/sample-office.building.json?raw';
import { Group, Mesh, PerspectiveCamera, Sphere, Vector3, type Object3D } from 'three';
import { describe, expect, it } from 'vitest';
import { Ellipsoid } from '../src/core/Ellipsoid';
import { matchesSelector, STRUCTURE_TAG, type BimEntity } from '../src/indoor/BimEntity';
import { Building } from '../src/indoor/Building';
import { createDemoBuilding } from '../demo/data/demoBuilding';
import { IndoorManager, type CameraPose, type IndoorHost } from '../src/indoor/IndoorManager';
import { defaultFilterObject, focusSet, levelPath, SIBLING_OPACITY, type LevelControl } from '../src/indoor/LevelControl';
import { diagonalHeadings, fovNormalizedRange, nearestDiagonalView, viewPosition, type LevelView } from '../src/indoor/levelView';
import { parseBuildingDoc, pointInPolygon, polygonArea, polygonCentroid, signedArea } from '../src/indoor/schema';
import { SurfaceHeightQuery, type SurfaceSample } from '../src/viewer/SurfaceHeight';

const E = Ellipsoid.WGS84;
const DEG = Math.PI / 180;

function minimalDoc(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    format: 'three-geo-building',
    version: '1.0',
    id: 'b1',
    name: 'Test',
    anchor: { longitude: 116.39, latitude: 39.9, height: 50, heading: 30 },
    floors: [
      {
        id: 'f1',
        index: 0,
        elevation: 0,
        height: 4,
        rooms: [{ id: 'r1', name: 'Room 1', footprint: [[0, 0], [10, 0], [10, 8], [0, 8]] }],
        things: [{ id: 't1', name: 'Cam 1', category: 'camera', position: [5, 4, 3] }],
      },
    ],
    ...overrides,
  };
}

/** Two floors; floor 1 has two rooms, a device in each, one in the corridor, a wall and a door. */
function richDoc(): Record<string, unknown> {
  return minimalDoc({
    floors: [
      {
        id: 'f1',
        index: 0,
        elevation: 0,
        height: 4,
        rooms: [
          { id: 'r1', name: 'Room 1', footprint: [[0, 0], [10, 0], [10, 8], [0, 8]], tags: ['office'] },
          { id: 'r2', name: 'Room 2', footprint: [[10, 0], [20, 0], [20, 8], [10, 8]], viewpoint: { heading: 90, pitch: -60, range: 25 } },
        ],
        things: [
          { id: 't1', name: 'Cam 1', category: 'camera', position: [5, 4, 3], tags: ['alarm'] },
          { id: 't2', name: 'Cam 2', category: 'camera', position: [15, 4, 3] },
          { id: 't3', name: 'Corridor AP', category: 'ap', position: [10, 12, 3] },
        ],
        elements: [
          { id: 'w1', kind: 'wall', path: [[0, 10], [20, 10]], height: 3 },
          { id: 'd1', kind: 'door', position: [3, 0, 0], size: [1, 0.1, 2] },
        ],
      },
      { id: 'f2', index: 1, elevation: 4, height: 4, rooms: [{ id: 'r3', name: 'Room 3', footprint: [[0, 0], [10, 0], [10, 8], [0, 8]] }] },
    ],
  });
}

interface Calls {
  views: LevelView[];
  poses: CameraPose[];
  tilesets: boolean[];
}

/** Indoor host without a viewer: no markers DOM; flights are recorded and resolve at once unless `flight` is given. */
function host(overrides: Partial<IndoorHost> = {}, flight?: () => Promise<void>): { host: IndoorHost; calls: Calls; camera: PerspectiveCamera } {
  const calls: Calls = { views: [], poses: [], tilesets: [] };
  const camera = new PerspectiveCamera(50, 1.5, 1, 1e8);
  const h: IndoorHost = {
    ellipsoid: E,
    camera,
    markers: { add: () => ({ remove: () => undefined }) } as unknown as IndoorHost['markers'],
    groundHeight: () => 40,
    flyToView: (v) => {
      calls.views.push(v);
      return flight ? flight() : Promise.resolve();
    },
    getCameraPose: () => ({ position: camera.position.clone(), heading: 12, pitch: -20 }),
    flyToPose: (p) => {
      calls.poses.push(p);
      return flight ? flight() : Promise.resolve();
    },
    setTilesetsVisible: (v) => calls.tilesets.push(v),
    loadModel: null,
    createLabelElement: () => ({}) as HTMLElement,
    ...overrides,
  };
  return { host: h, calls, camera };
}

function manager(doc = richDoc(), overrides: Partial<IndoorHost> = {}) {
  const h = host(overrides);
  const indoor = new IndoorManager(h.host);
  const b = indoor.add(doc);
  const get = (id: string) => indoor.getById(id)!;
  return { indoor, b, get, ...h };
}

/** Puts the camera 300 m south of the building, 150 m up. */
function cameraNear(camera: PerspectiveCamera, b: Building): void {
  const center = b.worldBounds(new Sphere())!.center;
  const e = new Vector3();
  const n = new Vector3();
  const u = new Vector3();
  E.eastNorthUp(center, e, n, u);
  camera.position.copy(center).addScaledVector(n, -300).addScaledVector(u, 150);
}

describe('building schema', () => {
  it('parses a minimal document and fills defaults', () => {
    const doc = parseBuildingDoc(minimalDoc());
    expect(doc.floors).toHaveLength(1);
    expect(doc.anchor.heading).toBe(30);
    expect(doc.floors[0].rooms![0].walls).toBe(true);
    expect(doc.floors[0].things![0].shape).toBe('box');
  });

  it('reports the JSON path of problems', () => {
    expect(() => parseBuildingDoc({ ...minimalDoc(), format: 'x' })).toThrow('$.format');
    expect(() => parseBuildingDoc(minimalDoc({ anchor: { longitude: 1 } }))).toThrow('$.anchor.latitude');
    const dup = minimalDoc();
    (dup.floors as { things: { id: string }[] }[])[0].things[0].id = 'r1';
    expect(() => parseBuildingDoc(dup)).toThrow('duplicate id "r1"');
    const badRoom = minimalDoc();
    (badRoom.floors as { rooms: { footprint: unknown }[] }[])[0].rooms[0].footprint = [[0, 0]];
    expect(() => parseBuildingDoc(badRoom)).toThrow('$.floors[0].rooms[0].footprint');
  });

  it('parses and validates tags and viewpoints', () => {
    const doc = parseBuildingDoc(richDoc());
    const [r1, r2] = doc.floors[0].rooms!;
    expect(r1.tags).toEqual(['office']);
    expect(r2.viewpoint).toEqual({ heading: 90, pitch: -60, range: 25 });
    expect(parseBuildingDoc(minimalDoc({ viewpoint: { pitch: -30 } })).viewpoint).toEqual({ pitch: -30 });
    expect(() => parseBuildingDoc(minimalDoc({ tags: 'alarm' }))).toThrow('$.tags: expected an array of strings');
    expect(() => parseBuildingDoc(minimalDoc({ tags: ['ok', ''] }))).toThrow('$.tags[1]');
    expect(() => parseBuildingDoc(minimalDoc({ viewpoint: 3 }))).toThrow('$.viewpoint');
    expect(() => parseBuildingDoc(minimalDoc({ viewpoint: { pitch: -120 } }))).toThrow('$.viewpoint.pitch: must be within -90..90 degrees');
    expect(() => parseBuildingDoc(minimalDoc({ viewpoint: { range: 0 } }))).toThrow('$.viewpoint.range: must be positive');
    const badThing = richDoc();
    (badThing.floors as { things: Record<string, unknown>[] }[])[0].things[1].viewpoint = { heading: 'north' };
    expect(() => parseBuildingDoc(badThing)).toThrow('$.floors[0].things[1].viewpoint.heading');
  });

  it('validates door openings and element kinds', () => {
    const withDoors = (doors: unknown) => {
      const d = minimalDoc();
      (d.floors as { rooms: Record<string, unknown>[] }[])[0].rooms[0].doors = doors;
      return d;
    };
    expect(parseBuildingDoc(withDoors([{ edge: 2 }])).floors[0].rooms![0].doors).toEqual([{ edge: 2, at: 0.5, width: undefined }]);
    expect(() => parseBuildingDoc(withDoors([{ edge: 4, at: 0.5 }]))).toThrow('$.floors[0].rooms[0].doors[0].edge: expected an edge index 0..3');
    expect(() => parseBuildingDoc(withDoors([{ edge: 1.5 }]))).toThrow('doors[0].edge');
    expect(() => parseBuildingDoc(withDoors([{ edge: 0, at: 1.2 }]))).toThrow('doors[0].at: expected 0..1');
    expect(() => parseBuildingDoc(withDoors([{ edge: 0, width: 0 }]))).toThrow('doors[0].width: must be positive');
    expect(() => parseBuildingDoc(withDoors({ edge: 0 }))).toThrow('$.floors[0].rooms[0].doors: expected an array');
    const withElement = (el: Record<string, unknown>) => {
      const d = minimalDoc();
      (d.floors as Record<string, unknown>[])[0].elements = [{ id: 'e1', ...el }];
      return d;
    };
    expect(() => parseBuildingDoc(withElement({ kind: 'beam', position: [0, 0, 0] }))).toThrow('$.floors[0].elements[0].kind: expected one of wall, door, window, column, slab, stair');
    expect(() => parseBuildingDoc(withElement({ kind: 'wall' }))).toThrow('$.floors[0].elements[0]: expected path or position');
    expect(() => parseBuildingDoc(withElement({ kind: 'wall', path: [[0, 0]] }))).toThrow('elements[0].path: expected at least 2');
    expect(() => parseBuildingDoc(withElement({ kind: 'slab', path: [[0, 0], [1, 0]] }))).toThrow('elements[0].path: expected at least 3');
    expect(parseBuildingDoc(withElement({ kind: 'column', position: [1, 2, 0] })).floors[0].elements![0].position).toEqual([1, 2, 0]);
  });

  it('accepts and builds the sample document of the data manual', () => {
    const doc = parseBuildingDoc(sampleBuildingJson);
    expect(doc.floors.map((f) => f.name)).toEqual(['B1', '1F', '2F']);
    const b = new Building(doc, E, null);
    const all: BimEntity[] = [];
    b.traverse((e) => all.push(e));
    expect(all.filter((e) => e.type === 'room')).toHaveLength(13);
    expect(all.find((e) => e.id === 'B-F1-COL01')!.tags.has(STRUCTURE_TAG)).toBe(true);
    expect(all.find((e) => e.id === 'B-F1-RK02')!.tags.has('alarm')).toBe(true);
    // Every device stands inside its floor's footprint.
    for (const t of all.filter((e) => e.type === 'thing')) {
      expect(pointInPolygon(t.group.position.x, t.group.position.y, doc.footprint!)).toBe(true);
    }
  });

  it('computes polygon area, orientation, centroid and containment', () => {
    const square: [number, number][] = [
      [0, 0],
      [4, 0],
      [4, 3],
      [0, 3],
    ];
    expect(polygonArea(square)).toBe(12);
    expect(signedArea(square)).toBeGreaterThan(0);
    expect(signedArea([...square].reverse())).toBeLessThan(0);
    expect(polygonCentroid(square)).toEqual([2, 1.5]);
    expect(pointInPolygon(2, 1, square)).toBe(true);
    expect(pointInPolygon(5, 1, square)).toBe(false);
    expect(pointInPolygon(2, -0.1, square)).toBe(false);
  });

  it('accepts the demo building after a JSON round trip', () => {
    const doc = parseBuildingDoc(JSON.parse(JSON.stringify(createDemoBuilding())));
    expect(doc.floors.map((f) => f.name)).toEqual(['1F', '2F', '3F', '4F', '5F']);
    const rooms = doc.floors.flatMap((f) => f.rooms ?? []);
    expect(rooms.length).toBeGreaterThan(40);
    expect(new Set(rooms.map((r) => r.id)).size).toBe(rooms.length);
  });
});

describe('Building', () => {
  it('builds the entity tree and places the local frame on the globe', () => {
    const b = new Building(parseBuildingDoc(minimalDoc()), E, null);
    expect(b.floors).toHaveLength(1);
    const [floor] = b.floors;
    expect(floor.children.map((c) => c.type)).toEqual(['room', 'thing']);
    expect(floor.children[0].properties['面积']).toBe('80.0 m²');
    // The local origin sits at the anchor (50 m above the ellipsoid).
    b.root.updateMatrixWorld(true);
    const origin = new Vector3().applyMatrix4(b.group.matrixWorld);
    const c = E.cartesianToCartographic(origin)!;
    expect(c.height).toBeCloseTo(50, 3);
    expect(c.longitude / DEG).toBeCloseTo(116.39, 6);
    // Local +Y points 30 degrees east of north.
    const yAxis = new Vector3(0, 1, 0).applyMatrix4(b.group.matrixWorld).sub(origin).normalize();
    const east = new Vector3();
    const north = new Vector3();
    E.eastNorthUp(origin, east, north, new Vector3());
    expect(Math.atan2(yAxis.dot(east), yAxis.dot(north)) / DEG).toBeCloseTo(30, 4);
    const bounds = b.worldBounds(new Sphere());
    expect(bounds).not.toBeNull();
    expect(bounds!.radius).toBeGreaterThan(5);
  });

  it('carries tags, viewpoints and room outlines; walls are structure', () => {
    const b = new Building(parseBuildingDoc(richDoc()), E, null);
    const byId = (id: string) => {
      let found: BimEntity | null = null;
      b.traverse((e) => e.id === id && (found = e));
      return found! as BimEntity;
    };
    expect([...byId('r1').tags]).toEqual(['office']);
    expect(byId('r2').viewpoint).toEqual({ heading: 90, pitch: -60, range: 25 });
    expect(byId('r1').outline).toHaveLength(4);
    expect(byId('w1').tags.has(STRUCTURE_TAG)).toBe(true);
    expect(byId('w1').tags.has('wall')).toBe(true);
    expect(byId('d1').tags.has(STRUCTURE_TAG)).toBe(false);
    expect(byId('d1').tags.has('door')).toBe(true);
  });

  it('matches ThingJS-style selectors', () => {
    const b = new Building(parseBuildingDoc(minimalDoc()), E, null);
    const cam = b.floors[0].children[1];
    expect(matchesSelector(cam, '.Thing')).toBe(true);
    expect(matchesSelector(cam, '.room, .thing')).toBe(true);
    expect(matchesSelector(cam, '#t1')).toBe(true);
    expect(matchesSelector(cam, '[category=camera]')).toBe(true);
    expect(matchesSelector(cam, 'Cam 1')).toBe(true);
    expect(matchesSelector(cam, /^Cam/)).toBe(true);
    expect(matchesSelector(cam, '.Room')).toBe(false);
    expect(matchesSelector(cam, (e) => e.closest('floor')?.id === 'f1')).toBe(true);
    expect(matchesSelector(cam, '.thing && [category=camera] && !tags:or(alarm)')).toBe(true);
  });

  it('waits for models of an entity and its descendants', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const loadModel = async (): Promise<Object3D> => {
      await gate;
      const g = new Group();
      g.add(new Mesh());
      return g;
    };
    const doc = richDoc();
    (doc.floors as Record<string, unknown>[])[0].model = { uri: 'f1.glb' };
    const b = new Building(parseBuildingDoc(doc), E, loadModel);
    let floorReady = false;
    void b.modelsLoaded(b.floors[0]).then(() => (floorReady = true));
    let otherReady = false;
    void b.modelsLoaded(b.floors[1]).then(() => (otherReady = true));
    await Promise.resolve();
    await Promise.resolve();
    expect(otherReady).toBe(true);
    expect(floorReady).toBe(false);
    release();
    await b.modelsLoaded(b);
    expect(floorReady).toBe(true);
  });
});

describe('entity sets', () => {
  it('queries, chains, narrows and styles', () => {
    const { indoor } = manager();
    const floors = indoor.query('.floor');
    expect(floors.map((f) => f.id)).toEqual(['f1', 'f2']);
    expect(floors.query('.room').map((r) => r.id)).toEqual(['r1', 'r2', 'r3']);
    expect(floors.query('.room').where('tags:or(office)').map((r) => r.id)).toEqual(['r1']);
    expect(indoor.query('.thing[category=camera]').length).toBe(2);
    // `map` returns a plain array, `query` an entity set.
    expect(floors.map((f) => f.id)).not.toHaveProperty('query');
    const cams = indoor.query('[category=camera]');
    cams.setStyle({ color: '#ff0000' });
    expect(cams.every((c) => c.style.color === '#ff0000')).toBe(true);
    cams.visible = false;
    expect(cams.visible).toBe(false);
    expect(indoor.query('.nothing').first).toBeNull();
    expect(indoor.getById('t2')?.name).toBe('Cam 2');
    expect(indoor.getById('missing')).toBeNull();
  });
});

describe('level rules', () => {
  it('walks level paths through the common ancestor', () => {
    const { b, get } = manager();
    const [f1, f2, r1, r2, r3] = ['f1', 'f2', 'r1', 'r2', 'r3'].map(get);
    const ids = (p: { leave: BimEntity[]; enter: (BimEntity | null)[] }) => ({ leave: p.leave.map((e) => e.id), enter: p.enter.map((e) => e?.id ?? 'globe') });
    expect(ids(levelPath(null, r1))).toEqual({ leave: [], enter: ['b1', 'f1', 'r1'] });
    expect(ids(levelPath(r1, null))).toEqual({ leave: ['r1', 'f1', 'b1'], enter: ['globe'] });
    expect(ids(levelPath(r1, b))).toEqual({ leave: ['r1', 'f1'], enter: ['b1'] });
    expect(ids(levelPath(r1, r2))).toEqual({ leave: ['r1'], enter: ['r2'] });
    expect(ids(levelPath(r1, r3))).toEqual({ leave: ['r1', 'f1'], enter: ['f2', 'r3'] });
    expect(ids(levelPath(f1, f1))).toEqual({ leave: [], enter: ['f1'] });
    expect(ids(levelPath(f2, f1))).toEqual({ leave: ['f2'], enter: ['f1'] });
  });

  it('maps picks to the unit of the current level', () => {
    const { b, get } = manager();
    const [f1, f2, r1, r2, t1, w1, d1] = ['f1', 'f2', 'r1', 'r2', 't1', 'w1', 'd1'].map(get);
    // Globe: the whole building.
    expect(defaultFilterObject(r1, null)).toBe(b);
    // Building: the floor.
    expect(defaultFilterObject(r1, b)).toBe(f1);
    expect(defaultFilterObject(w1, b)).toBe(f1);
    // Floor: its direct children, structure excepted.
    expect(defaultFilterObject(r1, f1)).toBe(r1);
    expect(defaultFilterObject(t1, f1)).toBe(t1);
    expect(defaultFilterObject(d1, f1)).toBe(d1);
    expect(defaultFilterObject(w1, f1)).toBeNull();
    // Room: siblings act as themselves, the floor slab as the floor, the room as itself.
    expect(defaultFilterObject(r2, r1)).toBe(r2);
    expect(defaultFilterObject(t1, r1)).toBe(t1);
    expect(defaultFilterObject(f1, r1)).toBe(f1);
    expect(defaultFilterObject(r1, r1)).toBe(r1);
    expect(defaultFilterObject(w1, r1)).toBeNull();
    // Another floor: that floor.
    expect(defaultFilterObject(get('r3'), r1)).toBe(f2);
  });

  it('keeps a room with what stands in it, and a device with its room', () => {
    const { get } = manager();
    const ids = (s: Set<BimEntity>) => [...s].map((e) => e.id).sort();
    expect(ids(focusSet(get('r1')))).toEqual(['d1', 'r1', 't1']);
    expect(ids(focusSet(get('t2')))).toEqual(['r2', 't2']);
    expect(ids(focusSet(get('t3')))).toEqual(['t3']);
  });
});

describe('level framing', () => {
  it('normalizes distance to the field of view', () => {
    expect(fovNormalizedRange(100, 60)).toBeCloseTo(100, 9);
    // Narrower field of view: farther away for the same on-screen size.
    expect(fovNormalizedRange(100, 30)).toBeCloseTo((100 * Math.tan(30 * DEG)) / Math.tan(15 * DEG), 9);
    expect(fovNormalizedRange(100, 90)).toBeLessThan(100);
  });

  it('picks the diagonal view nearest to the camera', () => {
    expect(diagonalHeadings(30)).toEqual([75, 165, 255, 345]);
    expect(diagonalHeadings(-60)).toEqual([345, 75, 165, 255]);
    const center = E.cartographicToCartesian(116.39 * DEG, 39.9 * DEG, 50);
    const e = new Vector3();
    const n = new Vector3();
    const u = new Vector3();
    E.eastNorthUp(center, e, n, u);
    const framing = { pitch: -45, radii: 3, minRadius: 5 };
    // Camera south-west of the subject: looking north-east (heading 45) is the closest diagonal.
    const sw = center.clone().addScaledVector(e, -200).addScaledVector(n, -200).addScaledVector(u, 150);
    const view = nearestDiagonalView(E, center, 20, 0, sw, 60, framing);
    expect(view.heading).toBe(45);
    expect(view.pitch).toBe(-45);
    expect(view.range).toBeCloseTo(60, 9);
    // The camera position of the view is south-west of and above the target.
    const p = viewPosition(E, view).sub(center);
    expect(p.dot(e)).toBeLessThan(0);
    expect(p.dot(n)).toBeLessThan(0);
    expect(p.dot(u)).toBeCloseTo(60 * Math.sin(45 * DEG), 6);
    expect(p.length()).toBeCloseTo(60, 6);
    // North-east camera: heading 225; a rotated building rotates the candidates.
    const ne = center.clone().addScaledVector(e, 200).addScaledVector(n, 200).addScaledVector(u, 150);
    expect(nearestDiagonalView(E, center, 20, 0, ne, 60, framing).heading).toBe(225);
    expect(nearestDiagonalView(E, center, 20, 10, ne, 60, framing).heading).toBe(235);
    // Tiny subjects are framed as `minRadius`.
    expect(nearestDiagonalView(E, center, 0.1, 0, sw, 60, framing).range).toBeCloseTo(15, 9);
  });
});

describe('IndoorManager levels', () => {
  it('steps globe -> building -> floor -> room and back with events', async () => {
    const { indoor, b, get } = manager(minimalDoc());
    const floor = get('f1');
    const room = get('r1');
    const events: string[] = [];
    indoor.events.on('enterLevel', (e) => events.push(`enter:${e.object?.id ?? 'globe'}`));
    indoor.events.on('leaveLevel', (e) => events.push(`leave:${e.object?.id ?? 'globe'}`));

    // From the globe a double click on a room enters its building first.
    expect(indoor.nextLevel(room)).toBe(b);
    await indoor.enter(b);
    expect(b.exterior.visible).toBe(false);
    expect(indoor.nextLevel(room)).toBe(floor);
    await indoor.enter(floor);
    expect(indoor.nextLevel(room)).toBe(room);
    await indoor.enter(room);
    expect(indoor.selected).toBe(room);
    expect(indoor.nextLevel(room)).toBeNull();
    await indoor.back();
    expect(indoor.current).toBe(floor);
    await indoor.enter(null);
    expect(b.exterior.visible).toBe(true);
    expect(b.floors.every((f) => !f.visible)).toBe(true);
    expect(events).toEqual(['enter:b1', 'enter:f1', 'enter:r1', 'leave:r1', 'enter:f1', 'leave:f1', 'leave:b1', 'enter:globe']);
  });

  it('enters every level on the way and flies only at the destination', async () => {
    const { indoor, get, calls } = manager();
    const events: string[] = [];
    for (const type of ['beforeEnterLevel', 'enterLevel', 'leaveLevel'] as const) {
      indoor.events.on(type, (e) => events.push(`${type}:${e.object?.id ?? 'globe'}`));
    }
    expect(await indoor.enter(get('r1'))).toBe(true);
    expect(events).toEqual(['beforeEnterLevel:b1', 'enterLevel:b1', 'beforeEnterLevel:f1', 'enterLevel:f1', 'beforeEnterLevel:r1', 'enterLevel:r1']);
    expect(calls.views).toHaveLength(1);
    events.length = 0;
    // Room on another floor: up to the building, down the other branch.
    await indoor.enter(get('r3'));
    expect(events).toEqual(['leaveLevel:r1', 'leaveLevel:f1', 'beforeEnterLevel:f2', 'enterLevel:f2', 'beforeEnterLevel:r3', 'enterLevel:r3']);
    expect(get('f1').visible).toBe(false);
    expect(get('f2').visible).toBe(true);
  });

  it('flies through every level when not jumping', async () => {
    const { indoor, get, calls } = manager();
    await indoor.enter(get('r1'), { jumping: false });
    expect(calls.views).toHaveLength(3);
    await indoor.enter(get('f1'), { fly: false });
    expect(calls.views).toHaveLength(3);
  });

  it('cancels a transition when another one starts', async () => {
    const flights: (() => void)[] = [];
    const h = host({}, () => new Promise<void>((r) => flights.push(r)));
    const indoor = new IndoorManager(h.host);
    const b = indoor.add(richDoc());
    const flying = async (n: number) => {
      for (let i = 0; i < 50 && flights.length < n; i++) await new Promise((r) => setTimeout(r, 0));
      expect(flights).toHaveLength(n);
    };
    const first = indoor.enter(b);
    await flying(1);
    // The first transition is flying; a second one takes over (the camera would cancel the first flight).
    const second = indoor.enter(indoor.getById('f2'));
    flights[0]();
    expect(await first).toBe(false);
    await flying(2);
    flights[1]();
    expect(await second).toBe(true);
    expect(indoor.current?.id).toBe('f2');
  });

  it('stops a transition when a listener starts another one mid-way', async () => {
    const { indoor, get } = manager();
    const entered: string[] = [];
    indoor.events.on('enterLevel', (e) => {
      entered.push(e.object?.id ?? 'globe');
      if (e.object?.id === 'f1' && e.next?.id === 'r1') void indoor.enter(get('f2'));
    });
    const result = await indoor.enter(get('r1'));
    expect(result).toBe(false);
    expect(entered).toEqual(['b1', 'f1', 'f2']);
    expect(indoor.current?.id).toBe('f2');
  });

  it('flies back to the view it left when going up', async () => {
    const { indoor, b, get, calls, camera } = manager();
    cameraNear(camera, b);
    await indoor.enter(b);
    const atBuilding = camera.position.clone();
    camera.position.addScalar(5); // the flight would have moved it
    await indoor.enter(get('r1'));
    expect(calls.poses).toHaveLength(0);
    // Back to the floor: never viewed, so it is framed.
    await indoor.back();
    expect(calls.poses).toHaveLength(0);
    expect(calls.views).toHaveLength(3);
    // Back to the building: the remembered pose.
    await indoor.back();
    expect(calls.poses).toHaveLength(1);
    expect(calls.poses[0].position.distanceTo(atBuilding.addScalar(5))).toBeLessThan(1e-6);
    // Back to the globe: where the camera was before entering the building.
    await indoor.back();
    expect(calls.poses).toHaveLength(2);
    expect(indoor.current).toBeNull();
    // Each remembered view is used once.
    await indoor.enter(get('f1'));
    await indoor.enter(b);
    expect(calls.poses).toHaveLength(2);
  });

  it('does not remember a far globe view', async () => {
    const { indoor, b, calls, camera } = manager();
    camera.position.set(0, 0, 2e7);
    await indoor.enter(b);
    await indoor.back();
    expect(calls.poses).toHaveLength(0);
    // A wide view of the building instead.
    expect(calls.views.at(-1)!.pitch).toBe(-35);
  });

  it('uses the document viewpoint relative to the building heading', async () => {
    const { indoor, get, calls } = manager();
    await indoor.enter(get('r2'));
    const view = calls.views.at(-1)!;
    expect(view.heading).toBeCloseTo(30 + 90, 9);
    expect(view.pitch).toBe(-60);
    expect(view.range).toBe(25);
  });

  it('frames levels with the nearest diagonal view', async () => {
    const { indoor, b, calls, camera } = manager();
    cameraNear(camera, b);
    await indoor.enter(b);
    // Building heading 30; the camera is south of the building: the candidates facing north are 345 and 75.
    expect([345, 75]).toContain(calls.views[0].heading);
    expect(calls.views[0].pitch).toBe(-35);
  });

  it('shows the shell outside, all floors in the building, one floor below', async () => {
    const { indoor, b, get, calls } = manager();
    expect(b.exterior.visible).toBe(true);
    expect(b.floors.every((f) => !f.visible)).toBe(true);
    await indoor.enter(b);
    expect(b.exterior.visible).toBe(false);
    expect(b.floors.every((f) => f.visible)).toBe(true);
    expect(calls.tilesets.at(-1)).toBe(false);
    await indoor.enter(get('f2'));
    expect(b.floors.map((f) => f.visible)).toEqual([false, true]);
    await indoor.back();
    expect(b.floors.every((f) => f.visible)).toBe(true);
    await indoor.enter(null);
    expect(calls.tilesets.at(-1)).toBe(true);
  });

  it('fades the rest of the floor in a room or on a device', async () => {
    const { indoor, get } = manager();
    const [r1, r2, t1, t2, t3, w1, d1] = ['r1', 'r2', 't1', 't2', 't3', 'w1', 'd1'].map(get);
    await indoor.enter(r1);
    expect([r1, t1, d1, w1].map((e) => e.levelOpacity)).toEqual([1, 1, 1, 1]);
    expect([r2, t2, t3].map((e) => e.levelOpacity)).toEqual([SIBLING_OPACITY, SIBLING_OPACITY, SIBLING_OPACITY]);
    // Faded meshes are transparent and stop writing depth.
    const m = r2.meshes[0].material as unknown as { opacity: number; transparent: boolean; depthWrite: boolean };
    expect(m.transparent).toBe(true);
    expect(m.depthWrite).toBe(false);
    expect(m.opacity).toBeCloseTo(SIBLING_OPACITY, 9);
    // A device in another room keeps that room.
    await indoor.enter(t2);
    expect([t2, r2].map((e) => e.levelOpacity)).toEqual([1, 1]);
    expect([r1, t1, t3].map((e) => e.levelOpacity)).toEqual([SIBLING_OPACITY, SIBLING_OPACITY, SIBLING_OPACITY]);
    await indoor.back();
    expect([r1, r2, t1, t2, t3, d1].every((e) => e.levelOpacity === 1)).toBe(true);
    expect(m.transparent).toBe(false);
    expect(m.depthWrite).toBe(true);
    expect(m.opacity).toBe(1);
  });

  it('keeps user styles apart from level fading', async () => {
    const { indoor, get } = manager();
    const r2 = get('r2');
    r2.setStyle({ opacity: 0.5 });
    await indoor.enter(get('r1'));
    const m = r2.meshes[0].material as unknown as { opacity: number };
    expect(m.opacity).toBeCloseTo(0.5 * SIBLING_OPACITY, 9);
    await indoor.back();
    expect(m.opacity).toBeCloseTo(0.5, 9);
    expect(r2.style.opacity).toBe(0.5);
  });

  it('runs custom level controls by condition and priority', async () => {
    const { indoor, get, calls } = manager();
    const log: string[] = [];
    const custom: LevelControl = {
      condition: '.room && tags:or(office)',
      priority: 1,
      setEffect: ({ object }) => void log.push(`set:${object.id}`),
      resetEffect: ({ object }) => void log.push(`reset:${object.id}`),
      filterObject: (hit) => (hit.type === 'thing' ? null : hit),
      viewFor: () => null,
      configureCamera: ({ object }) => {
        log.push(`camera:${object.id}`);
        return () => log.push(`restore:${object.id}`);
      },
    };
    const off = indoor.registerLevelControl(custom, 'test');
    expect(indoor.controlFor(get('r1'))).toBe(custom);
    expect(indoor.controlFor(get('r2'))).not.toBe(custom);
    await indoor.enter(get('r1'));
    expect(log).toEqual(['set:r1', 'camera:r1']);
    // viewFor returned null: no flight for the room.
    expect(calls.views).toHaveLength(0);
    expect(indoor.filterObject(get('t1'))).toBeNull();
    // The built-in placement control did not run: nothing faded.
    expect(get('r2').levelOpacity).toBe(1);
    await indoor.enter(get('r2'));
    expect(log).toEqual(['set:r1', 'camera:r1', 'restore:r1', 'reset:r1']);
    expect(get('r1').levelOpacity).toBe(SIBLING_OPACITY);
    off();
    expect(indoor.controlFor(get('r1'))).not.toBe(custom);
    // Replacing the defaults by tag: the fallback control has no effects.
    indoor.unregisterLevelControls('builtin');
    await indoor.enter(get('f2'));
    expect(get('f1').visible).toBe(true);
  });

  it('waits for the level models before flying, at most modelWaitMs', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const loadModel = async (): Promise<Object3D> => {
      await gate;
      return new Group();
    };
    const doc = richDoc();
    (doc.floors as Record<string, unknown>[])[0].model = { uri: 'f1.glb' };
    const { indoor, get, calls } = manager(doc, { loadModel });
    const entering = indoor.enter(get('f1'));
    await new Promise((r) => setTimeout(r, 20));
    expect(calls.views).toHaveLength(0);
    release();
    await entering;
    expect(calls.views).toHaveLength(1);

    // A model that never arrives delays the flight by modelWaitMs only.
    const stuck = richDoc();
    (stuck.floors as Record<string, unknown>[])[1].model = { uri: 'f2.glb' };
    const late = manager(stuck, { loadModel: () => new Promise<Object3D>(() => undefined) });
    late.indoor.modelWaitMs = 30;
    const t0 = performance.now();
    await late.indoor.enter(late.get('f2'));
    expect(late.calls.views).toHaveLength(1);
    expect(performance.now() - t0).toBeGreaterThanOrEqual(25);
  });

  it('expands floors only at the building level', async () => {
    const { indoor, b, get } = manager();
    indoor.expandFloors = true;
    await indoor.enter(b);
    b.update(10);
    expect(get('f2').group.position.z).toBeGreaterThan(4 + 6);
    await indoor.enter(get('f2'));
    b.update(10);
    expect(get('f2').group.position.z).toBeCloseTo(4, 2);
  });

  it('asks the viewer for a crossfade when a level change alters what is shown', async () => {
    let fades = 0;
    const { indoor, b, get } = manager(richDoc(), { beginTransition: () => fades++ });
    await indoor.enter(b);
    expect(fades).toBe(1);
    // Re-entering the current level changes nothing on screen.
    await indoor.enter(b);
    expect(fades).toBe(1);
    await indoor.enter(get('r1'));
    await indoor.back();
    expect(fades).toBe(3);
    await indoor.enter(get('f2'), { transition: false });
    expect(fades).toBe(3);
    // Removing the building resets it without a fade.
    indoor.remove(b);
    expect(fades).toBe(3);
    expect(indoor.current).toBeNull();
  });

  it('keeps the look-at target of remembered views and flies back with it', async () => {
    const { indoor, b, get, calls, camera } = manager(richDoc(), {});
    cameraNear(camera, b);
    const target = b.worldBounds(new Sphere())!.center.clone();
    (indoor as unknown as { host: IndoorHost }).host.getCameraPose = () => ({ position: camera.position.clone(), heading: 12, pitch: -20, target: target.clone() });
    await indoor.enter(b);
    await indoor.enter(get('f1'));
    await indoor.back();
    expect(calls.poses.at(-1)!.target!.distanceTo(target)).toBeLessThan(1e-9);
  });

  it('clamps buildings without a height to the terrain', () => {
    const indoor = new IndoorManager(host().host);
    const doc = minimalDoc();
    (doc.anchor as Record<string, unknown>).height = undefined;
    const b = indoor.add(doc);
    expect(b.groundHeight).toBe(40);
  });

  it('clamps to 3D Tiles without the globe and keeps that height while they are suppressed', async () => {
    // The viewer's wiring: reliable surfaceHeight or null (keep the current height).
    const tiles = { active: true, hit: { height: 52, resolution: 400 } as SurfaceSample | null };
    const surface = new SurfaceHeightQuery({
      globeShown: () => false,
      terrain: () => null,
      tilesActive: () => tiles.active,
      raycastTiles: () => tiles.hit,
      now: () => 0,
    });
    surface.beginFrame();
    const frames = (n: number) => {
      for (let i = 0; i < n; i++) {
        surface.beginFrame();
        indoor.update(1 / 60);
      }
    };
    const indoor = new IndoorManager(
      host({
        groundHeight: (lon, lat) => {
          const s = surface.query(lon, lat);
          return s.reliable ? s.height : null;
        },
        setTilesetsVisible: (v) => {
          tiles.active = v;
        },
      }).host,
    );
    const doc = minimalDoc();
    (doc.anchor as Record<string, unknown>).height = undefined;
    const b = indoor.add(doc);
    // Coarse tiles: not clamped yet (no floating on a rough estimate).
    expect(b.groundHeight).toBe(0);
    tiles.hit = { height: 47.2, resolution: 6 };
    frames(10);
    expect(b.groundHeight).toBeCloseTo(47.2, 6);
    await indoor.enter(b);
    expect(tiles.active).toBe(false);
    tiles.hit = null;
    frames(90);
    expect(b.groundHeight).toBeCloseTo(47.2, 6);
    await indoor.back();
    tiles.hit = { height: 46.9, resolution: 1 };
    frames(60);
    expect(b.groundHeight).toBeCloseTo(46.9, 6);
  });
});
