/**
 * Builds globe tile meshes off the main thread: fetches and decodes raster
 * elevation tiles, samples them onto a regular grid in Web Mercator space,
 * converts to ECEF, adds skirts and computes culling volumes.
 *
 * Raster terrain is read from the tile `terrainLevelOffset` levels up (one
 * 256 px tile serves 8 x 8 mesh tiles at full resolution). Requests carrying
 * an `upsample` grid are answered at once from the ancestor's heights while
 * the exact terrain tile is prefetched for the follow-up request.
 *
 * Downloads are shared by every job that needs the same terrain tile and are
 * aborted when the last waiting job is cancelled; sources on HTTP/1.1 servers
 * also keep to their per-host limit, with slots granted by the main thread
 * (`terrain/terrainDownloads.ts`, `requestSlots.ts`). With the persistent
 * cache on, tile files are looked up in it first and stored after download
 * (`tileStore.ts`).
 */
import { computeHorizonCullingPoint, geodeticNormal, geodeticToEcef, mercatorVToLatitude, WGS84_A } from '../core/geodesy';
import { geoidUndulation } from '../core/Geoid';
import { SlotClient } from './requestSlots';
import { cachedRequest, openTileStore, tileKey, type TileStore } from './tileStore';
import type { BuildTileRequest, BuiltTile, WorkerRequest, WorkerResponse } from './workerProtocol';
import { isQuantizedMesh, type QuantizedMeshTerrainSource, type RasterTerrainSource, type TerrainSource } from './terrain/TerrainSource';
import { decodeQuantizedMesh, geographicTileRect, isTileAvailable, rasterizeQuantizedMesh, sampleGrid } from './terrain/quantizedMesh';
import { isAbortError, LoadCache, throttledRead, type SharedLoad } from './terrain/terrainDownloads';
import { innerGrid, rasterSourceTile, sampleBorderedGrid, terrainLevelOffset, upsampleBorderedGrid } from './terrain/terrainTiling';
import { buildTileIndices, edgeVertices } from './tileMeshLayout';

// Minimal worker scope typing (the project compiles against the DOM lib).
declare const self: {
  postMessage(message: unknown, transfer: Transferable[]): void;
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
};

interface HeightImage {
  width: number;
  height: number;
  data: Float32Array;
}

const HEIGHT_CACHE_SIZE = 64;
const heightCache = new LoadCache<HeightImage>(HEIGHT_CACHE_SIZE);
/** In-flight build jobs by request id. */
const jobs = new Map<number, AbortController>();
const sources = new Map<string, TerrainSource>();
const slots = new SlotClient((message) => self.postMessage(message, []));
/** Persistent cache of terrain files (null when off). */
let store: TileStore | null = null;

function fillTemplate(url: string, z: number, x: number, y: number): string {
  return url.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y));
}

async function fetchHeightImage(src: RasterTerrainSource, z: number, x: number, y: number, load: SharedLoad<HeightImage>): Promise<HeightImage> {
  const url = fillTemplate(src.url, z, x, y);
  const blob = (await cachedRequest(store, tileKey('dem', src.id, z, x, y), load.controller.signal, () =>
    throttledRead(slots, url, src.maxRequestsPerHost, load, async (signal) => {
      const res = await fetch(url, { mode: 'cors', credentials: 'omit', signal });
      if (!res.ok) throw new Error(`terrain HTTP ${res.status}`);
      return res.blob();
    }),
  ))!;
  // Keep raw bytes: no color management or premultiplication, or the decoded heights drift.
  const bitmap = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  const { width, height } = bitmap;
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('2D canvas unavailable in worker');
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  const rgba = ctx.getImageData(0, 0, width, height).data;
  const data = new Float32Array(width * height);
  if (src.encoding === 'terrarium') {
    for (let i = 0, p = 0; i < data.length; i++, p += 4) {
      data[i] = rgba[p] * 256 + rgba[p + 1] + rgba[p + 2] / 256 - 32768;
    }
  } else {
    for (let i = 0, p = 0; i < data.length; i++, p += 4) {
      data[i] = -10000 + (rgba[p] * 65536 + rgba[p + 1] * 256 + rgba[p + 2]) * 0.1;
    }
  }
  return { width, height, data };
}

