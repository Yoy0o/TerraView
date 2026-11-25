# 光照、大气、阴影与云

这一章讲画面的"天气"：地图模式和真实太阳光照、日期与时间、大气和星空、建筑的日照阴影、云壳与近地的体积云。它们都是 viewer 上的开关和设置，不需要额外加载数据。

## 地图模式与真实光照

viewer 默认是**地图模式**（`viewer.lighting = false`）：影像按原色显示，整个可见半球都是亮的，建筑和模型由相机上方的一盏"头灯"加固定的半球光照亮。看数据、做标绘时这样最清楚。

打开**真实光照**后，太阳位置按 `viewer.date` 计算：有昼夜、晨昏线、日落时的暖色，建筑投下阴影。

```ts
viewer.lighting = true;
viewer.date = new Date('2026-06-21T06:00:00Z'); // 北京时间 14:00（Date 是绝对时刻，时区自己换算）
viewer.timeMultiplier = 600;                    // 每真实秒推进 600 模拟秒；0 = 停住（默认）
```

| 属性 | 默认 | 说明 |
| --- | --- | --- |
| `lighting` | `false` | 真实太阳光照 |
| `date` | 创建时的当前时间 | 驱动太阳和星空的模拟时刻（`Date`） |
| `timeMultiplier` | 0 | 每真实秒推进多少模拟秒。不为 0 时太阳一直在动，画面不会静止（不降帧、不做静止超采样） |
| `atmosphere` | `true` | 大气散射：天空、地平线的蓝色光晕、远处地面的空气透视 |
| `showStars` | `true` | 星空（随恒星时转动，白天和低空时自动淡出） |
| `showGlobe` | `true` | 地球瓦片。隐藏后贴地查询（`viewer.surfaceHeight`）改用可见 3D Tiles 的表面。Google 真实感 3D Tiles 这类自带地面的数据通常配合隐藏地球使用（[3D Tiles](./tiles3d.md)） |
| `indoorBackdrop` | `true` | 进入建筑后周围什么都不画时显示展台背景（见下文） |

这些都可以随时改，改了画面立刻更新，不需要 `requestRender()`。也就是说，做一个"时间轴"控件只要把滑块的值换算成 `Date` 赋给 `viewer.date`：

```ts
/** 北京时间（UTC+8）某一天的 hours 时（可带小数）。 */
function beijingTime(year: number, month: number, day: number, hours: number): Date {
  return new Date(Date.UTC(year, month - 1, day) + (hours - 8) * 3600e3);
}
slider.oninput = () => (viewer.date = beijingTime(2026, 6, 21, Number(slider.value)));
```

## 光照跟随大气

开真实光照时，照亮建筑、设备和 3D Tiles 的灯光来自和地球同一套大气模型：

- **太阳光**的颜色是视点处（进入建筑时取建筑锚点）的太阳透射率：正午偏白，太阳低时偏橙，日落后为 0。
- **天光**是天空亮度加被照亮的地面反光，投影成球谐光照探针：朝上的面偏蓝，竖直的墙有地面反光。
- **夜间**保留一点半球补光，室内仍看得清。
- 建筑、设备、3D Tiles 和地球瓦片带同样的**空气透视**：城市尺度上远处的模型和周围地面一起变淡（按 `viewer.atmosphere` 开关，100 m 以内不计算，室内没有开销）。

你自己加进 `viewer.scene` 的带光照材质（如 `MeshStandardMaterial`）同样被太阳光和天光照亮，但不带空气透视。见[描边、调色与自定义对象](./effects.md)。

