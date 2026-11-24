/**
 * "Dim outside" look of a local scene (`outside: 'dim'`, docs/agents/local-scene.md
 * §4.6): a linear-stage post effect that darkens and desaturates every pixel
 * whose scene depth puts it outside the region, keeping the surroundings as
 * context. No material changes and no discard: the outside stays visible,
 * pickable and loaded.
 *
 * Each pixel's view position comes from the scene depth; `viewToRegion`
 * (worldToRegion × camera.matrixWorld, float64 on the CPU) takes it to the
 * region frame without ECEF magnitudes on the GPU.
 */
import { Matrix4, Vector2, Vector4, type PerspectiveCamera } from 'three';
import { dot, float, Fn, mix, perspectiveDepthToViewZ, screenUV, select, uniform, uniformArray, vec2, vec3, vec4 } from 'three/tsl';
import type { TSLNode } from '../core/tsl';
import type { PostEffect, PostFrame, PostInputs } from '../post/PostPipeline';
import { MAX_REGION_VERTICES, type ResolvedRegion } from '../region/region';
import { regionDistanceNode, writeRing } from '../region/regionMask';

/** Brightness kept outside the region at full dimming. */
const DIM = 0.32;
/** Share of the color replaced by its luminance outside the region. */
const DESATURATE = 0.65;

export class RegionDimEffect implements PostEffect {
  readonly name = 'local-scene-dim';
  readonly stage = 'linear' as const;
  /** Before other linear effects (glow), so highlights outside stay bright. */
  readonly order = -100;
  readonly graphVersion = 0;
  /** 0..1, animated by the local scene. */
  amount = 0;
  private region: ResolvedRegion | null = null;
  private readonly viewToRegion = uniform(new Matrix4());
  private readonly params = uniform(new Vector4());
  private readonly ring = Array.from({ length: MAX_REGION_VERTICES + 1 }, () => new Vector2());
  private readonly vertices = uniformArray(this.ring, 'vec2');
  /** (near, far, 1 / P00, 1 / P11) of the camera. */
  private readonly lens = uniform(new Vector4(1, 2, 1, 1));
  private readonly strength = uniform(0);
  private readonly reversed = uniform(1);

  get active(): boolean {
    return this.region !== null && this.amount > 0.001;
  }

  setRegion(region: ResolvedRegion | null): void {
    this.region = region;
  }

  prepare(frame: PostFrame): void {
    const r = this.region;
    if (!r) return;
    const cam: PerspectiveCamera = frame.camera;
    this.viewToRegion.value.multiplyMatrices(r.worldToRegion, cam.matrixWorld);
    const p = cam.projectionMatrix.elements;
    this.lens.value.set(cam.near, cam.far, 1 / p[0], 1 / p[5]);
    const n = r.kind === 'polygon' ? writeRing(r.vertices, this.ring) : 0;
    this.params.value.set(r.kind === 'circle' ? 1 : 2, r.radius, n, 0);
    this.strength.value = this.amount;
    this.reversed.value = (frame.renderer as unknown as { reversedDepthBuffer?: boolean }).reversedDepthBuffer ? 1 : 0;
  }

  build(input: TSLNode, inputs: PostInputs): TSLNode {
    return Fn(() => {
      const depth: TSLNode = inputs.sceneDepth.sample(screenUV).x;
      // Sky (cleared depth) is not part of the outside ground.
      const sky: TSLNode = select(this.reversed.greaterThan(0.5), depth.lessThanEqual(0), depth.greaterThanEqual(1));
      const z: TSLNode = perspectiveDepthToViewZ(depth, this.lens.x, this.lens.y);
      const ndc: TSLNode = vec2(screenUV.x.mul(2).sub(1), float(1).sub(screenUV.y.mul(2)));
      const view: TSLNode = vec3(ndc.x.mul(z.negate()).mul(this.lens.z), ndc.y.mul(z.negate()).mul(this.lens.w), z);
      const p: TSLNode = this.viewToRegion.mul(vec4(view, 1)).xy;
      const inside: TSLNode = regionDistanceNode(p, this.params, this.vertices).greaterThanEqual(0);
      const color: TSLNode = input.rgb;
      const luma: TSLNode = dot(color, vec3(0.2126, 0.7152, 0.0722));
      const dimmed: TSLNode = mix(color, vec3(luma), DESATURATE).mul(DIM);
      const k: TSLNode = select(inside.or(sky), float(0), this.strength);
      return vec4(mix(color, dimmed, k), input.a);
    })();
  }

  dispose(): void {
    this.region = null;
  }
}
