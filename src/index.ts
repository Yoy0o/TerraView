/**
 * TerraView public entry.
 *
 * Everything a host application needs is exported from here; anything not
 * exported is internal and may change without notice. The stylesheet is a
 * separate import: `import 'terra-view/style.css'`.
 *
 * API tiers (docs/api.md §2): exports are stable unless their declaration is
 * tagged advanced (engine objects and implementation details for extensions
 * and debugging; may change in a minor version). Members tagged internal are
 * stripped from the published declarations. Do not write the tags themselves
 * (at sign + name) in this comment: `stripInternal` matches the text of any
 * leading comment, and this one leads the first export.
 *
 * Units and frames (see docs/api.md): world coordinates are ECEF meters, the
 * public API takes degrees and meters above the WGS84 ellipsoid, internals use
 * radians.
 *
 * Groups below:
 *   viewer      GeoViewer, camera controller, navigation, interaction, picking
 *   local       local scene (one area on its own, sandbox walls)
 *   globe       imagery providers and presets, terrain sources, raster overlays
 *   tiles3d     OGC 3D Tiles layers
 *   vector      GeoJSON layers and their styles
 *   markers     HTML markers, point layers, clustering
 *   indoor      building documents, entities, selectors, level controls
 *   atmosphere  cloud layer options
 *   core        ellipsoid, geodesy, GPU tiers, events, math helpers, locales, errors
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
  ViewerError,
  ViewerErrorSource,
  ViewerEvents,
  ViewerSnapshot,
  ViewPosition,
} from './viewer/GeoViewer';
export type { LoadState } from './viewer/loadState';
export { GlobeCameraController } from './viewer/GlobeCameraController';
export type { AutoOrbitOptions, CameraAnimationStep, CameraBounds, ControllerEvents, FlyToOptions } from './viewer/GlobeCameraController';
export { NavigationControls, AUTO_ROTATE_DEFAULTS } from './viewer/NavigationControls';
export type { AutoRotateMode, AutoRotateSettings } from './viewer/NavigationControls';
export { INTRO_DEFAULTS } from './viewer/IntroAnimation';
export type { IntroSpinOptions } from './viewer/IntroAnimation';
export { InteractionManager } from './viewer/InteractionManager';
export type { InteractionEvent, InteractionType, ListenerOptions, PauseScope, PickInfo } from './viewer/InteractionManager';
export { PickBuffer } from './viewer/PickBuffer';
export type { GpuPick, PickBufferOptions, PickTarget } from './viewer/PickBuffer';
export type { SurfaceHeight, SurfaceHeightOptions, SurfaceSample, SurfaceSource } from './viewer/SurfaceHeight';
export {
  cameraDirection,
  cameraRight,
  cameraUp,
  getHeadingPitch,
  lookAtHeadingPitchRange,
  orientationFromHeadingPitch,
} from './viewer/cameraMath';
export type { HeadingPitch } from './viewer/cameraMath';

// ---------------------------------------------------------------- local
export { LocalScene } from './local/LocalScene';
export type { LocalSceneCameraOptions, LocalSceneEvents, LocalSceneOptions, LocalSceneRegion, LocalSceneWallOptions } from './local/LocalScene';
export { MAX_REGION_DIAMETER, MAX_REGION_VERTICES, MIN_REGION_RADIUS, ResolvedRegion } from './local/region';
export type { LocalRegion } from './local/region';

// ---------------------------------------------------------------- globe
export { Globe } from './globe/Globe';
export type { GlobeOptions, GlobeStats } from './globe/Globe';
export { XYZImageryProvider } from './globe/imagery/ImageryProvider';
export type { ImageryProvider, XYZImageryOptions } from './globe/imagery/ImageryProvider';
export { EquirectangularImageryProvider } from './globe/imagery/EquirectangularImageryProvider';
export type { EquirectangularImageryOptions } from './globe/imagery/EquirectangularImageryProvider';
export { DebugImageryProvider } from './globe/imagery/DebugImageryProvider';
export { IMAGERY_PRESETS, OVERLAY_PRESETS, findImageryPreset, findOverlayPreset } from './globe/imagery/presets';
export type { ImageryPreset, OverlayPreset } from './globe/imagery/presets';
export { AWS_TERRARIUM, cesiumIonTerrain, mapboxTerrain, maptilerTerrain, quantizedMeshFromLayerJson } from './globe/terrain/TerrainSource';
export type { QuantizedMeshTerrainSource, RasterTerrainSource, TerrainEncoding, TerrainSource } from './globe/terrain/TerrainSource';
export { OverlayCompositor } from './globe/OverlayCompositor';
export type { RasterOverlay } from './globe/OverlayCompositor';
export { tileDebugUniforms, refreshTileMaterials } from './globe/TileMaterial';

// ---------------------------------------------------------------- 3D Tiles
export { Tiles3DLayer } from './tiles3d/Tiles3DLayer';
export type { Tiles3DLayerEvents, Tiles3DLayerOptions, TilesetSource, TilesMemoryStats } from './tiles3d/Tiles3DLayer';
export type { FeatureHighlightStyle, TileFeature } from './tiles3d/tileFeatures';

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
export { createCard } from './markers/cards';
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
export { FloorOcclusion, FLOOR_OCCLUSION_DEFAULTS } from './indoor/FloorOcclusion';
export type { BakedOcclusion, FloorOcclusionOptions, OcclusionGrid } from './indoor/FloorOcclusion';

// ---------------------------------------------------------------- post-processing and per-object effects
export { ViewerEffects } from './post/ViewerEffects';
export { BUILTIN_OUTLINES, COLOR_GRADING_PRESETS } from './post/postMath';
export type { ColorGradingOptions, ObjectEffects, OutlineStyle } from './post/postMath';
export { Supersampling } from './post/Supersampling';
export type { SupersamplingOptions } from './post/Supersampling';
export { ColorGrading } from './post/ColorGrading';
export { Transparency } from './post/Transparency';
export type { TransparencyOptions } from './post/Transparency';
export { PostPipeline } from './post/PostPipeline';
export type { PostEffect, PostFrame, PostInputs, PostStage } from './post/PostPipeline';

// ---------------------------------------------------------------- lighting
export { SunShadows } from './lighting/SunShadows';
export type { SunShadowOptions } from './lighting/SunShadows';

// ---------------------------------------------------------------- atmosphere
export { CloudLayer, CLOUD_DEFAULTS } from './atmosphere/CloudLayer';
export type { CloudOptions, ResolvedCloudOptions } from './atmosphere/CloudLayer';
export { VOLUMETRIC_CLOUD_DEFAULTS } from './atmosphere/volumetricCloudMath';
export type { VolumetricCloudOptions } from './atmosphere/volumetricCloudMath';

// ---------------------------------------------------------------- core
export { Ellipsoid, cartographic } from './core/Ellipsoid';
export type { Cartographic } from './core/Ellipsoid';
export { EventEmitter } from './core/EventEmitter';
export { WGS84_A, WGS84_B, geodeticNormal, geodeticToEcef } from './core/geodesy';
export { sunDirectionECEF } from './core/SunPosition';
export { GPU_TIERS, classifyGpu, gpuProfile, parseGpuTier } from './core/gpuProfile';
export type { CloudQuality, GpuHints, GpuProfile, GpuTier, IndoorQuality, TilesQuality } from './core/gpuProfile';
export { DEG2RAD, RAD2DEG, clamp, formatDegrees, formatDistance } from './core/math';
export { DEFAULT_LOCALE, MESSAGES, localize, resolveMessages } from './core/i18n';
export type { LocaleId, LocalizedText, ViewerMessageOverrides, ViewerMessages } from './core/i18n';
export { TerraViewError, isTerraViewError } from './core/errors';
export type { TerraViewErrorCode, TerraViewErrorDetails } from './core/errors';
