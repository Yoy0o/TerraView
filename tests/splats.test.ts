/**
 * Gaussian splats (docs/agents/splats.md): file decoders (.splat, .ply, .spz 2–4), the
 * budget, bounds and crop, placement math, CPU picking through the hierarchy, and the demo's
 * URL parameters.
 */
import { describe, expect, it } from 'vitest';
import { hasStartupFlight, parseSplatParams } from '../demo/ui/urlOptions';
import { isTerraViewError } from '../src/core/errors';
import { gpuProfile, GPU_TIERS } from '../src/core/gpuProfile';
import {
  budgetSplats,
  computeSplatBounds,
  cropSplats,
  limitShDegree,
  selectSplats,
  SH_C0,
  splatGpuBytes,
  splatImportance,
  writeCovariance,
  type SplatData,
} from '../src/splats/splatData';
import { decodePly, decodeSplatRows, decodeSplats, decodeSpz, detectSplatFormat } from '../src/splats/splatFormats';
import { buildSplatIndex, raycastSplats } from '../src/splats/splatIndex';
import { boxToLocal, resolvePivot, rotate3, rotate3Inverse, screenRadius, sphereInView, splatModelMatrix, upAxisMatrix, type SplatUpAxis } from '../src/splats/splatPlacement';

const cov = (sx: number, sy: number, sz: number, q: [number, number, number, number] = [0, 0, 0, 1]) => {
  const out = new Float32Array(6);
  writeCovariance(out, 0, sx, sy, sz, ...q);
  return out;
};

/** Splats from a list of { center, scale (isotropic), opacity 0..1 }. */
function makeSplats(list: { p: [number, number, number]; s?: number; a?: number }[]): SplatData {
  const count = list.length;
  const data: SplatData = { count, centers: new Float32Array(count * 3), covariances: new Float32Array(count * 6), colors: new Uint8Array(count * 4), shDegree: 0 };
  list.forEach((item, i) => {
    data.centers.set(item.p, i * 3);
    const s = item.s ?? 0.1;
    writeCovariance(data.covariances, i * 6, s, s, s, 0, 0, 0, 1);
    data.colors.set([200, 100, 50, Math.round((item.a ?? 1) * 255)], i * 4);
  });
  return data;
}

async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

describe('covariance', () => {
  it('is the squared scale on the diagonal without rotation', () => {
    const c = cov(1, 2, 3);
    expect([...c]).toEqual([1, 0, 0, 4, 0, 9]);
  });

  it('turns with the quaternion and normalizes it', () => {
    // 90 degrees about Z, not normalized: the x scale ends up along y.
    const h = Math.SQRT1_2 * 5;
    const c = cov(1, 2, 3, [0, 0, h, h]);
    expect(c[0]).toBeCloseTo(4, 5);
    expect(c[3]).toBeCloseTo(1, 5);
    expect(c[5]).toBeCloseTo(9, 5);
    expect(c[1]).toBeCloseTo(0, 5);
  });
});

describe('.splat', () => {
  it('decodes fixed 32-byte rows', () => {
    const bytes = new Uint8Array(64);
    const view = new DataView(bytes.buffer);
    [1, 2, 3, 0.5, 0.25, 2].forEach((v, i) => view.setFloat32(i * 4, v, true));
    bytes.set([10, 20, 30, 255], 24);
    // w, x, y, z: identity.
    bytes.set([255, 128, 128, 128], 28);
    [-1, -2, -3, 1, 1, 1].forEach((v, i) => view.setFloat32(32 + i * 4, v, true));
    bytes.set([1, 2, 3, 4, 255, 128, 128, 128], 56);
    const data = decodeSplatRows(bytes);
    expect(data.count).toBe(2);
    expect(data.shDegree).toBe(0);
    expect([...data.centers]).toEqual([1, 2, 3, -1, -2, -3]);
    expect([...data.colors]).toEqual([10, 20, 30, 255, 1, 2, 3, 4]);
    expect(data.covariances[0]).toBeCloseTo(0.25, 6);
    expect(data.covariances[3]).toBeCloseTo(0.0625, 6);
    expect(data.covariances[5]).toBeCloseTo(4, 6);
  });

  it('refuses a length that is not whole rows', () => {
    expect(() => decodeSplatRows(new Uint8Array(33))).toThrow(/multiple of 32/);
  });
});

