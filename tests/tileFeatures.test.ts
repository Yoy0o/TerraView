/**
 * 3D Tiles feature picking (roadmap P2.3): feature IDs from EXT_mesh_features
 * attributes / implicit IDs, b3dm batch IDs and i3dm instances, properties
 * from property tables and batch tables, and the highlight overlay.
 */
import {
  BufferAttribute,
  BufferGeometry,
  Group,
  InstancedMesh,
  InterleavedBuffer,
  InterleavedBufferAttribute,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  Raycaster,
  Vector3,
  type Intersection,
} from 'three';
import { describe, expect, it } from 'vitest';
import {
  copyPositions,
  createFeatureHighlight,
  disposeFeatureHighlight,
  featureIdAt,
  featureIdSource,
  featureProperties,
  featureTriangleVertices,
} from '../src/tiles3d/tileFeatures';
import { Ellipsoid } from '../src/core/Ellipsoid';
import { resolveTileFeature, Tiles3DLayer, type TileFeature } from '../src/tiles3d/Tiles3DLayer';
import { InteractionManager, type InteractionEvent, type PickInfo } from '../src/viewer/InteractionManager';

const LAYER = { name: 'test' } as unknown as Tiles3DLayer;

/**
 * Two unit squares side by side in the z = 0 plane (x 0..1 is feature 7, x 1..2 is feature 9),
 * two triangles each, with separate vertices per square as feature boundaries have.
 */
function squares(attribute = '_feature_id_0'): BufferGeometry {
  const g = new BufferGeometry();
  const p: number[] = [];
  for (const x0 of [0, 1]) p.push(x0, 0, 0, x0 + 1, 0, 0, x0 + 1, 1, 0, x0, 1, 0);
  g.setAttribute('position', new BufferAttribute(new Float32Array(p), 3));
  g.setIndex([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]);
  g.setAttribute(attribute, new BufferAttribute(new Float32Array([7, 7, 7, 7, 9, 9, 9, 9]), 1));
  return g;
}

function meshFeatures(...sets: Record<string, unknown>[]) {
  return { getFeatureInfo: () => sets };
}

/** A hit on face `faceIndex` closest to its vertex `corner` (0..2). */
function hitOn(object: Mesh, faceIndex: number, corner = 0): Intersection {
  const barycoord = new Vector3(corner === 0 ? 0.8 : 0.1, corner === 1 ? 0.8 : 0.1, corner === 2 ? 0.8 : 0.1);
  return { object, faceIndex, barycoord, point: new Vector3(), distance: 1 } as unknown as Intersection;
}

describe('feature ID sources', () => {
  it('reads the first EXT_mesh_features set that is not a texture', () => {
    const mesh = new Mesh(squares());
    mesh.userData.meshFeatures = meshFeatures({ texture: { index: 0 }, propertyTable: 1 }, { attribute: 0, propertyTable: 0, nullFeatureId: 255 });
    expect(featureIdSource(mesh)).toEqual({ kind: 'attribute', attribute: '_feature_id_0', nullId: 255, table: 0 });
    mesh.userData.meshFeatures = meshFeatures({ featureCount: 8 });
    expect(featureIdSource(mesh)).toEqual({ kind: 'implicit', nullId: null, table: null });
    mesh.userData.meshFeatures = meshFeatures({ texture: { index: 0 } });
    expect(featureIdSource(mesh)).toBeNull();
  });

  it('uses b3dm batch IDs and i3dm instances with the content batch table', () => {
    const content = new Group() as Group & { batchTable?: unknown };
    content.batchTable = { count: 10, getDataFromId: () => ({}) };
    const b3dm = new Mesh(squares('_batchid'));
    content.add(b3dm);
    expect(featureIdSource(b3dm)).toEqual({ kind: 'attribute', attribute: '_batchid', nullId: null, table: 'batch' });
    const i3dm = new InstancedMesh(squares(), new MeshBasicMaterial(), 3);
    content.add(i3dm);
    expect(featureIdSource(i3dm)).toEqual({ kind: 'instance', table: 'batch' });
    expect(featureIdSource(new Mesh(squares('normal_only')))).toBeNull();
  });
});