/** Decoded elevation tile; `signal` is the waiting job's (omit for prefetches). */
function getHeightImage(src: RasterTerrainSource, z: number, x: number, y: number, signal?: AbortSignal): Promise<HeightImage> {
  const key = `${src.id}/${z}/${x}/${y}`;
  const entry = heightCache.get(key, (load) => fetchHeightImage(src, z, x, y, load), !signal);
  return heightCache.wait(key, entry, signal);
}

/** Bilinear sample of a height image at normalized coordinates (0,0 = north-west corner). */
function sampleHeight(img: HeightImage, u: number, v: number): number {
  const fx = Math.min(img.width - 1, Math.max(0, u * img.width - 0.5));
  const fy = Math.min(img.height - 1, Math.max(0, v * img.height - 0.5));
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = Math.min(img.width - 1, x0 + 1);
  const y1 = Math.min(img.height - 1, y0 + 1);
  const tx = fx - x0;
  const ty = fy - y0;
  const d = img.data;
  const w = img.width;
  const a = d[y0 * w + x0] * (1 - tx) + d[y0 * w + x1] * tx;
  const b = d[y1 * w + x0] * (1 - tx) + d[y1 * w + x1] * tx;
  return a * (1 - ty) + b * ty;
}

function sourceTileFor(req: BuildTileRequest, src: RasterTerrainSource) {
  return rasterSourceTile(req.level, req.x, req.y, src.maxZoom, terrainLevelOffset(src.tileSize ?? 256, req.segments));
}

/** Heights of the tile grid with a one-cell border (`sampleBorderedGrid`; NaN where the elevation tile ends). */
async function sampleTerrainGrid(req: BuildTileRequest, src: RasterTerrainSource, signal: AbortSignal): Promise<Float32Array> {
  const { x, y } = req;
  // Each mesh tile samples a sub-rectangle of a coarser elevation tile.
  const { z: sz, x: sx, y: sy, dz } = sourceTileFor(req, src);
  const scale = 1 / 2 ** dz;
  const offU = (x - sx * 2 ** dz) * scale;
  const offV = (y - sy * 2 ** dz) * scale;
  const img = await getHeightImage(src, sz, sx, sy, signal);
  return sampleBorderedGrid(req.segments, offU, offV, scale, (u, v) => {
    const h = sampleHeight(img, u, v);
    return (req.clampToSeaLevel && h < 0 ? 0 : h) * req.exaggeration;
  });
}

// -----------------------------------------------------------------------------
// Quantized-mesh terrain (geographic tiles resampled onto the mercator grid)

const QM_GRID = 65;

interface GeoTile {
  level: number;
  x: number;
  y: number;
  grid: Float32Array;
}

const geoCache = new LoadCache<GeoTile | null>(HEIGHT_CACHE_SIZE);

/**
 * Loads a geographic terrain tile, falling back to ancestors when it is not
 * available. `signal` is the waiting job's (omit for prefetches).
 */
