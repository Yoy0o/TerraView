/**
 * Walls around a local scene region (docs/agents/local-scene.md §4.4): a band
 * from the drawn surface down to a common base along the region boundary, so
 * the cut-out area reads as a solid block of ground (a sandbox). The geometry
 * lies on the region prism itself, so it meets the clipped surface edge without
 * overlapping it.
 *
 * Two looks: `solid` (soil gradient with strata lines, a bright top edge, lit
 * by a key light so sides facing different ways differ), and `hidden`: drawn
 * before other opaque geometry into depth only, which leaves the background
 * where the walls are (a floating patch, like three-geo) while still hiding
 * tile skirts and the underside of the terrain seen through the cut.
 *
 * Vertices are in the region frame (meters from the region center, float32 is
 * plenty); the mesh matrix is the region frame.
 */
import { BufferAttribute, BufferGeometry, Color, FrontSide, Mesh, Vector3, type Matrix4 } from 'three';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import { abs, attribute, clamp, dot, float, fract, fwidth, max, mix, normalize, normalWorld, smoothstep, uniform } from 'three/tsl';
import type { TSLNode } from '../atmosphere/AtmosphereNodes';
import { bayerThreshold } from './regionMask';

/** Default soil color at the top of the walls (sRGB). */
export const WALL_COLOR = 0x8c6b4f;
const EDGE_COLOR = 0xe8eef6;
/** Deeper soil is this much darker. */
const DEEP_FACTOR = 0.42;

/** One sample of the boundary: region-frame position and heights. */
export interface WallColumns {
  /** Region-frame XY of each column (x0, y0, x1, y1, ...), a closed loop. */
  xy: Float64Array;
  /** Region-frame z of the top of each column (the surface). */
  top: Float32Array;
  /** Region-frame z of the bottom of each column (the base). */
  bottom: Float32Array;
  /** Ellipsoidal height of the top of each column (strata lines follow absolute height). */
  topHeight: Float32Array;
  /** Ellipsoidal height of the base (meters). */
  baseHeight: number;
}

export class RegionWalls {
  readonly mesh: Mesh;
  /** World direction of the light that shades the walls. */
  readonly keyLight = uniform(new Vector3(0, 0, 1));
  /** 0..1: share of the wall pixels drawn (dithered reveal while entering or leaving). */
  readonly reveal = uniform(1);
  private readonly topColor = uniform(new Color(WALL_COLOR));
  private readonly edge = uniform(1);
  /** Typical wall depth (meters): the soil gradient spans it. */
  private readonly depthScale = uniform(100);
  private readonly material: MeshBasicNodeMaterial;
  private readonly revealMask: TSLNode;
  private solid = true;

  constructor() {
    const m = new MeshBasicNodeMaterial();
    m.name = 'RegionWalls';
    m.side = FrontSide;
    const depth: TSLNode = attribute('wallDepth', 'float');
    const height: TSLNode = attribute('wallHeight', 'float');
    const t: TSLNode = smoothstep(0, this.depthScale, depth);
    let c: TSLNode = mix(this.topColor, this.topColor.mul(DEEP_FACTOR), t);
    // Strata: a faint line every few meters of absolute height, gone where they get dense on screen.
    const spacing: TSLNode = max(this.depthScale.div(6), float(2));
    const s: TSLNode = height.div(spacing);
    const w: TSLNode = max(fwidth(s), float(1e-4));
    const line: TSLNode = float(1).sub(smoothstep(0, 1.2, abs(fract(s.sub(0.5)).sub(0.5)).div(w)));
    const dense: TSLNode = smoothstep(0.15, 0.4, w);
    c = mix(c, c.mul(0.72), line.mul(float(1).sub(dense)).mul(0.6));
    // Key light plus a soft fill, so the four sides of a block read differently.
    const ndl: TSLNode = max(dot(normalize(normalWorld), this.keyLight), 0);
    c = c.mul(ndl.mul(0.5).add(0.62));
    // Bright top edge, about 1.5 px wide at any distance.
    const e: TSLNode = depth.div(max(fwidth(depth), float(1e-4)));
    const edge: TSLNode = float(1).sub(smoothstep(1, 2, e)).mul(this.edge);
    m.colorNode = mix(c, uniform(new Color(EDGE_COLOR)), clamp(edge, 0, 1).mul(0.85));
    this.material = m;
    this.revealMask = bayerThreshold().lessThan(this.reveal);

    this.mesh = new Mesh(new BufferGeometry(), m);
    this.mesh.name = 'RegionWalls';
    this.mesh.matrixAutoUpdate = false;
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
  }

