/**
 * Decoders for 3D Gaussian splat files, run in the splat Worker (no three.js, no DOM):
 *
 * - `.ply`   the GraphDECO / INRIA training output (binary little endian; `f_dc`, `f_rest`,
 *            `opacity`, `scale`, `rot`), spherical harmonics up to degree 3;
 * - `.splat` the fixed 32-byte rows of antimatter15's viewer (no spherical harmonics);
 * - `.spz`   Niantic's compressed format, versions 1–3 (gzip) and 4 (Zstandard streams).
 *
 * The .spz layout follows three.js's `SPZLoader` (MIT, see THIRD_PARTY_NOTICES.md), which
 * cannot run here: Workers must not import three.js. Zstandard itself is not in this
 * module either: the caller supplies it (`DecodeOptions.zstd`). See docs/agents/splats.md §2.
 */
import { TerraViewError } from '../core/errors';
import { createShBand, SH_BAND_COMPONENTS, SH_BAND_WORDS, SH_C0, writeCovariance, type SplatData, type SplatShDegree } from './splatData';

/** File formats the SDK decodes. */
export type SplatFormat = 'ply' | 'splat' | 'spz';

/** Decompresses one Zstandard frame of known size (SPZ version 4); may answer later (the Worker asks the main thread). */
export type ZstdDecode = (data: Uint8Array, uncompressedSize: number) => Uint8Array | Promise<Uint8Array>;

export interface DecodeOptions {
  /** Zstandard decompression for files that need it (SPZ 4); without it such files are refused. */
  zstd?: ZstdDecode;
}

const SPZ_MAGIC = 0x5053474e;
const GZIP_MAGIC = 0x8b1f;
const SPLAT_ROW_BYTES = 32;
/** f_rest properties of a PLY by spherical harmonics degree. */
const PLY_REST_COUNT = [0, 9, 24, 45];
/** SH vectors after the first, by stored degree (SPZ stores up to degree 4; we read up to 3). */
const SPZ_SH_VECTORS = [0, 3, 8, 15, 24];
const SPZ_COLOR_SCALE = SH_C0 / 0.15;

const invalid = (format: SplatFormat, reason: string) => new TerraViewError('splat-invalid', `Invalid .${format} file: ${reason}`, { format, reason });

/**
 * The format of a file from its first bytes, else from its name: PLY and SPZ 4 have magic
 * numbers, gzip can only be an SPZ here, and a `.splat` file is anonymous rows of 32 bytes.
 */
