/**
 * Level-of-detail policy for 3D Tiles beyond the plain error target: relaxing
 * distant tiles in oblique views, and backing off when the tile cache cannot
 * hold what the view asks for. Pure functions (no three.js), unit tested.
 * Background and measurements: docs/agents/gpu-memory.md §5.
 */

/** Falloff density at a grazing, low view (per meter); CesiumJS `dynamicScreenSpaceErrorDensity`. */
export const FALLOFF_DENSITY = 2e-4;
/** The falloff fades out between these camera heights above the ground (meters). */
export const FALLOFF_FADE_START = 2_000;
export const FALLOFF_FADE_END = 12_000;

/**
 * Density for the tile renderer's distance falloff
 * (`error -= errorFalloff * (1 - exp(-(distance * density)^2))`).
 *
 * An oblique view near the ground looks across tens of kilometers; without
 * the falloff those far tiles load at the same pixel error as the foreground
 * and make up most of the tiles in memory. Looking straight down nothing is
 * "far", and from high up everything is: both get no falloff, so the view
 * from orbit is not blurred.
 *
 * @param altitude Camera height above the ground in meters.
 * @param viewDotUp Cosine of the angle between the view direction and the local vertical (-1 = straight down).
 * @returns Density per meter, 0 when the falloff does not apply.
 */
export function tilesFalloffDensity(altitude: number, viewDotUp: number): number {
  if (!Number.isFinite(altitude) || !Number.isFinite(viewDotUp)) return 0;
  const horizon = 1 - Math.min(1, viewDotUp * viewDotUp);
  const t = Math.min(1, Math.max(0, (altitude - FALLOFF_FADE_START) / (FALLOFF_FADE_END - FALLOFF_FADE_START)));
  const fade = 1 - t * t * (3 - 2 * t);
  return FALLOFF_DENSITY * horizon * fade;
}

/** State of the adaptive error target of one tile cache. */
export interface AdaptiveErrorState {
  /** Factor applied to the error target (1 = as configured). */
  scale: number;
  /** Seconds tiles have been refused without a break. */
  refusedFor: number;
  /** Seconds the cache has had room without a break. */
  roomFor: number;
}

export function createAdaptiveErrorState(): AdaptiveErrorState {
  return { scale: 1, refusedFor: 0, roomFor: 0 };
}

export interface AdaptiveErrorInput {
  /** Tiles the last update wanted but could not load because the cache is full. */
  refused: number;
  /**
   * Bytes of the tiles the last update used (visible ones, their ancestors and siblings), and the size
   * eviction shrinks the cache to (`cacheMinBytes`). The cache total cannot tell whether there is room:
   * it stays at that size, filled up with unused tiles.
   */
  usedBytes: number;
  cacheMinBytes: number;
  /** Upper bound of the factor (1 disables). */
  maxScale: number;
  /** Seconds since the last step. */
  dt: number;
}

/** Refusals shorter than this are a passing burst (camera still moving), seconds. */
const REFUSED_GRACE = 0.4;
/** The cache must have had room for this long before detail comes back, seconds. */
const ROOM_GRACE = 3;
/** Growth while refusing and decay with room, per second. */
const RAISE_RATE = 0.35;
const LOWER_RATE = 0.06;
/** "Room" means the used tiles take less than this share of the size eviction shrinks the cache to. */
const ROOM_FILL = 0.85;

/**
 * Advances the adaptive error factor by one frame and returns it.
 *
 * A full cache refuses new tiles: the view stops refining and stays blurry
 * in patches for good, while the traversal retries every frame. Raising the
 * error target makes the view ask for fewer, coarser tiles until it fits,
 * so the whole view ends up evenly a little softer instead. Detail returns
 * slowly, and only once the tiles in use take clearly less than the cache
 * keeps anyway (so raising and lowering do not chase each other).
 */
export function stepAdaptiveError(state: AdaptiveErrorState, input: AdaptiveErrorInput): number {
  const max = Math.max(1, input.maxScale);
  const dt = Math.min(Math.max(input.dt, 0), 0.25);
  if (max === 1) {
    state.scale = 1;
    state.refusedFor = state.roomFor = 0;
    return 1;
  }
  if (input.refused > 0) {
    state.refusedFor += dt;
    state.roomFor = 0;
    if (state.refusedFor > REFUSED_GRACE) state.scale = Math.min(max, state.scale * (1 + RAISE_RATE * dt));
  } else {
    state.refusedFor = 0;
    const room = input.usedBytes < input.cacheMinBytes * ROOM_FILL;
    state.roomFor = room ? state.roomFor + dt : 0;
    if (state.roomFor > ROOM_GRACE) state.scale = Math.max(1, state.scale * (1 - LOWER_RATE * dt));
  }
  return state.scale;
}
