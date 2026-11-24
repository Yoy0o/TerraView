/**
 * 3DTilesRendererJS plugin that keeps a tileset inside a local scene region
 * (docs/agents/local-scene.md §4.2): tiles whose bounding volume misses the
 * region prism are neither traversed nor loaded. Tiles that touch it are left
 * to the camera's own error and frustum tests: answering for them would make
 * the library treat every tile in the region as visible (its region plugins
 * load what they cover regardless of the camera), see
 * `TilesRendererBase.calculateTileViewErrorWithPlugin`.
 */
import { Sphere, type Object3D } from 'three';
import { RegionRelation, type ResolvedRegion } from '../region/region';

interface BoundingVolume {
  getSphere(target: Sphere): void;
}

interface ViewErrorTarget {
  inView: boolean;
  error: number;
  distance: number;
}

const _sphere = new Sphere();

export class RegionMaskPlugin {
  readonly name = 'TV_REGION_MASK_PLUGIN';
  /** Region to keep, or null for no masking. */
  region: ResolvedRegion | null = null;
  private group: Object3D | null = null;

  init(tiles: { group: Object3D }): void {
    this.group = tiles.group;
  }

  calculateTileViewError(tile: { engineData?: { boundingVolume?: BoundingVolume } }, target: ViewErrorTarget): boolean {
    const region = this.region;
    const volume = tile.engineData?.boundingVolume;
    if (!region || !volume || !this.group) return false;
    volume.getSphere(_sphere);
    _sphere.applyMatrix4(this.group.matrixWorld);
    if (region.relateSphere(_sphere.center, _sphere.radius) !== RegionRelation.OUTSIDE) return false;
    target.inView = false;
    target.error = 0;
    target.distance = Infinity;
    return true;
  }

  dispose(): void {
    this.region = null;
    this.group = null;
  }
}
