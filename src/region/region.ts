/**
 * Local scene regions (docs/agents/local-scene.md §3): the area a local scene
 * shows, as a vertical prism in the east-north-up frame of its center. Every
 * consumer (globe tile culling and clipping, 3D Tiles masking, walls, picking,
 * camera bounds) uses this one definition, so they agree with each other.
 *
 * Campus to city sized areas only (at most `MAX_REGION_DIAMETER`): the prism
 * follows the inputs in longitude / latitude to within h·d/R (a few meters at
 * that size), and the clip shader stays cheap.
 */
import { Matrix4, Vector3 } from 'three';
import type { Ellipsoid } from '../core/Ellipsoid';
import { TerraViewError } from '../core/errors';
import { DEG2RAD, RAD2DEG } from '../core/math';

/** Area of a local scene. Degrees for longitude / latitude, meters for lengths. */
export type LocalRegion =
  | {
      type: 'circle';
      /** [longitude, latitude] in degrees. */
      center: readonly [number, number];
      /** Meters, `MIN_REGION_RADIUS` to half of `MAX_REGION_DIAMETER`. */
      radius: number;
    }
  | {
      type: 'rectangle';
      /** Degrees; west < east (the rectangle may not cross the antimeridian), south < north. */
      west: number;
      south: number;
      east: number;
      north: number;
    }
  | {
      type: 'polygon';
      /**
       * One ring of [longitude, latitude] in degrees, not self-intersecting, without holes (a
       * closing vertex equal to the first is dropped). More than `MAX_REGION_VERTICES` vertices
       * are simplified.
       */
      coordinates: readonly (readonly [number, number])[];
    };

/** Most polygon vertices the clip shader tests. */
export const MAX_REGION_VERTICES = 64;
/** Largest region (meters across): campus to city scale. */
export const MAX_REGION_DIAMETER = 100_000;
/** Smallest circle radius (meters). */
export const MIN_REGION_RADIUS = 20;
/** Highest |latitude| (degrees) of any region vertex (the globe's Web Mercator tiles stop near 85°). */
export const MAX_REGION_LATITUDE = 84;
/**
 * Height band (meters, relative to the region center) outside of which nothing belongs to the
 * region: the earth curves down by d²/2R (196 m at 50 km) and terrain spans about 9 km. Keeps
 * geometry on the far side of the planet, which projects into the prism too, out.
 */
export const REGION_Z_RANGE: readonly [number, number] = [-30_000, 30_000];

/** How a volume relates to a region. */
export const RegionRelation = {
  OUTSIDE: 0,
  CROSSING: 1,
  INSIDE: 2,
} as const;
export type RegionRelation = (typeof RegionRelation)[keyof typeof RegionRelation];

const RECT_SEGMENTS_PER_EDGE = 8;
const CIRCLE_OUTLINE_SEGMENTS = 128;

const _p = new Vector3();
const _q = new Vector3();

function invalid(expected: string): TerraViewError {
  return new TerraViewError('option-invalid', `local scene region: ${expected}`, { option: 'region', expected });
}

function finite(...v: number[]): boolean {
  return v.every((x) => Number.isFinite(x));
}

/**
 * A validated region placed on the ellipsoid: its frame (ENU at the center,
 * at `centerHeight`) and its shape in that frame's XY plane (meters).
 */
export class ResolvedRegion {
  readonly kind: 'circle' | 'polygon';
  /** Center longitude / latitude in degrees. */
  readonly longitude: number;
  readonly latitude: number;
  /** Ellipsoidal height of the frame origin (meters): the ground at the center once known. */
  centerHeight = 0;
  /** Circle radius, or the distance from the center to the farthest vertex (meters). */
  radius = 0;
  /** Polygon vertices in the region frame: x0, y0, x1, y1, ... (open ring). Empty for circles. */
  vertices = new Float64Array(0);
  /** Region frame → ECEF and back (float64; the shader receives products of these, see `regionMask.ts`). */
  readonly regionToWorld = new Matrix4();
  readonly worldToRegion = new Matrix4();
  /** The input outline in degrees ([lon, lat] pairs): polygon vertices, or a sampled circle. */
  readonly outline: readonly (readonly [number, number])[];
  private readonly circleRadius: number;

