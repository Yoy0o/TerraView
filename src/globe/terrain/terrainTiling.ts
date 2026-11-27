/**
 * Terrain tile selection shared by the main thread (worker routing) and the
 * mesh worker. Dependency-free so worker bundles stay small.
 */

/** A raster terrain tile and how many levels below it the mesh tile sits. */
export interface SourceTile {
  z: number;
  x: number;
  y: number;
  /** Mesh level minus source level (the mesh covers 1 / 2^dz of the source tile). */
  dz: number;
}

/**
 * How many levels coarser the terrain tile can be than the mesh tile without
 * losing samples. A 256 px elevation tile has 256 samples per edge while a
 * mesh tile uses `segments` (32) grid cells, so the tile 3 levels up covers
 * 8 x 8 mesh tiles at exactly one sample per grid cell. Fetching that tile
 * instead of one per mesh tile cuts terrain requests by 64x with no loss of
 * detail.
 */
export function terrainLevelOffset(tileSize: number, segments: number): number {
  return Math.max(0, Math.round(Math.log2(Math.max(1, tileSize) / Math.max(1, segments))));
}

/** Raster terrain tile used for a mesh tile. */
export function rasterSourceTile(level: number, x: number, y: number, maxZoom: number, levelOffset: number): SourceTile {
  const z = Math.max(0, Math.min(maxZoom, level - levelOffset));
  const dz = level - z;
  return { z, x: x >> dz, y: y >> dz, dz };
}

/**
 * Bilinear sample of a mesh height grid ((n + 1)^2 samples, row 0 = north
 * edge) at normalized tile coordinates (u east, v south, both 0..1).
 */
export function sampleHeightGrid(grid: ArrayLike<number>, segments: number, u: number, v: number): number {
  const n = segments;
  const fx = Math.min(n, Math.max(0, u * n));
  const fy = Math.min(n, Math.max(0, v * n));
  const x0 = Math.min(n - 1, Math.floor(fx));
  const y0 = Math.min(n - 1, Math.floor(fy));
  const tx = fx - x0;
  const ty = fy - y0;
  const row = n + 1;
  const a = grid[y0 * row + x0] * (1 - tx) + grid[y0 * row + x0 + 1] * tx;
  const b = grid[(y0 + 1) * row + x0] * (1 - tx) + grid[(y0 + 1) * row + x0 + 1] * tx;
  return a * (1 - ty) + b * ty;
}

/** Samples a source covers, within this much of its 0..1 range, count as inside. */
const BORDER_EPSILON = 1e-9;

/**
 * Samples a tile's height grid together with a one-cell border around it:
 * (segments + 3)^2 values, row-major north to south, the tile's own grid
 * at rows and columns 1..segments + 1. The border lets the mesh worker
 * compute edge normals with central differences like everywhere else, so two
 * neighbors reading the same source give their shared edge the same normals
 * (one-sided differences at the edges made lighting seams along every tile
 * border). Border samples outside the source (`u`, `v` beyond 0..1) are NaN:
 * there the worker falls back to one-sided differences.
 *
 * @param offU Source coordinate (0..1, east) of the tile's west edge.
 * @param offV Source coordinate (0..1, south) of the tile's north edge.
 * @param scale Tile size in source coordinates.
 * @param sample Height at source coordinates (`u` east, `v` south).
 */
export function sampleBorderedGrid(segments: number, offU: number, offV: number, scale: number, sample: (u: number, v: number) => number): Float32Array {
  const n = segments;
  const row = n + 3;
  const out = new Float32Array(row * row);
  const inRange = (t: number) => t >= -BORDER_EPSILON && t <= 1 + BORDER_EPSILON;
  for (let j = -1; j <= n + 1; j++) {
    const v = offV + (j / n) * scale;
    for (let i = -1; i <= n + 1; i++) {
      const u = offU + (i / n) * scale;
      const own = i >= 0 && i <= n && j >= 0 && j <= n;
      out[(j + 1) * row + i + 1] = own || (inRange(u) && inRange(v)) ? sample(u, v) : NaN;
    }
  }
  return out;
}

/** The tile's own (segments + 1)^2 grid inside a bordered grid (`sampleBorderedGrid`). */
export function innerGrid(bordered: ArrayLike<number>, segments: number): Float32Array {
  const row = segments + 1;
  const out = new Float32Array(row * row);
  for (let j = 0; j < row; j++) {
    for (let i = 0; i < row; i++) out[j * row + i] = bordered[(j + 1) * (row + 2) + i + 1];
  }
  return out;
}

/**
 * Resamples the part of an ancestor's height grid covered by a descendant
 * tile onto the descendant's grid, with a one-cell border where the ancestor
 * covers it (`sampleBorderedGrid`). Lets a child tile become renderable right
 * away (Cesium-style "upsampled" terrain) while its own terrain downloads.
 */
export function upsampleBorderedGrid(
  parent: ArrayLike<number>,
  parentSegments: number,
  parentLevel: number,
  parentX: number,
  parentY: number,
  level: number,
  x: number,
  y: number,
  segments: number,
): Float32Array {
  const dl = level - parentLevel;
  const scale = 1 / 2 ** dl;
  const offU = (x - parentX * 2 ** dl) * scale;
  const offV = (y - parentY * 2 ** dl) * scale;
  return sampleBorderedGrid(segments, offU, offV, scale, (u, v) => sampleHeightGrid(parent, parentSegments, u, v));
}

/** `upsampleBorderedGrid` without the border: the descendant's (segments + 1)^2 grid. */
export function upsampleHeightGrid(
  parent: ArrayLike<number>,
  parentSegments: number,
  parentLevel: number,
  parentX: number,
  parentY: number,
  level: number,
  x: number,
  y: number,
  segments: number,
): Float32Array {
  return innerGrid(upsampleBorderedGrid(parent, parentSegments, parentLevel, parentX, parentY, level, x, y, segments), segments);
}
