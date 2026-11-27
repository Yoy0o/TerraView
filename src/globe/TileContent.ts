/**
 * What loaded content does to the globe's tiles (docs/agents/tile-loading.md §2): applying
 * geometry, imagery and overlay as they arrive; which imagery a tile shows (its own or a
 * magnified ancestor) and when it switches (levels merged, siblings revealed together); the
 * imagery cross-fades; and the terrain morphs that keep the ground from jumping when a mesh
 * or the level of detail changes.
 */
import { BufferAttribute, BufferGeometry, Mesh, Vector3, Vector4, type Group } from 'three';
import type { GlobeTile, SharedTexture } from './GlobeTile';
import { MORPH_ATTRIBUTE } from './TileMaterial';
import type { TileOverlaySource } from './overlay';
import type { TerrainSource } from './terrain/TerrainSource';
import { morphDeltas, tileVertexCount } from './tileMeshLayout';
import { childUvTransform, imagerySwitchDue, selectionIn, TileSelection } from './tileSelection';
import type { BuiltTile } from './workerProtocol';

/** What tile content reads of its globe (the globe passes itself). */
export interface ContentHost {
  readonly group: Group;
  /** Frame counter and `performance.now()` of the current update. */
  readonly frame: number;
  readonly now: number;
  readonly imageryGen: number;
  readonly geometryGen: number;
  readonly terrain: TerrainSource | null;
  readonly segments: number;
  readonly overlaySource: TileOverlaySource | null;
  /** Tiles holding content (the cache), and textures shown while there is none. */
  readonly loaded: Set<GlobeTile>;
  readonly placeholder: SharedTexture;
  readonly emptyOverlay: SharedTexture;
  readonly wireframe: boolean;
  readonly fadeDuration: number;
  readonly morphDuration: number;
  childHeightRange(tile: GlobeTile): [number, number];
  disposeFills(tile: GlobeTile): void;
}

const _prevTransform = new Vector4();

export class TileContent {
  /** Tiles cross-fading to new imagery, and tiles morphing to a new mesh. */
  readonly fading = new Set<GlobeTile>();
  readonly morphing = new Set<GlobeTile>();

  constructor(private readonly globe: ContentHost) {}

  applyOverlay(tile: GlobeTile, texture: SharedTexture | null, version: number): void {
    tile.ownOverlay?.release();
    tile.ownOverlay = texture ? texture.acquire() : null;
    tile.overlayGen = version;
    this.resolveOverlay(tile);
    this.trackLoaded(tile);
  }

  /** Own overlay, or while it is being refreshed, the closest ancestor's (magnified). */
  resolveOverlay(tile: GlobeTile): void {
    const source = this.globe.overlaySource;
    let src: GlobeTile | null = null;
    if (source) {
      if (tile.ownOverlay) {
        src = tile;
      } else if (tile.overlayGen !== source.version) {
        src = tile.parent;
        while (src && !src.ownOverlay) src = src.parent;
      }
    }
    const shared = src?.ownOverlay ?? this.globe.emptyOverlay;
    if (tile.overlay !== shared) {
      shared.acquire();
      tile.overlay?.release();
      tile.overlay = shared;
    }
    const material = tile.material;
    material.overlayMap = shared.texture;
    if (src && src !== tile) {
      const dz = tile.level - src.level;
      const scale = 1 / 2 ** dz;
      material.overlayTransform.set((tile.x - src.x * 2 ** dz) * scale, (tile.y - src.y * 2 ** dz) * scale, scale, scale);
    } else {
      material.overlayTransform.set(0, 0, 1, 1);
    }
  }

  applyImagery(tile: GlobeTile, texture: SharedTexture | null, gen: number): void {
    tile.ownImagery?.release();
    tile.ownImagery = texture ? texture.acquire() : null;
    tile.imageryGen = gen;
    // Applied before this frame's traversal. On screen: the render loop reveals it (with its
    // siblings, cross-faded). Off screen: show it directly.
    if (tile.lastRenderedFrame !== this.globe.frame - 1) this.resolveImagery(tile, false);
    this.trackLoaded(tile);
  }