  /** @internal Use `viewer.localScene` (regions are resolved when entering). */
  constructor(
    private readonly ellipsoid: Ellipsoid,
    kind: 'circle' | 'polygon',
    longitude: number,
    latitude: number,
    outline: readonly (readonly [number, number])[],
    circleRadius = 0,
  ) {
    this.kind = kind;
    this.longitude = longitude;
    this.latitude = latitude;
    this.outline = outline;
    this.circleRadius = circleRadius;
    this.setCenterHeight(0);
  }

  /** Moves the frame origin to a new ground height at the center (meters) and re-projects the shape. */
  setCenterHeight(height: number): void {
    this.centerHeight = height;
    const origin = this.ellipsoid.cartographicToCartesian(this.longitude * DEG2RAD, this.latitude * DEG2RAD, height, _p);
    this.ellipsoid.eastNorthUpToFixedFrame(origin, this.regionToWorld);
    this.worldToRegion.copy(this.regionToWorld).invert();
    if (this.kind === 'circle') {
      this.radius = this.circleRadius;
      return;
    }
    const n = this.outline.length;
    const v = new Float64Array(n * 2);
    let r = 0;
    for (let i = 0; i < n; i++) {
      const [lon, lat] = this.outline[i];
      this.ellipsoid.cartographicToCartesian(lon * DEG2RAD, lat * DEG2RAD, height, _p).applyMatrix4(this.worldToRegion);
      v[i * 2] = _p.x;
      v[i * 2 + 1] = _p.y;
      r = Math.max(r, Math.hypot(_p.x, _p.y));
    }
    this.vertices = v;
    this.radius = r;
  }

  /** ECEF point → region frame. */
  toRegion(world: Vector3, out = new Vector3()): Vector3 {
    return out.copy(world).applyMatrix4(this.worldToRegion);
  }

  /** Region frame → ECEF point. */
  toWorld(local: Vector3, out = new Vector3()): Vector3 {
    return out.copy(local).applyMatrix4(this.regionToWorld);
  }

  /** Distance (meters) from a region-frame XY point to the boundary: positive inside, negative outside. */
  signedDistance(x: number, y: number): number {
    if (this.kind === 'circle') return this.radius - Math.hypot(x, y);
    return polygonSignedDistance(this.vertices, x, y);
  }

  /** Whether an ECEF point lies in the prism, optionally widened by `margin` meters. */
  containsWorld(world: Vector3, margin = 0): boolean {
    const p = this.toRegion(world, _q);
    if (p.z < REGION_Z_RANGE[0] || p.z > REGION_Z_RANGE[1]) return false;
    return this.signedDistance(p.x, p.y) >= -margin;
  }

  /** Whether a position (degrees) lies in the region. */
  contains(longitude: number, latitude: number): boolean {
    this.ellipsoid.cartographicToCartesian(longitude * DEG2RAD, latitude * DEG2RAD, this.centerHeight, _p);
    return this.containsWorld(_p);
  }

  /** How a sphere (ECEF center, radius in meters) relates to the prism. Conservative: unsure cases are CROSSING. */
  relateSphere(center: Vector3, radius: number): RegionRelation {
    const p = this.toRegion(center, _q);
    const [zMin, zMax] = REGION_Z_RANGE;
    if (p.z - radius > zMax || p.z + radius < zMin) return RegionRelation.OUTSIDE;
    const d = this.signedDistance(p.x, p.y);
    if (d <= -radius) return RegionRelation.OUTSIDE;
    if (d >= radius && p.z - radius >= zMin && p.z + radius <= zMax) return RegionRelation.INSIDE;
    return RegionRelation.CROSSING;
  }

  /**
   * Moves a region-frame XY point back inside the region widened by `margin` meters (the
   * nearest such point). Returns false (and `out` = the input) when it is already inside.
   */
  clampXY(x: number, y: number, margin: number, out: { x: number; y: number }): boolean {
    out.x = x;
    out.y = y;
    if (this.signedDistance(x, y) >= -margin) return false;
    if (this.kind === 'circle') {
      const r = Math.hypot(x, y);
      const k = (this.radius + margin) / r;
      out.x = x * k;
      out.y = y * k;
      return true;
    }
    const q = nearestOnPolygon(this.vertices, x, y);
    const dx = x - q.x;
    const dy = y - q.y;
    const len = Math.hypot(dx, dy) || 1;
    out.x = q.x + (dx / len) * margin;
    out.y = q.y + (dy / len) * margin;
    return true;
  }

