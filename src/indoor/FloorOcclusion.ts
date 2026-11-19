/**
 * Floor ambient occlusion (M3.4): a soft darkening of the floor along walls
 * and under furniture, and of the walls just above the floor, baked once per
 * floor instead of computed per frame.
 *
 * Bake (GPU, a few milliseconds when a floor is first shown or its content
 * changed): everything standing on the floor (walls, columns, devices, the
 * floor model) is drawn from above with an orthographic camera into a
 * coverage mask. The camera clips at `height` above the floor; a closed solid
 * cut there shows its inside, whose faces point away from the camera, so
 * "back face, or front face above floor level" marks the solid parts even
 * where the tops are clipped away. Floor surfaces (front faces at floor
 * level) do not count. Two separable filters turn the mask into occlusion:
 * a Gaussian-weighted maximum (contact: falls off with the distance to the
 * nearest occluder, so a 14 cm wall darkens its base as much as a cabinet)
 * and a Gaussian average (soft: grows with how much stands around, darker
 * in corners and under furniture). The result is read back once into an R8
 * data texture covering the floor's bounds.
 *
 * Shading: floor surfaces, walls and floor-model meshes share one `colorNode`
 * that multiplies the diffuse color by `1 - intensity · occlusion · weight`.
 * Upward faces at floor level take the full weight; vertical faces sample
 * the floor just in front of them, fading out with height; everything else
 * is untouched. Per-floor values (texture, bounds, intensity) are material
 * properties read with `materialReference`, the floor-local transform of each
 * mesh is a per-object uniform, so every receiver shares one shader build.
 *
 * Roles of meshes (`mesh.userData.aoRole`): 'floor' receives only (slabs, room
 * floors), 'occluder' casts only (windows, devices), anything else on a floor
 * does both; batched devices cast through their instances.
 */
import {
  DataTexture,
  DoubleSide,
  InstancedMesh,
  LinearFilter,
  Matrix4,
  Mesh,
  NoBlending,
  OrthographicCamera,
  RedFormat,
  RenderTarget,
  Scene,
  Texture,
  UnsignedByteType,
  Vector2,
  Vector4,
  Box3,
  type BufferGeometry,
  type Material,
  type Object3D,
} from 'three';
import {
  abs,
  clamp,
  Discard,
  float,
  Fn,
  frontFacing,
  If,
  materialColor,
  materialReference,
  max,
  min,
  normalLocal,
  normalize,
  positionLocal,
  positionWorld,
  select,
  smoothstep,
  texture,
  uniform,
  uv,
  vec4,
} from 'three/tsl';
import { MeshBasicNodeMaterial, NodeMaterial, QuadMesh, type WebGPURenderer } from 'three/webgpu';
import type { TSLNode } from '../atmosphere/AtmosphereNodes';
import type { BimEntity } from './BimEntity';

/** Floor ambient occlusion settings (`indoor.ambientOcclusion`). Lengths in meters. */
export interface FloorOcclusionOptions {
  /** Bake and apply floor AO (default true). Off removes it from every floor and frees the textures. */
  enabled?: boolean;
  /** How dark fully occluded floor gets, 0..1 (default 0.6). Applies at once, no re-bake. */
  intensity?: number;
  /** Reach of the darkening, meters (default 0.9): σ of the soft part; the contact part falls off over half of it. */
  radius?: number;
  /** What stands on the floor: geometry between 5 cm and this height above it casts AO, meters (default 1.8). */
  height?: number;
  /** Target texel size of the bake, meters (default 0.08). */
  texelSize?: number;
  /** Texels along the longer side of a floor at most (default by GPU tier: 512 / 1024 / 1024 / 2048). */
  maxResolution?: number;
}

export const FLOOR_OCCLUSION_DEFAULTS = {
  enabled: true,
  intensity: 0.6,
  radius: 0.9,
  height: 1.8,
  texelSize: 0.08,
  maxResolution: 1024,
} as const satisfies Required<FloorOcclusionOptions>;