  /**
   * A tile that was not on screen last frame takes over from its parent (zooming
   * in) or its descendants (zooming out). It starts with the best imagery at
   * once: fading in from whatever it showed when it was last drawn would flash
   * an outdated, often much coarser picture. When it replaces its parent with
   * sharper imagery (e.g. cached from an earlier visit), it fades in from the
   * parent's picture so refinement does not pop.
   */
  showNewTile(tile: GlobeTile): void {
    if (tile.fadeFrom) this.endFade(tile);
    this.resolveImagery(tile, false);
    const before = this.shownAncestor(tile);
    this.morphFromPrevious(tile, before);
    const from = before?.imagery;
    if (!before || !from || from === tile.imagery || this.globe.fadeDuration <= 0) return;
    // The part of the ancestor's picture that covered this tile.
    const p = before.material.imageryTransform;
    let t: [number, number, number, number] = [p.x, p.y, p.z, p.w];
    for (let dz = tile.level - before.level - 1; dz >= 0; dz--) {
      t = childUvTransform(t, (tile.x >> dz) & 1, (tile.y >> dz) & 1);
    }
    this.startFade(tile, from.acquire(), _prevTransform.set(t[0], t[1], t[2], t[3]));
  }

  /**
   * The ancestor whose picture covered `tile` last frame: one drawn itself
   * (zooming in, possibly several levels at once), or the parent through the
   * fill that stood in for `tile`. Null when `tile` replaces descendants.
   */
  private shownAncestor(tile: GlobeTile): GlobeTile | null {
    const last = this.globe.frame - 1;
    if (tile.filledFrame === last) return tile.parent;
    for (let a = tile.parent; a; a = a.parent) {
      if (a.lastRenderedFrame === last) return a;
    }
    return null;
  }

  /**
   * Height drawn last frame at (u, v) of `tile` (u east, v south, 0..1) by the
   * descendants that `tile` now replaces (zooming out), or null.
   */
  private shownHeightBelow(tile: GlobeTile, u: number, v: number): number | null {
    const last = this.globe.frame - 1;
    let t = tile;
    while (t.children) {
      const cx = u < 0.5 ? 0 : 1;
      const cy = v < 0.5 ? 0 : 1;
      const c = t.children[cy * 2 + cx];
      const cu = Math.min(1, u * 2 - cx);
      const cv = Math.min(1, v * 2 - cy);
      if (c.lastRenderedFrame === last) return c.heights && c.geometryGen === this.globe.geometryGen ? c.sampleHeight(cu, cv) : null;
      // `t`'s quadrant stood in for `c`.
      if (c.filledFrame === last) return t.heights && t.geometryGen === this.globe.geometryGen ? t.sampleHeight(u, v) : null;
      t = c;
      u = cu;
      v = cv;
    }
    return null;
  }

  /**
   * Starts morphing a tile that has just come on screen from the surface drawn
   * there last frame: `before` (an ancestor, zooming in) or the descendants
   * it replaces (zooming out). Interim children of the drawn ancestor share its
   * surface, so the common zoom-in case needs no morph.
   */
  private morphFromPrevious(tile: GlobeTile, before: GlobeTile | null): void {
    if (!this.globe.terrain || this.globe.morphDuration <= 0 || !tile.heights || tile.geometryGen !== this.globe.geometryGen) return;
    const N = tile.segments;
    if (before) {
      if (!before.heights || before.geometryGen !== this.globe.geometryGen) return;
      const scale = 2 ** (tile.level - before.level);
      const ou = tile.x - before.x * scale;
      const ov = tile.y - before.y * scale;
      this.startMorph(tile, (i, j) => before.sampleHeight((ou + i / N) / scale, (ov + j / N) / scale));
    } else if (tile.children) {
      this.startMorph(tile, (i, j) => this.shownHeightBelow(tile, i / N, j / N));
    }
  }

  /** Morphs `tile`'s mesh from `oldHeight` (per grid vertex) to its own heights; tiny changes snap. */
  private startMorph(tile: GlobeTile, oldHeight: (i: number, j: number) => number | null): void {
    const attr = tile.morphAttribute;
    if (!attr || !tile.heights) return;
    const { max } = morphDeltas(tile.segments, tile.heights, oldHeight, attr.array as Float32Array);
    // Below half a meter nobody sees the change (the offsets are ignored at morph = 1).
    if (max < 0.5) {
      this.endMorph(tile);
      return;
    }
    attr.needsUpdate = true;
    tile.morphStart = this.globe.now;
    tile.material.morph = 0;
    this.morphing.add(tile);
  }

  endMorph(tile: GlobeTile): void {
    this.morphing.delete(tile);
    tile.material.morph = 1;
  }

  updateMorphs(): void {
    if (this.morphing.size === 0) return;
    const duration = Math.max(1e-3, this.globe.morphDuration * 1000);
    for (const tile of this.morphing) {
      const k = (this.globe.now - tile.morphStart) / duration;
      if (k >= 1 || !tile.mesh) this.endMorph(tile);
      else tile.material.morph = k * k * (3 - 2 * k);
    }
  }

