/**
 * Building construction: entity tree and meshes from a building document,
 * geographic placement, glTF attachment, and instanced batches for devices
 * (M3.6, `InstanceBatch.ts`).
 */
import {
  BoxGeometry,
  BufferGeometry,
  Color,
  CylinderGeometry,
  DoubleSide,
  ExtrudeGeometry,
  Group,
  Matrix4,
  Mesh,
  Object3D,
  Shape,
  ShapeGeometry,
  SphereGeometry,
  Vector3,
  type Material,
  type Side,
} from 'three';
import { MeshStandardNodeMaterial } from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { Ellipsoid } from '../core/Ellipsoid';
import { DEG2RAD } from '../core/math';
import { BimEntity, STRUCTURE_TAG, type BaseLook } from './BimEntity';
import { InstanceBatcher, lookOf, makeBatchMaterial, toNodeMaterial, type BatchMesh, type BatchSpec } from './InstanceBatch';
import { sharedStylePool, type StylePool } from './StylePool';
import {
  bounds2,
  polygonArea,
  polygonCentroid,
  signedArea,
  type BuildingDoc,
  type ElementBase,
  type FloorDef,
  type ModelRef,
  type RoomDef,
  type StructureDef,
  type ThingDef,
  type Vec2,
} from './schema';

/** Loads a glTF model (resolved URL) into a scene graph. */
export type ModelLoader = (uri: string) => Promise<Object3D>;

export interface BuildingOptions {
  /**
   * Draw devices (things) of the same shape or model through shared
   * instanced batches (default true). False builds one mesh and material per
   * device, as before M3.6.
   */
  batching?: boolean;
  /** Pool of shared geometries and materials (default: `sharedStylePool`). */
  pool?: StylePool;
}

/** Base material key of primitive devices (all share one shader and material per render state). */
const PRIMITIVE_MATERIAL = 'thing:standard';

/** Unit primitive centered at the origin (scaled and lifted per device by the instance matrix). */
function unitGeometry(shape: ThingDef['shape']): BufferGeometry {
  if (shape === 'cylinder') return new CylinderGeometry(0.5, 0.5, 1, 20).rotateX(Math.PI / 2);
  if (shape === 'sphere') return new SphereGeometry(0.5, 20, 14);
  return new BoxGeometry(1, 1, 1);
}

/** Instance transform of a primitive device: the same solid as the unbatched geometry (bottom at z = 0 for boxes and cylinders). */
function primitiveMatrix(shape: ThingDef['shape'], w: number, d: number, h: number): Matrix4 {
  const r = Math.max(w, d, h);
  const scale = shape === 'sphere' ? new Matrix4().makeScale(r, r, r) : shape === 'cylinder' ? new Matrix4().makeScale(w, w, h) : new Matrix4().makeScale(w, d, h);
  return new Matrix4().makeTranslation(0, 0, h / 2).multiply(scale);
}

/** Model frame of a `ModelRef` (offset, heading, glTF Y-up to Z-up, scale), as `attachModel` nests it. */
function modelFrame(ref: ModelRef): Matrix4 {
  const m = new Matrix4().makeRotationZ(-(ref.rotation ?? 0) * DEG2RAD);
  if (ref.offset) m.setPosition(...ref.offset);
  if ((ref.upAxis ?? 'Y') === 'Y') m.multiply(new Matrix4().makeRotationX(Math.PI / 2));
  return m.multiply(new Matrix4().makeScale(ref.scale ?? 1, ref.scale ?? 1, ref.scale ?? 1));
}

/** A model can be batched when every mesh is plain (no skinning, morphs, instancing) with a single material. */
function batchable(scene: Object3D): boolean {
  let ok = true;
  scene.traverse((o) => {
    const mesh = o as Mesh & { isSkinnedMesh?: boolean; isInstancedMesh?: boolean };
    if (!mesh.isMesh) return;
    if (mesh.isSkinnedMesh || mesh.isInstancedMesh || Array.isArray(mesh.material) || Object.keys(mesh.geometry.morphAttributes).length > 0) ok = false;
  });
  return ok;
}

const WALL_THICKNESS = 0.14;
const DOOR_HEIGHT = 2.1;
const SLAB_THICKNESS = 0.25;
const EXPAND_SPEED = 6;

