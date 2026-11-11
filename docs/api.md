# TerraView 公共 API

面向在应用里嵌入 TerraView 的开发者。这里列的是从包入口 `terra-view`（`src/index.ts`）导出的内容；没有导出的模块是内部实现，随时可能变。各子系统的细节在 [docs/agents/](agents/)。

> 状态：0.1.0，私有包。0.x 阶段次版本号可以有破坏性变更，变更记入 [CHANGELOG](../CHANGELOG.md)。

## 1. 接入

```ts
import 'terra-view/style.css';
import { GeoViewer } from 'terra-view';

const viewer = await GeoViewer.create({ container: document.getElementById('map')! });
```

| 事项 | 说明 |
| --- | --- |
| 包入口 | `terra-view`（ES 模块，`dist/terraview.js`，类型在 `dist/types/`）；`terra-view/style.css` |
| peer 依赖 | `three` 0.187.x、`3d-tiles-renderer` 0.5.x，由宿主安装，不打进包。TypeScript 宿主另装 `@types/three@0.187.0` |
| 浏览器 | WebGPU（Chrome / Edge 113+），没有时自动回退 WebGL 2；`forceWebGL: true` 强制 WebGL 2 |
| 打包工具 | Worker 是 `dist/assets/*.worker-*.js`，用 `new URL(..., import.meta.url)` 引用。Vite 8（开发与构建）已实测；webpack 5 未实测 |
| 释放 | `viewer.dispose()`：停止渲染循环，释放 GPU 资源、Worker、监听，移除 canvas，恢复容器 |

### 1.1 容器

`container` 可以是任意有尺寸的元素，不必铺满窗口；尺寸变化由内部的 `ResizeObserver` 跟随。`GeoViewer` 对容器做三件事，`dispose()` 时恢复：

- 加 `tv-viewer` 类（样式作用域，并让顶牌的 `z-index` 留在 viewer 内部）。
- `position` 是 `static` 时改成 `relative`（顶牌层和淡出层相对容器定位）。
- 没有 `tabindex` 时设为 `-1`，用来接收键盘。

### 1.2 样式与主题

`terra-view/style.css` 只管 SDK 创建的元素，类名都以 `tv-` 开头：

| 类 | 元素 |
| --- | --- |
| `.tv-viewer` | 容器 |
| `.tv-canvas` | 渲染用的 canvas |
| `.tv-crossfade` | 层级切换时淡出的上一帧 |
| `.tv-marker-layer`（密集时加 `.tv-dense`） | 顶牌层 |
| `.tv-marker`（`.tv-interactive`、`.tv-occluded`） | 单个顶牌的定位外壳 |
| `.tv-card` + `.tv-<样式名>`（`.tv-selected`） | 顶牌内容，样式名见 [markers.md](agents/markers.md) §2 |

主题变量设在容器或任意祖先上：`--tv-font`、`--tv-text`、`--tv-muted`、`--tv-card-bg`；单个顶牌的强调色是 `--tv-accent`（由 `color` 选项设置）。自定义顶牌可以直接给 `viewer.markers.add({ element })` 传自己的元素，不必用内置样式。

### 1.3 键盘与焦点

相机快捷键（W A S D / 方向键平移，Q E 转向，R F 俯仰）只在焦点位于 viewer 内时生效，不监听 `window`：同页多个 viewer 互不影响，宿主的输入框和快捷键不受干扰。点击 canvas 或顶牌会让 viewer 获得焦点；要一打开就能用键盘，调用 `viewer.canvas.focus()`。带 Ctrl / Meta / Alt 的组合键不处理。`viewer.controller.enableKeyboard = false` 关闭。

Esc 返回上一级之类的全局快捷键属于应用，SDK 不注册，写法见 `demo/main.ts`。

### 1.4 解码器

glTF 的 Draco、KTX2（Basis）解码器默认用宿主安装的 three.js 自带的文件，由宿主的打包工具处理。要自己托管时：

```ts
GeoViewer.create({ container, decoderPath: '/libs/draco/gltf/', transcoderPath: '/libs/basis/' });
```

### 1.5 凭证

天地图、Cesium ion、Google、Mapbox、MapTiler 的密钥由宿主作为参数传入（`IMAGERY_PRESETS[i].create(key)`、`cesiumIonTerrain(token)`、`addTileset({ source: { type: 'google', apiKey } })` 等）。SDK 不保存、不内置任何凭证。

## 2. 约定