function loadGeoTile(src: QuantizedMeshTerrainSource, level: number, x: number, y: number, signal?: AbortSignal): Promise<GeoTile | null> {
  const key = `${src.id}/${level}/${x}/${y}`;
  const entry = geoCache.get(
    key,
    async (load): Promise<GeoTile | null> => {
      const s = load.controller.signal;
      // The fallback waits on behalf of this load, so cancelling it releases the parent too. A detached
      // download (throttled host) may finish after it was cancelled: its fallback then loads on its own.
      const parent = () => (level > 0 ? loadGeoTile(src, level - 1, x >> 1, y >> 1, s.aborted ? undefined : s) : Promise.resolve(null));
      if (!isTileAvailable(src.available, level, x, y)) return parent();
      const url = fillTemplate(src.url, level, x, y);
      const file = await cachedRequest(store, tileKey('dem', src.id, level, x, y), s, () =>
        throttledRead(slots, url, src.maxRequestsPerHost, load, async (signal) => {
          const res = await fetch(url, { headers: src.headers, mode: 'cors', credentials: 'omit', signal });
          if (res.status === 404 || res.status === 204) return null;
          if (!res.ok) throw new Error(`terrain HTTP ${res.status}`);
          return res.blob();
        }),
      );
      if (!file) return parent();
      return { level, x, y, grid: rasterizeQuantizedMesh(decodeQuantizedMesh(await file.arrayBuffer()), QM_GRID) };
    },
    !signal,
  );
  return geoCache.wait(key, entry, signal);
}

/** Geographic tiles (level, column, row range) covering a mercator mesh tile. */
function geoTilesFor(req: BuildTileRequest, src: QuantizedMeshTerrainSource) {
  const n = 2 ** req.level;
  const west = (req.x / n) * 360 - 180;
  const toDeg = 180 / Math.PI;
  const latN = mercatorVToLatitude(req.y / n) * toDeg;
  const latS = mercatorVToLatitude((req.y + 1) / n) * toDeg;
  // A geographic tile at level g is as wide as a mercator tile at level g + 1,
  // so one column covers this tile; it spans at most a couple of rows.
  const g = Math.max(0, Math.min(src.geographicMaxZoom, req.level - 1));
  const size = 180 / 2 ** g;
  const gx = Math.min(2 ** (g + 1) - 1, Math.max(0, Math.floor((west + 180) / size + 1e-9)));
  const maxRow = 2 ** g - 1;
  const rowOf = (lat: number) => Math.min(maxRow, Math.max(0, Math.floor((lat + 90) / size)));
  return { g, gx, rowOf, r0: rowOf(latS), r1: rowOf(latN - 1e-9) };
}

/** Heights of the tile grid with a one-cell border (NaN where the border leaves the loaded geographic tiles). */
async function sampleQuantizedMesh(req: BuildTileRequest, src: QuantizedMeshTerrainSource, signal: AbortSignal): Promise<Float32Array> {
  const N = req.segments;
  const row = N + 3;
  const n = 2 ** req.level;
  const west = (req.x / n) * 360 - 180;
  const east = ((req.x + 1) / n) * 360 - 180;
  const vNorth = req.y / n;
  const vSouth = (req.y + 1) / n;
  const toDeg = 180 / Math.PI;

  const { g, gx, rowOf, r0, r1 } = geoTilesFor(req, src);
  const tiles = new Map<number, GeoTile | null>();
  await Promise.all(
    Array.from({ length: r1 - r0 + 1 }, (_, i) => r0 + i).map(async (r) => tiles.set(r, await loadGeoTile(src, g, gx, r, signal))),
  );

  const heights = new Float32Array(row * row);
  for (let j = -1; j <= N + 1; j++) {
    const lat = mercatorVToLatitude(vNorth + ((vSouth - vNorth) * j) / N) * toDeg;
    const tile = tiles.get(Math.min(r1, Math.max(r0, rowOf(lat))));
    for (let i = -1; i <= N + 1; i++) {
      const lon = west + ((east - west) * i) / N;
      const border = i < 0 || i > N || j < 0 || j > N;
      let h = 0;
      if (tile) {
        const rect = geographicTileRect(tile.level, tile.x, tile.y);
        const u = (lon - rect.west) / rect.size;
        const v = (lat - rect.south) / rect.size;
        if (border && (u < 0 || u > 1 || v < 0 || v > 1)) {
          heights[(j + 1) * row + i + 1] = NaN;
          continue;
        }
        h = sampleGrid(tile.grid, QM_GRID, u, v);
      } else if (border) {
        heights[(j + 1) * row + i + 1] = NaN;
        continue;
      }
      if (req.exaggeration !== 1) {
        // Exaggerate relative to sea level, not to the ellipsoid.
        const n0 = geoidUndulation(lon / toDeg, lat / toDeg);
        h = (h - n0) * req.exaggeration + n0;
      }
      heights[(j + 1) * row + i + 1] = h;
    }
  }
  return heights;
}

