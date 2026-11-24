/**
 * Picking of a viewer: what lies under a pixel or along a view ray (buildings, 3D Tiles, the
 * globe; GPU pick buffer first, CPU rays otherwise), 3D Tiles features and GeoJSON features
 * under the cursor, and the surface camera gestures grab (with the reference ground when no
 * globe is drawn).
 */
import { Raycaster, Vector2, Vector3, type Object3D, type PerspectiveCamera, type Ray } from 'three';
import type { WebGPURenderer } from 'three/webgpu';
import { cartographic, type Cartographic, type Ellipsoid } from '../core/Ellipsoid';
import { DEG2RAD } from '../core/math';
import type { Globe } from '../globe/Globe';
import type { IndoorManager } from '../indoor/IndoorManager';
import type { LocalScene } from '../local/LocalScene';
import type { Tiles3DLayer } from '../tiles3d/Tiles3DLayer';
import { resolveTileFeature, type TileFeature } from '../tiles3d/tileFeatures';
import type { GeoJsonLayer } from '../vector/GeoJsonLayer';
import { lonLatToMerc } from '../vector/geometry';
import type { LabelManager } from '../vector/LabelManager';
import type { FeatureHit } from '../vector/types';
import type { VectorService } from '../vector/VectorService';
import type { PickInfo } from './InteractionManager';
import type { PickBuffer, PickTarget } from './PickBuffer';
import type { SurfaceHeightQuery } from './SurfaceHeight';
import type { FeaturePick, SurfacePick } from './viewerTypes';
import { enteredBuilding, type ViewerState } from './viewerState';

/** What picking reads of its viewer. */
export interface PickingHost {
  readonly state: ViewerState;
  readonly renderer: WebGPURenderer;
  readonly camera: PerspectiveCamera;
  readonly ellipsoid: Ellipsoid;
  readonly globe: Globe;
  readonly indoor: IndoorManager;
  readonly localScene: LocalScene;
  readonly pickBuffer: PickBuffer<Tiles3DLayer> | null;
  readonly tilesets: readonly Tiles3DLayer[];
  readonly vectorLayers: readonly GeoJsonLayer[];
  readonly vectors: VectorService;
  readonly labels: LabelManager;
  /** Ground heights (`viewer.surfaceHeight`), for the reference ground. */
  readonly surface: SurfaceHeightQuery;
}

const EARTH_CIRCUMFERENCE = 2 * Math.PI * 6378137;

const _ndc = new Vector2();
const _carto = cartographic();

export class ViewerPicking {
  private readonly raycaster = new Raycaster();
  /** Ellipsoidal height of the last 3D Tiles surface a gesture picked (reference ground without the globe). */
  private lastSurfaceHeight = 0;

  constructor(private readonly viewer: PickingHost) {}

  /** Closest surface hit (buildings, 3D Tiles or globe) at normalized device coordinates. */
  pick(ndc: Vector2, options: { buffer?: boolean } = {}): SurfacePick | null {
    if (options.buffer) {
      const g = this.pickFromBuffer(ndc);
      if (g !== undefined) return g;
    }
    this.viewer.camera.updateMatrixWorld();
    this.raycaster.setFromCamera(ndc, this.viewer.camera);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (this.raycaster as any).firstHitOnly = true;
    let best: SurfacePick | null = null;
    // A local scene hiding its surroundings: what is clipped away cannot be hit either.
    const ls = this.viewer.localScene;
    const accept = ls.hidesOutside ? (p: Vector3) => ls.showsWorld(p) : undefined;
    const entity = this.viewer.indoor.pick(this.raycaster);
    if (entity) best = { point: entity.point.clone(), source: 'entity', distance: entity.distance, entity: entity.entity, via: 'ray' };
    // All hits, not just the first: the first may be clipped away.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (accept) (this.raycaster as any).firstHitOnly = false;
    for (const layer of this.viewer.tilesets) {
      if (!layer.active || !layer.ready) continue;
      const hit = this.raycaster.intersectObject(layer.group, true).find((h) => !accept || accept(h.point));
      if (hit && hit.distance < (best?.distance ?? Infinity)) {
        best = { point: hit.point.clone(), source: 'tiles', distance: hit.distance, tileset: layer, via: 'ray' };
      }
    }
    if (this.viewer.state.showGlobe) {
      const g = this.viewer.globe.raycast(this.raycaster.ray, accept);
      if (g && g.distance < (best?.distance ?? Infinity)) best = { point: g.point, source: 'globe', distance: g.distance, via: 'ray' };
    }
    return best;
  }

