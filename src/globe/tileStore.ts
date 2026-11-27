/**
 * Persistent tile cache (docs/agents/tile-loading.md §6.1): compressed tile files (imagery, raster
 * overlays, terrain) kept in IndexedDB across sessions, so a returning user, or one offline, does
 * not download them again. Off unless the host enables it (`GlobeOptions.persistentCache`): the
 * SDK touches browser storage only when asked to. Dependency-free (the mesh worker uses it too).
 *
 * Imagery is fetched on the main thread and terrain in the mesh workers; each context opens its
 * own connection to the same database. IndexedDB transactions on the same stores run one after the
 * other across contexts, so the running size total stays exact. Lookups happen before a request
 * takes a per-host slot (`RequestScheduler`), so cache hits cost no connection.
 *
 * The logic (expiry, batching, least-recently-used eviction) works on `TileStoreBackend`, so it is
 * unit tested with `MemoryTileBackend`; `openIndexedDbBackend` is the browser backend.
 */

/** Persistent tile cache settings (`GlobeOptions.persistentCache`). */
export interface PersistentCacheOptions {
  /**
   * IndexedDB database name. Viewers, and pages of the same origin, that use the same name share
   * one cache (and one size limit). Default 'terraview-tiles'.
   */
  name?: string;
  /** Most bytes of tile files kept; the least recently used go first. Default 512 MB. */
  maxBytes?: number;
  /** Tiles stored longer ago than this are downloaded again (days). Default 30. */
  maxAgeDays?: number;
  /** Cache base imagery and raster overlay tiles. Default true. */
  imagery?: boolean;
  /** Cache terrain tiles. Default true. */
  terrain?: boolean;
}

export type ResolvedCacheOptions = Required<PersistentCacheOptions>;

export const DEFAULT_CACHE_NAME = 'terraview-tiles';
const DEFAULT_MAX_BYTES = 512 * 1024 * 1024;
const DEFAULT_MAX_AGE_DAYS = 30;
const DAY_MS = 86_400_000;
/** A hit refreshes a tile's last-use time at most this often (each refresh is a write). */
const TOUCH_INTERVAL_MS = 3_600_000;
/** Writes are batched: flushed this long after the first queued one, or at this many. */
const FLUSH_DELAY_MS = 250;
const FLUSH_MAX = 32;
/** Eviction brings the total down to this share of `maxBytes`, so it does not run after every write. */
const EVICT_TO = 0.9;

/** `true` = defaults; `false` / undefined / null = off. */
export function resolveCacheOptions(options: boolean | PersistentCacheOptions | null | undefined): ResolvedCacheOptions | null {
  if (!options) return null;
  const o = options === true ? {} : options;
  return {
    name: o.name ?? DEFAULT_CACHE_NAME,
    maxBytes: Math.max(1, o.maxBytes ?? DEFAULT_MAX_BYTES),
    maxAgeDays: Math.max(0, o.maxAgeDays ?? DEFAULT_MAX_AGE_DAYS),
    imagery: o.imagery ?? true,
    terrain: o.terrain ?? true,
  };
}

/** A stored tile file. Times are `Date.now()` milliseconds. */
export interface StoredTile {
  blob: Blob;
  size: number;
  stored: number;
  used: number;
}

export interface TileStoreUsage {
  /** Bytes of tile files stored. */
  bytes: number;
  count: number;
}

/** Storage under `TileStore`. All methods may reject; `TileStore` treats failures as misses. */
export interface TileStoreBackend {
  get(key: string): Promise<StoredTile | null>;
  /** Stores tiles (replacing any with the same key) and refreshes last-use times in one transaction; resolves to the total bytes after it. */
  write(puts: readonly { key: string; blob: Blob; stored: number }[], touches: readonly { key: string; used: number }[]): Promise<number>;
  /** Deletes the least recently used tiles until at most `bytes` remain; resolves to the total after it. */
  evict(bytes: number): Promise<number>;
  usage(): Promise<TileStoreUsage>;
  clear(): Promise<void>;
  close(): void;
}

