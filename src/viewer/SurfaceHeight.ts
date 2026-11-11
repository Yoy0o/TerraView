/**
 * Unified ground height query (`viewer.surfaceHeight`): which surface counts
 * as "the ground" at a longitude / latitude, how detailed it is, and whether
 * it is detailed enough to clamp to. Sources are injected (no three, no
 * renderer) so the fallback order, thresholds, ray budget and held results
 * are unit-testable.
 *
 * Order: with the globe shown, only its terrain (same value as
 * `Globe.getHeight`). Without the globe, the visible 3D Tiles (a ray straight
 * down onto the tile meshes); results are remembered so that while the tiles
 * are suppressed (inside a building) or not loaded at a spot, the last
 * measurement is held instead of falling back to 0 m.
 */

/** A height measurement from one source. */
export interface SurfaceSample {
  /** WGS84 ellipsoidal height, meters. */
  height: number;
  /**
   * How coarse the data is, meters: terrain grid spacing, or the 3D tile's
   * geometric error. Infinity when unknown.
   */
  resolution: number;
}

/** Where a surface height came from. */
export type SurfaceSource = 'terrain' | 'tiles' | 'ellipsoid';

/** Result of a surface height query. */
export interface SurfaceHeight extends SurfaceSample {
  /** 'ellipsoid' means no data: height 0 m, never reliable. */
  source: SurfaceSource;
  /** `resolution <= maxCellSize` of the query: safe to clamp buildings, points and the camera to. */
  reliable: boolean;
  /**
   * A 3D Tiles result measured in an earlier frame and held because the
   * tiles are suppressed, not loaded here, or out of ray budget this frame.
   */
  held: boolean;
}

export interface SurfaceHeightOptions {
  /**
   * Coarsest data that counts as reliable, meters (grid spacing / geometric
   * error). Default 150, the terrain clamping threshold (tile-loading.md §4.3).
   */
  maxCellSize?: number;
}

/** What the query reads from the viewer. Angles in radians. */
export interface SurfaceHeightSources {
  /** Whether the globe is drawn; when it is, its terrain is the ground. */
  globeShown(): boolean;
  /** Finest loaded terrain sample, or null while unknown (see `Globe.sampleHeight`). */
  terrain(longitude: number, latitude: number): SurfaceSample | null;
  /** Whether any 3D Tiles layer is visible, loaded and not suppressed. */
  tilesActive(): boolean;
  /** Highest visible 3D Tiles surface straight below / above the point (expensive), or null. */
  raycastTiles(longitude: number, latitude: number): SurfaceSample | null;
  /** Milliseconds clock for the ray budget. */
  now(): number;
}

export const DEFAULT_SURFACE_CELL = 150;

interface Held extends SurfaceSample {
  /** Frame it was measured in. */
  frame: number;
}

/** About 0.6 m on the ground: queries closer than this share a held result. */
const KEY_QUANTUM = 1e-7;

/**
 * Surface height query with a per-frame ray budget and a held-results cache
 * (LRU). Call `beginFrame()` once per frame.
 */
export class SurfaceHeightQuery {
  /** Tile rays may start while this frame has spent less than this, in ms (at least one ray per frame). */
  rayBudgetMs = 1.5;
  /** Held tile results kept (LRU). */
  heldLimit = 16384;
  /** Rays cast this frame (diagnostics). */
  raysThisFrame = 0;
  private frame = 0;
  private spentMs = 0;
  private readonly held = new Map<string, Held>();

  constructor(private readonly sources: SurfaceHeightSources) {}

  /** Starts a frame: resets the ray budget. */
  beginFrame(): void {
    this.frame++;
    this.spentMs = 0;
    this.raysThisFrame = 0;
  }

  /** Forgets held 3D Tiles results (a tileset was added, removed or moved). */
  clearHeld(): void {
    this.held.clear();
  }

  /** Number of held 3D Tiles results. */
  get heldCount(): number {
    return this.held.size;
  }

  /** Surface height at a position (radians). Always returns a value; check `reliable`. */
  query(longitude: number, latitude: number, options: SurfaceHeightOptions = {}): SurfaceHeight {
    const maxCell = options.maxCellSize ?? DEFAULT_SURFACE_CELL;
    const s = this.sources;
    const terrain = s.terrain(longitude, latitude);
    if (s.globeShown()) {
      return terrain ? result(terrain, 'terrain', maxCell, false) : ellipsoid();
    }
    const tiles = this.tilesSample(longitude, latitude);
    if (tiles && tiles.resolution <= maxCell) return result(tiles, 'tiles', maxCell, tiles.frame !== this.frame);
    // Nothing reliable: the most detailed estimate, flagged unreliable.
    if (tiles && (!terrain || tiles.resolution <= terrain.resolution)) return result(tiles, 'tiles', maxCell, tiles.frame !== this.frame);
    return terrain ? result(terrain, 'terrain', maxCell, false) : ellipsoid();
  }

  /** A fresh ray when the tiles are active and the budget allows, else the held result. */
  private tilesSample(longitude: number, latitude: number): Held | null {
    const key = `${Math.round(longitude / KEY_QUANTUM)},${Math.round(latitude / KEY_QUANTUM)}`;
    const held = this.held.get(key) ?? null;
    if (held?.frame === this.frame || !this.sources.tilesActive()) return held;
    if (this.raysThisFrame > 0 && this.spentMs >= this.rayBudgetMs) return held;
    const t0 = this.sources.now();
    const hit = this.sources.raycastTiles(longitude, latitude);
    this.spentMs += this.sources.now() - t0;
    this.raysThisFrame++;
    // No hit (tile not loaded or not in view here): keep what was measured before.
    if (!hit) return held;
    // Tiles coarsen when the camera moves away; a finer earlier measurement stays more accurate.
    const keep = held !== null && held.resolution < hit.resolution;
    const next: Held = keep ? { ...held, frame: this.frame } : { height: hit.height, resolution: hit.resolution, frame: this.frame };
    this.held.delete(key);
    this.held.set(key, next);
    if (this.held.size > this.heldLimit) this.held.delete(this.held.keys().next().value!);
    return next;
  }
}

function result(sample: SurfaceSample, source: SurfaceSource, maxCell: number, held: boolean): SurfaceHeight {
  return { height: sample.height, resolution: sample.resolution, source, reliable: sample.resolution <= maxCell, held };
}

function ellipsoid(): SurfaceHeight {
  return { height: 0, resolution: Infinity, source: 'ellipsoid', reliable: false, held: false };
}
