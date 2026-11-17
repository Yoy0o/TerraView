/**
 * On-demand building models (roadmap P2.2 / M3.8): floor and device models
 * load when their floor is shown, hidden floor models unload over the budget
 * (least recently shown first), and the size estimate behind `viewer.memory`.
 */
import { BoxGeometry, BufferAttribute, BufferGeometry, CompressedTexture, DataTexture, Group, Mesh, MeshStandardMaterial, PerspectiveCamera, type Object3D, type Texture } from 'three';
import { describe, expect, it } from 'vitest';
import { Ellipsoid } from '../src/core/Ellipsoid';
import type { BimEntity } from '../src/indoor/BimEntity';
import { Building } from '../src/indoor/Building';
import { IndoorManager, type IndoorHost } from '../src/indoor/IndoorManager';
import { disposeModel, estimateModelBytes, modelsToUnload, type ModelResidency } from '../src/indoor/modelBudget';
import { parseBuildingDoc } from '../src/indoor/schema';
import { StylePool } from '../src/indoor/StylePool';

const E = Ellipsoid.WGS84;

function texture(size = 64): DataTexture {
  const t = new DataTexture(new Uint8Array(size * size * 4), size, size);
  t.generateMipmaps = false;
  return t;
}

/**
 * A floor model: a node per room (named after the room id) plus static geometry,
 * all sharing one textured material. Counts loads per URI and keeps every texture.
 */
function modelSource() {
  const loads: string[] = [];
  const textures: Texture[] = [];
  const loadModel = async (uri: string): Promise<Object3D> => {
    loads.push(uri);
    const map = texture();
    textures.push(map);
    const material = new MeshStandardMaterial({ map });
    const scene = new Group();
    const floorId = /([^/]+)\.glb$/.exec(uri)?.[1] ?? 'x';
    for (const id of [`${floorId}-r1`, `${floorId}-r2`]) {
      const node = new Mesh(new BoxGeometry(1, 1, 1), material);
      node.name = id;
      scene.add(node);
    }
    scene.add(new Mesh(new BoxGeometry(5, 5, 0.1), material));
    return scene;
  };
  return { loadModel, loads, textures };
}

function floor(id: string, index: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    index,
    elevation: index * 4,
    height: 4,
    model: { uri: `${id}.glb` },
    rooms: [
      { id: `${id}-r1`, footprint: [[0, 0], [10, 0], [10, 8], [0, 8]], walls: false },
      { id: `${id}-r2`, footprint: [[10, 0], [20, 0], [20, 8], [10, 8]], walls: false },
    ],
    ...extra,
  };
}

function doc(floors = [floor('f1', 0), floor('f2', 1), floor('f3', 2)]): Record<string, unknown> {
  return { format: 'three-geo-building', version: '1.0', id: 'b1', anchor: { longitude: 116.39, latitude: 39.9, height: 50 }, floors };
}

function host(loadModel: IndoorHost['loadModel']): IndoorHost {
  const camera = new PerspectiveCamera(50, 1.5, 0.1, 1e8);
  return {
    ellipsoid: E,
    camera,
    markers: { add: () => ({ remove: () => undefined }) } as unknown as IndoorHost['markers'],
    groundHeight: () => 40,
    flyToView: () => Promise.resolve(),
    getCameraPose: () => ({ position: camera.position.clone(), heading: 0, pitch: -30 }),
    flyToPose: () => Promise.resolve(),
    setTilesetsVisible: () => undefined,
    loadModel,
    createLabelElement: () => ({}) as HTMLElement,
  };
}

/** Lets pending model loads (resolved promises) attach. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

/** Whether a floor's model is attached: its node for the first room hangs under that room. */
function hasModel(f: BimEntity): boolean {
  return f.children[0].meshes.some((m) => m.name === `${f.id}-r1`);
}

function residency(over: Partial<ModelResidency> & { id: string }): ModelResidency & { id: string } {
  return { bytes: 10, loaded: true, visible: false, lastVisible: 0, ...over };
}

