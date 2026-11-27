# 常见问题

按现象排列。没有找到答案时，把 `viewer.snapshot()` 的输出（后端、显卡、档位、帧统计、显存、加载状态等，纯 JSON）附在 [issue](https://github.com/Yoy0o/TerraView/issues) 里。

## 显示

### 页面上什么都没有

先看容器有没有尺寸：`GeoViewer` 铺满的是容器，容器高度为 0 时 canvas 也是 0。给容器一个明确的高度（`height: 600px`，或者让它的父元素有高度再用 `100%`）。容器尺寸之后变化会自动跟随。

其次看 `GeoViewer.create()` 有没有 reject：浏览器既不支持 WebGPU 也不支持 WebGL 2、或者必填项缺失（`code: 'option-invalid'`）时会抛错。

### 地球是灰的 / 底图不出来

- 打开开发者工具的网络面板，看影像请求是不是失败了（跨域、密钥错误、被墙、配额用完）。同一个影像源累计失败 3 次后，`viewer.events` 会发一次 `error`（`source: 'imagery'`，`code: 'imagery-unreachable'`），可以据此提示用户切换底图。
- 国内访问 ArcGIS、OSM 可能很慢：可以换天地图（需要 key，[影像、叠加层与地形](./imagery-terrain.md)）或自己部署的瓦片服务。
- 只支持 HTTP/1.1 的瓦片服务要在影像源（或地形源）上声明 `maxRequestsPerHost: 6`，否则屏幕中心的瓦片会排在长队后面。
- 用户经常回来看同一片区域、或者网络不稳定时，可以开启本机缓存 `persistentCache`，下载过的瓦片第二天和断网时直接从本机读（[影像、叠加层与地形](./imagery-terrain.md#本机缓存与离线)）。

### 画面看起来糊 / 太费显卡

画布的像素比和抗锯齿按显存档位给（`viewer.gpu.tier`：`low` / `medium` / `high` / `ultra`，按显卡自动识别）。可以在创建时用 `gpuTier`、`maxPixelRatio`、`antialias` 改。双显卡的 Windows 笔记本上，Chrome 会忽略 `powerPreference`，可能跑在集显上：状态里的 `viewer.info.adapter` 会显示实际用的显卡，需要时在系统的图形设置里给浏览器指定高性能显卡。见[加载、错误与性能](./performance.md)。

### 建筑、点位埋在地下或飘在空中

TerraView 的高度都是 WGS84 椭球高，不是海拔，两者相差几米到几十米（[基本概念](./concepts.md#椭球高与海拔)）。最省心的做法是不给高度，让它贴地：建筑锚点、点位、高斯泼溅在不给高度时都会落在地面上，地形加载后自动跟随。加载 Google 真实感 3D Tiles 这类自带地面的数据时，通常要隐藏地球（`viewer.showGlobe = false`），"地面"随之变成 3D Tiles 的表面。

### 截图是黑的

不要直接读 canvas（WebGPU 的画布在合成后就被清掉了）。用 `viewer.captureFrame()`，它返回一张画好当前画面的 canvas；等画面加载完再截，就在 `idle` 事件里调用。

## 交互

### 我改了场景里的对象，画面没有变化

画面静止后 viewer 不再重画。经 SDK API 做的改动会自动唤醒画面；绕过 SDK 直接改 three.js 对象（往 `viewer.scene` 里加网格、改它的位置或材质）后，调用 `viewer.requestRender()`。见[基本概念](./concepts.md#画面什么时候重画)。

### 我设置了相机位置，但用户一拖就乱了 / 飞行打断不了

不要直接改 `viewer.camera.position` 或 `quaternion`。用 `viewer.setView()`、`flyTo()`、`viewer.navigation` 的命令，或者 `viewer.controller.playAnimation()` 做脚本化的运动。见[相机与导航](./camera.md)。

### 键盘没有反应

相机快捷键只在 viewer 有焦点时生效（不监听 `window`，避免干扰页面上的输入框）。用户点一下地图就有焦点了；要一打开就能用键盘，调用 `viewer.canvas.focus()`。

### 点击事件拿不到点到的东西 / 拖动地图也算点击

用 `viewer.interaction.on('click', handler)`，不要自己在 canvas 上注册 `click`：前者区分了拖动和点击，并带着拾取结果（`event.kind`、`event.entity`、`event.cartographic` 等）。HTML 顶牌盖在 canvas 上，会挡住它下面的点击：实体的顶牌带上 `userData.entity` 会自动转发，其他顶牌自己处理 `onClick`。见[交互、拾取与事件](./interaction.md)。

### 弹窗打开时，双击地图还会飞走

用 `viewer.interaction.pause({ blockDefault: true })` 屏蔽交互（连同相机的双击飞近），保存它返回的函数，弹窗关闭时调用它恢复。

## 工程

### 页面上有两份 three.js / 控制台警告 "Multiple instances of Three.js"

`three` 是 peer 依赖，应该由你的工程安装一份。用 `npm ls three` 检查，所有依赖都应该解析到同一个 0.187.x。

### 部署后 Worker 或解码器 404

SDK 的 Worker 和 three.js 的 Draco / KTX2 解码器都用 `new URL(..., import.meta.url)` 引用，由打包工具输出成独立文件。部署时把构建产物目录完整上传（不要只传 `index.html` 和主 JS）。要把解码器放到 CDN 时，创建 viewer 时传 `decoderPath` / `transcoderPath`。

### 在 Vue / MobX 里用，报奇怪的 three.js 错误或者很卡

不要把 viewer、图层、实体放进响应式状态：代理会包住内部的 three.js 对象。Vue 用普通变量、`shallowRef` 或 `markRaw`。见[快速开始](./getting-started.md#在框架里使用)。

### 单页应用切换路由后内存一直涨

离开页面或卸载组件时调用 `viewer.dispose()`：它停止渲染循环，释放 GPU 资源、Worker 和事件监听，移除 canvas，恢复容器。反复创建、销毁不会泄漏（仓库的冒烟测试会检查销毁后 Worker 归零）。

### 自动化测试里等不到加载完成 / 很慢

- 等 `viewer.events` 的 `idle` 事件，不要固定等几秒。
- 没有 GPU 的环境（CI）里浏览器走 SwiftShader 软件渲染，帧率只有个位数，影像解码也慢几百倍，只适合做功能检查，不能据此判断性能。
- 浏览器标签页被遮挡或隐藏时，动画帧会被降到很低甚至暂停，加载也不推进。

### 可以在国内正式发布吗

SDK 本身没有限制。数据方面：在中国境内公开发布地图，底图、国界等数据须使用有审图号的数据，坐标系要符合相关规定；仓库演示里的国界数据不是审定地图。商用前请确认影像、地形等数据服务的许可条款。
