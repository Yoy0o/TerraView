import { BoxGeometry, Group, Mesh, MeshBasicMaterial, PerspectiveCamera, Scene, type BufferGeometry, type Matrix4 } from 'three';
import { describe, expect, it } from 'vitest';
import { Ellipsoid } from '../src/core/Ellipsoid';
import { BimEntity } from '../src/indoor/BimEntity';
import { IndoorManager, type IndoorHost } from '../src/indoor/IndoorManager';
import { EffectMarks, type EffectSource } from '../src/post/EffectMarks';
import {
  BUILTIN_OUTLINES,
  COLOR_GRADING_LIMITS,
  COLOR_GRADING_PRESETS,
  DEFAULT_SUPERSAMPLING_SAMPLES,
  DEFAULT_SUPERSAMPLING_SAMPLES_MSAA,
  gradingPassNeeded,
  halton,
  jitterOffset,
  MAX_SUPERSAMPLING_SAMPLES,
  MIN_SUPERSAMPLING_SAMPLES,
  normalizeGrading,
  normalizeSampleCount,
  sampleWeight,
  collectAttachments,
  edgeAlpha,
  edgeSamples,
  graphKey,
  mergeEffects,
  normalizeOutlineStyle,
  outlineMaskScale,
  outlineRadius,
  PULSE_MIN,
  pulseFactor,
  resolveEffects,
  sortEffects,
  type EffectOrderInfo,
  type ResolvedEffects,
} from '../src/post/postMath';

const fx = (name: string, stage: 'linear' | 'display', order: number, extra: Partial<EffectOrderInfo> = {}): EffectOrderInfo => ({
  name,
  stage,
  order,
  graphVersion: 0,
  ...extra,
});

describe('post pipeline rules', () => {
  it('orders linear effects before display effects, then by order, then by registration', () => {
    const list = [fx('outline', 'display', 100), fx('grade', 'linear', 200), fx('glow', 'linear', 100), fx('overlay', 'display', 100), fx('ao', 'linear', 50)];
    expect(sortEffects(list).map((e) => e.name)).toEqual(['ao', 'glow', 'grade', 'outline', 'overlay']);
  });

  it('collects each attachment once, without the color output', () => {
    const list = [fx('a', 'linear', 0, { attachments: ['normal', 'output'] }), fx('b', 'linear', 1, { attachments: ['velocity', 'normal'] })];
    expect(collectAttachments(list)).toEqual(['normal', 'velocity']);
    expect(collectAttachments([fx('c', 'display', 0)])).toEqual([]);
  });

  it('keys the graph by effect, version, attachments and output settings', () => {
    const a = [fx('glow', 'linear', 0), fx('outline', 'display', 0)];
    const key = graphKey(a, 'neutral');
    expect(graphKey([fx('glow', 'linear', 0), fx('outline', 'display', 0)], 'neutral')).toBe(key);
    expect(graphKey([fx('glow', 'linear', 0), fx('outline', 'display', 0, { graphVersion: 1 })], 'neutral')).not.toBe(key);
    expect(graphKey([fx('outline', 'display', 0)], 'neutral')).not.toBe(key);
    expect(graphKey(a, 'aces')).not.toBe(key);
    expect(graphKey([fx('glow', 'linear', 0, { attachments: ['normal'] }), fx('outline', 'display', 0)], 'neutral')).not.toBe(key);
  });
});