  /**
   * Pick from the GPU pick buffer; undefined when it cannot answer (no fresh
   * buffer, or a sample it cannot resolve), so the caller casts a ray.
   */
  private pickFromBuffer(ndc: Vector2): SurfacePick | null | undefined {
    const hit = this.viewer.pickBuffer?.lookup((ndc.x + 1) / 2, (1 - ndc.y) / 2);
    if (hit === undefined) return undefined;
    if (hit === null) return null;
    const base = { point: hit.point, distance: hit.distance, normal: hit.normal, via: 'buffer' as const };
    if (hit.target.kind === 'entity') {
      const entity = this.viewer.indoor.entityForHit(hit.object, hit.instanceId);
      return entity ? { ...base, source: 'entity', entity } : undefined;
    }
    if (hit.target.kind === 'tiles') return { ...base, source: 'tiles', tileset: hit.target.layer };
    return { ...base, source: 'globe' };
  }

  /** What a mesh stands for in the pick buffer: buildings, 3D Tiles and globe tiles; nothing else is pickable. */
  classifyPick(object: Object3D): PickTarget<Tiles3DLayer> | null {
    for (let x: Object3D | null = object; x; x = x.parent) {
      if (x === this.viewer.indoor.root) return { kind: 'entity' };
      if (x === this.viewer.globe.group) return { kind: 'globe' };
      const layer = this.viewer.tilesets.find((l) => l.group === x);
      if (layer) return { kind: 'tiles', layer };
    }
    return null;
  }

  /** What lies under a client-space pixel (used by the interaction manager). */
  pickAt(clientX: number, clientY: number): PickInfo {
    const rect = this.viewer.renderer.domElement.getBoundingClientRect();
    _ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    const hit = this.pick(_ndc, { buffer: true });
    const layer = hit?.source === 'tiles' ? (hit.tileset ?? null) : null;
    // Resolved on demand from the view ray of this pick: hovers that never ask cost no CPU ray.
    let feature: TileFeature | null | undefined = layer ? undefined : null;
    const ray = layer ? this.viewRay(_ndc).clone() : null;
    return {
      kind: hit ? hit.source : 'none',
      entity: hit?.entity ?? null,
      tileset: hit?.tileset ?? null,
      point: hit?.point ?? null,
      cartographic: hit ? this.viewer.ellipsoid.cartesianToCartographic(hit.point) : null,
      clientX,
      clientY,
      marker: null,
      tileFeature: () => (feature === undefined ? (feature = this.tileFeatureOnRay(ray!, layer!)) : feature),
    };
  }

  /** `viewer.pickTileFeature`. */
  pickTileFeature(clientX: number, clientY: number): TileFeature | null {
    return this.pickAt(clientX, clientY).tileFeature?.() ?? null;
  }

  /** The camera ray through normalized device coordinates (the shared raycaster's ray). */
  private viewRay(ndc: Vector2): Ray {
    this.viewer.camera.updateMatrixWorld();
    this.raycaster.setFromCamera(ndc, this.viewer.camera);
    return this.raycaster.ray;
  }

