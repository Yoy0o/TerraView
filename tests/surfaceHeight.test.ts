import { describe, expect, it } from 'vitest';
import { SurfaceHeightQuery, type SurfaceSample, type SurfaceHeightSources } from '../src/viewer/SurfaceHeight';

/** Fake viewer: globe on / off, a terrain sample, tiles active / suppressed, a tile hit per call. */
function setup(init: Partial<{ globe: boolean; terrain: SurfaceSample | null; tilesActive: boolean; tiles: SurfaceSample | null; rayMs: number }> = {}) {
  const state = { globe: false, terrain: null as SurfaceSample | null, tilesActive: true, tiles: null as SurfaceSample | null, rayMs: 0, rays: 0, clock: 0, ...init };
  const sources: SurfaceHeightSources = {
    globeShown: () => state.globe,
    terrain: () => state.terrain,
    tilesActive: () => state.tilesActive,
    raycastTiles: () => {
      state.rays++;
      state.clock += state.rayMs;
      return state.tiles;
    },
    now: () => state.clock,
  };
  const q = new SurfaceHeightQuery(sources);
  q.beginFrame();
  return { q, state };
}

const LON = 2.0362;
const LAT = 0.6964;

describe('SurfaceHeightQuery sources and thresholds', () => {
  it('uses only the terrain while the globe is shown, like Globe.getHeight', () => {
    const { q, state } = setup({ globe: true, terrain: { height: 48, resolution: 30 }, tiles: { height: 60, resolution: 1 } });
    const r = q.query(LON, LAT);
    expect(r).toEqual({ height: 48, resolution: 30, source: 'terrain', reliable: true, held: false });
    expect(state.rays).toBe(0);
    // Coarser than the threshold: same height, flagged unreliable (getHeight(…, 150) would be null).
    state.terrain = { height: 120, resolution: 600 };
    expect(q.query(LON, LAT)).toMatchObject({ height: 120, source: 'terrain', reliable: false });
    expect(q.query(LON, LAT, { maxCellSize: Infinity }).reliable).toBe(true);
    state.terrain = null;
    expect(q.query(LON, LAT)).toMatchObject({ height: 0, source: 'ellipsoid', reliable: false });
  });

  it('uses the 3D Tiles ray without the globe, reliable once the tile is detailed enough', () => {
    const { q, state } = setup({ tiles: { height: 52.4, resolution: 400 } });
    expect(q.query(LON, LAT)).toMatchObject({ height: 52.4, source: 'tiles', reliable: false });
    q.beginFrame();
    state.tiles = { height: 47.1, resolution: 8 };
    expect(q.query(LON, LAT)).toEqual({ height: 47.1, resolution: 8, source: 'tiles', reliable: true, held: false });
    expect(q.query(LON, LAT, { maxCellSize: 5 }).reliable).toBe(false);
  });

  it('falls back to the finer of tiles and hidden terrain, then the ellipsoid', () => {
    const { q, state } = setup({ terrain: { height: 40, resolution: 300 }, tiles: null });
    // No tile hit: the hidden globe's terrain, unreliable.
    expect(q.query(LON, LAT)).toMatchObject({ height: 40, source: 'terrain', reliable: false });
    q.beginFrame();
    state.tiles = { height: 50, resolution: 1000 };
    expect(q.query(LON, LAT)).toMatchObject({ height: 40, source: 'terrain', reliable: false });
    q.beginFrame();
    state.tiles = { height: 50, resolution: 200 };
    expect(q.query(LON, LAT)).toMatchObject({ height: 50, source: 'tiles', reliable: false });
    // Hidden terrain alone is never preferred over reliable tiles, and nothing at all is 0 m.
    const empty = setup({ tiles: null, tilesActive: false });
    expect(empty.q.query(LON, LAT)).toMatchObject({ height: 0, source: 'ellipsoid', reliable: false, held: false });
  });
});