/**
 * `bordered`: heights of the tile grid with a one-cell border
 * (`sampleBorderedGrid`, NaN where there is no data), used for central
 * differences at the edges. `ellipsoidal`: heights are already ellipsoidal
 * and exaggerated (upsampled from an ancestor mesh), so no geoid correction
 * is applied.
 */
function buildMesh(req: BuildTileRequest, bordered: Float32Array | null, src: TerrainSource | null, ellipsoidal = false): BuiltTile {
  const N = req.segments;
  const row = N + 1;
  const brow = N + 3;
  const gridCount = row * row;
  const skirtCount = 4 * row;
  const vertexCount = gridCount + skirtCount;
  const n = 2 ** req.level;
  const west = (req.x / n) * 2 * Math.PI - Math.PI;
  const east = ((req.x + 1) / n) * 2 * Math.PI - Math.PI;
  const vNorth = req.y / n;
  const vSouth = (req.y + 1) / n;

  // Latitudes of rows -1..N + 1 (index j + 1) and longitude of column i (-1..N + 1).
  const lats = new Float64Array(brow);
  for (let j = -1; j <= N + 1; j++) lats[j + 1] = mercatorVToLatitude(vNorth + ((vSouth - vNorth) * j) / N);
  const lonAt = (i: number) => west + ((east - west) * i) / N;

  // MSL -> ellipsoidal heights (EGM96), so terrain and 3D Tiles share one datum.
  if (bordered && !ellipsoidal && src?.heightReference === 'msl') {
    for (let j = -1; j <= N + 1; j++) {
      for (let i = -1; i <= N + 1; i++) {
        const k = (j + 1) * brow + i + 1;
        if (!Number.isNaN(bordered[k])) bordered[k] += geoidUndulation(lonAt(i), lats[j + 1]);
      }
    }
  }
  const heights = bordered ? innerGrid(bordered, N) : null;

  let minHeight = 0;
  let maxHeight = 0;
  if (heights) {
    minHeight = Infinity;
    maxHeight = -Infinity;
    for (let i = 0; i < heights.length; i++) {
      const h = heights[i];
      if (h < minHeight) minHeight = h;
      if (h > maxHeight) maxHeight = h;
    }
  }

  const ecef = new Float64Array(vertexCount * 3);
  const normals64 = new Float64Array(vertexCount * 3);
  const uvs = new Float32Array(vertexCount * 2);

  for (let j = 0; j <= N; j++) {
    for (let i = 0; i <= N; i++) {
      const k = j * row + i;
      const lon = lonAt(i);
      geodeticToEcef(lon, lats[j + 1], heights ? heights[k] : 0, ecef, k * 3);
      geodeticNormal(lon, lats[j + 1], normals64, k * 3);
      uvs[k * 2] = i / N;
      uvs[k * 2 + 1] = j / N;
    }
  }

  // Terrain normals from central differences of the ECEF grid (east x north = up). At the edges
  // the border samples stand in for the neighbor's row or column, so both tiles compute the same
  // normal there; without a border sample (end of the source data) the difference is one-sided.
  let reliefMin = minHeight;
  let reliefMax = maxHeight;
  if (bordered) {
    for (let k = 0; k < bordered.length; k++) {
      const h = bordered[k];
      if (h < reliefMin) reliefMin = h;
      if (h > reliefMax) reliefMax = h;
    }
  }
  if (bordered && reliefMax - reliefMin > 0.01) {
    // ECEF of grid point (i, j), -1..N + 1: tile vertices from `ecef`, border points computed here.
    // Returns null for a border point without data.
    const pa = [0, 0, 0];
    const pb = [0, 0, 0];
    const point = (i: number, j: number, out: number[]): number[] | null => {
      if (i >= 0 && i <= N && j >= 0 && j <= N) {
        const o = (j * row + i) * 3;
        out[0] = ecef[o];
        out[1] = ecef[o + 1];
        out[2] = ecef[o + 2];
        return out;
      }
      const h = bordered[(j + 1) * brow + i + 1];
      if (Number.isNaN(h)) return null;
      geodeticToEcef(lonAt(i), lats[j + 1], h, out, 0);
      return out;
    };
    // Difference vector from the point before to the point after (i, j) along (di, dj).
    const diff = (i: number, j: number, di: number, dj: number, out: number[]): void => {
      const after = point(i + di, j + dj, pa) ?? point(i, j, pa)!;
      const before = point(i - di, j - dj, pb) ?? point(i, j, pb)!;
      out[0] = after[0] - before[0];
      out[1] = after[1] - before[1];
      out[2] = after[2] - before[2];
    };
    const east3 = [0, 0, 0];
    const north3 = [0, 0, 0];
    for (let j = 0; j <= N; j++) {
      for (let i = 0; i <= N; i++) {
        const k = j * row + i;
        diff(i, j, 1, 0, east3);
        // Rows run north to south: "after" in the north direction is row j - 1.
        diff(i, j, 0, -1, north3);
        const ax = east3[0];
        const ay = east3[1];
        const az = east3[2];
        const bx = north3[0];
        const by = north3[1];
        const bz = north3[2];
        let nx = ay * bz - az * by;
        let ny = az * bx - ax * bz;
        let nz = ax * by - ay * bx;
        const len = Math.hypot(nx, ny, nz);
        if (len > 1e-9) {
          nx /= len;
          ny /= len;
          nz /= len;
          // Guard against degenerate cells near the poles flipping the normal.
          const gx = normals64[k * 3];
          const gy = normals64[k * 3 + 1];
          const gz = normals64[k * 3 + 2];
          if (nx * gx + ny * gy + nz * gz > 0.05) {
            normals64[k * 3] = nx;
            normals64[k * 3 + 1] = ny;
            normals64[k * 3 + 2] = nz;
          }
        }
      }
    }
  }

  // Skirts hide cracks between neighbors at different levels of detail.
  const latC = mercatorVToLatitude((vNorth + vSouth) / 2);
  const lonSpan = (east - west) * WGS84_A * Math.cos(latC);
  const latSpan = Math.abs(lats[0] - lats[N]) * WGS84_A;
  const segment = Math.max(lonSpan, latSpan) / N;
  const sagitta = (segment * segment) / (8 * WGS84_A);
  const skirtDepth = Math.max(20, segment * 0.15, sagitta * 3) + (heights ? 0.5 * (maxHeight - minHeight) : 0);

  // Edge vertex indices, each traversed so the skirt faces outward (layout: tileMeshLayout.ts).
  const edges = edgeVertices(N);

  let s = gridCount;
  for (const edge of edges) {
    for (const k of edge) {
      ecef[s * 3] = ecef[k * 3] - normals64[k * 3] * skirtDepth;
      ecef[s * 3 + 1] = ecef[k * 3 + 1] - normals64[k * 3 + 1] * skirtDepth;
      ecef[s * 3 + 2] = ecef[k * 3 + 2] - normals64[k * 3 + 2] * skirtDepth;
      normals64[s * 3] = normals64[k * 3];
      normals64[s * 3 + 1] = normals64[k * 3 + 1];
      normals64[s * 3 + 2] = normals64[k * 3 + 2];
      uvs[s * 2] = uvs[k * 2];
      uvs[s * 2 + 1] = uvs[k * 2 + 1];
      s++;
    }
  }

  // RTC center at the middle of the tile, mid-height.
  const center: [number, number, number] = [0, 0, 0];
  geodeticToEcef((west + east) / 2, latC, (minHeight + maxHeight) / 2, center);

  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  let radiusSq = 0;
  for (let k = 0; k < vertexCount; k++) {
    const dx = ecef[k * 3] - center[0];
    const dy = ecef[k * 3 + 1] - center[1];
    const dz = ecef[k * 3 + 2] - center[2];
    positions[k * 3] = dx;
    positions[k * 3 + 1] = dy;
    positions[k * 3 + 2] = dz;
    normals[k * 3] = normals64[k * 3];
    normals[k * 3 + 1] = normals64[k * 3 + 1];
    normals[k * 3 + 2] = normals64[k * 3 + 2];
    radiusSq = Math.max(radiusSq, dx * dx + dy * dy + dz * dz);
  }

  const indices = buildTileIndices(N, vertexCount);

  const horizonPoint = computeHorizonCullingPoint(center[0], center[1], center[2], ecef, gridCount);

  return {
    type: 'built',
    id: req.id,
    center,
    positions,
    normals,
    uvs,
    indices,
    gridVertexCount: gridCount,
    minHeight,
    maxHeight,
    boundingRadius: Math.sqrt(radiusSq),
    horizonPoint,
    heights,
    upsampled: false,
  };
}

