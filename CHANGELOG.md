# 更新日志

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。版本号尚未对外发布，`0.1.0` 是首个可用的原型；之后的改动先记在“未发布”下。

## [未发布]

### GPU 版层级切换过渡（2026-11-18，路线图 §0.2 P3.4）

进出建筑、切换楼层时，上一帧不再是钉在屏幕上的截图，而是按深度跟着相机移动、在原处溶解。说明见 [docs/api.md](docs/api.md) §1.9、[indoor-bim.md](docs/agents/indoor-bim.md) §7.1。

**变更**

- 层级切换过渡改在 GPU 上做：截下当前画面和深度（画面静止时直接用超采样的画面，不读回 CPU），之后 0.45 s 内按深度重投影到飞行中的相机、叠在新画面上淡出。消失的外壳、楼层留在原处溶解，地面和 3D Tiles 不再出现错开的双影。
- `viewer.levelTransition` 的类型从 `FrameCrossfade` 换成 `LevelTransition`（高级，不从入口导出）：`duration`（毫秒，0 关闭）照旧，新增 `reproject`（默认 true；false 时整屏溶解、不跟随相机）。

**变更（破坏性）**

- 去掉盖在画布上的 `.tv-crossfade` 元素和它的样式；`FrameCrossfade.start(render)` 不再存在（过渡由 viewer 在层级切换时自己开始）。给 `.tv-crossfade` 写过样式的宿主可以删掉那段样式。

**工程**

- `post/LevelTransition.ts`（display 阶段的 `transition` 效果，排在调色之后、描边之前）、`PostPipeline.capture`；`postMath` 新增 `transitionOpacity`、`transitionGrid`、`isFarSideOfEdge`。`tests/post.test.ts`：淡出曲线、网格密度、深度边缘规则，以及在 ECEF 坐标下用 float32 重放着色器的重投影算法、与 float64 直接投影对照（误差小于 0.05 像素）。
- 过渡期间的显存（1080p 约 31 MB）计入 `viewer.memory.framebuffers`，结束即释放。

### 静止超采样、静止后停画与调色（2026-11-18，路线图 §0.2 P3.3）

画面静止后自动抗锯齿，画完就不再画帧；新增曝光、对比度、饱和度调节。说明见 [docs/api.md](docs/api.md) §1.8、§1.9。

**新增**

- 静止超采样（默认开）：画面安静 1 秒后，接下来 16 帧（有 MSAA）或 32 帧（没有 MSAA）把相机错开亚像素再画并平均，长斜边、细线、描边边缘明显平滑。`GeoViewerOptions.supersampling`（`boolean` 或 `{ enabled, samples }`）、`viewer.supersampling`（`Supersampling`：`enabled`、`samples` 4–64、只读 `sampleCount` / `converged`、`set`），类型 `SupersamplingOptions`。
- `viewer.colorGrading`（`ColorGrading`：`exposure` 0.1–4、`contrast` 0–2、`saturation` 0–2，`set` / `reset` / `options`）与 `GeoViewerOptions.colorGrading`；预设 `COLOR_GRADING_PRESETS`（`neutral`、`vivid`：对比度 1.05、饱和度 1.1），类型 `ColorGradingOptions`。默认中性，不增加开销。
- `viewer.stats.still`（画面已超采样完、不再重画）、`stats.samples`（屏幕上的画面平均了几帧）。
- 演示应用："场景"面板的"静止超采样""鲜明调色"开关；状态栏显示"超采样 n/N"和"已静止"；URL 参数 `?ss=0|1`、`?ssSamples=4–64`、`?grade=neutral|vivid`。

**变更**

- 超采样画完后 viewer **不再画帧**，直到有变化（状态仍按 `idleFrameRate` 每秒更新 10 次）：实测静止时 CPU 地球 14% → 6.9%、建筑场景 27% → 7.9%（相对原来的每秒 10 帧），GPU 基本空闲。关掉超采样时仍是原来的每秒 10 帧。
- **绕过 SDK 直接改 three 对象（`viewer.scene` 里的对象、材质、`renderer` 设置）后必须调用 `requestRender()`**：画面静止后，不调用的话改动要等下一次别的变化才出现（原来最多晚 100 ms）。场景里有自己逐帧动画的宿主，每帧调用 `requestRender()` 或设 `idleFrameRate: 0`（0 时不做超采样）。
- 容器上的指针、滚轮、键盘输入和手势开始只让 viewer 全帧率更新，不再算作画面变化：鼠标在静止画面上移动不会丢掉超采样结果；输入引起的相机运动、悬停、选中照常算变化。
- `stats.fps` 是每秒实际画的帧数，静止时为 0；`frame` 事件在每次状态更新后触发，静止时也触发（不画帧，`stats.still` 为 true）。
- `captureFrame()` / `navigation.screenshot()` 在画面已超采样且之后没有变化时直接输出超采样的画面。
- 动画帧停顿 2 秒以上后恢复（切回标签页、睡眠唤醒）时重画一次。
- 每帧额外检测：注记淡入淡出、地球影像淡入与地形渐变、3D Tiles 细节层级淡入淡出和自适应误差变化、相机矩阵、画布尺寸、`viewer.date`、色调映射与曝光、瓦片调试开关；这些变化都让画面回到实时。
- 超采样的历史缓冲（画布大小 × 8 字节，1080p 约 16 MB）计入 `viewer.memory.framebuffers`，第一次超采样时分配，关掉时释放。

**工程**

- `post/Supersampling.ts`、`post/ColorGrading.ts`，`PostPipeline.renderSample` / `present` / `samples`；`framePacing` 的 `FramePacer` 改为 `markChange` / `markWake` / `isStill` / `shouldTick` / `ticked`，新增 `drawMode`；`tests/framePacing.test.ts`（变化与唤醒、静止判定、超采样期间全帧率、绘制方式）、`tests/post.test.ts`（Halton、抖动范围与分布、混合权重等于平均、样本数、调色范围与预设）。打包宿主冒烟检查左侧 viewer 超采样完后静止、每秒不画帧、`requestRender()` 后恢复。

### 后期管线、描边与发光（2026-11-17，路线图 §0.2 P3.1、P3.2）

选中、悬停和告警改用描边与发光表示；所有帧经过一条可扩展的后期管线。说明见 [docs/api.md](docs/api.md) §1.9、[indoor-bim.md](docs/agents/indoor-bim.md) §5.5。

**新增**

