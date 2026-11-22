/**
 * Picking Gaussian splats on the CPU: a bounding volume hierarchy over the splats and a
 * ray query through it. Splats do not write depth and are not in the GPU pick buffer, so
 * every pick on a splat layer (clicks, hover, the camera's zoom-to-cursor and orbit pivot)
 * is answered here. Pure functions on typed arrays (no three.js), built in the splat
 * Worker and queried on the main thread. See docs/agents/splats.md §5.
 *
 * What a ray hits: splats are fuzzy, so the hit is where the opacity gathered along the
 * ray (front to back, each splat at its strongest point on the ray) reaches `minOpacity`:
 * the surface one sees, not the first faint floater in front of it.
 *
 * Why a hierarchy and not a grid: splat sizes within one scene span orders of magnitude
 * (a grid sized for the many small ones leaves most of a real scene in an "oversized" list
 * that every ray has to walk; measured on the sample scenes). Boxes here are exact for
 * each splat: an ellipsoid's extent along an axis is the cutoff times the square root of
 * the covariance's diagonal entry.
 */
import type { SplatData } from './splatData';

/** Splats drawn extend to this many standard deviations (three.js `GaussianSplat`'s cutoff). */
const KERNEL_CUTOFF = 2;
/** Splats in a leaf at most. */
const LEAF_SIZE = 8;
/** Flat splats have a singular covariance: each axis is raised by this fraction of the trace. */
const FLATNESS = 1e-4;

/**
 * Hierarchy over the splats that can be hit. Nodes are stored depth first: an inner node's
 * first child follows it. All arrays are transferable.
 */
export interface SplatIndex {
  nodeCount: number;
  /** Box per node: min x, y, z, max x, y, z (splat extents included). */
  bounds: Float32Array;
  /** Per node: [second child, 0] for an inner node, [first item, item count] for a leaf. */
  links: Uint32Array;
  /** Splat indices, grouped by leaf. */
  items: Uint32Array;
}

export interface SplatRayHit {
  /** Distance along the ray, in the units of the data. */
  distance: number;
  /** Index of the splat at which the gathered opacity crossed the threshold. */
  index: number;
  /** Opacity gathered up to and including that splat (0..1). */
  opacity: number;
}

export interface SplatRayOptions {
  /** Gathered opacity that counts as a surface (default 0.5). */
  minOpacity?: number;
  /** Ignore hits beyond this distance. */
  maxDistance?: number;
  /** Only splats whose byte is non-zero take part (a layer's crop); all when omitted. */
  mask?: Uint8Array | null;
}

