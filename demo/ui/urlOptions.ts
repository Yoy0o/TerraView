/**
 * Demo-app URL parameters for the opening spin and the cloud layer, parsed
 * into the core option types. Pure functions (no DOM), unit tested; invalid
 * values are ignored so a typo never breaks startup.
 *
 *   ?intro=0|1            off / on (overrides the saved panel setting)
 *   ?introDuration=<s>    seconds until the globe is at rest
 *   ?introSpeed=<deg/s>   starting spin speed (negative reverses)
 *   ?introZoom=<factor>   start this many times higher (1 = no zoom)
 *   ?clouds=0|1           hide / show the cloud layer
 *   ?cloudCoverage=0..1   ?cloudOpacity=0..1   ?cloudSpeed=<deg/s>
 *   ?cloudHeight=<m>      ?cloudTexture=<url of an equirectangular cloud map>
 *   ?cloudVolumetric=0|1  volumetric clouds near the ground off / on (default: the GPU tier's)
 *   ?cloudBase=<m>        ?cloudThickness=<m>   ?cloudWind=<m/s>   ?cloudWindHeading=<deg>
 *   ?cloudDensity=0.1..4  ?cloudShadows=0|1
 *   ?cull=0|1             contribution culling of small devices / components off / on
 *   ?cullThreshold=0..1   share of the viewport below which they are culled (0.005 = 0.5 %)
 *   ?cullHysteresis=0..1  ?cullInterval=<frames>   ?cullSelector=<entity selector, e.g. .thing>
 *
 * Read in main.ts: ?gpu=low|medium|high|ultra sets the GPU tier (memory budgets and default quality,
 * docs/agents/gpu-memory.md) instead of the one guessed from the adapter; ?idleFps=<0, 10–60> sets
 * the frame rate once the view is quiet (0 = every frame; docs/api.md §1.8); ?ss=0|1 turns still
 * supersampling off / on and ?ssSamples=<4–64> sets its samples; ?grade=neutral|vivid picks the
 * color grading preset (docs/api.md §1.8, §1.9); ?ao=0|1 turns the floor ambient occlusion off / on
 * and ?aoIntensity=0..1 sets its strength (docs/agents/indoor-bim.md §5.6); ?shadows=0|1 turns the
 * sun shadows off / on and ?oit=0|1 order-independent transparency (docs/api.md §1.11; defaults
 * from the GPU tier).
 */
import { type CloudOptions, compileSelector, type ContributionCullingOptions, type IntroSpinOptions, type VolumetricCloudOptions } from 'terra-view';

/** '1' / 'true' / 'on' / '' (bare flag) → true, '0' / 'false' / 'off' → false, absent or other → undefined. */
export function parseFlag(params: URLSearchParams, name: string): boolean | undefined {
  const v = params.get(name);
  if (v === null) return undefined;
  const s = v.trim().toLowerCase();
  if (s === '' || s === '1' || s === 'true' || s === 'on' || s === 'yes') return true;
  if (s === '0' || s === 'false' || s === 'off' || s === 'no') return false;
  return undefined;
}

/** Finite number within [min, max], else undefined. */
export function parseNumber(params: URLSearchParams, name: string, min = -Infinity, max = Infinity): number | undefined {
  const v = params.get(name);
  if (v === null || v.trim() === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n >= min && n <= max ? n : undefined;
}

export interface IntroParams {
  /** Explicit on / off from `?intro`, undefined when absent. */
  enabled: boolean | undefined;
  options: IntroSpinOptions;
}

export function parseIntroParams(params: URLSearchParams): IntroParams {
  const options: IntroSpinOptions = {};
  const duration = parseNumber(params, 'introDuration', 0.5, 120);
  if (duration !== undefined) options.duration = duration;
  const speed = parseNumber(params, 'introSpeed', -720, 720);
  if (speed !== undefined) options.speed = speed;
  const zoom = parseNumber(params, 'introZoom', 1, 10);
  if (zoom !== undefined) options.zoomFrom = zoom;
  return { enabled: parseFlag(params, 'intro'), options };
}

export interface CloudParams {
  /** Explicit show / hide from `?clouds`, undefined when absent. */
  visible: boolean | undefined;
  options: CloudOptions;
}

export function parseCloudParams(params: URLSearchParams): CloudParams {
  const options: CloudOptions = {};
  const coverage = parseNumber(params, 'cloudCoverage', 0, 1);
  if (coverage !== undefined) options.coverage = coverage;
  const opacity = parseNumber(params, 'cloudOpacity', 0, 1);
  if (opacity !== undefined) options.opacity = opacity;
  const speed = parseNumber(params, 'cloudSpeed', -90, 90);
  if (speed !== undefined) options.speed = speed;
  const height = parseNumber(params, 'cloudHeight', 0, 100_000);
  if (height !== undefined) options.height = height;
  const tex = params.get('cloudTexture')?.trim();
  if (tex && /^(https?:|\/|\.{0,2}\/|data:image\/)/i.test(tex)) options.textureUrl = tex;
  // Volumetric clouds near the ground: only the parameters that are present.
  const volumetric: VolumetricCloudOptions = {};
  const set = <K extends keyof VolumetricCloudOptions>(key: K, value: VolumetricCloudOptions[K] | undefined) => {
    if (value !== undefined) volumetric[key] = value;
  };
  set('enabled', parseFlag(params, 'cloudVolumetric'));
  set('bottom', parseNumber(params, 'cloudBase', 0, 15_000));
  set('thickness', parseNumber(params, 'cloudThickness', 200, 10_000));
  set('windSpeed', parseNumber(params, 'cloudWind', 0, 60));
  set('windHeading', parseNumber(params, 'cloudWindHeading', -360, 360));
  set('density', parseNumber(params, 'cloudDensity', 0.1, 4));
  set('shadows', parseFlag(params, 'cloudShadows'));
  if (Object.keys(volumetric).length > 0) options.volumetric = volumetric;
  return { visible: parseFlag(params, 'clouds'), options };
}

export interface CullingParams {
  /** Explicit on / off from `?cull`, undefined when absent. */
  enabled: boolean | undefined;
  options: ContributionCullingOptions;
}

/** Contribution culling parameters; tuning values without `?cull=1` only preset the options. */
export function parseCullingParams(params: URLSearchParams): CullingParams {
  const options: ContributionCullingOptions = {};
  const threshold = parseNumber(params, 'cullThreshold', 0, 1);
  if (threshold !== undefined) options.threshold = threshold;
  const hysteresis = parseNumber(params, 'cullHysteresis', 0, 1);
  if (hysteresis !== undefined) options.hysteresis = hysteresis;
  const interval = parseNumber(params, 'cullInterval', 1, 600);
  if (interval !== undefined) options.interval = Math.round(interval);
  const selector = params.get('cullSelector')?.trim();
  if (selector) {
    try {
      compileSelector(selector);
      options.selector = selector;
    } catch {
      // A malformed selector is ignored like any other invalid value.
    }
  }
  return { enabled: parseFlag(params, 'cull'), options };
}

/**
 * Startup URL parameters whose own camera flight would cut the opening spin
 * short (a building, 3D Tiles, vector or point data framed on load, a local scene).
 */
export function hasStartupFlight(params: URLSearchParams): boolean {
  return ['demo', 'building', 'tileset', 'geojson', 'points', 'region'].some((k) => params.has(k));
}