/** Soft category colors for rooms and equipment. */
const ROOM_COLORS: Record<string, string> = {
  office: '#cfe3ff',
  meeting: '#ffe2b8',
  lobby: '#d9f2e3',
  corridor: '#eef1f5',
  server: '#e3d7ff',
  restroom: '#d4eef2',
  storage: '#ece4d8',
  stair: '#e6e6e6',
  kitchen: '#ffd6d6',
};
const THING_COLORS: Record<string, string> = {
  camera: '#334155',
  sensor: '#0ea5e9',
  ap: '#f8fafc',
  extinguisher: '#dc2626',
  rack: '#1f2937',
  ahu: '#94a3b8',
  desk: '#c8a27a',
  screen: '#111827',
};

function material(color: string, options: { opacity?: number; roughness?: number; metalness?: number; side?: Side } = {}): MeshStandardNodeMaterial {
  const m = new MeshStandardNodeMaterial();
  m.color = new Color(color);
  m.roughness = options.roughness ?? 0.85;
  m.metalness = options.metalness ?? 0;
  if (options.opacity !== undefined && options.opacity < 1) {
    m.transparent = true;
    m.opacity = options.opacity;
    m.depthWrite = false;
  }
  if (options.side !== undefined) m.side = options.side;
  return m;
}

/** Counter-clockwise copy of a polygon. */
function ccw(points: Vec2[]): Vec2[] {
  return signedArea(points) < 0 ? [...points].reverse() : points;
}

function shapeOf(points: Vec2[]): Shape {
  const s = new Shape();
  points.forEach(([x, y], i) => (i === 0 ? s.moveTo(x, y) : s.lineTo(x, y)));
  s.closePath();
  return s;
}

/** Prism over a polygon from z0 to z1. */
function prism(points: Vec2[], z0: number, z1: number): BufferGeometry {
  const g = new ExtrudeGeometry(shapeOf(ccw(points)), { depth: z1 - z0, bevelEnabled: false });
  g.translate(0, 0, z0);
  return g;
}

/** Wall box from a to b (centered on the segment), bottom at z0. */
function wallBox(a: Vec2, b: Vec2, z0: number, height: number, thickness: number): BufferGeometry | null {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy);
  if (len < 0.05 || height <= 0) return null;
  const g = new BoxGeometry(len, thickness, height);
  g.rotateZ(Math.atan2(dy, dx));
  g.translate((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, z0 + height / 2);
  return g;
}

/**
 * Walls along a room boundary, inset by half the wall thickness so the walls
 * of neighbouring rooms sit back to back instead of z-fighting. Door
 * openings leave a gap with a lintel above it.
 */
function roomWalls(room: RoomDef, height: number): BufferGeometry | null {
  const pts = ccw(room.footprint);
  const n = pts.length;
  const parts: BufferGeometry[] = [];
  const inset = WALL_THICKNESS / 2;
  for (let i = 0; i < n; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len = Math.hypot(dx, dy);
    if (len < 0.05) continue;
    // Interior is on the left of each edge of a counter-clockwise polygon.
    const nx = (-dy / len) * inset;
    const ny = (dx / len) * inset;
    const p0: Vec2 = [a[0] + nx, a[1] + ny];
    const p1: Vec2 = [b[0] + nx, b[1] + ny];
    const at = (t: number): Vec2 => [p0[0] + (p1[0] - p0[0]) * t, p0[1] + (p1[1] - p0[1]) * t];
    // Door indices refer to the footprint as authored; map them when it was reversed
    // (edge i then runs backwards along authored edge n-2-i).
    const flipped = signedArea(room.footprint) < 0;
    const authoredEdge = flipped ? (n - 2 - i + n) % n : i;
    const doors = (room.doors ?? [])
      .filter((d) => d.edge === authoredEdge)
      .map((d) => ({ ...d, at: flipped ? 1 - d.at : d.at }))
      .sort((x, y) => x.at - y.at);
    let t0 = 0;
    for (const d of doors) {
      const w = Math.min(len * 0.9, d.width ?? 1.0) / len;
      const s = Math.max(0, d.at - w / 2);
      const e = Math.min(1, d.at + w / 2);
      const seg = wallBox(at(t0), at(s), 0, height, WALL_THICKNESS);
      if (seg) parts.push(seg);
      const lintel = wallBox(at(s), at(e), DOOR_HEIGHT, height - DOOR_HEIGHT, WALL_THICKNESS);
      if (lintel) parts.push(lintel);
      t0 = e;
    }
    const tail = wallBox(at(t0), at(1), 0, height, WALL_THICKNESS);
    if (tail) parts.push(tail);
  }
  if (parts.length === 0) return null;
  const merged = mergeGeometries(parts.map((p) => p.toNonIndexed()));
  for (const p of parts) p.dispose();
  return merged;
}