/** Starts downloading the terrain an exact build of this tile will need (errors are retried then). */
function prefetchTerrain(req: BuildTileRequest, src: TerrainSource): void {
  if (isQuantizedMesh(src)) {
    const { g, gx, r0, r1 } = geoTilesFor(req, src);
    for (let r = r0; r <= r1; r++) loadGeoTile(src, g, gx, r).catch(() => undefined);
  } else {
    const t = sourceTileFor(req, src);
    getHeightImage(src, t.z, t.x, t.y).catch(() => undefined);
  }
}

async function handleBuild(req: BuildTileRequest): Promise<void> {
  const job = new AbortController();
  jobs.set(req.id, job);
  try {
    const src = req.terrainId ? (sources.get(req.terrainId) ?? null) : null;
    if (req.terrainId && !src) throw new Error(`unknown terrain source ${req.terrainId}`);
    let tile: BuiltTile;
    if (src && req.upsample) {
      const u = req.upsample;
      const heights = upsampleBorderedGrid(u.heights, u.segments, u.level, u.x, u.y, req.level, req.x, req.y, req.segments);
      if (req.prefetch !== false) prefetchTerrain(req, src);
      tile = buildMesh(req, heights, src, true);
      tile.upsampled = true;
    } else {
      const heights = src ? await (isQuantizedMesh(src) ? sampleQuantizedMesh(req, src, job.signal) : sampleTerrainGrid(req, src, job.signal)) : null;
      if (job.signal.aborted) {
        post({ type: 'error', id: req.id, message: 'cancelled', aborted: true });
        return;
      }
      tile = buildMesh(req, heights, src);
    }
    const transfer: Transferable[] = [tile.positions.buffer, tile.normals.buffer, tile.uvs.buffer, tile.indices.buffer];
    if (tile.heights) transfer.push(tile.heights.buffer);
    post(tile, transfer);
  } catch (err) {
    // An abort the job did not ask for (a shared download withdrawn under it) is retried by the globe, not reported.
    post({ type: 'error', id: req.id, message: err instanceof Error ? err.message : String(err), aborted: job.signal.aborted || isAbortError(err) });
  } finally {
    jobs.delete(req.id);
  }
}

function post(msg: WorkerResponse, transfer: Transferable[] = []): void {
  self.postMessage(msg, transfer);
}

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const msg = event.data;
  if (msg.type === 'source') sources.set(msg.source.id, msg.source);
  else if (msg.type === 'build') void handleBuild(msg);
  else if (msg.type === 'cancel') jobs.get(msg.id)?.abort();
  else if (msg.type === 'slot') slots.receive(msg);
  else if (msg.type === 'cache') {
    void store?.close();
    store = msg.options ? openTileStore(msg.options) : null;
  }
};
