# 影像、叠加层与地形

地球的表面由三样东西组成：一张**底图影像**（必填）、任意多层半透明的**叠加层**（注记、路网等），以及可选的**地形**。这一章讲怎么选用内置的数据源、接入自己的瓦片服务、在运行时切换，以及显示署名、处理加载失败。

## 底图影像

`GeoViewer.create` 的 `imagery` 是必填项，传一个影像源（`ImageryProvider`）。最简单的是用内置预设：

```ts
import { findImageryPreset, GeoViewer } from 'terra-viewer';

const viewer = await GeoViewer.create({
  container,
  imagery: findImageryPreset('esri-imagery')!.create(),
});
```

| 预设 id | 内容 | 说明 |
| --- | --- | --- |
| `esri-imagery` | ArcGIS 卫星影像 | 免密钥，HTTP/1.1（已按域名限流） |
| `esri-topo` | ArcGIS 地形图 | 免密钥，HTTP/1.1 |
| `osm` | OpenStreetMap 标准地图 | 免密钥；OSM 官方瓦片服务器不适合大流量的生产应用，见其使用政策 |
| `carto-voyager`、`carto-dark` | Carto 浅色 / 暗色街道图 | **目前不可用**：Carto 已改为要求 API key，不带 key 的请求只返回写着 "API KEY REQUIRED" 的占位图（2026-11-25 发现，预设待更新） |
| `tianditu-img` | 天地图影像 | **需要密钥**：`create(key)` |
| `blue-marble` | NASA Blue Marble 单张全球图 | 免密钥，低清（只到第 4 级），适合做背景或离线兜底 |
| `debug` | 调试网格 | 离线，每块瓦片上写着层级和行列号 |

`IMAGERY_PRESETS` 是预设数组，可以拿来生成下拉框。预设的显示名 `label` 是多语言文本，用 `localize(preset.label, viewer.locale)` 取当前语言的名字：

```ts
import { IMAGERY_PRESETS, localize } from 'terra-viewer';

for (const p of IMAGERY_PRESETS) {
  if (p.requiresKey) continue; // 需要密钥的预设：p.requiresKey === 'tianditu'
  select.add(new Option(localize(p.label, viewer.locale), p.id));
}
```

### 天地图

天地图的影像和注记是两层：影像作底图，注记作叠加层（见下文）。密钥由你传入，SDK 不保存：

```ts
const tk = '你的天地图密钥';
const viewer = await GeoViewer.create({ container, imagery: findImageryPreset('tianditu-img')!.create(tk) });
viewer.overlays.addRaster(findOverlayPreset('tianditu-cia')!.create(tk));
```

天地图的浏览器端密钥要在天地图控制台里配置允许的域名，而且每天有请求配额，所以这两个预设关掉了"空闲时预取下一级影像"（`prefetch: false`）。

### 接入自己的 XYZ 瓦片服务

任何按 Web 墨卡托 `{z}/{x}/{y}` 切片的服务都可以用 `XYZImageryProvider` 接入：

```ts
import { XYZImageryProvider } from 'terra-viewer';

const topo = new XYZImageryProvider({
  id: 'opentopomap',
  name: 'OpenTopoMap',
  url: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
  subdomains: ['a', 'b', 'c'],
  maxZoom: 17,
  maxRequestsPerHost: 6, // 这个服务只支持 HTTP/1.1
  attribution: 'Map data © OpenStreetMap contributors, SRTM · Map style © OpenTopoMap (CC-BY-SA)',
});
```

