/**
 * Features of 3D Tiles content (roadmap P2.3): which feature a picked
 * triangle belongs to, its properties, and a highlight overlay for it.
 *
 * - Feature IDs: `EXT_mesh_features` feature ID attributes and implicit IDs
 *   (the vertex index), b3dm batch IDs (`_BATCHID`) and i3dm instances.
 *   Feature ID textures are not read: the library reads them through a
 *   WebGL renderer of its own, and tiles stay WebGPU-only.
 * - Properties: `EXT_structural_metadata` property tables, or the batch table
 *   (b3dm / i3dm). Property textures and attributes are not read.
 * - Highlight: a translucent copy of the feature's triangles hung under the
 *   tile mesh, so it follows the tile's transform and visibility and the tile
 *   materials (and their shared pipelines) stay untouched.
 *
 * All of it runs on the CPU from a ray hit. See docs/agents/tile-loading.md §7.1.
 */
import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  Mesh,
  type InstancedMesh,
  type InterleavedBufferAttribute,
  type Intersection,
  type Object3D,
  type Vector3,
} from 'three';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import type { Tiles3DLayer } from './Tiles3DLayer';

/** A feature of a 3D Tiles layer, picked under the pointer (`viewer.pickTileFeature`, `event.tileFeature()`). */
export interface TileFeature {
  /** The 3D Tiles layer the feature belongs to. */
  readonly layer: Tiles3DLayer;
  /**
   * Feature ID within its tile content: the `EXT_mesh_features` feature ID, or
   * the batch ID (b3dm, i3dm). IDs are only unique inside one tile's content.
   */
  readonly id: number;
  /**
   * Where the properties come from: the property table name (or its class)
   * of `EXT_structural_metadata`, 'batch' for a batch table, null when the
   * content has no properties for the feature.
   */
  readonly table: string | null;
  /** Properties of the feature (property table row or batch table entry); empty when there are none. */
  readonly properties: Record<string, unknown>;
  /** World (ECEF) position that was picked. */
  readonly point: Vector3;
  /** @advanced The tile mesh the feature was picked on; a highlight covers the feature in this mesh. */
  readonly object: Object3D;
}

/** Where the feature IDs of a tile mesh come from (first usable feature ID set). */
export type FeatureIdSource =
  /** A vertex attribute (`_feature_id_N`, or `_batchid` of b3dm). */
  | { kind: 'attribute'; attribute: string; nullId: number | null; table: number | 'batch' | null }
  /** The vertex index (`EXT_mesh_features` without attribute or texture). */
  | { kind: 'implicit'; nullId: number | null; table: number | null }
  /** The instance index of an i3dm instanced mesh. */
  | { kind: 'instance'; table: 'batch' | null };

/** The parts of the library's `MeshFeatures` read here. */
interface MeshFeaturesLike {
  getFeatureInfo(): { attribute?: number; texture?: unknown; propertyTable?: number | null; nullFeatureId?: number | null }[];
}

/** The parts of the library's `StructuralMetadata` read here. */
interface StructuralMetadataLike {
  getPropertyTableData(table: number, id: number): Record<string, unknown>;
  getPropertyTableInfo(table: number): { name?: string | null; className?: string | null };
}

/** The parts of the library's `BatchTable` read here. */
interface BatchTableLike {
  count: number;
  getDataFromId(id: number, target?: Record<string, unknown>): Record<string, unknown>;
}

/** Batch table of the tile content an object belongs to (set on the content's root by the b3dm / i3dm loaders). */
export function batchTableOf(object: Object3D): BatchTableLike | null {
  for (let x: Object3D | null = object; x; x = x.parent) {
    const table = (x as Object3D & { batchTable?: BatchTableLike }).batchTable;
    if (table) return table;
  }
  return null;
}

/** Where a tile mesh's feature IDs come from; null when it has none this module can read. */
export function featureIdSource(object: Object3D): FeatureIdSource | null {
  const features = object.userData?.meshFeatures as MeshFeaturesLike | undefined;
  if (features) {
    for (const info of features.getFeatureInfo()) {
      // Feature ID textures would need a GPU read back.
      if (info.texture) continue;
      const nullId = info.nullFeatureId ?? null;
      const table = info.propertyTable ?? null;
      if (info.attribute !== undefined && info.attribute !== null) return { kind: 'attribute', attribute: `_feature_id_${info.attribute}`, nullId, table };
      return { kind: 'implicit', nullId, table };
    }
    return null;
  }
  const batch = batchTableOf(object) ? 'batch' : null;
  if ((object as InstancedMesh).isInstancedMesh) return batch ? { kind: 'instance', table: batch } : null;
  const geometry = (object as Mesh).geometry as BufferGeometry | undefined;
  if (geometry?.getAttribute('_batchid')) return { kind: 'attribute', attribute: '_batchid', nullId: null, table: batch };
  return null;
}