function abortError(): Error {
  return new DOMException('Aborted', 'AbortError');
}

/** The persistent cache as the host sees it (`Globe.persistentCache`). */
export interface PersistentTileCache {
  readonly options: Readonly<ResolvedCacheOptions>;
  /** Lookups answered from the cache and lookups that were not, on this page's main thread (imagery, overlays; terrain is counted in the workers). */
  readonly hits: number;
  readonly misses: number;
  /** Bytes and number of tiles stored (all viewers and pages sharing the database). */
  usage(): Promise<TileStoreUsage>;
  /** Deletes every stored tile. */
  clear(): Promise<void>;
}

/** Expiry, write batching and eviction over a backend (see the module comment). */
export class TileStore implements PersistentTileCache {
  hits = 0;
  misses = 0;
  private readonly queue = new Map<string, { blob: Blob; stored: number }>();
  private readonly touches = new Map<string, number>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private flushing: Promise<void> = Promise.resolve();
  private writable = true;
  private closed = false;

  constructor(
    private readonly backend: Promise<TileStoreBackend | null>,
    readonly options: Readonly<ResolvedCacheOptions>,
    private readonly now: () => number = Date.now,
  ) {
    // An unavailable backend (no IndexedDB, private mode, blocked) leaves an inert cache.
    backend.catch(() => undefined);
  }

  /** The stored file for `key`, or null when absent, expired or unreadable. */
  async get(key: string): Promise<Blob | null> {
    const queued = this.queue.get(key);
    if (queued) {
      this.hits++;
      return queued.blob;
    }
    let tile: StoredTile | null = null;
    try {
      const backend = await this.backend;
      tile = backend && !this.closed ? await backend.get(key) : null;
    } catch {
      tile = null;
    }
    const now = this.now();
    if (!tile || now - tile.stored > this.options.maxAgeDays * DAY_MS) {
      this.misses++;
      return null;
    }
    this.hits++;
    if (now - tile.used > TOUCH_INTERVAL_MS) {
      this.touches.set(key, now);
      this.schedule();
    }
    return tile.blob;
  }

  /** Stores a downloaded file (batched; never throws). */
  put(key: string, blob: Blob): void {
    if (!this.writable || this.closed || blob.size === 0 || blob.size > this.options.maxBytes) return;
    this.queue.set(key, { blob, stored: this.now() });
    this.touches.delete(key);
    if (this.queue.size >= FLUSH_MAX) void this.flush();
    else this.schedule();
  }

  private schedule(): void {
    if (this.timer || this.closed) return;
    this.timer = setTimeout(() => void this.flush(), FLUSH_DELAY_MS);
  }

  /** Writes what is queued now (and evicts if over the limit); resolves when done. */
  flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const puts = [...this.queue].map(([key, v]) => ({ key, blob: v.blob, stored: v.stored }));
    const touches = [...this.touches].map(([key, used]) => ({ key, used }));
    this.queue.clear();
    this.touches.clear();
    if (puts.length === 0 && touches.length === 0) return this.flushing;
    // One write at a time from this context, in order.
    this.flushing = this.flushing.then(() => this.write(puts, touches));
    return this.flushing;
  }

  private async write(puts: { key: string; blob: Blob; stored: number }[], touches: { key: string; used: number }[]): Promise<void> {
    let backend: TileStoreBackend | null = null;
    try {
      backend = await this.backend;
    } catch {
      return;
    }
    if (!backend || this.closed) return;
    const limit = this.options.maxBytes;
    try {
      const total = await backend.write(puts, touches);
      if (total > limit) await backend.evict(limit * EVICT_TO);
    } catch (err) {
      // Most likely over the browser's quota: make room and try once more, then stop writing.
      try {
        const { bytes } = await backend.usage();
        await backend.evict(Math.min(limit, bytes) * 0.5);
        const total = await backend.write(puts, touches);
        if (total > limit) await backend.evict(limit * EVICT_TO);
      } catch {
        this.writable = false;
        console.warn('[TileStore] persistent tile cache stopped writing:', (err as Error)?.message ?? err);
      }
    }
  }

  async usage(): Promise<TileStoreUsage> {
    await this.flush();
    try {
      const backend = await this.backend;
      return backend ? await backend.usage() : { bytes: 0, count: 0 };
    } catch {
      return { bytes: 0, count: 0 };
    }
  }

  async clear(): Promise<void> {
    this.queue.clear();
    this.touches.clear();
    await this.flushing;
    try {
      const backend = await this.backend;
      await backend?.clear();
    } catch {
      // Nothing stored to clear.
    }
  }

  /** Writes what is queued, then closes the connection. */
  async close(): Promise<void> {
    if (this.closed) return;
    await this.flush();
    this.closed = true;
    try {
      (await this.backend)?.close();
    } catch {
      // Never opened.
    }
  }
}