/** A binary PLY as the INRIA trainer writes it, from rows of named float properties. */
function makePly(properties: string[], rows: number[][], extraHeader = ''): Uint8Array {
  const header = `ply\nformat binary_little_endian 1.0\n${extraHeader}element vertex ${rows.length}\n${properties.map((p) => `property float ${p}`).join('\n')}\nend_header\n`;
  const head = new TextEncoder().encode(header);
  const bytes = new Uint8Array(head.length + rows.length * properties.length * 4);
  bytes.set(head);
  const view = new DataView(bytes.buffer, head.length);
  rows.forEach((row, r) => row.forEach((v, c) => view.setFloat32((r * properties.length + c) * 4, v, true)));
  return bytes;
}

describe('.ply', () => {
  const base = ['x', 'y', 'z', 'nx', 'ny', 'nz', 'f_dc_0', 'f_dc_1', 'f_dc_2'];
  const tail = ['opacity', 'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3'];

  it('decodes position, color, opacity, log scales and the w-first quaternion', () => {
    const row = [1, 2, 3, 0, 0, 0, 1, 0, -1, 0, Math.log(0.5), Math.log(2), 0, 1, 0, 0, 0];
    const data = decodePly(makePly([...base, ...tail], [row]));
    expect(data.count).toBe(1);
    expect(data.shDegree).toBe(0);
    expect([...data.centers]).toEqual([1, 2, 3]);
    // color = 0.5 + C0 × f_dc; opacity = sigmoid(0) = 0.5
    expect(data.colors[0]).toBe(Math.round((0.5 + SH_C0) * 255));
    expect(data.colors[1]).toBe(128);
    expect(data.colors[2]).toBe(Math.round((0.5 - SH_C0) * 255));
    expect(data.colors[3]).toBe(128);
    expect(data.covariances[0]).toBeCloseTo(0.25, 6);
    expect(data.covariances[3]).toBeCloseTo(4, 6);
    expect(data.covariances[5]).toBeCloseTo(1, 6);
  });

  it('reorders spherical harmonics from channel-major to coefficient-major bytes', () => {
    // Degree 1: f_rest_0..2 red, 3..5 green, 6..8 blue.
    const rest = Array.from({ length: 9 }, (_, i) => `f_rest_${i}`);
    const values = [0.5, 0.25, 0, -0.5, -0.25, 0, 1.5, -1.5, 0.125];
    const row = [0, 0, 0, 0, 0, 0, 0, 0, 0, ...values, 0, 0, 0, 0, 1, 0, 0, 0];
    const data = decodePly(makePly([...base, ...rest, ...tail], [row]));
    expect(data.shDegree).toBe(1);
    const bytes = new Uint8Array(data.sh1!.buffer);
    const byte = (v: number) => Math.max(0, Math.min(255, Math.round(v * 128 + 128)));
    // Coefficient 0: R, G, B = f_rest_0, f_rest_3, f_rest_6; and so on. Values beyond ±1 clamp.
    expect([...bytes.subarray(0, 9)]).toEqual([0.5, -0.5, 1.5, 0.25, -0.25, -1.5, 0, 0, 0.125].map(byte));
    // Padding up to whole words stays at zero (128).
    expect([...bytes.subarray(9, 12)]).toEqual([128, 128, 128]);
  });

  it('tells ordinary point clouds, compressed and ASCII files apart', () => {
    const cloud = () => decodePly(makePly(['x', 'y', 'z'], [[0, 0, 0]]));
    expect(cloud).toThrow(/not a Gaussian splat file/);
    try {
      cloud();
    } catch (e) {
      expect(isTerraViewError(e, 'splat-invalid')).toBe(true);
    }
    const compressed = () => decodePly(makePly(['packed_position'], [[0]], 'element chunk 1\nproperty float min_x\n'));
    expect(compressed).toThrow(/compressed PLY/);
    const ascii = new TextEncoder().encode('ply\nformat ascii 1.0\nelement vertex 0\nend_header\n');
    try {
      decodePly(ascii);
      expect.unreachable();
    } catch (e) {
      expect(isTerraViewError(e, 'splat-format-unsupported')).toBe(true);
    }
  });

  it('refuses a file shorter than its header says', () => {
    const bytes = makePly([...base, ...tail], [new Array(17).fill(0)]);
    expect(() => decodePly(bytes.subarray(0, bytes.length - 4))).toThrow(/shorter/);
  });
});

