import { describe, expect, it } from 'vitest';
import {
  cloudFrameRate,
  DEFAULT_IDLE_FRAME_RATE,
  drawMode,
  FramePacer,
  MAX_IDLE_FRAME_RATE,
  MIN_IDLE_FRAME_RATE,
  normalizeIdleFrameRate,
  QUIET_MS,
} from '../src/viewer/framePacing';

/** Animation frames of a 60 Hz display from `start` for `ms`, and which of them the pacer runs. */
function run(pacer: FramePacer, start: number, ms: number, floorRate = 0): number[] {
  const drawn: number[] = [];
  const frames = Math.round((ms * 60) / 1000);
  for (let i = 0; i < frames; i++) {
    const t = start + (i * 1000) / 60;
    if (pacer.shouldTick(t, floorRate)) {
      pacer.ticked(t);
      drawn.push(t);
    }
  }
  return drawn;
}

describe('normalizeIdleFrameRate', () => {
  it('keeps 0 (throttling off) and values within 10–60', () => {
    expect(normalizeIdleFrameRate(0)).toBe(0);
    expect(normalizeIdleFrameRate(10)).toBe(10);
    expect(normalizeIdleFrameRate(24)).toBe(24);
    expect(normalizeIdleFrameRate(60)).toBe(60);
  });

  it('raises values below 10 and caps values above 60', () => {
    expect(normalizeIdleFrameRate(2)).toBe(MIN_IDLE_FRAME_RATE);
    expect(normalizeIdleFrameRate(0.5)).toBe(MIN_IDLE_FRAME_RATE);
    expect(normalizeIdleFrameRate(144)).toBe(MAX_IDLE_FRAME_RATE);
  });

  it('falls back to the default for anything else', () => {
    for (const v of [undefined, null, -1, Number.NaN, Infinity, '10', {}]) expect(normalizeIdleFrameRate(v)).toBe(DEFAULT_IDLE_FRAME_RATE);
  });
});

describe('FramePacer', () => {
  it('draws every frame at first and for a second after any activity', () => {
    const pacer = new FramePacer(10, 0);
    expect(run(pacer, 0, QUIET_MS - 20)).toHaveLength(59);
    expect(pacer.throttled).toBe(false);
  });

  it('drops to the idle rate once quiet, and reports it', () => {
    const pacer = new FramePacer(10, 0);
    run(pacer, 0, QUIET_MS);
    const drawn = run(pacer, QUIET_MS, 2000);
    expect(drawn.length).toBeGreaterThanOrEqual(19);
    expect(drawn.length).toBeLessThanOrEqual(21);
    expect(pacer.throttled).toBe(true);
  });

  it('spaces idle frames evenly at about 1 / rate', () => {
    const pacer = new FramePacer(10, 0);
    run(pacer, 0, QUIET_MS);
    const drawn = run(pacer, QUIET_MS + 200, 1000);
    for (let i = 1; i < drawn.length; i++) expect(drawn[i] - drawn[i - 1]).toBeCloseTo(100, -1);
  });

  it('goes back to every frame on activity, for another quiet period', () => {
    const pacer = new FramePacer(10, 0);
    run(pacer, 0, 3000);
    pacer.markChange(3000);
    expect(run(pacer, 3000, 500)).toHaveLength(30);
    expect(pacer.throttled).toBe(false);
  });

  it('never throttles with an idle frame rate of 0', () => {
    const pacer = new FramePacer(0, 0);
    expect(run(pacer, 0, 3000)).toHaveLength(180);
  });

  it('draws faster than the idle rate when something animating needs it, up to every frame', () => {
    const pacer = new FramePacer(10, 0);
    run(pacer, 0, QUIET_MS);
    const clouds = run(pacer, QUIET_MS, 1000, 30);
    expect(clouds.length).toBeGreaterThanOrEqual(29);
    expect(clouds.length).toBeLessThanOrEqual(31);
    expect(run(pacer, 3000, 1000, MAX_IDLE_FRAME_RATE)).toHaveLength(60);
    expect(pacer.throttled).toBe(false);
  });

  it('ignores activity stamped earlier than the latest', () => {
    const pacer = new FramePacer(10, 0);
    pacer.markChange(5000);
    pacer.markChange(1000);
    expect(pacer.shouldTick(5500)).toBe(true);
    expect(pacer.throttled).toBe(false);
  });
});