describe('feature ID at a hit', () => {
  it('takes the vertex closest to the hit point', () => {
    const mesh = new Mesh(squares());
    const source = { kind: 'attribute', attribute: '_feature_id_0', nullId: null, table: null } as const;
    expect(featureIdAt(source, hitOn(mesh, 0))).toBe(7);
    expect(featureIdAt(source, hitOn(mesh, 3, 2))).toBe(9);
    // The null feature ID means "no feature".
    expect(featureIdAt({ ...source, nullId: 9 }, hitOn(mesh, 2))).toBeNull();
  });

  it('uses the vertex index for implicit IDs and the instance for i3dm', () => {
    const mesh = new Mesh(squares());
    // Face 1 is (0, 2, 3); corner 2 is vertex 3.
    expect(featureIdAt({ kind: 'implicit', nullId: null, table: null }, hitOn(mesh, 1, 2))).toBe(3);
    expect(featureIdAt({ kind: 'instance', table: 'batch' }, { object: mesh, instanceId: 2 } as unknown as Intersection)).toBe(2);
    // Points: the hit carries the vertex index.
    expect(featureIdAt({ kind: 'implicit', nullId: null, table: null }, { object: mesh, index: 5 } as unknown as Intersection)).toBe(5);
  });

  it('resolves a real ray hit end to end', () => {
    const content = new Group() as Group & { batchTable?: unknown };
    content.batchTable = { count: 10, getDataFromId: (id: number) => ({ name: `feature ${id}` }) };
    const mesh = new Mesh(squares('_batchid'), new MeshBasicMaterial());
    content.add(mesh);
    content.updateMatrixWorld(true);
    const raycaster = new Raycaster(new Vector3(1.6, 0.5, 5), new Vector3(0, 0, -1));
    const hit = raycaster.intersectObject(content, true)[0];
    const feature = resolveTileFeature(LAYER, hit)!;
    expect(feature).toMatchObject({ layer: LAYER, id: 9, table: 'batch', properties: { name: 'feature 9' }, object: mesh });
    expect(feature.point.x).toBeCloseTo(1.6, 6);
    // Without feature IDs there is no feature.
    expect(resolveTileFeature(LAYER, { ...hit, object: new Mesh(squares('other')) })).toBeNull();
  });
});

describe('feature properties', () => {
  it('reads property tables by name, class or index', () => {
    const mesh = new Mesh(squares());
    const tables = [{ name: 'buildings', className: 'building' }, { name: null, className: 'tree' }, { name: '', className: '' }];
    mesh.userData.structuralMetadata = {
      getPropertyTableInfo: (t: number) => tables[t],
      getPropertyTableData: (t: number, id: number) => ({ table: t, id }),
    };
    const source = (table: number) => ({ kind: 'attribute', attribute: '_feature_id_0', nullId: null, table }) as const;
    expect(featureProperties(mesh, source(0), 7)).toEqual({ table: 'buildings', properties: { table: 0, id: 7 } });
    expect(featureProperties(mesh, source(1), 7).table).toBe('tree');
    expect(featureProperties(mesh, source(2), 7).table).toBe('2');
  });

  it('gives no properties without a table, out of range, or when reading fails', () => {
    const content = new Group() as Group & { batchTable?: unknown };
    content.batchTable = { count: 2, getDataFromId: () => ({ a: 1 }) };
    const mesh = new Mesh(squares('_batchid'));
    content.add(mesh);
    const batch = { kind: 'attribute', attribute: '_batchid', nullId: null, table: 'batch' } as const;
    expect(featureProperties(mesh, batch, 1)).toEqual({ table: 'batch', properties: { a: 1 } });
    expect(featureProperties(mesh, batch, 5)).toEqual({ table: null, properties: {} });
    expect(featureProperties(mesh, { ...batch, table: null }, 1)).toEqual({ table: null, properties: {} });
    mesh.userData.structuralMetadata = {
      getPropertyTableInfo: () => ({ name: 't' }),
      getPropertyTableData: () => {
        throw new Error('bad table');
      },
    };
    expect(featureProperties(mesh, { ...batch, table: 0 }, 1)).toEqual({ table: null, properties: {} });
  });
});

