/**
 * The local scene clip mask (docs/agents/local-scene.md §4.3): a TSL
 * `maskNode` that keeps fragments inside the region prism, shared by globe
 * tiles, 3D Tiles and pick materials so they share pipelines.
 *
 * Precision: the region frame of a fragment is `modelToRegion × positionLocal`,
 * with `modelToRegion = worldToRegion × matrixWorld` multiplied on the CPU in
 * float64 for every draw (`onObjectUpdate`). Its translation is only the
 * distance from the mesh's origin to the region center, so float32 is exact to
 * millimeters; no ECEF coordinate reaches the shader.
 *
 * Several viewers: the node graph is shared by the page, the region is looked
 * up per renderer (one per viewer) when a render or a draw starts. Renderers
 * without a local scene get `keepOutside = 1`, so their mask always passes.
 */
import { Matrix4, Vector2, Vector4, type Object3D } from 'three';
import { bool, float, Fn, fwidth, If, int, Loop, positionLocal, renderGroup, screenCoordinate, uniform, uniformArray, vec4 } from 'three/tsl';
import type { TSLNode } from '../atmosphere/AtmosphereNodes';
import { MAX_REGION_VERTICES } from './region';

/** What the clip shader of one renderer tests. */
export interface RegionGpuState {
  /** ECEF → region frame (float64). */
  readonly worldToRegion: Matrix4;
  /** 'circle': |xy| ≤ radius; 'polygon': even-odd test against `vertices`. */
  kind: 'circle' | 'polygon';
  radius: number;
  /** Polygon vertices in the region frame (x0, y0, ...), at most `MAX_REGION_VERTICES`. */
  vertices: Float64Array;
  /**
   * Share of the outside still drawn, 0..1 (screen-door dither): 1 while entering starts, 0 once
   * only the region is drawn.
   */
  keepOutside: number;
}

const states = new WeakMap<object, RegionGpuState>();

/** Sets (or clears) the region a renderer clips to. */
export function setRegionGpuState(renderer: object, state: RegionGpuState | null): void {
  if (state) states.set(renderer, state);
  else states.delete(renderer);
}

interface FrameLike {
  renderer: object | null;
  object: Object3D | null;
}

function stateOf(frame: FrameLike): RegionGpuState | undefined {
  return frame.renderer ? states.get(frame.renderer) : undefined;
}

let mask: TSLNode | null = null;
const variants = new WeakSet<object>();

/** 4x4 Bayer threshold in (0, 1) per pixel (same pattern as the 3D Tiles LOD fade). */
export function bayerThreshold(): TSLNode {
  const v: TSLNode = (screenCoordinate.xy as TSLNode).mod(4).floor();
  const bayer2 = (p: TSLNode): TSLNode => p.y.mul(3).add(p.x.mul(2)).mod(4);
  const bayer4: TSLNode = bayer2(v.mod(2)).mul(4).add(bayer2(v.mod(4).mul(0.5).floor()));
  return bayer4.add(0.5).div(float(16));
}

/**
 * Signed distance (meters) from a region-frame XY point to the region boundary, positive inside:
 * `params` = (kind: 0 none / 1 circle / 2 polygon, radius, vertex count, unused), `vertices` = a
 * closed ring (vertex n repeats vertex 0) in a `vec2` uniform array. Even-odd rule for polygons.
 * Without a region (kind 0) a large positive number.
 */
export function regionDistanceNode(point: TSLNode, params: TSLNode, vertices: TSLNode): TSLNode {
  return Fn(() => {
    const p: TSLNode = point.toVar();
    const result: TSLNode = float(1e9).toVar();
    If(params.x.equal(1), () => {
      result.assign(params.y.sub(p.length()));
    }).ElseIf(params.x.equal(2), () => {
      const crossings: TSLNode = bool(false).toVar();
      const nearest: TSLNode = float(1e18).toVar();
      Loop({ start: int(0), end: int(params.z) }, ({ i }: { i: TSLNode }) => {
        const a: TSLNode = vertices.element(i);
        const b: TSLNode = vertices.element(i.add(1));
        const straddles: TSLNode = a.y.greaterThan(p.y).notEqual(b.y.greaterThan(p.y));
        const xCross: TSLNode = b.x.sub(a.x).mul(p.y.sub(a.y)).div(b.y.sub(a.y)).add(a.x);
        If(straddles.and(p.x.lessThan(xCross)), () => {
          crossings.assign(crossings.not());
        });
        // Squared distance to the edge.
        const ab: TSLNode = b.sub(a);
        const t: TSLNode = p.sub(a).dot(ab).div(ab.dot(ab).max(1e-12)).clamp(0, 1);
        const d: TSLNode = p.sub(a.add(ab.mul(t)));
        nearest.assign(nearest.min(d.dot(d)));
      });
      const dist: TSLNode = nearest.sqrt();
      result.assign(crossings.select(dist, dist.negate()));
    });
    return result;
  })();
}

