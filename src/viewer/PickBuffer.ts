/**
 * GPU pick buffer (M2.1): one render of the pickable scene into a
 * half-resolution RGBA32Uint target — R object id, G instance id (the
 * instance index of a batched device), B `floatBitsToUint(view depth)`, A
 * `packSnorm2x16(octahedral view normal)` — read back asynchronously, so
 * hover and click lookups are an array read instead of a ray cast through
 * every mesh. A buffer is only used while it matches the current camera and
 * scene (`fresh`); otherwise callers fall back to CPU rays. WebGPU only.
 * See docs/agents/roadmap.md §3 M2.1 and AGENTS.md §3.7.
 */
import {
  BackSide,
  Color,
  DoubleSide,
  FrontSide,
  NoBlending,
  RenderTarget,
  RGBAIntegerFormat,
  UnsignedIntType,
  Vector3,
  type Camera,
  type Material,
  type Mesh,
  type Object3D,
  type PerspectiveCamera,
  type Scene,
  type Side,
} from 'three';
import * as TSL from 'three/tsl';
import { MeshBasicNodeMaterial, NodeMaterialInstance, type NodeMaterial, type WebGPURenderer } from 'three/webgpu';
import type { TSLNode } from '../atmosphere/AtmosphereNodes';
import { isTileMaterial, tileMorphPositionNode } from '../globe/TileMaterial';
import { bufferPixel, decodeTexel, transformDirection, transformPoint, viewPositionFromDepth } from './pickMath';

/** What a drawn object stands for (the caller's classification; null = not drawn in the pick pass). @advanced */
export interface PickTarget<L = unknown> {
  kind: 'entity' | 'tiles' | 'globe';
  /** The 3D Tiles layer for `kind: 'tiles'`. */
  layer?: L;
}

/** A pick buffer sample resolved to a scene object and world position. @advanced */
export interface GpuPick<L = unknown> {
  object: Object3D;
  /** Instance index for instanced draws (batched devices), 0 otherwise. */
  instanceId: number;
  target: PickTarget<L>;
  /** World (ECEF) point on the cursor ray at the sampled depth. */
  point: Vector3;
  /** World unit normal of the surface, facing the camera (flat, per triangle). */
  normal: Vector3;
  /** Distance from the camera, meters. */
  distance: number;
}

/** Number of values in a frame signature: camera world (16) + projection (16) + size (2) + draws, triangles, epoch, scene key (4). */
const SIGNATURE_SIZE = 38;

/**
 * One read-back pick buffer: the texels plus what is needed to turn a
 * texel into a world position (camera matrices at render time) and the
 * objects behind the ids.
 */
export class PickFrame<L = unknown> {
  constructor(
    readonly data: Uint32Array,
    readonly width: number,
    readonly height: number,
    /** Object per id (index 0 unused). */
    readonly objects: readonly (Object3D | null)[],
    readonly targets: readonly (PickTarget<L> | null)[],
    /** Camera `projectionMatrixInverse` at render time (column-major). */
    readonly projectionInverse: ArrayLike<number>,
    /** Camera `matrixWorld` at render time (column-major, float64 ECEF). */
    readonly cameraWorld: ArrayLike<number>,
    /** Frame signature at render time (see `PickBuffer`). */
    readonly signature: Float64Array,
  ) {}

  /**
   * Sample under a point given as a fraction of the canvas (fx from the
   * left, fy from the top, 0..1). `null` = nothing drawn there (sky);
   * `undefined` = outside the buffer.
   */
  sample(fx: number, fy: number): GpuPick<L> | null | undefined {
    const px = bufferPixel(fx, fy, this.width, this.height);
    if (!px) return undefined;
    const s = decodeTexel(this.data, this.width, px[0], px[1]);
    if (!s) return null;
    const object = this.objects[s.objectId];
    const target = this.targets[s.objectId];
    if (!object || !target) return null;
    // The exact cursor ray (not the texel center) keeps the point under the cursor.
    const v = viewPositionFromDepth(fx * 2 - 1, 1 - fy * 2, s.viewZ, this.projectionInverse);
    const w = transformPoint(this.cameraWorld, v[0], v[1], v[2]);
    const n = transformDirection(this.cameraWorld, s.normal[0], s.normal[1], s.normal[2]);
    return {
      object,
      instanceId: s.instanceId,
      target,
      point: new Vector3(w[0], w[1], w[2]),
      normal: new Vector3(n[0], n[1], n[2]),
      distance: Math.hypot(v[0], v[1], v[2]),
    };
  }
}