describe('SurfaceHeightQuery held results', () => {
  it('keeps the result measured before the tiles were suppressed', () => {
    const { q, state } = setup({ tiles: { height: 47.1, resolution: 4 } });
    expect(q.query(LON, LAT).reliable).toBe(true);
    // Entering a building suppresses the tiles: no ray, the held result instead of 0 m.
    state.tilesActive = false;
    state.tiles = null;
    for (let i = 0; i < 3; i++) {
      q.beginFrame();
      expect(q.query(LON, LAT)).toEqual({ height: 47.1, resolution: 4, source: 'tiles', reliable: true, held: true });
    }
    expect(state.rays).toBe(1);
    // Tiles back: measured again.
    state.tilesActive = true;
    state.tiles = { height: 47.3, resolution: 2 };
    q.beginFrame();
    expect(q.query(LON, LAT)).toMatchObject({ height: 47.3, held: false });
  });

  it('holds through a missed ray and keeps a finer earlier result over a coarser new one', () => {
    const { q, state } = setup({ tiles: { height: 47.1, resolution: 4 } });
    q.query(LON, LAT);
    q.beginFrame();
    state.tiles = null;
    expect(q.query(LON, LAT)).toMatchObject({ height: 47.1, held: true });
    q.beginFrame();
    // The camera flew away and the tile coarsened.
    state.tiles = { height: 60, resolution: 300 };
    expect(q.query(LON, LAT)).toMatchObject({ height: 47.1, resolution: 4, reliable: true });
    // Refinement replaces it.
    q.beginFrame();
    state.tiles = { height: 46.8, resolution: 1 };
    expect(q.query(LON, LAT).height).toBe(46.8);
  });

  it('is cleared when tilesets change', () => {
    const { q, state } = setup({ tiles: { height: 47.1, resolution: 4 } });
    q.query(LON, LAT);
    expect(q.heldCount).toBe(1);
    q.clearHeld();
    state.tilesActive = false;
    expect(q.query(LON, LAT).source).toBe('ellipsoid');
  });

  it('evicts the least recently measured results beyond the limit', () => {
    const { q, state } = setup({ tiles: { height: 1, resolution: 1 } });
    q.heldLimit = 2;
    q.rayBudgetMs = Infinity;
    q.query(0.1, 0.1);
    q.query(0.2, 0.2);
    q.query(0.3, 0.3);
    expect(q.heldCount).toBe(2);
    state.tilesActive = false;
    expect(q.query(0.1, 0.1).source).toBe('ellipsoid');
    expect(q.query(0.3, 0.3).source).toBe('tiles');
  });
});

describe('SurfaceHeightQuery ray budget', () => {
  it('reuses a ray within a frame and stops casting once the budget is spent', () => {
    const { q, state } = setup({ tiles: { height: 47, resolution: 4 }, rayMs: 1 });
    q.rayBudgetMs = 2;
    q.query(LON, LAT);
    q.query(LON, LAT, { maxCellSize: Infinity });
    expect(state.rays).toBe(1);
    q.query(0.1, 0.1);
    // 2 ms spent: further points wait (unreliable, no data yet) instead of stalling the frame.
    const late = q.query(0.2, 0.2);
    expect(state.rays).toBe(2);
    expect(late).toMatchObject({ source: 'ellipsoid', reliable: false });
    // Next frame: at least one ray, the budget again.
    q.beginFrame();
    expect(q.query(0.2, 0.2).reliable).toBe(true);
    expect(q.raysThisFrame).toBe(1);
  });

  it('always allows the first ray of a frame', () => {
    const { q, state } = setup({ tiles: { height: 47, resolution: 4 }, rayMs: 50 });
    q.rayBudgetMs = 1;
    expect(q.query(LON, LAT).reliable).toBe(true);
    expect(q.query(0.1, 0.1).reliable).toBe(false);
    expect(state.rays).toBe(1);
  });
});