- `entity.effects` / `entity.setEffects({ outline, glow, glowColor })`、`EntitySet.setEffects`：实体的描边样式和发光（0..1），覆盖实体和它下面正在显示的内容；合批设备只描自己的实例。
- `viewer.effects`（`ViewerEffects`）：`set(object, effects)` / `get` / `clear` 给 three.js 对象设描边和发光；`defineOutline(name, { color, hiddenColor, fill, pulse })` 定义样式（内置 `select`、`hover`、`alarm`，导出为 `BUILTIN_OUTLINES`）；`outlineWidth`（CSS 像素，1–6）、`glowStrength`、`glowRadius`。导出类型 `ObjectEffects`、`OutlineStyle`。
- `indoor.selectOutline` / `indoor.hoverOutline`：选中、悬停用的描边样式（默认 `'select'` / `'hover'`，null 关闭）。
- 高级：`viewer.postProcessing`（`PostPipeline`）与 `PostEffect`、`PostFrame`、`PostInputs`、`PostStage`：自定义后期效果（色调映射前 / 后两段、按序、按需 MRT 附件）。
- 演示应用：状态为"告警…"的设备显示告警描边和发光（"室内 / BIM"面板可关），描边宽度滑块。

**变更（破坏性）**

- 选中、悬停不再设置实体的 `emissive` 样式（原来是 `#1d4ed8` / `#0f2f66`），改为描边；实体材质和合批实例属性保持不变。依赖选中后自发光颜色的宿主改用 `indoor.selectOutline` 或 `viewer.effects.defineOutline('select', …)`。
- `viewer.stats.drawCalls` / `triangles` 只算场景 pass（原来含输出 pass），不含后期和拾取。

**变更**

- 每帧经后期管线渲染：场景画进 viewer 自己的 HDR 目标（取代渲染器自带的那张，格式相同），没有效果时开销与原来一致；截图和层级切换截帧同样经过它。
- 描边、发光的渲染目标计入 `viewer.memory.framebuffers`（只在使用时分配）。
- WebGL 后端不再开 GPU 计时查询（从来没有读，`info.timestampQuery` 本来就是 false）。

**工程**

- `src/post/`（`PostPipeline`、`EffectMarks`、`OutlineEffect`、`GlowEffect`、`ViewerEffects`、`postMath`）与 `tests/post.test.ts`（效果排序与图键、附件、样式与闪烁、边缘采样、对象与实体的效果、选中 / 悬停描边、合批实例、移除建筑）；`tests/batching.test.ts` 的选中 / 悬停用例改为验证描边。

### 3D Tiles 要素拾取、属性查询与高亮（2026-11-17，路线图 §0.2 P2.3）

点到 3D Tiles 上的某栋楼、某个构件时，可以拿到它的要素编号和属性，并把它高亮出来。说明见 [docs/api.md](docs/api.md) §3.3、[tile-loading.md](docs/agents/tile-loading.md) §7.1。

**新增**

- `event.tileFeature()`（`viewer.interaction` 的事件）和 `viewer.pickTileFeature(clientX, clientY)`：指针下的要素 `TileFeature`（`layer`、`id`、`table`、`properties`、`point`、`object`），没有时为 null。要素编号来自 `EXT_mesh_features`（要素编号属性、隐式编号）、b3dm 的批量编号或 i3dm 的实例；属性来自 `EXT_structural_metadata` 的属性表或批量表。`tileFeature()` 第一次调用时才发一条 CPU 射线，悬停不调用就没有开销。WebGPU、WebGL 都可用。
- `viewer.highlightTileFeature(feature, { color, opacity })` / `viewer.highlightedTileFeature`：在拾取到的瓦片上半透明地叠一层该要素的三角形（默认 `#ffd23f`、50 %），不改瓦片材质；瓦片卸载、换细节层级或移除图层时清除。
- 导出类型 `TileFeature`、`FeatureHighlightStyle`；`PickInfo.tileFeature`（可选，宿主自己构造的拾取可以不带）。
- 演示应用：单击 3D Tiles 要素弹出属性并高亮。

**变更**

- 3D Tiles 的 glTF 现在解析 `EXT_mesh_features` / `EXT_structural_metadata`（原来关闭）。只读属性和属性表；要素编号纹理、属性纹理不读（库读纹理要自建 WebGL 渲染器），所以用纹理存要素编号的数据集拾取不到要素。属性表等元数据占少量内存。

**工程**

- `tiles3d/tileFeatures.ts` 与 `tests/tileFeatures.test.ts`（编号来源、最近顶点、空编号、属性表与批量表、量化与交错坐标的复制、叠加网格不挡射线、图层随瓦片释放清除高亮、事件上的懒解析）。

### 楼层模型按需加载与显存预算（2026-11-17，路线图 §0.2 P2.2）

原来 `indoor.add()` 时把所有楼层和设备的 glTF 一次加载完，楼多、层多时一打开就下载、上传全部模型，而且一直占着显存。现在楼层第一次显示时才加载它的模型，隐藏楼层的模型超过预算时卸载。说明见 [indoor-bim.md](docs/agents/indoor-bim.md) §5.4。

**新增**

- `indoor.lazyModels`（默认 true）、`BuildingOptions.lazyModels`；`indoor.modelBytesTarget` / `indoor.modelUnloadDelayMs`（按显存档位给：`low` 64 MB / 5 s，`medium` 128 MB / 10 s，`high` 256 MB / 10 s，`ultra` 512 MB / 20 s）；读数 `indoor.modelBytes`、`building.modelBytes`。
- `viewer.memory.buildings`（已加载的建筑 glTF 模型），并计入 `gpuTotal`；`viewer.gpu.indoor`（类型 `IndoorQuality`）。
- 演示应用：状态栏显示建筑模型的显存（1 MB 以上时）。

**变更**

- 楼层模型（`floor.model`）和设备模型（`thing.model`）在楼层第一次显示，或 `building.modelsLoaded(entity)` 要用到时才加载；外壳模型仍随建筑加载。刚 `add()` 完时房间、设备上还没有模型网格。要恢复原来的行为：在 `add()` 之前设 `indoor.lazyModels = false`。
- `building.modelsLoaded(entity)` 会先开始加载该实体用到的模型再等待（它下面的楼层、它所在楼层、它的设备和外壳），可以用来预加载；房间、设备现在也会等所在楼层的整层模型。
- 所有建筑的模型超过 `modelBytesTarget` 时，隐藏了至少 `modelUnloadDelayMs` 的楼层模型按最近显示的先后卸载，再显示时重新加载；显示着的楼层不卸载。
- `viewer.memory.gpuTotal` 多了建筑模型一项，有模型的场景读数会变大。