function addMesh(entity: BimEntity, geometry: BufferGeometry, mat: MeshStandardNodeMaterial, managed = true): Mesh {
  const mesh = new Mesh(geometry, mat);
  mesh.userData.entity = entity;
  entity.group.add(mesh);
  if (managed) entity.meshes.push(mesh);
  return mesh;
}

function labelOf<T extends { name?: string; label?: BimEntity['label'] }>(def: T): BimEntity['label'] {
  return def.label ? { ...def.label } : null;
}

/** Structural kinds: tagged `structure` (not interactive inside a floor or room). */
const STRUCTURE_TAGGED_KINDS = new Set(['wall', 'slab', 'column']);

/** Copies the document's tags and viewpoint onto a new entity. */
function adopt<T extends BimEntity>(entity: T, def: ElementBase, extraTags: string[] = []): T {
  for (const t of [...extraTags, ...(def.tags ?? [])]) entity.tags.add(t);
  entity.viewpoint = def.viewpoint ? { ...def.viewpoint } : null;
  return entity;
}

/**
 * A building on the globe: entity tree (building → floors → rooms / things /
 * elements) plus meshes, positioned by the ENU frame at its geo anchor.
 */
export class Building extends BimEntity {
  /** Geographic placement: ENU frame at the anchor, rotated by the heading. Parent of `group`. */
  readonly root = new Group();
  /** Exterior shell shown from outside (hidden when the building is entered). */
  readonly exterior = new Group();
  readonly floors: BimEntity[] = [];
  /** Ground height (ellipsoidal meters) used for the anchor when the document has none. */
  groundHeight = 0;
  private expandGap = 0;
  private expandTarget = 0;
  private readonly topElevation: number;
  /** Model loads per entity (settled when attached or failed). */
  private readonly modelLoads = new Map<BimEntity, Promise<void>[]>();
  /** Instanced device batches per floor. */
  private readonly batchers = new Map<BimEntity, InstanceBatcher>();
  /** Batched device models, loaded once per URL and shared by every device using them. */
  private readonly templates = new Map<string, Promise<Object3D | null>>();
  private readonly batching: boolean;
  private readonly pool: StylePool;
  private disposed = false;

  constructor(
    readonly doc: BuildingDoc,
    private readonly ellipsoid: Ellipsoid,
    private readonly loadModel: ModelLoader | null,
    private readonly baseUrl?: string,
    options: BuildingOptions = {},
  ) {
    super(doc.id, 'building', doc.name ?? doc.id, doc.category ?? 'building', doc.properties ?? {}, doc.label);
    adopt(this, doc);
    this.batching = options.batching ?? true;
    this.pool = options.pool ?? sharedStylePool;
    this.root.name = `Building ${this.name}`;
    this.root.matrixAutoUpdate = false;
    this.root.add(this.group);
    this.exterior.name = 'exterior';
    this.group.add(this.exterior);

    const footprint = doc.footprint ?? this.floorUnionBounds();
    this.topElevation = Math.max(...doc.floors.map((f) => f.elevation + f.height));
    for (const f of doc.floors) this.buildFloor(f, footprint);
    this.buildExterior(footprint);

    const [cx, cy] = polygonCentroid(footprint);
    this.labelAnchor.set(cx, cy, this.topElevation + (this.label?.offset ?? 3));
    this.properties = { 楼层数: doc.floors.length, 建筑高度: `${this.topElevation.toFixed(1)} m`, ...this.properties };
    this.place(doc.anchor.height ?? 0);
  }