/** Front faces below this height (meters above the floor) are floor surfaces, not occluders. */
export const FLOOR_LEVEL = 0.05;
/** Geometry lower than this below the floor (slab undersides) is cut away by the bake camera. */
const BELOW_FLOOR = 0.015;
/** Occlusion right next to an occluder (the contact term's share). */
export const CONTACT_WEIGHT = 0.6;
/** Gain of the soft (averaged) term: fully surrounded ground reaches full occlusion with the contact term. */
export const SOFT_GAIN = 0.8;
/** The contact term's σ is half the radius, but at most this many texels (its taps must not skip a thin wall). */
const CONTACT_MAX_TEXELS = 5;
/** Upward faces higher than this above the floor get no AO (desk tops, window sills). */
const FLOOR_FADE: readonly [number, number] = [0.1, 0.35];

// -----------------------------------------------------------------------------
// Pure rules (unit-tested)

/** Floor-local area a floor's AO texture covers, and its size in texels. */
export interface OcclusionGrid {
  /** Lower-left corner, floor-local meters. */
  x0: number;
  y0: number;
  /** Extent, meters. */
  width: number;
  height: number;
  cols: number;
  rows: number;
}

/**
 * Texture area for content within [minX, maxX] × [minY, maxY] (floor-local
 * meters): grown by `margin` on every side so the blur fades out inside the
 * texture, `texel` meters per texel unless the longer side would exceed
 * `maxResolution` texels. Null for empty or invalid bounds.
 */
export function occlusionGrid(minX: number, minY: number, maxX: number, maxY: number, margin: number, texel: number, maxResolution: number): OcclusionGrid | null {
  if (![minX, minY, maxX, maxY].every(Number.isFinite) || maxX < minX || maxY < minY) return null;
  const x0 = minX - margin;
  const y0 = minY - margin;
  const width = Math.max(maxX - minX + 2 * margin, 1e-3);
  const height = Math.max(maxY - minY + 2 * margin, 1e-3);
  const size = Math.max(texel, Math.max(width, height) / Math.max(1, maxResolution));
  return { x0, y0, width, height, cols: Math.max(4, Math.ceil(width / size)), rows: Math.max(4, Math.ceil(height / size)) };
}

/** Taps of each blur direction (odd: one in the middle). */
export const BLUR_TAPS = 25;
/** The taps span ±3 σ. */
const BLUR_SPAN_SIGMAS = 3;

/**
 * Gaussian weights of the filter taps, 1 in the middle (the contact term's
 * weighted maximum). Taps sit at fixed multiples of σ (±`BLUR_SPAN_SIGMAS`),
 * so the weights do not depend on σ: one shader serves every floor and
 * radius, only the step between taps changes.
 */
export function falloffWeights(taps = BLUR_TAPS): number[] {
  const half = (taps - 1) / 2;
  const w: number[] = [];
  for (let k = -half; k <= half; k++) {
    const x = (k / half) * BLUR_SPAN_SIGMAS;
    w.push(Math.exp(-0.5 * x * x));
  }
  return w;
}

/** The same weights normalized to sum 1 (the soft term's average). */
export function blurWeights(taps = BLUR_TAPS): number[] {
  const w = falloffWeights(taps);
  const sum = w.reduce((a, b) => a + b, 0);
  return w.map((v) => v / sum);
}

/** Occlusion from the contact term (weighted maximum, 0..1) and the soft term (average, 0..1). */
export function combineOcclusion(contact: number, soft: number): number {
  return Math.min(1, CONTACT_WEIGHT * contact + SOFT_GAIN * soft);
}

/** σ of the contact term, meters: half the radius, at most `CONTACT_MAX_TEXELS` texels. */
export function contactSigma(radius: number, texel: number): number {
  return Math.min(radius / 2, CONTACT_MAX_TEXELS * texel);
}

/** Step between blur taps in texture coordinates for a σ in meters over an extent of `span` meters. */
export function blurStep(sigma: number, span: number, taps = BLUR_TAPS): number {
  const half = (taps - 1) / 2;
  return (sigma * BLUR_SPAN_SIGMAS) / half / span;
}

/**
 * How much of the baked occlusion a surface point takes (the shader's rule):
 * `z` is its height above the floor (m), `nz` the up component of its unit
 * normal, `fade` the height over which walls fade out (m).
 */
export function occlusionWeight(z: number, nz: number, fade: number): number {
  const up = Math.min(Math.max(nz, 0), 1);
  const side = 1 - Math.abs(nz);
  const onFloor = up * (1 - smooth(FLOOR_FADE[0], FLOOR_FADE[1], z));
  const onWall = side * (1 - smooth(0, fade, z));
  return Math.max(onFloor, onWall);
}

