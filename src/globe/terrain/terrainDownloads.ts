/**
 * Terrain downloads of the mesh worker (docs/agents/tile-loading.md §3, §3.1). Dependency-free.
 *
 * One download serves every build job that needs the same terrain tile and is
 * kept in a small LRU cache once done. When the last job waiting for it is
 * cancelled, the download is aborted, so requests the view no longer needs do
 * not hold the server's connections.
 *
 * Sources that declare `maxRequestsPerHost` (HTTP/1.1 servers) take a slot of
 * the page-wide host queue first (`SlotClient`, shared with imagery). For
 * them, as for imagery, a download that has started is not aborted (that
 * would close the connection, and the next request pays a new handshake): it
 * finishes into the cache. Prefetches (exact terrain for interim meshes) take
 * a slot only if one is free, so they never hold back downloads a view needs;
 * a skipped prefetch is downloaded when the tile asks for its exact mesh.
 */
import { hostOf } from '../imagery/RequestScheduler';
import type { SlotClient } from '../requestSlots';

/** A download shared by the jobs that need it. */
export interface SharedLoad<T> {
  readonly promise: Promise<T>;
  readonly controller: AbortController;
  /** Jobs currently waiting for it; prefetches do not count. */
  waiters: number;
  settled: boolean;
  /** Started by a prefetch: takes a host slot only if one is free while no job waits. */
  readonly optional: boolean;
  /** Started without its signal (throttled host): cancelling no longer stops it, it finishes into the cache. */
  detached: boolean;
}

export function abortError(): Error {
  return new DOMException('Aborted', 'AbortError');
}

export function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}

export class LoadCache<T> {
  private readonly entries = new Map<string, SharedLoad<T>>();

  constructor(private readonly capacity: number) {}

  get size(): number {
    return this.entries.size;
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  /**
   * The load for `key` (refreshing its LRU position), or a new one started by
   * `start`. `optional`: started by a prefetch (see `SharedLoad.optional`).
   */
  get(key: string, start: (load: SharedLoad<T>) => Promise<T>, optional = false): SharedLoad<T> {
    const cached = this.entries.get(key);
    if (cached) {
      this.entries.delete(key);
      this.entries.set(key, cached);
      return cached;
    }
    const controller = new AbortController();
    // The entry exists before `start` runs, so the download can read its waiters.
    let settle!: { resolve: (v: T) => void; reject: (e: unknown) => void };
    const promise = new Promise<T>((resolve, reject) => (settle = { resolve, reject }));
    const entry: SharedLoad<T> = { promise, controller, waiters: 0, settled: false, optional, detached: false };
    promise.then(
      () => {
        entry.settled = true;
      },
      () => {
        entry.settled = true;
        if (this.entries.get(key) === entry) this.entries.delete(key);
      },
    );
    this.entries.set(key, entry);
    while (this.entries.size > this.capacity) this.entries.delete(this.entries.keys().next().value as string);
    start(entry).then(settle.resolve, settle.reject);
    return entry;
  }

  /**
   * Waits for a load on behalf of a job. If the job is cancelled while no
   * other job waits for the same data, the download is aborted as well,
   * unless it has already started on a throttled host (see the module comment).
   */
  wait(key: string, entry: SharedLoad<T>, signal?: AbortSignal): Promise<T> {
    if (!signal) return entry.promise;
    if (signal.aborted) return Promise.reject(abortError());
    entry.waiters++;
    return new Promise<T>((resolve, reject) => {
      let done = false;
      const release = (): boolean => {
        if (done) return false;
        done = true;
        entry.waiters--;
        signal.removeEventListener('abort', onAbort);
        return true;
      };
      const onAbort = (): void => {
        if (!release()) return;
        if (entry.waiters === 0 && !entry.settled) {
          entry.controller.abort();
          // A detached download goes on and its result stays useful; anything else is gone.
          if (!entry.detached && this.entries.get(key) === entry) this.entries.delete(key);
        }
        reject(abortError());
      };
      signal.addEventListener('abort', onAbort, { once: true });
      entry.promise.then(
        (value) => {
          if (release()) resolve(value);
        },
        (err: unknown) => {
          if (release()) reject(err);
        },
      );
    });
  }
}

/**
 * Runs the network part of a load (`read`: fetch and read the body) within
 * the host limit, if any. `read` receives the signal to pass to `fetch`:
 * the load's own when the host is not throttled, none once a throttled
 * download has started. A prefetch that finds no free slot rejects with an
 * `AbortError` (its callers ignore it).
 */
export async function throttledRead<R>(
  slots: SlotClient | null,
  url: string,
  limit: number | undefined,
  load: SharedLoad<unknown>,
  read: (signal: AbortSignal | undefined) => Promise<R>,
): Promise<R> {
  const signal = load.controller.signal;
  if (!limit || !slots) return read(signal);
  const host = hostOf(url);
  let release = await slots.acquire(host, limit, { signal, ifFree: load.optional && load.waiters === 0 });
  // A job may have joined the prefetch meanwhile: then it waits like any other download.
  if (!release && load.waiters > 0) release = await slots.acquire(host, limit, { signal });
  if (!release) throw abortError();
  load.detached = true;
  try {
    return await read(undefined);
  } finally {
    release();
  }
}
