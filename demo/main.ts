import 'terra-view/style.css';
import './style.css';
import { AWS_TERRARIUM, COLOR_GRADING_PRESETS, GeoViewer, parseGpuTier, type ViewPosition } from 'terra-view';
import { ControlPanel, createImagery } from './ui/ControlPanel';
import { h } from './ui/dom';
import { FeaturePopup } from './ui/FeaturePopup';
import { LevelBar } from './ui/IndoorPanel';
import { NavigationBar } from './ui/NavigationBar';
import { loadSettings } from './ui/settings';
import { StatusBar } from './ui/StatusBar';
import { hasStartupFlight, parseCloudParams, parseCullingParams, parseFlag, parseIntroParams, parseNumber } from './ui/urlOptions';

const DEFAULT_VIEW: ViewPosition = { longitude: 112, latitude: 26, height: 1.75e7, heading: 0, pitch: -90 };

/** Camera state in the URL hash: #lon,lat,height,heading,pitch */
function parseHashView(): ViewPosition | null {
  const parts = location.hash.slice(1).split(',').map(Number);
  if (parts.length < 3 || parts.slice(0, 3).some((n) => !Number.isFinite(n))) return null;
  const [longitude, latitude, height, heading = 0, pitch = -90] = parts;
  return { longitude, latitude, height, heading, pitch };
}

function syncHash(viewer: GeoViewer): void {
  let last = '';
  window.setInterval(() => {
    if (viewer.controller.isFlying || viewer.controller.isAnimating) return;
    const v = viewer.getView();
    if (![v.longitude, v.latitude, v.height].every(Number.isFinite)) return;
    const hash = `#${v.longitude.toFixed(5)},${v.latitude.toFixed(5)},${v.height.toFixed(0)},${v.heading.toFixed(1)},${v.pitch.toFixed(1)}`;
    if (hash !== last) {
      last = hash;
      history.replaceState(null, '', hash);
    }
  }, 600);
}

function showFatal(message: string): void {
  document.getElementById('app')!.append(
    h('div', { class: 'fatal' }, h('h2', {}, '无法启动三维地球'), h('p', {}, message), h('p', { class: 'hint' }, '需要支持 WebGPU 或 WebGL 2 的浏览器（Chrome / Edge 113+、Safari 26+、Firefox 141+）。')),
  );
}

