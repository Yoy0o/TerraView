# 演示应用

演示应用是建在公共 API 上的完整应用：控制面板、状态栏、属性弹窗、层级条、导航按钮条、URL 参数、文件拖放，几乎覆盖了 SDK 的全部功能。它有两个用途：

- **看效果**：不写代码，先把自己的数据（3D Tiles、GeoJSON、点位、建筑文档、高斯泼溅）拖进去看看。
- **抄写法**：每个面板背后都是几十行调用公共 API 的代码，源码在仓库的 [`demo/`](../../demo/)（面板在 [`demo/ui/`](../../demo/ui/)）。它只从 `terra-viewer` 入口引用 SDK，和你的应用处在同样的位置。

演示应用不随 npm 包发布。

## 打开

- 在线：[https://yoy0o.github.io/TerraView/demo/](https://yoy0o.github.io/TerraView/demo/)
- 本地：克隆仓库后

  ```bash
  npm install
  npm run dev          # http://localhost:5173
  ```

浏览器控制台里的 `window.viewer` 就是 `GeoViewer` 实例，可以直接试 API，例如 `viewer.flyTo({ longitude: 121.5, latitude: 31.24, height: 3000 })`。

## 操作

| 操作 | 作用 |
| --- | --- |
| 左键拖动 | 抓住地面平移，光标下的点始终跟手，松手有惯性 |
| 滚轮 / 双指捏合 | 向光标处缩放，保持当前航向和俯仰 |
| 右键、中键或 Ctrl / Shift + 左键拖动 | 横向调航向、纵向调俯仰（默认绕屏幕中心） |
| 双击 | 进入建筑 / 楼层 / 房间；不在建筑上时飞近该点 |
| 右键单击、Esc | 返回上一级（Esc 先关闭属性弹窗；在局部场景里退出局部场景） |
| 单击 | 选中建筑、房间、设备、3D Tiles 要素或矢量要素，弹出属性 |
| W A S D / 方向键、Q E、R F | 平移、转向、俯仰（viewer 有焦点时） |
| 右下角按钮条 | 放大、缩小、指北、倾斜 / 俯视、回到初始视角、自动旋转、全屏、截图 |
| 把文件拖进窗口 | 加载 `.geojson` / `.json`、`.building.json`、`*.points.json`、`.ply` / `.splat` / `.spz` |

## 面板

左侧面板按功能分组，大部分设置会保存在本机浏览器里（localStorage），下次打开仍然生效：

| 分组 | 内容 | 对应章节 |
| --- | --- | --- |
| 底图影像、叠加层 | 内置影像预设、自定义 XYZ 地址、天地图密钥；天地图注记、边界、交通等叠加层的顺序和不透明度 | [影像、叠加层与地形](./imagery-terrain.md) |
| 地形 | AWS、Mapbox、MapTiler、Cesium World Terrain、自定义 quantized-mesh，高程夸张 | 同上 |
| 场景 | 大气、太阳光照与昼夜、星空、本地时间与时间流逝、日照阴影、透明混合、静止超采样、鲜明调色 | [光照、大气、阴影与云](./environment.md)、[描边、调色与自定义对象](./effects.md) |
| 云层 | 云量、飘动、云底高度、风速、体积云 | [光照、大气、阴影与云](./environment.md) |
| 开场动画 | 打开页面时地球自转后停在初始视角，重播 | [相机与导航](./camera.md) |
| 3D Tiles | 按地址、Cesium ion 资产、Google 真实感 3D Tiles 加载；显隐、飞到、高度偏移、贴地 | [3D Tiles](./tiles3d.md) |
| 矢量、点位 | 加载 GeoJSON 和点位数据，样式、注记字段、聚合 | [GeoJSON 矢量与注记](./vector.md)、[顶牌与点位标注](./markers.md) |
| 高斯泼溅 | 开放的示例场景，位置、朝向、缩放、轴向、裁剪、绑定层级 | [高斯泼溅](./splats.md) |
| 室内 | 示例办公楼、加载建筑文档、楼层展开、层级切换、贡献剔除 | [建筑、层级与实体](./indoor.md) |
| 局部场景 | 画圆、矩形、多边形区域，侧壁、背景、区域外压暗 | [局部场景](./local-scene.md) |
| 相机、视点 | 右键旋转中心、最大倾斜、惯性、自动旋转，常用视点 | [相机与导航](./camera.md) |
| 调试 | 影像精度（屏幕空间误差）、瓦片边界、按层级着色、线框、冻结 LOD | — |

底部状态栏显示渲染后端（WebGPU / WebGL 2）、显卡和显存档位（鼠标悬停看详情）、帧率（节能、静止超采样的状态）、瓦片与加载数量、显存估算、相机高度与朝向、光标处的经纬度，以及一个指北针。

访问凭证（天地图、Cesium ion、Google、Mapbox、MapTiler）只保存在你本机的浏览器里，不会上传。

## URL 参数

在地址后面加参数可以直接打开某个状态，适合分享链接或做固定的演示：

| 参数 | 作用 |
| --- | --- |
| `?webgl` | 强制使用 WebGL 2 后端 |
| `?imagery=osm` | 底图：`esri-imagery` `osm` `esri-topo` `tianditu-img` `blue-marble` `debug`（`carto-voyager` `carto-dark` 目前不可用：Carto 改为要求 API key） |
| `?noterrain` | 启动时关闭地形 |
| `?gpu=low\|medium\|high\|ultra` | 指定显存档位 |
| `?tileset=<url>` | 加载一个 3D Tiles（tileset.json） |
| `?geojson=<url>` | 加载 GeoJSON（可重复） |
| `?points=<url>` | 加载点位：GeoJSON 点要素或带经纬度字段的记录数组（可重复） |
| `?splats=<url>` | 加载高斯泼溅；`?splatsAt=经度,纬度[,椭球高]`、`?splatsScale`、`?splatsHeading`、`?splatsUp=-y\|+y\|+z`、`?splatsMax` |
| `?demo` | 加载程序生成的示例办公楼（5 层，房间、设备、传感器、机房告警）并进入 |
| `?building=<url>` | 加载建筑文档（[建筑数据制作手册](../building-data-manual.md)） |
| `?region=circle:经度,纬度,半径km` / `rect:西,南,东,北` / `poly:经度,纬度;…` | 进入局部场景；`?regionLook=sandbox\|float\|dim` |
| `?intro=0\|1` `?introDuration` `?introSpeed` `?introZoom` | 开场动画 |
| `?clouds=0\|1` `?cloudCoverage` `?cloudOpacity` `?cloudSpeed` `?cloudHeight` `?cloudTexture=<url>` | 云壳 |
| `?cloudVolumetric=0\|1` `?cloudBase` `?cloudThickness` `?cloudWind` `?cloudWindHeading` `?cloudDensity` `?cloudShadows=0\|1` | 体积云 |
| `?shadows=0\|1` `?oit=0\|1` `?ao=0\|1` `?aoIntensity` | 日照阴影、透明顺序无关混合、楼层环境光遮蔽 |
| `?ss=0\|1` `?ssSamples=4–64` `?idleFps=0\|10–60` `?grade=neutral\|vivid` | 静止超采样、静止帧率、调色 |
| `?tileCache=0\|1` | 瓦片持久缓存（IndexedDB，跨会话、离线可用；面板"瓦片缓存"里可看用量、清空） |
| `?cull=1` `?cullThreshold` `?cullHysteresis` `?cullInterval` `?cullSelector` | 设备贡献剔除 |
| `#经度,纬度,高度,航向,俯仰` | 相机位置（浏览时自动更新，可以直接分享链接） |

几个常用组合：

- 示例办公楼：`?demo`
- 离线也能看的室内演示：`?imagery=debug&noterrain&intro=0&demo`
- 看 OSM 底图上的点位文件：`?imagery=osm&points=https://example.com/stations.points.json`
- 北京城区沙盘：`?region=circle:116.397,39.91,3`

URL 参数和本机设置都属于演示应用自己：SDK 不读 URL、不读 localStorage，你的应用要不要提供类似的参数由你决定。演示应用的解析代码在 [`demo/ui/urlOptions.ts`](../../demo/ui/urlOptions.ts)，可以参考。