/**
 * The tile file for `key`: from the cache when stored there, otherwise from `request` (then stored).
 * `store` null = no cache. A null result (tile missing on the server) is not stored.
 */
export async function cachedRequest(store: TileStore | null, key: string, signal: AbortSignal | undefined, request: () => Promise<Blob | null>): Promise<Blob | null> {
  if (store) {
    const hit = await store.get(key);
    if (signal?.aborted) throw abortError();
    if (hit) return hit;
  }
  const blob = await request();
  if (blob && store) store.put(key, blob);
  return blob;
}

/** Cache key of a tile: kind ('img' imagery / overlays, 'dem' terrain), source id and tile address. */
export function tileKey(kind: 'img' | 'dem', sourceId: string, z: number, x: number, y: number): string {
  return `${kind}:${sourceId}/${z}/${x}/${y}`;
}

// -----------------------------------------------------------------------------
// Backends

/** In-memory backend (tests, and a model of what the IndexedDB one does). */
export class MemoryTileBackend implements TileStoreBackend {
  readonly tiles = new Map<string, StoredTile>();

  async get(key: string): Promise<StoredTile | null> {
    return this.tiles.get(key) ?? null;
  }

  async write(puts: readonly { key: string; blob: Blob; stored: number }[], touches: readonly { key: string; used: number }[]): Promise<number> {
    for (const p of puts) this.tiles.set(p.key, { blob: p.blob, size: p.blob.size, stored: p.stored, used: p.stored });
    for (const t of touches) {
      const tile = this.tiles.get(t.key);
      if (tile) tile.used = t.used;
    }
    return this.total();
  }

  async evict(bytes: number): Promise<number> {
    const byUse = [...this.tiles].sort((a, b) => a[1].used - b[1].used);
    let total = this.total();
    for (const [key, tile] of byUse) {
      if (total <= bytes) break;
      this.tiles.delete(key);
      total -= tile.size;
    }
    return total;
  }

  async usage(): Promise<TileStoreUsage> {
    return { bytes: this.total(), count: this.tiles.size };
  }

  async clear(): Promise<void> {
    this.tiles.clear();
  }

  close(): void {}

  private total(): number {
    let n = 0;
    for (const t of this.tiles.values()) n += t.size;
    return n;
  }
}

const DB_VERSION = 1;
const TILES = 'tiles';
const META = 'meta';
const TOTALS = 'totals';
const ALL = 'all';

interface MetaRecord {
  key: string;
  size: number;
  stored: number;
  used: number;
}

interface TotalsRecord {
  key: typeof ALL;
  bytes: number;
  count: number;
}

function request<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function completion(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? abortError());
  });
}

/**
 * IndexedDB backend. Stores: 'tiles' (key → file), 'meta' (key → size and times, indexed by last
 * use for eviction) and 'totals' (running byte and tile count). Resolves to null where IndexedDB
 * is unavailable.
 */