/** SPZ header and attribute streams for one splat at (1.5, −2, 0.25). */
function spzParts(version: number, shDegree = 0) {
  const fractionalBits = 12;
  const header = new Uint8Array(16);
  const view = new DataView(header.buffer);
  view.setUint32(0, 0x5053474e, true);
  view.setUint32(4, version, true);
  view.setUint32(8, 1, true);
  header[12] = shDegree;
  header[13] = fractionalBits;
  const fixed = (v: number) => {
    const n = Math.round(v * (1 << fractionalBits)) & 0xffffff;
    return [n & 255, (n >> 8) & 255, (n >> 16) & 255];
  };
  const positions = new Uint8Array([...fixed(1.5), ...fixed(-2), ...fixed(0.25)]);
  const alphas = new Uint8Array([200]);
  // (b / 255 − 0.5) × C0 / 0.15 + 0.5
  const colors = new Uint8Array([255, 128, 0]);
  // exp(b / 16 − 10): 160 → 1, 144 → e⁻¹, 176 → e
  const scales = new Uint8Array([160, 144, 176]);
  // 90 degrees about Z: (0, 0, √½, √½).
  const rotations =
    version >= 3
      ? (() => {
          // Largest component index 3 (w); x, y, z as sign-magnitude 10 bits, x in the top bits.
          const mag = (v: number) => (v < 0 ? 512 : 0) | Math.round((Math.abs(v) / Math.SQRT1_2) * 511);
          const packed = ((3 << 30) | (mag(0) << 20) | (mag(0) << 10) | mag(Math.SQRT1_2)) >>> 0;
          return new Uint8Array([packed & 255, (packed >> 8) & 255, (packed >> 16) & 255, packed >>> 24]);
        })()
      : new Uint8Array([128, 128, Math.round((Math.SQRT1_2 + 1) * 127.5)]);
  const shVectors = [0, 3, 8, 15][shDegree];
  const sh = Uint8Array.from({ length: shVectors * 3 }, (_, i) => 100 + i);
  return { header, streams: [positions, alphas, colors, scales, rotations, sh] };
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

function expectSpzSplat(data: SplatData) {
  expect(data.count).toBe(1);
  expect(data.centers[0]).toBeCloseTo(1.5, 3);
  expect(data.centers[1]).toBeCloseTo(-2, 3);
  expect(data.centers[2]).toBeCloseTo(0.25, 3);
  expect(data.colors[3]).toBe(200);
  expect(data.colors[0]).toBe(255);
  expect(data.colors[1]).toBe(128);
  expect(data.colors[2]).toBe(0);
  // Scales (1, e⁻¹, e) turned 90 degrees about Z: xx ↔ yy.
  expect(data.covariances[0]).toBeCloseTo(Math.exp(-2), 2);
  expect(data.covariances[3]).toBeCloseTo(1, 2);
  expect(data.covariances[5]).toBeCloseTo(Math.exp(2), 2);
}

describe('.spz', () => {
  it('decodes versions 2 and 3 (gzip; byte and smallest-three quaternions)', async () => {
    for (const version of [2, 3]) {
      const { header, streams } = spzParts(version);
      const file = await gzip(concat([header, ...streams]));
      expect(detectSplatFormat(file)).toBe('spz');
      expectSpzSplat(await decodeSpz(file));
    }
  });

  it('copies spherical harmonics band by band and drops what is beyond degree 3', async () => {
    const { header, streams } = spzParts(3, 2);
    const data = await decodeSpz(await gzip(concat([header, ...streams])));
    expect(data.shDegree).toBe(2);
    expect([...new Uint8Array(data.sh1!.buffer).subarray(0, 9)]).toEqual([100, 101, 102, 103, 104, 105, 106, 107, 108]);
    expect([...new Uint8Array(data.sh2!.buffer).subarray(0, 15)]).toEqual(Array.from({ length: 15 }, (_, i) => 109 + i));
  });

  it('decodes version 4 through the Zstandard decoder it is given', async () => {
    const { streams } = spzParts(4);
    const present = streams.filter((s) => s.length > 0);
    const header = new Uint8Array(32);
    const view = new DataView(header.buffer);
    view.setUint32(0, 0x5053474e, true);
    view.setUint32(4, 4, true);
    view.setUint32(8, 1, true);
    header[13] = 12;
    header[15] = present.length;
    view.setUint32(16, 32, true);
    const toc = new Uint8Array(present.length * 16);
    const tocView = new DataView(toc.buffer);
    present.forEach((s, i) => {
      tocView.setBigUint64(i * 16, BigInt(s.length), true);
      tocView.setBigUint64(i * 16 + 8, BigInt(s.length), true);
    });
    const file = concat([header, toc, ...present]);
    expect(detectSplatFormat(file)).toBe('spz');
    // "Compression" that stores: the decoder hands the bytes back.
    let calls = 0;
    const data = await decodeSpz(file, { zstd: async (bytes) => (calls++, bytes.slice()) });
    expect(calls).toBe(5);
    expectSpzSplat(data);
    await expect(decodeSpz(file)).rejects.toThrow(/Zstandard/);
    // A decoder that fails or returns the wrong amount: an invalid file, not a crash.
    const failing = await decodeSpz(file, { zstd: () => Promise.reject(new Error('bad frame')) }).catch((e: unknown) => e);
    expect(isTerraViewError(failing, 'splat-invalid')).toBe(true);
    const short = await decodeSpz(file, { zstd: (bytes) => bytes.subarray(1) }).catch((e: unknown) => e);
    expect(isTerraViewError(short, 'splat-invalid')).toBe(true);
  });

  it('reports corrupt gzip as an invalid file', async () => {
    const error = await decodeSpz(new Uint8Array([0x1f, 0x8b, 8, 0, 1, 2, 3, 4, 5, 6])).catch((e: unknown) => e);
    expect(isTerraViewError(error, 'splat-invalid')).toBe(true);
  });
});

describe('format detection', () => {
  it('goes by content first, then by name', async () => {
    expect(detectSplatFormat(new TextEncoder().encode('ply\nformat'))).toBe('ply');
    expect(detectSplatFormat(new Uint8Array(64), 'scene.splat')).toBe('splat');
    expect(detectSplatFormat(new Uint8Array(64), 'https://host/a/scene.SPZ?token=1')).toBe('spz');
    // Rows of 32 bytes without a name are taken as .splat; anything else is unknown.
    expect(detectSplatFormat(new Uint8Array(64))).toBe('splat');
    expect(detectSplatFormat(new Uint8Array(65))).toBeNull();
    const error = await decodeSplats(new Uint8Array(65), null).catch((e: unknown) => e);
    expect(isTerraViewError(error, 'splat-format-unsupported')).toBe(true);
  });
});

describe('bounds, budget and crop', () => {
  it('keeps stray splats out of the core bounds', () => {
    const list = Array.from({ length: 1000 }, (_, i) => ({ p: [(i % 10) / 10, Math.floor(i / 10) / 100, 0.5] as [number, number, number] }));
    list.push({ p: [500, -300, 80] }, { p: [-400, 200, -90] });
    const b = computeSplatBounds(makeSplats(list));
    expect(b.max[0]).toBe(500);
    expect(b.min[0]).toBe(-400);
    expect(b.coreMin[0]).toBeGreaterThanOrEqual(0);
    expect(b.coreMax[0]).toBeLessThanOrEqual(0.9001);
    expect(b.coreMax[1]).toBeLessThan(1);
    expect(b.coreMin[2]).toBeCloseTo(0.5);
  });

  it('drops invisible splats first, then the least important, keeping file order', () => {
    const data = makeSplats([
      { p: [0, 0, 0], s: 1, a: 1 },
      { p: [1, 0, 0], s: 0.1, a: 1 },
      { p: [2, 0, 0], s: 1, a: 0 },
      { p: [3, 0, 0], s: 0.5, a: 0.5 },
      { p: [NaN, 0, 0], s: 1, a: 1 },
      { p: [5, 0, 0], s: 2, a: 1 },
    ]);
    expect(splatImportance(data, 0)).toBeGreaterThan(splatImportance(data, 3));
    // Everything drawable fits: only the transparent and the broken one go.
    expect([...budgetSplats(data, 100)!]).toEqual([0, 1, 3, 5]);
    expect([...budgetSplats(data, 2)!]).toEqual([0, 5]);
    expect([...budgetSplats(data, 3)!]).toEqual([0, 3, 5]);
    expect(budgetSplats(makeSplats([{ p: [0, 0, 0] }, { p: [1, 1, 1] }]), 2)).toBeNull();
    // Equal scores: the budget is still met exactly.
    const same = makeSplats(Array.from({ length: 10 }, (_, i) => ({ p: [i, 0, 0] as [number, number, number] })));
    expect(budgetSplats(same, 4)!.length).toBe(4);
  });

  it('crops in the local frame and compacts every attribute', () => {
    const data = makeSplats([{ p: [0, 0, 0] }, { p: [0, -2, 0] }, { p: [3, 0, 0] }, { p: [0, 0, 5] }]);
    data.shDegree = 1;
    data.sh1 = Uint32Array.from({ length: 12 }, (_, i) => i);
    // File Y down: local Z = −y. A box above the pivot keeps the splat at y = −2.
    const up = upAxisMatrix('-y');
    const box = cropSplats(data, { type: 'box', min: [-1, -1, 1], max: [1, 1, 3] }, up, [0, 0, 0]);
    expect([...box]).toEqual([1]);
    const sphere = cropSplats(data, { type: 'sphere', center: [0, 0, 0], radius: 3.5 }, up, [0, 0, 0]);
    expect([...sphere]).toEqual([0, 1, 2]);
    // The pivot shifts the frame.
    expect([...cropSplats(data, { type: 'sphere', center: [0, 0, 0], radius: 0.5 }, up, [3, 0, 0])]).toEqual([2]);
    const picked = selectSplats(data, Uint32Array.from([3, 1]));
    expect(picked.count).toBe(2);
    expect([...picked.centers]).toEqual([0, 0, 5, 0, -2, 0]);
    expect([...picked.sh1!]).toEqual([9, 10, 11, 3, 4, 5]);
    expect(limitShDegree(picked, 0).sh1).toBeUndefined();
    expect(limitShDegree(picked, 3)).toBe(picked);
  });

  it('estimates video memory per splat', () => {
    expect(splatGpuBytes(1000, 0)).toBe(60_000);
    expect(splatGpuBytes(1000, 1)).toBe(88_000);
    // The WebGL backend evaluates SH in the vertex shader: no per-splat result buffer.
    expect(splatGpuBytes(1000, 3, false)).toBe(112_000);
    expect(splatGpuBytes(1000, 3)).toBe(128_000);
  });

  it('gives every GPU tier a growing splat budget', () => {
    let previous = 0;
    for (const tier of GPU_TIERS) {
      const q = gpuProfile(tier).splats;
      expect(q.maxSplats).toBeGreaterThan(previous);
      expect(q.maxShDegree).toBeGreaterThanOrEqual(0);
      expect(q.maxShDegree).toBeLessThanOrEqual(3);
      previous = q.maxSplats;
    }
  });
});

describe('placement', () => {
  const axes: SplatUpAxis[] = ['-y', '+y', '+z'];

  it('converts the file axes with proper rotations', () => {
    for (const axis of axes) {
      const m = upAxisMatrix(axis);
      const det = m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);
      expect(det).toBe(1);
      expect(rotate3Inverse(m, rotate3(m, [1, 2, 3]))).toEqual([1, 2, 3]);
    }
    // COLMAP: down is +Y, forward is +Z.
    expect(rotate3(upAxisMatrix('-y'), [0, -1, 0])).toEqual([0, 0, 1]);
    expect(rotate3(upAxisMatrix('-y'), [0, 0, 1])).toEqual([0, 1, 0]);
    expect(rotate3(upAxisMatrix('+y'), [0, 1, 0])).toEqual([0, 0, 1]);
  });

  it('puts the pivot under the middle of the scene', () => {
    const bounds = { min: [-9, -9, -9], max: [9, 9, 9], coreMin: [-1, -4, 2], coreMax: [3, 0, 6] } as never;
    // Y down: the lowest point is the largest y.
    expect(resolvePivot('bottom', bounds, '-y')).toEqual([1, 0, 4]);
    expect(resolvePivot('center', bounds, '-y')).toEqual([1, -2, 4]);
    expect(resolvePivot('bottom', bounds, '+z')).toEqual([1, -2, 2]);
    expect(resolvePivot('origin', bounds, '-y')).toEqual([0, 0, 0]);
    expect(resolvePivot([7, 8, 9], bounds, '-y')).toEqual([7, 8, 9]);
    expect(boxToLocal([-1, -4, 2], [3, 0, 6], '-y')).toEqual({ min: [-1, 2, 0], max: [3, 6, 4] });
  });

  const apply = (m: number[], p: [number, number, number]) => [
    m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
    m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
    m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
  ];

  it('builds the model matrix: pivot at the anchor, heading clockwise, scale in meters', () => {
    const base = { upAxis: '-y' as const, pivot: [1, 2, 3], heading: 0, pitch: 0, roll: 0, scale: 2 };
    const m = splatModelMatrix(base);
    apply(m, [1, 2, 3]).forEach((v) => expect(v).toBeCloseTo(0, 12));
    // One unit up in the file (−Y) is two meters up.
    const up = apply(m, [1, 1, 3]);
    expect(up[0]).toBeCloseTo(0, 12);
    expect(up[1]).toBeCloseTo(0, 12);
    expect(up[2]).toBeCloseTo(2, 12);
    // The file's forward (+Z) points north; with heading 90 it points east.
    const north = apply(m, [1, 2, 4]);
    expect(north[1]).toBeCloseTo(2, 12);
    const east = apply(splatModelMatrix({ ...base, heading: 90 }), [1, 2, 4]);
    expect(east[0]).toBeCloseTo(2, 12);
    expect(east[1]).toBeCloseTo(0, 12);
    // Pitch lifts the north side, roll the west side.
    expect(apply(splatModelMatrix({ ...base, pitch: 30 }), [1, 2, 4])[2]).toBeCloseTo(2 * Math.sin(Math.PI / 6), 12);
    expect(apply(splatModelMatrix({ ...base, roll: 30 }), [0, 2, 3])[2]).toBeCloseTo(2 * Math.sin(Math.PI / 6), 12);
  });

  it('keeps lengths and handedness for any angles', () => {
    const m = splatModelMatrix({ upAxis: '+y', pivot: [0, 0, 0], heading: 37, pitch: -12, roll: 71, scale: 3 });
    const x = [m[0], m[1], m[2]];
    const y = [m[4], m[5], m[6]];
    const z = [m[8], m[9], m[10]];
    for (const v of [x, y, z]) expect(Math.hypot(...v)).toBeCloseTo(3, 12);
    const cross = [x[1] * y[2] - x[2] * y[1], x[2] * y[0] - x[0] * y[2], x[0] * y[1] - x[1] * y[0]];
    cross.forEach((v, i) => expect(v).toBeCloseTo(z[i] * 3, 10));
  });

  it('measures a sphere on screen and against the view pyramid', () => {
    // 90 degree vertical field of view, 1000 px: one meter at ten meters is 50 px.
    expect(screenRadius(1, 10, 90, 1000)).toBeCloseTo(50, 9);
    expect(screenRadius(1, 0.5, 90, 1000)).toBe(Infinity);
    expect(sphereInView(0, 0, -10, 1, 1, 1)).toBe(true);
    // Behind the camera.
    expect(sphereInView(0, 0, 10, 1, 1, 1)).toBe(false);
    expect(sphereInView(0, 0, 0.5, 1, 1, 1)).toBe(true);
    // Beside the pyramid, and just touching its side plane.
    expect(sphereInView(20, 0, -10, 1, 1, 1)).toBe(false);
    expect(sphereInView(11.3, 0, -10, 1, 1, 1)).toBe(true);
    expect(sphereInView(11.5, 0, -10, 1, 1, 1)).toBe(false);
  });
});