export function detectSplatFormat(bytes: Uint8Array, name = ''): SplatFormat | null {
  if (bytes.length >= 4) {
    if (bytes[0] === 0x70 && bytes[1] === 0x6c && bytes[2] === 0x79 && (bytes[3] === 0x0a || bytes[3] === 0x0d)) return 'ply';
    const magic = (bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24)) >>> 0;
    if (magic === SPZ_MAGIC) return 'spz';
    if ((magic & 0xffff) === GZIP_MAGIC) return 'spz';
  }
  const ext = /\.([a-z0-9]+)(?:[?#].*)?$/i.exec(name)?.[1]?.toLowerCase();
  if (ext === 'ply' || ext === 'splat' || ext === 'spz') return ext;
  return bytes.length > 0 && bytes.length % SPLAT_ROW_BYTES === 0 ? 'splat' : null;
}

/** Decodes a file of the given (or detected) format. */
export async function decodeSplats(bytes: Uint8Array, format: SplatFormat | null, options: DecodeOptions = {}): Promise<SplatData> {
  if (format === 'ply') return decodePly(bytes);
  if (format === 'splat') return decodeSplatRows(bytes);
  if (format === 'spz') return decodeSpz(bytes, options);
  throw new TerraViewError('splat-format-unsupported', 'Unknown Gaussian splat format (supported: .ply, .splat, .spz)', { format: 'unknown' });
}

// ---------------------------------------------------------------------------
// .splat

/** Rows of position (3 float32), scale (3 float32), RGBA (4 bytes), rotation (4 bytes: w, x, y, z as (b − 128) / 128). */
export function decodeSplatRows(bytes: Uint8Array): SplatData {
  if (bytes.length === 0 || bytes.length % SPLAT_ROW_BYTES !== 0) throw invalid('splat', 'length is not a multiple of 32 bytes');
  const count = bytes.length / SPLAT_ROW_BYTES;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const centers = new Float32Array(count * 3);
  const covariances = new Float32Array(count * 6);
  const colors = new Uint8Array(count * 4);
  for (let i = 0; i < count; i++) {
    const o = i * SPLAT_ROW_BYTES;
    centers[i * 3] = view.getFloat32(o, true);
    centers[i * 3 + 1] = view.getFloat32(o + 4, true);
    centers[i * 3 + 2] = view.getFloat32(o + 8, true);
    colors.set(bytes.subarray(o + 24, o + 28), i * 4);
    writeCovariance(
      covariances,
      i * 6,
      view.getFloat32(o + 12, true),
      view.getFloat32(o + 16, true),
      view.getFloat32(o + 20, true),
      (bytes[o + 29] - 128) / 128,
      (bytes[o + 30] - 128) / 128,
      (bytes[o + 31] - 128) / 128,
      (bytes[o + 28] - 128) / 128,
    );
  }
  return { count, centers, covariances, colors, shDegree: 0 };
}

// ---------------------------------------------------------------------------
// .ply

const PLY_TYPES: Record<string, { size: number; read: (v: DataView, o: number) => number }> = {
  char: { size: 1, read: (v, o) => v.getInt8(o) },
  int8: { size: 1, read: (v, o) => v.getInt8(o) },
  uchar: { size: 1, read: (v, o) => v.getUint8(o) },
  uint8: { size: 1, read: (v, o) => v.getUint8(o) },
  short: { size: 2, read: (v, o) => v.getInt16(o, true) },
  int16: { size: 2, read: (v, o) => v.getInt16(o, true) },
  ushort: { size: 2, read: (v, o) => v.getUint16(o, true) },
  uint16: { size: 2, read: (v, o) => v.getUint16(o, true) },
  int: { size: 4, read: (v, o) => v.getInt32(o, true) },
  int32: { size: 4, read: (v, o) => v.getInt32(o, true) },
  uint: { size: 4, read: (v, o) => v.getUint32(o, true) },
  uint32: { size: 4, read: (v, o) => v.getUint32(o, true) },
  float: { size: 4, read: (v, o) => v.getFloat32(o, true) },
  float32: { size: 4, read: (v, o) => v.getFloat32(o, true) },
  double: { size: 8, read: (v, o) => v.getFloat64(o, true) },
  float64: { size: 8, read: (v, o) => v.getFloat64(o, true) },
};

interface PlyHeader {
  count: number;
  /** Bytes of one vertex row and where the rows start. */
  rowBytes: number;
  dataOffset: number;
  /** Byte offset of each property within a row, and its type. */
  properties: Map<string, { offset: number; type: string }>;
}

/** Reads the header: the vertex element must come first (as every 3DGS exporter writes it). */
function parsePlyHeader(bytes: Uint8Array): PlyHeader {
  const marker = 'end_header';
  const limit = Math.min(bytes.length, 1 << 20);
  let end = -1;
  search: for (let i = 0; i + marker.length <= limit; i++) {
    for (let j = 0; j < marker.length; j++) if (bytes[i + j] !== marker.charCodeAt(j)) continue search;
    end = i + marker.length;
    break;
  }
  if (end < 0) throw invalid('ply', 'no end_header');
  // The header ends with the line break after end_header (LF, or CR LF).
  let dataOffset = end;
  if (bytes[dataOffset] === 0x0d) dataOffset++;
  if (bytes[dataOffset] === 0x0a) dataOffset++;
  const lines = new TextDecoder().decode(bytes.subarray(0, end)).split(/\r\n|\r|\n/);
  if (lines[0]?.trim() !== 'ply') throw invalid('ply', 'missing ply magic');
  const properties = new Map<string, { offset: number; type: string }>();
  let count = -1;
  let rowBytes = 0;
  let elements = 0;
  let inVertex = false;
  for (const line of lines) {
    const parts = line.trim().split(/\s+/);
    if (parts[0] === 'format' && parts[1] !== 'binary_little_endian') {
      throw new TerraViewError('splat-format-unsupported', `PLY format ${parts[1]} is not supported (binary_little_endian only)`, { format: `ply ${parts[1]}` });
    }
    if (parts[0] === 'element') {
      elements++;
      inVertex = parts[1] === 'vertex';
      if (inVertex) {
        if (elements !== 1) {
          // SuperSplat's compressed PLY puts a chunk element first.
          throw new TerraViewError('splat-format-unsupported', 'PLY files with elements before the vertices (compressed PLY) are not supported', { format: 'ply compressed' });
        }
        count = Number(parts[2]);
      }
    } else if (parts[0] === 'property' && inVertex) {
      if (parts[1] === 'list') throw invalid('ply', 'list property in the vertex element');
      const type = PLY_TYPES[parts[1]];
      if (!type) throw invalid('ply', `unknown property type ${parts[1]}`);
      properties.set(parts[2], { offset: rowBytes, type: parts[1] });
      rowBytes += type.size;
    }
  }
  if (!Number.isInteger(count) || count < 0) throw invalid('ply', 'no vertex element');
  return { count, rowBytes, dataOffset, properties };
}

export function decodePly(bytes: Uint8Array): SplatData {
  const header = parsePlyHeader(bytes);
  const { count, rowBytes, dataOffset, properties } = header;
  const required = ['x', 'y', 'z', 'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity'];
  const missing = required.filter((name) => !properties.has(name));
  if (missing.length > 0) {
    if (properties.has('packed_position')) {
      throw new TerraViewError('splat-format-unsupported', 'Compressed PLY (packed_position) is not supported', { format: 'ply compressed' });
    }
    // An ordinary point cloud or mesh, not a trained splat scene.
    throw invalid('ply', `not a Gaussian splat file: missing ${missing.join(', ')}`);
  }
  if (bytes.length < dataOffset + count * rowBytes) throw invalid('ply', 'file is shorter than its header says');
  let rest = 0;
  while (properties.has(`f_rest_${rest}`)) rest++;
  const shDegree = PLY_REST_COUNT.indexOf(rest) as SplatShDegree | -1;
  if (shDegree < 0) throw invalid('ply', `unexpected number of f_rest properties (${rest})`);

  const view = new DataView(bytes.buffer, bytes.byteOffset + dataOffset, count * rowBytes);
  const reader = (name: string) => {
    const p = properties.get(name)!;
    const read = PLY_TYPES[p.type].read;
    return (row: number) => read(view, row * rowBytes + p.offset);
  };
  const [x, y, z, s0, s1, s2, r0, r1, r2, r3, d0, d1, d2, opacity] = required.map(reader);
  const restReaders = Array.from({ length: rest }, (_, i) => reader(`f_rest_${i}`));
  // f_rest holds all red coefficients, then green, then blue.
  const perChannel = rest / 3;

  const centers = new Float32Array(count * 3);
  const covariances = new Float32Array(count * 6);
  const colors = new Uint8ClampedArray(count * 4);
  const bands = [null, ...[1, 2, 3].map((degree) => (degree <= shDegree ? createShBand(count, degree) : null))];
  const bandStart = [0, 0, 3, 8];
  for (let i = 0; i < count; i++) {
    centers[i * 3] = x(i);
    centers[i * 3 + 1] = y(i);
    centers[i * 3 + 2] = z(i);
    // Scales are logarithms; rot_0 is the quaternion's w.
    writeCovariance(covariances, i * 6, Math.exp(s0(i)), Math.exp(s1(i)), Math.exp(s2(i)), r1(i), r2(i), r3(i), r0(i));
    colors[i * 4] = (d0(i) * SH_C0 + 0.5) * 255;
    colors[i * 4 + 1] = (d1(i) * SH_C0 + 0.5) * 255;
    colors[i * 4 + 2] = (d2(i) * SH_C0 + 0.5) * 255;
    colors[i * 4 + 3] = 255 / (1 + Math.exp(-opacity(i)));
    for (let degree = 1; degree <= shDegree; degree++) {
      const band = bands[degree]!;
      const target = i * SH_BAND_WORDS[degree] * 4;
      for (let j = 0; j < SH_BAND_COMPONENTS[degree]; j++) {
        const coefficient = bandStart[degree] + Math.floor(j / 3);
        band.bytes[target + j] = restReaders[coefficient + (j % 3) * perChannel](i) * 128 + 128;
      }
    }
  }
  const data: SplatData = { count, centers, covariances, colors: new Uint8Array(colors.buffer), shDegree: shDegree as SplatShDegree };
  if (bands[1]) data.sh1 = bands[1].words;
  if (bands[2]) data.sh2 = bands[2].words;
  if (bands[3]) data.sh3 = bands[3].words;
  return data;
}

// ---------------------------------------------------------------------------
// .spz

interface SpzStreams {
  version: number;
  count: number;
  fractionalBits: number;
  storedShDegree: number;
  positions: Uint8Array;
  alphas: Uint8Array;
  colors: Uint8Array;
  scales: Uint8Array;
  rotations: Uint8Array;
  sh: Uint8Array;
}

async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined') {
    throw new TerraViewError('splat-format-unsupported', 'This browser cannot decompress gzip (.spz needs DecompressionStream)', { format: 'spz gzip' });
  }
  try {
    const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    throw invalid('spz', 'gzip data is corrupt');
  }
}

