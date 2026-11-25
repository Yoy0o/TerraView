# 建筑、层级与实体

TerraView 把建筑当作地球场景的一部分：同一台相机从地球飞进建筑，再进入楼层、房间、设备，不切换页面，也不切换渲染器。每个房间、设备都是带编号、类别、属性的**实体**，可以查询、拾取、改外观、挂顶牌。

这一章讲宿主怎么用：加载建筑、在层级之间切换、查询和修改实体、响应点击。数据怎么做（坐标、字段、类别、glTF 模型）见[建筑数据制作手册](../building-data-manual.md)，实现细节见 [indoor-bim.md](../agents/indoor-bim.md)。

## 层级

| 层级 | `type` | 对应 IFC | 说明 |
| --- | --- | --- | --- |
| 地球 | — | IfcSite 所在地 | `indoor.current === null` |
| 建筑 | `building` | IfcBuilding | 外壳加若干楼层 |
| 楼层 | `floor` | IfcBuildingStorey | 标高、层高、楼板轮廓 |
| 房间 | `room` | IfcSpace | 多边形轮廓，自动算面积、生成墙和门洞 |
| 设备 | `thing` | IfcElement | 设备、传感器、资产：位置、尺寸或模型 |
| 构件 | `element` | IfcWall / IfcDoor / IfcWindow … | 墙、门、窗、柱、楼板、楼梯 |

## 建筑文档

一栋建筑就是一份 JSON（建议扩展名 `*.building.json`）：

```json
{
  "format": "three-geo-building",
  "version": "1.0",
  "id": "office-a",
  "name": "示例办公楼",
  "anchor": { "longitude": 116.3929, "latitude": 39.9994, "heading": 15 },
  "footprint": [[-30, -12], [30, -12], [30, 12], [-30, 12]],
  "floors": [
    {
      "id": "F1", "name": "1F", "index": 0, "elevation": 0, "height": 4.2,
      "rooms": [
        { "id": "F1-R01", "name": "101 办公室", "category": "office", "footprint": [[-30, -12], [-10, -12], [-10, 0], [-30, 0]] }
      ],
      "things": [
        { "id": "F1-TH01", "name": "101 温湿度", "category": "sensor", "position": [-20, -6, 1.6], "properties": { "温度": "23.4 ℃" } }
      ]
    }
  ]
}
```

- `anchor` 是建筑本地坐标的原点：经纬度（度），`heading` 是建筑 +Y 轴的朝向（度，自北顺时针）。**省略 `height` 时自动贴地**（地形，或地球隐藏时的 3D Tiles 表面）。本地坐标 X 东、Y 北、Z 上，单位米。
- 房间、设备可以用程序生成的几何（多边形轮廓、盒子 / 圆柱），也可以挂 glTF 模型（整层模型按节点名或 `extras.id` 对应到实体）。
- 每个元素都可以带 `properties`（属性）、`tags`（标签）、`label`（顶牌）、`viewpoint`（进入时的视点）。

完整的字段、默认值和样例见[建筑数据制作手册](../building-data-manual.md)和 [sample-office.building.json](../examples/sample-office.building.json)。

## 加载与移除

```ts
const doc = await (await fetch('/data/office.building.json')).json();
const building = viewer.indoor.add(doc, '/data/'); // 第二个参数：解析模型相对路径的基准 URL

viewer.indoor.remove(building);
```

`add()` 同步校验文档并构建：缺字段、类型不对、id 重复、多边形少于 3 个点等问题会抛出 `TerraViewError`（`code: 'building-invalid'`，`details.path` 是出错的 JSON 路径，如 `$.floors[0].rooms[0].footprint`）；同一个 `id` 的建筑重复加载抛 `building-already-loaded`。也可以先用 `parseBuildingDoc(doc)` 单独校验。

`viewer.indoor.buildings` 是已加载的建筑，增删时 `indoor.events` 发 `buildings-changed`。

## 在层级之间切换

默认交互（SDK 已经注册好）：

| 操作 | 结果 |
| --- | --- |
| 双击建筑 / 楼层 / 房间 / 设备 | 进入下一级：地球上双击建筑进入建筑，建筑里双击楼层进入楼层…… |
| 右键单击 | 返回上一级 |
| 单击 | 选中（描边）当前层级下的交互单元：地球上是整栋建筑，建筑里是楼层，楼层里是房间、设备 |
| 悬停 | 交互单元描边（`indoor.hoverOutline`） |