/** Diffuse factor for an occlusion value (0..1) taken with a weight at an intensity. */
export function occlusionFactor(occlusion: number, weight: number, intensity: number): number {
  return 1 - intensity * occlusion * weight;
}

/** Normalized options with defaults (numbers out of range are clamped, non-numbers ignored). */
export function resolveOcclusionOptions(o: FloorOcclusionOptions, base: Required<FloorOcclusionOptions>): Required<FloorOcclusionOptions> {
  const num = (v: unknown, fallback: number, lo: number, hi: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback);
  return {
    enabled: typeof o.enabled === 'boolean' ? o.enabled : base.enabled,
    intensity: num(o.intensity, base.intensity, 0, 1),
    radius: num(o.radius, base.radius, 0.05, 10),
    height: num(o.height, base.height, 0.2, 10),
    texelSize: num(o.texelSize, base.texelSize, 0.01, 2),
    maxResolution: Math.round(num(o.maxResolution, base.maxResolution, 16, 4096)),
  };
}

function smooth(e0: number, e1: number, x: number): number {
  const t = Math.min(Math.max((x - e0) / (e1 - e0), 0), 1);
  return t * t * (3 - 2 * t);
}

// -----------------------------------------------------------------------------
// What a floor contains

/** Role of a mesh in the floor AO (`mesh.userData.aoRole`). */
export type OcclusionRole = 'floor' | 'occluder' | 'both';

/** Something drawn into the bake: a geometry with its floor-local matrix. */
interface Occluder {
  geometry: BufferGeometry;
  matrix: Matrix4;
}

/** Floor-local placement of an object (float64 on the CPU: small numbers even for ECEF scenes). */
function floorLocal(floorInverse: Matrix4, object: Object3D, out = new Matrix4()): Matrix4 {
  return out.multiplyMatrices(floorInverse, object.matrixWorld);
}

/**
 * Calls `visit` for every mesh of a floor that is shown (entities hidden by
 * user code are skipped; contribution culling does not count as hidden),
 * with the entity it belongs to. Batched device meshes are skipped: their
 * instances are reported through `visitInstance`.
 */
function forEachFloorMesh(floor: BimEntity, visit: (mesh: Mesh, owner: BimEntity) => void, visitInstance?: (geometry: BufferGeometry, matrix: Matrix4) => void): void {
  const walk = (e: BimEntity) => {
    if (e !== floor && !e.group.visible) return;
    const stack: Object3D[] = [...e.group.children];
    while (stack.length) {
      const o = stack.pop()!;
      const owner = o.userData.entity as BimEntity | undefined;
      // Child entities are walked from the entity tree; batches through their instances.
      if (owner && owner.group === o && owner !== e) continue;
      if (o.userData.pooled) continue;
      const mesh = o as Mesh;
      if (mesh.isMesh) {
        if (mesh.visible || e.culled) visit(mesh, e);
      } else if (!o.visible) continue;
      stack.push(...o.children);
    }
    if (visitInstance) for (const i of e.instances) i.floorDrawable?.(visitInstance);
    for (const c of e.children) walk(c);
  };
  walk(floor);
}

function roleOf(mesh: Mesh, owner: BimEntity): OcclusionRole {
  const role = mesh.userData.aoRole as OcclusionRole | undefined;
  if (role) return role;
  return owner.type === 'thing' ? 'occluder' : 'both';
}

// -----------------------------------------------------------------------------
// Receiving materials

/** Material properties the shared AO color node reads. */
interface OcclusionMaterial extends NodeMaterial {
  floorAoMap: Texture;
  /** (x0, y0, 1 / width, 1 / height) of the texture's floor-local area. */
  floorAoBounds: Vector4;
  /** (intensity, wall fade height, normal offset, 0). */
  floorAoParams: Vector4;
}

const IDENTITY = new Matrix4();
let sharedColorNode: TSLNode = null;

/** `materialReference` to a texture with a binding of its own (see `TileMaterial.textureReference`). */
function textureReference(property: string): TSLNode {
  const ref: TSLNode = materialReference(property, 'texture');
  const setNodeType = ref.setNodeType.bind(ref);
  ref.setNodeType = (type: string) => {
    setNodeType(type);
    ref.node.getUniformHash = () => `floorAo.${property}`;
  };
  return ref;
}