describe('per-object effects', () => {
  it('resolves to null when nothing is drawn', () => {
    expect(resolveEffects(null)).toBeNull();
    expect(resolveEffects({})).toBeNull();
    expect(resolveEffects({ glow: 0, outline: null })).toBeNull();
  });

  it('lets a highlight replace the own outline and keeps the glow', () => {
    expect(resolveEffects({ outline: 'alarm', glow: 0.5 }, 'select')).toEqual({ outline: 'select', glow: 0.5, glowColor: null });
    expect(resolveEffects({ outline: 'alarm' }, null)).toEqual({ outline: 'alarm', glow: 0, glowColor: null });
    expect(resolveEffects({}, 'hover')).toEqual({ outline: 'hover', glow: 0, glowColor: null });
  });

  it('clamps glow to 0..1 and ignores non-numbers', () => {
    expect(resolveEffects({ glow: 3 })!.glow).toBe(1);
    expect(resolveEffects({ glow: -1 })).toBeNull();
    expect(resolveEffects({ glow: Number.NaN })).toBeNull();
  });

  it('merges updates: undefined keeps a field, null clears it', () => {
    const cur = { outline: 'alarm', glow: 0.6, glowColor: '#f00' };
    expect(mergeEffects(cur, { glow: 0.2 })).toEqual({ outline: 'alarm', glow: 0.2, glowColor: '#f00' });
    expect(mergeEffects(cur, { outline: null, glowColor: undefined })).toEqual({ glow: 0.6, glowColor: '#f00' });
    expect(mergeEffects(cur, { glow: null })).toEqual({ outline: 'alarm', glowColor: '#f00' });
    expect(mergeEffects({}, { outline: 'select' })).toEqual({ outline: 'select' });
  });
});

describe('outline styles and edge search', () => {
  it('normalizes styles', () => {
    expect(normalizeOutlineStyle({ color: '#fff' })).toEqual({ color: '#fff', hiddenColor: null, fill: 0, pulse: 0 });
    expect(normalizeOutlineStyle({ color: '#fff', fill: 2, pulse: -1, hiddenColor: '#000' })).toEqual({ color: '#fff', hiddenColor: '#000', fill: 1, pulse: 0 });
    for (const name of ['select', 'hover', 'alarm']) expect(BUILTIN_OUTLINES[name]).toBeDefined();
    expect(BUILTIN_OUTLINES.alarm.pulse).toBeGreaterThan(0);
  });

  it('pulses between PULSE_MIN and full strength, steady without a period', () => {
    expect(pulseFactor(12.3, 0)).toBe(1);
    expect(pulseFactor(0, 2)).toBeCloseTo(1);
    expect(pulseFactor(1, 2)).toBeCloseTo(PULSE_MIN);
    expect(pulseFactor(2, 2)).toBeCloseTo(1);
    for (let t = 0; t < 3; t += 0.07) {
      const p = pulseFactor(t, 1.2);
      expect(p).toBeGreaterThanOrEqual(PULSE_MIN - 1e-9);
      expect(p).toBeLessThanOrEqual(1 + 1e-9);
    }
  });

  it('halves the mask on high-density screens and keeps the width in CSS pixels', () => {
    expect(outlineMaskScale(1)).toBe(1);
    expect(outlineMaskScale(1.5)).toBe(1);
    expect(outlineMaskScale(2)).toBe(2);
    expect(outlineRadius(2, 1)).toBe(2);
    expect(outlineRadius(2, 2)).toBe(2);
    expect(outlineRadius(2, 1.25)).toBeCloseTo(2.5);
    // Clamped to 1–6 CSS pixels.
    expect(outlineRadius(100, 1)).toBe(6);
    expect(outlineRadius(0, 1)).toBe(1);
  });

  it('searches every offset within reach, farthest first', () => {
    const s = edgeSamples(2);
    expect(s.some((x) => x.dx === 0 && x.dy === 0)).toBe(false);
    expect(s.every((x) => x.distance <= 2.5)).toBe(true);
    // Integer offsets within 2.5 px (a 5×5 square without the corners and the center).
    expect(s.length).toBe(20);
    for (let i = 1; i < s.length; i++) expect(s[i].distance).toBeLessThanOrEqual(s[i - 1].distance);
    expect(s[s.length - 1].distance).toBe(1);
    // Symmetric: every offset has its mirror.
    for (const x of s) expect(s.some((y) => y.dx === -x.dx && y.dy === -x.dy)).toBe(true);
  });

  it('fades the edge over its last half pixel', () => {
    expect(edgeAlpha(1, 2)).toBe(1);
    expect(edgeAlpha(2, 2)).toBeCloseTo(0.5);
    expect(edgeAlpha(Math.SQRT2 * 2, 2)).toBe(0);
  });
});