  /** Heading of the building's +Y axis in radians (clockwise from north). */
  get heading(): number {
    return (this.doc.anchor.heading ?? 0) * DEG2RAD;
  }

  /** Re-anchors the building at a height (ellipsoidal meters). */
  place(height: number): void {
    this.groundHeight = height;
    const a = this.doc.anchor;
    const origin = this.ellipsoid.cartographicToCartesian(a.longitude * DEG2RAD, a.latitude * DEG2RAD, height);
    const enu = this.ellipsoid.eastNorthUpToFixedFrame(origin);
    // Local +Y points `heading` clockwise from north: a negative turn about up.
    this.root.matrix.copy(enu).multiply(new Matrix4().makeRotationZ(-this.heading));
    this.root.matrixWorldNeedsUpdate = true;
    this.root.updateMatrixWorld(true);
  }

  /**
   * Settles once the glTF models of an entity and its descendants are
   * attached (or failed). A level waits for this before framing the camera.
   */
  modelsLoaded(entity: BimEntity = this): Promise<void> {
    const pending: Promise<void>[] = [];
    entity.traverse((e) => pending.push(...(this.modelLoads.get(e) ?? [])));
    return Promise.all(pending).then(() => undefined);
  }

  /** Spreads floors apart vertically (楼层展开) by `gap` meters per storey (0 collapses). */
  setExpanded(gap: number): void {
    this.expandTarget = gap;
  }

  get isExpanding(): boolean {
    return Math.abs(this.expandGap - this.expandTarget) > 1e-3;
  }

  /** Advances animations; returns true when something moved. */
  update(dt: number): boolean {
    if (!this.isExpanding) return false;
    const k = 1 - Math.exp(-dt * EXPAND_SPEED);
    this.expandGap += (this.expandTarget - this.expandGap) * k;
    if (Math.abs(this.expandGap - this.expandTarget) < 0.01) this.expandGap = this.expandTarget;
    this.floors.forEach((f, rank) => {
      const def = this.doc.floors[rank];
      f.group.position.z = def.elevation + this.expandGap * rank;
      f.group.updateMatrixWorld(true);
    });
    return true;
  }

  private floorUnionBounds(): Vec2[] {
    const pts = this.doc.floors.flatMap((f) => [...(f.outline ?? []), ...(f.rooms ?? []).flatMap((r) => r.footprint)]);
    const [x0, y0, x1, y1] = bounds2(pts.length ? pts : [[0, 0], [10, 10]]);
    return [
      [x0, y0],
      [x1, y0],
      [x1, y1],
      [x0, y1],
    ];
  }

  private buildFloor(def: FloorDef, footprint: Vec2[]): void {
    const floor = adopt(new BimEntity(def.id, 'floor', def.name ?? `${def.index + 1}F`, def.category ?? 'floor', def.properties ?? {}, labelOf(def) ?? undefined), def);
    floor.group.position.z = def.elevation;
    const outline = def.outline ?? footprint;
    floor.properties = { 楼层: floor.name, 标高: `${def.elevation.toFixed(2)} m`, 层高: `${def.height.toFixed(2)} m`, 面积: `${polygonArea(outline).toFixed(1)} m²`, ...floor.properties };
    const [cx, cy] = polygonCentroid(outline);
    floor.labelAnchor.set(cx, cy, def.height);
    this.add(floor);
    this.floors.push(floor);

    // Slab: managed by the floor itself (picking empty floor area selects the floor).
    addMesh(floor, prism(outline, -SLAB_THICKNESS, 0), material('#d9dee6', { roughness: 0.95 }));

    for (const r of def.rooms ?? []) this.buildRoom(floor, r, def.height);
    for (const t of def.things ?? []) this.buildThing(floor, t);
    for (const e of def.elements ?? []) this.buildElement(floor, e, def.height);
    if (def.model) this.trackModel(floor, this.attachModel(floor, def.model, def));
  }

