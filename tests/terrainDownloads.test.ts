import { describe, expect, it } from 'vitest';
import { acquireRequestSlot, hostLoad } from '../src/globe/imagery/RequestScheduler';
import { SlotBroker, SlotClient } from '../src/globe/requestSlots';
import { LoadCache, throttledRead, type SharedLoad } from '../src/globe/terrain/terrainDownloads';

const tick = () => new Promise((r) => setTimeout(r, 0));
const ticks = async (n: number) => {
  for (let i = 0; i < n; i++) await tick();
};

function deferred<T = string>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A worker's client wired to its main-thread broker, messages delivered asynchronously like postMessage. */
function workerPair() {
  let broker!: SlotBroker;
  const client = new SlotClient((m) => setTimeout(() => broker.receive(m), 0));
  broker = new SlotBroker((m) => setTimeout(() => client.receive(m), 0));
  return { client, broker };
}

/** A fake server: each `read` waits for the test to finish it and records the signal it was given. */
function fakeServer() {
  const calls: { url: string; signal: AbortSignal | undefined; done: ReturnType<typeof deferred<string>> }[] = [];
  const read = (url: string) => (signal: AbortSignal | undefined) => {
    const done = deferred();
    calls.push({ url, signal, done });
    signal?.addEventListener('abort', () => done.reject(new DOMException('Aborted', 'AbortError')));
    return done.promise;
  };
  return { calls, read };
}

describe('acquireRequestSlot', () => {
  it('gives an ifFree request a slot only when one is free and nobody waits', async () => {
    const host = 'iffree.test';
    const a = (await acquireRequestSlot(host, { limit: 1 }))!;
    expect(await acquireRequestSlot(host, { limit: 1, ifFree: true })).toBeNull();
    a();
    const b = await acquireRequestSlot(host, { limit: 1, ifFree: true });
    expect(b).toBeTypeOf('function');
    b!();
    b!(); // releasing twice frees one slot only
    expect(hostLoad(host)).toMatchObject({ active: 0, waiting: 0 });
  });
});

describe('request slots across workers', () => {
  it('holds one per-host limit for all workers, the rest granted in order', async () => {
    const host = 'workers.test';
    const w1 = workerPair();
    const w2 = workerPair();
    const order: string[] = [];
    const take = (w: ReturnType<typeof workerPair>, name: string) =>
      w.client.acquire(host, 2).then((release) => {
        order.push(name);
        return release!;
      });
    const r1 = take(w1, 'a');
    const r2 = take(w2, 'b');
    await ticks(2);
    const r3 = take(w1, 'c');
    const r4 = take(w2, 'd');
    await ticks(2);
    expect(order).toEqual(['a', 'b']);
    expect(hostLoad(host)).toMatchObject({ active: 2, waiting: 2 });
    (await r2)();
    await ticks(3);
    expect(order).toEqual(['a', 'b', 'c']);
    (await r1)();
    (await r3)();
    (await r4)();
    await ticks(2);
    expect(hostLoad(host)).toMatchObject({ active: 0, waiting: 0 });
  });

  it('withdraws a waiting request when aborted and frees a grant that crossed the abort', async () => {
    const host = 'withdraw.test';
    const w = workerPair();
    const held = (await w.client.acquire(host, 1))!;
    const c = new AbortController();
    const waiting = w.client.acquire(host, 1, { signal: c.signal });
    await ticks(2);
    expect(hostLoad(host).waiting).toBe(1);
    c.abort();
    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
    await ticks(2);
    expect(hostLoad(host)).toMatchObject({ active: 1, waiting: 0 });

    // Abort right after the broker granted: the grant is ignored, the slot comes back.
    held();
    const c2 = new AbortController();
    const late = w.client.acquire(host, 1, { signal: c2.signal });
    await tick(); // acquire delivered and granted; the grant message is in flight
    c2.abort();
    await expect(late).rejects.toMatchObject({ name: 'AbortError' });
    await ticks(2);
    expect(hostLoad(host)).toMatchObject({ active: 0, waiting: 0 });
    expect(w.broker.size).toBe(0);
  });

  it('gives back held and waiting slots when the worker goes away', async () => {
    const host = 'dispose.test';
    const w = workerPair();
    await w.client.acquire(host, 1);
    void w.client.acquire(host, 1);
    await ticks(2);
    expect(hostLoad(host)).toMatchObject({ active: 1, waiting: 1 });
    w.broker.dispose();
    expect(hostLoad(host)).toMatchObject({ active: 0, waiting: 0 });
  });
});