describe('picking', () => {
  /** A wall of opaque splats in the plane z = 0, 21 × 21 over [−1, 1]². */
  const wall = () => {
    const list: { p: [number, number, number]; s?: number; a?: number }[] = [];
    for (let y = -10; y <= 10; y++) for (let x = -10; x <= 10; x++) list.push({ p: [x / 10, y / 10, 0], s: 0.06, a: 0.95 });
    return list;
  };

  it('hits the surface where the gathered opacity reaches the threshold', () => {
    const data = makeSplats(wall());
    const index = buildSplatIndex(data);
    expect(index.items.length).toBe(data.count);
    const hit = raycastSplats(data, index, [0.03, -0.02, 5], [0, 0, -1]);
    expect(hit).not.toBeNull();
    expect(hit!.distance).toBeCloseTo(5, 6);
    expect(hit!.opacity).toBeGreaterThanOrEqual(0.5);
    // The splat at the wall's middle.
    expect(hit!.index).toBe(10 * 21 + 10);
    // Oblique rays too, and none beside the wall or pointing away.
    const d = Math.SQRT1_2;
    expect(raycastSplats(data, index, [-3, 0, 3], [d, 0, -d])!.distance).toBeCloseTo(3 / d, 1);
    expect(raycastSplats(data, index, [5, 5, 5], [0, 0, -1])).toBeNull();
    expect(raycastSplats(data, index, [0, 0, 5], [0, 0, 1])).toBeNull();
  });

  it('passes through thin haze in front of a surface', () => {
    const list = wall();
    // A faint floater two units in front of the wall.
    list.push({ p: [0, 0, 2], s: 0.3, a: 0.2 });
    const data = makeSplats(list);
    const index = buildSplatIndex(data);
    expect(raycastSplats(data, index, [0, 0, 5], [0, 0, -1])!.distance).toBeCloseTo(5, 6);
    // A low threshold stops at the floater instead.
    expect(raycastSplats(data, index, [0, 0, 5], [0, 0, -1], { minOpacity: 0.1 })!.distance).toBeCloseTo(3, 6);
    // Haze alone is not a surface.
    const haze = makeSplats([{ p: [0, 0, 0], s: 0.3, a: 0.2 }]);
    expect(raycastSplats(haze, buildSplatIndex(haze), [0, 0, 5], [0, 0, -1])).toBeNull();
  });

  it('honors the mask of a crop and the distance limit', () => {
    const list = wall();
    const near = list.length;
    // A second, smaller wall in front.
    for (let y = -2; y <= 2; y++) for (let x = -2; x <= 2; x++) list.push({ p: [x / 10, y / 10, 1], s: 0.06, a: 0.95 });
    const data = makeSplats(list);
    const index = buildSplatIndex(data);
    expect(raycastSplats(data, index, [0, 0, 5], [0, 0, -1])!.distance).toBeCloseTo(4, 6);
    const mask = new Uint8Array(data.count).fill(1);
    mask.fill(0, near);
    expect(raycastSplats(data, index, [0, 0, 5], [0, 0, -1], { mask })!.distance).toBeCloseTo(5, 6);
    expect(raycastSplats(data, index, [0, 0, 5], [0, 0, -1], { maxDistance: 3 })).toBeNull();
    expect(raycastSplats(data, index, [0, 0, 5], [0, 0, -1], { maxDistance: 4.5 })!.distance).toBeCloseTo(4, 6);
  });

  it('agrees with a brute-force search on random splats', () => {
    let seed = 12345;
    const random = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const count = 3000;
    const data: SplatData = { count, centers: new Float32Array(count * 3), covariances: new Float32Array(count * 6), colors: new Uint8Array(count * 4), shDegree: 0 };
    for (let i = 0; i < count; i++) {
      data.centers.set([random() * 4 - 2, random() * 4 - 2, random() * 4 - 2], i * 3);
      // Anisotropic, rotated, sizes over two orders of magnitude; some flat.
      const s = 0.005 * 100 ** random();
      const q: [number, number, number, number] = [random() - 0.5, random() - 0.5, random() - 0.5, random() - 0.5];
      writeCovariance(data.covariances, i * 6, s, s * (0.2 + random()), i % 7 === 0 ? 0 : s * (0.2 + random()), ...q);
      data.colors[i * 4 + 3] = Math.floor(random() * 256);
    }
    const index = buildSplatIndex(data);
    // One leaf holding everything: the same test without the hierarchy.
    const all = Uint32Array.from(index.items);
    const brute = { nodeCount: 1, bounds: new Float32Array([-9, -9, -9, 9, 9, 9]), links: new Uint32Array([0, all.length]), items: all };
    let hits = 0;
    for (let k = 0; k < 300; k++) {
      const o: [number, number, number] = [random() * 10 - 5, random() * 10 - 5, random() * 10 - 5];
      const t = [random() * 2 - 1, random() * 2 - 1, random() * 2 - 1];
      const d = [t[0] - o[0], t[1] - o[1], t[2] - o[2]];
      const l = Math.hypot(d[0], d[1], d[2]);
      const dir = [d[0] / l, d[1] / l, d[2] / l];
      const a = raycastSplats(data, index, o, dir, { minOpacity: 0.3 });
      const b = raycastSplats(data, brute, o, dir, { minOpacity: 0.3 });
      expect(a === null).toBe(b === null);
      if (a && b) {
        hits++;
        expect(a.index).toBe(b.index);
        expect(a.distance).toBeCloseTo(b.distance, 9);
      }
    }
    expect(hits).toBeGreaterThan(50);
  });

  it('leaves out what cannot be hit and survives an empty set', () => {
    const data = makeSplats([{ p: [0, 0, 0], a: 0 }, { p: [NaN, 0, 0] }, { p: [1, 0, 0], s: 0 }]);
    const index = buildSplatIndex(data);
    expect(index.items.length).toBe(0);
    expect(raycastSplats(data, index, [0, 0, 5], [0, 0, -1])).toBeNull();
    const none = makeSplats([]);
    expect(raycastSplats(none, buildSplatIndex(none), [0, 0, 5], [0, 0, -1])).toBeNull();
  });
});

