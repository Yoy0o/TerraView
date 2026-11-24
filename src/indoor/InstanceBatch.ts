/**
 * Instanced drawing of devices (M3.6). Devices with the same geometry and
 * base material on a floor are drawn by one `InstancedMesh` per render state
 * (opaque, transparent, transparent without depth write); per-device color,
 * glow and opacity are instance attributes, so styles, hover / selection
 * highlights and level fading never split a batch or clone a material.
 * Instance index → entity (`BatchMesh.entityAt`) is the instance id that GPU
 * picking (M2.1) reads back. See docs/agents/indoor-bim.md §5.2.
 */
import {
  Box3,
  Color,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  type BufferAttribute,
  type BufferGeometry,
  type Material,
} from 'three';
import { materialEmissive, materialOpacity, referenceAttribute } from 'three/tsl';
import { MeshBasicNodeMaterial, MeshLambertNodeMaterial, MeshPhongNodeMaterial, MeshPhysicalNodeMaterial, MeshStandardNodeMaterial, type NodeMaterial } from 'three/webgpu';
import { aerialPerspectiveOutputNode } from '../atmosphere/AtmosphereNodes';
import type { TSLNode } from '../core/tsl';
import type { DrawableSink } from '../post/EffectMarks';
import type { BaseLook, BimEntity, EntityInstance, ResolvedLook } from './BimEntity';
import { variantKey, type MaterialState, type StylePool } from './StylePool';

/** Floats per instance in `bimStyle`: emissive rgb, opacity. */
const STYLE_SIZE = 4;
const INITIAL_CAPACITY = 16;
const WHITE = new Color(1, 1, 1);
const BLACK = new Color(0, 0, 0);

const _m = new Matrix4();
const _box = new Box3();

/**
 * Turns a base node material into a batch material: the instance color
 * (three's `instanceColor`) multiplies the diffuse color, `bimStyle.rgb`
 * the emissive color and `bimStyle.a` the opacity. The material's own color,
 * emissive and opacity become neutral (white / white / 1) because the
 * instance carries the full value; maps still apply.
 */
export function makeBatchMaterial<T extends NodeMaterial>(m: T): T {
  // `referenceAttribute` reads `mesh.bimStyle` per object, so every batch shares one shader build.
  const style: TSLNode = referenceAttribute('bimStyle', 'vec4');
  const mat = m as T & { color?: Color; emissive?: Color; emissiveNode: TSLNode; opacityNode: TSLNode };
  mat.color?.set(1, 1, 1);
  if (mat.emissive) {
    mat.emissive.set(1, 1, 1);
    mat.emissiveNode = (materialEmissive as TSLNode).mul(style.rgb);
  }
  mat.opacity = 1;
  mat.opacityNode = (materialOpacity as TSLNode).mul(style.a);
  // Hazed by the atmosphere like the globe around it (M3.5).
  if (mat.outputNode === null) mat.outputNode = aerialPerspectiveOutputNode();
  mat.transparent = false;
  mat.depthWrite = true;
  return m;
}

const NODE_CLASSES: Record<string, new () => NodeMaterial> = {
  MeshStandardMaterial: MeshStandardNodeMaterial,
  MeshPhysicalMaterial: MeshPhysicalNodeMaterial,
  MeshBasicMaterial: MeshBasicNodeMaterial,
  MeshLambertMaterial: MeshLambertNodeMaterial,
  MeshPhongMaterial: MeshPhongNodeMaterial,
};
/** Properties not carried over to the node material (identity, listeners, type). */
const SKIPPED = new Set(['uuid', 'type', 'version', 'userData', '_listeners']);

/** Whether a material is a node material or has a node equivalent `toNodeMaterial` converts it to exactly. */
export function hasNodeEquivalent(m: Material): boolean {
  return (m as Material & { isNodeMaterial?: boolean }).isNodeMaterial === true || m.type in NODE_CLASSES;
}

/**
 * Node-material copy of a (glTF) material for batching, the same property
 * copy `renderer.library.fromMaterial` does. Unknown types fall back to a
 * standard material with the source's color and map.
 */