/** The diffuse color with floor AO applied; one node for every receiving material. */
function occlusionColorNode(): TSLNode {
  if (sharedColorNode) return sharedColorNode;
  // Floor-local frame of the drawn object (set per mesh when AO is applied; identity otherwise).
  const floorFromObject: TSLNode = (uniform(new Matrix4()) as TSLNode).onObjectUpdate(
    ({ object }: { object: Object3D | null }) => (object?.userData.floorAoMatrix as Matrix4 | undefined) ?? IDENTITY,
  );
  const bounds: TSLNode = materialReference('floorAoBounds', 'vec4');
  const params: TSLNode = materialReference('floorAoParams', 'vec4');
  const map: TSLNode = textureReference('floorAoMap');
  sharedColorNode = Fn(() => {
    const p: TSLNode = floorFromObject.mul(vec4(positionLocal, 1)).xyz.toVar();
    const n0: TSLNode = normalize(floorFromObject.mul(vec4(normalLocal, 0)).xyz);
    const n: TSLNode = select(frontFacing, n0, n0.negate()).toVar();
    // Vertical faces read the floor just in front of them.
    const at = p.xy.add(n.xy.mul(params.z)).sub(bounds.xy).mul(bounds.zw);
    // Sampled unconditionally: texture fetches stay in uniform control flow.
    const occlusion = map.context({ getUV: () => at }).r;
    const up = clamp(n.z, 0, 1);
    const side = float(1).sub(abs(n.z));
    const onFloor = up.mul(float(1).sub(smoothstep(FLOOR_FADE[0], FLOOR_FADE[1], p.z)));
    const onWall = side.mul(float(1).sub(smoothstep(0, params.y, p.z)));
    const factor = float(1).sub(params.x.mul(occlusion).mul(max(onFloor, onWall)));
    // The material's color (times its map when it has one; vec3 without, read as alpha 1).
    const base: TSLNode = vec4(materialColor as TSLNode);
    return vec4(base.rgb.mul(factor), base.a);
  })();
  return sharedColorNode;
}

/** Whether a material can take the AO node (a node material without a color node of its own). */
function canReceive(m: Material): m is OcclusionMaterial {
  const n = m as NodeMaterial;
  return n.isNodeMaterial === true && (n.colorNode === null || n.colorNode === sharedColorNode) && !(n as { nodeMaterial?: unknown }).nodeMaterial;
}

function materialsOf(mesh: Mesh): Material[] {
  return Array.isArray(mesh.material) ? mesh.material : [mesh.material];
}

// -----------------------------------------------------------------------------
// Bake

/** A floor's baked occlusion. */
export interface BakedOcclusion {
  /**
   * Occlusion per texel (R8, 0..255). Row 0 is the floor's -y edge and column 0 its -x edge, on
   * every backend: a plain data texture, so no render-target row order or flip applies.
   */
  readonly texture: DataTexture;
  readonly grid: OcclusionGrid;
  /** GPU bytes of the texture. */
  readonly bytes: number;
}

/**
 * Occlusion values of a read-back RGBA8 bake as R8 rows from the floor's -y edge up. `topDown`:
 * the read-back's first row is the top of the rendered picture (WebGPU); WebGL reads from the
 * bottom.
 */
export function occlusionRows(pixels: ArrayLike<number>, cols: number, rows: number, topDown: boolean, stride = 4): Uint8Array {
  const out = new Uint8Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    const src = (topDown ? rows - 1 - r : r) * cols * stride;
    const dst = r * cols;
    for (let c = 0; c < cols; c++) out[dst + c] = pixels[src + c * stride];
  }
  return out;
}

const _inv = new Matrix4();
const _box = new Box3();
const _bounds = new Box3();

/**
 * Bakes floor AO textures on the GPU (top-down coverage mask, then two
 * separable blurs), read back once into a data texture. One per viewer;
 * scene objects are created per bake and dropped after it, so nothing of a
 * floor stays referenced here.
 */
export class FloorOcclusionBaker implements OcclusionBaker {
  private readonly scene = new Scene();
  private readonly camera = new OrthographicCamera();
  private readonly occluderMaterial = new MeshBasicNodeMaterial();
  /** What the blur reads when no bake is running (holds no floor's texture). */
  private readonly placeholder = new Texture();
  private readonly source = texture(this.placeholder);
  private readonly stepContact = uniform(new Vector2());
  private readonly stepSoft = uniform(new Vector2());
  private readonly horizontal: QuadMesh;
  private readonly vertical: QuadMesh;
  /** Read-back rows start at the top of the rendered picture (WebGPU), not at the bottom (WebGL). */
  private readonly topDown: boolean;