从代码切换：

```ts
const indoor = viewer.indoor;

await indoor.enter(building);                    // 进入建筑：隐藏外壳，显示全部楼层
await indoor.enter(indoor.getById('F3-R10'));    // 直接进入房间：沿路径逐级切换，只在终点飞行
await indoor.enter(room, { jumping: false });    // 每进入一级都飞一次
await indoor.back();                             // 返回上一级，优先飞回往下钻之前的视点
await indoor.enter(null);                        // 回到地球

indoor.current;                                  // 当前层级（null = 地球）
indoor.current?.ancestors();                     // 从建筑到父级的路径
```

| `enter()` 选项 | 说明 |
| --- | --- |
| `fly` | 是否飞行，默认 `true` |
| `duration` | 飞行时长，秒（默认自动） |
| `jumping` | 默认 `true`：只在终点飞；`false` 时每进入一级都飞 |
| `transition` | 默认 `true`：切换时上一帧按深度重投影后溶解 |

`enter()` 返回的 Promise 在切换完成时以 `true` 结束；新的 `enter()` 会取消进行中的切换，旧的以 `false` 结束（状态停在已完成的那一步，是一致的）。进入房间、设备、构件时会同时选中它，同层的其他实体淡成 25% 不透明度。

### 层级事件

一次切换沿层级路径逐级离开、进入，每一级都发事件：

```ts
indoor.events.on('beforeEnterLevel', ({ object }) => { /* 即将进入 object */ });
indoor.events.on('enterLevel', ({ object, previous, next, path }) => console.log('进入', object?.name ?? '地球'));
indoor.events.on('leaveLevel', ({ object }) => { /* 离开了 object */ });
```

`object` 是这一步进入或离开的层级（`null` 是地球），`previous` / `next` 是整个切换的起点和终点，`path` 是依次离开、进入的层级。例如从 1F 的 103 机房切到 2F 的 201 办公区，再按两次返回：

```
leaveLevel 103 机房 → leaveLevel 1F → beforeEnterLevel 2F → enterLevel 2F → beforeEnterLevel 201 → enterLevel 201
返回：leaveLevel 201 → beforeEnterLevel 2F → enterLevel 2F
返回：leaveLevel 2F → beforeEnterLevel 建筑 → enterLevel 建筑
```

往上返回时，目标层级会被**重新进入**一次（它的效果重新应用），所以层级效果要写成幂等的绝对状态。另有 `select`、`hover` 事件（`{ entity }`）。

### Esc 与返回按钮

SDK 不在 `window` 上注册键盘监听：Esc 返回、面包屑、返回按钮由应用自己做，调用 `indoor.back()` 或 `indoor.enter(某一级)`：

```ts
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && viewer.indoor.current) void viewer.indoor.back();
});
```

### 显示选项

| 项 | 说明 |
| --- | --- |
| `indoor.expandFloors` | 建筑层级下把楼层上下拉开 |
| `indoor.showLabels` | 显示 / 隐藏所有实体顶牌 |
| `indoor.hideTilesetsIndoor` | 进入建筑时隐藏 3D Tiles（默认 `true`；绑定了层级的图层不看它，见下文"层级绑定"） |
| `viewer.indoorBackdrop` | 建筑周围什么都不画时（地球隐藏、3D Tiles 被压制）显示展台背景，默认 `true` |
| `viewer.flyToEntity(entity, { heading, pitch, rangeScale, duration })` | 不切换层级，只把相机飞到能看全某个实体的位置 |

### 地下层与起伏的地面

建筑按锚点处的地面高度贴地，SDK 不会在建筑占地范围内挖开或压低地球表面，所以有两种情况地面会挡住室内：

- **地下层**（`elevation` 为负的楼层）在地面以下，从上面看被地表完全盖住。
- **占地范围内地形有起伏**：地形数据里常带着房屋、树木，一栋楼的范围内起伏一两米很常见，高出楼板的地面会从楼板里露出来，也会挡住对房间的点击。