export function toNodeMaterial(source: Material): NodeMaterial {
  const src = source as Material & { isNodeMaterial?: boolean };
  if (src.isNodeMaterial) return (source as NodeMaterial).clone();
  const Ctor = NODE_CLASSES[source.type];
  if (!Ctor) {
    const m = new MeshStandardNodeMaterial();
    const s = source as Material & { color?: Color; map?: MeshStandardNodeMaterial['map'] };
    if (s.color) m.color.copy(s.color);
    m.map = s.map ?? null;
    m.side = source.side;
    return m;
  }
  const m = new Ctor() as unknown as Record<string, unknown>;
  for (const key in source) {
    if (SKIPPED.has(key) || key.startsWith('is')) continue;
    const v = (source as unknown as Record<string, unknown>)[key];
    // Colors are neutralized by `makeBatchMaterial`; never alias the source's (other devices read their base look from it).
    m[key] = (v as Color | null)?.isColor ? (v as Color).clone() : v;
  }
  return m as unknown as NodeMaterial;
}

/** Base look of a source material (what styles restore). */
export function lookOf(m: Material): BaseLook {
  const s = m as Material & { color?: Color; emissive?: Color };
  return { color: s.color?.clone() ?? null, emissive: s.emissive?.clone() ?? null, opacity: m.opacity, transparent: m.transparent, depthWrite: m.depthWrite };
}

/** Widens the pending upload range of an instance attribute to cover `count` items from `first`. */
function markDirty(attr: BufferAttribute, first: number, count = 1): void {
  const s = attr.itemSize;
  const start = first * s;
  const end = (first + count) * s;
  const ranges = attr.updateRanges;
  // The backend clears the ranges once uploaded; until then keep a single merged range.
  if (ranges.length === 0) attr.addUpdateRange(start, end - start);
  else {
    const r = ranges[0];
    const s0 = Math.min(r.start, start);
    r.count = Math.max(r.start + r.count, end) - s0;
    r.start = s0;
  }
  attr.needsUpdate = true;
}

/**
 * One draw of a batch: an `InstancedMesh` whose first `count` instances are
 * the visible devices of one geometry, base material and render state.
 */
export class BatchMesh extends InstancedMesh {
  readonly isBatchMesh = true;
  /** Per-instance emissive rgb and opacity (read by the material through `referenceAttribute('bimStyle')`). */
  bimStyle: InstancedBufferAttribute;
  /** Instance index → instance (and its entity). */
  readonly slots: BatchedInstance[] = [];

  constructor(
    geometry: BufferGeometry,
    material: Material,
    readonly capacity: number,
    /** Pool key of the material (released by the owning group). */
    readonly materialKey: string,
  ) {
    super(geometry, material, capacity);
    this.count = 0;
    this.visible = false;
    this.instanceColor = new InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    this.bimStyle = new InstancedBufferAttribute(new Float32Array(capacity * STYLE_SIZE), STYLE_SIZE);
    // Excluded from per-entity disposal: the batch group releases pooled resources.
    this.userData.pooled = true;
    // Devices cast and receive the sun shadows (M3.9); transparent batches are skipped when the map is drawn.
    this.castShadow = true;
    this.receiveShadow = true;
  }

  /** Entity drawn by an instance index (picking, GPU pick ids), or null when out of range. */
  entityAt(index: number): BimEntity | null {
    return this.slots[index]?.entity ?? null;
  }

  get full(): boolean {
    return this.count >= this.capacity;
  }

  /** Appends an instance; returns its index. */
  push(instance: BatchedInstance): number {
    const i = this.count;
    this.slots[i] = instance;
    this.count = i + 1;
    this.visible = true;
    this.writeMatrix(i, instance.matrix);
    this.writeLook(i, instance.look);
    this.boundsChanged();
    return i;
  }

  /** Removes an instance by moving the last one into its slot. */
  removeAt(index: number): void {
    const last = this.count - 1;
    if (index !== last) {
      const moved = this.slots[last];
      this.slots[index] = moved;
      moved.index = index;
      this.writeMatrix(index, moved.matrix);
      this.writeLook(index, moved.look);
    }
    this.slots.length = last;
    this.count = last;
    this.visible = last > 0;
    this.boundsChanged();
  }

