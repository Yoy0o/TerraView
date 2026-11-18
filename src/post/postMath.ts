/**
 * Rules of the post-processing pipeline and its per-object effects (roadmap M3.1 / M3.2 / M3.3)
 * that need no GPU: effect ordering and the graph key, outline styles and their pulse, the sample
 * pattern of the outline edge pass, per-object effect resolution, the jitter and weights of
 * still supersampling, color grading settings.
 *
 * No three.js here (unit tested in tests/post.test.ts).
 */

/**
 * Where an effect sits in the pipeline: `linear` effects work on the HDR scene color before
 * tone mapping (light: bloom, AO, color grading); `display` effects work on the tone-mapped,
 * sRGB-encoded picture (exact colors: outlines, overlays).
 */
export type PostStage = 'linear' | 'display';

/** What the pipeline needs to know about an effect to order it and to key the node graph. */
export interface EffectOrderInfo {
  readonly name: string;
  readonly stage: PostStage;
  /** Lower runs first within the stage (closer to the scene). */
  readonly order: number;
  /** Changes whenever the effect's node graph would come out differently. */
  readonly graphVersion: number;
  /** Names of the scene attachments (MRT outputs) the effect reads. */
  readonly attachments?: readonly string[];
}

/** Effects in pipeline order: linear before display, then by `order`, then by registration. */
export function sortEffects<T extends Pick<EffectOrderInfo, 'stage' | 'order'>>(effects: readonly T[]): T[] {
  return effects
    .map((effect, index) => ({ effect, index }))
    .sort((a, b) => stageRank(a.effect.stage) - stageRank(b.effect.stage) || a.effect.order - b.effect.order || a.index - b.index)
    .map((x) => x.effect);
}

function stageRank(stage: PostStage): number {
  return stage === 'linear' ? 0 : 1;
}

/**
 * Scene attachments the active effects read, each once, in first-use order (the scene pass
 * writes only these besides color and depth).
 */
export function collectAttachments(effects: readonly EffectOrderInfo[]): string[] {
  const out: string[] = [];
  for (const e of effects) for (const name of e.attachments ?? []) if (name !== 'output' && !out.includes(name)) out.push(name);
  return out;
}

/** Key of the node graph for a list of active effects (already sorted): rebuilt when it changes. */
export function graphKey(effects: readonly EffectOrderInfo[], extra = ''): string {
  return effects.map((e) => `${e.name}@${e.graphVersion}[${(e.attachments ?? []).join(',')}]`).join('|') + `#${extra}`;
}

// ---------------------------------------------------------------------------
// Per-object effects

/**
 * Effects of one object or entity (`entity.effects`, `viewer.effects.set`).
 */
export interface ObjectEffects {
  /** Name of an outline style (`'select'`, `'hover'`, `'alarm'` or one from `viewer.effects.defineOutline`); null for none. */
  outline?: string | null;
  /** Glow (selective bloom) intensity, 0..1; 0 or null for none. */
  glow?: number | null;
  /** Glow color (CSS color); null or absent: the outline style's color, or white without an outline. */
  glowColor?: string | null;
}

/** Effects after combining an entity's own effects with its selection / hover highlight. */
export interface ResolvedEffects {
  outline: string | null;
  glow: number;
  glowColor: string | null;
}

/**
 * Effects to draw for an object: a highlight (selection, hover; an outline style name) takes
 * the place of the object's own outline while it lasts; glow is clamped to 0..1. Null when
 * nothing is drawn.
 */
export function resolveEffects(own: Readonly<ObjectEffects> | null, highlight: string | null = null): ResolvedEffects | null {
  const outline = highlight ?? own?.outline ?? null;
  const g = own?.glow;
  const glow = typeof g === 'number' && Number.isFinite(g) ? Math.min(1, Math.max(0, g)) : 0;
  if (outline === null && glow === 0) return null;
  return { outline, glow, glowColor: own?.glowColor ?? null };
}

/** Merges a partial update into an object's effects (`undefined` keeps a field, null clears it). */
export function mergeEffects(current: Readonly<ObjectEffects>, update: Readonly<ObjectEffects>): ObjectEffects {
  const out: ObjectEffects = { ...current };
  for (const key of ['outline', 'glow', 'glowColor'] as const) {
    if (!(key in update) || update[key] === undefined) continue;
    if (update[key] === null) delete out[key];
    else (out as Record<string, unknown>)[key] = update[key];
  }
  return out;
}

// ---------------------------------------------------------------------------
// Outline styles