在建筑里时隐藏地球是最简单的办法，周围空了 SDK 会自动铺上展台背景：

```ts
viewer.indoor.events.on('enterLevel', () => (viewer.showGlobe = !viewer.indoor.current));
```

只是起伏的问题时，也可以在文档里把 `anchor.height` 写成占地范围内最高处的地面椭球高（写了高度就不再自动贴地）。

### 自定义层级的行为

每一级进入时做什么（显隐、半透明）、点到东西映射成哪个交互单元、相机怎么取景，都由**层级控制**（`LevelControl`）决定。内置三个：`building`（`.building`）、`floor`（`.floor`）、`placement`（`.room, .thing, .element`）。可以按选择器和优先级注册自己的：

```ts
import { defaultFilterObject, framedView } from 'terra-viewer';

viewer.indoor.registerLevelControl(
  {
    condition: '.room && tags:or(server)',  // 哪些层级用它
    priority: 10,                           // 大者优先；相同时后注册的优先
    setEffect: ({ object }) => object.setStyle({ color: '#7c3aed' }),
    resetEffect: ({ object }) => object.setStyle({ color: null }),
    filterObject: (hit, ctx) => defaultFilterObject(hit, ctx.object),
    viewFor: (entity, ctx) => framedView(entity, ctx, { pitch: -70, radii: 2, minRadius: 6 }),
    configureCamera: () => {
      const c = viewer.controller;
      const saved = c.pitchRangeDeg;
      c.pitchRangeDeg = [-90, -30];           // 在机房里不许把相机放平
      return () => (c.pitchRangeDeg = saved); // 离开时恢复
    },
  },
  'my-app', // 标签：unregisterLevelControls('my-app') 整体注销
);
```

`setEffect` / `resetEffect` 可以返回 Promise，切换会等它完成。要整体替换默认行为，先 `unregisterLevelControls('builtin')`。`viewFor` 返回 `null` 表示该层级不飞行。

## 查询实体

```ts
const offices = viewer.indoor.query('.room && [category=office]'); // EntitySet
offices.length;
offices.forEach((room) => console.log(room.name, room.properties));

viewer.indoor.query('.floor').query('tags:or(alarm)');  // 链式：楼层下带 alarm 标签的实体
viewer.indoor.query('.thing').where('[温度>=26]');       // 在结果里再筛选
viewer.indoor.getById('F3-R10');                        // 按 id 直接取（不经过选择器）
```

`EntitySet` 就是数组（`length`、下标、`forEach`、`map`），另有 `query`、`where`、`first`，以及批量操作 `setStyle`、`setEffects`、`visible`。

| 选择器 | 含义 |
| --- | --- |
| `.room` `.thing` `.floor` | 按类型（不区分大小写） |
| `#F3-R10` | 按 id |
| `[category=camera]` `[状态!=正常]` `[温度>=26]` | 属性比较：`=` `!=` `<` `>` `<=` `>=`。`id`、`type`、`name`、`category` 读实体字段，其他键读 `properties`。数值比较时 `"23.1 ℃"` 读作 23.1 |
| `[name=303*]` | 前缀匹配 |
| `[温度]` | 属性存在 |
| `tags:or(a, b)` `tags:and(a, b)` `tags:not(a, b)` | 标签任一 / 全部 / 都没有 |
| `/^Cam/i` | 名称匹配正则 |
| `&&` `\|\|` `!` `( )` `,` | 组合；`,` 与 `\|\|` 都是"或"。紧挨着写的项按"且"处理，如 `.thing[category=camera]` |

选择器编译后缓存。语法错误抛 `SelectorError`（`index` 是出错位置，从 0 起）。也可以直接传正则或谓词函数 `(e) => boolean`。