describe('terrain downloads', () => {
  it('shares one download and aborts it when the last waiting job is cancelled (unthrottled)', async () => {
    const cache = new LoadCache<string>(8);
    const server = fakeServer();
    const start = (load: SharedLoad<string>) => throttledRead(null, 'https://h2.test/1', undefined, load, server.read('1'));
    const j1 = new AbortController();
    const j2 = new AbortController();
    const p1 = cache.wait('k', cache.get('k', start), j1.signal);
    const p2 = cache.wait('k', cache.get('k', start), j2.signal);
    expect(server.calls).toHaveLength(1);
    j1.abort();
    await expect(p1).rejects.toMatchObject({ name: 'AbortError' });
    expect(server.calls[0].signal?.aborted).toBe(false);
    j2.abort();
    await expect(p2).rejects.toMatchObject({ name: 'AbortError' });
    expect(server.calls[0].signal?.aborted).toBe(true);
    expect(cache.has('k')).toBe(false);
  });

  it('keeps to the host limit and lets a started download finish into the cache when cancelled', async () => {
    const host = 'http1.test';
    const w = workerPair();
    const cache = new LoadCache<string>(8);
    const server = fakeServer();
    const load = (i: number, signal: AbortSignal) => {
      const entry = cache.get(String(i), (l) => throttledRead(w.client, `https://${host}/${i}`, 2, l, server.read(String(i))));
      return cache.wait(String(i), entry, signal);
    };
    const jobs = [0, 1, 2].map(() => new AbortController());
    const results = jobs.map((j, i) => load(i, j.signal));
    results.forEach((r) => r.catch(() => undefined));
    await ticks(4);
    expect(server.calls.map((c) => c.url)).toEqual(['0', '1']);
    // Started on a throttled host: fetched without a signal.
    expect(server.calls[0].signal).toBeUndefined();

    // Cancelling the started download does not stop it; cancelling the waiting one withdraws it.
    jobs[0].abort();
    jobs[2].abort();
    await expect(results[0]).rejects.toMatchObject({ name: 'AbortError' });
    await expect(results[2]).rejects.toMatchObject({ name: 'AbortError' });
    expect(cache.has('0')).toBe(true);
    expect(cache.has('2')).toBe(false);
    server.calls[0].done.resolve('zero');
    server.calls[1].done.resolve('one');
    expect(await results[1]).toBe('one');
    await ticks(4);
    expect(server.calls).toHaveLength(2);
    // The late result serves the next job without a new request.
    expect(await load(0, new AbortController().signal)).toBe('zero');
    expect(server.calls).toHaveLength(2);
    expect(hostLoad(host)).toMatchObject({ active: 0, waiting: 0 });
  });

  it('skips a prefetch while the host is busy, unless a job joins it', async () => {
    const host = 'prefetch.test';
    const w = workerPair();
    const cache = new LoadCache<string>(8);
    const server = fakeServer();
    const start = (key: string) => (l: SharedLoad<string>) => throttledRead(w.client, `https://${host}/${key}`, 1, l, server.read(key));

    const busy = cache.wait('busy', cache.get('busy', start('busy')), new AbortController().signal);
    await ticks(3);
    expect(server.calls).toHaveLength(1);

    // A prefetch (no waiting job) finds no free slot: dropped, and gone from the cache.
    const skipped = cache.get('p1', start('p1'), true);
    await expect(skipped.promise).rejects.toMatchObject({ name: 'AbortError' });
    expect(cache.has('p1')).toBe(false);

    // A job joins a prefetch before the broker answers: it waits for a slot like any download.
    const joined = cache.get('p2', start('p2'), true);
    const job = cache.wait('p2', joined, new AbortController().signal);
    await ticks(4);
    expect(cache.has('p2')).toBe(true);
    expect(hostLoad(host)).toMatchObject({ active: 1, waiting: 1 });
    server.calls[0].done.resolve('b');
    expect(await busy).toBe('b');
    await ticks(4);
    expect(server.calls.map((c) => c.url)).toEqual(['busy', 'p2']);
    server.calls[1].done.resolve('p');
    expect(await job).toBe('p');

    // Host idle: a prefetch goes ahead.
    const free = cache.get('p3', start('p3'), true);
    await ticks(4);
    expect(server.calls).toHaveLength(3);
    server.calls[2].done.resolve('q');
    expect(await free.promise).toBe('q');
    await ticks(2);
    expect(hostLoad(host)).toMatchObject({ active: 0, waiting: 0 });
  });
});