  private buildRoom(floor: BimEntity, def: RoomDef, floorHeight: number): void {
    const area = polygonArea(def.footprint);
    const room = adopt(new BimEntity(def.id, 'room', def.name ?? def.id, def.category ?? 'room', { 面积: `${area.toFixed(1)} m²`, ...(def.properties ?? {}) }, labelOf(def) ?? undefined), def);
    room.outline = def.footprint.map(([x, y]) => [x, y] as Vec2);
    floor.add(room);
    const height = def.height ?? floorHeight - 0.3;
    const color = def.color ?? ROOM_COLORS[room.category] ?? '#e8edf4';
    const geometry = new ShapeGeometry(shapeOf(ccw(def.footprint)));
    geometry.translate(0, 0, 0.02);
    addMesh(room, geometry, material(color, { roughness: 0.9 }));
    if (def.walls !== false) {
      const walls = roomWalls(def, height);
      if (walls) addMesh(room, walls, material('#f3f5f9', { roughness: 0.7 }));
    }
    const [cx, cy] = polygonCentroid(def.footprint);
    room.labelAnchor.set(cx, cy, height + (room.label?.offset ?? 0.6));
  }

  private buildThing(floor: BimEntity, def: ThingDef): void {
    const thing = adopt(new BimEntity(def.id, 'thing', def.name ?? def.id, def.category ?? 'thing', def.properties ?? {}, labelOf(def) ?? undefined), def);
    floor.add(thing);
    const [x, y, z] = def.position;
    thing.group.position.set(x, y, z);
    thing.group.rotation.z = -(def.rotation ?? 0) * DEG2RAD;
    const [w, d, h] = def.size ?? [0.5, 0.5, 0.5];
    const color = def.color ?? THING_COLORS[thing.category] ?? '#64748b';
    if (def.model) {
      this.trackModel(thing, this.batching ? this.attachBatchedModel(floor, thing, def.model) : this.attachModel(thing, def.model));
    } else if (this.batching) {
      thing.group.updateMatrix();
      const shape = def.shape ?? 'box';
      const spec: BatchSpec = {
        geometryKey: `unit:${shape}`,
        createGeometry: () => unitGeometry(shape),
        materialKey: PRIMITIVE_MATERIAL,
        createMaterial: () => makeBatchMaterial(material('#ffffff', { roughness: 0.5, metalness: 0.2 })),
      };
      const base: BaseLook = { color: new Color(color), emissive: new Color(0, 0, 0), opacity: 1, transparent: false, depthWrite: true };
      this.batcherFor(floor).add(thing, spec, primitiveMatrix(shape, w, d, h), base);
    } else {
      let geometry: BufferGeometry;
      if (def.shape === 'cylinder') geometry = new CylinderGeometry(w / 2, w / 2, h, 20).rotateX(Math.PI / 2);
      else if (def.shape === 'sphere') geometry = new SphereGeometry(Math.max(w, d, h) / 2, 20, 14);
      else geometry = new BoxGeometry(w, d, h);
      geometry.translate(0, 0, h / 2);
      addMesh(thing, geometry, material(color, { roughness: 0.5, metalness: 0.2 }));
    }
    thing.labelAnchor.set(0, 0, h + (thing.label?.offset ?? 0.35));
  }

  /** Instanced batches of a floor (created on first use). */
  private batcherFor(floor: BimEntity): InstanceBatcher {
    let b = this.batchers.get(floor);
    if (!b) {
      b = new InstanceBatcher(floor, this.pool);
      this.batchers.set(floor, b);
    }
    return b;
  }

  /** Every batch mesh of the building (one draw each while it has visible instances). */
  get batchMeshes(): BatchMesh[] {
    return [...this.batchers.values()].flatMap((b) => b.meshes());
  }

  /** A device model shared by all devices with the same URL (loaded once, never added to the scene). */
  private modelTemplate(uri: string): Promise<Object3D | null> {
    let p = this.templates.get(uri);
    if (!p) {
      p = this.loadModel!(uri).then(
        (scene) => {
          scene.updateMatrixWorld(true);
          return scene;
        },
        (err: Error) => {
          console.warn(`[Building] model ${uri} failed:`, err.message);
          return null;
        },
      );
      this.templates.set(uri, p);
    }
    return p;
  }