  constructor(private readonly renderer: WebGPURenderer) {
    this.topDown = (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend === true;
    const m = this.occluderMaterial;
    m.name = 'FloorOcclusionMask';
    m.side = DoubleSide;
    m.depthTest = false;
    m.depthWrite = false;
    m.blending = NoBlending;
    m.fog = false;
    m.lights = false;
    m.toneMapped = false;
    // The bake scene is in floor-local meters: world z is the height above the floor.
    m.fragmentNode = Fn(() => {
      If(frontFacing.and(positionWorld.z.lessThan(FLOOR_LEVEL)), () => {
        Discard();
      });
      return vec4(1, 1, 1, 1);
    })();
    const peak = falloffWeights();
    const weights = blurWeights();
    const half = (weights.length - 1) / 2;
    const blur = (sample: (offsetContact: TSLNode, offsetSoft: TSLNode) => [TSLNode, TSLNode], combine: (contact: TSLNode, soft: TSLNode) => TSLNode) => {
      const q = new NodeMaterial();
      q.name = 'FloorOcclusionBlur';
      q.blending = NoBlending;
      q.depthTest = false;
      q.depthWrite = false;
      q.fragmentNode = Fn(() => {
        let contact: TSLNode = float(0);
        let soft: TSLNode = float(0);
        for (let k = -half; k <= half; k++) {
          const [c, s] = sample(this.stepContact.mul(k), this.stepSoft.mul(k));
          contact = max(contact, c.mul(peak[k + half]));
          soft = soft.add(s.mul(weights[k + half]));
        }
        return combine(contact, soft);
      })();
      return new QuadMesh(q);
    };
    // Horizontal: the mask filtered into r (contact: weighted maximum) and g (soft: average).
    this.horizontal = blur(
      (oc, os) => [this.source.sample(uv().add(oc)).r, this.source.sample(uv().add(os)).r],
      (c, s) => vec4(c, s, 0, 1),
    );
    // Vertical: each filter continued (both are separable), then combined into the occlusion.
    this.vertical = blur(
      (oc, os) => [this.source.sample(uv().add(oc)).r, this.source.sample(uv().add(os)).g],
      (c, s) => vec4(min(c.mul(CONTACT_WEIGHT).add(s.mul(SOFT_GAIN)), 1), 0, 0, 1),
    );
  }

  /**
   * Bakes the AO of a shown floor. The GPU work is issued at once; the promise settles when the
   * result is read back (a frame or two later), with null when the floor has nothing to bake
   * (no receivers, no occluders, empty bounds).
   */
  async bake(floor: BimEntity, options: Required<FloorOcclusionOptions>): Promise<BakedOcclusion | null> {
    floor.group.updateWorldMatrix(true, true);
    _inv.copy(floor.group.matrixWorld).invert();
    const occluders: Occluder[] = [];
    let receivers = 0;
    _bounds.makeEmpty();
    const extend = (geometry: BufferGeometry, matrix: Matrix4) => {
      if (!geometry.boundingBox) geometry.computeBoundingBox();
      _bounds.union(_box.copy(geometry.boundingBox!).applyMatrix4(matrix));
    };
    forEachFloorMesh(
      floor,
      (mesh, owner) => {
        const role = roleOf(mesh, owner);
        const matrix = floorLocal(_inv, mesh);
        extend(mesh.geometry, matrix);
        if (role !== 'occluder') receivers++;
        if (role !== 'floor') occluders.push({ geometry: mesh.geometry, matrix });
      },
      (geometry, matrix) => {
        extend(geometry, matrix);
        occluders.push({ geometry, matrix: matrix.clone() });
      },
    );
    if (receivers === 0 || occluders.length === 0 || _bounds.isEmpty()) return null;
    const grid = occlusionGrid(_bounds.min.x, _bounds.min.y, _bounds.max.x, _bounds.max.y, options.radius * 2, options.texelSize, options.maxResolution);
    if (!grid) return null;

    // Scene: occluders in floor-local space, instanced per geometry.
    const byGeometry = new Map<BufferGeometry, Matrix4[]>();
    for (const o of occluders) {
      const list = byGeometry.get(o.geometry) ?? [];
      list.push(o.matrix);
      byGeometry.set(o.geometry, list);
    }
    const drawn: Mesh[] = [];
    for (const [geometry, matrices] of byGeometry) {
      let mesh: Mesh;
      if (matrices.length === 1) {
        mesh = new Mesh(geometry, this.occluderMaterial);
        mesh.matrixAutoUpdate = false;
        mesh.matrix.copy(matrices[0]);
      } else {
        const inst = new InstancedMesh(geometry, this.occluderMaterial, matrices.length);
        matrices.forEach((m, i) => inst.setMatrixAt(i, m));
        inst.matrixAutoUpdate = false;
        mesh = inst;
      }
      mesh.frustumCulled = false;
      this.scene.add(mesh);
      drawn.push(mesh);
    }
    this.scene.updateMatrixWorld(true);

    // Camera straight down from `height`, keeping what lies between just below the floor and there.
    const cam = this.camera;
    cam.left = grid.x0;
    cam.right = grid.x0 + grid.width;
    cam.bottom = grid.y0;
    cam.top = grid.y0 + grid.height;
    cam.near = 0;
    cam.far = options.height + BELOW_FLOOR;
    cam.position.set(0, 0, options.height);
    cam.quaternion.identity();
    cam.updateMatrixWorld(true);
    cam.updateProjectionMatrix();

    const make = () =>
      new RenderTarget(grid.cols, grid.rows, { type: UnsignedByteType, depthBuffer: false, minFilter: LinearFilter, magFilter: LinearFilter, generateMipmaps: false });
    const mask = make();
    const pass = make();
    const result = make();

    const r = this.renderer;
    const prevTarget = r.getRenderTarget();
    const prevAutoClear = r.autoClear;
    r.autoClear = true;
    try {
      r.setRenderTarget(mask);
      r.render(this.scene, cam);
      const sigmaContact = contactSigma(options.radius, grid.width / grid.cols);
      this.source.value = mask.texture;
      this.stepContact.value.set(blurStep(sigmaContact, grid.width), 0);
      this.stepSoft.value.set(blurStep(options.radius, grid.width), 0);
      r.setRenderTarget(pass);
      this.horizontal.render(r);
      this.source.value = pass.texture;
      this.stepContact.value.set(0, blurStep(sigmaContact, grid.height));
      this.stepSoft.value.set(0, blurStep(options.radius, grid.height));
      r.setRenderTarget(result);
      this.vertical.render(r);
    } catch (err) {
      result.dispose();
      throw err;
    } finally {
      r.setRenderTarget(prevTarget);
      r.autoClear = prevAutoClear;
      for (const mesh of drawn) {
        mesh.removeFromParent();
        if ((mesh as InstancedMesh).isInstancedMesh) (mesh as InstancedMesh).dispose();
      }
      this.source.value = this.placeholder;
      mask.dispose();
      pass.dispose();
    }
    try {
      const pixels = (await r.readRenderTargetPixelsAsync(result, 0, 0, grid.cols, grid.rows)) as Uint8Array;
      const stride = pixels.length / (grid.cols * grid.rows);
      const data = occlusionRows(pixels, grid.cols, grid.rows, this.topDown, stride);
      const tex = new DataTexture(data, grid.cols, grid.rows, RedFormat, UnsignedByteType);
      tex.name = `FloorAO ${floor.id}`;
      tex.minFilter = LinearFilter;
      tex.magFilter = LinearFilter;
      tex.generateMipmaps = false;
      // Rows of R8 data are not 4-byte aligned for most widths.
      tex.unpackAlignment = 1;
      tex.needsUpdate = true;
      return { texture: tex, grid, bytes: grid.cols * grid.rows };
    } finally {
      result.dispose();
    }
  }

  dispose(): void {
    this.occluderMaterial.dispose();
    (this.horizontal.material as Material).dispose();
    (this.vertical.material as Material).dispose();
    this.placeholder.dispose();
  }
}

// -----------------------------------------------------------------------------
// Per floor state and scheduling

interface FloorState {
  baked: BakedOcclusion | null;
  /** Content version (`contentVersion(floor)`) and options version of the bake; -1 = never baked. */
  content: number;
  options: number;
  /** Content version seen last, and the clock (ms) when it was seen to change: re-baking waits for it to settle. */
  seen: number;
  changedAt: number;
  /** Receiving materials the AO is applied to (to take it off again). */
  materials: Set<OcclusionMaterial>;
}

/** What the scheduler reads of a building (`Building` implements it). */
export interface OcclusionSource {
  readonly floors: readonly BimEntity[];
  /** Increases whenever what stands on the floor changes (models, devices moved or shown / hidden). */
  contentVersion(floor: BimEntity): number;
}

/** What bakes the textures (`FloorOcclusionBaker`; tests pass a stand-in). */
export interface OcclusionBaker {
  bake(floor: BimEntity, options: Required<FloorOcclusionOptions>): Promise<BakedOcclusion | null>;
  dispose(): void;
}

/** Content changes settle this long (ms) before a shown floor is baked again (devices being dragged). */
export const REBAKE_SETTLE_MS = 250;

/**
 * Floor AO of every building of a viewer (`indoor.ambientOcclusion`): bakes
 * shown floors whose content or settings changed, one at a time, and applies
 * the result to their receiving materials. Hidden floors keep their texture.
 */
export class FloorOcclusion {
  private opts: Required<FloorOcclusionOptions>;
  private optionsVersion = 0;
  private readonly states = new Map<BimEntity, FloorState>();
  /** A bake waiting for its read-back; no other starts meanwhile. */
  private inFlight = false;
  /** Increases when everything is cleared: bakes started before then are dropped. */
  private generation = 0;