/** Look of an outline style (`viewer.effects.defineOutline`). */
export interface OutlineStyle {
  /** Color of the visible edge (CSS color). */
  color: string;
  /**
   * Edge color where the object is hidden behind other content (x-ray, CSS color); null or
   * absent: no outline around hidden parts, the edge follows what is visible.
   */
  hiddenColor?: string | null;
  /** Tint of the object's visible surface with `color`, 0..1 (default 0: edge only). */
  fill?: number;
  /** Pulse period in seconds (the outline fades between 30 % and full strength); 0 or absent: steady. */
  pulse?: number;
}

/** Built-in styles: selection, hover (`indoor.selectOutline` / `hoverOutline`) and an alarm preset. */
export const BUILTIN_OUTLINES: Readonly<Record<string, Readonly<OutlineStyle>>> = {
  select: { color: '#3b82f6', hiddenColor: '#1e40af', fill: 0.18 },
  hover: { color: '#93c5fd', fill: 0.08 },
  alarm: { color: '#ef4444', hiddenColor: '#991b1b', fill: 0.22, pulse: 1.2 },
};

/** A style with its numbers within range (fill 0..1, pulse ≥ 0, finite). */
export function normalizeOutlineStyle(style: Readonly<OutlineStyle>): Required<OutlineStyle> {
  const fill = Number.isFinite(style.fill) ? Math.min(1, Math.max(0, style.fill!)) : 0;
  const pulse = Number.isFinite(style.pulse) && style.pulse! > 0 ? style.pulse! : 0;
  return { color: style.color, hiddenColor: style.hiddenColor ?? null, fill, pulse };
}

/** Lowest strength of a pulsing outline (fraction of full). */
export const PULSE_MIN = 0.3;

/**
 * Strength (PULSE_MIN..1) of a pulsing effect at `timeSeconds`: a cosine from full strength
 * down to PULSE_MIN and back over `period` seconds; 1 when the period is 0 (steady).
 */
export function pulseFactor(timeSeconds: number, period: number): number {
  if (!(period > 0)) return 1;
  const phase = (timeSeconds / period) * Math.PI * 2;
  return PULSE_MIN + (1 - PULSE_MIN) * (0.5 + 0.5 * Math.cos(phase));
}

/** Default outline width, CSS pixels. */
export const DEFAULT_OUTLINE_WIDTH = 2;
/** Accepted outline widths, CSS pixels. */
export const MIN_OUTLINE_WIDTH = 1;
export const MAX_OUTLINE_WIDTH = 6;

/**
 * Downscale of the outline mask relative to the drawing buffer: 1 up to a pixel ratio of 1.5,
 * else 2 (on high-density screens half resolution looks the same and keeps the edge search short).
 */
export function outlineMaskScale(pixelRatio: number): number {
  return pixelRatio > 1.5 ? 2 : 1;
}

/** Edge radius in mask pixels for a width in CSS pixels. */
export function outlineRadius(widthCss: number, pixelRatio: number): number {
  const w = Math.min(MAX_OUTLINE_WIDTH, Math.max(MIN_OUTLINE_WIDTH, Number.isFinite(widthCss) ? widthCss : DEFAULT_OUTLINE_WIDTH));
  return (w * Math.max(pixelRatio, 0.5)) / outlineMaskScale(pixelRatio);
}

/** One sample of the edge search: offset in mask pixels and its distance. */
export interface EdgeSample {
  dx: number;
  dy: number;
  distance: number;
}

/**
 * Mask offsets the edge pass looks at for an edge `radius` mask pixels wide: every integer
 * offset (except the center) whose distance is at most `radius + 0.5`, farthest first, so that
 * when each covered sample overwrites the previous one the nearest covered sample wins.
 */
export function edgeSamples(radius: number): EdgeSample[] {
  const reach = Math.max(1, radius) + 0.5;
  const r = Math.ceil(reach);
  const out: EdgeSample[] = [];
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      if (dx === 0 && dy === 0) continue;
      const distance = Math.hypot(dx, dy);
      if (distance <= reach) out.push({ dx, dy, distance });
    }
  }
  return out.sort((a, b) => b.distance - a.distance || a.dy - b.dy || a.dx - b.dx);
}

/**
 * Edge opacity at `distance` mask pixels from the nearest covered pixel for an edge `radius`
 * wide: full inside, fading over the last half pixel (anti-aliasing).
 */
export function edgeAlpha(distance: number, radius: number): number {
  return Math.min(1, Math.max(0, Math.max(1, radius) + 0.5 - distance));
}

