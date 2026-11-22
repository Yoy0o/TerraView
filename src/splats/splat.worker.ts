/**
 * Loads one Gaussian splat file off the main thread: download (with progress), decode,
 * apply the budget, measure the bounds and build the picking hierarchy. One Worker per load,
 * closed by the layer when the answer arrives. No three.js imports (AGENTS.md §3.6) and no
 * third-party code: Zstandard frames (SPZ 4) are sent to the main thread, which decompresses
 * them with the decoder shipped in the host's three.js. The result's typed arrays are
 * transferred back.
 */
import { TerraViewError } from '../core/errors';
import { budgetSplats, computeSplatBounds, limitShDegree, selectSplats, splatTransferables, type SplatBounds, type SplatData } from './splatData';
import { decodeSplats, detectSplatFormat, type SplatFormat } from './splatFormats';
import { buildSplatIndex, type SplatIndex } from './splatIndex';

export interface SplatLoadRequest {
  /** Absolute URL to download, or the file's bytes. */
  url?: string;
  bytes?: ArrayBuffer;
  /** File name or URL for format detection when the bytes do not tell. */
  name: string;
  format?: SplatFormat;
  headers?: Record<string, string>;
  credentials?: RequestCredentials;
  maxSplats: number;
  maxShDegree: number;
  /** Share of the centers ignored on either side of each axis for the core bounds. */
  boundsTrim: number;
}

/** What the main thread sends: the request, then an answer per Zstandard frame the Worker asked for. */
export type SplatWorkerInput = SplatLoadRequest | { zstd: number; bytes: Uint8Array | null; error?: string };

export type SplatLoadMessage =
  | { type: 'progress'; loaded: number; total: number }
  /** Please decompress this Zstandard frame of `size` bytes (answer with `{ zstd: id, bytes }`). */
  | { type: 'zstd'; id: number; bytes: Uint8Array; size: number }
  | { type: 'done'; result: SplatLoadResult }
  | { type: 'error'; code: string | null; message: string; details: Record<string, string | number> };

export interface SplatLoadResult {
  data: SplatData;
  bounds: SplatBounds;
  index: SplatIndex;
  format: SplatFormat;
  /** Splats and spherical harmonics degree in the file, before the budget. */
  sourceCount: number;
  sourceShDegree: number;
  fileBytes: number;
  decodeMs: number;
}

const post = (message: SplatLoadMessage, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(message, transfer);

async function download(request: SplatLoadRequest): Promise<Uint8Array> {
  const url = request.url!;
  let response: Response;
  try {
    response = await fetch(url, { headers: request.headers, credentials: request.credentials });
  } catch (e) {
    throw new TerraViewError('splat-load-failed', `Could not load ${url}: ${e instanceof Error ? e.message : String(e)}`, { url, reason: 'network error' });
  }
  if (!response.ok) throw new TerraViewError('splat-load-failed', `Could not load ${url}: HTTP ${response.status}`, { url, reason: `HTTP ${response.status}` });
  // The length is only usable for progress when the body is not compressed in transit.
  const total = response.headers.get('content-encoding') ? 0 : Number(response.headers.get('content-length') ?? 0);
  if (!response.body) return new Uint8Array(await response.arrayBuffer());
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  let reported = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    // A message per megabyte at most.
    if (loaded - reported >= 1 << 20) {
      reported = loaded;
      post({ type: 'progress', loaded, total });
    }
  }
  const bytes = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  post({ type: 'progress', loaded, total: loaded });
  return bytes;
}

/** Zstandard frames waiting for the main thread, by request id. */
const zstdWaiting = new Map<number, { resolve: (bytes: Uint8Array) => void; reject: (error: Error) => void }>();
let nextZstdId = 1;

function zstdOnMainThread(bytes: Uint8Array, size: number): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const id = nextZstdId++;
    zstdWaiting.set(id, { resolve, reject });
    // A copy: the frame is a view into the file.
    const frame = bytes.slice();
    post({ type: 'zstd', id, bytes: frame, size }, [frame.buffer]);
  });
}

async function load(request: SplatLoadRequest): Promise<SplatLoadResult> {
  const bytes = request.bytes ? new Uint8Array(request.bytes) : await download(request);
  const start = performance.now();
  const format = request.format ?? detectSplatFormat(bytes, request.name);
  let data = await decodeSplats(bytes, format, { zstd: zstdOnMainThread });
  const sourceCount = data.count;
  const sourceShDegree = data.shDegree;
  data = limitShDegree(data, request.maxShDegree);
  const keep = budgetSplats(data, request.maxSplats);
  if (keep) data = selectSplats(data, keep);
  if (data.count === 0) throw new TerraViewError('splat-invalid', 'The file has no splats that can be drawn', { format: format ?? 'unknown', reason: 'no drawable splats' });
  const bounds = computeSplatBounds(data, request.boundsTrim);
  const index = buildSplatIndex(data);
  return { data, bounds, index, format: format!, sourceCount, sourceShDegree, fileBytes: bytes.length, decodeMs: performance.now() - start };
}

self.onmessage = (event: MessageEvent<SplatWorkerInput>) => {
  const input = event.data;
  if ('zstd' in input) {
    const waiting = zstdWaiting.get(input.zstd);
    zstdWaiting.delete(input.zstd);
    if (input.bytes) waiting?.resolve(input.bytes);
    else waiting?.reject(new Error(input.error ?? 'Zstandard decompression failed'));
    return;
  }
  load(input).then(
    (result) => post({ type: 'done', result }, [...splatTransferables(result.data), result.index.bounds.buffer, result.index.links.buffer, result.index.items.buffer] as Transferable[]),
    (e: unknown) => {
      const error = e instanceof TerraViewError ? e : null;
      post({ type: 'error', code: error?.code ?? null, message: e instanceof Error ? e.message : String(e), details: { ...(error?.details ?? {}) } });
    },
  );
};
