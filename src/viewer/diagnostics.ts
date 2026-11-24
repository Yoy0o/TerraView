/**
 * Diagnostics of a viewer: its estimated memory use (`viewer.memory`), the JSON snapshot for bug
 * reports (`viewer.snapshot()`, roadmap M5.1), and what the browser tells about the graphics
 * hardware (GPU tier guess, adapter name). Reads only what the viewer makes public.
 */
import type { DirectionalLight, HemisphereLight, LightProbe } from 'three';
import type { WebGPURenderer } from 'three/webgpu';
import type { CloudLayer } from '../clouds/CloudLayer';
import { estimateFramebufferBytes, type GpuHints } from '../core/gpuProfile';
import type { Globe } from '../globe/Globe';
import type { IndoorManager } from '../indoor/IndoorManager';
import type { SunShadows } from '../lighting/SunShadows';
import type { MarkerManager } from '../markers/MarkerManager';
import type { PointLayer } from '../markers/PointLayer';
import type { LevelTransition } from '../post/LevelTransition';
import type { PostPipeline } from '../post/PostPipeline';
import type { Supersampling } from '../post/Supersampling';
import type { Transparency } from '../post/Transparency';
import type { Tiles3DLayer } from '../tiles3d/Tiles3DLayer';
import type { GeoJsonLayer } from '../vector/GeoJsonLayer';
import type { LoadState } from './loadState';
import type { PickBuffer } from './PickBuffer';
import type { FrameStats, MemoryReport, RendererInfo, ViewerSnapshot, ViewPosition } from './viewerTypes';

/** The viewer members memory estimates add up. */
export interface MemorySource {
  readonly renderer: WebGPURenderer;
  readonly info: RendererInfo;
  readonly pickBuffer: PickBuffer<Tiles3DLayer> | null;
  readonly postProcessing: PostPipeline;
  readonly globe: Globe;
  readonly tilesets: readonly Tiles3DLayer[];
  readonly indoor: IndoorManager;
  readonly shadows: SunShadows;
}

/** The viewer members a snapshot reads. */
export interface SnapshotSource extends MemorySource {
  readonly memory: MemoryReport;
  readonly stats: FrameStats;
  readonly loadState: Readonly<LoadState>;
  readonly date: Date;
  readonly timeMultiplier: number;
  readonly lighting: boolean;
  readonly atmosphere: boolean;
  readonly showGlobe: boolean;
  readonly showStars: boolean;
  readonly clouds: CloudLayer;
  readonly vectorLayers: readonly GeoJsonLayer[];
  readonly pointLayers: readonly PointLayer[];
  readonly markers: MarkerManager;
  readonly supersampling: Supersampling;
  readonly levelTransition: LevelTransition;
  readonly transparency: Transparency;
  readonly sunLight: DirectionalLight;
  readonly skyLight: HemisphereLight;
  readonly skyProbe: LightProbe;
  getView(): Required<ViewPosition>;
}

/** Estimated memory use of the viewer's own allocations, in bytes (see `MemoryReport`). */
export function memoryReport(v: MemorySource): MemoryReport {
  const canvas = v.renderer.domElement;
  const framebuffers = estimateFramebufferBytes({ width: canvas.width, height: canvas.height, samples: v.info.samples }) +
    (v.pickBuffer?.gpuBytes ?? 0) +
    v.postProcessing.gpuBytes;
  const globe = v.globe.gpuBytes;
  let tilesGpu = 0;
  let tilesCache = 0;
  let tilesCacheMax = 0;
  for (const layer of v.tilesets) {
    const m = layer.memory;
    tilesGpu += m.gpuBytes;
    // One cache for all tilesets.
    tilesCache = m.cachedBytes;
    tilesCacheMax = m.cacheMaxBytes;
  }
  const buildings = v.indoor.modelBytes + v.indoor.ambientOcclusion.bytes;
  const shadows = v.shadows.bytes;
  return { framebuffers, globe, tilesGpu, buildings, shadows, gpuTotal: framebuffers + globe + tilesGpu + buildings + shadows, tilesCache, tilesCacheMax };
}