| 选项 | 说明 |
| --- | --- |
| `url` | URL 模板。占位符：`{z}` `{x}` `{y}`；`{-y}` 是 TMS 的行号（自南向北数）；`{s}` 轮流取 `subdomains`；`params` 里的键，如 `{tk}` |
| `subdomains` | `{s}` 的取值，例如 `['a', 'b', 'c']` |
| `minZoom`、`maxZoom` | 服务提供的层级范围（默认 0、19）。超过 `maxZoom` 的层级把最深一级的瓦片放大显示 |
| `params` | 模板里其余占位符的值（会做 URL 编码），常用来放密钥 |
| `maxRequestsPerHost` | 每个域名同时最多几个请求。**HTTP/1.1 的服务要设成 6**，HTTP/2 的不要设，见下 |
| `prefetch` | 空闲时把下一级影像预先下载进浏览器的 HTTP 缓存，放大时立刻清晰（默认 true）。有请求配额的服务关掉 |
| `attribution` | 署名文字，由你的界面显示 |
| `id`、`name` | 标识和名字，用于诊断信息 |

为什么要设 `maxRequestsPerHost`：浏览器对 HTTP/1.1 的服务每个域名只开约 6 个连接，多出来的请求在浏览器里先来先服务，SDK 的"视野中心优先"就失效了，已经移出视野的请求还挡在前面，屏幕中心可能要十几秒才清晰。声明之后，排不上的请求留在 SDK 自己的优先级队列里，每帧按视野重新排序。判断协议可以在浏览器开发者工具的网络面板里打开"协议"一列。

服务返回 404（或 204）表示这块瓦片不存在，地球会用放大的上级瓦片顶替，不算错误。

WMTS 服务只要是 Web 墨卡托（`EPSG:3857` / `GoogleMapsCompatible`）的切片，就可以把 `TILEMATRIX={z}&TILEROW={y}&TILECOL={x}` 写进模板接入，天地图预设就是这样做的。经纬度切片（`EPSG:4326`）的影像服务目前不支持。

### 单张全球图、调试网格和自定义影像源

- `EquirectangularImageryProvider({ url, maxZoom, attribution })`：一张等经纬度投影的全球图（左边缘经度 -180°，上边缘北纬 90°），切成瓦片显示。适合离线、内网或低带宽场合，`blue-marble` 预设就是它。
- `DebugImageryProvider`：程序生成的网格，不联网，适合测试和排查加载问题。
- 其他来源（内网鉴权、自己解码的格式）可以实现 `ImageryProvider` 接口：`id`、`name`、`minZoom`、`maxZoom`、`attribution`，以及 `requestImage(level, x, y, signal)` 返回 `ImageBitmap`（瓦片不存在时返回 `null`），可选 `maxConcurrentRequests`、`prefetch`、`dispose`。瓦片编号是 Web 墨卡托 XYZ。要尊重 `signal`：瓦片离开视野时请求会被取消。

### 运行时换底图

```ts
viewer.globe.setImagery(findImageryPreset('osm')!.create());
```

`viewer.globe` 是高级 API。换下来的影像源会被释放（`dispose`），所以每次都传一个新建的影像源，不要把旧的再传回去。换底图时屏幕上的瓦片先保持原来的画面，新影像到达后成组淡入，不会出现空白。

## 叠加层

叠加层是画在底图之上的半透明栅格：注记、路网、行政边界、你自己的专题图层。用 `viewer.overlays`：

```ts
import { findOverlayPreset } from 'terra-viewer';

const labels = viewer.overlays.addRaster(findOverlayPreset('esri-places')!.create(), 1); // 影像源, 不透明度 0..1
viewer.overlays.setOpacity(labels, 0.6);
viewer.overlays.setVisible(labels, false);
viewer.overlays.move(labels, +1); // 上移一层（后画的在上面）
viewer.overlays.removeRaster(labels); // 同时释放它的影像源
```

| 预设 id | 内容 | 建议不透明度 |
| --- | --- | --- |
| `tianditu-cia` | 天地图影像注记（需要密钥） | 1 |
| `esri-places` | Esri 边界与地名 | 1 |
| `esri-transport` | Esri 交通路网 | 0.9 |
| `carto-labels` | Carto 地名注记（**目前不可用**，同上） | 1 |
| `openrailwaymap` | OpenRailwayMap 铁路 | 0.9 |
| `debug-overlay` | 调试网格（离线） | 0.35 |