// The pick graph mixes uint and float nodes freely; three's strict TSL typings get in the way.
const { abs, cross, dFdx, dFdy, float, floatBitsToUint, instanceIndex, normalize, packSnorm2x16, positionView, select, uint, uniform, uvec4, vec2 }: TSLNode = TSL;

/** Octahedral encoding in TSL (same formula as `pickMath.octEncode`). */
function octEncodeNode(n: TSLNode): TSLNode {
  const p: TSLNode = n.xy.div(abs(n.x).add(abs(n.y)).add(abs(n.z)));
  // sign() is 0 at 0; the CPU decoder treats 0 as positive, so map 0 to +1.
  const s: TSLNode = select(p.greaterThanEqual(vec2(0)), vec2(1), vec2(-1));
  const folded: TSLNode = vec2(float(1).sub(abs(p.y)), float(1).sub(abs(p.x))).mul(s);
  return select(n.z.lessThan(0), folded, p);
}

/**
 * Pick materials: one shared node graph writing the pick texel, as
 * `NodeMaterialInstance` variants per face side; sources with a custom
 * `positionNode` (globe tiles, which morph) get their own variant on a base
 * that reuses that position node, refreshed from the source before each
 * draw and freed when the source is disposed (bases are reference counted).
 */
export class PickMaterials {
  /** Object id written for the object being drawn (set by the owner before drawing). */
  idOf: (object: Object3D) => number = () => 0;
  private readonly output: TSLNode;
  private readonly defaults = new Map<Side, NodeMaterialInstance>();
  private readonly defaultBase: NodeMaterial;
  /** Bases per custom position node, with the number of source variants using them. */
  private readonly bases = new Map<TSLNode, { base: NodeMaterial; refs: number }>();
  private readonly perSource = new WeakMap<Material, { pick: NodeMaterialInstance; keys: string[] }>();
  /** Property names every node material has; anything else on a source is a custom (materialReference) value. */
  private readonly builtinKeys: Set<string>;
  private liveSources = 0;

  constructor() {
    const objectId: TSLNode = uniform(0, 'uint').onObjectUpdate(({ object }: { object: Object3D }) => this.idOf(object));
    const p: TSLNode = positionView;
    // Flat normal from screen-space derivatives: works without a normal attribute (globe tiles).
    const n: TSLNode = normalize(cross(dFdx(p), dFdy(p)));
    const facing: TSLNode = select(n.dot(p).greaterThan(0), n.negate(), n);
    const oct: TSLNode = octEncodeNode(facing);
    this.output = uvec4(objectId, uint(instanceIndex), floatBitsToUint(p.z), packSnorm2x16(oct));
    this.defaultBase = this.makeBase(null);
    this.builtinKeys = new Set(Object.keys(new MeshBasicNodeMaterial()));
  }

  private makeBase(positionNode: TSLNode | null): NodeMaterial {
    const m = new MeshBasicNodeMaterial();
    m.name = 'PickBuffer';
    m.fragmentNode = this.output;
    if (positionNode) m.positionNode = positionNode;
    m.blending = NoBlending; // integer targets cannot blend
    m.transparent = false;
    m.depthTest = true;
    m.depthWrite = true;
    m.fog = false;
    m.lights = false;
    m.toneMapped = false;
    return m;
  }

