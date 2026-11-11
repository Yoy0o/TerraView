/**
 * M3.6 device batching and style pool: instancing per floor / geometry /
 * material state, instance → entity mapping, styles through instance
 * attributes, pooled materials with reference counts.
 */
import { BoxGeometry, Color, Group, Mesh, MeshStandardMaterial, PerspectiveCamera, Raycaster, Sphere, Vector3, type Object3D } from 'three';
import { MeshStandardNodeMaterial } from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { Ellipsoid } from '../src/core/Ellipsoid';
import { resolveLook, type BaseLook, type BimEntity } from '../src/indoor/BimEntity';
import { Building } from '../src/indoor/Building';
import { isBatchMesh, type BatchMesh } from '../src/indoor/InstanceBatch';
import { IndoorManager, type IndoorHost } from '../src/indoor/IndoorManager';
import { SIBLING_OPACITY } from '../src/indoor/LevelControl';
import { parseBuildingDoc } from '../src/indoor/schema';
import { RefCountedPool, StylePool } from '../src/indoor/StylePool';

const E = Ellipsoid.WGS84;

function doc(things: Record<string, unknown>[], extraFloors: Record<string, unknown>[] = []): Record<string, unknown> {
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
        things,
      },
      ...extraFloors,
    ],
  };
}

const THINGS = [
  { id: 't1', category: 'camera', position: [5, 4, 3], size: [0.4, 0.4, 0.4] },
  { id: 't2', category: 'camera', position: [15, 4, 3], size: [0.4, 0.4, 0.4] },
  { id: 't3', category: 'sensor', position: [6, 2, 0], shape: 'cylinder', size: [0.3, 0.3, 1] },
  { id: 't4', category: 'desk', position: [14, 2, 0], size: [2, 1, 0.75], color: '#00ff00' },
];

