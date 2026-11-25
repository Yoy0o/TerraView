# 3D Tiles

OGC 3D Tiles 是倾斜摄影、城市白模、点云、BIM 轻量化成果最常见的发布格式。TerraView 用 NASA-AMMOS 的 3DTilesRendererJS 做瓦片调度，自己负责把瓦片集放到地球上、凭证、节点材质与 WebGPU 下的细节层级渐显、按显存档位的预算，以及要素拾取。支持 b3dm / i3dm / pnts / cmpt / glTF 内容、隐式分块，Draco / KTX2 / Meshopt 压缩。

## 加载

```ts
const layer = viewer.addTileset({
  source: { type: 'url', url: 'https://example.com/city/tileset.json' },
  name: '城市白模',
});

layer.events.on('ready', ({ sphere }) => viewer.flyToSphere(sphere)); // sphere：ECEF 包围球
layer.events.on('error', ({ error }) => console.warn(error.message));  // 根 tileset 加载失败
```

`addTileset` 立即返回图层（`Tiles3DLayer`），根 tileset 在后台加载：好了发 `ready`，失败发 `error`（`TerraViewError`，`code: 'tileset-load-failed'`，`details.url` / `details.reason`；`viewer.events` 的 `error` 同时收到，`source: 'tileset'`）。之后个别瓦片的失败只记日志，由库自己重试。

图层列表是 `viewer.tilesets`，增删时 `viewer.events` 发 `tilesets-changed`；`viewer.removeTileset(layer)` 移除并释放显存。

### 数据来源

| `source` | 写法 | 说明 |
| --- | --- | --- |
| 任意 URL | `{ type: 'url', url }` | 指向 `tileset.json`，服务端要允许跨域（CORS） |
| Cesium ion | `{ type: 'ion', assetId: 96188, token }` | 资产编号和访问令牌由你传入；令牌过期会自动刷新 |
| Google 真实感 3D Tiles | `{ type: 'google', apiKey }` | Google Map Tiles API 的密钥 |

凭证由宿主传入，SDK 不保存、不内置。Google 的数据覆盖全球、自带地面，加载后通常把地球隐藏，并把误差目标放宽到 20：

```ts
const google = viewer.addTileset({ source: { type: 'google', apiKey: GOOGLE_KEY }, errorTarget: 20 });
viewer.showGlobe = false; // 地面由 3D Tiles 提供；贴地、防入地会改用 3D Tiles 表面
```

地球隐藏后，`viewer.surfaceHeight`、点位和建筑的贴地、相机防入地都改用对 3D Tiles 的竖直射线（见[交互、拾取与事件](./interaction.md)）。使用 Google、Cesium ion 的数据要按服务商条款在界面上显示署名；瓦片里带的版权信息可以从 3DTilesRendererJS 的 `layer.tiles.getAttributions()` 读到（`layer.tiles` 是库自己的对象，属于高级用法）。

## 主要选项

| 选项（`Tiles3DLayerOptions`） | 说明 |
| --- | --- |
| `source` | 必填，见上表 |
| `name` | 图层名，默认从来源推断 |
| `errorTarget` | 屏幕空间误差目标，像素，默认 12。越小越精细、加载越多。实际生效值还要乘显存档位的系数，缓存满时会临时放大 |
| `errorFalloff` | 斜视时远处瓦片额外允许的误差（`errorTarget` 的倍数），默认按档位，0 关闭 |
| `heightOffset` | 沿瓦片集中心处的竖直方向整体抬高，米，默认 0 |
| `fadeDuration` | 细节层级切换时的抖动渐显，毫秒，默认 300，0 关闭 |
| `level` | 绑定到建筑层级，见下文 |

图层上可以随时改的属性：

| 属性 | 说明 |
| --- | --- |
| `visible` | 显隐 |
| `errorTarget` | 误差目标。**改这里，不要改 `layer.tiles.errorTarget`**：后者每帧会被按档位和缓存状态重新计算的值覆盖 |
| `heightOffset` | 高度偏移，米 |
| `ready` / `error` | 根 tileset 是否加载好；失败时是错误消息 |
| `pending` | 排队、下载、解析中的瓦片数 |
| `memory` | 这个图层的显存、整页共用的解码缓存及上限、被拒绝加载的瓦片数（`TilesMemoryStats`，估算值） |
| `boundingSphere` | 根 tileset 的包围球（ECEF），`ready` 之后有效 |

