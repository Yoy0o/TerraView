/**
 * Request scheduling of the globe (docs/agents/tile-loading.md §1, §3): per-channel priority
 * queues (geometry, imagery, overlay) and concurrency limits, cancellation of loads no longer
 * wanted, the next-level imagery prefetch, the worker jobs and downloads themselves, the
 * per-frame upload budget (finished loads wait in `ready`, holding their slot, until applied),
 * and failure reporting. What a finished load does to its tile is `TileContent`'s; which
 * tiles to load comes from the selection in `Globe`.
 */
import { ClampToEdgeWrapping, LinearFilter, LinearMipmapLinearFilter, SRGBColorSpace, Texture } from 'three';
import { TerraViewError } from '../core/errors';
import { GlobeTile, MIN_LEVEL, SharedTexture, type LoadChannel } from './GlobeTile';
import type { TileOverlaySource } from './overlay';
import type { PolarCaps } from './PolarCaps';
import type { TileContent } from './TileContent';
import { isAbortError, TileWorkerPool } from './TileWorkerPool';
import { decodeImage, type ImageryProvider } from './imagery/ImageryProvider';
import { isQuantizedMesh, type TerrainSource } from './terrain/TerrainSource';
import { rasterSourceTile, terrainLevelOffset } from './terrain/terrainTiling';
import { PREFETCH_MAX_ACTIVE, shouldPrefetchChildren } from './tileSelection';
import { cachedRequest, tileKey, type TileStore } from './tileStore';
import type { UpsampleSource } from './workerProtocol';

export type ChannelKind = 'geo' | 'img' | 'ovl';

interface ReadyItem {
  tile: GlobeTile;
  kind: ChannelKind;
  controller: AbortController;
  epoch: number;
  apply: () => void;
  discard: () => void;
}

// Request priority buckets (lower loads first). See docs/agents/tile-loading.md.
/**
 * Content that blocks a level-of-detail change: geometry of a child that keeps
 * its parent from refining, or imagery / terrain a tile needs before it can
 * replace sharper descendants (zooming out).
 */
export const B_BLOCKING = 0;
/** Imagery of an intermediate ancestor: a cheap, sharper fallback for many tiles at once. */
export const B_ANCHOR = 1;
/** Imagery of a rendered tile that currently shows a much coarser fallback. */
export const B_URGENT = 2;
/** Imagery / overlay / exact terrain of rendered tiles. */
export const B_RENDERED = 3;
/** Ancestors kept current as fallbacks; limited to a third of the slots. */
export const B_LOW = 4;

/** Finished loads applied (and uploaded) per frame; keeps frame times flat while streaming. */
const APPLY_BUDGET = 16;
const APPLY_BUDGET_MS = 6;
/** In-flight loads no longer wanted for this many frames are cancelled. */
const STALE_FRAMES = 20;
/** Concurrent geometry jobs that need no download (interpolated or flat meshes). */
const LOCAL_GEOMETRY_LIMIT = 32;


export function channelOf(tile: GlobeTile, kind: ChannelKind): LoadChannel {
  return kind === 'geo' ? tile.geo : kind === 'img' ? tile.img : tile.ovl;
}

/** Routes tiles that read the same terrain data to the same worker (its cache holds the decoded tile). */
function terrainAffinity(terrain: TerrainSource, level: number, x: number, y: number, segments: number): string | undefined {
  if (isQuantizedMesh(terrain)) {
    const g = Math.max(0, Math.min(terrain.geographicMaxZoom, level - 1));
    const shift = level - 1 - g;
    return shift > 0 ? `qm:${g}/${x >> shift}` : undefined;
  }
  const t = rasterSourceTile(level, x, y, terrain.maxZoom, terrainLevelOffset(terrain.tileSize ?? 256, segments));
  return t.dz > 0 ? `${t.z}/${t.x}/${t.y}` : undefined;
}