describe('feature highlight', () => {
  it('selects the triangles of the feature', () => {
    const source = { kind: 'attribute', attribute: '_feature_id_0', nullId: null, table: null } as const;
    expect(Array.from(featureTriangleVertices(squares(), source, 9))).toEqual([4, 5, 6, 4, 6, 7]);
    expect(featureTriangleVertices(squares(), source, 3)).toHaveLength(0);
  });

  it('copies positions with their storage type, normalization and interleaving', () => {
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Int16Array([0, 0, 0, 32767, 0, 0, 0, 32767, 0, -32767, 0, 0]), 3, true));
    const copy = copyPositions(g, [3, 1]);
    const attr = copy.getAttribute('position') as BufferAttribute;
    expect(attr.array).toBeInstanceOf(Int16Array);
    expect(attr.normalized).toBe(true);
    expect(Array.from(attr.array)).toEqual([-32767, 0, 0, 32767, 0, 0]);

    const interleaved = new BufferGeometry();
    // position xyz + one padding float per vertex
    const buffer = new InterleavedBuffer(new Float32Array([1, 2, 3, 99, 4, 5, 6, 99]), 4);
    interleaved.setAttribute('position', new InterleavedBufferAttribute(buffer, 3, 0));
    expect(Array.from(copyPositions(interleaved, [1]).getAttribute('position').array)).toEqual([4, 5, 6]);
  });

  it('hangs an overlay under the tile mesh that rays ignore, and frees it', () => {
    const mesh = new Mesh(squares(), new MeshBasicMaterial());
    mesh.userData.meshFeatures = meshFeatures({ attribute: 0 });
    const feature: TileFeature = { layer: LAYER, id: 9, table: null, properties: {}, point: new Vector3(), object: mesh };
    const overlay = createFeatureHighlight(feature, { color: '#ff0000', opacity: 0.3 })!;
    expect(overlay.parent).toBe(mesh);
    expect(overlay.geometry.getAttribute('position').count).toBe(6);
    expect((overlay.material as MeshBasicMaterial).opacity).toBe(0.3);
    mesh.updateMatrixWorld(true);
    const hits = new Raycaster(new Vector3(1.7, 0.4, 5), new Vector3(0, 0, -1)).intersectObject(mesh, true);
    expect(hits.map((h) => h.object)).toEqual([mesh]);
    let disposed = 0;
    overlay.geometry.addEventListener('dispose', () => disposed++);
    (overlay.material as MeshBasicMaterial).addEventListener('dispose', () => disposed++);
    disposeFeatureHighlight(overlay);
    expect(overlay.parent).toBeNull();
    expect(disposed).toBe(2);
    // The tile's own geometry is untouched.
    expect(mesh.geometry.getAttribute('position').count).toBe(8);
    // Nothing to tint: no overlay.
    expect(createFeatureHighlight({ ...feature, id: 3 })).toBeNull();
  });

  it('copies a whole i3dm instance at its matrix', () => {
    const content = new Group() as Group & { batchTable?: unknown };
    content.batchTable = { count: 2, getDataFromId: () => ({}) };
    const mesh = new InstancedMesh(squares(), new MeshBasicMaterial(), 2);
    mesh.setMatrixAt(1, new Matrix4().makeTranslation(10, 0, 0));
    content.add(mesh);
    const overlay = createFeatureHighlight({ layer: LAYER, id: 1, table: 'batch', properties: {}, point: new Vector3(), object: mesh })!;
    expect(overlay.geometry.index!.count).toBe(12);
    expect(new Vector3().setFromMatrixPosition(overlay.matrix).x).toBe(10);
  });
});

describe('tile features on interaction events', () => {
  function setup(pick: Partial<PickInfo>) {
    const dom = new EventTarget() as unknown as HTMLElement;
    const pickAt = (clientX: number, clientY: number): PickInfo => ({ kind: 'tiles', entity: null, tileset: LAYER, point: null, cartographic: null, clientX, clientY, marker: null, ...pick });
    const im = new InteractionManager({ domElement: dom, pickAt });
    const click = () => {
      for (const type of ['pointerdown', 'pointerup']) dom.dispatchEvent(Object.assign(new Event(type), { isPrimary: true, button: 0, clientX: 1, clientY: 1 }));
    };
    return { im, click };
  }

  it('passes the pick resolver through, and null without one', () => {
    const feature = { id: 4 } as TileFeature;
    let calls = 0;
    const withFeature = setup({ tileFeature: () => (calls++, feature) });
    const seen: InteractionEvent[] = [];
    withFeature.im.on('click', (e) => seen.push(e));
    withFeature.click();
    expect(calls).toBe(0);
    expect(seen[0].tileFeature()).toBe(feature);
    const plain = setup({});
    plain.im.on('click', (e) => seen.push(e));
    plain.click();
    expect(seen[1].tileFeature()).toBeNull();
  });
});

describe('layer highlight', () => {
  it('keeps one overlay, and drops it with the tile content it was picked in', () => {
    const layer = new Tiles3DLayer({ source: { type: 'url', url: 'https://example.com/tileset.json' } }, { dracoLoader: null, ktxLoader: null, meshoptDecoder: null }, Ellipsoid.WGS84);
    const content = new Group();
    const mesh = new Mesh(squares(), new MeshBasicMaterial());
    mesh.userData.meshFeatures = meshFeatures({ attribute: 0 });
    content.add(mesh);
    const feature = (id: number): TileFeature => ({ layer, id, table: null, properties: {}, point: new Vector3(), object: mesh });
    let changes = 0;
    layer.events.on('change', () => changes++);
    layer.setHighlight(feature(7));
    layer.setHighlight(feature(9));
    expect(mesh.children).toHaveLength(1);
    expect(layer.highlighted?.id).toBe(9);
    // Another tile's content going away keeps it.
    layer.tiles.dispatchEvent({ type: 'dispose-model', scene: new Group(), tile: {} } as never);
    expect(layer.highlighted?.id).toBe(9);
    layer.tiles.dispatchEvent({ type: 'dispose-model', scene: content, tile: {} } as never);
    expect(layer.highlighted).toBeNull();
    expect(mesh.children).toHaveLength(0);
    expect(changes).toBe(3);
  });
});