/** The three vertex indices of a triangle (indexed or not). */
export function triangleVertices(geometry: BufferGeometry, faceIndex: number, out: [number, number, number] = [0, 0, 0]): [number, number, number] {
  const index = geometry.index;
  for (let k = 0; k < 3; k++) out[k] = index ? index.getX(3 * faceIndex + k) : 3 * faceIndex + k;
  return out;
}

/** The vertex of a hit closest to the hit point (largest barycentric weight; points hit a vertex directly). */
function hitVertex(geometry: BufferGeometry, hit: Pick<Intersection, 'faceIndex' | 'barycoord' | 'index'>): number | null {
  if (hit.faceIndex === undefined || hit.faceIndex === null) return hit.index ?? null;
  const [a, b, c] = triangleVertices(geometry, hit.faceIndex);
  const w = hit.barycoord;
  if (!w) return a;
  return w.x >= w.y && w.x >= w.z ? a : w.y >= w.z ? b : c;
}

/** Feature ID of a vertex, or null for the null feature ID. */
function vertexFeature(geometry: BufferGeometry, source: FeatureIdSource, vertex: number): number | null {
  if (source.kind === 'instance') return null;
  const id = source.kind === 'implicit' ? vertex : Math.round(geometry.getAttribute(source.attribute).getX(vertex));
  return source.nullId !== null && id === source.nullId ? null : id;
}

/** Feature ID at a ray hit on a tile mesh, or null (no feature there, or the null feature ID). */
export function featureIdAt(source: FeatureIdSource, hit: Pick<Intersection, 'object' | 'faceIndex' | 'barycoord' | 'index' | 'instanceId'>): number | null {
  if (source.kind === 'instance') return hit.instanceId ?? null;
  const geometry = (hit.object as Mesh).geometry as BufferGeometry | undefined;
  if (!geometry) return null;
  const vertex = hitVertex(geometry, hit);
  return vertex === null ? null : vertexFeature(geometry, source, vertex);
}

/** Properties of a feature and the name of the table they come from (empty when there are none or the ID is out of range). */
export function featureProperties(object: Object3D, source: FeatureIdSource, id: number): { table: string | null; properties: Record<string, unknown> } {
  const table = source.table;
  try {
    if (table === 'batch') {
      const batch = batchTableOf(object);
      if (batch && id >= 0 && id < batch.count) return { table: 'batch', properties: batch.getDataFromId(id, {}) };
    } else if (table !== null) {
      const metadata = object.userData?.structuralMetadata as StructuralMetadataLike | undefined;
      if (metadata) {
        const info = metadata.getPropertyTableInfo(table);
        return { table: info.name || info.className || String(table), properties: metadata.getPropertyTableData(table, id) };
      }
    }
  } catch {
    // Out-of-range IDs and malformed tables: no properties rather than a failed pick.
  }
  return { table: null, properties: {} };
}

/** Resolves a ray hit on a tile mesh to a feature; null when the mesh has no readable feature IDs there. */
export function resolveTileFeature(layer: Tiles3DLayer, hit: Intersection): TileFeature | null {
  const source = featureIdSource(hit.object);
  if (!source) return null;
  const id = featureIdAt(source, hit);
  if (id === null) return null;
  const { table, properties } = featureProperties(hit.object, source, id);
  return { layer, id, table, properties, point: hit.point.clone(), object: hit.object };
}

/** Vertex indices (three per triangle) of the triangles of a feature: those with at least one vertex of the feature. */
export function featureTriangleVertices(geometry: BufferGeometry, source: FeatureIdSource, id: number): Uint32Array {
  const index = geometry.index;
  const triangles = Math.floor((index ? index.count : geometry.getAttribute('position').count) / 3);
  const out: number[] = [];
  const tri: [number, number, number] = [0, 0, 0];
  for (let f = 0; f < triangles; f++) {
    triangleVertices(geometry, f, tri);
    if (vertexFeature(geometry, source, tri[0]) === id || vertexFeature(geometry, source, tri[1]) === id || vertexFeature(geometry, source, tri[2]) === id) {
      out.push(tri[0], tri[1], tri[2]);
    }
  }
  return Uint32Array.from(out);
}