export async function decodeSpz(bytes: Uint8Array, options: DecodeOptions = {}): Promise<SplatData> {
  if (bytes.length >= 8) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    // Version 4 is not gzipped as a whole: its header is readable as is.
    if (view.getUint32(0, true) === SPZ_MAGIC) {
      const version = view.getUint32(4, true);
      if (version !== 4) throw new TerraViewError('splat-format-unsupported', `SPZ version ${version} is not supported`, { format: `spz ${version}` });
      if (!options.zstd) throw new TerraViewError('splat-format-unsupported', 'SPZ version 4 needs a Zstandard decoder', { format: 'spz 4' });
      return spzAttributes(await readSpz4(bytes, options.zstd));
    }
  }
  return spzAttributes(readSpzLegacy(await gunzip(bytes)));
}

/** Versions 1–3: one gzip stream of header and attribute arrays. */
function readSpzLegacy(bytes: Uint8Array): SpzStreams {
  if (bytes.length < 16) throw invalid('spz', 'header is missing');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== SPZ_MAGIC) throw invalid('spz', 'wrong magic number');
  const version = view.getUint32(4, true);
  if (version < 1 || version > 3) throw new TerraViewError('splat-format-unsupported', `SPZ version ${version} is not supported`, { format: `spz ${version}` });
  const count = view.getUint32(8, true);
  const storedShDegree = view.getUint8(12);
  const fractionalBits = view.getUint8(13);
  if (storedShDegree >= SPZ_SH_VECTORS.length) throw invalid('spz', `spherical harmonics degree ${storedShDegree}`);
  const sizes = [count * 3 * (version === 1 ? 2 : 3), count, count * 3, count * 3, count * (version === 3 ? 4 : 3), count * SPZ_SH_VECTORS[storedShDegree] * 3];
  // Trailing data (level-of-detail extension) is ignored.
  if (bytes.length < 16 + sizes.reduce((a, b) => a + b, 0)) throw invalid('spz', 'file is shorter than its header says');
  let offset = 16;
  const [positions, alphas, colors, scales, rotations, sh] = sizes.map((size) => bytes.subarray(offset, (offset += size)));
  return { version, count, fractionalBits, storedShDegree, positions, alphas, colors, scales, rotations, sh };
}