describe('modelsToUnload', () => {
  it('does nothing within the budget', () => {
    expect(modelsToUnload([residency({ id: 'a' })], 10, 10, 1e6, 0)).toEqual([]);
  });

  it('unloads hidden models, least recently shown first, until within budget', () => {
    const models = [residency({ id: 'new', lastVisible: 900 }), residency({ id: 'old', lastVisible: 100 }), residency({ id: 'mid', lastVisible: 500 })];
    // 40 loaded (10 of them not unloadable), budget 25: two have to go.
    expect(modelsToUnload(models, 40, 25, 10_000, 0).map((m) => m.id)).toEqual(['old', 'mid']);
    expect(modelsToUnload(models, 40, 30, 10_000, 0).map((m) => m.id)).toEqual(['old']);
  });

  it('keeps shown, loading and recently hidden models', () => {
    const models = [
      residency({ id: 'shown', visible: true }),
      residency({ id: 'loading', loaded: false }),
      residency({ id: 'recent', lastVisible: 9_500 }),
      residency({ id: 'empty', bytes: 0 }),
      residency({ id: 'due', lastVisible: 8_000 }),
    ];
    expect(modelsToUnload(models, 1_000, 0, 10_000, 1_000).map((m) => m.id)).toEqual(['due']);
  });
});

describe('estimateModelBytes', () => {
  it('counts attributes, indices and textures, each shared resource once', () => {
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(new Float32Array(30), 3));
    geometry.setIndex(new BufferAttribute(new Uint16Array(12), 1));
    const map = texture(16);
    const a = new Mesh(geometry, new MeshStandardMaterial({ map }));
    // A cloned material keeps the same map; the same geometry again.
    const b = new Mesh(geometry, (a.material as MeshStandardMaterial).clone());
    const root = new Group().add(a, b);
    expect(estimateModelBytes(root)).toBe(120 + 24 + 16 * 16 * 4);
    map.generateMipmaps = true;
    expect(estimateModelBytes(root)).toBeCloseTo(120 + 24 + (16 * 16 * 4 * 4) / 3, 6);
  });

  it('takes compressed textures as stored', () => {
    const t = new CompressedTexture([{ data: new Uint8Array(512), width: 32, height: 32 }, { data: new Uint8Array(128), width: 16, height: 16 }], 32, 32);
    const root = new Group().add(new Mesh(new BufferGeometry(), new MeshStandardMaterial({ map: t })));
    expect(estimateModelBytes(root)).toBe(640);
  });

  it('disposes geometries, materials and textures once', () => {
    const map = texture();
    const material = new MeshStandardMaterial({ map });
    const geometry = new BoxGeometry();
    const root = new Group().add(new Mesh(geometry, material), new Mesh(geometry, material));
    const count = { geometry: 0, material: 0, map: 0 };
    geometry.addEventListener('dispose', () => count.geometry++);
    material.addEventListener('dispose', () => count.material++);
    map.addEventListener('dispose', () => count.map++);
    disposeModel(root, root);
    expect(count).toEqual({ geometry: 1, material: 1, map: 1 });
  });
});

describe('lazy floor models', () => {
  it('loads a floor model only when asked for, with its devices', async () => {
    const src = modelSource();
    const cam = { id: 'cam', position: [2, 2, 0], model: { uri: 'cam.glb' } };
    const b = new Building(parseBuildingDoc(doc([floor('f1', 0, { things: [cam] }), floor('f2', 1)])), E, src.loadModel, undefined, { pool: new StylePool() });
    await settle();
    expect(src.loads).toEqual([]);
    expect(b.modelBytes).toBe(0);
    await b.modelsLoaded(b.floors[0]);
    expect(src.loads.sort()).toEqual(['cam.glb', 'f1.glb']);
    // Nodes named after rooms moved under the rooms.
        expect(hasModel(b.floors[0])).toBe(true);
    expect(b.modelBytes).toBeGreaterThan(0);
    // Asking for a room waits for the model of its floor.
    await b.modelsLoaded(b.floors[1].children[0]);
    expect(src.loads).toContain('f2.glb');
    b.dispose();
  });

  it('loads everything with the building when lazy models are off', async () => {
    const src = modelSource();
    const b = new Building(parseBuildingDoc(doc()), E, src.loadModel, undefined, { lazyModels: false });
    expect(src.loads.sort()).toEqual(['f1.glb', 'f2.glb', 'f3.glb']);
    await b.modelsLoaded();
    expect(b.unloadableModels()).toEqual([]);
    b.dispose();
  });

  it('frees the textures of attached models with the building', async () => {
    const src = modelSource();
    const b = new Building(parseBuildingDoc(doc()), E, src.loadModel);
    await b.modelsLoaded();
    let freed = 0;
    for (const t of src.textures) t.addEventListener('dispose', () => freed++);
    b.dispose();
    expect(freed).toBe(3);
    expect(b.modelBytes).toBe(0);
  });

  it('drops a model that arrives after the building was removed', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const src = modelSource();
    let freed = 0;
    const b = new Building(parseBuildingDoc(doc([floor('f1', 0)])), E, async (uri) => {
      await gate;
      const scene = await src.loadModel(uri);
      src.textures[0].addEventListener('dispose', () => freed++);
      return scene;
    });
    const loaded = b.modelsLoaded();
    b.dispose();
    release();
    await loaded;
    expect(freed).toBe(1);
    expect(hasModel(b.floors[0])).toBe(false);
    expect(b.modelBytes).toBe(0);
  });
});