  /**
   * Points along the boundary in the region frame (x0, y0, x1, y1, ...; a closed loop, the last
   * point connects to the first), at most `spacing` meters apart, every polygon vertex included.
   */
  boundaryPoints(spacing: number, maxPoints = 2048): Float64Array {
    if (this.kind === 'circle') {
      const n = Math.min(maxPoints, Math.max(64, Math.ceil((2 * Math.PI * this.radius) / spacing)));
      const out = new Float64Array(n * 2);
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2;
        out[i * 2] = Math.cos(a) * this.radius;
        out[i * 2 + 1] = Math.sin(a) * this.radius;
      }
      return out;
    }
    const v = this.vertices;
    const n = v.length / 2;
    let perimeter = 0;
    for (let i = 0; i < n; i++) perimeter += Math.hypot(v[((i + 1) % n) * 2] - v[i * 2], v[((i + 1) % n) * 2 + 1] - v[i * 2 + 1]);
    const step = Math.max(spacing, perimeter / Math.max(n, maxPoints - n));
    const pts: number[] = [];
    for (let i = 0; i < n; i++) {
      const ax = v[i * 2];
      const ay = v[i * 2 + 1];
      const bx = v[((i + 1) % n) * 2];
      const by = v[((i + 1) % n) * 2 + 1];
      const k = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / step));
      for (let j = 0; j < k; j++) pts.push(ax + ((bx - ax) * j) / k, ay + ((by - ay) * j) / k);
    }
    return new Float64Array(pts);
  }
}

/** Distance from (x, y) to a polygon's boundary, positive inside (even-odd rule). */
export function polygonSignedDistance(v: Float64Array, x: number, y: number): number {
  const n = v.length / 2;
  let inside = false;
  let best = Infinity;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const ax = v[j * 2];
    const ay = v[j * 2 + 1];
    const bx = v[i * 2];
    const by = v[i * 2 + 1];
    if (ay > y !== by > y && x < ((bx - ax) * (y - ay)) / (by - ay) + ax) inside = !inside;
    best = Math.min(best, segmentDistanceSq(x, y, ax, ay, bx, by));
  }
  const d = Math.sqrt(best);
  return inside ? d : -d;
}