/** Builds the hierarchy (about 0.3 s per million splats). Splats without opacity or extent are left out. */
export function buildSplatIndex(data: SplatData): SplatIndex {
  const { count, centers, covariances, colors } = data;
  // Half extents of each splat's box.
  const extents = new Float32Array(count * 3);
  const items = new Uint32Array(count);
  let n = 0;
  for (let i = 0; i < count; i++) {
    const xx = covariances[i * 6];
    const yy = covariances[i * 6 + 3];
    const zz = covariances[i * 6 + 5];
    const drawable = colors[i * 4 + 3] >= 3 && xx + yy + zz > 0 && Number.isFinite(xx + yy + zz) && Number.isFinite(centers[i * 3] + centers[i * 3 + 1] + centers[i * 3 + 2]);
    if (!drawable) continue;
    // With the same floor the ray test adds, so that a box never clips its splat.
    const floor = (xx + yy + zz) * FLATNESS;
    extents[i * 3] = KERNEL_CUTOFF * Math.sqrt(Math.max(xx, 0) + floor);
    extents[i * 3 + 1] = KERNEL_CUTOFF * Math.sqrt(Math.max(yy, 0) + floor);
    extents[i * 3 + 2] = KERNEL_CUTOFF * Math.sqrt(Math.max(zz, 0) + floor);
    items[n++] = i;
  }
  if (n === 0) return { nodeCount: 0, bounds: new Float32Array(0), links: new Uint32Array(0), items: new Uint32Array(0) };
  let capacity = Math.max(16, Math.ceil(n / 2));
  let bounds = new Float32Array(capacity * 6);
  let links = new Uint32Array(capacity * 2);
  let nodeCount = 0;
  const newNode = (): number => {
    if (nodeCount === capacity) {
      capacity *= 2;
      const b = new Float32Array(capacity * 6);
      b.set(bounds);
      bounds = b;
      const l = new Uint32Array(capacity * 2);
      l.set(links);
      links = l;
    }
    return nodeCount++;
  };

  // Depth first with an explicit stack: [start, end, parent whose second child this is (or −1)].
  const stack: number[] = [0, n, -1];
  while (stack.length > 0) {
    const parent = stack.pop()!;
    const end = stack.pop()!;
    const start = stack.pop()!;
    const node = newNode();
    if (parent >= 0) links[parent * 2] = node;
    // Box of the splats, and of their centers (what the split looks at).
    let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    let cMinX = Infinity, cMinY = Infinity, cMinZ = Infinity, cMaxX = -Infinity, cMaxY = -Infinity, cMaxZ = -Infinity;
    for (let k = start; k < end; k++) {
      const i = items[k] * 3;
      const x = centers[i], y = centers[i + 1], z = centers[i + 2];
      const ex = extents[i], ey = extents[i + 1], ez = extents[i + 2];
      if (x - ex < minX) minX = x - ex;
      if (y - ey < minY) minY = y - ey;
      if (z - ez < minZ) minZ = z - ez;
      if (x + ex > maxX) maxX = x + ex;
      if (y + ey > maxY) maxY = y + ey;
      if (z + ez > maxZ) maxZ = z + ez;
      if (x < cMinX) cMinX = x;
      if (y < cMinY) cMinY = y;
      if (z < cMinZ) cMinZ = z;
      if (x > cMaxX) cMaxX = x;
      if (y > cMaxY) cMaxY = y;
      if (z > cMaxZ) cMaxZ = z;
    }
    bounds.set([minX, minY, minZ, maxX, maxY, maxZ], node * 6);
    const size = end - start;
    if (size <= LEAF_SIZE) {
      links[node * 2] = start;
      links[node * 2 + 1] = size;
      continue;
    }
    // Split the longest axis of the centers at its middle; halve the list when that separates nothing.
    const dx = cMaxX - cMinX, dy = cMaxY - cMinY, dz = cMaxZ - cMinZ;
    const axis = dx >= dy && dx >= dz ? 0 : dy >= dz ? 1 : 2;
    const middle = axis === 0 ? (cMinX + cMaxX) / 2 : axis === 1 ? (cMinY + cMaxY) / 2 : (cMinZ + cMaxZ) / 2;
    let lo = start;
    let hi = end - 1;
    while (lo <= hi) {
      if (centers[items[lo] * 3 + axis] < middle) lo++;
      else {
        const t = items[lo];
        items[lo] = items[hi];
        items[hi] = t;
        hi--;
      }
    }
    if (lo === start || lo === end) lo = start + (size >> 1);
    links[node * 2 + 1] = 0;
    // The second child is pushed first, so the first child is built next and follows its parent.
    stack.push(lo, end, node);
    stack.push(start, lo, -1);
  }
  return { nodeCount, bounds: bounds.slice(0, nodeCount * 6), links: links.slice(0, nodeCount * 2), items: items.slice(0, n) };
}

/** Scratch of a query (one at a time on the main thread). */
const nodeStack: number[] = [];
const entryStack: number[] = [];
const candidateT: number[] = [];
const candidateAlpha: number[] = [];
const candidateIndex: number[] = [];
const order: number[] = [];

/**
 * First surface of the splats on a ray (`origin`, unit `direction`, both in the
 * coordinates of the data); null when the ray gathers less than `minOpacity`.
 */
