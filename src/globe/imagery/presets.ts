import { DebugImageryProvider } from './DebugImageryProvider';
import { EquirectangularImageryProvider } from './EquirectangularImageryProvider';
import { XYZImageryProvider, type ImageryProvider } from './ImageryProvider';
import type { LocalizedText } from '../../core/i18n';

/** server.arcgisonline.com speaks HTTP/1.1 only; browsers open 6 connections per host. */
const ARCGIS_CONNECTIONS = 6;

export interface ImageryPreset {
  id: string;
  /** Label for preset pickers, per locale: `localize(preset.label, locale)`. */
  label: LocalizedText;
  /** Name of a credential the preset needs (looked up via `create(key)`). */
  requiresKey?: 'tianditu';
  create(key?: string): ImageryProvider;
}

export const IMAGERY_PRESETS: ImageryPreset[] = [
  {
    id: 'esri-imagery',
    label: { 'zh-CN': 'ArcGIS 卫星影像', en: 'ArcGIS World Imagery' },
    create: () =>
      new XYZImageryProvider({
        id: 'esri-imagery',
        name: 'ArcGIS World Imagery',
        url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
        maxRequestsPerHost: ARCGIS_CONNECTIONS,
        maxZoom: 19,
        attribution: 'Imagery © Esri, Maxar, Earthstar Geographics, GIS User Community',
      }),
  },
  {
    id: 'osm',
    label: { 'zh-CN': 'OpenStreetMap', en: 'OpenStreetMap' },
    create: () =>
      new XYZImageryProvider({
        id: 'osm',
        name: 'OpenStreetMap',
        url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
        maxZoom: 19,
        attribution: '© OpenStreetMap contributors',
      }),
  },
  {
    id: 'carto-voyager',
    label: { 'zh-CN': 'Carto Voyager', en: 'Carto Voyager' },
    create: () =>
      new XYZImageryProvider({
        id: 'carto-voyager',
        name: 'Carto Voyager',
        url: 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png',
        subdomains: ['a', 'b', 'c', 'd'],
        maxZoom: 20,
        attribution: '© OpenStreetMap contributors © CARTO',
      }),
  },
  {
    id: 'carto-dark',
    label: { 'zh-CN': 'Carto 暗色', en: 'Carto Dark' },
    create: () =>
      new XYZImageryProvider({
        id: 'carto-dark',
        name: 'Carto Dark Matter',
        url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png',
        subdomains: ['a', 'b', 'c', 'd'],
        maxZoom: 20,
        attribution: '© OpenStreetMap contributors © CARTO',
      }),
  },
  {
    id: 'esri-topo',
    label: { 'zh-CN': 'ArcGIS 地形图', en: 'ArcGIS Topographic' },
    create: () =>
      new XYZImageryProvider({
        id: 'esri-topo',
        name: 'ArcGIS World Topo',
        url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}',
        maxRequestsPerHost: ARCGIS_CONNECTIONS,
        maxZoom: 19,
        attribution: 'Tiles © Esri and contributors',
      }),
  },
  {
    id: 'tianditu-img',
    label: { 'zh-CN': '天地图影像（需 key）', en: 'Tianditu Imagery (key required)' },
    requiresKey: 'tianditu',
    create: (key = '') =>
      new XYZImageryProvider({
        id: 'tianditu-img',
        name: 'Tianditu Imagery',
        url: 'https://t{s}.tianditu.gov.cn/img_w/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=img&STYLE=default&TILEMATRIXSET=w&FORMAT=tiles&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}&tk={tk}',
        subdomains: ['0', '1', '2', '3', '4', '5', '6', '7'],
        minZoom: 1,
        maxZoom: 18,
        params: { tk: key },
        // Keys have a daily request quota: do not spend it on prefetching.
        prefetch: false,
        attribution: '© 天地图 / 国家地理信息公共服务平台',
      }),
  },
  {
    id: 'blue-marble',
    label: { 'zh-CN': 'Blue Marble 单图（低清）', en: 'Blue Marble single image (low resolution)' },
    create: () =>
      new EquirectangularImageryProvider({
        id: 'blue-marble',
        name: 'NASA Blue Marble',
        url: 'https://raw.githubusercontent.com/mrdoob/three.js/dev/examples/textures/planets/earth_atmos_2048.jpg',
        maxZoom: 4,
        attribution: 'NASA Blue Marble (via three.js examples)',
      }),
  },
  {
    id: 'debug',
    label: { 'zh-CN': '调试网格（离线）', en: 'Debug grid (offline)' },
    create: () => new DebugImageryProvider(),
  },
];