/** A source with fixed effects and one drawn mesh. */
function source(effects: ResolvedEffects | null, drawn = 1): EffectSource & { geometry: BufferGeometry } {
  const geometry = new BoxGeometry();
  const mesh = new Mesh(geometry);
  return {
    geometry,
    resolvedEffects: () => effects,
    collectDrawables: (add) => {
      for (let i = 0; i < drawn; i++) add(geometry, 0, mesh.matrixWorld);
    },
  };
}

describe('EffectMarks', () => {
  it('reports which effects are in use', () => {
    const marks = new EffectMarks(new Scene());
    const list: EffectSource[] = [];
    marks.extraSources = () => list;
    marks.refresh();
    expect([marks.hasOutline, marks.hasGlow, marks.pulsing]).toEqual([false, false, false]);
    list.push(source({ outline: 'select', glow: 0, glowColor: null }));
    marks.refresh();
    expect([marks.hasOutline, marks.hasGlow, marks.pulsing]).toEqual([true, false, false]);
    list.push(source({ outline: 'alarm', glow: 0.5, glowColor: null }));
    marks.refresh();
    expect([marks.hasOutline, marks.hasGlow, marks.pulsing]).toEqual([true, true, true]);
  });

  it('ignores unknown outline styles until they are defined', () => {
    const marks = new EffectMarks(new Scene());
    const s = source({ outline: 'custom', glow: 0, glowColor: null });
    marks.extraSources = () => [s];
    marks.refresh();
    expect(marks.hasOutline).toBe(false);
    expect(marks.gather(1)).toHaveLength(0);
    let changes = 0;
    marks.onChange = () => changes++;
    marks.defineOutline('custom', { color: '#00ff00', pulse: 2 });
    expect(changes).toBe(1);
    marks.refresh();
    expect(marks.hasOutline && marks.pulsing).toBe(true);
    const items = marks.gather(2);
    expect(items).toHaveLength(1);
    expect(items[0].outline!.name).toBe('custom');
    // Edge colors stay sRGB-encoded (composed after tone mapping); glow uses the linear color.
    expect(items[0].outline!.edge.g).toBeCloseTo(1);
    expect(marks.outlineStyle('custom')).toEqual({ color: '#00ff00', hiddenColor: null, fill: 0, pulse: 2 });
    expect(marks.outlineNames).toContain('custom');
  });

  it('gathers once per frame and takes the glow color from the outline, else white', () => {
    const marks = new EffectMarks(new Scene());
    const a = source({ outline: 'alarm', glow: 0.4, glowColor: null }, 2);
    const b = source({ outline: null, glow: 1, glowColor: null });
    const c = source({ outline: null, glow: 1, glowColor: '#0000ff' });
    marks.extraSources = () => [a, b, c];
    marks.refresh();
    const items = marks.gather(7);
    expect(items).toHaveLength(4);
    expect(items[0].glowColor.r).toBeGreaterThan(0.5);
    expect(items[0].glowColor.g).toBeLessThan(0.1);
    expect(items[2].glowColor.getHex()).toBe(0xffffff);
    expect(items[3].glowColor.b).toBeCloseTo(1);
    expect(items[3].glowColor.r).toBeCloseTo(0);
    expect(marks.gather(7)).toHaveLength(4);
  });

  it('draws three.js objects only while they are shown in the scene', () => {
    const scene = new Scene();
    const marks = new EffectMarks(scene);
    const group = new Group();
    const visible = new Mesh(new BoxGeometry(), new MeshBasicMaterial());
    const hidden = new Mesh(new BoxGeometry(), new MeshBasicMaterial());
    hidden.visible = false;
    group.add(visible, hidden);
    marks.set(group, { outline: 'select' });
    marks.refresh();
    expect(marks.hasOutline).toBe(true);
    // Not in the scene yet.
    expect(marks.gather(1)).toHaveLength(0);
    scene.add(group);
    expect(marks.gather(2).map((i) => i.geometry)).toEqual([visible.geometry]);
    group.visible = false;
    expect(marks.gather(3)).toHaveLength(0);
    group.visible = true;
    // Merging, then clearing a field; nothing left removes the object.
    marks.set(group, { glow: 0.5 });
    expect(marks.get(group)).toEqual({ outline: 'select', glow: 0.5 });
    marks.set(group, { outline: null, glow: null });
    expect(marks.get(group)).toEqual({});
    marks.refresh();
    expect(marks.hasOutline || marks.hasGlow).toBe(false);
    marks.set(group, { outline: 'hover' });
    marks.clear();
    marks.refresh();
    expect(marks.hasOutline).toBe(false);
  });
});