/** Version 4: a table of contents and one Zstandard frame per attribute. */
async function readSpz4(bytes: Uint8Array, zstd: ZstdDecode): Promise<SpzStreams> {
  if (bytes.length < 32) throw invalid('spz', 'header is missing');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint32(8, true);
  const storedShDegree = view.getUint8(12);
  const fractionalBits = view.getUint8(13);
  const streamCount = view.getUint8(15);
  const tocOffset = view.getUint32(16, true);
  if (storedShDegree >= SPZ_SH_VECTORS.length) throw invalid('spz', `spherical harmonics degree ${storedShDegree}`);
  const sizes = [count * 9, count, count * 3, count * 3, count * 4, count * SPZ_SH_VECTORS[storedShDegree] * 3];
  let offset = tocOffset + streamCount * 16;
  let entry = 0;
  const streams: Uint8Array[] = [];
  for (const size of sizes) {
    if (size === 0) {
      streams.push(new Uint8Array(0));
      continue;
    }
    if (entry >= streamCount) throw invalid('spz', 'attribute stream is missing');
    // Entries are 16 bytes and start with the compressed size (uint64); frames follow the table in order.
    const compressedSize = Number(view.getBigUint64(tocOffset + entry * 16, true));
    entry++;
    if (offset + compressedSize > bytes.length) throw invalid('spz', 'file is shorter than its table of contents says');
    let out: Uint8Array;
    try {
      out = await zstd(bytes.subarray(offset, offset + compressedSize), size);
    } catch {
      throw invalid('spz', 'Zstandard data is corrupt');
    }
    offset += compressedSize;
    if (out.length !== size) throw invalid('spz', 'attribute stream has the wrong size');
    streams.push(out);
  }
  const [positions, alphas, colors, scales, rotations, sh] = streams;
  return { version: 4, count, fractionalBits, storedShDegree, positions, alphas, colors, scales, rotations, sh };
}