export function findImageryPreset(id: string): ImageryPreset | undefined {
  return IMAGERY_PRESETS.find((p) => p.id === id);
}

export interface OverlayPreset {
  id: string;
  /** Label for preset pickers, per locale: `localize(preset.label, locale)`. */
  label: LocalizedText;
  requiresKey?: 'tianditu';
  /** Suggested initial opacity. */
  opacity: number;
  create(key?: string): ImageryProvider;
}

/** Semi-transparent raster layers composited over the base imagery. */
export const OVERLAY_PRESETS: OverlayPreset[] = [
  {
    id: 'tianditu-cia',
    label: { 'zh-CN': '天地图影像注记（需 key）', en: 'Tianditu Labels (key required)' },
    requiresKey: 'tianditu',
    opacity: 1,
    create: (key = '') =>
      new XYZImageryProvider({
        id: 'tianditu-cia',
        name: 'Tianditu Labels',
        url: 'https://t{s}.tianditu.gov.cn/cia_w/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=cia&STYLE=default&TILEMATRIXSET=w&FORMAT=tiles&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}&tk={tk}',
        subdomains: ['0', '1', '2', '3', '4', '5', '6', '7'],
        minZoom: 1,
        maxZoom: 18,
        params: { tk: key },
        // Keys have a daily request quota: do not spend it on prefetching.
        prefetch: false,
        attribution: '© 天地图',
      }),
  },
  {
    id: 'esri-places',
    label: { 'zh-CN': 'Esri 边界与地名', en: 'Esri Boundaries & Places' },
    opacity: 1,
    create: () =>
      new XYZImageryProvider({
        id: 'esri-places',
        name: 'Esri Boundaries & Places',
        url: 'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}',
        maxRequestsPerHost: ARCGIS_CONNECTIONS,
        maxZoom: 19,
        attribution: 'Labels © Esri and contributors',
      }),
  },
  {
    id: 'esri-transport',
    label: { 'zh-CN': 'Esri 交通路网', en: 'Esri Transportation' },
    opacity: 0.9,
    create: () =>
      new XYZImageryProvider({
        id: 'esri-transport',
        name: 'Esri Transportation',
        url: 'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}',
        maxRequestsPerHost: ARCGIS_CONNECTIONS,
        maxZoom: 19,
        attribution: 'Roads © Esri and contributors',
      }),
  },
  {
    id: 'carto-labels',
    label: { 'zh-CN': 'Carto 地名注记', en: 'Carto Labels' },
    opacity: 1,
    create: () =>
      new XYZImageryProvider({
        id: 'carto-labels',
        name: 'Carto labels',
        url: 'https://{s}.basemaps.cartocdn.com/dark_only_labels/{z}/{x}/{y}.png',
        subdomains: ['a', 'b', 'c', 'd'],
        maxZoom: 20,
        attribution: '© OpenStreetMap contributors © CARTO',
      }),
  },
  {
    id: 'openrailwaymap',
    label: { 'zh-CN': 'OpenRailwayMap 铁路', en: 'OpenRailwayMap Railways' },
    opacity: 0.9,
    create: () =>
      new XYZImageryProvider({
        id: 'openrailwaymap',
        name: 'OpenRailwayMap',
        url: 'https://{s}.tiles.openrailwaymap.org/standard/{z}/{x}/{y}.png',
        subdomains: ['a', 'b', 'c'],
        maxZoom: 19,
        attribution: 'Railways © OpenRailwayMap (CC-BY-SA), © OpenStreetMap contributors',
      }),
  },
  {
    id: 'debug-overlay',
    label: { 'zh-CN': '调试网格（离线）', en: 'Debug grid (offline)' },
    opacity: 0.35,
    create: () => new DebugImageryProvider(),
  },
];

export function findOverlayPreset(id: string): OverlayPreset | undefined {
  return OVERLAY_PRESETS.find((p) => p.id === id);
}