**修复**

- 移除建筑时没有释放模型的纹理（只释放了几何和材质）。
- 建筑移除后才加载完的模型仍被挂到已移除的建筑上，占着显存。

**工程**

- `indoor/modelBudget.ts`（卸载规则 `modelsToUnload`、字节估算、释放，纯函数）与 `tests/models.test.ts`；`tests/gpuProfile.test.ts` 补建筑模型预算。

### 降帧收尾：从代码做的改动立即恢复全帧率（2026-11-14，路线图 §0.2 P2.1a"收尾"）

原来从代码改实体样式、显隐，改云层、图层属性时，viewer 不知道画面变了：改动要等下一个安静帧（最多 100 ms）才出现，之后的收尾（顶牌重新放置、遮挡判定、剔除）也按每秒 10 帧慢慢走。

**变更**

- 经 SDK API 做的改动都会在下一个动画帧恢复全帧率：实体的 `setStyle` / `visible` / `levelOpacity` / `refreshTransform()`、建筑模型加载完成、`indoor.showLabels` / `expandFloors`、`clouds.set()`、3D Tiles 图层的 `visible` / `heightOffset`、GeoJSON 图层的 `visible` / `setStyle` / `setLabelStyle`、叠加图层、点位图层的 `visible` / `setStyle` / `setCluster`。只有绕过 SDK 直接改 three 对象（往 `viewer.scene` 加对象等）时才需要 `requestRender()`。
- 点位顶牌分帧创建（每帧最多 200 个）没做完时保持全帧率。
- `Tiles3DLayer` 的 `change` 事件在设 `visible` / `heightOffset` 时也会触发（原来只在瓦片加载时），值没变时不触发。

**修复**

- 设备移动后调用 `refreshTransform()`，拾取缓冲没有失效（绘制数不变，签名看不出来），点击仍命中设备原来的位置。现在实体显隐和移动都会让拾取缓冲和贡献剔除失效。

**工程**

- 单测：实体改动通知（含值不变时不通知、建筑移除后不再通知）、云层 `onChange`。

### 静止时降帧（2026-11-13，路线图 §0.2 P2.1a）

画面静止时原来也按显示器刷新率每帧渲染。现在安静 1 秒后默认降到每秒 10 帧，有变化立刻恢复。实测（RTX 40 系列独显、1920×1080、静止后测 4 s）：地球 45.7% → 14.9%（CPU 时间占一个核的比例），建筑场景 80–126% → 19.7%，3000 个点位 17.7%。说明见 [docs/api.md](docs/api.md) §1.8，取值依据见路线图 P2.1a。

**新增**

- `GeoViewerOptions.idleFrameRate` / `viewer.idleFrameRate`（默认 10；0 不降帧；其他值限在 10–60）、`viewer.requestRender()`、`FrameStats.throttled`。
- 容器不在视口内（滚出去、`display: none`）时完全不画，回到视口立刻恢复。

**变更**

- 静止时 `stats.fps` 和 `frame` 事件按降下来的帧率走（约 10）。绕过 viewer 改了场景（往 `viewer.scene` 加对象、从代码改实体样式；后者见上面的"降帧收尾"）时，改动最多晚 100 ms 出现；需要立刻显示就调用 `requestRender()`。

**修复**

- 顶牌全部移除后，顶牌层仍一直报告"待放置"（没有顶牌时放置被跳过，请求标志不清除）。之前没有可见影响，降帧后会让 viewer 永远不降帧。

**工程**

- `viewer/framePacing.ts`（降帧判定、取值规范化、云层所需帧率，纯函数）与 `tests/framePacing.test.ts`。打包宿主冒烟：有 GPU 时检查安静后降到每秒不超过 15 帧、`requestRender()` 后恢复；隐藏容器后不再出帧、恢复显示后继续出帧。
- 演示应用：`?idleFps=<0, 10–60>`；状态栏在降帧时显示"节能"。

### 加载状态与错误事件（2026-11-13，路线图 §0.2 P2.4）

宿主不必再轮询地球统计或给每个图层分别挂监听，就能知道"加载完了没有""哪里出错了"。说明见 [docs/api.md](docs/api.md) §1.6、§1.7。

**新增**

- `viewer.events` 的 `error`（`ViewerError`：`source` 为 `imagery` / `terrain` / `tileset` / `geojson` / `points`，`error`，图层的失败带 `layer`）。原来影像出错只能经高级 API `globe.onImageryError` 拿到，地形出错只有控制台告警。
- `viewer.loadState`（`LoadState`：`globe`、`tilesets`、`layers`、`pending`、`idle`），事件 `load-progress`（每帧最多一次）和 `idle`（加载完成时；每轮加载结束都会再触发）。
- 错误码 `terrain-unreachable`（地形瓦片累计 3 次构建失败，每个地形源报告一次；`globe.terrainError`）和 `tileset-load-failed`（3D Tiles 根 tileset 加载失败）。
- `Tiles3DLayer.error`（失败消息）、`Tiles3DLayer.pending`（排队、下载、解析中的瓦片数）。
- 导出类型 `LoadState`、`ViewerError`、`ViewerErrorSource`。

**变更**

- `Tiles3DLayer` 的 `error` 事件增加 `error` 字段（`TerraViewError`，code `tileset-load-failed`，`details.url` / `details.reason`，原始错误在 `cause`），与 GeoJSON、点位图层一致；同一图层只报告一次（原来根 tileset 加载前的每次失败都会触发）。

**工程**

- `tests/loadState.test.ts`：加载状态的汇总与事件时机。打包宿主（`scripts/host-fixture`）监听 `idle` 和 `error`，冒烟测试检查有 GPU 时两个 viewer 都报告 `idle`、全程没有 `error`。
- 演示应用：影像、地形出错改用 `viewer.events` 的 `error`；状态栏的加载指示改用 `viewer.loadState`。

### 公共 API 分级（2026-11-13，路线图 §0.2 P1.1）

导出和公开成员分成稳定 / 高级 / 内部三级，规则见 [docs/api.md](docs/api.md) §2，每项的级别见 §3。

**新增**

- `viewer.highlightedFeature`：`highlightFeature` 设的要素（`{ layerId, featureId }`，没有时为 null），取代原来读 `viewer.vectors.highlighted` 的写法。
- 高级 API 在源码和类型声明里标 `@advanced`：`viewer.renderer` / `scene` / `camera` / `globe` / `pickBuffer` / `levelTransition`、`Globe`、`PickBuffer`、相机数学、GPU 档位函数、`createCard`、点位纯函数、瓦片调试开关。

