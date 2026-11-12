# TerraView 公共 API

面向在应用里嵌入 TerraView 的开发者。这里列的是从包入口 `terra-view`（`src/index.ts`）导出的内容；没有导出的模块是内部实现，随时可能变。各子系统的细节在 [docs/agents/](agents/)。

> 状态：0.1.0，私有包。0.x 阶段次版本号可以有破坏性变更，变更记入 [CHANGELOG](../CHANGELOG.md)。

## 1. 接入

```ts
import 'terra-view/style.css';
import { GeoViewer, IMAGERY_PRESETS } from 'terra-view';

const viewer = await GeoViewer.create({
  container: document.getElementById('map')!,
  imagery: IMAGERY_PRESETS[0].create(), // 底图影像源，必填
});
```

| 事项 | 说明 |
| --- | --- |
| 包入口 | `terra-view`（ES 模块，`dist/terraview.js`，类型在 `dist/types/`）；`terra-view/style.css` |
| peer 依赖 | `three` 0.187.x、`3d-tiles-renderer` 0.5.x，由宿主安装，不打进包。TypeScript 宿主另装 `@types/three@0.187.0` |
| 浏览器 | WebGPU（Chrome / Edge 113+），没有时自动回退 WebGL 2；`forceWebGL: true` 强制 WebGL 2 |
| 打包工具 | Worker 是 `dist/assets/*.worker-*.js`，用 `new URL(..., import.meta.url)` 引用。Vite 8（开发与构建）已实测；webpack 5（style-loader / css-loader）已实测：构建、运行，以及 Draco、KTX2、meshopt 模型的实际解码（不用设解码器路径） |
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
GeoViewer.create({ container, imagery, decoderPath: '/libs/draco/gltf/', transcoderPath: '/libs/basis/' });
```

### 1.5 凭证

天地图、Cesium ion、Google、Mapbox、MapTiler 的密钥由宿主作为参数传入（`IMAGERY_PRESETS[i].create(key)`、`cesiumIonTerrain(token)`、`addTileset({ source: { type: 'google', apiKey } })` 等）。SDK 不保存、不内置任何凭证。

### 1.6 语言与错误

SDK 自己生成、会给最终用户看的文字只有几类，默认中文（`zh-CN`），可以切换成英文或逐项改写：

```ts
GeoViewer.create({ container, imagery, locale: 'en' });
GeoViewer.create({ container, imagery, messages: { entityProperties: { area: '建筑面积' }, pointLayerName: '站点' } });
```

| 文字 | 来源 | zh-CN / en |
| --- | --- | --- |
| BIM 实体的自动属性名 | `messages.entityProperties` | 楼层数 / Floors、建筑高度 / Building height、楼层 / Floor、标高 / Elevation、层高 / Storey height、面积 / Area、类型 / Type |
| 房间顶牌的默认副标题 | 取 `area` 属性 | 同上 |
| 没有名字、也没有 URL 的点位图层名 | `messages.pointLayerName` | 点位 / Points |
| 内置影像、叠加层预设的显示名 | 预设的 `label`（`LocalizedText`），用 `localize(preset.label, locale)` 取 | 各预设两种语言都有 |

`viewer.locale`、`viewer.messages` 是生效的语言和文字。属性名是实体 `properties` 的键：选择器和样式规则里要用当前语言的名字（`[面积>20]` 或 `[Area>20]`）。服务商署名（attribution）保持服务商要求的原文；输入数据里认的字段别名（"经度""名称"等）与语言无关。

**错误**：SDK 主动抛出的错误都是 `TerraViewError`：`message` 是英文（给日志和开发者看），`code` 稳定、可以据此翻译或处理，`details` 带上相关的值。用 `isTerraViewError(err, code?)` 判断。

| `code` | 何时 | `details` |
| --- | --- | --- |
| `imagery-unreachable` | 底图影像连续 3 次请求失败（`globe.onImageryError` 回调、`globe.imageryError`） | `provider`、`reason` |
| `terrain-format-unsupported` | quantized-mesh 的 layer.json 格式不认识 | `format` |
| `terrain-projection-unsupported` | quantized-mesh 不是 EPSG:4326 | `projection` |
| `ion-asset-not-terrain` | Cesium ion 资产不是地形 | `assetId`、`type` |
| `building-invalid` | 建筑文档校验失败（`parseBuildingDoc`、`indoor.add`） | `path`（如 `$.floors[0].height`） |
| `building-already-loaded` | 同一 id 的建筑重复加载 | `id` |
| `points-empty` | 点位数据里没有可用的点（`message` 带第一条解析告警） | 无 |
| `geojson-invalid` | GeoJSON 无法识别（`addGeoJson`） | 无 |
| `option-invalid` | `GeoViewer.create` 的必填项缺失或类型不对（`container` 要是元素，`imagery` 要是影像源）；在创建渲染器之前检查 | `option`、`expected` |

图层异步加载失败时，`GeoJsonLayer`、`PointLayer` 的 `error` 事件带上原始错误（`{ message, error }`），可以照样按 `code` 处理。网络错误（`HTTP 404` 等）和第三方库的错误照原样抛出，不包装。演示应用把 code 译成中文的写法见 `demo/ui/errors.ts`。

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
| `IMAGERY_PRESETS` / `findImageryPreset`、`OVERLAY_PRESETS` / `findOverlayPreset` | 内置底图与叠加层预设；显示名是 `label`（`LocalizedText`），见 §1.6 |
| `TerrainSource`、`AWS_TERRARIUM`、`mapboxTerrain`、`maptilerTerrain`、`cesiumIonTerrain`、`quantizedMeshFromLayerJson` | 地形源 |
| `RasterOverlay`、`OverlayCompositor`（`viewer.overlays`） | 半透明栅格叠加层 |
| `Globe`（`viewer.globe`）、`GlobeOptions`、`GlobeStats` | 四叉树地球：`stats`、`maxScreenSpaceError`、`terrainExaggeration`、`onImageryError` / `imageryError`（§1.6）；[tile-loading.md](agents/tile-loading.md) |
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

语言与错误（§1.6）：`LocaleId`、`DEFAULT_LOCALE`、`MESSAGES`、`ViewerMessages`、`ViewerMessageOverrides`、`resolveMessages`、`LocalizedText`、`localize`；`TerraViewError`、`TerraViewErrorCode`、`TerraViewErrorDetails`、`isTerraViewError`。

## 4. 多个 viewer

同一页面可以创建多个 `GeoViewer`（各自的容器、相机、图层、事件），可以混用 WebGPU 和 WebGL 后端（`forceWebGL`）。

模块级的共享状态（2026-11-12 逐项核对）：

| 共享的东西 | 位置 | 为什么安全 |
| --- | --- | --- |
| 按域名的请求队列 | `globe/imagery/RequestScheduler` | 有意共享：浏览器的连接数本来就按页面算 |
| 瓦片着色器的节点图、占位纹理、形变位置节点 | `globe/TileMaterial` | 节点和纹理对象由每个渲染器各自编译、上传；从不释放，不会被某个 viewer 的 `dispose()` 带走 |
| `tileDebugUniforms` | `globe/TileMaterial` | 调试开关，有意让所有 viewer 一起变 |
| 大气 uniform（太阳方向、相机位置与高度、光照 / 大气开关） | `atmosphere/AtmosphereNodes` | 每个 viewer 渲染前重写全部值（帧内在 `updateEnvironment` 里；帧外的截图和层级切换截帧也先重写，见下） |
| 注记的相机 uniform 与节点 | `vector/LabelManager` | 同上，渲染前 `syncCamera` |
| 3D Tiles 渐显遮罩节点 | `tiles3d/nodeMaterials` | 只读节点图，逐材质参数走 `materialReference` |
| 设备的几何与材质池 | `indoor/StylePool`（`sharedStylePool`） | 按键共享、引用计数：最后一个使用者释放后才 `dispose` |
| 选择器编译缓存 | `indoor/selector` | 纯函数结果 |
| 点位聚合 Worker | `markers/PointLayer` | 引用计数，最后一个点位图层销毁时关闭 |
| EGM96 网格 | `core/Geoid` | 只读数据，首次使用时解码 |

实测（2026-11-12，Chrome，演示应用的 WebGPU viewer 旁边再建 viewer）：一个 WebGL viewer 与演示应用的 WebGPU viewer 同时加载同一栋建筑（共用样式池的材质），然后销毁；再轮流以 WebGPU / WebGL 创建 6 个 viewer，各加建筑和 300 个聚合点位、渲染后销毁。全程控制台无错误，演示应用的建筑照常渲染（材质没有被别的 viewer 的销毁释放），最后只剩一个 canvas。另外，反复创建、销毁 40 次的泄漏测试见路线图 §10.5：Worker、canvas、`tv-*` 节点、窗口 / 文档监听、rAF 都回到基线。

**新增模块级状态时**：先想清楚它该按 viewer 持有还是全局共享（AGENTS.md §3.10）；共享的写进上表。存放"当前相机""当前开关"这类按 viewer 不同的值的共享 uniform，必须在该 viewer 的每次渲染前重写，包括帧循环之外的渲染。

## 5. 还没有的东西

- 没有发布到 npm（`package.json` 里是 `private`）。许可证 Apache-2.0，见仓库根目录的 `LICENSE`。包名：`terra-view` 在 npm 上没有注册（2026-11-11 查询）。但 npm 上已有 `terraview`（npm 官方的安全占位包，2021 年起），而 npm 自 2017 年起不允许新建的无 scope 包名去掉 `.` `-` `_` 后与已有包相同，所以首次发布 `terra-view` 有可能被拒；这一点只有真正发布时才能确认。被拒时改用带 scope 的 `@<scope>/terra-view`（scope 不受这条规则限制）。
- 显示文案只内置 `zh-CN` 和 `en` 两种语言（§1.6）；其他语言用 `messages` 逐项改写。
- 没有 CommonJS / UMD 产物，只有 ES 模块。
- 示例数据（`demo/data/`）和演示面板（`demo/ui/`）不随包发布。