  /**
   * @param baker Bakes the textures (null: nothing is baked, e.g. without a renderer).
   * @param changed Called when the picture changed (a floor got its AO, settings applied).
   * @param defaults Settings before `configure` (the viewer passes the GPU tier's `maxResolution`).
   */
  constructor(
    private readonly baker: OcclusionBaker | null,
    private readonly changed: () => void,
    defaults: FloorOcclusionOptions = {},
  ) {
    this.opts = resolveOcclusionOptions(defaults, FLOOR_OCCLUSION_DEFAULTS);
  }

  /** Current settings. */
  get options(): Readonly<Required<FloorOcclusionOptions>> {
    return this.opts;
  }

  get enabled(): boolean {
    return this.opts.enabled;
  }

  set enabled(v: boolean) {
    this.configure({ enabled: v });
  }

  /** Changes settings (only the given fields). Intensity applies at once; the others re-bake shown floors. */
  configure(options: FloorOcclusionOptions): void {
    const next = resolveOcclusionOptions(options, this.opts);
    const prev = this.opts;
    this.opts = next;
    if (!next.enabled) {
      if (prev.enabled) this.clear();
      return;
    }
    if (next.radius !== prev.radius || next.height !== prev.height || next.texelSize !== prev.texelSize || next.maxResolution !== prev.maxResolution) {
      this.optionsVersion++;
    }
    if (next.intensity !== prev.intensity) {
      for (const s of this.states.values()) for (const m of s.materials) m.floorAoParams.x = next.intensity;
    }
    this.changed();
  }

