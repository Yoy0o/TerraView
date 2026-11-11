/**
 * Marker occlusion (M2.2): rules shared by `MarkerManager` and the viewer's
 * occlusion proxies. A marker with `occlusion: 'hide' | 'fade'` gets a tiny
 * proxy at its anchor that the renderer tests with an occlusion query after
 * the opaque scene; while the query reports the proxy fully hidden, the
 * marker is hidden or faded. Proxy slots come from a fixed-capacity pool with
 * index recycling (after t3d `OcclusionProxyManager`); results arrive a few
 * frames late and a state change is only accepted once it has held for a
 * couple of reads. No three.js or DOM here (unit tested).
 */

/** What happens to a marker whose anchor is hidden behind opaque geometry. */
export type OcclusionMode = 'none' | 'hide' | 'fade';

/**
 * Where the scene answers occlusion queries for markers (implemented by the
 * viewer with three.js occlusion queries; absent = markers are never occluded).
 */
export interface MarkerOcclusion {
  /** A free proxy slot, or -1 when the pool is full (the marker then counts as visible). */
  acquire(): number;
  release(slot: number): void;
  /** Places the proxy for the next render: world (ECEF) center and radius in meters. */
  place(slot: number, x: number, y: number, z: number, radius: number): void;
  /** Latest query result for the slot: true when no sample of the proxy passed the depth test. */
  occluded(slot: number): boolean;
}

/**
 * The mode a marker actually gets: important markers (those that do not
 * declutter, e.g. alarm and building cards) are never hidden, only faded
 * (AGENTS.md: important information does not make way).
 */
export function effectiveOcclusion(mode: OcclusionMode | undefined, declutter: boolean | undefined): OcclusionMode {
  if (!mode || mode === 'none') return 'none';
  return mode === 'hide' && declutter !== true ? 'fade' : mode;
}

/** Proxy radius in meters that covers `pixels` CSS pixels at a distance (perspective camera). */
export function proxyRadius(distance: number, fovDeg: number, viewportHeightPx: number, pixels = 2): number {
  const metersPerPixel = (2 * distance * Math.tan((fovDeg * Math.PI) / 360)) / Math.max(1, viewportHeightPx);
  return pixels * metersPerPixel;
}

/** Fixed-capacity slot pool: hands out indices 0..capacity-1, reuses released ones first. */
export class ProxySlots {
  private readonly free: number[] = [];
  private readonly used: Uint8Array;
  private next = 0;
  private count = 0;

  constructor(readonly capacity: number) {
    this.used = new Uint8Array(capacity);
  }

  /** A free index, or -1 when all `capacity` slots are in use. */
  acquire(): number {
    let i: number;
    if (this.free.length > 0) i = this.free.pop()!;
    else if (this.next < this.capacity) i = this.next++;
    else return -1;
    this.used[i] = 1;
    this.count++;
    return i;
  }

  /** Returns a slot; releasing a free or out-of-range slot does nothing. */
  release(i: number): void {
    if (i < 0 || i >= this.capacity || this.used[i] === 0) return;
    this.used[i] = 0;
    this.count--;
    this.free.push(i);
  }

  isUsed(i: number): boolean {
    return i >= 0 && i < this.capacity && this.used[i] === 1;
  }

  /** Slots in use. */
  get size(): number {
    return this.count;
  }
}

/** Reads in a row a new raw state must hold before the marker switches (query results can flicker at edges). */
export const OCCLUSION_CONFIRM_READS = 2;

/**
 * Debounced occlusion state of one marker. `read(raw)` feeds the latest
 * query result and returns the accepted state; it changes only after
 * `OCCLUSION_CONFIRM_READS` equal reads in a row.
 */
export class OcclusionState {
  occluded = false;
  private streak = 0;

  read(raw: boolean): boolean {
    if (raw === this.occluded) {
      this.streak = 0;
      return this.occluded;
    }
    if (++this.streak >= OCCLUSION_CONFIRM_READS) {
      this.occluded = raw;
      this.streak = 0;
    }
    return this.occluded;
  }

  /** Back to visible (proxy released: the next result is unknown). */
  reset(): void {
    this.occluded = false;
    this.streak = 0;
  }
}