**破坏性变更**

- 从包入口移除（改为内部）：`geoidUndulation`、`FrameCrossfade`、`decodeImage`、`isQuantizedMesh`、`WebMercatorTilingScheme`、`MERCATOR_MAX_LATITUDE`、`GeoRect`、`greenwichMeanSiderealTime`、`buildClusterTree`、`clusterLeaves`、`ClusterSelector`、`ClusterTree`、`ClusterTreeInput`、`ClusterTreeOptions`、`ClusterView`、`createClusterCard`、`setClusterCount`。去掉 `geoidUndulation` 后，主入口不再带 EGM96 网格：`dist/terraview.js` 从 673.5 KB（gzip 250.8）降到 500.6 KB（gzip 154.8）；瓦片 Worker 照旧内嵌自己那份。
- 以下成员从类型声明里去掉（`@internal`，运行时仍在，随时可能变）：`viewer` 的 `stars`、`sunLight`、`skyLight`、`labels`、`vectors`、`markerOcclusion`、`backdrop`、`pickReferenceSurface`；`viewer.globe` 的 `group`、`scheme`、`surfaceSignature`、`setOverlaySource`、`update`、`releaseHidden`、`sampleHeight`、`raycast`、`dispose`；`viewer.indoor.culling` 的 `update`、`forget`；`Marker` 原来已标 `@internal` 的放置与测量方法（`measure`、`place`、`cull`、`hide` 等）。

**工程**

- 类型声明构建开 `stripInternal`：标了 `@internal` 的成员不再出现在 `dist/types` 里。`build:types` 之后再用 `tsconfig.dts.json`（`skipLibCheck: false`）检查一遍发布的声明，防止公开签名引用被裁掉的声明（宿主工程开着 `skipLibCheck`，原来发现不了），再用 `scripts/check-dts.mjs` 比对入口在 `src/index.ts` 和 `dist/types/index.d.ts` 里的导出名（前导注释里出现内部标记的字样，`stripInternal` 会把整条导出裁掉，声明仍然合法）。
- `check:package` 里宿主工程的类型检查或构建失败时，打印 tsc / vite 的输出（原来只有 "Command failed"）。
- 演示应用改用 `viewer.highlightedFeature`。

### 浏览器冒烟测试（2026-11-12，路线图 §0.2 P1.5）

只涉及开发与 CI，包的内容不变。

**工程**

- 新增开发依赖 `@playwright/test`（1.65.0）。`npm run smoke:build` 构建库、演示应用和打包后的宿主工程，`npm run smoke` 在浏览器里冒烟：演示应用（瓦片就绪、建筑层级逐级进出与事件顺序、销毁）和打包宿主（两个 viewer、逐个销毁、Worker 归零、只有一份 three、顶牌留在容器内），WebGL / WebGPU 各一遍；外部影像与地形请求由本地替身瓦片应答，不依赖外网。本机用已装的 Chrome；CI 在无 GPU 的 Chromium 里跑，WebGL / WebGPU 都走 SwiftShader。
- `scripts/check-package.mjs` 新增 `--keep-host <dir>`：保留宿主工程的构建产物，供冒烟测试使用；宿主工程支持 `?webgl`。
- 2026-11-13 修正 CI 首跑的超时：宿主测试要求地球加载队列完全排空，软件渲染下 2 核 runner 150 s 内做不到。现在测试先问浏览器是不是软件渲染，是的话只等屏幕上的瓦片都有自己的影像，有 GPU 时仍要求排空；两个 viewer 同时等。`SMOKE_NO_GPU=1` 不再用 `--disable-gpu`（它让 WebGPU 拿不到适配器），改为 WebGL 用 `--use-angle=swiftshader`、WebGPU 用 `--use-webgpu-adapter=swiftshader`，CI 上 WebGPU 两项因此不再跳过。冒烟不再重试。CI 的打包检查和冒烟合并成一个 `package` job（共用一次安装、构建和打包宿主，构建不再重复类型检查）。

### 语言与错误（2026-11-12，路线图 §0.2 P1.2）

SDK 里写死的中文改成可选语言（默认 `zh-CN`，另有 `en`），错误改成英文消息加稳定的 `code`。说明见 [docs/api.md](docs/api.md) §1.6。

**新增**

- `GeoViewerOptions.locale`（`'zh-CN' | 'en'`，默认 `'zh-CN'`）和 `messages`（逐项改写）；`viewer.locale`、`viewer.messages`。影响 BIM 实体的自动属性名（楼层数 / Floors、面积 / Area 等）、房间顶牌的默认副标题、点位图层的默认名。
- `TerraViewError`（`code`、`details`）与 `isTerraViewError`；导出 `LocaleId`、`DEFAULT_LOCALE`、`MESSAGES`、`ViewerMessages`、`ViewerMessageOverrides`、`resolveMessages`、`LocalizedText`、`localize`、`TerraViewErrorCode`、`TerraViewErrorDetails`。
- `GeoJsonLayer`、`PointLayer` 的 `error` 事件增加 `error`（原始错误，SDK 抛出的带 `code`）。
- `BuildingOptions.messages`、`IndoorHost.messages`、`PointLayerHost.messages`（不传时为 `zh-CN`）。
- `GeoViewer.create` 先检查必填项：`container` 不是元素、`imagery` 不是影像源时立即抛 `TerraViewError`（code `option-invalid`）。原来漏传 `imagery` 的 JavaScript 宿主不会马上报错，而是之后每帧在地球更新里报错，`dispose()` 也会抛错。

**破坏性变更**

- 影像、叠加层预设的 `name` 改为 `label: LocalizedText`（`{ 'zh-CN', en }`），用 `localize(preset.label, locale)` 取显示名。
- `globe.imageryErrorMessage`（字符串）改为 `globe.imageryError`（`TerraViewError`，code `imagery-unreachable`，`details.provider` / `details.reason`）；`globe.onImageryError` 的参数从字符串改为这个错误。
- SDK 主动抛出的错误改为英文消息（原来是中文）并带 `code`：地形格式与投影、ion 资产类型、建筑重复加载、点位数据为空、GeoJSON 无法识别；建筑文档校验错误（`BuildingSchemaError`）现在也是 `TerraViewError`（code `building-invalid`，`details.path`），消息不变。
- 点位解析告警（`parsePoints(...).warnings`）改为英文。
- 天地图两个影像源的 `name` 改为英文（`Tianditu Imagery`、`Tianditu Labels`），与其他影像源一致；署名保持原文。