- **坐标**：世界坐标是 ECEF，单位米，+Z 指向北极。公共 API 的经纬度用度，高度是 WGS84 椭球高（米），航向自北顺时针（度），俯仰向下为负（度）。带 `Vector3` 的参数是 ECEF 点。
- **事件**：各对象的 `events` 是 `EventEmitter`，`on(type, handler)` 返回取消函数。
- **相机**：不要直接改 `viewer.camera` 的位姿，用 `setView` / `flyTo` / `viewer.navigation` / `controller.playAnimation`，否则手势打断不了，也不触发按需更新。
- **内部对象**：`viewer.renderer`、`scene`、`camera`、`globe`、`controller` 是公开字段，方便调试和高级用法，但不属于稳定 API。

## 3. 导出清单

### 3.1 viewer

| 导出 | 用途 |
| --- | --- |
| `GeoViewer` | 总入口。`GeoViewer.create(options)` 创建；`setView` / `getView` / `flyTo` / `flyToTarget` / `flyToBBox` / `flyToSphere`；`addTileset` / `addGeoJson` / `addPoints` 及对应的 `remove*`；`pick` / `pickAt`；`surfaceHeight`；`loadModel`；`captureFrame`；`playIntro`；开关 `atmosphere` / `lighting` / `showStars` / `showGlobe`；`dispose` |
| `GeoViewerOptions`、`ViewPosition`、`TargetView`、`SphereFlightOptions` | 创建参数与视点类型 |
| `viewer.events`（`ViewerEvents`） | 图层增删、帧统计等事件 |
| `viewer.info`（`RendererInfo`）、`viewer.stats`（`FrameStats`）、`viewer.memory`（`MemoryReport`）、`viewer.gpu`（`GpuProfile`） | 后端与适配器、帧耗时、显存估算、档位预算 |
| `viewer.canvas` | 渲染用的 canvas |
| `GlobeCameraController`（`viewer.controller`） | 手势开关（`enablePan` / `enableRotate` / `enableTilt` / `enableZoom` / `enableKeyboard`）、`zoomBy` / `orbitBy`、`playAnimation`、环绕巡航；[camera-controller.md](agents/camera-controller.md) |
| `NavigationControls`（`viewer.navigation`） | 放大缩小、转向、2D/3D、回到初始视角、自动旋转、全屏、截图；[intro-and-navigation.md](agents/intro-and-navigation.md) |
| `InteractionManager`（`viewer.interaction`） | `on(type, handler, { selector, tag, priority, once })`、`off`、`pause`；类型 `InteractionEvent`、`ListenerOptions`、`PauseScope`、`PickInfo` |
| `PickBuffer`（`viewer.pickBuffer`） | GPU 拾取缓冲；改了签名看不到的东西后调用 `invalidate()` |
| `SurfaceHeight` 等 | `viewer.surfaceHeight(lon, lat)` 的结果类型（地形或可见 3D Tiles 的高度，带可信度） |
| `getHeadingPitch`、`lookAtHeadingPitchRange`、`orientationFromHeadingPitch`、`cameraDirection` / `cameraUp` / `cameraRight` | 相机数学（弧度） |

### 3.2 globe

| 导出 | 用途 |
| --- | --- |
| `ImageryProvider`、`XYZImageryProvider`、`EquirectangularImageryProvider`、`DebugImageryProvider` | 底图影像源；自定义源实现 `ImageryProvider` |
| `IMAGERY_PRESETS` / `findImageryPreset`、`OVERLAY_PRESETS` / `findOverlayPreset` | 内置底图与叠加层预设 |
| `TerrainSource`、`AWS_TERRARIUM`、`mapboxTerrain`、`maptilerTerrain`、`cesiumIonTerrain`、`quantizedMeshFromLayerJson` | 地形源 |
| `RasterOverlay`、`OverlayCompositor`（`viewer.overlays`） | 半透明栅格叠加层 |
| `Globe`（`viewer.globe`）、`GlobeOptions`、`GlobeStats` | 四叉树地球：`stats`、`maxScreenSpaceError`、`terrainExaggeration`；[tile-loading.md](agents/tile-loading.md) |
| `tileDebugUniforms`、`refreshTileMaterials` | 瓦片着色器的调试开关（页面上所有 viewer 共用） |

### 3.3 3D Tiles

`Tiles3DLayer`（`viewer.addTileset(options)` 的返回值）：`visible`、`errorTarget`、`heightOffset`、`events`（`ready` 等）、`memory`。来源 `TilesetSource`：`url` / `ion` / `google`。预算见 [gpu-memory.md](agents/gpu-memory.md)。

### 3.4 矢量