  /**
   * Picks this tile's own imagery or the closest ancestor's (magnified). With
   * `fade` (the tile was on screen last frame), a change of picture
   * cross-fades from the old one.
   */
  resolveImagery(tile: GlobeTile, fade: boolean): void {
    this.showImagery(tile, this.imagerySource(tile), fade);
  }

  /** The tile with the best imagery for `tile`: itself, the closest ancestor with imagery, or (provider just changed) a stale one. */
  private imagerySource(tile: GlobeTile): GlobeTile | null {
    let src: GlobeTile | null = tile;
    let stale: GlobeTile | null = null;
    while (src) {
      if (src.ownImagery) {
        if (src.imageryGen === this.globe.imageryGen) return src;
        stale ??= src;
      }
      src = src.parent;
    }
    return stale;
  }

  /**
   * Imagery update for a tile that stays on screen. Better imagery is not
   * shown the moment it arrives (`imagerySwitchDue`): sharper ancestors are
   * coalesced and a tile's own imagery waits for its siblings', so the view
   * sharpens in a few calm cross-fades instead of flickering tile by tile.
   * Returns whether better imagery is being held back.
   */
  updateShownImagery(tile: GlobeTile): boolean {
    const src = this.imagerySource(tile);
    const target = src?.ownImagery ?? this.globe.placeholder;
    if (target === tile.imagery) {
      tile.imageryPendingSince = 0;
      return false;
    }
    if (tile.imageryPendingSince === 0) tile.imageryPendingSince = this.globe.now;
    const own = src === tile;
    const fromPlaceholder = !tile.imagery || tile.imagery === this.globe.placeholder;
    const due = imagerySwitchDue(this.globe.now - tile.imageryPendingSince, own, fromPlaceholder, own && this.siblingsHaveImagery(tile));
    if (!due) return true;
    this.showImagery(tile, src, true);
    tile.imageryPendingSince = 0;
    return false;
  }

  /**
   * Whether every sibling drawn this frame has its own imagery, or has none to wait for (out of
   * range, missing, failed). A sibling filled in by the parent's quadrant (no mesh yet) has not:
   * it will be drawn shortly, and revealing without it would change the block piece by piece.
   */
  private siblingsHaveImagery(tile: GlobeTile): boolean {
    const siblings = tile.parent?.children;
    if (!siblings) return true;
    for (const s of siblings) {
      if (s === tile) continue;
      if (s.filledFrame === this.globe.frame) return false;
      if (selectionIn(s, this.globe.frame) !== TileSelection.RENDERED) continue;
      if (s.imageryGen === this.globe.imageryGen || s.img.failures > 0) continue;
      return false;
    }
    return true;
  }

  private showImagery(tile: GlobeTile, src: GlobeTile | null, fade: boolean): void {
    const shared = src?.ownImagery ?? this.globe.placeholder;
    const material = tile.material;
    if (tile.imagery !== shared) {
      shared.acquire();
      const previous = tile.imagery;
      tile.imagery = shared;
      _prevTransform.copy(material.imageryTransform);
      this.setImageryTransform(tile, src);
      if (previous && fade && tile.mesh && this.globe.fadeDuration > 0) {
        this.startFade(tile, previous, _prevTransform);
      } else {
        previous?.release();
      }
    } else {
      this.setImageryTransform(tile, src);
    }
    material.imageryMap = shared.texture;
    if (!tile.fadeFrom) {
      material.fadeMap = shared.texture;
      material.fadeTransform.copy(material.imageryTransform);
      material.fade = 1;
    }
  }

  private setImageryTransform(tile: GlobeTile, src: GlobeTile | null): void {
    const t = tile.material.imageryTransform;
    if (src && src !== tile) {
      const dz = tile.level - src.level;
      const scale = 1 / 2 ** dz;
      t.set((tile.x - src.x * 2 ** dz) * scale, (tile.y - src.y * 2 ** dz) * scale, scale, scale);
    } else {
      t.set(0, 0, 1, 1);
    }
  }

  /**
   * Starts cross-fading from `from` (ownership of one reference passes to the
   * tile). When a fade is still running, the picture on screen is a blend of
   * its source and `from` (its target). Restarting from `from` would pop the
   * part of the source still visible, e.g. an anchor tile and the tile's own
   * imagery arriving right after each other. While the source still dominates,
   * the fade keeps it and just retargets to the new imagery.
   */
  private startFade(tile: GlobeTile, from: SharedTexture, fromTransform: Vector4): void {
    if (tile.fadeFrom && tile.material.fade < 0.5) {
      from.release();
      return;
    }
    tile.fadeFrom?.release();
    tile.fadeFrom = from;
    tile.fadeStart = this.globe.now;
    const m = tile.material;
    m.fadeMap = from.texture;
    m.fadeTransform.copy(fromTransform);
    m.fade = 0;
    this.fading.add(tile);
  }

