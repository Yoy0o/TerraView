/**
 * TerraView public entry.
 *
 * Everything a host application needs is exported from here; anything not
 * exported is internal and may change without notice. The stylesheet is a
 * separate import: `import 'terra-view/style.css'`.
 *
 * Units and frames (see docs/api.md): world coordinates are ECEF meters, the
 * public API takes degrees and meters above the WGS84 ellipsoid, internals use
 * radians.
 *
 * Groups below:
 *   viewer      GeoViewer, camera controller, navigation, interaction, picking
 *   globe       imagery providers and presets, terrain sources, raster overlays
 *   tiles3d     OGC 3D Tiles layers
 *   vector      GeoJSON layers and their styles
 *   markers     HTML markers, point layers, clustering
 *   indoor      building documents, entities, selectors, level controls
 *   atmosphere  cloud layer options
 *   core        ellipsoid, geodesy, GPU tiers, events, math helpers
 */

// ---------------------------------------------------------------- viewer
export { GeoViewer } from './viewer/GeoViewer';
export type {
  FeaturePick,
  FrameStats,
  GeoViewerOptions,
  MemoryReport,
  RendererInfo,
  SphereFlightOptions,
  SurfacePick,
  TargetView,
  ViewerEvents,
  ViewPosition,
} from './viewer/GeoViewer';
export { GlobeCameraController } from './viewer/GlobeCameraController';
export type { AutoOrbitOptions, CameraAnimationStep, ControllerEvents, FlyToOptions } from './viewer/GlobeCameraController';
export { NavigationControls, AUTO_ROTATE_DEFAULTS } from './viewer/NavigationControls';
export type { AutoRotateMode, AutoRotateSettings } from './viewer/NavigationControls';
export { INTRO_DEFAULTS } from './viewer/IntroAnimation';
export type { IntroSpinOptions } from './viewer/IntroAnimation';
export { InteractionManager } from './viewer/InteractionManager';
export type { InteractionEvent, InteractionType, ListenerOptions, PauseScope, PickInfo } from './viewer/InteractionManager';
export { PickBuffer } from './viewer/PickBuffer';
export type { GpuPick, PickBufferOptions, PickTarget } from './viewer/PickBuffer';
export type { SurfaceHeight, SurfaceHeightOptions, SurfaceSample, SurfaceSource } from './viewer/SurfaceHeight';
export { FrameCrossfade } from './viewer/FrameCrossfade';
export {
  cameraDirection,
  cameraRight,
  cameraUp,
  getHeadingPitch,
  lookAtHeadingPitchRange,
  orientationFromHeadingPitch,
} from './viewer/cameraMath';
export type { HeadingPitch } from './viewer/cameraMath';

// ---------------------------------------------------------------- globe
export { Globe } from './globe/Globe';
export type { GlobeOptions, GlobeStats } from './globe/Globe';
export { XYZImageryProvider, decodeImage } from './globe/imagery/ImageryProvider';
export type { ImageryProvider, XYZImageryOptions } from './globe/imagery/ImageryProvider';
export { EquirectangularImageryProvider } from './globe/imagery/EquirectangularImageryProvider';
export type { EquirectangularImageryOptions } from './globe/imagery/EquirectangularImageryProvider';
export { DebugImageryProvider } from './globe/imagery/DebugImageryProvider';
export { IMAGERY_PRESETS, OVERLAY_PRESETS, findImageryPreset, findOverlayPreset } from './globe/imagery/presets';
export type { ImageryPreset, OverlayPreset } from './globe/imagery/presets';
export {
  AWS_TERRARIUM,
  cesiumIonTerrain,
  isQuantizedMesh,
  mapboxTerrain,
  maptilerTerrain,
  quantizedMeshFromLayerJson,
} from './globe/terrain/TerrainSource';
export type { QuantizedMeshTerrainSource, RasterTerrainSource, TerrainEncoding, TerrainSource } from './globe/terrain/TerrainSource';
export { OverlayCompositor } from './globe/OverlayCompositor';
export type { RasterOverlay } from './globe/OverlayCompositor';
export { WebMercatorTilingScheme, MERCATOR_MAX_LATITUDE } from './globe/TilingScheme';
export type { GeoRect } from './globe/TilingScheme';
/** Debug switches of the globe tile shader (wireframe tint, tile borders): shared by every viewer on the page. */
export { tileDebugUniforms, refreshTileMaterials } from './globe/TileMaterial';

// ---------------------------------------------------------------- 3D Tiles
export { Tiles3DLayer } from './tiles3d/Tiles3DLayer';
export type { Tiles3DLayerEvents, Tiles3DLayerOptions, TilesetSource, TilesMemoryStats } from './tiles3d/Tiles3DLayer';