describe('entity effects', () => {
  it('merges effects, reports changes to the root and lets a highlight take over the outline', () => {
    const root = new BimEntity('b', 'building', 'B', '', {});
    const room = new BimEntity('r', 'room', 'R', '', {});
    root.add(room);
    const seen: BimEntity[] = [];
    let changes = 0;
    root.onEffects = (e) => seen.push(e);
    root.onChange = () => changes++;
    room.setEffects({ outline: 'alarm', glow: 0.3 });
    room.setEffects({ glow: 0.6 });
    expect(room.effects).toEqual({ outline: 'alarm', glow: 0.6 });
    expect(seen).toEqual([room, room]);
    expect(changes).toBe(2);
    room.highlight = 'select';
    expect(room.resolvedEffects()).toEqual({ outline: 'select', glow: 0.6, glowColor: null });
    room.highlight = null;
    expect(room.resolvedEffects()!.outline).toBe('alarm');
    room.effects = {};
    expect(room.resolvedEffects()).toBeNull();
  });

  it('collects the shown meshes of the entity and its descendants', () => {
    const floor = new BimEntity('f', 'floor', 'F', '', {});
    const room = new BimEntity('r', 'room', 'R', '', {});
    const other = new BimEntity('o', 'room', 'O', '', {});
    floor.add(room);
    floor.add(other);
    const mesh = (e: BimEntity) => {
      const m = new Mesh(new BoxGeometry(), new MeshBasicMaterial());
      e.group.add(m);
      e.meshes.push(m);
      return m;
    };
    const slab = mesh(floor);
    const roomMesh = mesh(room);
    const otherMesh = mesh(other);
    floor.group.updateMatrixWorld(true);
    const collect = (e: BimEntity) => {
      const out: BufferGeometry[] = [];
      e.collectDrawables((g: BufferGeometry, _s: number, _m: Matrix4) => out.push(g));
      return out;
    };
    expect(collect(floor)).toEqual([slab.geometry, roomMesh.geometry, otherMesh.geometry]);
    other.visible = false;
    expect(collect(floor)).toEqual([slab.geometry, roomMesh.geometry]);
    // Culled meshes are not drawn either.
    room.culled = true;
    expect(collect(floor)).toEqual([slab.geometry]);
    room.culled = false;
    // Nothing while an ancestor is hidden.
    floor.visible = false;
    expect(collect(room)).toEqual([]);
  });
});

const E = Ellipsoid.WGS84;

function indoorHost(): IndoorHost {
  const camera = new PerspectiveCamera(50, 1.5, 1, 1e8);
  return {
    ellipsoid: E,
    camera,
    markers: { add: () => ({ remove: () => undefined }) } as unknown as IndoorHost['markers'],
    groundHeight: () => 0,
    flyToView: () => Promise.resolve(),
    getCameraPose: () => ({ position: camera.position.clone(), heading: 0, pitch: -30 }),
    flyToPose: () => Promise.resolve(),
    setTilesetsVisible: () => undefined,
    loadModel: null,
    createLabelElement: () => ({}) as HTMLElement,
  };
}

const DOC = {
  format: 'three-geo-building',
  version: '1.0',
  id: 'fx',
  name: 'FX',
  anchor: { longitude: 116.39, latitude: 39.9, height: 0 },
  floors: [
    {
      id: 'f1',
      index: 0,
      elevation: 0,
      height: 4,
      rooms: [{ id: 'r1', name: 'Room 1', footprint: [[0, 0], [10, 0], [10, 8], [0, 8]] }],
      things: [
        { id: 't1', name: 'Cam 1', category: 'camera', position: [5, 4, 3] },
        { id: 't2', name: 'Cam 2', category: 'camera', position: [6, 4, 3] },
      ],
    },
  ],
};

