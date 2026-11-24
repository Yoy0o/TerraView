/** UI preferences and user-supplied credentials, kept in this browser only. */
export type TerrainChoice = 'none' | 'aws' | 'mapbox' | 'maptiler' | 'cesium' | 'qm-url';

export interface OverlaySetting {
  id: string;
  opacity: number;
  visible: boolean;
}

export interface Settings {
  imagery: string;
  customImageryUrl: string;
  /** @deprecated kept for migrating older saved settings; use `terrainSource`. */
  terrain: boolean;
  terrainSource: TerrainChoice;
  mapboxToken: string;
  maptilerKey: string;
  quantizedMeshUrl: string;
  overlays: OverlaySetting[];
  exaggeration: number;
  atmosphere: boolean;
  lighting: boolean;
  stars: boolean;
  /** Cloud layer shown. */
  clouds: boolean;
  /** Cloud coverage, 0–1. */
  cloudCoverage: number;
  /** Cloud drift, degrees of longitude per second. */
  cloudSpeed: number;
  /** Volumetric clouds near the ground; null = the GPU tier's default. */
  cloudVolumetric: boolean | null;
  /** Base of the volumetric clouds, meters. */
  cloudBase: number;
  /** Wind of the volumetric clouds, meters per second. */
  cloudWind: number;
  /** Play the opening spin on startup. */
  intro: boolean;
  /** Refine still views (viewer.supersampling). */
  supersampling: boolean;
  /** Color grading preset (COLOR_GRADING_PRESETS). */
  grading: 'neutral' | 'vivid';
  quality: number;
  tiandituKey: string;
  ionToken: string;
  googleKey: string;
}

const KEY = 'terraview:settings';
/** Key used before the move from three-geo-global: read once so saved settings and keys carry over. */
const LEGACY_KEY = 'three-geo-global:settings';

export const DEFAULT_SETTINGS: Settings = {
  imagery: 'esri-imagery',
  customImageryUrl: '',
  terrain: true,
  terrainSource: 'aws',
  mapboxToken: '',
  maptilerKey: '',
  quantizedMeshUrl: '',
  overlays: [],
  exaggeration: 1,
  atmosphere: true,
  lighting: false,
  stars: true,
  clouds: true,
  cloudCoverage: 0.5,
  cloudSpeed: 0.5,
  cloudVolumetric: null,
  cloudBase: 1500,
  cloudWind: 6,
  intro: true,
  supersampling: true,
  grading: 'neutral',
  quality: 1.25,
  tiandituKey: '',
  ionToken: '',
  googleKey: '',
};

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY) ?? localStorage.getItem(LEGACY_KEY);
    if (raw) {
      const saved = JSON.parse(raw) as Partial<Settings>;
      const merged = { ...DEFAULT_SETTINGS, ...saved };
      if (saved.terrainSource === undefined && saved.terrain === false) merged.terrainSource = 'none';
      if (!Array.isArray(merged.overlays)) merged.overlays = [];
      return merged;
    }
  } catch {
    /* storage unavailable */
  }
  return { ...DEFAULT_SETTINGS };
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* storage unavailable */
  }
}
