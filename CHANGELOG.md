# 更新日志

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。版本号尚未对外发布，`0.1.0` 是首个可用的原型；之后的改动先记在“未发布”下。

## [未发布]

### 语言与错误（2026-11-12，路线图 §0.2 P1.2）

SDK 里写死的中文改成可选语言（默认 `zh-CN`，另有 `en`），错误改成英文消息加稳定的 `code`。说明见 [docs/api.md](docs/api.md) §1.6。

**新增**

- `GeoViewerOptions.locale`（`'zh-CN' | 'en'`，默认 `'zh-CN'`）和 `messages`（逐项改写）；`viewer.locale`、`viewer.messages`。影响 BIM 实体的自动属性名（楼层数 / Floors、面积 / Area 等）、房间顶牌的默认副标题、点位图层的默认名。
- `TerraViewError`（`code`、`details`）与 `isTerraViewError`；导出 `LocaleId`、`DEFAULT_LOCALE`、`MESSAGES`、`ViewerMessages`、`ViewerMessageOverrides`、`resolveMessages`、`LocalizedText`、`localize`、`TerraViewErrorCode`、`TerraViewErrorDetails`。
- `GeoJsonLayer`、`PointLayer` 的 `error` 事件增加 `error`（原始错误，SDK 抛出的带 `code`）。
- `BuildingOptions.messages`、`IndoorHost.messages`、`PointLayerHost.messages`（不传时为 `zh-CN`）。

**破坏性变更**

- 影像、叠加层预设的 `name` 改为 `label: LocalizedText`（`{ 'zh-CN', en }`），用 `localize(preset.label, locale)` 取显示名。
- `globe.imageryErrorMessage`（字符串）改为 `globe.imageryError`（`TerraViewError`，code `imagery-unreachable`，`details.provider` / `details.reason`）；`globe.onImageryError` 的参数从字符串改为这个错误。
- SDK 主动抛出的错误改为英文消息（原来是中文）并带 `code`：地形格式与投影、ion 资产类型、建筑重复加载、点位数据为空、GeoJSON 无法识别；建筑文档校验错误（`BuildingSchemaError`）现在也是 `TerraViewError`（code `building-invalid`，`details.path`），消息不变。
- 点位解析告警（`parsePoints(...).warnings`）改为英文。
- 天地图两个影像源的 `name` 改为英文（`Tianditu Imagery`、`Tianditu Labels`），与其他影像源一致；署名保持原文。

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