describe('selection and hover outlines', () => {
  it('outline the selected and hovered entity instead of tinting it', () => {
    const indoor = new IndoorManager(indoorHost());
    const b = indoor.add(DOC);
    const room = indoor.getById('r1')!;
    const cam = indoor.getById('t1')!;
    indoor.select(room);
    expect(room.highlight).toBe('select');
    expect(room.style.emissive).toBeUndefined();
    indoor.setHovered(cam);
    expect(cam.highlight).toBe('hover');
    expect([...indoor.markedEntities]).toEqual([room, cam]);
    // Buildings are not outlined on hover.
    indoor.setHovered(b);
    expect(b.highlight).toBeNull();
    expect(cam.highlight).toBeNull();
    indoor.select(null);
    expect(room.highlight).toBeNull();
    expect(indoor.markedEntities.size).toBe(0);
  });

  it('use configurable styles, and own effects come back after the highlight', () => {
    const indoor = new IndoorManager(indoorHost());
    indoor.add(DOC);
    const cam = indoor.getById('t2')!;
    cam.setEffects({ outline: 'alarm' });
    indoor.selectOutline = 'focus';
    indoor.select(cam);
    expect(cam.resolvedEffects()!.outline).toBe('focus');
    indoor.selectOutline = null;
    expect(cam.resolvedEffects()!.outline).toBe('alarm');
    indoor.select(null);
    expect(indoor.markedEntities.has(cam)).toBe(true);
  });

  it('collect batched devices one instance at a time', () => {
    const indoor = new IndoorManager(indoorHost());
    const b = indoor.add(DOC);
    const cam = indoor.getById('t1')!;
    const out: Matrix4[] = [];
    // From outside, devices are hidden: nothing to draw.
    cam.collectDrawables((_g, _s, m) => out.push(m.clone()));
    expect(out).toHaveLength(0);
    b.traverse((e) => (e.visible = true));
    b.root.updateMatrixWorld(true);
    expect(cam.instances.length).toBe(1);
    cam.collectDrawables((_g, _s, m) => out.push(m.clone()));
    expect(out).toHaveLength(1);
    // The instance's world position is the device's (5, 4, 3) in the building frame, not the batch origin.
    const p = cam.labelPosition();
    const fromMatrix = out[0].elements.slice(12, 15);
    expect(Math.hypot(fromMatrix[0] - p.x, fromMatrix[1] - p.y, fromMatrix[2] - p.z)).toBeLessThan(5);
  });

  it('forget the entities of a removed building', () => {
    const indoor = new IndoorManager(indoorHost());
    const b = indoor.add(DOC);
    indoor.getById('t1')!.setEffects({ glow: 1 });
    expect(indoor.markedEntities.size).toBe(1);
    indoor.remove(b);
    expect(indoor.markedEntities.size).toBe(0);
  });
});