  /** GPU bytes of the baked textures (one byte per texel). */
  get bytes(): number {
    let b = 0;
    for (const s of this.states.values()) b += s.baked?.bytes ?? 0;
    return b;
  }

  /** Number of floors with a baked texture. */
  get bakedFloors(): number {
    let n = 0;
    for (const s of this.states.values()) if (s.baked) n++;
    return n;
  }

  /** The bake of a floor, or null (diagnostics, tests). */
  bakedFor(floor: BimEntity): BakedOcclusion | null {
    return this.states.get(floor)?.baked ?? null;
  }

  /**
   * @internal Starts baking one shown floor that needs it (not while another bake is
   * being read back). `clock` is a millisecond clock. Returns true when a
   * bake started; its result is applied when it arrives (`changed` is called).
   */
  update(sources: readonly OcclusionSource[], clock: number): boolean {
    if (!this.opts.enabled || !this.baker || this.inFlight) return false;
    for (const b of sources) {
      for (const floor of b.floors) {
        if (!floor.effectivelyVisible) continue;
        const content = b.contentVersion(floor);
        let s = this.states.get(floor);
        if (!s) {
          s = { baked: null, content: -1, options: -1, seen: content, changedAt: -Infinity, materials: new Set() };
          this.states.set(floor, s);
        }
        if (s.seen !== content) {
          s.seen = content;
          s.changedAt = clock;
        }
        if (s.content === content && s.options === this.optionsVersion) continue;
        // A first bake (and one for new settings) goes at once; content changes wait until they settle.
        if (s.content !== -1 && s.content !== content && clock - s.changedAt < REBAKE_SETTLE_MS) continue;
        this.startBake(floor, s, content);
        return true;
      }
    }
    return false;
  }