  /**
   * Attaches a device model as instances: every mesh of the model becomes an
   * instance in the floor batch of its geometry and material, so devices
   * sharing a model draw once per mesh of the model. Models that cannot be
   * instanced (skinned, morphed, multi-material) fall back to `attachModel`.
   */
  private async attachBatchedModel(floor: BimEntity, thing: BimEntity, ref: ModelRef): Promise<void> {
    if (!this.loadModel) return;
    const uri = this.baseUrl ? new URL(ref.uri, this.baseUrl).href : ref.uri;
    const scene = await this.modelTemplate(uri);
    if (this.disposed || !scene) return;
    if (!batchable(scene)) return this.attachModel(thing, ref);
    thing.group.updateMatrix();
    const frame = modelFrame(ref);
    const batcher = this.batcherFor(floor);
    scene.traverse((o) => {
      const mesh = o as Mesh;
      if (!mesh.isMesh) return;
      const source = mesh.material as Material;
      const spec: BatchSpec = {
        geometryKey: `geo:${mesh.geometry.uuid}`,
        createGeometry: () => mesh.geometry,
        materialKey: `mat:${source.uuid}`,
        createMaterial: () => makeBatchMaterial(toNodeMaterial(source)),
      };
      batcher.add(thing, spec, frame.clone().multiply(mesh.matrixWorld), lookOf(source));
    });
  }

  private buildElement(floor: BimEntity, def: StructureDef, floorHeight: number): void {
    const el = adopt(
      new BimEntity(def.id, 'element', def.name ?? def.kind, def.category ?? def.kind, { 类型: def.kind, ...(def.properties ?? {}) }, labelOf(def) ?? undefined),
      def,
      STRUCTURE_TAGGED_KINDS.has(def.kind) ? [def.kind, STRUCTURE_TAG] : [def.kind],
    );
    floor.add(el);
    const color = def.color ?? (def.kind === 'window' ? '#93c5fd' : def.kind === 'door' ? '#a16207' : '#e5e7eb');
    let geometry: BufferGeometry | null = null;
    if ((def.kind === 'wall' || def.kind === 'window') && def.path && def.path.length >= 2) {
      const parts = def.path
        .slice(1)
        .map((b, i) => wallBox(def.path![i], b, 0, def.height ?? floorHeight, def.thickness ?? WALL_THICKNESS))
        .filter((g): g is BufferGeometry => g !== null);
      if (parts.length) geometry = mergeGeometries(parts.map((p) => p.toNonIndexed()));
    } else if (def.kind === 'slab' && def.path && def.path.length >= 3) {
      geometry = prism(def.path, -(def.thickness ?? SLAB_THICKNESS), 0);
    } else if (def.position) {
      const [w, d, h] = def.size ?? [0.4, 0.4, def.height ?? floorHeight];
      geometry = new BoxGeometry(w, d, h).translate(def.position[0], def.position[1], def.position[2] + h / 2);
    }
    if (geometry) {
      geometry.computeBoundingBox();
      const box = geometry.boundingBox!;
      el.labelAnchor.set((box.min.x + box.max.x) / 2, (box.min.y + box.max.y) / 2, box.max.z + 0.3);
      addMesh(el, geometry, material(color, { opacity: def.kind === 'window' ? 0.45 : 1 }));
    }
  }

  private buildExterior(footprint: Vec2[]): void {
    const ext = this.doc.exterior;
    if (ext?.model) {
      this.trackModel(this, this.attachModel(this, ext.model, undefined, this.exterior));
      return;
    }
    const color = ext?.color ?? '#8fb3d9';
    // Glass curtain wall with opaque floor bands, and a roof slab.
    const glass = material(color, { opacity: ext?.opacity ?? 0.5, roughness: 0.15, metalness: 0.4, side: DoubleSide });
    const shell = new Mesh(prism(footprint, 0, this.topElevation), glass);
    shell.renderOrder = 2;
    shell.userData.entity = this;
    this.exterior.add(shell);
    this.meshes.push(shell);
    const band = material('#e6ebf2', { roughness: 0.8 });
    const [cx, cy] = polygonCentroid(footprint);
    const grow = (p: Vec2): Vec2 => [cx + (p[0] - cx) * 1.012, cy + (p[1] - cy) * 1.012];
    const bands: BufferGeometry[] = [];
    for (const f of this.doc.floors) bands.push(prism(footprint.map(grow), f.elevation - 0.35, f.elevation + 0.05));
    bands.push(prism(footprint.map(grow), this.topElevation - 0.1, this.topElevation + 0.6));
    const merged = mergeGeometries(bands.map((b) => b.toNonIndexed()));
    for (const b of bands) b.dispose();
    const bandMesh = new Mesh(merged, band);
    bandMesh.userData.entity = this;
    this.exterior.add(bandMesh);
    this.meshes.push(bandMesh);
  }

