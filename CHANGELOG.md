# 更新日志

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。0.x 阶段次版本号可以有破坏性变更。`0.1.0` 是迁移前（three-geo-global）的原型，没有对外发布；`0.2.0` 是 TerraView 的首个对外版本。新的改动先记在“未发布”下。

## [未发布]

### 地球瓦片加载（2026-11-27）

- **放大时也用象限填充**（C1）：可见子瓦片里有一个已就绪就细化，缺网格的用父瓦片的象限顶替（原来只在上一帧已经细化时这样做），已就绪的子瓦片早一步画出并请求自己的影像。被填充的兄弟瓦片算作"影像未就绪"，同一块区域仍然一起变清晰。默认的 AWS 栅格地形下兄弟网格本来同时就绪，差别很小；quantized-mesh 地形收益较明显。
- **地形下载按域名限流**（C6）：地形源新增可选字段 `maxRequestsPerHost`（HTTP/1.1 的服务设 6），`AWS_TERRARIUM` 默认 6（`s3.amazonaws.com` 只支持 HTTP/1.1）；`quantizedMeshFromLayerJson` 的选项也可以给。地形在 Worker 里下载，名额由主线程从影像所用的同一个域名队列里代领，所以同一域名的影像、地形、所有 Worker 和同页所有 viewer 共用一个上限，排不上的下载留在 SDK 这边、取消即出队。这类源上已经开始的下载不再中止（中止会关闭 HTTP/1.1 连接），下完留在 Worker 缓存里；临时网格附带的精确地形预取只用空闲名额。实现见 `globe/requestSlots.ts`、`globe/terrain/terrainDownloads.ts`，说明见 docs/agents/tile-loading.md §3.1。

### 社区文件、中英双语对外文档与赞助（2026-11-26）

- **英文版对外文档**：`README.en.md`、`CONTRIBUTING.en.md`；文档站点新增英文入口 `/en/`（VitePress 多语言：首页、快速开始、0.2.0 发布说明、赞助页，侧栏链到只有中文的手册和 API 参考）。中英成对的文档清单写在 `CONTRIBUTING.md`，改一边时另一边同步。
- **社区文件**：贡献指南 `CONTRIBUTING.md`、行为准则 `CODE_OF_CONDUCT.md`（采用 Contributor Covenant 2.1，中英双语）、安全策略 `SECURITY.md`（经 GitHub 私下报告，中英双语）；`.github/ISSUE_TEMPLATE/`（问题报告、功能建议，双语表单）和 `.github/PULL_REQUEST_TEMPLATE.md`。
- **赞助**：`.github/FUNDING.yml`（仓库页的 Sponsor 按钮，指向站点赞助页）、`package.json` 的 `funding` 字段（`npm fund` 可见）、赞助页 `docs/sponsor.md` / `docs/en/sponsor.md`（微信、PayPal 收款码，企业赞助与支持），README 中英两版新增"参与贡献""赞助支持"两节和徽章。收款码图片在 `docs/images/sponsor/`。

### 使用手册、示例与文档站点（2026-11-25）

- **使用手册**（`docs/guide/`，面向接入 SDK 的开发者）：简介、快速开始（含 React / Vue 接入）、基本概念、创建与容器、相机与导航、影像与地形、3D Tiles、GeoJSON、顶牌与点位、高斯泼溅、室内与 BIM、光照与云、局部场景、描边与自定义对象、交互与拾取、加载与性能、演示应用、常见问题。
- **可运行示例**（`examples/`，16 个）：每个是独立页面，只用 `terra-viewer` 的公共 API 编写，只用免密钥的数据；清单在 `examples/catalog.ts`。`npm run examples:dev`（端口 5175）、`npm run build:examples`（`dist-examples/`，已接进 `verify` 和 CI）。
- **文档站点**（GitHub Pages，`https://yoy0o.github.io/TerraView/`）：VitePress 生成手册、API 参考、建筑数据制作手册和发布说明，`/examples/` 是示例，`/demo/` 是演示应用；`npm run site:build` 构建到 `dist-site/`，`npm run docs:dev` 本地预览。手册页里的示例点击后才在 iframe 中运行。`docs/agents/` 不发布，站点里指向它、源码或 CHANGELOG 的相对链接改写成 GitHub 上的文件。工作流 `.github/workflows/pages.yml`：推送到 main 时构建并发布，PR 只构建。
- 新增开发依赖 `vitepress` 1.6.4（经同意；只用于文档站点，不进包）。它自带 Vite 5，`npm audit` 报的 esbuild 开发服务器问题只影响本机的 `docs:dev`。
- 浏览器冒烟测试新增 `examples` 项目（`tests/e2e/examples.e2e.ts`）：示例列表齐全，每个示例都能创建 viewer、出帧、没有未捕获的错误（外部数据被拦截时也一样）。

### 已知问题