describe('still supersampling rules', () => {
  it('halton is the radical inverse', () => {
    expect([1, 2, 3, 4, 5].map((i) => halton(i, 2))).toEqual([0.5, 0.25, 0.75, 0.125, 0.625]);
    expect(halton(1, 3)).toBeCloseTo(1 / 3, 12);
    expect(halton(2, 3)).toBeCloseTo(2 / 3, 12);
    expect(halton(3, 3)).toBeCloseTo(1 / 9, 12);
    expect(halton(0, 2)).toBe(0);
  });

  it('sample 0 is not jittered; the others stay within half a pixel and are all different', () => {
    expect(jitterOffset(0)).toEqual([0, 0]);
    const seen = new Set<string>();
    for (let k = 1; k < 64; k++) {
      const [x, y] = jitterOffset(k);
      expect(x).toBeGreaterThanOrEqual(-0.5);
      expect(x).toBeLessThan(0.5);
      expect(y).toBeGreaterThanOrEqual(-0.5);
      expect(y).toBeLessThan(0.5);
      seen.add(`${x},${y}`);
    }
    expect(seen.size).toBe(63);
  });

  it('jitter of 16 samples covers the pixel evenly (each quadrant gets 3–5)', () => {
    const quadrants = [0, 0, 0, 0];
    for (let k = 0; k < 16; k++) {
      const [x, y] = jitterOffset(k);
      quadrants[(x < 0 ? 0 : 1) + (y < 0 ? 0 : 2)]++;
    }
    for (const n of quadrants) {
      expect(n).toBeGreaterThanOrEqual(3);
      expect(n).toBeLessThanOrEqual(5);
    }
    // Mean offset close to the pixel center (no shift of the whole picture).
    let mx = 0;
    let my = 0;
    for (let k = 0; k < 32; k++) {
      const [x, y] = jitterOffset(k);
      mx += x / 32;
      my += y / 32;
    }
    expect(Math.abs(mx)).toBeLessThan(0.06);
    expect(Math.abs(my)).toBeLessThan(0.06);
  });

  it('blending with sampleWeight keeps the plain mean of all samples', () => {
    const samples = [0.9, 0.1, 0.4, 0.7, 0.3, 1, 0, 0.55];
    let history = 123; // whatever the history held: the first sample replaces it
    samples.forEach((v, k) => {
      const w = sampleWeight(k);
      history = history * (1 - w) + v * w;
      const mean = samples.slice(0, k + 1).reduce((a, b) => a + b, 0) / (k + 1);
      expect(history).toBeCloseTo(mean, 12);
    });
    expect(sampleWeight(0)).toBe(1);
    expect(sampleWeight(3)).toBe(0.25);
  });

  it('sample counts: defaults by MSAA, rounded and kept within range', () => {
    expect(normalizeSampleCount(undefined, true)).toBe(DEFAULT_SUPERSAMPLING_SAMPLES_MSAA);
    expect(normalizeSampleCount(undefined, false)).toBe(DEFAULT_SUPERSAMPLING_SAMPLES);
    expect(normalizeSampleCount(Number.NaN, false)).toBe(DEFAULT_SUPERSAMPLING_SAMPLES);
    expect(normalizeSampleCount('8', true)).toBe(DEFAULT_SUPERSAMPLING_SAMPLES_MSAA);
    expect(normalizeSampleCount(1, true)).toBe(MIN_SUPERSAMPLING_SAMPLES);
    expect(normalizeSampleCount(1000, true)).toBe(MAX_SUPERSAMPLING_SAMPLES);
    expect(normalizeSampleCount(23.6, true)).toBe(24);
  });
});

describe('color grading rules', () => {
  it('keeps values within range and ignores invalid ones', () => {
    expect(normalizeGrading('contrast', 1.05)).toBe(1.05);
    expect(normalizeGrading('contrast', 5)).toBe(COLOR_GRADING_LIMITS.contrast[1]);
    expect(normalizeGrading('saturation', -1)).toBe(0);
    expect(normalizeGrading('exposure', 0)).toBe(COLOR_GRADING_LIMITS.exposure[0]);
    expect(normalizeGrading('exposure', Number.NaN)).toBe(1);
    expect(normalizeGrading('saturation', undefined, 1.2)).toBe(1.2);
  });

  it('needs the grading pass only for contrast or saturation', () => {
    expect(gradingPassNeeded(COLOR_GRADING_PRESETS.neutral)).toBe(false);
    expect(gradingPassNeeded({ ...COLOR_GRADING_PRESETS.neutral, exposure: 1.5 })).toBe(false);
    expect(gradingPassNeeded(COLOR_GRADING_PRESETS.vivid)).toBe(true);
    expect(gradingPassNeeded({ exposure: 1, contrast: 1, saturation: 0.9 })).toBe(true);
  });

  it('presets are within range', () => {
    for (const preset of Object.values(COLOR_GRADING_PRESETS)) {
      for (const key of ['exposure', 'contrast', 'saturation'] as const) expect(normalizeGrading(key, preset[key])).toBe(preset[key]);
    }
  });
});