describe('demo URL parameters', () => {
  it('turns ?splats and its companions into layer options', () => {
    const q = (s: string) => parseSplatParams(new URLSearchParams(s));
    expect(q('demo')).toBeNull();
    expect(q('splats=')).toBeNull();
    expect(q('splats=a.spz')).toEqual({ url: 'a.spz' });
    expect(q('splats=a.ply&splatsAt=116.39,39.91&splatsScale=2.5&splatsHeading=-30&splatsUp=-y&splatsMax=500000')).toEqual({
      url: 'a.ply',
      position: { longitude: 116.39, latitude: 39.91 },
      scale: 2.5,
      heading: -30,
      upAxis: '-y',
      maxSplats: 500000,
    });
    expect(q('splats=a.ply&splatsAt=116.39,39.91,52.5')!.position).toEqual({ longitude: 116.39, latitude: 39.91, height: 52.5 });
    // A "+" in a query string is a space: "+y", "%2By" and "y" all mean Y up.
    for (const up of ['+y', '%2By', 'y', 'Y']) expect(q(`splats=a.spz&splatsUp=${up}`)!.upAxis).toBe('+y');
    expect(q('splats=a.spz&splatsUp=z')!.upAxis).toBe('+z');
    // Malformed values are ignored, never fatal.
    expect(q('splats=a.spz&splatsAt=200,39&splatsScale=0&splatsUp=x&splatsHeading=abc')).toEqual({ url: 'a.spz' });
    expect(q('splats=a.spz&splatsAt=116.39')).toEqual({ url: 'a.spz' });
  });

  it('counts as a startup flight', () => {
    expect(hasStartupFlight(new URLSearchParams('splats=a.spz'))).toBe(true);
  });
});