type TypedArrayConstructor = new (length: number) => ArrayLike<number> & { [i: number]: number };

/**
 * Positions of the given vertices as a new, non-indexed geometry with the same
 * storage type and normalization as the source (quantized positions stay
 * quantized), so the copy rasterizes to the same depth as the original.
 */
export function copyPositions(geometry: BufferGeometry, vertices: ArrayLike<number> | null): BufferGeometry {
  const src = geometry.getAttribute('position') as BufferAttribute | InterleavedBufferAttribute;
  const itemSize = src.itemSize;
  const interleaved = (src as InterleavedBufferAttribute).isInterleavedBufferAttribute === true;
  const array = interleaved ? (src as InterleavedBufferAttribute).data.array : (src as BufferAttribute).array;
  const stride = interleaved ? (src as InterleavedBufferAttribute).data.stride : itemSize;
  const offset = interleaved ? (src as InterleavedBufferAttribute).offset : 0;
  const count = vertices ? vertices.length : src.count;
  const out = new (array.constructor as TypedArrayConstructor)(count * itemSize);
  for (let k = 0; k < count; k++) {
    const v = vertices ? vertices[k] : k;
    for (let c = 0; c < itemSize; c++) out[k * itemSize + c] = array[v * stride + offset + c];
  }
  const copy = new BufferGeometry();
  copy.setAttribute('position', new BufferAttribute(out as unknown as Float32Array, itemSize, src.normalized));
  if (!vertices && geometry.index) copy.setIndex(new BufferAttribute(Uint32Array.from(geometry.index.array as ArrayLike<number>), 1));
  return copy;
}

/** Look of a feature highlight. */
export interface FeatureHighlightStyle {
  /** CSS color (default '#ffd23f', the vector highlight color). */
  color?: string;
  /** 0..1 (default 0.5). */
  opacity?: number;
}

const DEFAULT_HIGHLIGHT = '#ffd23f';

/**
 * The overlay mesh of a highlighted feature: its triangles, child of the tile
 * mesh (an i3dm instance copies the whole instance at its matrix). Ignores
 * rays, so picking still resolves the tile mesh. Null when the feature has no
 * triangles in that mesh (e.g. points, or IDs that only exist on vertices).
 */
export function createFeatureHighlight(feature: TileFeature, style: FeatureHighlightStyle = {}): Mesh | null {
  const object = feature.object as Mesh;
  const source = featureIdSource(object);
  if (!source || !(object as Mesh).isMesh) return null;
  let geometry: BufferGeometry;
  const instanced = source.kind === 'instance';
  if (instanced) {
    geometry = copyPositions(object.geometry, null);
  } else {
    const vertices = featureTriangleVertices(object.geometry, source, feature.id);
    if (vertices.length === 0) return null;
    geometry = copyPositions(object.geometry, vertices);
  }
  const material = new MeshBasicNodeMaterial();
  material.color = new Color(style.color ?? DEFAULT_HIGHLIGHT);
  material.transparent = true;
  material.opacity = style.opacity ?? 0.5;
  material.depthWrite = false;
  material.side = DoubleSide;
  const overlay = new Mesh(geometry, material);
  overlay.name = 'feature highlight';
  overlay.userData.featureHighlight = true;
  // Picking keeps resolving the tile mesh underneath.
  overlay.raycast = () => undefined;
  overlay.renderOrder = 1;
  if (instanced) {
    overlay.matrixAutoUpdate = false;
    (object as unknown as InstancedMesh).getMatrixAt(feature.id, overlay.matrix);
  }
  object.add(overlay);
  overlay.updateMatrixWorld(true);
  return overlay;
}

/** Removes a highlight overlay and frees its geometry and material (the tile's own resources are untouched). */
export function disposeFeatureHighlight(overlay: Mesh): void {
  overlay.removeFromParent();
  overlay.geometry.dispose();
  (overlay.material as MeshBasicNodeMaterial).dispose();
}