**修复**

- 同页多个 viewer 时，`captureFrame()`（截图）和层级切换前的截帧会用上**另一个 viewer** 的相机和大气设置：大气、注记的 uniform 是所有 viewer 共用的，帧外渲染之前没有重写。现在这两处渲染前先写回本 viewer 的值（实测：截图前 uniform 里是另一个 viewer 的相机，截图后是本 viewer 的）。

**工程**

- `tests/i18n.test.ts`：两种语言的文案齐全、改写合并、预设显示名、属性名随语言变化、错误码；并扫描 `src/`，注释以外出现中文就失败（输入字段别名、服务商署名、预设的中文显示名除外）。
- 演示应用：`demo/ui/errors.ts` 把错误码译成中文，作为宿主处理错误的示例。

### SDK 化：迁移到 TerraView（2026-11-11）

代码从 three-geo-global（`main`，提交 `be3bbbd`）迁移到本仓库，并改造成可复用的 npm 包 `terra-view`（私有，未发布）。包名：`terra-view` 在 npm 上没有注册（2026-11-11 查询）。但 npm 上已有 `terraview`（npm 官方的安全占位包，2021 年起），而 npm 自 2017 年起不允许新建的无 scope 包名去掉 `.` `-` `_` 后与已有包相同，所以首次发布 `terra-view` 有可能被拒；这一点只有真正发布时才能确认。被拒时改用带 scope 的 `@<scope>/terra-view`（scope 不受这条规则限制）。功能没有删减；下面是对使用者和开发者可见的变化，路径对应见 [AGENTS.md](AGENTS.md) §8。

**新增**

- 包入口 `src/index.ts`：`GeoViewer`、图层类、公共类型和纯工具都从 `terra-view` 导出；清单见 [docs/api.md](docs/api.md)。
- 库构建：`npm run build` 产出 `dist/terraview.js`（ES 模块）、`dist/terraview.css`、`dist/assets/*.worker-*.js` 和类型声明 `dist/types/`。`three`、`3d-tiles-renderer`（含子路径）是 peer 依赖，不打进产物。
- `GeoViewerOptions.decoderPath` / `transcoderPath`：指定 Draco、KTX2 解码器文件的位置（默认用宿主安装的 three.js 自带的那份）。
- `viewer.canvas`。
- 演示应用移到 `demo/`，通过包入口使用 SDK；`npm run build:demo` 构建到 `dist-demo/`。`npm run verify` 一次跑完 typecheck、test、两种构建。

**破坏性变更**

- **类名统一加 `tv-` 前缀**：`.viewer-canvas` → `.tv-canvas`，`.frame-crossfade` → `.tv-crossfade`，`.marker-layer` → `.tv-marker-layer`，`.marker` → `.tv-marker`，`.tg-*` → `.tv-*`；状态类 `.interactive` / `.occluded` / `.dense` / `.selected` → `.tv-interactive` / `.tv-occluded` / `.tv-dense` / `.tv-selected`。
- **CSS 变量**：顶牌不再读页面的 `--font` / `--text` / `--muted`，改为带默认值的 `--tv-font` / `--tv-text` / `--tv-muted` / `--tv-card-bg`；`--accent` → `--tv-accent`，`--size` → `--tv-size`。
- **样式要单独引入**：`import 'terra-view/style.css'`，里面只有 SDK 创建的元素（canvas、淡出层、顶牌）。
- **顶牌层相对容器定位**（原来是 `position: fixed` 铺满窗口）：viewer 不铺满窗口时顶牌位置正确。`GeoViewer` 给容器加 `tv-viewer` 类，容器是 `static` 定位时改成 `relative`，没有 `tabindex` 时设为 `-1`，`dispose()` 时恢复。
- **相机键盘不再监听 `window`**：改为监听 viewer 容器，只在 viewer 有焦点时生效；焦点离开时释放按住的键；带 Ctrl / Meta / Alt 的组合键不处理；处理了的按键会 `preventDefault`（方向键不再滚动宿主页面）。演示应用启动时自动聚焦 canvas。
- 示例数据 `createDemoBuilding`、`POINT_DEMOS` 不在包里（在 `demo/data/`）。

**许可证**

- 采用 Apache-2.0（2026-11-11）：新增 `LICENSE`，`package.json` 的 `license` 改为 `Apache-2.0`，`check:package` 检查 tarball 里有 `LICENSE`。移植代码的声明仍在 `THIRD_PARTY_NOTICES.md`。
- `THIRD_PARTY_NOTICES.md` 补齐：CesiumJS（地球瓦片选择、地平线剔除、请求限流等改写部分，Apache-2.0）和内嵌的 EGM96 网格（NGA 数据，经 `egm96-universal` 生成，MIT）。`package-lock.json` 的 `license` 同步为 `Apache-2.0`。

**工程**

- GitHub Actions：`ci.yml`（每次推送和 PR：typecheck、单测、库构建与类型声明、演示构建，Node 22 / 24；再把打出的包装进宿主工程检查）和 `release.yml`（推送标签 `v<版本>`：GitHub Release 附 tgz，`package.json` 不再是 `private` 时发布到 npm）。
- `npm run check:package`（`scripts/check-package.mjs`）：检查 tarball 的内容（入口、样式、Worker、类型声明都在，源码和演示不在，three 没被打进去），再装进 `scripts/host-fixture` 的宿主工程做类型检查和构建。
- 包体积预算：`check:package` 检查入口、样式和每个 Worker 的原始大小与 gzip 大小，超出预算时失败；CI 上把体积表写进运行摘要。
- `package.json` 补 `repository`、`homepage`、`bugs`、`keywords`（npm 带 provenance 发布时要核对 `repository`）。

**修复**

- 点位聚合的共享 Worker 在最后一个点位图层销毁后关闭（原来一直留着）。

**演示应用**

- 本机设置的 localStorage 键改为 `terraview:settings`，没有时读旧键 `three-geo-global:settings`，已保存的设置和密钥不丢。

**验证**

- 291 个单测（新增 `tests/keyboard.test.ts`）；`npm pack` 的 tgz 装进空的 Vite 8 工程，开发服务器和生产构建下两个并排的 viewer 都在 WebGPU 上正常运行，Worker 正常加载，页面上只有一份 three。

### 迁移前的改动（three-geo-global）