完整列表见 [API 参考 §3.3](../api.md#_3-3-3d-tiles)。

## 放到地形上

3D Tiles 里的高度是椭球高。数据本身做过地理配准（倾斜摄影成果通常是）就能直接对上地形；很多样例数据、从建模软件导出的白模却是从椭球面 0 m 起算的，开着地形时会埋在地下。这时按地面高度设 `heightOffset`：

```ts
import { RAD2DEG } from 'terra-viewer';

layer.events.on('ready', ({ sphere }) => {
  const c = viewer.ellipsoid.cartesianToCartographic(sphere.center)!; // 弧度
  const lon = c.longitude * RAD2DEG;
  const lat = c.latitude * RAD2DEG;

  // 地形逐级加载：等查询结果可靠（网格不粗于 30 m）再用，之后不再检查
  const off = viewer.events.on('frame', () => {
    const ground = viewer.surfaceHeight(lon, lat, { maxCellSize: 30 });
    if (!ground.reliable) return;
    off();
    layer.heightOffset = ground.height - 0; // 0：数据底面的椭球高（看 tileset.json 根节点的 region）
  });
});
```

要点：

- `viewer.surfaceHeight(经度, 纬度)` 用度，返回 `{ height, resolution, source, reliable }`；`reliable` 为 false 时数据还太粗，不要用它的高度。
- 设 `heightOffset` 后 `boundingSphere` 不跟着移动（它是根 tileset 的原始范围）。偏移较大时，飞过去用 `viewer.flyToTarget({ target: { longitude, latitude, height }, range })` 指定目标点，而不是 `flyToSphere(layer.boundingSphere)`。
- 改 `heightOffset` 会发 `moved` 事件，viewer 随之丢掉之前在它上面测得的高度缓存（地球隐藏、靠 3D Tiles 贴地时有用）。

## 要素拾取与属性

b3dm / i3dm 的批量表、`EXT_mesh_features` + `EXT_structural_metadata` 的属性表都可以按要素读：在交互事件里调用 `event.tileFeature()`，得到指针下的要素编号和属性；`viewer.highlightTileFeature()` 把它高亮。

```ts
viewer.interaction.on('click', (e) => {
  const f = e.tileFeature(); // { layer, id, table, properties, point, object } 或 null
  viewer.highlightTileFeature(f, { color: '#ffd23f', opacity: 0.6 }); // null 清除高亮
  if (f) showPanel(f.properties);
});

// 不在交互监听里时，按屏幕坐标拾取
const f = viewer.pickTileFeature(clientX, clientY);
```

| 字段（`TileFeature`） | 说明 |
| --- | --- |
| `id` | 要素编号：`EXT_mesh_features` 的编号，或 b3dm 的批次号、i3dm 的实例号。**只在一块瓦片内唯一**，不同瓦片可能重复 |
| `table` | 属性来源：属性表名，批量表为 `'batch'`，没有属性时 `null` |
| `properties` | 这个要素的属性（批量表或属性表的一行），没有时为空对象 |
| `point` | 拾取到的位置（ECEF） |

注意：

- `tileFeature()` 第一次调用时才在 CPU 上发一条射线，之后缓存；不调用就没有开销。悬停事件里也能用，但只在需要时调用。
- 不读**要素编号纹理**和属性纹理（读它们要另建一个 WebGL 上下文）。数据用纹理存要素编号时，拾取不到要素（返回 null）。
- 高亮是把该要素的三角形复制一份半透明地叠上去，不改瓦片材质；同一时间只高亮一个要素。那块瓦片被卸载或换成别的细节层级时高亮会消失（`viewer.highlightedTileFeature` 变为 null）。点云（pnts）能拾取，不能高亮。
- 批量表里的字段名、单位由数据决定。例如本章示例的数据里经纬度是弧度。

## 显存与性能

3D Tiles 往往是场景里最占显存的部分。缓存和显存预算按显存档位（`viewer.gpu.tier`）给，不需要手动设：

| 档位 | 解码缓存（整页共用） | 图层显存目标 | 误差目标系数 |
| --- | --- | --- | --- |
| `low` | 192–256 MB | 128 MB | × 1.5 |
| `medium` | 320–448 MB | 256 MB | × 1.2 |
| `high` | 512–768 MB | 384 MB | × 1 |
| `ultra` | 1024–1536 MB | 768 MB | × 0.8 |

- 视线外的瓦片在显存目标以内保留一段时间，转身回看不用重新上传；超出目标才释放。
- 斜视时远处的瓦片放宽误差（`errorFalloff`）；缓存满了整体降低精度，而不是局部停止加载、永远糊着。被拒绝的瓦片数在 `layer.memory.refused`，放大倍数在 `layer.memory.errorScale`。
- 想要更清晰就调小 `errorTarget`，想省显存和流量就调大；档位可以在创建时用 `gpuTier` 指定。细节见[加载、错误与性能](./performance.md)和 [gpu-memory.md](../agents/gpu-memory.md) §5。

## 与室内、局部场景的关系

- **进入建筑时**，没有绑定层级的 3D Tiles 默认隐藏（`viewer.indoor.hideTilesetsIndoor`，默认 true），免得倾斜摄影挡住室内。
- **层级绑定**：某栋楼自己的倾斜摄影，可以在楼外显示、进楼后隐藏：`addTileset({ source, level: { entity: 'office-a', show: 'outside' } })`；进楼也保留就用 `{ show: 'always' }`。规则见[建筑、层级与实体](./indoor.md)。
- **局部场景**可以直接用一个瓦片集的范围做区域：`viewer.localScene.enter({ region: { type: 'tileset', layer } })`，区域外的瓦片不加载（[局部场景](./local-scene.md)）。
- 开光照时 3D Tiles 接收建筑的日照阴影，并带上和地面一致的空气透视（[光照、大气、阴影与云](./environment.md)）。

<ExampleFrame id="tiles3d" />

示例源码：[examples/tiles3d/main.ts](../../examples/tiles3d/main.ts)。