describe('indoor model budget', () => {
  function setup() {
    const src = modelSource();
    const indoor = new IndoorManager(host(src.loadModel));
    const b = indoor.add(doc());
    const get = (id: string) => indoor.getById(id)!;
    return { src, indoor, b, get };
  }

  it('loads the models of shown floors', async () => {
    const { src, indoor, b, get } = setup();
    indoor.update(1 / 60);
    await settle();
    // Outside: floors are hidden.
    expect(src.loads).toEqual([]);
    await indoor.enter(get('f2'));
    expect(src.loads).toEqual(['f2.glb']);
    // Shown floors load without asking (e.g. entered without flying, or shown by custom code).
    b.floors[0].visible = true;
    indoor.update(1 / 60);
    await settle();
    expect(src.loads).toEqual(['f2.glb', 'f1.glb']);
    expect(indoor.modelBytes).toBe(b.modelBytes);
  });

  it('unloads hidden floor models over the budget after the delay, and loads them again when shown', async () => {
    const { src, indoor, b, get } = setup();
    await indoor.enter(b);
    expect(src.loads.sort()).toEqual(['f1.glb', 'f2.glb', 'f3.glb']);
    const perFloor = b.modelBytes / 3;
    // Room for two floor models.
    indoor.modelBytesTarget = perFloor * 2.5;
    indoor.modelUnloadDelayMs = 1000;
    let freed = 0;
    for (const t of src.textures) t.addEventListener('dispose', () => freed++);
    indoor.update(0.1);
    // f3 alone: f1 and f2 hidden from now on.
    await indoor.enter(get('f3'));
    indoor.update(0.5);
    expect(b.modelBytes).toBeCloseTo(perFloor * 3, 6);
    // Shown floors stay; after the delay one hidden floor goes (the first in order when shown at the same time).
    indoor.update(0.6);
    expect(freed).toBe(1);
    expect(b.modelBytes).toBeCloseTo(perFloor * 2, 6);
    const gone = b.floors.find((f) => !hasModel(f))!;
    expect(['f1', 'f2']).toContain(gone.id);
    // Within budget now: the other hidden floor stays.
    indoor.update(5);
    expect(freed).toBe(1);
    // Shown again: loads again.
    await indoor.enter(gone);
    expect(src.loads.filter((u) => u === `${gone.id}.glb`)).toHaveLength(2);
    expect(hasModel(gone)).toBe(true);
  });

  it('unloads the least recently shown floor first', async () => {
    const { indoor, b, get } = setup();
    await indoor.enter(get('f1'));
    indoor.update(0.1);
    await indoor.enter(get('f2'));
    indoor.update(1);
    await indoor.enter(get('f3'));
    indoor.update(1);
    const perFloor = b.modelBytes / 3;
    indoor.modelBytesTarget = perFloor * 2.5;
    indoor.modelUnloadDelayMs = 0;
    indoor.update(0.1);
    // f1 was hidden longest; f2 stays.
    expect(hasModel(get('f1'))).toBe(false);
    expect(hasModel(get('f2'))).toBe(true);
    expect(hasModel(get('f3'))).toBe(true);
  });

  it('never unloads shown floors, even over the budget', async () => {
    const { indoor, b } = setup();
    await indoor.enter(b);
    indoor.modelBytesTarget = 0;
    indoor.modelUnloadDelayMs = 0;
    indoor.update(10);
    expect(b.floors.every(hasModel)).toBe(true);
  });

  it('reports unloads as geometry changes (picking refreshes)', async () => {
    const changes: boolean[] = [];
    const src = modelSource();
    const indoor = new IndoorManager({ ...host(src.loadModel), contentChanged: (g) => changes.push(g) });
    const b = indoor.add(doc());
    await indoor.enter(b.floors[0]);
    indoor.modelBytesTarget = 0;
    indoor.modelUnloadDelayMs = 0;
    await indoor.enter(null, { fly: false });
    changes.length = 0;
    indoor.update(0.1);
    expect(changes).toContain(true);
  });
});