// ---------------------------------------------------------------- vector
export { GeoJsonLayer } from './vector/GeoJsonLayer';
export type { GeoJsonLayerEvents, GeoJsonLayerOptions } from './vector/GeoJsonLayer';
export { DEFAULT_LABEL_STYLE, DEFAULT_VECTOR_STYLE } from './vector/types';
export type { FeatureHit, FeatureKind, LabelStyle, LayerSummary, VectorSource, VectorStyle } from './vector/types';
export { lonLatToMerc, mercToLonLat } from './vector/geometry';

// ---------------------------------------------------------------- markers and points
export { Marker, MarkerManager } from './markers/MarkerManager';
export type { MarkerEventType, MarkerOptions, MarkerStats } from './markers/MarkerManager';
export type { MarkerOcclusion, OcclusionMode } from './markers/occlusion';
export { createCard, createClusterCard, setClusterCount } from './markers/cards';
export type { CardOptions } from './markers/cards';
export { PointLayer } from './markers/PointLayer';
export type { ClusterOptions, PointLayerEvents, PointLayerOptions, PointLayerStats } from './markers/PointLayer';
export {
  MARKER_STYLES,
  defaultTitle,
  fillTemplate,
  matchesRule,
  parsePoints,
  pointsBBox,
  resolvePointStyle,
} from './markers/points';
export type { Condition, MarkerStyleName, ParsedPoints, PointRecord, PointRule, PointStyle } from './markers/points';
export { buildClusterTree, clusterLeaves, ClusterSelector } from './markers/clusterTree';
export type { ClusterTree, ClusterTreeInput, ClusterTreeOptions, ClusterView } from './markers/clusterTree';

// ---------------------------------------------------------------- indoor / BIM
export { IndoorManager } from './indoor/IndoorManager';
export type { CameraPose, EnterOptions, IndoorEvents, LevelEvent } from './indoor/IndoorManager';
export { Building } from './indoor/Building';
export type { BuildingOptions, ModelLoader } from './indoor/Building';
export { BimEntity, STRUCTURE_TAG, closestMatching, matchesSelector } from './indoor/BimEntity';
export type { EntitySelector, EntityStyle, EntityType } from './indoor/BimEntity';
export { EntitySet } from './indoor/EntitySet';
export { compileSelector, SelectorError } from './indoor/selector';
export type { Selectable, SelectorPredicate } from './indoor/selector';
export {
  BUILDING_FORMAT,
  BUILDING_FORMAT_VERSION,
  STRUCTURE_KINDS,
  parseBuildingDoc,
  pointInPolygon,
  polygonArea,
  polygonCentroid,
} from './indoor/schema';
export type {
  BuildingDoc,
  ElementBase,
  FloorDef,
  GeoAnchor,
  LabelDef,
  LabelMode,
  ModelRef,
  RoomDef,
  StructureDef,
  ThingDef,
  Vec2,
  Vec3,
  ViewpointDef,
} from './indoor/schema';
export {
  BUILTIN_LEVEL_CONTROLS,
  basicLevelControl,
  buildingLevelControl,
  defaultFilterObject,
  floorLevelControl,
  focusSet,
  framedView,
  placementLevelControl,
  showOutside,
} from './indoor/LevelControl';
export type { LevelContext, LevelControl } from './indoor/LevelControl';
export type { Framing, LevelView } from './indoor/levelView';
export { ContributionCuller, DEFAULT_CULLING } from './indoor/ContributionCulling';
export type { ContributionCullingOptions, CullingRule } from './indoor/ContributionCulling';

// ---------------------------------------------------------------- atmosphere
export { CloudLayer, CLOUD_DEFAULTS } from './atmosphere/CloudLayer';
export type { CloudOptions } from './atmosphere/CloudLayer';

// ---------------------------------------------------------------- core
export { Ellipsoid, cartographic } from './core/Ellipsoid';
export type { Cartographic } from './core/Ellipsoid';
export { EventEmitter } from './core/EventEmitter';
export { WGS84_A, WGS84_B, geodeticNormal, geodeticToEcef } from './core/geodesy';
export { geoidUndulation } from './core/Geoid';
export { greenwichMeanSiderealTime, sunDirectionECEF } from './core/SunPosition';
export { GPU_TIERS, classifyGpu, gpuProfile, parseGpuTier } from './core/gpuProfile';
export type { GpuHints, GpuProfile, GpuTier, TilesQuality } from './core/gpuProfile';
export { DEG2RAD, RAD2DEG, clamp, formatDegrees, formatDistance } from './core/math';
