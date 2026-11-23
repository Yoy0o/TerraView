/**
 * Static server for the browser smoke tests (playwright.config.ts starts it):
 *
 *   node tests/e2e/server.mjs <dir> <port>
 *
 * Serves a build folder (dist-demo/, or the host project kept by `check:package --keep-host`),
 * two generated 256 px tiles that the tests hand out instead of the real tile services, and a
 * generated Gaussian splat file, so the smoke tests run offline and see the same pixels every time:
 *
 *   /__tiles/imagery.png   grid pattern (basemap imagery)
 *   /__tiles/terrain.png   Terrarium-encoded flat ground at 100 m
 *   /__splats/ball.splat   3000 Gaussian splats on a sphere of radius 1 (`.splat` rows)
 *   /__tiles3d/empty/tileset.json   a 3D Tiles tileset without content, around the demo building
 *
 * Node only, no dependencies.
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { deflateSync } from 'node:zlib';

const root = resolve(process.argv[2] ?? '.');
const port = Number(process.argv[3] ?? 4180);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.glb': 'model/gltf-binary',
  '.ktx2': 'image/ktx2',
  '.map': 'application/json',
};

// ------------------------------------------------------------------ PNG tiles

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/** 8-bit RGB PNG from a pixel function (x, y) => [r, g, b]. */
function png(size, pixel) {
  const raw = Buffer.alloc(size * (size * 3 + 1));
  for (let y = 0; y < size; y++) {
    const row = y * (size * 3 + 1);
    for (let x = 0; x < size; x++) raw.set(pixel(x, y), row + 1 + x * 3);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 2, 0, 0, 0], 8); // 8 bit, RGB, deflate, no filter, no interlace
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const TILES = {
  '/__tiles/imagery.png': png(256, (x, y) => (x % 32 === 0 || y % 32 === 0 ? [235, 240, 245] : [40 + (x >> 2), 90, 60 + (y >> 2)])),
  // Terrarium: height = R * 256 + G + B / 256 - 32768, so (128, 100, 0) is 100 m.
  '/__tiles/terrain.png': png(256, () => [128, 100, 0]),
};

// ------------------------------------------------------------------ Gaussian splats

/** A `.splat` file: `count` opaque splats spread evenly over a unit sphere, colored by position. */
function splatBall(count) {
  const out = Buffer.alloc(count * 32);
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < count; i++) {
    const y = 1 - (2 * (i + 0.5)) / count;
    const r = Math.sqrt(1 - y * y);
    const x = Math.cos(golden * i) * r;
    const z = Math.sin(golden * i) * r;
    const o = i * 32;
    [x, y, z, 0.06, 0.06, 0.06].forEach((v, k) => out.writeFloatLE(v, o + k * 4));
    out.set([128 + 100 * x, 128 + 100 * y, 128 + 100 * z, 255], o + 24);
    // Rotation as w, x, y, z bytes: identity.
    out.set([255, 128, 128, 128], o + 28);
  }
  return out;
}

const SPLATS = { '/__splats/ball.splat': splatBall(3000) };

/** A valid tileset with nothing to draw (west, south, east, north in radians; heights in meters): layer logic without tile data. */
const RAD = Math.PI / 180;
const EMPTY_TILESET = JSON.stringify({
  asset: { version: '1.1' },
  geometricError: 0,
  root: { boundingVolume: { region: [116.392 * RAD, 39.999 * RAD, 116.394 * RAD, 40.0 * RAD, 0, 50] }, geometricError: 0, refine: 'ADD' },
});

// ------------------------------------------------------------------ server

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  // Tiles stand in for other origins: let any page read them.
  res.setHeader('Access-Control-Allow-Origin', '*');
  const tile = TILES[url.pathname];
  if (tile) return res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' }).end(tile);
  const splats = SPLATS[url.pathname];
  if (splats) return res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': splats.length }).end(splats);
  if (url.pathname === '/__tiles3d/empty/tileset.json') return res.writeHead(200, { 'Content-Type': 'application/json' }).end(EMPTY_TILESET);

  const path = decodeURIComponent(url.pathname);
  const file = normalize(join(root, path.endsWith('/') ? `${path}index.html` : path));
  if (file !== root && !file.startsWith(root + sep)) return res.writeHead(403).end();
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream' }).end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found');
  }
}).listen(port, '127.0.0.1', () => console.log(`smoke server: ${root} on http://127.0.0.1:${port}`));
