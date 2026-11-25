# GeoJSON 矢量与注记

`viewer.addGeoJson()` 把 GeoJSON 数据画在地球上：面、线、点按地球瓦片栅格化成叠加纹理，**贴合地形**、没有 Z-fighting；名称注记在屏幕空间避让、淡入淡出，被地形挡住时隐藏。解析、投影、跨日界线展开、空间索引和栅格化都在 Worker 里做，几十 MB 的文件也不卡主线程。

## 加载

```ts
const layer = viewer.addGeoJson({
  url: '/data/districts.geojson',          // 或 data：GeoJSON 对象 / JSON 文本
  name: '行政区',
  style: { colorBy: 'type', fillOpacity: 0.4, stroke: '#ffffff' },
  label: { field: 'name' },               // false 关闭注记
});

layer.events.on('ready', (summary) => {
  console.log(summary.featureCount, summary.propertyKeys);
  viewer.flyToBBox(summary.bbox!);         // [西, 南, 东, 北]，度
});
layer.events.on('error', ({ error }) => console.warn(error.message));
```

- 来源三选一：`url`（Worker 自己下载）、`data` 传对象或 JSON 文本。两个都没有时 `addGeoJson` 直接抛错。
- 坐标按 GeoJSON 规范是 WGS84 经纬度（度）。支持全部几何类型（含 `Multi*` 和 `GeometryCollection`）；坐标里的高度不使用，所有几何都贴在地面上。
- `ready` 带上数据摘要（`LayerSummary`）：要素数、各几何类型的数量、范围 `bbox`、出现过的属性名 `propertyKeys`、实际用作注记的字段 `labelField`。
- 数据无法识别时 `error` 里是 `TerraViewError`（`code: 'geojson-invalid'`），网络错误照原样给出；`viewer.events` 的 `error` 同时收到（`source: 'geojson'`）。

图层列表是 `viewer.vectorLayers`，增删时 `viewer.events` 发 `vectors-changed`；`viewer.removeGeoJson(layer)` 移除。

## 样式

`style` 是图层级的样式（`VectorStyle`，颜色都是 CSS 颜色字符串，线宽、半径是 CSS 像素）：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `fill` / `fillOpacity` | 图层色 / 0.18 | 面的填充。不写颜色时每个图层轮流取一种默认色，便于区分 |
| `stroke` / `strokeWidth` / `strokeOpacity` | 图层色 / 1.5 / 0.95 | 线和面的边 |
| `pointColor` / `pointRadius` | 图层色 / 4 | 点画成圆点 |
| `pointStroke` / `pointStrokeWidth` | `#ffffff` / 1.25 | 圆点的描边 |
| `colorBy` | null | 按某个属性的值分类填充：数值取整后对应一组 10 色调色板（适合 Natural Earth 的 `MAPCOLOR7` 一类字段），文本按哈希取色。只影响面的填充 |
| `simplestyle` | true | 采用要素属性里的 [simplestyle-spec](https://github.com/mapbox/simplestyle-spec) 字段：`fill`、`fill-opacity`、`stroke`、`stroke-width`、`stroke-opacity`、`marker-color`、`marker-size`，逐要素覆盖图层样式 |

运行中改样式用 `layer.setStyle(部分字段)`，只重画该图层范围内的瓦片；显隐用 `layer.visible`。

```ts
layer.setStyle({ colorBy: null, fill: '#38bdf8', fillOpacity: 0.3 });
layer.visible = false;
```

逐要素的颜色写在数据里（simplestyle）最简单；按属性分段着色（如按数值渐变）目前没有内置，可以在加载前给要素写好 `fill` 属性。

## 注记

`label` 选项（`LabelStyle`）：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | true | 是否显示注记（也可以直接传 `label: false`） |
| `field` | null | 用作注记文字的属性。null 时自动选名称类字段，中文优先（`name_zh`、`NAME_ZH`、`名称`、`name`…） |
| `color` / `haloColor` | 白 / 深色半透明 | 文字和描边光晕的颜色 |
| `size` | 13 | 字号，CSS 像素 |
| `useMinZoom` | true | 数据里有 `min_label` / `min_zoom` 时按它分级显示 |

注记位置：面取极点不可达点（面内离边界最远的点），线取中点，点在圆点上方。注记互相避让：优先级取数据里的等级字段（`labelrank` / `scalerank` / `rank` 越小越优先，或 `pop_max` / `population` 越大越优先），没有时点最优先、面和线越大越优先；地平线之后、被地形挡住的不显示。改注记用 `await layer.setLabelStyle(部分字段)`，换 `field` 时会在 Worker 里重新计算位置。

## 点击查询与高亮

GeoJSON 画在地球的瓦片纹理里，交互事件只知道点到了地球（`e.kind === 'globe'`）。要知道点到了哪个要素，用 `viewer.pickFeature()`：先看注记，再在 Worker 里做点在面内、点到线的距离判断（容差 5 像素）。

```ts
viewer.interaction.on('click', async (e) => {
  const pick = await viewer.pickFeature(e.clientX, e.clientY); // 异步
  viewer.highlightFeature(pick?.hit ?? null);                   // null 取消高亮
  if (pick) showPanel(pick.layer.name, pick.hit.properties);
});
```

| `pickFeature` 的结果（`FeaturePick`） | 说明 |
| --- | --- |
| `layer` | 要素所在的图层 |
| `hit.properties` | 要素属性 |
| `hit.kind` | `'point'` / `'line'` / `'polygon'` |
| `hit.bbox` | 要素范围 `[西, 南, 东, 北]`，度，可以直接给 `flyToBBox` |
| `position` | 点击处的经纬度（弧度）和高度；点在注记上时为 null |

同一时间只高亮一个要素（`viewer.highlightedFeature` 读当前高亮的图层和要素编号）。多个图层叠在一起时，后加的图层在上面，先查到它。

## 注意事项

- **矢量是画在地球瓦片上的**：`viewer.showGlobe = false`（例如用 Google 真实感 3D Tiles 时）后，画在瓦片里的面、线、点随之不显示；它们也不会贴到 3D Tiles 或建筑表面上。要在 3D Tiles 上标注位置，用[顶牌与点位](./markers.md)。
- **点要素是栅格化的圆点**，没有 DOM，也不能单独设图标。需要图标、卡片、点击弹框、聚合时，用 `viewer.addPoints()`（[顶牌与点位标注](./markers.md)），它同样能读 GeoJSON 点。
- **线宽、点半径是屏幕像素**，缩放时保持粗细不变，不是地面上的米数。
- 与半透明栅格叠加层（`viewer.overlays`，[影像、叠加层与地形](./imagery-terrain.md)）合成在同一张叠加纹理里，着色器只多一次采样，加再多图层也不增加绘制次数。
- 国界一类的数据不是审定地图，在中国境内发布须使用有审图号的数据。
- 进入[局部场景](./local-scene.md)后，区域外的矢量和注记不显示。

<ExampleFrame id="geojson" />

示例源码：[examples/geojson/main.ts](../../examples/geojson/main.ts)。
