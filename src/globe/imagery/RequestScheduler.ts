/**
 * Per-host request throttling for tile servers (CesiumJS `RequestScheduler`,
 * simplified). Dependency-free. Imagery uses it on the main thread; the
 * terrain workers ask the main thread for slots (`requestSlots.ts`), so one
 * limit per host holds across imagery, terrain, workers and viewers of a page.
 *
 * Browsers open about 6 connections per host to an HTTP/1.1 server. Requests
 * beyond that wait inside the browser's network stack, first come first
 * served: the globe's priorities (view center first, blocking content first)
 * no longer apply there, and requests for tiles that have since left the view
 * hold back the ones the user now looks at. Limiting per host keeps the
 * waiting on our side, where waiting requests are dropped the moment they are
 * aborted.
 *
 * A request that has started is not aborted by default: cancelling an
 * HTTP/1.1 response closes its connection, and the next request then pays a
 * new TCP + TLS handshake (often longer than the rest of the download). Its
 * result still arrives and can be cached.
 */

interface Waiter {
  resolve: () => void;
  signal?: AbortSignal;
  onAbort: () => void;
}

interface HostQueue {
  limit: number;
  active: number;
  readonly waiting: Waiter[];
}

const hosts = new Map<string, HostQueue>();

function abortError(): DOMException {
  return new DOMException('The request was aborted.', 'AbortError');
}

/** Host (with port) of a URL, or '' when it cannot be parsed. */
export function hostOf(url: string): string {
  try {
    return new URL(url, typeof location !== 'undefined' ? location.href : undefined).host;
  } catch {
    return '';
  }
}

export interface SlotOptions {
  /** Requests in flight to this host at most (the lowest limit given for a host wins). */
  limit: number;
  /** Aborting before the slot is granted rejects with an `AbortError` and frees its place at once. */
  signal?: AbortSignal;
  /**
   * Take a slot only if one is free now and nobody waits for one; otherwise
   * resolve to null at once (prefetches that must not hold back needed requests).
   */
  ifFree?: boolean;
}

export interface ScheduleOptions extends Omit<SlotOptions, 'ifFree'> {
  /** Also abort a request that has already started (default false, see the module comment). */
  abortStarted?: boolean;
}

/**
 * Waits for one of `limit` request slots of `host`; waiting requests are
 * granted in the order they asked. Resolves to the function that gives the
 * slot back (call it exactly once, when the response body has been read), or
 * to null when `ifFree` and no slot is free.
 */
export async function acquireRequestSlot(host: string, options: SlotOptions): Promise<(() => void) | null> {
  const { signal } = options;
  if (signal?.aborted) throw abortError();
  let q = hosts.get(host);
  if (!q) {
    q = { limit: options.limit, active: 0, waiting: [] };
    hosts.set(host, q);
  }
  q.limit = Math.max(1, Math.min(q.limit, options.limit));
  const queue = q;

  if (queue.active < queue.limit && queue.waiting.length === 0) {
    queue.active++;
  } else if (options.ifFree) {
    return null;
  } else {
    // Wait for a slot; `release` hands it over without decrementing `active`.
    await new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        resolve,
        signal,
        onAbort: () => {
          const i = queue.waiting.indexOf(waiter);
          if (i >= 0) queue.waiting.splice(i, 1);
          reject(abortError());
        },
      };
      signal?.addEventListener('abort', waiter.onAbort, { once: true });
      queue.waiting.push(waiter);
    });
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = queue.waiting.shift();
    if (next) {
      next.signal?.removeEventListener('abort', next.onAbort);
      next.resolve();
    } else {
      queue.active--;
    }
  };
}

/**
 * Runs `run` once fewer than `limit` requests to `host` are in flight; waiting
 * requests start in the order they were scheduled.
 *
 * @param run Receives the signal to pass to `fetch`: the caller's when
 * `abortStarted`, otherwise none.
 */
export async function scheduleRequest<T>(host: string, options: ScheduleOptions, run: (signal: AbortSignal | undefined) => Promise<T>): Promise<T> {
  const release = (await acquireRequestSlot(host, options))!;
  try {
    return await run(options.abortStarted ? options.signal : undefined);
  } finally {
    release();
  }
}

/** Requests in flight and waiting for a host (debugging and tests). */
export function hostLoad(host: string): { active: number; waiting: number; limit: number } {
  const q = hosts.get(host);
  return { active: q?.active ?? 0, waiting: q?.waiting.length ?? 0, limit: q?.limit ?? Infinity };
}