// ---------------------------------------------------------------------------
// Still supersampling (roadmap M3.3)

/** Supersampling samples by default with 4x MSAA: each sample already covers four positions per pixel. */
export const DEFAULT_SUPERSAMPLING_SAMPLES_MSAA = 16;
/** Supersampling samples by default without MSAA (`low` GPU tier, `antialias: false`). */
export const DEFAULT_SUPERSAMPLING_SAMPLES = 32;
/** Accepted sample counts. */
export const MIN_SUPERSAMPLING_SAMPLES = 4;
export const MAX_SUPERSAMPLING_SAMPLES = 64;

/** Element `index` (≥ 1) of the Halton sequence in `base`: the radical inverse, in [0, 1). */
export function halton(index: number, base: number): number {
  let result = 0;
  let fraction = 1;
  let i = Math.floor(index);
  while (i > 0) {
    fraction /= base;
    result += fraction * (i % base);
    i = Math.floor(i / base);
  }
  return result;
}

/**
 * Sub-pixel camera offset of supersampling sample `sample` (0-based), in pixels, each component
 * in [-0.5, 0.5): sample 0 is not offset, so the first sample is the live frame already on the
 * canvas and refining starts without a visible step; the others follow Halton(2, 3), which covers
 * the pixel evenly for any number of samples.
 */
export function jitterOffset(sample: number): [number, number] {
  if (!(sample >= 1)) return [0, 0];
  return [halton(sample, 2) - 0.5, halton(sample, 3) - 0.5];
}

/**
 * Weight of sample `sample` (0-based) when it is blended over the running average:
 * `average = average × (1 − w) + sample × w` with `w = 1 / (sample + 1)` keeps the plain mean of
 * all samples so far (the first one replaces whatever was there).
 */
export function sampleWeight(sample: number): number {
  return 1 / (Math.max(0, Math.floor(sample)) + 1);
}

/**
 * Samples to take for a requested count: rounded and kept within MIN–MAX; anything that is not a
 * finite number gives the default for the canvas (fewer with MSAA).
 */
export function normalizeSampleCount(value: unknown, msaa: boolean): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return msaa ? DEFAULT_SUPERSAMPLING_SAMPLES_MSAA : DEFAULT_SUPERSAMPLING_SAMPLES;
  return Math.min(MAX_SUPERSAMPLING_SAMPLES, Math.max(MIN_SUPERSAMPLING_SAMPLES, Math.round(value)));
}

// ---------------------------------------------------------------------------
// Color grading (roadmap M3.3)

/** Look of the picture (`viewer.colorGrading`, `GeoViewerOptions.colorGrading`). */
export interface ColorGradingOptions {
  /** Light multiplier before tone mapping (the renderer's `toneMappingExposure`), 0.1–4, default 1. */
  exposure?: number;
  /** Contrast of the displayed picture around mid gray, 0–2, default 1 (no change). */
  contrast?: number;
  /** Color saturation, 0 (gray) – 2, default 1 (no change). */
  saturation?: number;
}

/** Ranges of the grading settings. */
export const COLOR_GRADING_LIMITS: Readonly<Record<keyof ColorGradingOptions, readonly [number, number]>> = {
  exposure: [0.1, 4],
  contrast: [0, 2],
  saturation: [0, 2],
};

/**
 * Grading presets: `neutral` changes nothing (the default), `vivid` adds a little contrast and
 * saturation (imagery and models look less washed out on large screens).
 */
export const COLOR_GRADING_PRESETS: Readonly<Record<'neutral' | 'vivid', Readonly<Required<ColorGradingOptions>>>> = {
  neutral: { exposure: 1, contrast: 1, saturation: 1 },
  vivid: { exposure: 1, contrast: 1.05, saturation: 1.1 },
};

/**
 * One grading setting within its range; anything that is not a finite number gives `fallback`
 * (the current value when updating, the neutral value otherwise).
 */
export function normalizeGrading(key: keyof ColorGradingOptions, value: unknown, fallback: number = COLOR_GRADING_PRESETS.neutral[key]): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  const [min, max] = COLOR_GRADING_LIMITS[key];
  return Math.min(max, Math.max(min, value));
}

/** Whether contrast or saturation need the grading pass (exposure is part of tone mapping and costs nothing). */
export function gradingPassNeeded(g: Readonly<Required<ColorGradingOptions>>): boolean {
  return g.contrast !== 1 || g.saturation !== 1;
}