  writeMatrix(index: number, matrix: Matrix4): void {
    this.setMatrixAt(index, matrix);
    markDirty(this.instanceMatrix, index);
  }

  writeLook(index: number, look: ResolvedLook): void {
    const color = look.color ?? WHITE;
    const emissive = look.emissive ?? BLACK;
    color.toArray(this.instanceColor!.array, index * 3);
    markDirty(this.instanceColor!, index);
    const a = this.bimStyle.array as Float32Array;
    const o = index * STYLE_SIZE;
    a[o] = emissive.r;
    a[o + 1] = emissive.g;
    a[o + 2] = emissive.b;
    a[o + 3] = look.opacity;
    markDirty(this.bimStyle, index);
  }

  /** Frustum culling and raycasting use cached bounds over the first `count` instances. */
  boundsChanged(): void {
    this.boundingBox = null;
    this.boundingSphere = null;
  }

  /** Copies the instances of a smaller batch (when growing). */
  adopt(from: BatchMesh): void {
    for (let i = 0; i < from.count; i++) {
      const inst = from.slots[i];
      inst.mesh = this;
      this.push(inst);
      inst.index = i;
    }
  }

  override dispose(): this {
    super.dispose();
    this.bimStyle.dispose();
    return this;
  }
}

/** Geometry and base material shared by the instances of one batch group. */
export interface BatchSpec {
  /** Pool key of the geometry (e.g. 'unit:box', or a glTF geometry uuid). */
  geometryKey: string;
  createGeometry: () => BufferGeometry;
  /** Pool key of the base material ("resource" part of the style key). */
  materialKey: string;
  createMaterial: () => NodeMaterial;
}

/** Instances of one geometry and base material on one floor, split into one mesh per render state. */
export class BatchGroup {
  readonly geometry: BufferGeometry;
  private readonly meshes = new Map<string, BatchMesh>();

  constructor(
    private readonly batcher: InstanceBatcher,
    readonly spec: BatchSpec,
  ) {
    this.geometry = batcher.pool.geometries.acquire(spec.geometryKey, spec.createGeometry) as BufferGeometry;
  }

  /** The mesh of a render state with room for one more instance (created or grown as needed). */
  meshFor(state: MaterialState): BatchMesh {
    const key = variantKey(this.spec.materialKey, state);
    let mesh = this.meshes.get(key);
    if (mesh && !mesh.full) return mesh;
    const capacity = mesh ? mesh.capacity * 2 : INITIAL_CAPACITY;
    const { key: materialKey, material } = mesh
      ? { key: mesh.materialKey, material: mesh.material as Material }
      : this.batcher.pool.acquireMaterial(this.spec.materialKey, this.spec.createMaterial, state);
    const next = new BatchMesh(this.geometry, material, capacity, materialKey);
    next.name = `batch ${key}`;
    if (mesh) {
      // Grow: the bigger mesh takes over the instances and the material reference.
      next.adopt(mesh);
      mesh.removeFromParent();
      mesh.dispose();
    }
    this.meshes.set(key, next);
    this.batcher.root.add(next);
    return next;
  }

  /** Every mesh of this group (one per render state used so far). */
  get batchMeshes(): IterableIterator<BatchMesh> {
    return this.meshes.values();
  }

  dispose(): void {
    for (const mesh of this.meshes.values()) {
      mesh.removeFromParent();
      mesh.dispose();
      this.batcher.pool.releaseMaterial(mesh.materialKey);
    }
    this.meshes.clear();
    this.batcher.pool.geometries.release(this.spec.geometryKey);
  }
}

/** One entity's instance in a batch group: follows the entity's look, visibility and transform. */
export class BatchedInstance implements EntityInstance {
  /** Matrix in the batch's space (the owner's local frame): entity transform × `local`. */
  readonly matrix = new Matrix4();
  look: ResolvedLook;
  mesh: BatchMesh | null = null;
  index = -1;
  private active = false;