`GeoJsonLayer`（`viewer.addGeoJson`）、`GeoJsonLayerOptions`、`VectorStyle`、`LabelStyle`、`DEFAULT_VECTOR_STYLE`、`DEFAULT_LABEL_STYLE`、`FeatureHit`、`LayerSummary`；`lonLatToMerc` / `mercToLonLat`。

### 3.5 顶牌与点位

| 导出 | 用途 |
| --- | --- |
| `MarkerManager`（`viewer.markers`）、`Marker`、`MarkerOptions` | HTML 顶牌：`add({ element, position, ... })`、`remove`；遮挡 `occlusion: 'none' \| 'hide' \| 'fade'` |
| `createCard`、`createClusterCard`、`setClusterCount`、`CardOptions` | 内置顶牌样式模板 |
| `PointLayer`（`viewer.addPoints`）、`PointLayerOptions`、`ClusterOptions` | 点位图层：数据、样式规则、聚合 |
| `parsePoints`、`resolvePointStyle`、`matchesRule`、`fillTemplate`、`pointsBBox`、`MARKER_STYLES` | 点位解析与规则（纯函数） |
| `buildClusterTree`、`ClusterSelector`、`clusterLeaves` | 层级聚合树（纯函数） |

格式与规则见 [markers.md](agents/markers.md)。

### 3.6 室内 / BIM

| 导出 | 用途 |
| --- | --- |
| `IndoorManager`（`viewer.indoor`） | `add(doc, baseUrl?)`、`remove`、`enter(entity)`、`back()`、`query(selector)`、`getById`、`events`（`beforeEnterLevel` / `enterLevel` / `leaveLevel`）、`registerLevelControl` |
| `Building`、`BimEntity`、`EntitySet` | 建筑、实体（`setStyle`、`visible`、`levelOpacity`、`refreshTransform`）、查询结果的批量操作 |
| `parseBuildingDoc`、`BuildingDoc`、`FloorDef`、`RoomDef`、`ThingDef`、`StructureDef` 等 | `three-geo-building` 文档格式与校验；[building-data-manual.md](building-data-manual.md) |
| `compileSelector`、`SelectorError`、`matchesSelector`、`closestMatching` | 选择器 |
| `LevelControl`、`BUILTIN_LEVEL_CONTROLS`、`buildingLevelControl` 等 | 层级的显隐、半透明、取景策略，可替换 |
| `ContributionCuller`（`viewer.indoor.culling`）、`ContributionCullingOptions` | 贡献剔除，默认关闭 |

格式、层级事件和选择器语法见 [indoor-bim.md](agents/indoor-bim.md)。

### 3.7 大气与 core

`CloudLayer`（`viewer.clouds`）、`CloudOptions`、`CLOUD_DEFAULTS`；`Ellipsoid`、`cartographic`、`geodeticToEcef`、`geodeticNormal`、`geoidUndulation`、`sunDirectionECEF`；`GpuTier`、`gpuProfile`、`classifyGpu`、`parseGpuTier`；`EventEmitter`；`DEG2RAD`、`RAD2DEG`、`clamp`、`formatDegrees`、`formatDistance`。

## 4. 多个 viewer

同一页面可以创建多个 `GeoViewer`（各自的容器、相机、图层、事件）。已实测两个 viewer 并排运行。需要知道的共享状态：

- 按域名的请求队列跨 viewer 共享（浏览器的连接数本来就按页面算）。
- `tileDebugUniforms` 和大气的全局参数是模块级的，所有 viewer 共用。
- 点位聚合用一个共享 Worker，最后一个点位图层销毁时关闭。

反复创建、销毁的长时间稳定性还没有专门测试（路线图 §10 S5）。

## 5. 还没有的东西

- 没有发布到 npm（`package.json` 里是 `private`）。许可证 Apache-2.0，见仓库根目录的 `LICENSE`。包名：`terra-view` 在 npm 上没有注册（2026-11-11 查询）。但 npm 上已有 `terraview`（npm 官方的安全占位包，2021 年起），而 npm 自 2017 年起不允许新建的无 scope 包名去掉 `.` `-` `_` 后与已有包相同，所以首次发布 `terra-view` 有可能被拒；这一点只有真正发布时才能确认。被拒时改用带 scope 的 `@<scope>/terra-view`（scope 不受这条规则限制）。
- 核心里还有少量写死的中文默认文案（房间顶牌副标题取 `面积` 属性、点位图层默认名、解析告警文本），没有 i18n 选项。
- 没有 CommonJS / UMD 产物，只有 ES 模块。
- 示例数据（`demo/data/`）和演示面板（`demo/ui/`）不随包发布。
