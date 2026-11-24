/**
 * Cloud shadows on what the sun lights (volumetric clouds, `atmosphere/VolumetricClouds`): a
 * map of the sunlight's transmittance through the cloud layer, orthographic along the sun's
 * rays around the camera, read by every receiver through `sunShadowFactor` (so it dims the
 * direct sun only, on the globe, 3D Tiles, buildings and the studio ground alike).
 *
 * - Map coordinates come from `(world → map) × object matrix`, taken per drawn object in
 *   float64 on the CPU (as the sun shadows do), so ECEF magnitudes never reach the GPU.
 * - The third map coordinate is the height above the ellipsoid (planar around the map's
 *   center): receivers inside or above the cloud layer get less or no shadow.
 * - The node's inputs are module-level uniforms shared by every viewer on the page: each
 *   viewer binds its own map (`bindCloudShadows`) before it renders, like the sun shadows'
 *   (docs/api.md §4). Nothing is sampled while no viewer has cloud shadows.
 */
import { DataTexture, LinearFilter, Matrix4, RGBAFormat, UnsignedByteType, type Object3D, type Texture } from 'three';
import { Fn, If, float, min, mix, positionLocal, smoothstep, texture, uniform, vec4 } from 'three/tsl';
import type { TSLNode } from '../core/tsl';

/** What a viewer binds before it renders (`bindCloudShadows`). */
export interface CloudShadowBinding {
  /** Transmittance map (red channel, 1 = full sun). */
  texture: Texture;
  /** World → (u, v, height above the ellipsoid in meters) of the map. */
  worldToMap: Matrix4;
  /** Share of the direct sun a fully shadowing cloud takes away, 0–1 (0: no shadows). */
  strength: number;
  /** Cloud layer, heights above the ellipsoid in meters. */
  bottom: number;
  top: number;
}

/** Share of the map along its border over which shadows fade out. */
const EDGE_FADE = 0.15;

const C = {
  strength: uniform(0),
  bottom: uniform(1500),
  top: uniform(4000),
};
const worldToMap = new Matrix4();
let mapNode: TSLNode = null;
let placeholder: DataTexture | null = null;
let shared: TSLNode = null;

/**
 * Sunlight that gets through the clouds to the shaded point, 0–1 (1 while no viewer has cloud
 * shadows, and outside the map). Part of `sunShadowFactor`; one node for every receiver.
 */
export function cloudShadowFactor(): TSLNode {
  if (shared) return shared;
  // A valid texture before any viewer binds its map (never sampled while the strength is 0).
  placeholder = new DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1, RGBAFormat, UnsignedByteType);
  placeholder.magFilter = LinearFilter;
  placeholder.minFilter = LinearFilter;
  placeholder.needsUpdate = true;
  placeholder.name = 'cloud shadow placeholder';
  mapNode = texture(placeholder);
  const objectToMap: TSLNode = (uniform(new Matrix4()) as TSLNode).onObjectUpdate(
    ({ object }: { object: Object3D | null }, self: { value: Matrix4 }) =>
      C.strength.value > 0 && object ? self.value.multiplyMatrices(worldToMap, object.matrixWorld) : self.value,
  );
  shared = Fn(() => {
    const lit = float(1).toVar();
    If(C.strength.greaterThan(0), () => {
      const p = objectToMap.mul(vec4(positionLocal, 1)).xyz.toVar();
      const border = min(min(p.x, p.y), min(p.x.oneMinus(), p.y.oneMinus()));
      const edge = smoothstep(0, EDGE_FADE, border);
      // Above the cloud base the column overhead holds less cloud; above the tops, none.
      const below = float(1).sub(smoothstep(C.bottom, C.top, p.z));
      // Explicit level: the branch depends on the fragment (border), not only on the uniform.
      const t = mapNode.sample(p.xy.clamp(0, 1)).level(0).r;
      lit.assign(mix(1, t, C.strength.mul(edge).mul(below)));
    });
    return lit;
  })();
  return shared;
}

/** Binds a viewer's cloud shadow map (null: none) before it renders. */
export function bindCloudShadows(binding: CloudShadowBinding | null): void {
  cloudShadowFactor();
  if (!binding || !(binding.strength > 0)) {
    C.strength.value = 0;
    return;
  }
  if (mapNode.value !== binding.texture) mapNode.value = binding.texture;
  worldToMap.copy(binding.worldToMap);
  C.strength.value = Math.min(1, binding.strength);
  C.bottom.value = binding.bottom;
  C.top.value = binding.top;
}