预设的 `opacity` 字段就是建议值。叠加层可以是任何影像源，包括你自己的 `XYZImageryProvider`。

`rasterLayers` 按从下到上的顺序列出当前的叠加层。改不透明度、显隐、顺序都要经上面的方法：直接改 `layer.opacity` 不会刷新瓦片。

所有叠加层和贴地的 GeoJSON 矢量（[GeoJSON 矢量与注记](./vector.md)）一起合成为每块地球瓦片的一张纹理，叠多少层着色器都只多一次采样；代价是增删叠加层、改不透明度时屏幕上的瓦片要重新合成一遍。

## 地形

```ts
import { AWS_TERRARIUM, GeoViewer } from 'terra-viewer';

const viewer = await GeoViewer.create({ container, imagery, terrain: AWS_TERRARIUM, terrainExaggeration: 1 });
```

不给 `terrain`（或给 `null`）时地球是光滑的椭球面。内置的地形源：

| 写法 | 数据 | 说明 |
| --- | --- | --- |
| `AWS_TERRARIUM` | AWS Terrain Tiles（SRTM、GMTED2010、ETOPO1，含海底） | 免密钥，到第 15 级 |
| `mapboxTerrain(token)` | Mapbox Terrain-RGB | 需要 Mapbox 令牌 |
| `maptilerTerrain(key)` | MapTiler Terrain | 需要 MapTiler 密钥，512 px 瓦片 |
| `await cesiumIonTerrain(token, assetId = 1)` | Cesium ion 上的地形，资产 1 是 Cesium World Terrain | 需要 ion 令牌；**异步**，先取资产的访问地址 |
| `await quantizedMeshFromLayerJson(baseUrl, { headers, attribution })` | 任意 quantized-mesh 服务（`layer.json`） | **异步**；只支持 EPSG:4326 |

```ts
import { cesiumIonTerrain } from 'terra-viewer';

const terrain = await cesiumIonTerrain('你的 Cesium ion 令牌');
const viewer = await GeoViewer.create({ container, imagery, terrain });
```

地形在 Worker 里解码构网，不占主线程。高度统一是 WGS84 椭球高：海拔类的数据（AWS、Mapbox、MapTiler，`heightReference: 'msl'`）在解码时按 EGM96 大地水准面改正，quantized-mesh 本来就是椭球高（`'ellipsoid'`）。这样地形才能和 3D Tiles、GNSS 测量的数据对齐。

自建的 Terrain-RGB / Terrarium 栅格地形服务可以直接写一个 `RasterTerrainSource` 对象：

```ts
import type { RasterTerrainSource } from 'terra-viewer';

const myTerrain = {
  id: 'my-dem',
  name: '内网 DEM',
  encoding: 'mapbox', // 'terrarium' 或 'mapbox'（Terrain-RGB）
  url: 'https://tiles.example.com/dem/{z}/{x}/{y}.png',
  tileSize: 256, // 瓦片边长，像素
  maxZoom: 14,
  heightReference: 'msl', // 海拔填 'msl'，椭球高填 'ellipsoid'
  maxRequestsPerHost: 6, // 只支持 HTTP/1.1 的服务才设，HTTP/2 的不要设
  attribution: '© 某某测绘',
} satisfies RasterTerrainSource;
```

地形的 `maxRequestsPerHost` 和影像的同理（见上文"为什么要设"）：地形在 Worker 里下载，名额由主线程统一发放，同一个域名的影像和地形共用这个上限。已经开始的下载在不再需要时不会中止（中止会关掉连接，下一个请求要重新握手），下完照样进缓存。`AWS_TERRARIUM` 所在的 `s3.amazonaws.com` 只支持 HTTP/1.1，预设里已经设了 6。

### 地形夸张与运行时切换