  constructor(
    readonly entity: BimEntity,
    private readonly group: BatchGroup,
    /** Transform from the entity's frame to the instance (shape size, glTF node transform). */
    readonly local: Matrix4,
    readonly base: BaseLook,
  ) {
    this.look = { ...base };
  }

  setLook(look: ResolvedLook): void {
    this.look = look;
    if (!this.active) return;
    const mesh = this.mesh!;
    const m = mesh.material as Material;
    if (m.transparent === look.transparent && m.depthWrite === look.depthWrite) mesh.writeLook(this.index, look);
    else {
      this.leave();
      this.join();
    }
  }

  setActive(active: boolean): void {
    if (active === this.active) return;
    this.active = active;
    if (active) this.join();
    else this.leave();
  }

  updateMatrix(): void {
    this.matrix.multiplyMatrices(this.entity.group.matrix, this.local);
    if (this.mesh) {
      this.mesh.writeMatrix(this.index, this.matrix);
      this.mesh.boundsChanged();
    }
  }

  expandWorldBox(box: Box3): void {
    const g = this.group.geometry;
    if (!g.boundingBox) g.computeBoundingBox();
    _box.copy(g.boundingBox!).applyMatrix4(_m.multiplyMatrices(this.entity.group.matrixWorld, this.local));
    box.union(_box);
  }

  expandLocalBox(box: Box3): void {
    const g = this.group.geometry;
    if (!g.boundingBox) g.computeBoundingBox();
    box.union(_box.copy(g.boundingBox!).applyMatrix4(this.local));
  }

  dispose(): void {
    this.setActive(false);
  }

  collectDrawable(add: DrawableSink): void {
    const mesh = this.mesh;
    if (!mesh || !this.active || !mesh.visible) return;
    add(this.group.geometry, (mesh.material as Material).side, _m.multiplyMatrices(mesh.matrixWorld, this.matrix));
  }

  floorDrawable(add: (geometry: BufferGeometry, matrix: Matrix4) => void): void {
    // `matrix` is in the batch owner's frame: the batches sit untransformed in the floor's group.
    add(this.group.geometry, this.matrix);
  }

  private join(): void {
    const mesh = this.group.meshFor({ transparent: this.look.transparent, depthWrite: this.look.depthWrite });
    this.mesh = mesh;
    this.index = mesh.push(this);
  }

  private leave(): void {
    if (!this.mesh) return;
    this.mesh.removeAt(this.index);
    this.mesh = null;
    this.index = -1;
  }
}

/**
 * Batches of one owner entity (a floor): a group added to the owner's
 * scene group, so floor visibility and floor expansion apply to every
 * instance at once.
 */
export class InstanceBatcher {
  readonly root = new Group();
  private readonly groups = new Map<string, BatchGroup>();

  constructor(
    readonly owner: BimEntity,
    readonly pool: StylePool,
  ) {
    this.root.name = 'batches';
    owner.group.add(this.root);
  }

  /** Adds an instance of `entity` (a direct child of the owner) and registers it with the entity. */
  add(entity: BimEntity, spec: BatchSpec, local: Matrix4, base: BaseLook): BatchedInstance {
    const key = `${spec.geometryKey}|${spec.materialKey}`;
    let group = this.groups.get(key);
    if (!group) {
      group = new BatchGroup(this, spec);
      this.groups.set(key, group);
    }
    const instance = new BatchedInstance(entity, group, local, base);
    entity.addInstance(instance);
    return instance;
  }

  /** Every batch mesh (one draw each while it has instances). */
  meshes(): BatchMesh[] {
    const out: BatchMesh[] = [];
    for (const g of this.groups.values()) out.push(...g.batchMeshes);
    return out;
  }

  /** Releases every pooled geometry and material of these batches. */
  dispose(): void {
    for (const g of this.groups.values()) g.dispose();
    this.groups.clear();
    this.root.removeFromParent();
  }
}

/** Whether an object is a device batch (hits carry an `instanceId` to resolve with `entityAt`). */
export function isBatchMesh(o: unknown): o is BatchMesh {
  return (o as BatchMesh | null)?.isBatchMesh === true;
}