  /** The pick material for a source material. */
  forSource(source: Material): Material {
    const src = source as Material & { positionNode?: TSLNode | null; nodeMaterial?: NodeMaterial };
    const custom = isTileMaterial(source) ? tileMorphPositionNode() : (src.positionNode ?? src.nodeMaterial?.positionNode ?? null);
    if (!custom) return this.defaultFor(source.side);
    let entry = this.perSource.get(source);
    if (!entry) {
      let base = this.bases.get(custom);
      if (!base) {
        base = { base: this.makeBase(custom), refs: 0 };
        this.bases.set(custom, base);
      }
      base.refs++;
      this.liveSources++;
      const pick = new NodeMaterialInstance(base.base);
      pick.side = source.side;
      const keys = Object.keys(source).filter((k) => !this.builtinKeys.has(k) && !k.endsWith('Node') && !k.startsWith('is') && k !== 'nodeMaterial');
      entry = { pick, keys };
      this.perSource.set(source, entry);
      const release = () => {
        source.removeEventListener('dispose', release);
        pick.dispose();
        this.perSource.delete(source);
        this.liveSources--;
        if (--base!.refs === 0) {
          base!.base.dispose();
          this.bases.delete(custom);
        }
      };
      source.addEventListener('dispose', release);
    }
    // Values the position node reads through materialReference (e.g. a tile's morph) follow the source.
    const dst = entry.pick as unknown as Record<string, unknown>;
    const s = source as unknown as Record<string, unknown>;
    for (const k of entry.keys) dst[k] = s[k];
    return entry.pick;
  }

  private defaultFor(side: Side): NodeMaterialInstance {
    const key = side === BackSide ? BackSide : side === DoubleSide ? DoubleSide : FrontSide;
    let m = this.defaults.get(key);
    if (!m) {
      m = new NodeMaterialInstance(this.defaultBase);
      m.side = key;
      this.defaults.set(key, m);
    }
    return m;
  }

  /** Live per-source variants and custom bases (both drop to zero when their sources are disposed). */
  get stats(): { sources: number; bases: number } {
    return { sources: this.liveSources, bases: this.bases.size };
  }

  dispose(): void {
    for (const m of this.defaults.values()) m.dispose();
    this.defaults.clear();
    for (const b of this.bases.values()) b.base.dispose();
    this.bases.clear();
    this.defaultBase.dispose();
  }
}

/** @advanced */
export interface PickBufferOptions<L> {
  renderer: WebGPURenderer;
  scene: Scene;
  camera: PerspectiveCamera;
  /**
   * What a mesh stands for, or null when it is not pickable (sky, clouds,
   * backdrop...). Called once per object; the result is cached.
   */
  classify(object: Object3D): PickTarget<L> | null;
  /** Buffer size relative to the canvas drawing buffer (default 0.5). */
  scale?: number;
  /** Minimum time between two pick renders, ms (default 250). */
  interval?: number;
}

/**
 * Keeps a pick buffer of the current view. Call `update()` once per frame
 * after the main render; it re-renders (at most every `interval` ms) only
 * while lookups happened recently and the view or scene changed, and reads
 * the result back asynchronously. `lookup()` answers from the latest buffer
 * only while it is `fresh` (camera, size and scene signature unchanged since
 * it was rendered), else returns `undefined` so the caller casts a ray.
 *
 * @advanced Reached as `viewer.pickBuffer`; use `viewer.pick` / `pickAt` to pick.
 */