describe('FramePacer: changes, wakes and still views', () => {
  it('wakes run frames at the full rate for a second, like changes', () => {
    const pacer = new FramePacer(10, 0);
    run(pacer, 0, 3000);
    pacer.markWake(3000);
    expect(run(pacer, 3000, 500)).toHaveLength(30);
    expect(pacer.throttled).toBe(false);
    expect(run(pacer, 3000 + QUIET_MS, 1000).length).toBeLessThanOrEqual(11);
  });

  it('is still once nothing changed for QUIET_MS, and wakes do not end it', () => {
    const pacer = new FramePacer(10, 0);
    expect(pacer.isStill(QUIET_MS - 1)).toBe(false);
    expect(pacer.isStill(QUIET_MS)).toBe(true);
    // Pointer moves over a still view: frames at the full rate, the view still still.
    pacer.markWake(2000);
    expect(pacer.isStill(2100)).toBe(true);
    expect(pacer.shouldTick(2100)).toBe(true);
    expect(pacer.throttled).toBe(false);
    // A change: not still for another quiet period.
    pacer.markChange(2200);
    expect(pacer.changedAt).toBe(2200);
    expect(pacer.isStill(2200 + QUIET_MS - 1)).toBe(false);
    expect(pacer.isStill(2200 + QUIET_MS)).toBe(true);
  });

  it('is never still while something animates on its own or with throttling off', () => {
    const pacer = new FramePacer(10, 0);
    expect(pacer.isStill(5000, 0.5)).toBe(false);
    expect(pacer.isStill(5000, MAX_IDLE_FRAME_RATE)).toBe(false);
    expect(new FramePacer(0, 0).isStill(5000)).toBe(false);
  });

  it('runs every frame while a still view is refined, then the idle rate', () => {
    const pacer = new FramePacer(10, 0);
    run(pacer, 0, QUIET_MS);
    let refined = 0;
    for (let i = 0; i < 30; i++) {
      const t = QUIET_MS + (i * 1000) / 60;
      if (pacer.shouldTick(t, 0, true)) {
        pacer.ticked(t);
        refined++;
      }
    }
    expect(refined).toBe(30);
    expect(pacer.throttled).toBe(false);
    expect(run(pacer, QUIET_MS + 500, 1000).length).toBeLessThanOrEqual(11);
    expect(pacer.throttled).toBe(true);
  });
});

describe('drawMode', () => {
  it('draws live unless the view is still and supersampling is on', () => {
    expect(drawMode(false, true, 0, 16)).toBe('live');
    expect(drawMode(false, true, 16, 16)).toBe('live');
    expect(drawMode(true, false, 0, 16)).toBe('live');
  });

  it('takes samples up to the target, then holds the picture', () => {
    expect(drawMode(true, true, 0, 16)).toBe('sample');
    expect(drawMode(true, true, 15, 16)).toBe('sample');
    expect(drawMode(true, true, 16, 16)).toBe('hold');
    // Fewer samples asked for than taken: hold what is there.
    expect(drawMode(true, true, 32, 16)).toBe('hold');
  });
});

describe('cloudFrameRate', () => {
  const base = { speedDegPerSec: 0.5, layerRadius: 6_378_137 + 10_000, fovDeg: 50, viewportHeight: 1080 };

  it('matches the worked numbers (default drift, 1080 px, 50°)', () => {
    expect(cloudFrameRate({ ...base, distance: 490_000 })).toBeCloseTo(87.9, 0);
    expect(cloudFrameRate({ ...base, distance: 1_990_000 })).toBeCloseTo(21.6, 0);
    expect(cloudFrameRate({ ...base, distance: 19_990_000 })).toBeLessThan(DEFAULT_IDLE_FRAME_RATE);
  });

  it('scales with the drift speed (either direction) and is 0 without drift', () => {
    const a = cloudFrameRate({ ...base, distance: 1_000_000 });
    expect(cloudFrameRate({ ...base, distance: 1_000_000, speedDegPerSec: -1 })).toBeCloseTo(2 * a, 6);
    expect(cloudFrameRate({ ...base, distance: 1_000_000, speedDegPerSec: 0 })).toBe(0);
  });

  it('is 0 for a degenerate view (camera at or below the layer, no viewport)', () => {
    expect(cloudFrameRate({ ...base, distance: 0 })).toBe(0);
    expect(cloudFrameRate({ ...base, distance: -500 })).toBe(0);
    expect(cloudFrameRate({ ...base, distance: 1_000_000, viewportHeight: 0 })).toBe(0);
  });
});