  /** @internal Whether a shown floor waits for its first bake or a re-bake, or a bake is being read back. */
  pending(sources: readonly OcclusionSource[]): boolean {
    if (!this.opts.enabled || !this.baker) return false;
    if (this.inFlight) return true;
    for (const b of sources) {
      for (const floor of b.floors) {
        if (!floor.effectivelyVisible) continue;
        const s = this.states.get(floor);
        if (!s || s.content !== b.contentVersion(floor) || s.options !== this.optionsVersion) return true;
      }
    }
    return false;
  }

  private startBake(floor: BimEntity, s: FloorState, content: number): void {
    const generation = this.generation;
    const options = this.optionsVersion;
    // Marked as baked for these versions now: a failure is not retried every frame.
    s.content = content;
    s.options = options;
    this.inFlight = true;
    let job: Promise<BakedOcclusion | null>;
    try {
      job = this.baker!.bake(floor, this.opts);
    } catch (err) {
      job = Promise.reject(err);
    }
    job.then(
      (baked) => {
        this.inFlight = false;
        // Cleared, disabled or the building removed while reading back: nothing to apply it to.
        if (generation !== this.generation || this.states.get(floor) !== s) {
          baked?.texture.dispose();
          return;
        }
        const previous = s.baked;
        const before = s.materials;
        s.materials = baked ? this.apply(floor, baked) : new Set();
        // Materials that no longer receive (meshes gone or now occluders only) lose the node.
        for (const m of before) if (!s.materials.has(m)) removeNode(m);
        previous?.texture.dispose();
        s.baked = baked;
        this.changed();
      },
      (err: Error) => {
        this.inFlight = false;
        // A read-back cut short by clearing or disposing the viewer is not a failure worth reporting.
        if (generation === this.generation) console.warn(`[FloorOcclusion] bake of ${floor.id} failed:`, err?.message ?? err);
      },
    );
  }

  /** Puts a floor's texture on its receiving materials; returns them. */
  private apply(floor: BimEntity, baked: BakedOcclusion): Set<OcclusionMaterial> {
    const { grid } = baked;
    const node = occlusionColorNode();
    const out = new Set<OcclusionMaterial>();
    floor.group.updateWorldMatrix(true, true);
    _inv.copy(floor.group.matrixWorld).invert();
    forEachFloorMesh(floor, (mesh, owner) => {
      if (roleOf(mesh, owner) === 'occluder') return;
      mesh.userData.floorAoMatrix = floorLocal(_inv, mesh, (mesh.userData.floorAoMatrix as Matrix4 | undefined) ?? new Matrix4());
      for (const m of materialsOf(mesh)) {
        if (!canReceive(m)) continue;
        m.floorAoMap = baked.texture;
        m.floorAoBounds = new Vector4(grid.x0, grid.y0, 1 / grid.width, 1 / grid.height);
        m.floorAoParams = new Vector4(this.opts.intensity, this.opts.radius, Math.min(0.15, this.opts.radius / 4), 0);
        // Re-bakes keep the node: only the texture and numbers change, the material is not rebuilt.
        if (m.colorNode !== node) {
          m.colorNode = node;
          m.needsUpdate = true;
        }
        out.add(m);
      }
    });
    return out;
  }

  /** @internal Forgets the floors of a removed building (their materials are disposed with it). */
  forget(building: OcclusionSource): void {
    for (const f of building.floors) {
      const s = this.states.get(f);
      if (!s) continue;
      s.baked?.texture.dispose();
      this.states.delete(f);
    }
  }

  /** Removes the AO from every floor and frees the textures. */
  clear(): void {
    this.generation++;
    for (const s of this.states.values()) {
      for (const m of s.materials) removeNode(m);
      s.baked?.texture.dispose();
    }
    this.states.clear();
    this.changed();
  }

  /** @internal */
  dispose(): void {
    this.generation++;
    for (const s of this.states.values()) s.baked?.texture.dispose();
    this.states.clear();
    this.baker?.dispose();
  }
}

function removeNode(m: OcclusionMaterial): void {
  if (sharedColorNode && m.colorNode === sharedColorNode) {
    m.colorNode = null;
    m.needsUpdate = true;
  }
}