/** What the loader reads of its globe (the globe passes itself). */
export interface LoaderHost {
  readonly content: TileContent;
  readonly polarCaps: PolarCaps;
  /** Frame counter and `performance.now()` of the current update. */
  readonly frame: number;
  readonly now: number;
  /** Generations of the imagery provider and the terrain source: loads of older ones are discarded. */
  readonly imageryGen: number;
  readonly geometryGen: number;
  readonly imagery: ImageryProvider;
  /** The persistent cache for imagery (null when off). */
  readonly imageryStore: TileStore | null;
  readonly terrain: TerrainSource | null;
  readonly exaggeration: number;
  readonly segments: number;
  readonly maxAnisotropy: number;
  readonly overlaySource: TileOverlaySource | null;
  /** Tiles drawn this frame (prefetch around them). */
  readonly renderList: readonly GlobeTile[];
  readonly freeze: boolean;
  readonly maxScreenSpaceError: number;
  readonly prefetchImagery: boolean;
  imageryError: TerraViewError | null;
  terrainError: TerraViewError | null;
  readonly onImageryError: ((error: TerraViewError) => void) | null;
  readonly reportError: ((source: 'imagery' | 'terrain', error: TerraViewError) => void) | null;
  /** Selection helpers: priorities and whether a mesh needs a download. */
  foveation(tile: GlobeTile): number;
  computeSSE(tile: GlobeTile): number;
  outsideRegion(tile: GlobeTile): boolean;
  interimSource(tile: GlobeTile): GlobeTile | 'flat' | null;
  buildsLocally(tile: GlobeTile): boolean;
}

export class TileLoader {
  readonly workers = new TileWorkerPool();
  readonly queues: Record<ChannelKind, GlobeTile[]> = { geo: [], img: [], ovl: [] };
  readonly active: Record<ChannelKind, Set<GlobeTile>> = { geo: new Set(), img: new Set(), ovl: new Set() };
  /** Finished loads waiting for the per-frame upload budget (`applyReady`). */
  ready: ReadyItem[] = [];
  // Next-level prefetch (HTTP cache only): tiles already asked for (insertion order = age), downloads in flight,
  // and the signal that drops waiting ones when the provider changes.
  private readonly prefetched = new Set<string>();
  prefetchActive = 0;
  private prefetchAbort = new AbortController();
  /** Failures in a row of the current imagery provider / terrain source (reset when they change). */
  imageryErrors = 0;
  terrainErrors = 0;

  constructor(private readonly globe: LoaderHost) {}

  queue(kind: ChannelKind, tile: GlobeTile, bucket: number): void {
    const ch = channelOf(tile, kind);
    // Buckets dominate; anchors load coarse-to-fine; then by distance from the view center.
    // Imagery of drawn tiles is ordered by their parent's block, so the four siblings load back
    // to back and can be revealed together (`imagerySwitchDue`); center-first still holds per block.
    const block = kind === 'img' && (bucket === B_RENDERED || bucket === B_URGENT) && tile.parent ? tile.parent : tile;
    const priority =
      bucket * 1e8 +
      (bucket === B_ANCHOR ? tile.level * 1e6 : 0) +
      Math.min(this.globe.foveation(block), 9.99) * 1e4 +
      Math.min(Math.log2(1 + block.distance), 99) * 10 +
      (block !== tile ? Math.min(this.globe.foveation(tile), 9.99) * 0.1 : 0);
    if (ch.wantedFrame === this.globe.frame) {
      if (priority < ch.priority) {
        ch.priority = priority;
        ch.bucket = bucket;
      }
      return;
    }
    ch.wantedFrame = this.globe.frame;
    ch.priority = priority;
    ch.bucket = bucket;
    this.queues[kind].push(tile);
  }

  /**
   * Starts queued loads in priority order within the channel's concurrency
   * limit (`B_LOW` gets at most a third of it). Geometry that needs no
   * download (interpolated or flat meshes, about a millisecond in a worker)
   * has its own budget so it never waits behind slow terrain requests.
   */
  dispatch(kind: ChannelKind, limit: number): void {
    const queue = this.queues[kind];
    if (queue.length === 0) return;
    // Pool 0: downloads (limit); pool 1: geometry built from loaded data.
    const limits = [limit, kind === 'geo' ? LOCAL_GEOMETRY_LIMIT : 0];
    const active = [0, 0];
    const low = [0, 0];
    for (const t of this.active[kind]) {
      const ch = channelOf(t, kind);
      const pool = kind === 'geo' && ch.local ? 1 : 0;
      active[pool]++;
      if (ch.bucket >= B_LOW) low[pool]++;
    }
    const full = () => active[0] >= limits[0] && active[1] >= limits[1];
    if (full()) return;
    queue.sort((a, b) => channelOf(a, kind).priority - channelOf(b, kind).priority);
    for (const tile of queue) {
      if (full()) break;
      const ch = channelOf(tile, kind);
      if (ch.loading || this.globe.now < ch.retryAt) continue;
      const pool = kind === 'geo' && this.globe.buildsLocally(tile) ? 1 : 0;
      if (active[pool] >= limits[pool]) continue;
      if (ch.bucket >= B_LOW) {
        if (low[pool] >= Math.max(1, Math.floor(limits[pool] / 3))) continue;
        low[pool]++;
      }
      active[pool]++;
      if (kind === 'geo') {
        ch.local = pool === 1;
        this.startGeometry(tile);
      } else if (kind === 'img') this.startImagery(tile);
      else this.startOverlay(tile);
    }
  }