- `carto-voyager`、`carto-dark` 底图预设和 `carto-labels` 叠加层目前不可用：Carto 已改为要求 API key，不带 key 的请求只返回写着 "API KEY REQUIRED" 的占位图（HTTP 200，所以不会报 `imagery-unreachable`）。在预设更新之前请换用其他底图；处理方式待定（roadmap §9 ISSUE-2）。

### 发布流程

- `release.yml`：没有 `NPM_TOKEN` 时用 npm 的 trusted publishing（GitHub Actions OIDC，自带 provenance）发布；发布后从 registry 核对版本，`npm publish` 成功退出但版本只进了暂存区（staged，0.2.0 出现过）时让工作流失败并提示去 npmjs.com 批准；GitHub Release、npm 版本已存在时跳过，标签的运行可以安全重跑。

## [0.2.0] - 2026-11-25

TerraView 的首个对外版本：代码从 three-geo-global 迁移并改造成 npm 包 `terra-viewer`，之后补齐了嵌入所需的 API 分级、语言与错误码、加载状态、按需停画，以及后期管线、日照阴影、局部场景、高斯泼溅、层级绑定、体积云等功能。面向使用者的发布说明（功能概览、从 0.1.0 升级的破坏性变更汇总、兼容性）见 [docs/releases/v0.2.0.md](docs/releases/v0.2.0.md)；下面按专题、从新到旧列出 0.1.0 之后的全部改动。

**发布准备**（2026-11-25）

- `package.json` 的 `version` 改为 `0.2.0`（`package-lock.json` 同步），`description`、`keywords` 补上体积云、高斯泼溅。
- **包名改为 `terra-viewer`**（原 `terra-view`）：npm 不允许新建的无 scope 包名去掉 `.` `-` `_` 后与已有包相同，`terra-view` 会撞上 npm 的占位包 `terraview`。导入改为 `terra-viewer` 和 `terra-viewer/style.css`；产物文件名（`dist/terraview.js`）、类名前缀 `tv-` 不变。
- 去掉 `package.json` 的 `"private": true`，发布到 npm。
- README 重写：功能概览按子系统整理并补齐 0.1.0 之后的功能，新增接入示例（最小接入、加载状态与错误、室内、多个 viewer、释放）、文档索引，更新架构图、目录、对标表、已知限制和路线图。
- 新增发布说明 `docs/releases/v<版本>.md`；`release.yml` 创建 GitHub Release 时用它作正文（没有时退回 GitHub 自动生成的说明）。
- 包体积预算收紧到当前大小的约 110%：`terraview.css` 16 → 10 KiB（gzip 5 → 3.2），`vector.worker` 32 → 28（10 → 9.2），`clusterTree.worker` 12 → 8（5 → 3.4），`cloudNoise.worker` 10 → 8（4 → 3.4）；入口和其余 Worker 已在 110% 以内，不变。

### 单包内重构（2026-11-24，progress-log G 组）

只搬代码、不改行为：公共 API 的导出名不变（`check-dts`），发布的声明里 `GeoViewer`、`Globe` 的公开成员不变；新旧构建在浏览器里编译出的着色器逐字节相同，加载、静止超采样、拾取等行为逐项相同。

**变更**

- `viewer.date`、`viewer.timeMultiplier`、`viewer.indoorBackdrop` 从字段改为同类型的 getter / setter（读写方式不变）。
- `TileFeature` 的声明移到 `Tiles3DLayer` 旁边（仍从包入口导出，形状不变）；`CameraBounds` 移到 `core/cameraBounds`（`GlobeCameraController` 仍导出它）。
- 库构建 `terraview.js` 未压缩 +16 KiB、gzip +5 KiB（新模块的文件头和 `this.viewer.` 之类的前缀；宿主压缩后 gzip 约 +1.7 KiB），在包体积预算内。

**工程**

- `GeoViewer.ts`（2,248 行 → 约 1,080 行）拆出 `ViewerEnvironment`、`FrameLoop`、`ViewerPicking`、`ViewerLayers`、`diagnostics`、`viewerState`、`viewerTypes`、`indoorBehaviors`；`Globe.ts`（1,988 → 1,119 行）拆出 `TileLoader`、`TileContent`、`PolarCaps`；`VolumetricClouds.ts`（1,252 → 729 行）拆出节点图 `cloudNodes.ts`。部件各自声明所需的窄接口，不 import 上层。
- 目录调整：云相关文件移到 `src/clouds/`；区域数学与裁剪遮罩移到 `src/region/`（`local/` 只留局部场景本身）；`TSLNode` 类型移到 `core/tsl`。
- 新增 `npm run check:layers`（`scripts/check-layers.mjs`，接进 `verify` 和 CI）：目录间的运行时依赖只能自下而上、文件之间没有运行时循环 import；`--types` 把只导入类型的也算上做审查。分层表见 AGENTS.md §2.1。

### 体积云（近地）（2026-11-24）