export class PickBuffer<L = unknown> {
  /** Turn GPU picking on or off (off: lookups always return undefined). */
  enabled = true;
  /** Lookups keep the buffer refreshing for this long, ms. */
  keepAliveMs = 3000;
  readonly materials = new PickMaterials();
  /** Pick renders, read backs, CPU time of the last pick render call (ms), read back latency (ms), objects drawn, lookups answered / not answered. */
  readonly stats = { renders: 0, readbacks: 0, lastRenderMs: 0, lastReadbackMs: 0, objects: 0, hits: 0, misses: 0 };
  private readonly renderer: WebGPURenderer;
  private readonly scene: Scene;
  private readonly camera: PerspectiveCamera;
  private readonly classify: (object: Object3D) => PickTarget<L> | null;
  private readonly scale: number;
  private readonly interval: number;
  private target: RenderTarget | null = null;
  private frame: PickFrame<L> | null = null;
  private readonly targets = new WeakMap<Object3D, PickTarget<L> | null>();
  private readonly current = new Float64Array(SIGNATURE_SIZE);
  private readonly rendered = new Float64Array(SIGNATURE_SIZE).fill(NaN);
  private ids = new Map<Object3D, number>();
  private pending = false;
  private lastRender = -Infinity;
  private lastQuery = -Infinity;
  private epoch = 0;
  private disposed = false;

  constructor(options: PickBufferOptions<L>) {
    this.renderer = options.renderer;
    this.scene = options.scene;
    this.camera = options.camera;
    this.classify = options.classify;
    this.scale = options.scale ?? 0.5;
    this.interval = options.interval ?? 250;
    this.materials.idOf = (o) => this.ids.get(o) ?? 0;
  }

  /**
   * Forces a refresh: something changed that the signature cannot see
   * (visibility, transforms). Takes effect at once: lookups in the same tick
   * already fall back to rays.
   */
  /** Video memory of the pick target in bytes: RGBA32Uint color (16 bytes per pixel) plus depth; 0 until the first pick renders it. */
  get gpuBytes(): number {
    return this.target ? this.target.width * this.target.height * (16 + 4) : 0;
  }

  invalidate(): void {
    this.epoch++;
    this.current[36] = this.epoch;
  }

  /**
   * Whether the latest buffer matches the current view and scene. The camera
   * and canvas size are compared live; the draw statistics are those of the
   * last `update()`.
   */
  get fresh(): boolean {
    if (this.frame === null) return false;
    this.writeView();
    return sameSignature(this.frame.signature, this.current);
  }

  /**
   * Call once per frame after the main render. `drawCalls` / `triangles` of
   * that render are part of the scene signature (tiles loading, objects
   * shown or hidden change them); `sceneKey` is any further number that
   * changes with the drawn geometry (the globe's `surfaceSignature`).
   */
  update(now: number, drawCalls: number, triangles: number, sceneKey = 0): void {
    if (this.disposed) return;
    this.writeSignature(drawCalls, triangles, sceneKey);
    if (!this.enabled || this.pending) return;
    if (now - this.lastQuery > this.keepAliveMs || now - this.lastRender < this.interval) return;
    if (sameSignature(this.rendered, this.current)) return;
    this.render(now);
  }

  /**
   * Pick under a point of the canvas (fractions 0..1 from the left / top).
   * `undefined`: no fresh buffer (cast a ray instead); `null`: nothing pickable there.
   */
  lookup(fx: number, fy: number): GpuPick<L> | null | undefined {
    this.lastQuery = performance.now();
    if (!this.enabled || !this.fresh) {
      this.stats.misses++;
      return undefined;
    }
    const r = this.frame!.sample(fx, fy);
    if (r === undefined) this.stats.misses++;
    else this.stats.hits++;
    return r;
  }

  private writeSignature(drawCalls: number, triangles: number, sceneKey: number): void {
    this.writeView();
    const s = this.current;
    s[34] = drawCalls;
    s[35] = triangles;
    s[36] = this.epoch;
    s[37] = sceneKey;
  }

  /** Camera pose, projection and canvas size into the current signature (the camera's world matrix is brought up to date). */
  private writeView(): void {
    const s = this.current;
    const cam = this.camera;
    cam.updateMatrixWorld();
    cam.matrixWorld.toArray(s, 0);
    cam.projectionMatrix.toArray(s, 16);
    const canvas = this.renderer.domElement;
    s[32] = canvas.width;
    s[33] = canvas.height;
  }

  private targetOf(object: Object3D): PickTarget<L> | null {
    let t = this.targets.get(object);
    if (t === undefined) {
      t = this.classify(object);
      this.targets.set(object, t);
    }
    return t;
  }