  private trackModel(entity: BimEntity, load: Promise<void>): void {
    const list = this.modelLoads.get(entity) ?? [];
    list.push(load);
    this.modelLoads.set(entity, list);
  }

  /**
   * Loads a glTF and attaches it to an entity. For floor models, nodes named
   * after (or with `extras.id` of) a room / thing / element id are moved under
   * that entity; everything else stays as static floor geometry.
   */
  private async attachModel(entity: BimEntity, ref: ModelRef, floorDef?: FloorDef, parent: Object3D = entity.group): Promise<void> {
    if (!this.loadModel) return;
    try {
      const uri = this.baseUrl ? new URL(ref.uri, this.baseUrl).href : ref.uri;
      const scene = await this.loadModel(uri);
      const holder = new Group();
      holder.name = `model ${ref.uri}`;
      if ((ref.upAxis ?? 'Y') === 'Y') holder.rotation.x = Math.PI / 2; // glTF +Y up -> local +Z up
      holder.scale.setScalar(ref.scale ?? 1);
      const wrapper = new Group();
      wrapper.rotation.z = -(ref.rotation ?? 0) * DEG2RAD;
      if (ref.offset) wrapper.position.set(...ref.offset);
      wrapper.add(holder);
      holder.add(scene);
      parent.add(wrapper);
      wrapper.updateMatrixWorld(true);

      if (floorDef) {
        const byId = new Map<string, BimEntity>();
        for (const c of entity.children) byId.set(c.id, c);
        const moves: [Object3D, BimEntity][] = [];
        scene.traverse((node) => {
          const id = (node.userData?.id as string | undefined) ?? node.name;
          const target = id ? byId.get(id) : undefined;
          if (target && !moves.some(([n]) => isAncestor(n, node))) moves.push([node, target]);
        });
        for (const [node, target] of moves) {
          target.group.attach(node);
          node.traverse((o) => {
            const mesh = o as Mesh;
            if (!mesh.isMesh) return;
            // Per-entity materials so style overrides stay local.
            mesh.material = Array.isArray(mesh.material) ? mesh.material.map((m) => m.clone()) : mesh.material.clone();
            mesh.userData.entity = target;
            target.meshes.push(mesh);
          });
        }
      }
      scene.traverse((o) => {
        if ((o as Mesh).isMesh && !o.userData.entity) {
          o.userData.entity = entity;
          if (entity.type === 'thing' || parent === this.exterior) entity.meshes.push(o as Mesh);
        }
      });
      // Styles and level fading set before the model arrived apply to it too.
      entity.traverse((e) => e.refreshStyle());
    } catch (err) {
      console.warn(`[Building] model ${ref.uri} failed:`, (err as Error).message);
    }
  }

  /** Local (building frame) point to world ECEF. */
  localToWorld(p: Vector3): Vector3 {
    return p.applyMatrix4(this.group.matrixWorld);
  }

  /**
   * Disposes every mesh of the building (the entity groups are nested, one
   * traversal covers all) and gives the pooled batch resources back.
   */
  override dispose(): void {
    this.disposed = true;
    // The batches go as a whole: instances need not leave them one by one.
    this.traverse((e) => {
      e.instances.length = 0;
    });
    for (const b of this.batchers.values()) b.dispose();
    this.batchers.clear();
    super.dispose();
    this.root.removeFromParent();
    // Templates were never drawn; their geometries were pooled (already released) or unused.
    for (const p of this.templates.values()) {
      void p.then((scene) =>
        scene?.traverse((o) => {
          const mesh = o as Mesh;
          if (!mesh.isMesh) return;
          mesh.geometry.dispose();
          for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) m.dispose();
        }),
      );
    }
    this.templates.clear();
  }
}

function isAncestor(a: Object3D, b: Object3D): boolean {
  for (let p = b.parent; p; p = p.parent) if (p === a) return true;
  return false;
}
