import { describe, expect, it } from 'vitest';
import { LoadTracker, summarizeLoad, type LoadInputs } from '../src/viewer/loadState';

const quiet: LoadInputs = { globe: { loading: 0, queued: 0, waitingImagery: 0 }, imageryUnreachable: false, tilesets: 0, layers: 0 };

describe('summarizeLoad', () => {
  it('adds up globe requests, tiles and layers', () => {
    const s = summarizeLoad({ ...quiet, globe: { loading: 3, queued: 5, waitingImagery: 0 }, tilesets: 2, layers: 1 });
    expect(s).toEqual({ globe: 8, tilesets: 2, layers: 1, pending: 11, idle: false });
  });

  it('is idle when nothing is pending and the screen has its own imagery', () => {
    expect(summarizeLoad(quiet).idle).toBe(true);
  });

  it('is not idle while on-screen tiles still show a magnified ancestor', () => {
    const s = summarizeLoad({ ...quiet, globe: { loading: 0, queued: 0, waitingImagery: 4 } });
    expect(s.pending).toBe(0);
    expect(s.idle).toBe(false);
  });

  it('does not wait for imagery from a source reported unreachable', () => {
    expect(summarizeLoad({ ...quiet, globe: { loading: 0, queued: 0, waitingImagery: 4 }, imageryUnreachable: true }).idle).toBe(true);
  });

  it('ignores the globe while it is hidden (its statistics are not updated)', () => {
    const s = summarizeLoad({ ...quiet, globe: null, tilesets: 1 });
    expect(s.globe).toBe(0);
    expect(s.pending).toBe(1);
    expect(summarizeLoad({ ...quiet, globe: null }).idle).toBe(true);
  });

  it('waits for 3D Tiles and layer data', () => {
    expect(summarizeLoad({ ...quiet, tilesets: 1 }).idle).toBe(false);
    expect(summarizeLoad({ ...quiet, layers: 1 }).idle).toBe(false);
  });
});

describe('LoadTracker', () => {
  const busy = summarizeLoad({ ...quiet, globe: { loading: 2, queued: 0, waitingImagery: 0 } });
  const busier = summarizeLoad({ ...quiet, globe: { loading: 3, queued: 1, waitingImagery: 0 } });
  const idle = summarizeLoad(quiet);

  it('reports the first state, and idle at once when there is nothing to load', () => {
    expect(new LoadTracker().step(idle)).toEqual({ progress: true, idle: true });
    expect(new LoadTracker().step(busy)).toEqual({ progress: true, idle: false });
  });

  it('reports progress only on change', () => {
    const t = new LoadTracker();
    t.step(busy);
    expect(t.step(busy)).toEqual({ progress: false, idle: false });
    expect(t.step(busier)).toEqual({ progress: true, idle: false });
  });

  it('reports idle on the transition only, and again after the next burst', () => {
    const t = new LoadTracker();
    t.step(busy);
    expect(t.step(idle)).toEqual({ progress: true, idle: true });
    expect(t.step(idle)).toEqual({ progress: false, idle: false });
    expect(t.step(busy).idle).toBe(false);
    expect(t.step(idle).idle).toBe(true);
  });

  it('treats waiting for imagery as a change of state', () => {
    const t = new LoadTracker();
    t.step(idle);
    const waiting = summarizeLoad({ ...quiet, globe: { loading: 0, queued: 0, waitingImagery: 2 } });
    expect(t.step(waiting)).toEqual({ progress: true, idle: false });
    expect(t.step(idle)).toEqual({ progress: true, idle: true });
  });
});
