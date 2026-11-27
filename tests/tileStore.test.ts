import { describe, expect, it } from 'vitest';
import {
  cachedRequest,
  MemoryTileBackend,
  resolveCacheOptions,
  TileStore,
  tileKey,
  type ResolvedCacheOptions,
  type TileStoreBackend,
} from '../src/globe/tileStore';

const DAY = 86_400_000;
const file = (bytes: number, fill = 1) => new Blob([new Uint8Array(bytes).fill(fill)]);

function setup(overrides: Partial<ResolvedCacheOptions> = {}) {
  let now = 1_000_000;
  const backend = new MemoryTileBackend();
  const options = { ...resolveCacheOptions(true)!, ...overrides };
  const store = new TileStore(Promise.resolve(backend), options, () => now);
  return { store, backend, advance: (ms: number) => (now += ms), at: () => now };
}

describe('persistent tile cache options', () => {
  it('is off unless asked for, with defaults for true', () => {
    expect(resolveCacheOptions(undefined)).toBeNull();
    expect(resolveCacheOptions(false)).toBeNull();
    expect(resolveCacheOptions(true)).toEqual({ name: 'terraview-tiles', maxBytes: 512 * 1024 * 1024, maxAgeDays: 30, imagery: true, terrain: true });
    expect(resolveCacheOptions({ terrain: false, maxBytes: 1e6 })).toMatchObject({ terrain: false, imagery: true, maxBytes: 1e6 });
  });

  it('keys tiles by kind, source and address', () => {
    expect(tileKey('img', 'osm', 3, 4, 5)).toBe('img:osm/3/4/5');
    expect(tileKey('dem', 'aws-terrarium', 9, 1, 2)).toBe('dem:aws-terrarium/9/1/2');
  });
});

describe('TileStore', () => {
  it('answers from the queue before it is written, then from the backend', async () => {
    const { store, backend } = setup();
    expect(await store.get('a')).toBeNull();
    store.put('a', file(10));
    expect((await store.get('a'))?.size).toBe(10);
    expect(backend.tiles.size).toBe(0);
    await store.flush();
    expect(backend.tiles.get('a')?.size).toBe(10);
    expect((await store.get('a'))?.size).toBe(10);
    expect([store.hits, store.misses]).toEqual([2, 1]);
    expect(await store.usage()).toEqual({ bytes: 10, count: 1 });
  });

  it('treats tiles older than maxAgeDays as missing; a new download replaces them', async () => {
    const { store, backend, advance } = setup({ maxAgeDays: 2 });
    store.put('a', file(10));
    await store.flush();
    advance(DAY);
    expect(await store.get('a')).not.toBeNull();
    advance(1.5 * DAY);
    expect(await store.get('a')).toBeNull();
    store.put('a', file(20));
    await store.flush();
    expect(backend.tiles.get('a')?.size).toBe(20);
    expect(await store.get('a')).not.toBeNull();
  });

  it('evicts the least recently used tiles to 90% of maxBytes once over it', async () => {
    const { store, backend, advance } = setup({ maxBytes: 100 });
    for (const k of ['a', 'b', 'c', 'd']) {
      store.put(k, file(20));
      advance(1000);
    }
    await store.flush();
    // 'a' is used again (refreshing its last use, after more than an hour), so 'b' is now the oldest.
    advance(2 * 3_600_000);
    expect(await store.get('a')).not.toBeNull();
    store.put('e', file(30));
    await store.flush();
    // 110 bytes > 100: drop the oldest until <= 90, which removing 'b' (not the refreshed 'a') achieves.
    expect([...backend.tiles.keys()].sort()).toEqual(['a', 'c', 'd', 'e']);
    expect((await store.usage()).bytes).toBe(90);
  });

  it('skips empty files and files larger than the whole cache', async () => {
    const { store, backend } = setup({ maxBytes: 50 });
    store.put('empty', new Blob([]));
    store.put('huge', file(60));
    await store.flush();
    expect(backend.tiles.size).toBe(0);
  });

  it('frees room and retries once when a write fails (quota), then stops writing', async () => {
    const backend = new MemoryTileBackend();
    let failures = 1;
    const flaky: TileStoreBackend = {
      get: (k) => backend.get(k),
      write: (p, t) => (failures-- > 0 ? Promise.reject(new DOMException('full', 'QuotaExceededError')) : backend.write(p, t)),
      evict: (b) => backend.evict(b),
      usage: () => backend.usage(),
      clear: () => backend.clear(),
      close: () => backend.close(),
    };
    const store = new TileStore(Promise.resolve(flaky), resolveCacheOptions(true)!);
    store.put('a', file(10));
    await store.flush();
    expect(backend.tiles.has('a')).toBe(true);

    failures = 2;
    const warn = console.warn;
    console.warn = () => undefined;
    store.put('b', file(10));
    await store.flush();
    console.warn = warn;
    expect(backend.tiles.has('b')).toBe(false);
    // No longer writing.
    failures = 0;
    store.put('c', file(10));
    await store.flush();
    expect(backend.tiles.has('c')).toBe(false);
  });

  it('is inert when the backend cannot be opened', async () => {
    const store = new TileStore(Promise.reject(new Error('no IndexedDB')), resolveCacheOptions(true)!);
    store.put('a', file(10));
    await store.flush();
    expect(await store.get('a')).toBeNull();
    expect(await store.usage()).toEqual({ bytes: 0, count: 0 });
  });

  it('clears everything, queued writes included', async () => {
    const { store, backend } = setup();
    store.put('a', file(10));
    await store.flush();
    store.put('b', file(10));
    await store.clear();
    await store.flush();
    expect(backend.tiles.size).toBe(0);
  });
});

describe('cachedRequest', () => {
  it('downloads on a miss and stores the file, then answers from the cache', async () => {
    const { store } = setup();
    let downloads = 0;
    const download = async () => {
      downloads++;
      return file(8);
    };
    expect((await cachedRequest(store, 'k', undefined, download))?.size).toBe(8);
    expect((await cachedRequest(store, 'k', undefined, download))?.size).toBe(8);
    expect(downloads).toBe(1);
  });

  it('does not store missing tiles, and works without a cache', async () => {
    const { store, backend } = setup();
    expect(await cachedRequest(store, 'missing', undefined, async () => null)).toBeNull();
    await store.flush();
    expect(backend.tiles.size).toBe(0);
    expect((await cachedRequest(null, 'k', undefined, async () => file(3)))?.size).toBe(3);
  });

  it('stops with an AbortError when aborted during the lookup', async () => {
    const { store } = setup();
    const c = new AbortController();
    const pending = cachedRequest(store, 'k', c.signal, async () => file(1));
    c.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });
});