function host(loadModel: IndoorHost['loadModel'] = null): IndoorHost {
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

function setup(things: Record<string, unknown>[] = THINGS) {
  const indoor = new IndoorManager(host());
  const b = indoor.add(doc(things));
  const get = (id: string) => indoor.getById(id)!;
  return { indoor, b, get };
}

/** The batch mesh and index currently drawing an entity's only instance. */
function slotOf(b: Building, e: BimEntity): { mesh: BatchMesh; index: number } | null {
  for (const mesh of b.batchMeshes) {
    for (let i = 0; i < mesh.count; i++) if (mesh.entityAt(i) === e) return { mesh, index: i };
  }
  return null;
}

function styleAt(mesh: BatchMesh, i: number): number[] {
  return Array.from(mesh.bimStyle.array.slice(i * 4, i * 4 + 4));
}

function colorAt(mesh: BatchMesh, i: number): Color {
  return new Color().fromArray(mesh.instanceColor!.array, i * 3);
}

/** Ray straight down onto an entity's label anchor (above its content). */
function rayDownOnto(e: BimEntity): Raycaster {
  const top = e.labelPosition(new Vector3());
  const up = E.geodeticNormal(top, new Vector3());
  return new Raycaster(top.clone().addScaledVector(up, 5), up.negate(), 0, 100);
}

describe('style pool', () => {
  it('shares values by key and disposes them at zero references', () => {
    const pool = new RefCountedPool();
    let created = 0;
    let disposed = 0;
    const make = () => {
      created++;
      return { dispose: () => disposed++ };
    };
    const a = pool.acquire('k', make);
    expect(pool.acquire('k', make)).toBe(a);
    expect([created, pool.refs('k')]).toEqual([1, 2]);
    pool.release('k');
    expect(disposed).toBe(0);
    pool.release('k');
    expect([disposed, pool.size]).toEqual([1, 0]);
    pool.release('k'); // unknown keys are ignored
    expect(disposed).toBe(1);
  });

  it('builds one node material per base and one instance per render state', () => {
    const pool = new StylePool();
    let bases = 0;
    const base = () => {
      bases++;
      return new MeshStandardNodeMaterial();
    };
    const opaque = pool.acquireMaterial('m', base, { transparent: false, depthWrite: true });
    const again = pool.acquireMaterial('m', base, { transparent: false, depthWrite: true });
    const faded = pool.acquireMaterial('m', base, { transparent: true, depthWrite: false });
    expect(again.material).toBe(opaque.material);
    expect(faded.material).not.toBe(opaque.material);
    expect(bases).toBe(1);
    // Both variants share the base node material (one shader build).
    expect(faded.material.nodeMaterial).toBe(opaque.material.nodeMaterial);
    expect([faded.material.transparent, faded.material.depthWrite]).toEqual([true, false]);
    let baseDisposed = false;
    opaque.material.nodeMaterial.addEventListener('dispose', () => (baseDisposed = true));
    pool.releaseMaterial(opaque.key);
    pool.releaseMaterial(opaque.key);
    expect(pool.stats).toEqual({ geometries: 0, bases: 1, materials: 1 });
    pool.releaseMaterial(faded.key);
    expect(baseDisposed).toBe(true);
    expect(pool.stats).toEqual({ geometries: 0, bases: 0, materials: 0 });
  });
});

describe('resolveLook', () => {
  const base: BaseLook = { color: new Color('#336699'), emissive: new Color(0, 0, 0), opacity: 0.8, transparent: true, depthWrite: true };

  it('keeps the base without a style', () => {
    const look = resolveLook(base, {}, 1);
    expect(look.color!.getHexString()).toBe('336699');
    expect([look.opacity, look.transparent, look.depthWrite]).toEqual([0.8, true, true]);
  });

  it('replaces colors, multiplies the level opacity and fades without depth writes', () => {
    const look = resolveLook(base, { color: '#ff0000', emissive: '#0000ff', opacity: 1 }, SIBLING_OPACITY);
    expect(look.color!.getHexString()).toBe('ff0000');
    expect(look.emissive!.getHexString()).toBe('0000ff');
    expect(look.opacity).toBeCloseTo(SIBLING_OPACITY, 9);
    expect([look.transparent, look.depthWrite]).toEqual([true, false]);
    // A style opacity of 1 makes a transparent base opaque; null restores it.
    expect(resolveLook(base, { opacity: 1 }, 1).transparent).toBe(false);
    expect(resolveLook(base, { opacity: null }, 1).opacity).toBe(0.8);
  });
});

describe('device batching', () => {
  it('draws devices of one shape and material state as one instanced mesh per floor', () => {
    const { b, get } = setup();
    const meshes = b.batchMeshes.filter((m) => m.count > 0);
    // Boxes (cameras and a desk, different sizes and colors) share one batch; the cylinder has its own.
    expect(meshes).toHaveLength(2);
    const boxes = slotOf(b, get('t1'))!.mesh;
    expect(slotOf(b, get('t4'))!.mesh).toBe(boxes);
    expect(boxes.count).toBe(3);
    expect(slotOf(b, get('t3'))!.mesh).not.toBe(boxes);
    // Devices keep no meshes of their own; batches hang under the floor group.
    expect(get('t1').meshes).toHaveLength(0);
    expect(boxes.parent!.parent).toBe(get('f1').group);
    // Every instance index maps back to its entity.
    expect(['t1', 't2', 't4'].map((id) => slotOf(b, get(id))!.index).sort()).toEqual([0, 1, 2]);
    for (let i = 0; i < boxes.count; i++) expect(boxes.entityAt(i)?.type).toBe('thing');
    expect(boxes.entityAt(99)).toBeNull();
  });

  it('carries the document colors in instance colors', () => {
    const { b, get } = setup();
    const desk = slotOf(b, get('t4'))!;
    expect(colorAt(desk.mesh, desk.index).getHexString()).toBe('00ff00');
    const cam = slotOf(b, get('t1'))!;
    expect(colorAt(cam.mesh, cam.index).getHexString()).toBe(new Color('#334155').getHexString());
    expect(styleAt(cam.mesh, cam.index)).toEqual([0, 0, 0, 1]);
  });

  it('applies setStyle, hover and selection through instance attributes', () => {
    const { indoor, b, get } = setup();
    const t1 = get('t1');
    t1.setStyle({ color: '#ff0000' });
    let s = slotOf(b, t1)!;
    expect(colorAt(s.mesh, s.index).getHexString()).toBe('ff0000');
    t1.setStyle({ color: null });
    expect(colorAt(s.mesh, s.index).getHexString()).toBe(new Color('#334155').getHexString());

    indoor.setHovered(t1);
    s = slotOf(b, t1)!;
    const hover = styleAt(s.mesh, s.index);
    expect(hover.slice(0, 3).some((v) => v > 0)).toBe(true);
    indoor.select(t1);
    const selected = styleAt(s.mesh, s.index);
    expect(selected).not.toEqual(hover);
    indoor.select(null);
    indoor.setHovered(null);
    expect(styleAt(s.mesh, s.index)).toEqual([0, 0, 0, 1]);
    // Other devices in the batch are untouched.
    const t2 = slotOf(b, get('t2'))!;
    expect(styleAt(t2.mesh, t2.index)).toEqual([0, 0, 0, 1]);
  });

  it('moves faded devices to the transparent batch and back', async () => {
    const { indoor, b, get } = setup();
    const [t1, t2] = [get('t1'), get('t2')];
    const opaque = slotOf(b, t1)!.mesh;
    await indoor.enter(get('r1'));
    expect(t2.levelOpacity).toBe(SIBLING_OPACITY);
    const faded = slotOf(b, t2)!;
    expect(faded.mesh).not.toBe(opaque);
    const m = faded.mesh.material as MeshStandardNodeMaterial;
    expect([m.transparent, m.depthWrite]).toEqual([true, false]);
    expect(styleAt(faded.mesh, faded.index)[3]).toBeCloseTo(SIBLING_OPACITY, 6);
    // The device in the entered room stays opaque.
    expect(slotOf(b, t1)!.mesh).toBe(opaque);
    // User opacity multiplies with level fading.
    t2.setStyle({ opacity: 0.5 });
    const s = slotOf(b, t2)!;
    expect(styleAt(s.mesh, s.index)[3]).toBeCloseTo(0.5 * SIBLING_OPACITY, 6);
    await indoor.back();
    const back = slotOf(b, t2)!;
    expect(back.mesh).not.toBe(opaque); // still translucent (user opacity 0.5) but writes depth again
    expect((back.mesh.material as MeshStandardNodeMaterial).depthWrite).toBe(true);
    expect(styleAt(back.mesh, back.index)[3]).toBeCloseTo(0.5, 6);
    t2.setStyle({ opacity: null });
    expect(slotOf(b, t2)!.mesh).toBe(opaque);
    expect(faded.mesh.count).toBe(0);
    expect(faded.mesh.visible).toBe(false);
  });

  it('hides devices by leaving the batch and keeps the index map compact', () => {
    const { b, get } = setup();
    const boxes = slotOf(b, get('t1'))!.mesh;
    get('t1').visible = false;
    expect(boxes.count).toBe(2);
    expect(slotOf(b, get('t1'))).toBeNull();
    for (let i = 0; i < boxes.count; i++) expect(['t2', 't4']).toContain(boxes.entityAt(i)!.id);
    get('t1').visible = true;
    expect(boxes.count).toBe(3);
    expect(slotOf(b, get('t1'))!.mesh).toBe(boxes);
  });

  it('picks batched devices by instance and skips hidden ones', async () => {
    const { indoor, get } = setup();
    await indoor.enter(get('f1'));
    const t1 = get('t1');
    expect(indoor.pick(rayDownOnto(t1))?.entity).toBe(t1);
    const desk = get('t4');
    expect(indoor.pick(rayDownOnto(desk))?.entity).toBe(desk);
    t1.visible = false;
    expect(indoor.pick(rayDownOnto(t1))?.entity).not.toBe(t1);
  });

  it('bounds batched devices like their unbatched meshes', () => {
    const batched = setup().get('t4').worldBounds(new Sphere())!;
    const indoor = new IndoorManager(host());
    indoor.batchDevices = false;
    indoor.add(doc(THINGS));
    const plain = indoor.getById('t4')!;
    expect(plain.meshes).toHaveLength(1);
    const reference = plain.worldBounds(new Sphere())!;
    expect(batched.center.distanceTo(reference.center)).toBeLessThan(1e-6);
    expect(batched.radius).toBeCloseTo(reference.radius, 6);
  });

  it('follows the entity transform after refreshTransform', () => {
    const { b, get } = setup();
    const t1 = get('t1');
    const before = t1.worldBounds(new Sphere())!.center.clone();
    t1.group.position.x += 2;
    t1.refreshTransform();
    expect(t1.worldBounds(new Sphere())!.center.distanceTo(before)).toBeCloseTo(2, 6);
    const s = slotOf(b, t1)!;
    const m = new Array<number>(16);
    s.mesh.instanceMatrix.array.slice(s.index * 16, s.index * 16 + 16).forEach((v, i) => (m[i] = v));
    expect(m[12]).toBeCloseTo(7, 5); // x of the translation: 5 + 2
  });

  it('grows batches past their initial capacity', () => {
    const many = Array.from({ length: 50 }, (_, i) => ({ id: `d${i}`, position: [(i % 10) * 2, Math.floor(i / 10) * 1.5, 0], size: [1, 1, 1] }));
    const { b, get } = setup(many);
    const meshes = b.batchMeshes.filter((m) => m.count > 0);
    expect(meshes).toHaveLength(1);
    expect(meshes[0].count).toBe(50);
    expect(meshes[0].capacity).toBeGreaterThanOrEqual(50);
    // Grown meshes replaced the smaller ones in the scene.
    expect(get('f1').group.getObjectByName('batches')!.children).toHaveLength(1);
    for (let i = 0; i < 50; i++) expect(slotOf(b, get(`d${i}`))).not.toBeNull();
  });

  it('keeps draw objects under 100 for 10,000 devices', () => {
    const shapes = ['box', 'cylinder', 'sphere'];
    const floors = Array.from({ length: 10 }, (_, f) => ({
      id: `F${f}`,
      index: f,
      elevation: f * 4,
      height: 4,
      things: Array.from({ length: 1000 }, (_, i) => ({ id: `F${f}-D${i}`, shape: shapes[i % 3], position: [(i % 40) * 1.2, Math.floor(i / 40) * 1.2, 0], size: [0.5, 0.5, 0.5] })),
    }));
    const indoor = new IndoorManager(host());
    const b = indoor.add({ ...doc([]), floors });
    expect(indoor.query('.thing').length).toBe(10_000);
    const draws: Object3D[] = [];
    b.root.traverse((o) => {
      if ((o as Mesh).isMesh && (!isBatchMesh(o) || o.count > 0)) draws.push(o);
    });
    // 10 floors × 3 shapes, plus 10 slabs and the exterior shell / bands.
    expect(draws.filter(isBatchMesh)).toHaveLength(30);
    expect(draws.length).toBeLessThan(100);
  });
});

describe('batched device models', () => {
  /** A model with two meshes (body and lens); counts loads. */
  function modelHost() {
    let loads = 0;
    const loadModel = async (): Promise<Object3D> => {
      loads++;
      const scene = new Group();
      const body = new Mesh(new BoxGeometry(1, 1, 1), new MeshStandardMaterial({ color: '#808080' }));
      const lens = new Mesh(new BoxGeometry(0.2, 0.2, 0.2), new MeshStandardMaterial({ color: '#000000', emissive: '#111111' }));
      lens.position.set(0, 0, 0.6);
      scene.add(body, lens);
      return scene;
    };
    return { loadModel, loads: () => loads };
  }

  const MODEL_THINGS = [1, 2, 3].map((i) => ({ id: `m${i}`, position: [i * 3, 4, 0], model: { uri: 'cam.glb' } }));

  it('loads a model once and draws each of its meshes as one batch', async () => {
    const m = modelHost();
    const pool = new StylePool();
    const b = new Building(parseBuildingDoc(doc(MODEL_THINGS)), E, m.loadModel, undefined, { pool });
    await b.modelsLoaded();
    expect(m.loads()).toBe(1);
    const meshes = b.batchMeshes.filter((x) => x.count > 0);
    expect(meshes).toHaveLength(2);
    expect(meshes.every((x) => x.count === 3)).toBe(true);
    const thing = b.floors[0].children.find((c) => c.id === 'm2')!;
    expect(thing.instances).toHaveLength(2);
    // Base looks come from the glTF materials; the shared node material is neutral.
    const body = meshes.find((x) => (x.geometry as BoxGeometry).parameters?.width === 1)!;
    const i = Array.from({ length: body.count }, (_, k) => k).find((k) => body.entityAt(k) === thing)!;
    expect(colorAt(body, i).getHexString()).toBe('808080');
    expect((body.material as unknown as { color: Color }).color.getHexString()).toBe('ffffff');
    thing.setStyle({ color: '#ff0000' });
    expect(colorAt(body, i).getHexString()).toBe('ff0000');
    expect(thing.worldBounds(new Sphere())).not.toBeNull();
    // Two pooled geometries, two bases, two opaque variants.
    expect(pool.stats).toEqual({ geometries: 2, bases: 2, materials: 2 });
    b.dispose();
    expect(pool.stats).toEqual({ geometries: 0, bases: 0, materials: 0 });
  });

  it('applies styles set before the model arrived', async () => {
    const m = modelHost();
    const b = new Building(parseBuildingDoc(doc(MODEL_THINGS)), E, m.loadModel, undefined, { pool: new StylePool() });
    const thing = b.floors[0].children.find((c) => c.id === 'm1')!;
    thing.setStyle({ emissive: '#0000ff' });
    thing.levelOpacity = 0.25;
    await b.modelsLoaded();
    expect(thing.instances).toHaveLength(2);
    for (const mesh of b.batchMeshes.filter((x) => x.count > 0 && (x.material as MeshStandardNodeMaterial).transparent)) {
      expect(mesh.count).toBe(1);
      expect(mesh.entityAt(0)).toBe(thing);
      expect(styleAt(mesh, 0)[2]).toBeCloseTo(1, 6);
      expect(styleAt(mesh, 0)[3]).toBeCloseTo(0.25, 6);
    }
  });
});

describe('pooled resources', () => {
  it('shares materials and geometries across buildings and frees them with the last one', () => {
    const pool = new StylePool();
    const a = new Building(parseBuildingDoc(doc(THINGS)), E, null, undefined, { pool });
    const b = new Building(parseBuildingDoc({ ...doc(THINGS), id: 'b2' }), E, null, undefined, { pool });
    // Boxes and cylinders, one primitive base material in one (opaque) state.
    expect(pool.stats).toEqual({ geometries: 2, bases: 1, materials: 1 });
    const material = a.batchMeshes[0].material as MeshStandardNodeMaterial;
    expect(b.batchMeshes[0].material).toBe(material);
    let disposed = false;
    material.addEventListener('dispose', () => (disposed = true));
    a.dispose();
    expect(disposed).toBe(false);
    expect(pool.stats.materials).toBe(1);
    b.dispose();
    expect(disposed).toBe(true);
    expect(pool.stats).toEqual({ geometries: 0, bases: 0, materials: 0 });
  });

  it('releases the batches of a removed building', () => {
    const indoor = new IndoorManager(host());
    const b = indoor.add(doc(THINGS));
    const meshes = b.batchMeshes;
    expect(meshes.length).toBeGreaterThan(0);
    let freed = 0;
    for (const m of meshes) m.addEventListener('dispose', () => freed++);
    indoor.remove(b);
    expect(freed).toBe(meshes.length);
    expect(b.batchMeshes).toHaveLength(0);
  });
});