  /** First hit of a ray on a layer's tiles, resolved to a feature. */
  private tileFeatureOnRay(ray: Ray, layer: Tiles3DLayer): TileFeature | null {
    if (!layer.active || !layer.ready || !this.viewer.tilesets.includes(layer)) return null;
    this.raycaster.ray.copy(ray);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (this.raycaster as any).firstHitOnly = true;
    const hit = this.raycaster.intersectObject(layer.group, true)[0];
    return hit ? resolveTileFeature(layer, hit) : null;
  }

  /** Cartographic position (radians) under a client-space pixel. */
  pickCartographic(clientX: number, clientY: number): Cartographic | null {
    const rect = this.viewer.renderer.domElement.getBoundingClientRect();
    _ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    const hit = this.pick(_ndc, { buffer: true });
    return hit ? this.viewer.ellipsoid.cartesianToCartographic(hit.point) : null;
  }

  /** Surface under a gesture: the scene, else the reference ground when no globe is drawn. */
  gesturePick(ndc: Vector2): Vector3 | null {
    const hit = this.pick(ndc);
    // In a local scene, empty space is handled by the camera bounds (region center, reference ground).
    if (this.viewer.localScene.hidesOutside) return hit?.point ?? null;
    if (hit) {
      if (hit.source === 'tiles' && !this.viewer.state.showGlobe) this.lastSurfaceHeight = this.viewer.ellipsoid.cartesianToCartographic(hit.point, _carto)?.height ?? this.lastSurfaceHeight;
      return hit.point;
    }
    return this.pickReferenceSurface(ndc);
  }

  /** `viewer.pickReferenceSurface`: the ground a gesture grabs when no globe is drawn. */
  pickReferenceSurface(ndc: Vector2): Vector3 | null {
    if (this.viewer.state.showGlobe) return null;
    const c = this.viewer.ellipsoid.cartesianToCartographic(this.viewer.camera.position, _carto);
    if (!c) return null;
    let height = enteredBuilding(this.viewer.indoor)?.groundHeight;
    if (height === undefined) {
      const s = this.viewer.surface.query(c.longitude, c.latitude);
      height = s.reliable ? s.height : this.lastSurfaceHeight;
    }
    if (c.height <= height) return null;
    this.viewer.camera.updateMatrixWorld();
    this.raycaster.setFromCamera(ndc, this.viewer.camera);
    const t = this.viewer.ellipsoid.intersectRay(this.raycaster.ray, height);
    return t === null ? null : this.raycaster.ray.at(t, new Vector3());
  }

  /** `viewer.pickFeature`: labels first, then draped geometry at the picked ground position. */
  async pickFeature(clientX: number, clientY: number): Promise<FeaturePick | null> {
    if (this.viewer.vectorLayers.length === 0) return null;
    const rect = this.viewer.renderer.domElement.getBoundingClientRect();
    let hit: FeatureHit | null = null;
    let position: Cartographic | null = null;
    const label = this.viewer.labels.hitTest(clientX - rect.left, clientY - rect.top);
    if (label) hit = await this.viewer.vectors.getFeature(label.layerId, label.featureId);
    if (!hit) {
      _ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
      const p = this.pick(_ndc, { buffer: true });
      if (!p) return null;
      position = this.viewer.ellipsoid.cartesianToCartographic(p.point);
      if (!position) return null;
      const [u, v] = lonLatToMerc(position.longitude / DEG2RAD, position.latitude / DEG2RAD);
      const sse = rect.height / (2 * Math.tan((this.viewer.camera.getEffectiveFOV() * DEG2RAD) / 2));
      const metersPerPx = this.viewer.camera.position.distanceTo(p.point) / sse;
      const pixelSize = metersPerPx / (EARTH_CIRCUMFERENCE * Math.max(Math.cos(position.latitude), 0.01));
      hit = await this.viewer.vectors.query(u, v, pixelSize, 5);
    }
    if (!hit) return null;
    const layer = this.viewer.vectorLayers.find((l) => l.id === hit.layerId);
    return layer ? { hit, layer, position } : null;
  }
}