相机降到约 300 km 以下时，云从覆盖全球的云壳过渡到立体的积云层：可以从地面仰望、飞进云里、从云上俯瞰，云被山体和建筑挡住，开光照时在地面、建筑和 3D Tiles 上投下随风移动的云影。思路参考 [yisky/hillaire-sky-webgpu](https://github.com/yisky/hillaire-sky-webgpu)（该仓库没有许可证，未复制代码和数据）与 Schneider 2015、Hillaire 2016。说明见 [docs/api.md](docs/api.md) §1.13，规范见 [docs/agents/volumetric-clouds.md](docs/agents/volumetric-clouds.md)。

**新增**

- `CloudOptions.volumetric`（`boolean` 或 `VolumetricCloudOptions`：`enabled`、`bottom`、`thickness`、`windSpeed`、`windHeading`、`density`、`shadows`、`fadeHeights`、`maxDistance`），`VOLUMETRIC_CLOUD_DEFAULTS`，`ResolvedCloudOptions`（`clouds.getOptions()` 的类型，含 `volumetric`）。与云壳共用 `visible`、`coverage`；天气跟随云壳的密度，从太空看到的云团处底下是成片的积云。默认按显存档位开（`low` 关）。
- 云影：开光照、太阳在地平线以上时，沿太阳光线穿过云层的透射率图乘进日照阴影的接收节点，只削弱直射阳光；地球地面、3D Tiles（含倾斜摄影）、建筑、设备、展台背景都接收。
- `GpuProfile.clouds`（`CloudQuality`：默认开关、历史像素上限、步数、朝太阳步数、云影图边长、天气图边长 `weatherSize`）。
- 演示应用："云层"下的"体积云（近地）"开关、云底高度、风速；URL 参数 `?cloudVolumetric=0|1`、`?cloudBase`、`?cloudThickness`、`?cloudWind`、`?cloudWindHeading`、`?cloudDensity`、`?cloudShadows=0|1`。

**变更**

- 天气图在 `medium` 及以上是 1024²（`low` 仍是 512²，多 3 MB 显存）：512² 时从 40–200 km 高看，云格只有约 4 个纹素，画成连在一起的圆角方块（B12）。每帧的追踪开销不变，只在天气图移动时重画（Intel Arc 集显上约 2.8 ms 一次）。
- 云壳的漂移只在云壳可见时（相机高于约 60 km）推进；近地时天气不动，体积云按自己的风移动。云壳可见时它的漂移被体积云当作风。
- 有云影时太阳平行光的 `castShadow` 也打开（即使建筑阴影关着），开关体积云云影时带光照的材质重编一次着色器。
- 有风时体积云一直在动，画面不算静止：按最近的云在屏幕上的移动速度要最低帧率（每帧 ≤ 1.5 px）；`windSpeed: 0` 时画面可以静止并做超采样。
- 包体积预算 `terraview.js` 从 800 KiB 调到 860 KiB（本次 +57 KiB 未压缩 / +17 KiB gzip，库构建保留注释）；新增 `assets/cloudNoise.worker` 预算。

**工程**

- `clouds/VolumetricClouds.ts`（linear 阶段的后期效果：天气图、云影图、半分辨率以内 2×2 交错追踪、按云距离 / 相机运动 / 风的时域重投影、按场景深度上采样的合成；全部 TSL 片元 pass，WebGPU 与 WebGL 2 相同）、`atmosphere/volumetricCloudMath.ts`（纯函数：选项、淡出、与着色器同公式的球壳求交与云层区间、步长增长、历史尺寸、天气图范围）、`atmosphere/cloudNoise.ts` + `cloudNoise.worker.ts`（可平铺的 64³ Perlin-Worley / Worley 噪声，Worker 生成，整页共享）、`lighting/cloudShadows.ts`（云影接收节点）。`CloudLayer.densityNode`（云壳密度节点，天气复用）、`AtmosphereNodes.aerialScatteringAlong`（沿给定方向和距离的空气透视）。
- 测试：`tests/volumetricClouds.test.ts`（20 项）、`tests/intro.test.ts` 补 URL 参数；冒烟新增"近地体积云、云影、销毁"（WebGL / WebGPU，硬件与软件模式都通过）。

### 层级绑定：图层挂到层级节点（2026-11-23，高斯泼溅第二期 ①）

层级树仍只有一棵（地球 → 建筑 → 楼层 → 房间 / 设备）；高斯泼溅、3D Tiles 这类图层不自成层级，而是绑定到其中一个节点上：所在层级决定它何时显示，实体自己的模型在它显示时可以让位。实体管语义（选择器、事件、顶牌、进出层级），绑定的内容管外观。规范见 [docs/agents/indoor-bim.md](docs/agents/indoor-bim.md) §6.5、[docs/agents/splats.md](docs/agents/splats.md) §7.1，API 见 [docs/api.md](docs/api.md) §1.14。

**新增**

- `viewer.indoor.bindings`（`LevelBindings`）：`bind(content, options, hooks)` / `unbind` / `get` / `of(entity)` / `all`。`LevelBindingOptions`：`entity`（实体或 id，按 id 可以早于建筑加载，建筑重载后自动接上；不写 = 地球）、`show`（`'inside'` / `'outside'` / `'current'` / `'entity'` / `'always'` 或函数；默认建筑 `'outside'`、其余 `'inside'`、不绑实体 `'current'`）、`entityOpacity`（内容显示且就绪时实体及其下级模型的不透明度；0 时看不见但仍可拾取、描边、带顶牌）。导出 `LevelBinding`、`LevelBindingHooks`、`LevelShow`、`LevelShowState`、`LevelRelation`、`LevelTree`、`LEVEL_SHOW_MODES`、`levelRelation`、`levelShown`、`defaultLevelShow`。
- `SplatLayerOptions.level`（`SplatLevelOptions`）、`layer.level` / `setLevel()` / `pickEntity`：除上面三项外，`position`（米）把图层放进实体的坐标系（建筑本地、楼层内、或相对设备），随建筑贴地、楼层展开一起移动；`follow: true` 把当前的地理位置原样转进去；`pickEntity`（默认开）让点到泼溅等于点到实体。
- 泼溅图层懒加载：`SplatLayerOptions.load`（`'eager'` / `'lazy'`，绑定了层级的默认 `'lazy'`：第一次显示时才下载）、`layer.loading`、`layer.preload()`。
- `Tiles3DLayerOptions.level`：3D Tiles 图层同样可以绑到层级（显隐和模型不透明度），例如某栋楼自己的倾斜摄影只在楼外显示，或某个图层进楼也保留。
- 建筑文档：任何元素的 `splats`（`SplatRef[]`：`uri`、`position`、`rotation`、`pitch`、`roll`、`scale`、`upAxis`、`pivot`、`show`、`entityOpacity`、`opacity`、`maxSplats`、`format`、`name`），加载建筑时建成绑定的图层，移除建筑时一并移除；`parseBuildingDoc` 校验并报出字段路径。
- 演示应用：泼溅面板的层级绑定控件（绑到哪个实体、显示时机、跟随、模型不透明度）；"点选位置"对放进实体坐标系的图层同样有效；示例办公楼的大堂里声明了一个实景（程序生成的示意数据，离线可用）。

**变更**

- 绑定了层级的图层不再看 `showIndoors` / `indoor.hideTilesetsIndoor`，由绑定规则决定；没绑定的行为不变。
- 点到绑定了层级的泼溅图层时，`SurfacePick.entity` / `PickInfo.entity` / `event.entity` 是它的实体（`kind` 仍是 `'splats'`），所以内置的悬停、选中、双击进入对泼溅同样生效。不想要时设 `level.pickEntity: false`。
- `loadState.layers` 只数正在加载的泼溅图层（懒加载、尚未开始的不算）；`viewer.snapshot().splats[]` 多了 `level`。
- `SplatLayerOptions.position` 改为可选（给了 `level.position` 时不需要）；两者都没有时仍同步抛 `option-invalid`。

**工程**

- `indoor/levelBinding.ts`：规则是纯函数（`levelRelation`、`levelShown`），注册表不认识泼溅或瓦片；在层级切换的每一步（事件触发之前）和每帧求值。`BimEntity` 多一个内部系数 `bindingOpacity`，与样式不透明度、`levelOpacity` 相乘、互不覆盖。
- 图层不依赖室内模块的实现：viewer 每帧把绑定实体的世界矩阵交给泼溅图层（`setFrame`），显隐经 `ViewerLayers.hiddenByLevel` 统一决定（泼溅和 3D Tiles 共用）；文档声明的场景经 `IndoorHost.addSplats` 回到 viewer 创建。
- 测试：`tests/levelBinding.test.ts`（14 项）；冒烟新增"绑定到层级"用例（WebGL / WebGPU），`tests/e2e/server.mjs` 多一个没有内容的 3D Tiles 数据集。
- 包体积：入口 780 → 800.4 KiB（gzip 243），超出原预算 0.4 KiB；属于有意增加，`scripts/check-package.mjs` 的入口预算调到 880（gzip 270 不变），说明记在 roadmap §0.2 P1.6。与体积云（预算 860）合并到 main 后入口 874.7 KiB（gzip 265.6），仍在 880 / 270 以内。

### 高斯泼溅（3DGS）图层（2026-11-22，路线图 M4.8）

把实拍训练出来的 3D 高斯泼溅场景放到地球上，与影像、地形、3D Tiles、建筑同屏显示，可以拾取、取景、摆放和裁剪。规范见 [docs/agents/splats.md](docs/agents/splats.md)，API 见 [docs/api.md](docs/api.md) §1.14。

**新增**

- `viewer.addSplats(options)` / `removeSplats(layer)`、`viewer.splatLayers`、事件 `splats-changed`；`SplatLayer`：`ready` / `error` / `progress` / `stats`、`placement` / `setPlacement`（经纬度、离地或椭球高、heading / pitch / roll、缩放）、`upAxis`、`visible`、`opacity`、`brightness`、`crop`（盒 / 球）、`localBounds` / `localToWorld`、`minScreenSize`、`pickable`、`boundingSphere`、`flyTo`、`raycast`、`gpuBytes`、`events`（`ready` / `error` / `progress` / `change` / `moved`）。导出类型 `SplatLayerOptions`、`SplatLayerEvents`、`SplatLayerStats`、`SplatPlacement`、`SplatHit`、`SplatCrop`、`SplatBounds`、`SplatFormat`、`SplatUpAxis`、`SplatPivot`、`SplatShDegree`、`SplatQuality`。
- 格式：`.ply`（INRIA 训练输出，0–3 阶球谐）、`.splat`、`.spz`（1–3 版 gzip，4 版 Zstandard），在 Worker 里下载和解码；按内容和文件名自动判断。
- 预算：`viewer.gpu.splats`（`maxSplats` / `maxShDegree`：50 万 / 0、150 万 / 1、300 万 / 2、600 万 / 3；WebGL 后端不超过 60 万），超出的按"不透明度 × 尺寸"舍去；`viewer.memory.splats`（计入 `gpuTotal`）、`viewer.snapshot().splats`。
- 拾取与事件：`SurfacePick.source` 和 `PickInfo.kind` 新增 `'splats'`（`SurfacePick.splats` / `splatIndex`，`PickInfo.splats`，`InteractionEvent.splats`）；相机的滚轮缩放、右键环绕能落在泼溅表面上。命中取沿射线累积不透明度达到 0.5 处，稀薄的漂浮物会被穿过。
- 加载状态与错误：未加载完的图层计入 `loadState.layers`；`ViewerErrorSource` 新增 `'splats'`；错误码 `splat-load-failed`、`splat-invalid`、`splat-format-unsupported`。
- 演示应用："高斯泼溅（3DGS）"面板（three.js 示例库的三个开放场景，CC BY 4.0；URL 与文件加载；显隐、轴向、点选位置、朝向、缩放、离地、不透明度、裁剪、取景、移除），拖入 `.ply` / `.splat` / `.spz`，URL 参数 `?splats=` `?splatsAt=` `?splatsScale=` `?splatsHeading=` `?splatsUp=` `?splatsMax=`。

**变更**

- `viewer.pick` 在拾取缓冲或射线求出表面之后，再对每个泼溅图层发一条射线（没有泼溅图层时不变）。
- 进入建筑时，泼溅图层默认随 3D Tiles 一起隐藏（`showIndoors: true` 保留）；局部场景隐藏区域外时，中心在区域外的图层隐藏。
- `MemoryReport` 多了 `splats` 字段；`GpuProfile` 多了 `splats`。
- docs/api.md §3 的小节重新编号（新增 §3.4 高斯泼溅，原 §3.4–§3.8 顺延）。

**工程**

- `src/splats/`：`splatData.ts`（数据布局、协方差、不含离群点的核心包围盒、预算、裁剪、显存估算）、`splatFormats.ts`（三种格式的解码，无 three 依赖）、`splatIndex.ts`（BVH 与沿射线累积不透明度的查询，提前终止是精确的）、`splatPlacement.ts`（轴向、枢轴、模型矩阵、屏幕尺寸与视锥测试）、`splat.worker.ts`（每次加载一个 Worker，返回后关闭）、`SplatLayer.ts`。
- 渲染用 three r187 自带的 `GaussianSplat`（addon，external）：只包一层 `colorNode`（sRGB → 线性、不透明度、亮度）；排序的深度范围取核心包围球（离群泼溅不再把计数排序的桶摊薄），视锥剔除和"屏幕上太小不画"由图层自己做；它没有 `dispose()`，图层遍历私有字段释放存储缓冲和计算管线（WebGL 后端每个存储缓冲还有一张纹理），实测两个后端移除后回到基线。
- SPZ 4 的 Zstandard 流由 Worker 发回主线程，用宿主 three 的 `three/addons/libs/zstddec.module.js` 解压：Worker 和包里都没有第三方二进制。
- 测试：`tests/splats.test.ts`（30 项：解码、预算、边界、裁剪、定位数学、拾取与暴力遍历的一致性、URL 参数）；`tests/e2e/demo.e2e.ts` 新增"高斯泼溅"用例（加载、拾取、真实单击、裁剪、移动、坏文件、移除后显存和 Worker 归零），`tests/e2e/server.mjs` 生成测试用的 `.splat`。
- `THIRD_PARTY_NOTICES.md` 增加 three.js（文件格式的实现参照其加载器，MIT）。
- 没有在真实 GPU 上量帧率（开发环境是软件渲染）；手测清单见 splats.md §10。


### 日照阴影、透明顺序无关混合（2026-11-19，路线图 §0.2 P3.6：M3.9）

打开真实光照时，建筑和设备在自身、地面、3D Tiles 上投下随时间变化的阴影；玻璃幕墙和半透明房间可以改用与绘制顺序无关的混合。说明见 [docs/api.md](docs/api.md) §1.11。

**新增**

- 日照阴影（默认按显存档位开，`low` 关；只在 `viewer.lighting = true` 且太阳在地平线以上时出现）：一张沿太阳光线的正交阴影图，每帧按"建筑包围盒 ∩ 视锥"适配范围（楼外是整栋楼和它的影子，楼里只剩相机附近，示例办公楼的纹素约 2.6–3.7 cm），中心按纹素对齐、边长分档量化，相机移动时影子边缘不抖。接收方：建筑、设备、glTF 模型、地球地面、3D Tiles（有光照的削弱直射，倾斜摄影整体变暗）、无地表时的展台背景。玻璃、窗、半透明房间不投影，阳光能照进窗户；被层级隐藏的楼层不投影。`viewer.shadows`（`SunShadows`：`enabled`、`intensity`、`softness`、`maxDistance`、`mapSize`、`configure`、只读 `active` / `texelSize` / `bytes`、`invalidate()`），`GeoViewerOptions.shadows`（`boolean` 或 `SunShadowOptions`）。
- 透明顺序无关混合（OIT，WebGPU）：建筑和设备的透明表面改用加权混合，转动视角时玻璃外壳、窗、半透明房间不再因排序变化跳变。`viewer.transparency`（`Transparency`：`orderIndependent`、只读 `supported` / `active`、`set`），`GeoViewerOptions.transparency`（`TransparencyOptions`）。默认只在 `ultra` 档位开（多两张画布大小的多重采样缓冲，1080p、4x MSAA 约 93 MB）；WebGL 后端保持按距离排序。
- `viewer.memory.shadows`（阴影图字节数，2048 图 16 MB，也计入 `gpuTotal`）；`viewer.snapshot()` 新增 `shadows` 和 `post.transparency`；`viewer.gpu` 新增 `shadows: { enabled, mapSize }`（`low` 关 1024 / `medium` 2048 / `high` 2048 / `ultra` 4096）和 `orderIndependentTransparency`。
- 演示应用："场景"里的"日照阴影"和"透明顺序无关混合（OIT）"开关；URL 参数 `?shadows=0|1`、`?oit=0|1`。

**变更**

- 建筑、设备批次和建筑 glTF 的网格默认 `castShadow` / `receiveShadow` 为 true，3D Tiles 的网格 `receiveShadow` 为 true；太阳平行光的 `castShadow` 跟随 `shadows.enabled`（开关一次让带光照的材质重编一次着色器）。

**工程**

- `lighting/shadowFit.ts`（纯函数：光源坐标系、包围盒沿光线的足迹与地面投影深度、与视锥足迹求交、纹素对齐、2^(1/4) 分档）、`lighting/SunShadows.ts`（自己的仅深度阴影图：只把建筑树当场景画，不经主场景、不碰统计；共享接收节点 `sunShadowFactor`：逐对象 float64 的"阴影矩阵 × 对象矩阵"、按 PCF 覆盖范围和受光角算的法线偏移、4×4 次硬件比较采样；无光照材质的 `unlitShadowOutputNode`）。没有用 three 的 `SunLight`（着色器里用 float32 世界坐标乘阴影矩阵，地球尺度上误差约半米）。
- `post/PostPipeline`：OIT 的场景 pass 分流、透明 pass（与场景目标共享多重采样深度）和合成；`post/Transparency.ts`。`AtmosphereNodes.applyAerialPerspective(color)`（空气透视作用于任意颜色）。
- 测试：`tests/shadows.test.ts`（光源坐标系、量化、强度随太阳高度、包围盒与地面影子的覆盖、纹素对齐与小幅移动不变、楼内收缩、超出距离 / 身后不画、深度范围随太阳高度、阴影矩阵在三种深度约定下的取值、设置范围），`tests/gpuProfile.test.ts` 补档位的阴影和 OIT 设置。

### 局部场景（沙盘模式）（2026-11-18，路线图 M4.9）

只显示地球上的一块区域，边缘一圈土层侧壁，相机围着它活动。规范见 [docs/agents/local-scene.md](docs/agents/local-scene.md)，API 见 [docs/api.md](docs/api.md) §1.12。

**新增**

- `viewer.localScene`（`LocalScene`）：`enter({ region, outside, walls, background, globe, camera, transition })`、`exit({ restoreView })`、`fit`、`set`、`contains`、`active`、`region`、`events`（`enter` / `exit`）。区域为圆、矩形、多边形（度 / 米）或 `{ type: 'tileset', layer }`，园区到城区（直径 ≤ 100 km）。区域外不绘制、不加载（`outside: 'hide'`），或压暗去饱和（`'dim'`）；侧壁（默认）或悬浮地块（`walls: false`）；展台背景、星空或纯色。导出类型 `LocalSceneOptions`、`LocalSceneRegion`、`LocalSceneWallOptions`、`LocalSceneCameraOptions`、`LocalSceneEvents`、`LocalRegion`，类 `ResolvedRegion`，常量 `MAX_REGION_DIAMETER`、`MAX_REGION_VERTICES`、`MIN_REGION_RADIUS`。
- 高级：`controller.bounds`（`CameraBounds`）：相机活动范围（视线不离开区域、最远距离、落空时的枢轴与参考地面），不开局部场景也能用。
- 演示应用："局部场景（沙盘）"面板（当前视野、画矩形 / 圆 / 多边形、外观、背景、回到总览、退出），`?region=`、`?regionLook=`，Esc 退出。

**变更**

- 局部场景中：拾取（含 GPU 拾取缓冲）不再命中区域外；`surfaceHeight` 和防入地在区域外返回侧壁底面高度；锚点在区域外的顶牌、注记、建筑隐藏；`navigation.home()` 回到区域总览；双击区域外回到总览（`interaction` 上 `tag: 'local-scene'`）。
- 地球瓦片材质多了一个共享的裁剪版本（`GlobeTileClipped`），只给跨区域边界的瓦片用；没开局部场景时不变。

### 楼层环境光遮蔽、光照跟随大气（2026-11-19，路线图 §0.2 P3.5：M3.4、M3.5）

楼层地面沿墙根、设备周围柔和变暗；打开真实光照时，建筑和 3D Tiles 的阳光颜色、天光跟着大气走，远处和地球一样有空气透视。说明见 [docs/api.md](docs/api.md) §1.10、[indoor-bim.md](docs/agents/indoor-bim.md) §5.6。

**新增**

- 楼层环境光遮蔽（默认开）：楼层第一次显示时在 GPU 上烘焙一次（俯视画出地面上立着的东西，再做两种可分离滤波），之后只是材质里多采样一张单通道贴图，不增加每帧的 pass。墙根、柜体、桌子周围的地面变暗，墙面底部随高度淡出；楼层模型、设备、墙改动后自动重新烘焙。`viewer.indoor.ambientOcclusion`（`FloorOcclusion`：`enabled`、`configure({ intensity, radius, height, texelSize, maxResolution })`、`options`、只读 `bakedFloors` / `bytes`、`bakedFor(floor)`），`GeoViewerOptions.ambientOcclusion`，类型 `FloorOcclusionOptions`、`BakedOcclusion`、`OcclusionGrid`，默认值 `FLOOR_OCCLUSION_DEFAULTS`。贴图分辨率上限按显存档位给（`viewer.gpu.indoor.aoMaxResolution`：512 / 1024 / 1024 / 2048）。
- `viewer.snapshot()`（高级）：当前的后端、帧统计、显存、加载状态、视点、地球、3D Tiles、室内（含 AO 和剔除）、后期效果和灯光，可以直接 `JSON.stringify` 附到问题报告里（路线图 M5.1 的 JSON 导出部分）。类型 `ViewerSnapshot`。
- `Tiles3DLayer` 新事件 `moved`（设了 `heightOffset`）。
- 演示应用："室内 / BIM"面板的"楼层环境光遮蔽"开关和"墙根阴影强度"滑块；URL 参数 `?ao=0|1`、`?aoIntensity=0..1`。

**变更**

- `viewer.lighting = true` 时，照亮建筑和 3D Tiles 的平行光颜色是大气在视点处（进入建筑时是建筑锚点）的太阳透射率，天光改为天空亮度和被照亮地面的二阶球谐光照探针（`LightProbe`），都由大气模型的 CPU 版算出（与着色器同一套常数和公式，浏览器实测两者相差不到 7×10⁻⁵）。正午接近白色，黄昏时朝阳的墙是橙色、背阴面是暗的蓝灰色，与地面一致；夜里保留少量补光，室内仍看得清。原来是白光乘一个昼夜系数加固定颜色的半球光。不开光照（默认的地图模式）时不变。
- 建筑（程序生成的和 glTF 模型）、设备、3D Tiles 的材质加上了与地球瓦片相同的空气透视（逐像素；100 m 以内跳过，室内没有开销）：城市尺度上远处的倾斜摄影、建筑和周围地面一起变淡。大气关闭时不做。
- 楼层、外壳和不能合批的设备的 glTF 材质在加载时转换为节点材质（渲染器原本在第一次绘制时做同样的转换）；没有节点版本的材质类型保持不变。
- `viewer.memory.buildings` 加上楼层 AO 贴图的字节数（每个纹素 1 字节，示例办公楼 5 层共 1.4 MB）。

**修复**

- 打开 Google 3D Tiles（或其他 3D Tiles）在全球视角下，远处的瓦片上每块都出现带橙色、紫色圆环的深蓝色暗斑（P3.5 引入）。远处的瓦片是粗网格，平面中部比椭球面低几十公里，空气透视原来一直积分到那个点，地下的"空气"密度按指数暴涨。现在视线最多积分到椭球面下 0.5 km（与天空着色器一样做地面求交）。
- 设了 3D Tiles 图层的 `heightOffset` 后，`viewer.surfaceHeight` 沿用的是移动前测到的高度（路线图 progress-log C11 的第二处局限）。现在图层移动时清空这些缓存。
- 加载建筑时控制台的 `THREE.BufferGeometry.toNonIndexed(): BufferGeometry is already non-indexed` 警告（外壳楼层带合并时对挤出几何调用了 `toNonIndexed`）。

**工程**

- `atmosphere/atmosphereModel.ts`（大气的 CPU 版：Chapman 近似、太阳透射率、单次散射天空、SH 投影；常数从这里给 TSL 版共用）、`atmosphere/AtmosphereLighting.ts`（太阳转过 0.1° 或视点移动 500 m 才重算，一次约 0.3–0.8 ms）、`AtmosphereNodes.aerialPerspectiveOutputNode()`（共享的 `outputNode`）。
- `indoor/FloorOcclusion.ts`：烘焙器（遮挡掩码：被近平面切开的封闭体露出背面，"背面，或高于地面的正面"算遮挡物；接触项用高斯加权最大值，薄墙也有足够的遮挡；柔和项用高斯平均）、读回成 `DataTexture`（行序自己定，不经过渲染目标的翻转规则）、调度（每次一层，改动稳定 250 ms 后重新烘焙）。网格角色 `mesh.userData.aoRole`：`'floor'`（楼板、房间地面）、`'occluder'`（窗、设备）。`Building.contentVersion(floor)` 记录楼层上的内容版本。
- 测试：`tests/atmosphere.test.ts`（与暴力积分对照的 Chapman 误差带、透射率与天空的物理性质、SH 约定、重算阈值）、`tests/floorOcclusion.test.ts`（网格、滤波权重、受光规则、读回行序、选项、调度与材质挂载）。

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

代码从 three-geo-global（`main`，提交 `be3bbbd`）迁移到本仓库，并改造成可复用的 npm 包 `terra-view`（私有，未发布）。包名：`terra-view` 在 npm 上没有注册（2026-11-11 查询）。但 npm 上已有 `terraview`（npm 官方的安全占位包，2021 年起），而 npm 自 2017 年起不允许新建的无 scope 包名去掉 `.` `-` `_` 后与已有包相同，所以首次发布 `terra-view` 有可能被拒（0.2.0 发布前因此改名为 `terra-viewer`）。功能没有删减；下面是对使用者和开发者可见的变化，路径对应见 [AGENTS.md](AGENTS.md) §8。

**新增**

- 包入口 `src/index.ts`：`GeoViewer`、图层类、公共类型和纯工具都从 `terra-viewer` 导出；清单见 [docs/api.md](docs/api.md)。
- 库构建：`npm run build` 产出 `dist/terraview.js`（ES 模块）、`dist/terraview.css`、`dist/assets/*.worker-*.js` 和类型声明 `dist/types/`。`three`、`3d-tiles-renderer`（含子路径）是 peer 依赖，不打进产物。
- `GeoViewerOptions.decoderPath` / `transcoderPath`：指定 Draco、KTX2 解码器文件的位置（默认用宿主安装的 three.js 自带的那份）。
- `viewer.canvas`。
- 演示应用移到 `demo/`，通过包入口使用 SDK；`npm run build:demo` 构建到 `dist-demo/`。`npm run verify` 一次跑完 typecheck、test、两种构建。

**破坏性变更**

- **类名统一加 `tv-` 前缀**：`.viewer-canvas` → `.tv-canvas`，`.frame-crossfade` → `.tv-crossfade`，`.marker-layer` → `.tv-marker-layer`，`.marker` → `.tv-marker`，`.tg-*` → `.tv-*`；状态类 `.interactive` / `.occluded` / `.dense` / `.selected` → `.tv-interactive` / `.tv-occluded` / `.tv-dense` / `.tv-selected`。
- **CSS 变量**：顶牌不再读页面的 `--font` / `--text` / `--muted`，改为带默认值的 `--tv-font` / `--tv-text` / `--tv-muted` / `--tv-card-bg`；`--accent` → `--tv-accent`，`--size` → `--tv-size`。
- **样式要单独引入**：`import 'terra-viewer/style.css'`，里面只有 SDK 创建的元素（canvas、淡出层、顶牌）。
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