/** Diagnostics of the viewer as of the last frame (`viewer.snapshot()`). */
export function viewerSnapshot(v: SnapshotSource): ViewerSnapshot {
  const indoor = v.indoor;
  const c = v.sunLight.color;
  return {
    time: new Date().toISOString(),
    date: v.date.toISOString(),
    info: { ...v.info },
    stats: { ...v.stats },
    memory: v.memory,
    load: { ...v.loadState },
    view: v.getView(),
    scene: {
      lighting: v.lighting,
      atmosphere: v.atmosphere,
      showGlobe: v.showGlobe,
      showStars: v.showStars,
      clouds: v.clouds.mesh.visible,
      timeMultiplier: v.timeMultiplier,
    },
    globe: { ...v.globe.stats, shown: v.showGlobe },
    tilesets: v.tilesets.map((l) => ({ id: l.id, name: l.name, visible: l.visible, active: l.active, pending: l.pending, errorScale: l.errorScale, memory: { ...l.memory } })),
    layers: { vector: v.vectorLayers.length, points: v.pointLayers.length, markers: { ...v.markers.stats } },
    indoor: {
      buildings: indoor.buildings.length,
      current: indoor.current ? { id: indoor.current.id, type: indoor.current.type } : null,
      selected: indoor.selected?.id ?? null,
      modelBytes: indoor.modelBytes,
      ambientOcclusion: { enabled: indoor.ambientOcclusion.enabled, floors: indoor.ambientOcclusion.bakedFloors, bytes: indoor.ambientOcclusion.bytes },
      culling: { enabled: indoor.culling.enabled, ...indoor.culling.stats },
    },
    post: {
      effects: v.postProcessing.effects.map((e) => ({ name: e.name, stage: e.stage, active: e.active })),
      samples: v.postProcessing.samples,
      supersampling: v.supersampling.enabled,
      transitionMs: v.levelTransition.duration,
      transparency: { orderIndependent: v.transparency.orderIndependent, supported: v.transparency.supported, active: v.transparency.active },
    },
    lights: { sunColor: [c.r, c.g, c.b], sunIntensity: v.sunLight.intensity, hemisphere: v.skyLight.intensity, skyProbe: v.skyProbe.intensity },
    shadows: { enabled: v.shadows.enabled, active: v.shadows.active, mapSize: v.shadows.mapSize, texelSize: v.shadows.texelSize, maxDistance: v.shadows.maxDistance },
  };
}

/**
 * What the browser tells about the graphics hardware, read from a WebGPU
 * adapter requested the same way the renderer will request its own. Without
 * WebGPU only the CPU-side hints are filled in.
 */
export async function detectGpuHints(): Promise<GpuHints> {
  const nav = navigator as Navigator & { deviceMemory?: number };
  const hints: GpuHints = {
    webgpu: false,
    vendor: '',
    architecture: '',
    fallbackAdapter: false,
    maxTextureSize: 0,
    deviceMemoryGB: typeof nav.deviceMemory === 'number' ? nav.deviceMemory : null,
    cores: typeof nav.hardwareConcurrency === 'number' ? nav.hardwareConcurrency : null,
    mobile: /Android|iPhone|iPad|iPod|Mobile/i.test(nav.userAgent ?? ''),
  };
  try {
    const adapter = await nav.gpu?.requestAdapter({ powerPreference: 'high-performance' });
    if (adapter) {
      const info: Partial<GPUAdapterInfo> & { isFallbackAdapter?: boolean } = adapter.info ?? {};
      hints.webgpu = true;
      hints.vendor = String(info.vendor ?? '').toLowerCase();
      hints.architecture = String(info.architecture ?? '').toLowerCase();
      hints.fallbackAdapter = (info.isFallbackAdapter ?? (adapter as { isFallbackAdapter?: boolean }).isFallbackAdapter) === true;
      hints.maxTextureSize = Number(adapter.limits?.maxTextureDimension2D ?? 0);
    }
  } catch {
    /* no adapter: the renderer falls back to WebGL 2 */
  }
  return hints;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function describeAdapter(backend: any): string {
  try {
    const info = backend.device?.adapterInfo ?? backend.adapter?.info;
    if (info) return [info.vendor, info.architecture, info.description].filter(Boolean).join(' ').trim() || 'WebGPU adapter';
    const gl = backend.gl as WebGL2RenderingContext | undefined;
    if (gl) {
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      return ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : String(gl.getParameter(gl.RENDERER));
    }
  } catch {
    /* ignore */
  }
  return 'unknown';
}