本轮按 [路线图](docs/agents/roadmap.md) 推进 M0（依赖升级）与 M1（层级与交互，借鉴 ThingJS 运行时），并修复了无地表时进入建筑的手势问题，补充了建筑数据制作手册。

### 升级

- three 0.186.1 → **0.187.0**（r187），@types/three 0.187.0，3d-tiles-renderer 0.5.3 → **0.5.4**。
- 地球瓦片材质改为 `NodeMaterialInstance`：所有瓦片共用一个节点材质（`sharedNodes().base`），逐瓦片参数仍走 `materialReference`。实例上设 `needsUpdate` 无效，改影响管线的属性（如线框）后调用 `refreshTileMaterials()`。

### 新增

- **GPU 档位与显存预算**（`core/gpuProfile.ts`、`tiles3d/lodPolicy.ts`，说明见 [gpu-memory.md](docs/agents/gpu-memory.md)）：按适配器厂商 / 架构猜测档位 `low` / `medium` / `high` / `ultra`（`ultra` 不自动选），可用 `?gpu=` 或 `GeoViewer.create({ gpuTier })` 指定；档位决定像素比上限、MSAA、地球瓦片缓存、3D Tiles 解码缓存与显存目标、纹理 mipmap / 各向异性、每帧初始化与并发上限。`viewer.gpu` 给出档位、来源和预算表，`viewer.memory` 对自己分配的资源求和（状态栏显示“显存≈N MB”）。浏览器读不到真实显存，这是估算，不是精确值。
- **3D Tiles 远处放宽与自适应误差**：斜视时远处放宽屏幕空间误差（`errorFalloff`，高空和垂直俯视时为 0）；解码缓存顶满时 `errorTarget` 整体放大（上限由档位给）、有余量后回落，状态栏显示“降精度 ×n”，不再出现局部永远停在粗层级、每帧重试上千个被拒绝瓦片的情况；瓦片纹理的各向异性在 `processTileModel` 里（上传前）设置，`low` 档关 mipmap。图层的 `errorTarget` 要改 `layer.errorTarget`，不要直接写 `layer.tiles.errorTarget`。
- **隐藏地球时释放缓存**：地球连续隐藏超过档位规定的时间后，`globe.releaseHidden` 从叶子卸载到只剩几十块（根瓦片保留），重新显示时从浏览器 HTTP 缓存重新加载。
- **贡献剔除**（M2.3，`indoor/ContributionCulling.ts`）：设备和非结构构件的包围球在屏幕上的精确投影占比低于阈值时不渲染，**默认关闭**。`viewer.indoor.culling.configure({ enabled, threshold, hysteresis, interval, selector, rules })` 或 `GeoViewer.create({ contributionCulling })` 开启和调参：阈值默认 0.5%、回差 10%、每 5 帧评估，可用选择器限定参与范围、按类别设阈值（0 = 永不剔除）。墙、楼板、柱、楼层、房间、建筑始终不参与，进入的层级和选中的实体不剔除。剔除用独立的 `entity.culled`，不改 `entity.visible`。`culling.stats` 给出参与数和剔除数。演示应用：`?cull=1` `?cullThreshold` `?cullHysteresis` `?cullInterval` `?cullSelector`，面板"远景剔除小设备"开关和阈值滑块。屏幕范围算法移植自 t3d.js（BSD-3，见 `THIRD_PARTY_NOTICES.md`）。