export async function openIndexedDbBackend(name: string): Promise<TileStoreBackend | null> {
  const idb = (globalThis as { indexedDB?: IDBFactory }).indexedDB;
  if (!idb) return null;
  const open = idb.open(name, DB_VERSION);
  open.onupgradeneeded = () => {
    const db = open.result;
    if (!db.objectStoreNames.contains(TILES)) db.createObjectStore(TILES, { keyPath: 'key' });
    if (!db.objectStoreNames.contains(META)) db.createObjectStore(META, { keyPath: 'key' }).createIndex('used', 'used');
    if (!db.objectStoreNames.contains(TOTALS)) db.createObjectStore(TOTALS, { keyPath: 'key' });
  };
  const db = await request(open);
  // Another page upgrading or deleting the database: step aside.
  db.onversionchange = () => db.close();

  const totalsOf = async (store: IDBObjectStore): Promise<TotalsRecord> =>
    ((await request(store.get(ALL))) as TotalsRecord | undefined) ?? { key: ALL, bytes: 0, count: 0 };

  return {
    async get(key) {
      const tx = db.transaction([TILES, META], 'readonly');
      const [file, meta] = await Promise.all([
        request(tx.objectStore(TILES).get(key)) as Promise<{ blob: Blob } | undefined>,
        request(tx.objectStore(META).get(key)) as Promise<MetaRecord | undefined>,
      ]);
      return file && meta ? { blob: file.blob, size: meta.size, stored: meta.stored, used: meta.used } : null;
    },

    async write(puts, touches) {
      const tx = db.transaction([TILES, META, TOTALS], 'readwrite');
      const done = completion(tx);
      const tiles = tx.objectStore(TILES);
      const meta = tx.objectStore(META);
      const totals = tx.objectStore(TOTALS);
      const t = await totalsOf(totals);
      for (const p of puts) {
        const old = (await request(meta.get(p.key))) as MetaRecord | undefined;
        if (old) {
          t.bytes -= old.size;
          t.count--;
        }
        tiles.put({ key: p.key, blob: p.blob });
        meta.put({ key: p.key, size: p.blob.size, stored: p.stored, used: p.stored } satisfies MetaRecord);
        t.bytes += p.blob.size;
        t.count++;
      }
      for (const touch of touches) {
        const m = (await request(meta.get(touch.key))) as MetaRecord | undefined;
        if (m && touch.used > m.used) meta.put({ ...m, used: touch.used });
      }
      totals.put(t);
      await done;
      return t.bytes;
    },

    async evict(bytes) {
      const tx = db.transaction([TILES, META, TOTALS], 'readwrite');
      const done = completion(tx);
      const tiles = tx.objectStore(TILES);
      const meta = tx.objectStore(META);
      const totals = tx.objectStore(TOTALS);
      const t = await totalsOf(totals);
      if (t.bytes > bytes) {
        await new Promise<void>((resolve, reject) => {
          const cursor = meta.index('used').openCursor();
          cursor.onerror = () => reject(cursor.error);
          cursor.onsuccess = () => {
            const c = cursor.result;
            if (!c || t.bytes <= bytes) {
              resolve();
              return;
            }
            const m = c.value as MetaRecord;
            tiles.delete(m.key);
            c.delete();
            t.bytes -= m.size;
            t.count--;
            c.continue();
          };
        });
        totals.put(t);
      }
      await done;
      return t.bytes;
    },

    async usage() {
      const tx = db.transaction([TOTALS], 'readonly');
      const t = await totalsOf(tx.objectStore(TOTALS));
      return { bytes: Math.max(0, t.bytes), count: Math.max(0, t.count) };
    },

    async clear() {
      const tx = db.transaction([TILES, META, TOTALS], 'readwrite');
      const done = completion(tx);
      tx.objectStore(TILES).clear();
      tx.objectStore(META).clear();
      tx.objectStore(TOTALS).clear();
      await done;
    },

    close() {
      db.close();
    },
  };
}

/** A cache on IndexedDB with these options (inert where IndexedDB is unavailable). */
export function openTileStore(options: ResolvedCacheOptions): TileStore {
  return new TileStore(openIndexedDbBackend(options.name).catch(() => null), options);
}