  private render(now: number): void {
    const r = this.renderer;
    const canvas = r.domElement;
    const w = Math.max(1, Math.ceil(canvas.width * this.scale));
    const h = Math.max(1, Math.ceil(canvas.height * this.scale));
    if (!this.target) {
      this.target = new RenderTarget(w, h, { type: UnsignedIntType, format: RGBAIntegerFormat, depthBuffer: true, generateMipmaps: false });
      this.target.texture.name = 'PickBuffer';
    } else if (this.target.width !== w || this.target.height !== h) this.target.setSize(w, h);

    const objects: (Object3D | null)[] = [null];
    const targets: (PickTarget<L> | null)[] = [null];
    const ids = new Map<Object3D, number>();
    this.ids = ids;
    const signature = Float64Array.from(this.current);
    const projectionInverse = this.camera.projectionMatrixInverse.toArray(new Float64Array(16));
    const cameraWorld = this.camera.matrixWorld.toArray(new Float64Array(16));

    // The sky background (a float shader) cannot draw into an integer target.
    const scene = this.scene as Scene & { backgroundNode: unknown; fogNode?: unknown };
    const saved = { background: scene.background, backgroundNode: scene.backgroundNode, fog: scene.fog, fogNode: scene.fogNode, environment: scene.environment };
    const clearColor = r.getClearColor(new Color());
    const clearAlpha = r.getClearAlpha();
    const previousTarget = r.getRenderTarget();
    const previousFunction = r.getRenderObjectFunction();
    scene.background = null;
    scene.backgroundNode = null;
    scene.fog = null;
    if ('fogNode' in scene) scene.fogNode = null;
    scene.environment = null;
    r.setClearColor(0x000000, 0);
    r.setRenderTarget(this.target);
    r.setRenderObjectFunction((object, sc, camera, geometry, material, group, lightsNode, clippingContext, passId) => {
      if (!(object as Mesh).isMesh) return;
      const target = this.targetOf(object);
      if (!target) return;
      let id = ids.get(object);
      if (id === undefined) {
        id = objects.length;
        objects.push(object);
        targets.push(target);
        ids.set(object, id);
      }
      r.renderObject(object, sc, camera as Camera, geometry, this.materials.forSource(material), group, lightsNode, clippingContext, passId);
    });
    const tRender = performance.now();
    try {
      r.render(this.scene, this.camera);
    } finally {
      this.stats.lastRenderMs = performance.now() - tRender;
      r.setRenderObjectFunction(previousFunction);
      r.setRenderTarget(previousTarget);
      r.setClearColor(clearColor, clearAlpha);
      scene.background = saved.background;
      scene.backgroundNode = saved.backgroundNode;
      scene.fog = saved.fog;
      if ('fogNode' in scene) scene.fogNode = saved.fogNode;
      scene.environment = saved.environment;
    }
    this.stats.renders++;
    this.stats.objects = objects.length - 1;
    this.lastRender = now;
    this.rendered.set(signature);
    this.pending = true;
    const t0 = performance.now();
    const rt = this.target;
    r.readRenderTargetPixelsAsync(rt, 0, 0, w, h)
      .then((pixels) => {
        if (this.disposed) return;
        this.frame = new PickFrame<L>(pixels as Uint32Array, w, h, objects, targets, projectionInverse, cameraWorld, signature);
        this.stats.readbacks++;
        this.stats.lastReadbackMs = performance.now() - t0;
      })
      .catch((err: Error) => {
        console.warn('[PickBuffer] read back failed:', err.message);
      })
      .finally(() => {
        this.pending = false;
      });
  }

  dispose(): void {
    this.disposed = true;
    this.frame = null;
    this.target?.dispose();
    this.target = null;
    this.materials.dispose();
  }
}

function sameSignature(a: Float64Array, b: Float64Array): boolean {
  for (let i = 0; i < SIGNATURE_SIZE; i++) if (a[i] !== b[i]) return false;
  return true;
}