/** IEEE 754 half float to number (SPZ 1 positions). */
function halfToFloat(h: number): number {
  const e = (h >> 10) & 0x1f;
  const m = h & 0x3ff;
  const sign = h & 0x8000 ? -1 : 1;
  if (e === 0) return sign * 2 ** -14 * (m / 1024);
  if (e === 31) return m ? NaN : sign * Infinity;
  return sign * 2 ** (e - 15) * (1 + m / 1024);
}

function spzAttributes(s: SpzStreams): SplatData {
  const { count, version } = s;
  const centers = new Float32Array(count * 3);
  const covariances = new Float32Array(count * 6);
  const colors = new Uint8ClampedArray(count * 4);
  if (version === 1) {
    for (let k = 0; k < count * 3; k++) centers[k] = halfToFloat(s.positions[k * 2] | (s.positions[k * 2 + 1] << 8));
  } else {
    // 24-bit signed fixed point; the shifts sign-extend.
    const scale = 1 / (1 << s.fractionalBits);
    const p = s.positions;
    for (let k = 0; k < count * 3; k++) centers[k] = (((p[k * 3] << 8) | (p[k * 3 + 1] << 16) | (p[k * 3 + 2] << 24)) >> 8) * scale;
  }
  const q = [0, 0, 0, 0];
  const r = s.rotations;
  for (let i = 0; i < count; i++) {
    if (version >= 3) {
      // "Smallest three": the largest component's index in the top 2 bits, the others as 10-bit
      // sign-magnitude values (magnitude 9 bits, up to 1/√2), lowest bits for the highest index.
      const packed = (r[i * 4] | (r[i * 4 + 1] << 8) | (r[i * 4 + 2] << 16) | (r[i * 4 + 3] << 24)) >>> 0;
      const largest = packed >>> 30;
      let sum = 0;
      let bits = packed;
      for (let k = 3; k >= 0; k--) {
        if (k === largest) continue;
        const magnitude = Math.SQRT1_2 * ((bits & 511) / 511);
        q[k] = bits & 512 ? -magnitude : magnitude;
        sum += q[k] * q[k];
        bits >>>= 10;
      }
      q[largest] = Math.sqrt(Math.max(0, 1 - sum));
    } else {
      q[0] = r[i * 3] / 127.5 - 1;
      q[1] = r[i * 3 + 1] / 127.5 - 1;
      q[2] = r[i * 3 + 2] / 127.5 - 1;
      q[3] = Math.sqrt(Math.max(0, 1 - q[0] * q[0] - q[1] * q[1] - q[2] * q[2]));
    }
    // Scales are logarithms quantized to 1/16.
    writeCovariance(covariances, i * 6, Math.exp(s.scales[i * 3] / 16 - 10), Math.exp(s.scales[i * 3 + 1] / 16 - 10), Math.exp(s.scales[i * 3 + 2] / 16 - 10), q[0], q[1], q[2], q[3]);
    for (let c = 0; c < 3; c++) colors[i * 4 + c] = ((s.colors[i * 3 + c] / 255 - 0.5) * SPZ_COLOR_SCALE + 0.5) * 255;
    colors[i * 4 + 3] = s.alphas[i];
  }
  const shDegree = Math.min(s.storedShDegree, 3) as SplatShDegree;
  const data: SplatData = { count, centers, covariances, colors: new Uint8Array(colors.buffer), shDegree };
  // Coefficients are already bytes around 128, coefficient-major: copy band by band.
  const stride = SPZ_SH_VECTORS[s.storedShDegree] * 3;
  let bandOffset = 0;
  for (let degree = 1; degree <= shDegree; degree++) {
    const band = createShBand(count, degree);
    const components = SH_BAND_COMPONENTS[degree];
    const words = SH_BAND_WORDS[degree] * 4;
    for (let i = 0; i < count; i++) band.bytes.set(s.sh.subarray(i * stride + bandOffset, i * stride + bandOffset + components), i * words);
    bandOffset += components;
    if (degree === 1) data.sh1 = band.words;
    else if (degree === 2) data.sh2 = band.words;
    else data.sh3 = band.words;
  }
  return data;
}