细节和数值见 [API 参考 §1.10](../api.md#_1-10-光照、空气透视与楼层环境光遮蔽)。

## 日照阴影

`viewer.lighting = true` 且太阳在地平线以上时，建筑和设备投下阴影，落在建筑自身、设备、地面、3D Tiles 和展台背景上。阴影图按"建筑 ∩ 视野"自动适配范围：楼外看是整栋楼和它的影子，进到楼里纹素随之变细（示例办公楼约 2.6–3.7 cm 一个纹素）。

```ts
viewer.shadows.enabled = true;                         // 默认按显存档位：low 关，其余开
viewer.shadows.configure({ intensity: 0.7, softness: 2 }); // 只改给出的项
```

| 选项（`SunShadowOptions`） | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | 按档位 | 开关。开关一次，带光照的材质要重编一次着色器 |
| `intensity` | 0.85 | 完全背阴处去掉多少直射阳光，0–1（天光不受影响） |
| `softness` | 1.5 | 边缘柔化宽度，阴影图纹素，0.5–4 |
| `maxDistance` | 2000 | 离相机多远以内画阴影，米 |
| `mapSize` | 2048（`ultra` 4096） | 阴影图边长，512–4096 的 2 的幂；2048 占 16 MB 显存 |

创建时也可以传 `GeoViewer.create({ shadows: false })` 或 `shadows: { mapSize: 4096 }`。只读的 `active`（上一帧是否画了阴影）、`texelSize`（一个纹素多少米）、`bytes` 方便调试。

谁投影、谁接收：

- **投影**：建筑实体和设备（程序生成的几何和 glTF 模型）。透明的东西（玻璃幕墙、窗、半透明的兄弟房间）不投影，阳光能照进室内；被层级隐藏的楼层不投影。**3D Tiles 和你自己加进场景的对象不投影**。
- **接收**：建筑、设备、地球地面、3D Tiles（有光照的削弱直射光，倾斜摄影整体变暗）、展台背景。

阴影图只在范围或建筑内容变化时重画，静止画面里没有开销。经实体 API 改建筑（显隐、样式、移动、换模型、切层级）时 viewer 自己会重画；**直接改了建筑网格时调用 `viewer.shadows.invalidate()`**。

没有用 three.js 自带的 `SunLight` 级联阴影：它在着色器里用 float32 的世界坐标乘阴影矩阵，ECEF 下误差约半米。也不要给太阳光打开 three.js 自己的阴影图。

## 云层与体积云

云默认不显示。`viewer.clouds` 远看是覆盖全球的**云壳**（约 10 km 高的一层，向东漂移）；相机降到约 300 km 以下时过渡到**体积云**：立体的积云层，可以从地面仰望、飞进云里、从云上俯瞰，云被山体和建筑挡住，开光照时在地面、建筑、3D Tiles 上投下随风移动的云影。体积云的天气跟随云壳：从太空看到云团的地方，底下就是成片的积云。

```ts
// 创建时打开
GeoViewer.create({ container, imagery, clouds: { visible: true, coverage: 0.55 } });

// 之后随时改（只改给出的项，非法值丢弃或夹紧）
viewer.clouds.set({ visible: true, coverage: 0.4 });
viewer.clouds.set({ volumetric: { bottom: 1200, thickness: 3000, windSpeed: 10, windHeading: 90 } });
viewer.clouds.set({ volumetric: false });  // 只要云壳
viewer.clouds.getOptions();                // 当前设置的副本
```

**云壳**（`CloudOptions`）：

| 选项 | 默认 | 说明 |
| --- | --- | --- |
| `visible` | `false` | 显示云。云壳和体积云共用 |
| `coverage` | 0.5 | 云量，0–1。云壳和体积云共用 |
| `opacity` | 0.9 | 最厚处的不透明度，0–1 |
| `speed` | 0.5 | 向东漂移，度经度 / 秒；负数向西，0 静止 |
| `height` | 10000 | 云壳的椭球高，米 |
| `fadeHeights` | [60 km, 500 km] | 相机高度低于前者隐藏、高于后者完全显示 |
| `textureUrl` | `null` | 等距圆柱投影的云图（左边缘经度 -180°，上为北）；`null` 是程序生成的云 |

**体积云**（`volumetric`，`true` / `false` 是 `{ enabled }` 的简写）：

| 选项 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | 按档位（`low` 关） | 近地时画体积云 |
| `bottom` | 1500 | 云底，椭球高，米（0–15000） |
| `thickness` | 2500 | 云层厚度，米（200–10000） |
| `windSpeed` | 6 | 风速，米/秒（0–60）。**0 时云不动，画面可以静止下来** |
| `windHeading` | 60 | 云移动的方向，度，自北顺时针 |
| `density` | 1 | 光学密度倍数（0.1–4） |
| `shadows` | `true` | 开光照时投下云影（只削弱直射阳光） |
| `fadeHeights` | [100 km, 300 km] | 相机高度低于前者全显、高于后者隐藏 |
| `maxDistance` | 80000 | 视线进入云层后最多走多远，米，远处逐渐变薄 |

要点：

- **云在动，画面就不静止**：云壳可见且在漂移、或体积云有风时，viewer 按云在屏幕上的移动速度保持一定帧率（整球视角每秒 10 帧，越低越快），不做静止超采样。大屏常驻、在意功耗时，用 `speed: 0`、`windSpeed: 0` 让云停下来。
- 进入局部场景、或建筑周围什么都不画（展台背景）时不画云；拾取不受云影响，点击会穿过云落到地面。
- 体积云第一次出现前要在 Worker 里生成一份噪声（约 0.5 s，整页一次）。

规范和实测见 [volumetric-clouds.md](../agents/volumetric-clouds.md)、[API 参考 §1.13](../api.md#_1-13-体积云)。

## 档位与代价

阴影和体积云的默认值随显存档位（`viewer.gpu.tier`，见[加载、错误与性能](./performance.md)）变化：

| 档位 | 日照阴影 | 阴影图 | 体积云 |
| --- | --- | --- | --- |
| `low` | 关 | 1024 | 关 |
| `medium` | 开 | 2048 | 开 |
| `high` | 开 | 2048 | 开 |
| `ultra` | 开 | 4096 | 开 |

代价（RTX 40 系列独显、WebGPU 的实测量级）：

- **阴影**：1280×720 下 GPU 多约 0.1 ms，阴影图 2048² 占 16 MB；静止画面不重画阴影图。
- **云壳**：开关的 GPU 时间差约 1 ms，集成显卡吃紧时可以换成云图（`textureUrl`，每片元一次采样）。
- **体积云**：整帧多 0.4–1.2 ms（低分辨率交错追踪 + 时域重投影）；显存在第一次显示时分配，1080p 约 20 MB。集成显卡上 `medium` 档多 2–7 ms，必要时关掉 `volumetric`。

明确要开或关时直接传选项，不必改档位：`GeoViewer.create({ shadows: true, clouds: { visible: true, volumetric: false } })`。

## 没有地表时：展台背景

隐藏了地球（例如用 Google 真实感 3D Tiles 时设了 `viewer.showGlobe = false`），又进入了建筑（3D Tiles 被压制），建筑周围就什么都没有了。这时 viewer 显示一块**展台背景**（地面网格和渐变天空），建筑不会悬在一片黑色里。`viewer.indoorBackdrop = false` 关掉它。展台背景同样接收日照阴影。

## 示例

<ExampleFrame id="lighting-clouds" />

示例源码：[examples/lighting-clouds/main.ts](../../examples/lighting-clouds/main.ts)。拖动"北京时间"看影子转动；"云下仰望""云上俯瞰"两个按钮分别把相机放到云底下和云层上方。