/** Copies a region's polygon into a closed ring of `Vector2` (length `MAX_REGION_VERTICES + 1`). */
export function writeRing(vertices: Float64Array, ring: Vector2[]): number {
  const n = Math.min(MAX_REGION_VERTICES, vertices.length / 2);
  for (let i = 0; i <= n; i++) {
    const k = i % n;
    ring[i].set(vertices[k * 2], vertices[k * 2 + 1]);
  }
  return n;
}

/**
 * The shared region clip mask: true inside the region of the renderer that draws, and on the
 * dithered share of the outside still shown. Assign it as `material.maskNode` (only where a
 * mesh crosses the boundary: a mask disables early depth testing).
 */
export function regionMaskNode(): TSLNode {
  if (mask) return mask;
  const modelToRegion: TSLNode = uniform(new Matrix4()).onObjectUpdate((frame: FrameLike, self: { value: Matrix4 }) => {
    const s = stateOf(frame);
    if (s && frame.object) self.value.multiplyMatrices(s.worldToRegion, frame.object.matrixWorld);
    return undefined;
  });
  // (kind: 0 none / 1 circle / 2 polygon, radius, vertex count, keepOutside)
  const params: TSLNode = uniform(new Vector4(0, 0, 0, 1))
    .setGroup(renderGroup)
    .onRenderUpdate((frame: FrameLike, self: { value: Vector4 }) => {
      const s = stateOf(frame);
      if (!s) self.value.set(0, 0, 0, 1);
      else self.value.set(s.kind === 'circle' ? 1 : 2, s.radius, s.kind === 'polygon' ? s.vertices.length / 2 : 0, s.keepOutside);
      return undefined;
    });
  // The ring is closed (vertex n repeats vertex 0), so edge i is (i, i + 1).
  const ring = Array.from({ length: MAX_REGION_VERTICES + 1 }, () => new Vector2());
  const vertices: TSLNode = uniformArray(ring, 'vec2')
    .setGroup(renderGroup)
    .onRenderUpdate((frame: FrameLike, self: { array: unknown[] }) => {
      const s = stateOf(frame);
      if (!s || s.kind !== 'polygon') return undefined;
      writeRing(s.vertices, self.array as Vector2[]);
      return undefined;
    });

  const p: TSLNode = modelToRegion.mul(vec4(positionLocal, 1)).xy;
  // Keep a fragment only when the boundary is farther than half its pixel's footprint: with MSAA a
  // pixel is kept or discarded as a whole, and the samples it covers beyond the boundary would be
  // drawn too. On surfaces facing the camera that is under half a pixel; on a vertical surface
  // seen edge-on (a tile skirt crossing the boundary) one pixel spans tens of meters, which then
  // showed through the walls as dotted lines. Derivatives stay in uniform control flow.
  const footprint: TSLNode = fwidth(p).length().mul(0.5);
  const inside: TSLNode = regionDistanceNode(p, params, vertices).greaterThan(footprint);
  mask = inside.or(bayerThreshold().lessThan(params.w));
  variants.add(mask);
  return mask;
}

/** Records a mask node that includes the region mask (e.g. combined with the 3D Tiles fade). */
export function registerRegionMaskVariant(node: TSLNode): void {
  variants.add(node);
}

/** Whether a material's `maskNode` clips to the region (the pick buffer copies the clip). */
export function hasRegionMask(material: { maskNode?: TSLNode | null }): boolean {
  const m = material.maskNode;
  return !!m && variants.has(m);
}