export function raycastSplats(data: SplatData, index: SplatIndex, origin: ArrayLike<number>, direction: ArrayLike<number>, options: SplatRayOptions = {}): SplatRayHit | null {
  if (index.nodeCount === 0) return null;
  const minOpacity = options.minOpacity ?? 0.5;
  const maxDistance = options.maxDistance ?? Infinity;
  const mask = options.mask ?? null;
  const { centers, covariances, colors } = data;
  const { bounds, links, items } = index;
  const ox = origin[0], oy = origin[1], oz = origin[2];
  const dx = direction[0], dy = direction[1], dz = direction[2];
  const ix = 1 / dx, iy = 1 / dy, iz = 1 / dz;

  /** Where the ray enters a node's box; Infinity when it misses or the box lies beyond `limit`. */
  const enter = (node: number, limit: number): number => {
    const b = node * 6;
    let t0 = 0;
    let t1 = limit;
    if (dx !== 0) {
      const a = (bounds[b] - ox) * ix;
      const c = (bounds[b + 3] - ox) * ix;
      t0 = Math.max(t0, Math.min(a, c));
      t1 = Math.min(t1, Math.max(a, c));
    } else if (ox < bounds[b] || ox > bounds[b + 3]) return Infinity;
    if (dy !== 0) {
      const a = (bounds[b + 1] - oy) * iy;
      const c = (bounds[b + 4] - oy) * iy;
      t0 = Math.max(t0, Math.min(a, c));
      t1 = Math.min(t1, Math.max(a, c));
    } else if (oy < bounds[b + 1] || oy > bounds[b + 4]) return Infinity;
    if (dz !== 0) {
      const a = (bounds[b + 2] - oz) * iz;
      const c = (bounds[b + 5] - oz) * iz;
      t0 = Math.max(t0, Math.min(a, c));
      t1 = Math.min(t1, Math.max(a, c));
    } else if (oz < bounds[b + 2] || oz > bounds[b + 5]) return Infinity;
    return t0 <= t1 ? t0 : Infinity;
  };

  let found = 0;
  // Distance at which the candidates found so far reach the threshold, and that candidate.
  let hitDistance = Infinity;
  let hitIndex = -1;
  let hitOpacity = 0;

  /** Front to back over the candidates: transmittance falls by each splat's response. */
  const resolve = () => {
    order.length = found;
    for (let k = 0; k < found; k++) order[k] = k;
    order.sort((p, q) => candidateT[p] - candidateT[q]);
    let transmittance = 1;
    for (let k = 0; k < found; k++) {
      const j = order[k];
      transmittance *= 1 - Math.min(candidateAlpha[j], 0.99);
      if (1 - transmittance >= minOpacity) {
        hitDistance = candidateT[j];
        hitIndex = candidateIndex[j];
        hitOpacity = 1 - transmittance;
        return;
      }
    }
  };

  nodeStack.length = 0;
  entryStack.length = 0;
  const rootEntry = enter(0, maxDistance);
  if (rootEntry === Infinity) return null;
  nodeStack.push(0);
  entryStack.push(rootEntry);
  while (nodeStack.length > 0) {
    const node = nodeStack.pop()!;
    // A splat's strongest point on the ray lies inside its box: nothing in a box entered
    // beyond the hit can come before it.
    if (entryStack.pop()! > hitDistance) continue;
    const size = links[node * 2 + 1];
    if (size === 0) {
      const first = node + 1;
      const second = links[node * 2];
      const limit = Math.min(maxDistance, hitDistance);
      const t1 = enter(first, limit);
      const t2 = enter(second, limit);
      // The nearer child on top of the stack.
      const near = t1 <= t2 ? first : second;
      const far = t1 <= t2 ? second : first;
      const tNear = Math.min(t1, t2);
      const tFar = Math.max(t1, t2);
      if (tFar !== Infinity) {
        nodeStack.push(far);
        entryStack.push(tFar);
      }
      if (tNear !== Infinity) {
        nodeStack.push(near);
        entryStack.push(tNear);
      }
      continue;
    }
    let added = false;
    const start = links[node * 2];
    for (let s = start; s < start + size; s++) {
      const i = items[s];
      if (mask && mask[i] === 0) continue;
      // Strongest response of splat i along the ray.
      const px = centers[i * 3] - ox;
      const py = centers[i * 3 + 1] - oy;
      const pz = centers[i * 3 + 2] - oz;
      const k = i * 6;
      let a = covariances[k];
      const b = covariances[k + 1];
      const c = covariances[k + 2];
      let d = covariances[k + 3];
      const e = covariances[k + 4];
      let f = covariances[k + 5];
      const floor = (a + d + f) * FLATNESS;
      a += floor;
      d += floor;
      f += floor;
      // Inverse of the symmetric covariance by cofactors (times its determinant).
      const c00 = d * f - e * e;
      const c01 = c * e - b * f;
      const c02 = b * e - c * d;
      const det = a * c00 + b * c01 + c * c02;
      if (!(det > 0)) continue;
      const c11 = a * f - c * c;
      const c12 = b * c - a * e;
      const c22 = a * d - b * b;
      const mdx = c00 * dx + c01 * dy + c02 * dz;
      const mdy = c01 * dx + c11 * dy + c12 * dz;
      const mdz = c02 * dx + c12 * dy + c22 * dz;
      const dd = dx * mdx + dy * mdy + dz * mdz;
      if (!(dd > 0)) continue;
      const dp = px * mdx + py * mdy + pz * mdz;
      const t = dp / dd;
      if (t < 0 || t > maxDistance || t > hitDistance) continue;
      const pp = px * (c00 * px + c01 * py + c02 * pz) + py * (c01 * px + c11 * py + c12 * pz) + pz * (c02 * px + c12 * py + c22 * pz);
      // Squared Mahalanobis distance of the ray's closest approach to the splat.
      const m2 = (pp - (dp * dp) / dd) / det;
      if (m2 > KERNEL_CUTOFF * KERNEL_CUTOFF) continue;
      const alpha = (colors[i * 4 + 3] / 255) * Math.exp(-0.5 * Math.max(m2, 0));
      if (alpha < 1 / 255) continue;
      candidateT[found] = t;
      candidateAlpha[found] = alpha;
      candidateIndex[found] = i;
      found++;
      added = true;
    }
    if (added) resolve();
  }
  return hitIndex < 0 ? null : { distance: hitDistance, index: hitIndex, opacity: hitOpacity };
}