  cancelStaleLoads(): void {
    for (const kind of ['geo', 'img', 'ovl'] as const) {
      for (const tile of this.active[kind]) {
        const ch = channelOf(tile, kind);
        if (ch.loading && !ch.loading.signal.aborted && this.globe.frame - ch.wantedFrame > STALE_FRAMES) ch.loading.abort();
      }
    }
  }

  /**
   * Warms the HTTP cache with the next level's imagery around the view center
   * (docs/agents/tile-loading.md §3.2). Uses spare capacity only: nothing
   * starts while imagery for a drawn tile (or one blocking a level change)
   * still waits for a request slot; ancestors kept as fallbacks (`B_LOW`)
   * do not hold it back. At most
   * `PREFETCH_MAX_ACTIVE` downloads run, which the imagery dispatch leaves
   * free. Each tile is asked for once per provider.
   */
  prefetchNextLevel(imageryLimit: number): void {
    const provider = this.globe.imagery;
    if (!this.globe.prefetchImagery || !provider.prefetch || this.globe.freeze) return;
    for (const t of this.queues.img) if (t.img.bucket < B_LOW && !t.img.loading && this.globe.now >= t.img.retryAt) return;
    let free = Math.min(PREFETCH_MAX_ACTIVE, imageryLimit) - this.prefetchActive;
    if (free <= 0) return;

    const candidates: { tile: GlobeTile; foveation: number }[] = [];
    for (const t of this.globe.renderList) {
      // Settled tiles only: own imagery shown, children within the provider's range.
      if (t.keptForDetail || t.level + 1 > provider.maxZoom || t.imageryGen !== this.globe.imageryGen) continue;
      const foveation = this.globe.foveation(t);
      if (shouldPrefetchChildren(this.globe.computeSSE(t), this.globe.maxScreenSpaceError, foveation)) candidates.push({ tile: t, foveation });
    }
    candidates.sort((a, b) => a.foveation - b.foveation);

    const signal = this.prefetchAbort.signal;
    for (const { tile } of candidates) {
      for (let i = 0; i < 4 && free > 0; i++) {
        const level = tile.level + 1;
        const x = tile.x * 2 + (i & 1);
        const y = tile.y * 2 + (i >> 1);
        const child = tile.children?.[i];
        if (child && child.imageryGen === this.globe.imageryGen) continue;
        if (child && this.globe.outsideRegion(child)) continue;
        const key = `${level}/${x}/${y}`;
        if (this.prefetched.has(key)) continue;
        this.prefetched.add(key);
        if (this.prefetched.size > 4096) this.prefetched.delete(this.prefetched.values().next().value as string);
        free--;
        this.prefetchActive++;
        // With a persistent cache, prefetch into it (kept across sessions) instead of the HTTP cache.
        const store = this.globe.imageryStore;
        const warm =
          store && provider.requestBlob
            ? cachedRequest(store, tileKey('img', provider.id, level, x, y), signal, () => provider.requestBlob!(level, x, y, signal))
            : provider.prefetch(level, x, y, signal);
        warm
          .catch(() => undefined)
          .finally(() => {
            // A provider switch has reset the count already.
            if (!signal.aborted) this.prefetchActive--;
          });
      }
      if (free <= 0) break;
    }
  }

  resetPrefetch(): void {
    this.prefetchAbort.abort();
    this.prefetchAbort = new AbortController();
    this.prefetchActive = 0;
    this.prefetched.clear();
  }

  /** Marks a load as in flight; returns its controller. */
  private begin(kind: ChannelKind, tile: GlobeTile): AbortController {
    const controller = new AbortController();
    channelOf(tile, kind).loading = controller;
    this.active[kind].add(tile);
    return controller;
  }

  /** Clears the in-flight state of a load (after it was applied, discarded or failed). */
  private finish(kind: ChannelKind, tile: GlobeTile, controller: AbortController): void {
    const ch = channelOf(tile, kind);
    if (ch.loading === controller) {
      ch.loading = null;
      this.active[kind].delete(tile);
    }
  }