`terrainExaggeration`（默认 1）把地形高度乘以一个倍数，适合在平原、丘陵地区突出起伏。运行时换地形源或改夸张：

```ts
viewer.globe.setTerrain(AWS_TERRARIUM, 2); // 高级 API：地形源（null = 关闭地形）, 夸张倍数
const { terrainSource, terrainExaggeration } = viewer.globe;
```

改夸张不会移动相机：在山区把夸张调大，山体可能高过相机，需要时自己 `flyTo` 到更高处。

地形是逐级细化的：一个区域刚进入视野时先用上级数据插值出的临时网格，精确网格到达后平滑过渡过去，所以山区的地面在加载过程中会有轻微的起伏变化。要查询某处地面的高度，不要读地形网格，用 `viewer.surfaceHeight(经度, 纬度)`，见[交互、拾取与事件](./interaction.md)。

## 署名

公共地图服务几乎都要求在地图上显示署名。**SDK 不在画面上画署名**，由你的界面显示。影像源和地形源都带着 `attribution` 字段：

```ts
function credits(): string {
  const parts = [viewer.globe.imageryProvider.attribution];
  for (const layer of viewer.overlays.rasterLayers) if (layer.visible) parts.push(layer.provider.attribution);
  if (viewer.globe.terrainSource) parts.push(viewer.globe.terrainSource.attribution);
  return parts.filter(Boolean).join(' · ');
}
```

（如果不想用高级 API `viewer.globe`，保存自己创建的影像源和地形源的引用即可。）3D Tiles 等数据的署名同样由你显示。

## 加载失败

| 情况 | 结果 |
| --- | --- |
| 单块瓦片 404 / 204 | 不算错误，用放大的上级瓦片顶替 |
| 底图影像累计 3 次请求失败 | `viewer.events` 发 `error`：`source: 'imagery'`，错误码 `imagery-unreachable`（每个影像源一次）。之后 `loadState.idle` 不再等它 |
| 地形瓦片累计 3 次构建失败 | `error`：`source: 'terrain'`，错误码 `terrain-unreachable`（每个地形源一次）。失败的瓦片保留原来的网格，之后退避重试 |
| `quantizedMeshFromLayerJson` / `cesiumIonTerrain` 失败 | Promise reject：`terrain-format-unsupported`（不是 quantized-mesh）、`terrain-projection-unsupported`（不是 EPSG:4326）、`ion-asset-not-terrain`（ion 资产不是地形），网络错误原样抛出 |

```ts
import { isTerraViewError } from 'terra-viewer';

viewer.events.on('error', ({ source, error }) => {
  if (isTerraViewError(error, 'imagery-unreachable')) showToast(`底图服务无法访问：${error.details.provider}`);
});
```

最常见的原因是密钥错误、域名白名单没有配置、服务不允许跨域（CORS），或者内网环境访问不到外网服务。详见[加载、错误与性能](./performance.md)。

## 加载调参

下面几个创建选项影响清晰度和流量，一般不需要改：

| 选项 | 默认 | 说明 |
| --- | --- | --- |
| `maxScreenSpaceError` | 1.25 | 一个影像像素最多占几个 CSS 像素才细化。调大更快、更省流量，但更糊 |
| `maxConcurrentLoads` | 24 | 影像同时下载的数量 |
| `maxCachedTiles` | 按显存档位 300–1000 | 缓存的瓦片数，集成显卡可以调小 |
| `fadeDuration` | 0.5 | 新影像交叉淡入的秒数，0 表示直接切换 |
| `prefetchImagery` | true | 空闲时预取下一级影像。按流量计费、移动网络时可以关掉 |

更多参数和它们的取舍见 [tile-loading.md](../agents/tile-loading.md) §8。

<ExampleFrame id="imagery-terrain" />

示例源码：[examples/imagery-terrain/main.ts](../../examples/imagery-terrain/main.ts)。