  /** Solid walls, or depth-only ones (the floating look). */
  setSolid(solid: boolean): void {
    if (solid === this.solid) return;
    this.solid = solid;
    const m = this.material;
    m.colorWrite = solid;
    // Depth-only walls must be in the depth buffer before the tiles they hide are drawn.
    this.mesh.renderOrder = solid ? 0 : -10;
    m.needsUpdate = true;
  }

  get isSolid(): boolean {
    return this.solid;
  }

  setStyle(color: Color | number | string, edge: boolean): void {
    this.topColor.value.set(color);
    this.edge.value = edge ? 1 : 0;
  }

  /** Sets the reveal (0..1); the dither mask is attached only while partly revealed (a mask costs early-Z). */
  setReveal(v: number): void {
    this.reveal.value = v;
    const want = v < 1 ? this.revealMask : null;
    if (this.material.maskNode !== want) {
      this.material.maskNode = want;
      this.material.needsUpdate = true;
    }
  }

  /** Places the walls in a region frame (ECEF matrix). */
  setFrame(regionToWorld: Matrix4): void {
    this.mesh.matrix.copy(regionToWorld);
    this.mesh.matrixWorld.copy(regionToWorld);
    this.mesh.matrixWorldNeedsUpdate = false;
  }

  /** Rebuilds the geometry from boundary columns (see `buildWallGeometry`). */
  setColumns(columns: WallColumns): void {
    const old = this.mesh.geometry;
    this.mesh.geometry = buildWallGeometry(columns);
    old.dispose();
    let depth = 0;
    const n = columns.top.length;
    for (let i = 0; i < n; i++) depth += columns.top[i] - columns.bottom[i];
    this.depthScale.value = Math.max(10, n > 0 ? depth / n : 100);
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.mesh.removeFromParent();
  }
}

/**
 * Wall geometry: one flat-shaded quad per boundary segment, facing out of the region (the
 * loop may run either way). Attributes: `position`, `normal` (region frame), `wallDepth`
 * (meters below the top) and `wallHeight` (ellipsoidal meters).
 */
export function buildWallGeometry(c: WallColumns): BufferGeometry {
  const n = c.top.length;
  const g = new BufferGeometry();
  if (n < 3) return g;
  // Signed area: counter-clockwise loops have the outside on the right of each edge.
  let area = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) area += c.xy[j * 2] * c.xy[i * 2 + 1] - c.xy[i * 2] * c.xy[j * 2 + 1];
  const order = (k: number) => (area >= 0 ? k : n - 1 - k);
  const pos = new Float32Array(n * 4 * 3);
  const nor = new Float32Array(n * 4 * 3);
  const depth = new Float32Array(n * 4);
  const height = new Float32Array(n * 4);
  const index = new Uint32Array(n * 6);
  for (let k = 0; k < n; k++) {
    const a = order(k);
    const b = order((k + 1) % n);
    const ax = c.xy[a * 2];
    const ay = c.xy[a * 2 + 1];
    const bx = c.xy[b * 2];
    const by = c.xy[b * 2 + 1];
    const len = Math.hypot(bx - ax, by - ay) || 1;
    const nx = (by - ay) / len;
    const ny = -(bx - ax) / len;
    // top a, bottom a, bottom b, top b
    const v = [
      [ax, ay, c.top[a], 0, c.topHeight[a]],
      [ax, ay, c.bottom[a], c.top[a] - c.bottom[a], c.baseHeight],
      [bx, by, c.bottom[b], c.top[b] - c.bottom[b], c.baseHeight],
      [bx, by, c.top[b], 0, c.topHeight[b]],
    ];
    for (let q = 0; q < 4; q++) {
      const o = k * 4 + q;
      pos[o * 3] = v[q][0];
      pos[o * 3 + 1] = v[q][1];
      pos[o * 3 + 2] = v[q][2];
      nor[o * 3] = nx;
      nor[o * 3 + 1] = ny;
      depth[o] = v[q][3];
      height[o] = v[q][4];
    }
    const o = k * 4;
    index.set([o, o + 1, o + 2, o, o + 2, o + 3], k * 6);
  }
  g.setAttribute('position', new BufferAttribute(pos, 3));
  g.setAttribute('normal', new BufferAttribute(nor, 3));
  g.setAttribute('wallDepth', new BufferAttribute(depth, 1));
  g.setAttribute('wallHeight', new BufferAttribute(height, 1));
  g.setIndex(new BufferAttribute(index, 1));
  g.computeBoundingSphere();
  return g;
}