  /** Queues a finished load for upload; it keeps its slot until then (backpressure). */
  private enqueueReady(tile: GlobeTile, kind: ChannelKind, controller: AbortController, epoch: number, apply: () => void, discard: () => void): void {
    this.ready.push({ tile, kind, controller, epoch, apply, discard });
  }

  applyReady(): void {
    if (this.ready.length === 0) return;
    const start = performance.now();
    let applied = 0;
    let i = 0;
    for (; i < this.ready.length; i++) {
      if (applied >= APPLY_BUDGET || performance.now() - start > APPLY_BUDGET_MS) break;
      const item = this.ready[i];
      this.finish(item.kind, item.tile, item.controller);
      // Imagery that arrived although no longer wanted is still this tile's picture (providers on
      // HTTP/1.1 let started downloads finish rather than close the connection): keep it cached.
      // Its apply step drops results of a replaced provider.
      const keepLate = item.kind === 'img';
      if ((item.controller.signal.aborted && !keepLate) || item.epoch !== item.tile.epoch) {
        item.discard();
        continue;
      }
      item.apply();
      applied++;
    }
    this.ready = i >= this.ready.length ? [] : this.ready.slice(i);
  }

  private startGeometry(tile: GlobeTile): void {
    const controller = this.begin('geo', tile);
    const epoch = tile.epoch;
    const gen = this.globe.geometryGen;
    const terrain = this.globe.terrain;
    if (terrain) this.workers.registerTerrain(terrain);

    // Refinement should not wait on the network: build an interim mesh from an
    // ancestor's heights while the exact terrain downloads in the worker.
    let upsample: UpsampleSource | null = null;
    const src = this.globe.interimSource(tile);
    if (src === 'flat') {
      // Roots start flat (relief is invisible from orbit) so the globe shows up at once
      // instead of after the first, possibly slow, terrain download.
      const n = this.globe.segments + 1;
      upsample = { heights: new Float32Array(n * n), segments: this.globe.segments, level: tile.level, x: tile.x, y: tile.y };
    } else if (src) {
      upsample = { heights: src.heights!.slice(), segments: src.segments, level: src.level, x: src.x, y: src.y };
    }

    this.workers
      .build(
        {
          level: tile.level,
          x: tile.x,
          y: tile.y,
          segments: this.globe.segments,
          terrainId: terrain?.id ?? null,
          exaggeration: this.globe.exaggeration,
          clampToSeaLevel: true,
          upsample,
          // Meshes built ahead of need (siblings outside the view) do not download terrain yet.
          prefetch: tile.geo.bucket < B_LOW,
        },
        controller.signal,
        terrain ? terrainAffinity(terrain, tile.level, tile.x, tile.y, this.globe.segments) : undefined,
      )
      .then((built) => {
        this.enqueueReady(
          tile,
          'geo',
          controller,
          epoch,
          () => {
            if (gen !== this.globe.geometryGen) return;
            this.globe.content.applyGeometry(tile, built, gen);
            tile.dataLevel = !terrain ? tile.level : upsample ? (upsample.level === tile.level ? -1 : upsample.level) : tile.level;
            tile.geo.succeed();
          },
          () => undefined,
        );
      })
      .catch((err: unknown) => {
        this.finish('geo', tile, controller);
        if (controller.signal.aborted || isAbortError(err)) return;
        tile.geo.fail(performance.now());
        if (terrain && terrain === this.globe.terrain && gen === this.globe.geometryGen) this.reportTerrainError(tile, terrain, err as Error);
        else console.warn(`[Globe] geometry ${tile.key} failed:`, (err as Error).message);
      });
  }

  private startImagery(tile: GlobeTile): void {
    const controller = this.begin('img', tile);
    const epoch = tile.epoch;
    const gen = this.globe.imageryGen;
    this.requestImage(tile.level, tile.x, tile.y, controller.signal)
      .then((bitmap) => {
        this.enqueueReady(
          tile,
          'img',
          controller,
          epoch,
          () => {
            if (gen !== this.globe.imageryGen) {
              bitmap?.close();
              return;
            }
            if (bitmap && tile.level === MIN_LEVEL) this.globe.polarCaps.sampleCapColor(tile, bitmap);
            this.globe.content.applyImagery(tile, bitmap ? this.createTexture(tile, bitmap, false) : null, gen);
            tile.img.succeed();
          },
          () => bitmap?.close(),
        );
      })
      .catch((err: unknown) => {
        this.finish('img', tile, controller);
        if (controller.signal.aborted || isAbortError(err) || gen !== this.globe.imageryGen) return;
        this.reportImageryError(tile, err as Error);
        // Keep showing a magnified ancestor; the tile stays stale and is retried with backoff.
        tile.img.fail(performance.now());
      });
  }