- **顶牌遮挡**（M2.2，`markers/occlusion.ts`、`viewer/OcclusionProxies.ts`）：`MarkerOptions.occlusion: 'none' | 'hide' | 'fade'`（默认 `none`）。顶牌锚点挂一个约 2 px 的代理，不写颜色和深度、在不透明物体之后绘制，用 three 遮挡查询判断是否被建筑、地形、3D Tiles 挡住；`hide` 隐藏且不占避让位，`fade` 加 `.marker.occluded` 淡出。不参与避让的重要顶牌（告警、建筑卡片）只淡出不隐藏。代理池固定容量 256、回收下标，裁剪或移除时归还；结果连续 2 次相同才切换。`viewer.markerOcclusion`、`markers.stats.occluded`。WebGPU、WebGL 均可用。
- **GPU 拾取缓冲**（M2.1，`viewer/PickBuffer.ts`、`viewer/pickMath.ts`）：半分辨率 `RGBA32Uint` 一次输出对象 id、实例 id（合批设备）、视空间深度和八面体法线；`setRenderObjectFunction` 换成共用一个节点图的拾取材质（地球瓦片复用形变位置节点 `tileMorphPositionNode`），场景变化且有人查询时最多每 0.25 s 重画并异步回读。交互事件的拾取先查缓冲，缓冲与当前相机和场景签名不一致（拖动、加载、层级切换后）或 WebGL 后端时退回 CPU 射线。悬停查询 0.005 ms、与设备数无关（射线 1 万设备时 1.38 ms）。`viewer.pick(ndc, { buffer: true })`，结果带 `via` 和 `normal`；`indoor.entityForHit`；`Globe.surfaceSignature`；`IndoorManager.update` 在建筑贴地移动时也返回 true。
- **设备合批与样式池**（M3.6，`indoor/InstanceBatch.ts`、`indoor/StylePool.ts`）：设备按楼层 × 几何 × 基础材质 × 渲染状态合成 `InstancedMesh`，基本形状用单位几何、尺寸进实例矩阵，glTF 设备模型每个 URL 只加载一次、每个子网格一批；颜色 / 发光 / 不透明度是实例属性，`setStyle`、层级淡化、悬停和选中高亮行为不变；`BatchMesh.entityAt(instanceId)` 映射回实体（拾取已改用它）。几何和材质按唯一键共享并计引用数，渲染状态变体是共用一次着色器构建的 `NodeMaterialInstance`，移除建筑时归零释放。1 万个设备从 10,000 次绘制、约 129 ms/帧降到 40 次、约 9 ms。`indoor.batchDevices = false` 可恢复逐设备网格。新增 `BimEntity.instances`、`refreshTransform()`、`resolveLook`。
- **自动旋转按视角选行为**（`navigation.startAutoRotate()` / `toggleAutoRotate()`、`autoRotateMode`、`autoRotate` 设置）：全球视角绕地轴自转（转速随高度等比降低）；近处地面倾斜视角绕中心点环绕；俯视时先倾斜到 -45° 再环绕；看天空或远处地平线时不可用。尺度按相机到枢轴的距离判断（`orbitMaxDistance` 200 km），可用 `filter` 否决。`GeoViewer.startAutoOrbit` 拒绝过远的枢轴；按钮条和面板按模式显示"地球自转 / 环绕浏览"。
- **开场动画**（`viewer.playIntro(options)`，`viewer/IntroAnimation.ts`）：地球向东自转若干秒、减速后停在初始视角，起始略高并随转速落定；时长、转速、减速段、起始高度可调，低于 2,000 km 的视角跳过（`force` 可强制）；任何手势或飞行立即打断。演示应用默认启动时播放，面板可关闭 / 重播，`?intro=0|1` `?introDuration` `?introSpeed` `?introZoom` 控制。
- **云层**（`viewer.clouds`，`atmosphere/CloudLayer.ts`）：影像上方的云壳，默认用 TSL 分形噪声程序生成（两层不同速度叠加、按纬度分带），也可用等距圆柱云图；向东漂移；云量、不透明度、速度、高度、淡出高度可调；开启光照时夜半球变暗；相机降到 500 km 以下淡出。演示应用默认显示，面板可调，`?clouds=0|1` `?cloudCoverage` `?cloudOpacity` `?cloudSpeed` `?cloudHeight` `?cloudTexture` 控制。
- **基础导航控制**（`viewer.navigation`，`viewer/NavigationControls.ts`，不依赖 UI）：放大、缩小、旋转、倾斜 / 俯视切换、指北、回到初始视角（`homeView`）、环绕、全屏、截图（`GeoViewer.captureFrame()`）。演示应用右下角新增按钮条（`ui/NavigationBar.ts`）。
- **控制器原语**：`zoomBy`（程序缩放，与滚轮同一套保持姿态的缩放）、`orbitBy`（程序环绕 / 倾斜，带缓动，受俯仰范围限制）、`playAnimation` / `stopAnimation` / `isAnimating`（可被手势打断的脚本动画）。`rotateHeadingAround` 改为基于 `orbitBy`。
- **选择器编译器**（`indoor/selector.ts`，纯函数）：`.type`、`#id`、`[k op v]`（`=` `!=` `>` `>=` `<` `<=`，值末尾 `*` 为前缀匹配）、存在性 `[k]`、`tags:or/and/not(...)`、`/正则/`、名称；`&&` `||` `!`、括号、相邻项为“且”、逗号为最低优先级的“或”。编译结果缓存，语法错误抛 `SelectorError`（带位置）。
- **实体集合 `EntitySet`**：`query()` 返回可链式操作的集合（`query` / `where` / `setStyle` / `visible` / `first`）。
- **实体标签与视点**：BIM 文档各级可写 `tags`（字符串数组）和 `viewpoint`（heading / pitch / range，度、米）；墙、楼板、柱自动带 `structure` 标签。
- **层级控制策略 `LevelControl`**（`indoor/LevelControl.ts`）：每一级的效果（`setEffect` / `resetEffect`）、拾取映射（`filterObject`）、取景（`viewFor`）、相机设置都由策略决定，按 `condition` 选择器和 `priority` 注册、按 `tag` 注销；内置建筑、楼层、房间 / 设备、构件四种策略。
- **层级路径切换**：`indoor.enter()` 沿最近公共祖先逐级离开、进入，每级触发 `beforeEnterLevel` / `enterLevel` / `leaveLevel`（事件带 `path`）；新的 `enter()` 取消进行中的切换；往下钻时缓存视点，返回时飞回；等待模型加载（最多 1.5 s）再取景。`enter()` 返回 `Promise<boolean>`。
- **最近对角取景**（`indoor/levelView.ts`）：从建筑的 45° / 135° / 225° / 315° 四个对角方向中选离当前航向最近的一个，按视场角归一化距离；进入楼层时兄弟楼层半透明（`levelOpacity`，与用户样式相乘）。
- **交互事件选项**：`interaction.on(type, handler, { selector, tag, priority, once })`；执行顺序为优先级 → 实体由深到浅（冒泡）→ 注册顺序；`stopPropagation()` / `stopImmediatePropagation()` / `preventDefault()`。
- **交互暂停**：`interaction.pause({ type, tag, selector, blockDefault })` / `resume(scope?)` / `paused`。按事件类型、监听标签、命中实体的选择器范围暂停（可叠加，返回值只撤销这一次）；暂停期间 `once` 不消耗，悬停恢复后补发 leave / enter；默认行为（相机双击飞近）默认照常，`blockDefault` 时一并挡住。
- **顶牌事件代理**：带 `userData.entity` 的 HTML 顶牌，单击、双击、右键单击转成 `viewer.interaction` 上对该实体的事件（`event.marker` 指向顶牌）；右键只在按下也发生在顶牌上时才转发。
- **注视飞行 `LookAtFlight`**：5 km 以内的层级跳转改为围绕注视点的短途飞行（注视点线性插值、方向球面插值、距离对数插值、零 roll），代替大弧线飞行。
- **层级切换淡出 `FrameCrossfade`**：切换时把上一帧画面盖在 canvas 上，0.45 s 淡出，避免 3D Tiles、外壳、楼层突然出现或消失。
- **展台背景 `IndoorBackdrop`**：地球隐藏且 3D Tiles 被压制时，在建筑下方铺网格地面、接触阴影和渐变天空，代替纯黑背景。
- 室内面板新增“无地表时显示展台背景”“层级切换淡入淡出”两个开关。
- **建筑数据制作手册** [docs/building-data-manual.md](docs/building-data-manual.md)（中文，面向数据人员）：坐标与高度、逐级字段表、门洞边号、房间 / 设备 / 构件类别词表、标签与顶牌样式、IFC 对照、glTF 模型、编号规则、校验错误表、自检清单、默认值表。
- 样例数据 [docs/examples/sample-office.building.json](docs/examples/sample-office.building.json)，由单测解析并构建，保证手册与代码一致。

### 变更

- 3D Tiles 的解码缓存和显存目标改按档位给：`high` 档分别为 512 / 768 MB 和 384 MB（以前是库默认的 307 / 410 MB 和 192 MB），隐藏瓦片在显存目标内保留；`high` 档的画布和地球参数与引入档位之前一致。
- BIM 文档校验更严格：门洞边号必须是范围内的整数、`at` 在 0..1、宽度为正；构件 `kind` 必须是 6 种之一，并且要有 `path`（楼板至少 3 点，其余至少 2 点）或 `position`。以前这类错误静默不显示，现在加载时报错并给出路径。
- 单击、悬停、双击的作用对象改由当前层级策略的 `filterObject` 决定（原来写死在 `GeoViewer` 里）。点击顶牌选中顶牌自己的实体。
- 地球隐藏时，建筑不再被重新贴到 0 m（`groundHeight` 返回 null，保持原高度）。
- `IndoorHost` 接口变化：`flyToSphere` / `cameraHeading` 换成 `flyToView` / `getCameraPose` / `flyToPose`，新增可选的 `beginTransition`。