  endFade(tile: GlobeTile): void {
    this.fading.delete(tile);
    tile.fadeFrom?.release();
    tile.fadeFrom = null;
    const m = tile.material;
    m.fade = 1;
    m.fadeMap = m.imageryMap;
    m.fadeTransform.copy(m.imageryTransform);
  }

  updateFades(): void {
    if (this.fading.size === 0) return;
    const duration = Math.max(1e-3, this.globe.fadeDuration * 1000);
    for (const tile of this.fading) {
      const k = (this.globe.now - tile.fadeStart) / duration;
      if (k >= 1 || !tile.fadeFrom) this.endFade(tile);
      else tile.material.fade = k * k * (3 - 2 * k);
    }
  }

  applyGeometry(tile: GlobeTile, built: BuiltTile, gen: number): void {
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(built.positions, 3));
    geometry.setAttribute('normal', new BufferAttribute(built.normals, 3));
    geometry.setAttribute('uv', new BufferAttribute(built.uvs, 2));
    geometry.setIndex(new BufferAttribute(built.indices, 1));
    // Own buffer per geometry: disposing a geometry frees every attribute it was drawn with.
    geometry.setAttribute(MORPH_ATTRIBUTE, new BufferAttribute(new Float32Array(tileVertexCount(this.globe.segments)), 1));
    geometry.computeBoundingSphere();

    let mesh = tile.mesh;
    // Replacing a mesh that is on screen (applied before this frame's traversal, so "last frame"
    // is still the current picture): remember the surface it shows, to morph from it.
    const N = this.globe.segments;
    let shown: Float32Array | null = null;
    const onScreen = tile.lastRenderedFrame === this.globe.frame - 1 || (tile.fills?.some((f) => f?.visible) ?? false);
    if (mesh && onScreen && this.globe.terrain && this.globe.morphDuration > 0 && tile.heights && tile.segments === N && built.heights) {
      shown = new Float32Array((N + 1) * (N + 1));
      for (let j = 0; j <= N; j++) for (let i = 0; i <= N; i++) shown[j * (N + 1) + i] = tile.shownGridHeight(i, j) ?? NaN;
    }
    if (mesh) {
      // Fills share the old vertex buffers: rebuilt from the new geometry on demand.
      this.globe.disposeFills(tile);
      mesh.geometry.dispose();
      mesh.geometry = geometry;
    } else {
      tile.material.wireframe = this.globe.wireframe;
      mesh = new Mesh(geometry, tile.material);
      mesh.name = `tile ${tile.key}`;
      mesh.frustumCulled = false;
      mesh.matrixAutoUpdate = false;
      mesh.visible = false;
      mesh.userData.globeTile = tile;
      tile.mesh = mesh;
      this.globe.group.add(mesh);
      // Show the best available imagery from the first frame on.
      this.resolveImagery(tile, false);
      this.resolveOverlay(tile);
    }
    mesh.position.set(built.center[0], built.center[1], built.center[2]);
    mesh.updateMatrix();
    mesh.updateMatrixWorld(true);

    tile.geometryGen = gen;
    tile.upsampled = built.upsampled;
    tile.segments = this.globe.segments;
    tile.heights = built.heights;
    tile.minHeight = built.minHeight;
    tile.maxHeight = built.maxHeight;
    tile.boundingSphere.center.set(built.center[0], built.center[1], built.center[2]);
    tile.boundingSphere.radius = built.boundingRadius;
    tile.horizonPoint = built.horizonPoint ? new Vector3(...built.horizonPoint) : null;
    // New bounds: decide the clip state again.
    tile.regionGen = -1;
    if (shown) {
      const old = shown;
      this.startMorph(tile, (i, j) => old[j * (N + 1) + i]);
    } else {
      this.endMorph(tile);
    }
    if (tile.children) {
      const [lo, hi] = this.globe.childHeightRange(tile);
      for (const c of tile.children) {
        if (!c.mesh || c.geometryGen !== gen) {
          c.minHeight = lo;
          c.maxHeight = hi;
          c.estimateBounds();
        }
      }
    }
    this.trackLoaded(tile);
  }

  private trackLoaded(tile: GlobeTile): void {
    if (tile.mesh || tile.ownImagery || tile.ownOverlay) this.globe.loaded.add(tile);
  }
}