function segmentDistanceSq(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? Math.min(1, Math.max(0, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
  const ex = ax + dx * t - px;
  const ey = ay + dy * t - py;
  return ex * ex + ey * ey;
}

function nearestOnPolygon(v: Float64Array, x: number, y: number): { x: number; y: number } {
  const n = v.length / 2;
  let best = Infinity;
  let qx = x;
  let qy = y;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const ax = v[j * 2];
    const ay = v[j * 2 + 1];
    const dx = v[i * 2] - ax;
    const dy = v[i * 2 + 1] - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 > 0 ? Math.min(1, Math.max(0, ((x - ax) * dx + (y - ay) * dy) / len2)) : 0;
    const cx = ax + dx * t;
    const cy = ay + dy * t;
    const d = (cx - x) ** 2 + (cy - y) ** 2;
    if (d < best) {
      best = d;
      qx = cx;
      qy = cy;
    }
  }
  return { x: qx, y: qy };
}

/** Whether segments ab and cd cross (touching at shared end points does not count). */
function segmentsCross(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, dx: number, dy: number): boolean {
  const o = (px: number, py: number, qx: number, qy: number, rx: number, ry: number) => Math.sign((qx - px) * (ry - py) - (qy - py) * (rx - px));
  const o1 = o(ax, ay, bx, by, cx, cy);
  const o2 = o(ax, ay, bx, by, dx, dy);
  const o3 = o(cx, cy, dx, dy, ax, ay);
  const o4 = o(cx, cy, dx, dy, bx, by);
  return o1 * o2 < 0 && o3 * o4 < 0;
}

/** Whether a ring (x0, y0, ...) has two non-adjacent edges that cross. */
export function ringSelfIntersects(v: Float64Array): boolean {
  const n = v.length / 2;
  for (let i = 0; i < n; i++) {
    const i2 = (i + 1) % n;
    for (let j = i + 2; j < n; j++) {
      const j2 = (j + 1) % n;
      if (j2 === i) continue;
      if (segmentsCross(v[i * 2], v[i * 2 + 1], v[i2 * 2], v[i2 * 2 + 1], v[j * 2], v[j * 2 + 1], v[j2 * 2], v[j2 * 2 + 1])) return true;
    }
  }
  return false;
}

/**
 * Indices of the ring vertices kept by Douglas-Peucker with a tolerance (meters); the ring is
 * split at its first vertex and the vertex farthest from it.
 */
function simplifyRing(xy: Float64Array, tolerance: number): number[] {
  const n = xy.length / 2;
  let far = 0;
  let farD = -1;
  for (let i = 1; i < n; i++) {
    const d = Math.hypot(xy[i * 2] - xy[0], xy[i * 2 + 1] - xy[1]);
    if (d > farD) {
      farD = d;
      far = i;
    }
  }
  const keep = new Uint8Array(n);
  keep[0] = keep[far] = 1;
  const stack: [number, number][] = [
    [0, far],
    [far, n],
  ];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const bi = b % n;
    let maxD = -1;
    let idx = -1;
    for (let i = a + 1; i < b; i++) {
      const d = Math.sqrt(segmentDistanceSq(xy[i * 2], xy[i * 2 + 1], xy[a * 2], xy[a * 2 + 1], xy[bi * 2], xy[bi * 2 + 1]));
      if (d > maxD) {
        maxD = d;
        idx = i;
      }
    }
    if (idx >= 0 && maxD > tolerance) {
      keep[idx] = 1;
      stack.push([a, idx], [idx, b]);
    }
  }
  const out: number[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(i);
  return out;
}

/**
 * Validates a region and places it on the ellipsoid (frame origin at 0 m until the caller
 * knows the ground height: `setCenterHeight`). Throws `option-invalid` for bad input.
 */
export function resolveRegion(region: LocalRegion, ellipsoid: Ellipsoid): ResolvedRegion {
  const checkLat = (lat: number) => {
    if (Math.abs(lat) > MAX_REGION_LATITUDE) throw invalid(`latitudes within ±${MAX_REGION_LATITUDE}°`);
  };
  const checkLon = (lon: number) => {
    if (lon < -180 || lon > 180) throw invalid('longitudes within ±180°');
  };
  if (region?.type === 'circle') {
    const [lon, lat] = region.center ?? [];
    if (!finite(lon, lat, region.radius)) throw invalid('circle center [lon, lat] (degrees) and radius (meters)');
    checkLon(lon);
    checkLat(lat);
    if (region.radius < MIN_REGION_RADIUS || region.radius * 2 > MAX_REGION_DIAMETER) {
      throw invalid(`circle radius from ${MIN_REGION_RADIUS} to ${MAX_REGION_DIAMETER / 2} meters`);
    }
    const outline: [number, number][] = [];
    const r = new ResolvedRegion(ellipsoid, 'circle', lon, lat, [], region.radius);
    for (let i = 0; i < CIRCLE_OUTLINE_SEGMENTS; i++) {
      const a = (i / CIRCLE_OUTLINE_SEGMENTS) * Math.PI * 2;
      const c = ellipsoid.cartesianToCartographic(r.toWorld(_p.set(Math.cos(a) * region.radius, Math.sin(a) * region.radius, 0), _q));
      if (c) outline.push([c.longitude * RAD2DEG, c.latitude * RAD2DEG]);
    }
    (r as { outline: readonly (readonly [number, number])[] }).outline = outline;
    return r;
  }
  let ring: [number, number][];
  if (region?.type === 'rectangle') {
    const { west, south, east, north } = region;
    if (!finite(west, south, east, north) || !(west < east) || !(south < north)) throw invalid('rectangle with west < east and south < north (degrees)');
    checkLon(west);
    checkLon(east);
    checkLat(south);
    checkLat(north);
    // Parallels curve in the region frame: densify the edges so the prism follows them.
    ring = [];
    const k = RECT_SEGMENTS_PER_EDGE;
    for (let i = 0; i < k; i++) ring.push([west + ((east - west) * i) / k, south]);
    for (let i = 0; i < k; i++) ring.push([east, south + ((north - south) * i) / k]);
    for (let i = 0; i < k; i++) ring.push([east - ((east - west) * i) / k, north]);
    for (let i = 0; i < k; i++) ring.push([west, north - ((north - south) * i) / k]);
  } else if (region?.type === 'polygon') {
    ring = (region.coordinates ?? []).map((c) => [c[0], c[1]] as [number, number]);
    if (ring.length > 1) {
      const a = ring[0];
      const b = ring[ring.length - 1];
      if (a[0] === b[0] && a[1] === b[1]) ring.pop();
    }
    if (ring.length < 3 || !ring.every((c) => finite(c[0], c[1]))) throw invalid('polygon with at least 3 [lon, lat] vertices (degrees)');
    for (const [lon, lat] of ring) {
      checkLon(lon);
      checkLat(lat);
    }
    let minLon = Infinity;
    let maxLon = -Infinity;
    for (const [lon] of ring) {
      minLon = Math.min(minLon, lon);
      maxLon = Math.max(maxLon, lon);
    }
    if (maxLon - minLon >= 180) throw invalid('polygon that does not cross the antimeridian');
  } else {
    throw invalid("type 'circle', 'rectangle' or 'polygon'");
  }

  // Center: middle of the bounding box in degrees (inside or not, it only anchors the frame).
  let minLon = Infinity;
  let maxLon = -Infinity;
  let minLat = Infinity;
  let maxLat = -Infinity;
  for (const [lon, lat] of ring) {
    minLon = Math.min(minLon, lon);
    maxLon = Math.max(maxLon, lon);
    minLat = Math.min(minLat, lat);
    maxLat = Math.max(maxLat, lat);
  }
  let resolved = new ResolvedRegion(ellipsoid, 'polygon', (minLon + maxLon) / 2, (minLat + maxLat) / 2, ring);
  if (resolved.radius * 2 > MAX_REGION_DIAMETER) throw invalid(`region at most ${MAX_REGION_DIAMETER / 1000} km across`);
  if (polygonArea(resolved.vertices) < 100) throw invalid('polygon with an area');
  if (ring.length > MAX_REGION_VERTICES) {
    // Simplify with a growing tolerance until the shader limit is met.
    let tolerance = resolved.radius * 1e-4;
    let kept = simplifyRing(resolved.vertices, tolerance);
    while (kept.length > MAX_REGION_VERTICES) {
      tolerance *= 1.5;
      kept = simplifyRing(resolved.vertices, tolerance);
    }
    ring = kept.map((i) => ring[i]);
    resolved = new ResolvedRegion(ellipsoid, 'polygon', resolved.longitude, resolved.latitude, ring);
  }
  if (ringSelfIntersects(resolved.vertices)) throw invalid('polygon that does not intersect itself');
  return resolved;
}

/** Signed area of a ring (m²; positive counter-clockwise). */
export function polygonArea(v: Float64Array): number {
  const n = v.length / 2;
  let a = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) a += v[j * 2] * v[i * 2 + 1] - v[i * 2] * v[j * 2 + 1];
  return Math.abs(a / 2);
}