### 修复

- **ISSUE-1：Google 3D Tiles 下建筑、点位埋进地面**。新增统一高程查询 `viewer.surfaceHeight(经度, 纬度, { maxCellSize })`（度；返回椭球高、来源 terrain / tiles / ellipsoid、数据分辨率、`reliable`、`held`）。地球显示时等于地形高度（`Globe.getHeight`）；地球隐藏时对可见 3D Tiles 自上而下做射线，瓦片几何误差不超过 150 m 才算可靠，结果按位置缓存，3D Tiles 被压制（进入建筑）或此处没加载时沿用缓存，不回落到 0 m。射线每帧限时 1.5 ms。建筑贴地、点位贴地、相机防入地、手势参考地面全部改用它。新增 `Globe.sampleHeight`（高度 + 网格间距）。3D Tiles 还没加载就进入了建筑（`?demo`）时，压制期间 3D Tiles 在后台继续加载、不绘制（`Tiles3DLayer.probe`），直到建筑拿到可靠高度。
- **缩放时画面抖动**：云层噪声最细的八度在全球视角下只有约 2 px 一个周期，缩放、漂移时云边闪烁。噪声改为按像素限带（`fwidth` 加权淡出过细的八度）。排查记录见 [intro-and-navigation.md](docs/agents/intro-and-navigation.md) §7。
- **无地表时手势失灵**：隐藏地球（Google 3D Tiles 会自动隐藏）后进入建筑，光标下没有可拾取的表面，控制器抓到地下约 13 km 的点，拖动 100 px 相机飞出 4000 多公里，右键只能原地转。现在落空时用参考地面（建筑地面高度的椭球，`GeoViewer.pickReferenceSurface`），防入地也以建筑地面为准。
- 展台背景的渐变量在目标值处每帧来回跳（1 ↔ 0.29），导致天空闪烁、地平线出现暗带：到达目标时夹在目标值上。

### 已知问题

- ~~ISSUE-1：Google 3D Tiles 下建筑、点位埋进地面~~：已修复（见上文“修复”）。贴地以 3D Tiles 最上层表面为准，建筑锚点正好落在倾斜摄影里的屋顶或树冠上时会贴到它上面，这种位置仍需写明 `anchor.height`。

### 文档

- 更新 AGENTS.md（版本、目录、事件规则、层级策略、新增陷阱）、README、indoor-bim.md（§5–§8、展台背景 §7.1）、camera-controller.md（参考地面、飞行类型）、roadmap.md（M0 / M1 状态、ISSUE-1、进度总览 §0.1、SDK 打包插入项 §10）、gpu-memory.md（新增）、progress-log.md（新增：改造时间线与待办）、markers.md、tile-loading.md。

### 测试

- 新增 `selector`、`interaction`、`flight`、`backdrop` 测试，扩充 `indoor` 测试（层级路径、取消、视点缓存、取景、校验、样例文档），共 149 个用例。

## [0.1.0] - 2026-11-06

首个可用原型（2026-11-04 至 11-06）。

### 地球与渲染

- WebGPU 优先（自动回退 WebGL 2），着色器全部用 TSL；ECEF 世界坐标、float64 模型视图矩阵（`highPrecision`）、逐瓦片 RTC 原点、反向 Z 深度。
- Web Mercator 四叉树地球：屏幕空间误差选级、视锥与地平线裁剪、可取消的优先级加载、LRU、父级顶替、裙边与极地补丁。
- 影像源（XYZ 预设、天地图、等经纬度图、调试格网），地形源（AWS Terrarium、Mapbox / MapTiler Terrain-RGB、Cesium World Terrain、任意 quantized-mesh），Worker 解码，EGM96 改正为椭球高。
- 栅格叠加层（天地图注记、Esri、Carto、OpenRailwayMap 等）与矢量栅格合成到每块瓦片的叠加纹理。
- 单次散射大气（Rayleigh / Mie / 臭氧）、按日期的太阳位置、昼夜着色、星空。
- **加载不闪烁**：
  - 选择记忆与“不丢细节”守卫（借鉴 CesiumJS）、象限填充、视野外兄弟预建网格；
  - 地形渐变（`startMorph`）；
  - 影像合并揭示、兄弟成组淡入；
  - 修复 TSL 纹理槽被合并导致的交叉淡入重影；
  - HTTP/1.1 影像源按域名限流；
  - 空闲时预取下一级影像到 HTTP 缓存。

### 数据图层

- OGC 3D Tiles（Draco / KTX2 / Meshopt、Cesium ion、Google），节点材质转换与 TSL dither 渐显，显存预算。
- GeoJSON 矢量：Worker 解析与按瓦片栅格化贴地，注记屏幕空间避让与遮挡，点击识别要素与属性弹窗。
- 点位标注 `viewer.addPoints`：GeoJSON 点 / 记录数组 / 点位文档，属性规则样式，自动贴地，层级聚合树（借鉴 Supercluster，可在 Worker 中构建），网格避让，8 种顶牌样式。

### 室内 / BIM

- 建筑文档格式（`*.building.json`）：建筑 → 楼层 → 房间 / 设备 / 构件，glTF 模型挂载，示例办公楼（`?demo`）。
- 双击进入、右键 / Esc 返回、单击选中、悬停高亮；HTML 顶牌（always / level / hover / click 显示模式）。

### 相机与交互

- 类 Google Earth 的相机：真实大地法线、抓地平移、右键调航向 / 俯仰、缩放到光标并保持航向俯仰、惯性、触控、键盘、大弧线飞行、环绕巡航、防入地只用可靠地形。
- 视口为零（窗口最小化）时忽略手势并恢复上一个有效位姿。
- 统一拾取与交互事件（click / dblclick / rightclick / hover）。

### 界面与工具

- 控制面板、状态栏（GPU 计时、瓦片与顶牌统计）、指南针、URL 视点分享（`#lon,lat,height,heading,pitch`）、URL 参数加载数据。
- 单元测试：测地学、裁剪、相机数学、太阳、大地水准面、地形解码、瓦片选择、矢量、点位、聚合。
- 开发规范文档：AGENTS.md 与 `docs/agents/`（相机、瓦片加载、室内、顶牌、路线图）。