async function main(): Promise<void> {
  const app = document.getElementById('app')!;
  const container = document.getElementById('viewer')!;
  const params = new URLSearchParams(location.search);
  const settings = loadSettings();
  const imageryParam = params.get('imagery');
  if (imageryParam) settings.imagery = imageryParam;
  if (params.has('noterrain')) settings.terrainSource = 'none';
  // ?ss=0|1 still supersampling off / on, ?grade=neutral|vivid color grading (override the panel settings).
  settings.supersampling = parseFlag(params, 'ss') ?? settings.supersampling;
  const grade = params.get('grade');
  if (grade === 'neutral' || grade === 'vivid') settings.grading = grade;

  // ?clouds / ?cloudCoverage / … and ?intro / ?introDuration / … (demo/ui/urlOptions.ts) override the saved settings for this visit.
  const cloudParams = parseCloudParams(params);
  const introParams = parseIntroParams(params);
  // ?cull / ?cullThreshold / … : contribution culling of small devices (off unless ?cull=1).
  const cullParams = parseCullingParams(params);

  const splash = h('div', { class: 'splash' }, h('div', { class: 'splash-globe' }), h('span', {}, '正在初始化 GPU…'));
  app.append(splash);

  let viewer: GeoViewer;
  try {
    viewer = await GeoViewer.create({
      homeView: DEFAULT_VIEW,
      clouds: {
        visible: cloudParams.visible ?? settings.clouds,
        coverage: settings.cloudCoverage,
        speed: settings.cloudSpeed,
        ...cloudParams.options,
      },
      contributionCulling: { ...cullParams.options, enabled: cullParams.enabled ?? false },
      // ?ao=0|1 floor ambient occlusion off / on (default on), ?aoIntensity=0..1 its strength.
      ambientOcclusion: { enabled: parseFlag(params, 'ao') ?? true, intensity: parseNumber(params, 'aoIntensity', 0, 1) },
      // ?shadows=0|1 sun shadows, ?oit=0|1 order-independent transparency (default: from the GPU tier).
      shadows: parseFlag(params, 'shadows'),
      transparency: { orderIndependent: parseFlag(params, 'oit') },
      container,
      imagery: createImagery(settings),
      // Sources that need network setup (Cesium ion, layer.json) are applied once the panel exists.
      terrain: settings.terrainSource === 'aws' ? AWS_TERRARIUM : null,
      terrainExaggeration: settings.exaggeration,
      maxScreenSpaceError: settings.quality,
      forceWebGL: params.has('webgl'),
      // ?gpu=low|medium|high|ultra overrides the tier guessed from the adapter.
      gpuTier: parseGpuTier(params.get('gpu')),
      // ?idleFps=0 draws every frame; 10–60 is the frame rate once the view is quiet (default 10).
      idleFrameRate: parseNumber(params, 'idleFps', 0, 240),
      // ?ssSamples=4–64: samples of a still view (default 16 with MSAA, 32 without).
      supersampling: { enabled: settings.supersampling, samples: parseNumber(params, 'ssSamples', 1, 1000) },
      colorGrading: COLOR_GRADING_PRESETS[settings.grading],
      initialView: parseHashView() ?? DEFAULT_VIEW,
    });
  } catch (err) {
    splash.remove();
    console.error(err);
    showFatal(err instanceof Error ? err.message : String(err));
    return;
  }
  splash.remove();

  viewer.atmosphere = settings.atmosphere;
  viewer.lighting = settings.lighting;
  viewer.showStars = settings.stars;

  const panel = new ControlPanel(viewer, settings);
  if (settings.terrainSource !== 'aws' && settings.terrainSource !== 'none') void panel.applyTerrain();
  const status = new StatusBar(viewer);
  const title = h(
    'div',
    { class: 'brand' },
    h('strong', {}, 'TerraView'),
    h('span', {}, '左键拖拽平移 · 滚轮缩放 · 右键拖拽调航向/俯仰 · 双击进入建筑 · 右键/Esc 返回'),
  );
  const popup = new FeaturePopup(viewer);
  const levels = new LevelBar(viewer);
  viewer.navigation.introOptions = introParams.options;
  const navBar = new NavigationBar(viewer, (text, kind) => panel.notify(text, kind));
  app.append(title, panel.root, status.root, status.compass, navBar.root, popup.root, levels.root, levels.floors);
  syncHash(viewer);
  // Camera keys (W A S D, arrows, Q E R F) go to the focused viewer only: take the focus at startup.
  viewer.canvas.focus({ preventScroll: true });

  // Opening spin, ending on the start view. Skipped when startup data would fly elsewhere
  // (unless ?intro=1) and, inside playIntro, for close-up views.
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (introParams.enabled ?? (settings.intro && !reducedMotion && !hasStartupFlight(params))) void viewer.playIntro(introParams.options);
  enableFileDrop(app, (files) => {
    const buildings = files.filter((f) => /\.building\.json$/i.test(f.name));
    for (const f of buildings) void panel.indoorPanel.loadFile(f);
    // *.points.json (or .points.geojson) become point marker layers, other GeoJSON draped vectors.
    const points = files.filter((f) => /\.points\.(geo)?json$/i.test(f.name));
    if (points.length) void panel.pointPanel.loadFiles(points);
    const rest = files.filter((f) => !buildings.includes(f) && !points.includes(f));
    if (rest.length) void panel.vectorPanel.loadFiles(rest);
  });
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || isTyping(e)) return;
    // Esc first closes the property popup, then steps up one indoor level.
    if (popup.isOpen) popup.close();
    else if (viewer.indoor.current) void viewer.indoor.back();
  });

  // ?geojson=<url> loads a GeoJSON layer on startup (repeatable).
  for (const url of params.getAll('geojson')) panel.vectorPanel.load({ url }, !location.hash);
  // ?points=<url> loads a point marker layer (GeoJSON points or records with lon / lat; repeatable).
  for (const url of params.getAll('points')) panel.pointPanel.load({ url }, !location.hash);

  // ?demo loads the procedural office building; ?building=<url> a building document.
  if (params.has('demo')) panel.indoorPanel.loadDemo();
  for (const url of params.getAll('building')) void panel.indoorPanel.loadUrl(url);

  // ?tileset=<url> loads a 3D Tiles dataset on startup.
  const tileset = params.get('tileset');
  if (tileset) {
    const layer = viewer.addTileset({ source: { type: 'url', url: tileset } });
    layer.events.on('ready', ({ sphere }) => {
      if (sphere.radius < 2e6 && !location.hash) void viewer.flyToSphere(sphere);
    });
  }

  // Handy for debugging from the console.
  (window as unknown as { viewer: GeoViewer }).viewer = viewer;
}

function isTyping(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
}

/** Drag GeoJSON (or *.building.json) files anywhere onto the page to load them. */
function enableFileDrop(app: HTMLElement, onFiles: (files: File[]) => void): void {
  const overlay = h('div', { class: 'drop-overlay', hidden: true }, h('div', {}, '释放以加载 GeoJSON / points.json / building.json 文件'));
  app.append(overlay);
  let depth = 0;
  const hasFiles = (e: DragEvent) => !!e.dataTransfer && [...e.dataTransfer.types].includes('Files');
  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    depth++;
    overlay.hidden = false;
  });
  window.addEventListener('dragleave', (e) => {
    if (!hasFiles(e)) return;
    depth = Math.max(0, depth - 1);
    if (depth === 0) overlay.hidden = true;
  });
  window.addEventListener('dragover', (e) => {
    if (hasFiles(e)) e.preventDefault();
  });
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    overlay.hidden = true;
    const files = [...(e.dataTransfer?.files ?? [])];
    if (files.length) onFiles(files);
  });
}

void main();