/**
 * Footprint of a box (its 8 ECEF corners) on the ground: the convex hull of the corners seen
 * from above, as [lon, lat] degrees. Used to show the area of a 3D Tiles layer.
 */
export function boxFootprint(corners: readonly Vector3[], ellipsoid: Ellipsoid): [number, number][] {
  const center = new Vector3();
  for (const c of corners) center.add(c);
  center.divideScalar(corners.length);
  const frame = ellipsoid.eastNorthUpToFixedFrame(center);
  const inverse = frame.clone().invert();
  // Top and bottom corners fall on the same spot: round to millimeters and drop duplicates.
  const seen = new Set<string>();
  const pts: [number, number][] = [];
  for (const c of corners) {
    const p = c.clone().applyMatrix4(inverse);
    const x = Math.round(p.x * 1000) / 1000;
    const y = Math.round(p.y * 1000) / 1000;
    const key = x + ',' + y;
    if (seen.has(key)) continue;
    seen.add(key);
    pts.push([x, y]);
  }
  const hull = convexHull(pts);
  const out: [number, number][] = [];
  for (const [x, y] of hull) {
    const c = ellipsoid.cartesianToCartographic(new Vector3(x, y, 0).applyMatrix4(frame));
    if (c) out.push([c.longitude * RAD2DEG, c.latitude * RAD2DEG]);
  }
  return out;
}

/** Convex hull (monotone chain), counter-clockwise. */
export function convexHull(points: readonly (readonly [number, number])[]): [number, number][] {
  const p = [...points].map((q) => [q[0], q[1]] as [number, number]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o: [number, number], a: [number, number], b: [number, number]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: [number, number][] = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper: [number, number][] = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
    upper.push(q);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}