  /**
   * A tile image from the provider, through the persistent cache when it is on and the provider
   * hands out encoded files (`requestBlob`): a stored file is decoded without a request (and
   * without a per-host slot), a downloaded one is stored.
   */
  private requestImage(level: number, x: number, y: number, signal: AbortSignal): Promise<ImageBitmap | null> {
    const provider = this.globe.imagery;
    const store = this.globe.imageryStore;
    if (!store || !provider.requestBlob) return provider.requestImage(level, x, y, signal);
    return cachedRequest(store, tileKey('img', provider.id, level, x, y), signal, () => provider.requestBlob!(level, x, y, signal)).then((blob) =>
      blob ? decodeImage(blob) : null,
    );
  }

  private startOverlay(tile: GlobeTile): void {
    const source = this.globe.overlaySource;
    if (!source) return;
    const controller = this.begin('ovl', tile);
    const epoch = tile.epoch;
    const version = source.version;
    source
      .requestOverlay(tile.level, tile.x, tile.y, controller.signal)
      .then((bitmap) => {
        this.enqueueReady(
          tile,
          'ovl',
          controller,
          epoch,
          () => {
            if (source !== this.globe.overlaySource) {
              bitmap?.close();
              return;
            }
            this.globe.content.applyOverlay(tile, bitmap ? this.createTexture(tile, bitmap, true) : null, version);
            tile.ovl.succeed();
          },
          () => bitmap?.close(),
        );
      })
      .catch((err: unknown) => {
        this.finish('ovl', tile, controller);
        if (controller.signal.aborted || isAbortError(err) || source !== this.globe.overlaySource) return;
        console.warn(`[Globe] overlay ${tile.key} failed:`, (err as Error).message);
        this.globe.content.applyOverlay(tile, null, version);
        tile.ovl.fail(performance.now());
      });
  }

  private reportImageryError(tile: GlobeTile, err: Error): void {
    this.imageryErrors++;
    if (this.imageryErrors <= 3) console.warn(`[Globe] imagery ${tile.key} failed:`, err.message);
    if (this.imageryErrors === 3) {
      console.warn('[Globe] further imagery errors are suppressed');
      this.globe.imageryError = new TerraViewError(
        'imagery-unreachable',
        `${this.globe.imagery.name} is unreachable (${err.message})`,
        { provider: this.globe.imagery.name, reason: err.message },
        { cause: err },
      );
      this.globe.onImageryError?.(this.globe.imageryError);
      this.globe.reportError?.('imagery', this.globe.imageryError);
    }
  }

  /** Same scheme as imagery: a few warnings, then one `terrain-unreachable` per terrain source. */
  private reportTerrainError(tile: GlobeTile, terrain: TerrainSource, err: Error): void {
    this.terrainErrors++;
    if (this.terrainErrors <= 3) console.warn(`[Globe] terrain ${tile.key} failed:`, err.message);
    if (this.terrainErrors === 3) {
      console.warn('[Globe] further terrain errors are suppressed');
      this.globe.terrainError = new TerraViewError(
        'terrain-unreachable',
        `${terrain.name} is unreachable (${err.message})`,
        { source: terrain.name, reason: err.message },
        { cause: err },
      );
      this.globe.reportError?.('terrain', this.globe.terrainError);
    }
  }

  private createTexture(tile: GlobeTile, bitmap: ImageBitmap, overlay: boolean): SharedTexture {
    const texture = new Texture(bitmap);
    texture.flipY = false;
    if (overlay) texture.premultiplyAlpha = false;
    texture.colorSpace = SRGBColorSpace;
    texture.wrapS = texture.wrapT = ClampToEdgeWrapping;
    texture.minFilter = LinearMipmapLinearFilter;
    texture.magFilter = LinearFilter;
    texture.generateMipmaps = true;
    texture.anisotropy = this.globe.maxAnisotropy;
    texture.needsUpdate = true;
    return new SharedTexture(texture, tile.level, tile.x, tile.y, bitmap.width * bitmap.height * 4 * 1.33);
  }
}