BIM 实体自动带的属性名（面积、楼层数、标高等）随 `locale` 变化：中文环境下写 `[面积>20]`，英文环境下写 `[Area>20]`（[基本概念](./concepts.md#语言)）。

## 改外观

```ts
const rack = viewer.indoor.getById('F1-RK02')!;

rack.setStyle({ color: '#ff4d4f' });                  // 染色；也可以给 opacity、emissive
rack.setStyle({ color: null });                       // null 还原文档里的外观
rack.setEffects({ outline: 'alarm', glow: 0.6 });     // 闪烁的红色描边 + 发光
rack.setEffects({ outline: null, glow: null });       // 清除
rack.visible = false;                                 // 显隐

viewer.indoor.query('tags:or(alarm)').setEffects({ outline: 'alarm', glow: 0.6 }); // 批量
```

| 项 | 说明 |
| --- | --- |
| `setStyle({ color, opacity, emissive })` | 用户样式。只改给出的字段，`null` 还原 |
| `setEffects({ outline, glow, glowColor })` / `effects` | 描边样式名（`'select'` / `'hover'` / `'alarm'` 或 `viewer.effects.defineOutline` 定义的）、发光强度 0..1。不改材质；选中合批设备时只描它自己 |
| `visible` | 实体自己的显隐 |
| `levelOpacity` | 层级效果用的不透明度系数，与 `setStyle` 的不透明度相乘 |
| `indoor.selectOutline` / `indoor.hoverOutline` | 选中、悬停用哪种描边，`null` 关闭 |

几条规则：

- **层级效果用 `levelOpacity`，不要用 `setStyle({ opacity })`**：内置的同级半透明就是改 `levelOpacity`，返回时会重新写回；用 `setStyle` 做层级效果会抹掉用户自己设的样式。
- **高亮用描边，不要改 `emissive` 或材质**：要换选中的样子，改 `indoor.selectOutline` 或 `viewer.effects.defineOutline('select', { … })`。
- **不要去找设备的材质**：设备按楼层合批成实例化网格（1 万个设备约 40 次绘制），合批设备的 `meshes` 是空的。改外观只用 `setStyle` / `setEffects` / `levelOpacity`，显隐只用 `entity.visible`（不要改 `entity.group.visible`）；移动设备的 `group` 之后调用 `entity.refreshTransform()`。
- 经实体 API 做的改动 viewer 都能发现（重画、拾取缓冲失效、阴影和楼层 AO 重算），不需要自己调用 `requestRender()`。
- 实时数据（IoT 状态）：更新 `entity.properties`，再按需 `setStyle` / `setEffects`。

## 交互

点击、悬停一律走 `viewer.interaction`，用选择器限定范围：

```ts
viewer.interaction.on(
  'click',
  (e) => openPanel(e.object!),        // e.object：选择器匹配到的实体（命中实体或它的祖先）
  { selector: '.room, .thing', tag: 'app' },
);

viewer.interaction.off('click', 'app'); // 按标签整体注销
```

- 事件里 `e.entity` 是命中的实体，`e.object` 是选择器匹配到的那个（冒泡到祖先），`e.marker` 不为空表示点在实体的顶牌上。
- 内置的室内行为注册在标签 `indoor`（双击进入、右键返回、单击选中）和 `indoor-hover`（悬停描边）上。要换掉某个默认行为：`viewer.interaction.off('dblclick', 'indoor')` 后注册自己的；要压过它：给更高的 `priority` 并 `e.stopPropagation()`；要取消相机的双击飞近：`e.preventDefault()`。
- 弹窗打开期间临时屏蔽交互，用 `pause`，保存返回的函数用来恢复：

```ts
// 不选中、不进出层级，相机的双击飞近也不生效（拖动、缩放照常）
const resume = viewer.interaction.pause({ blockDefault: true });
// 只屏蔽室内的默认行为
const resumeIndoor = viewer.interaction.pause({ tag: 'indoor', blockDefault: true });
resume();
```

不要注销再重新注册内置监听来"暂停"。详见[交互、拾取与事件](./interaction.md)。

### 实体顶牌

建筑和房间自动生成顶牌，设备在文档里写了 `label` 才有。顶牌的显示由文档的 `label.mode` 决定：

| `mode` | 何时显示 |
| --- | --- |
| `always` | 实体可见就显示 |
| `level` | 父层级被进入时（默认：进入楼层后显示房间牌） |
| `hover` | 悬停时 |
| `click` | 选中时 |

`label.style` 可以是 `card`（建筑、告警默认）、`pin`（设备默认）、`tag`（房间默认），或任意点位样式（`pulse`、`badge` 等，见[顶牌与点位标注](./markers.md)）。卡片样式不参与避让，总是显示。顶牌上的单击、双击、右键会转成对这个实体的 `viewer.interaction` 事件。

## 模型与性能

| 项 | 说明 |
| --- | --- |
| 模型按需加载 | 楼层和设备的 glTF 在楼层**第一次显示时**才加载（`indoor.lazyModels`，默认 `true`，要在 `add()` 之前改）。在显示之前要用到模型（取景、包围体）时先 `await building.modelsLoaded(entity)`，不要假设 `add()` 之后网格已经在了。模型加载不计入 `viewer.loadState` / `idle` |
| 显存预算 | 已加载模型超过 `indoor.modelBytesTarget`（按显存档位 64–512 MB）时，隐藏满 `indoor.modelUnloadDelayMs` 的楼层模型按最近显示先后卸载，再显示时重新加载。读数 `indoor.modelBytes`、`viewer.memory.buildings` |
| 设备合批 | 默认开（`indoor.batchDevices`，`add()` 之前改）。同楼层、同几何、同材质的设备合成一次绘制 |
| 贡献剔除 | 默认关。`indoor.culling.configure({ enabled: true, threshold: 0.005 })`：屏幕上太小的设备和非结构构件不画，墙、楼板、柱始终保留。它只设 `entity.culled`，不改 `visible`，也不要自己改实体网格的 `visible` 来做显隐 |
| 楼层环境光遮蔽 | 默认开。楼层第一次显示时烘焙一次，之后没有每帧开销：`indoor.ambientOcclusion.configure({ intensity: 0.6 })`、`.enabled = false` |
| 阴影与光照 | 开 `viewer.lighting` 后建筑投下日照阴影、受大气光照，见[光照、大气、阴影与云](./environment.md) |

## 层级绑定

高斯泼溅、3D Tiles 这类图层不是层级，但可以**绑定**到层级树的某个节点上，由所在层级决定显隐；绑定的实体可以在内容显示时让位：

```ts
// 三层的室内实景：进入三层时才加载、显示；模型隐去，但房间照常可以点选、进入
viewer.addSplats({ url: 'scans/F3.spz', level: { entity: 'F3', position: [0, 0, 0], entityOpacity: 0 } });

// 这栋楼自己的倾斜摄影：只在楼外显示
viewer.addTileset({ source: { type: 'url', url: '/tiles/office-a/tileset.json' }, level: { entity: 'office-a', show: 'outside' } });

// 进楼也不隐藏的 3D Tiles
viewer.addTileset({ source, level: { show: 'always' } });

// 宿主自己的 three.js 对象
viewer.indoor.bindings.bind(mesh, { entity: 'F3', show: 'inside' }, { onChange: (b) => (mesh.visible = b.shown) });
```

| `show` | 显示的条件 |
| --- | --- |
| `'inside'` | 所在层级是该实体或它的下级（楼层、房间、设备的默认） |
| `'outside'` | 所在层级在该实体之外，且实体可见（建筑的默认） |
| `'current'` | 所在层级正是该实体 |
| `'entity'` | 跟着实体的显隐走 |
| `'always'` | 实体存在就显示 |

`entity` 可以是实体或它的 id（按 id 绑定可以早于建筑加载）；`entityOpacity` 是内容显示且已加载时实体模型的不透明度（0 时看不见，但仍可拾取、描边、带顶牌）。建筑文档里任何元素也可以直接声明 `splats`，加载建筑时自动建成绑定的图层。

要让层级之外的东西跟着层级走，用绑定，不要在 `enterLevel` 监听里手写图层的显隐。细节见 [indoor-bim.md](../agents/indoor-bim.md) §6.5 和[高斯泼溅](./splats.md)。

## 示例

<ExampleFrame id="indoor" />

源码：[examples/indoor/main.ts](../../examples/indoor/main.ts)。加载样例建筑，按钮和双击逐级进入、返回，面板上显示当前层级路径和层级事件；Esc 返回写在应用里。

<ExampleFrame id="indoor-query" />

源码：[examples/indoor-query/main.ts](../../examples/indoor-query/main.ts)。选择器查询、批量染色 / 描边 / 发光 / 隐藏，点击房间或设备弹出属性，弹窗期间暂停交互。

全部导出见 [API 参考 §3.7](../api.md#_3-7-室内-bim)。
