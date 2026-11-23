# 室内与 BIM 模型规范

代码：`src/indoor/schema.ts`（格式与校验）、`src/indoor/selector.ts`（选择器编译）、`src/indoor/BimEntity.ts`（实体、样式、标签）、`src/indoor/EntitySet.ts`（查询结果）、`src/indoor/Building.ts`（构建与地理定位）、`src/indoor/LevelControl.ts`（层级控制策略）、`src/indoor/levelBinding.ts`（层级绑定：图层等内容按层级显隐）、`src/indoor/levelView.ts`（取景）、`src/indoor/IndoorManager.ts`（层级路径切换、视点缓存、拾取、顶牌）、`demo/data/demoBuilding.ts`（示例，不进包）。UI：`demo/ui/IndoorPanel.ts`。测试：`tests/indoor.test.ts`、`tests/levelBinding.test.ts`、`tests/selector.test.ts`、`tests/interaction.test.ts`。

## 1. 目标

- **无缝**：同一个场景、同一台相机，从地球飞进园区和建筑，再进入楼层、房间、设备，不切换页面，也不切换渲染器。
- **语义化**：每个房间和设备都是带编号、分类、属性的实体，可以查询、可以拾取、可以改样式，并能挂顶牌。
- **与 BIM 对齐**：层级对应 IFC 的空间结构，属性能承载 IFC 属性集；几何可以来自程序生成，也可以来自 glTF（由 IFC 或 Revit 导出）。

## 2. 层级模型

| 本项目 `type` | IFC | ThingJS | 说明 |
| --- | --- | --- | --- |
| （地球） | IfcSite 所在地 | Campus / 地图层级 | `current === null` |
| `building` | IfcBuilding | Building | 外立面加若干楼层；外部可见外壳 |
| `floor` | IfcBuildingStorey | Floor | 标高、层高、楼板轮廓 |
| `room` | IfcSpace | Room | 多边形轮廓，自动计算面积，自动生成墙（含门洞） |
| `element` | IfcWall / IfcDoor / IfcWindow / IfcColumn / IfcSlab / IfcStair | 墙 / 门 / 窗 / 地板 / 屋顶 | 结构构件，可选 |
| `thing` | IfcElement（设备、传感器、资产） | Thing / Entity | 位置、朝向、尺寸或模型 |

**层级之外的内容**：高斯泼溅、3D Tiles 这类图层不是层级，可以绑定到上面任一节点（包括"地球"），由所在层级决定显隐，见 §6.5。

**托管实体与静态几何**（对应 ThingJS 的 Entity 和 Misc）：文档里列出的元素都是托管实体，可以拾取、改样式、查询、挂顶牌。glTF 中没有对应实体的节点属于静态几何，照常绘制，但拾取时只会解析到它所在的楼层或设备。

## 3. 坐标系

- 建筑本地坐标：原点在 `anchor`（经度、纬度、高度），+X 东、+Y 北、+Z 上，整体按 `anchor.heading`（度，自北顺时针，指 +Y 轴的朝向）旋转。
- 楼层内容相对楼板：z = 0 是该层地面；楼层组的 z = `elevation`（楼层展开时再加偏移）。
- `anchor.height` 是椭球高。省略时自动贴地（`viewer.surfaceHeight`）：地球显示时贴地形，地球隐藏时（如 Google 3D Tiles）贴可见的 3D Tiles 表面；数据足够精细（网格间距 / 瓦片几何误差不超过 150 m）后才贴，之后随细化微调，见 tile-loading.md §4.3、[roadmap.md](roadmap.md) ISSUE-1。贴地导致建筑抬升时，如果相机正飞向它或已经在它内部，会通过 `controller.translate` 同步平移，保持取景不变。
- glTF 默认 Y 轴朝上，加载时绕 X 轴转 +90°；Z 轴朝上的导出请写 `upAxis: 'Z'`。可选 `scale`、`offset`、`rotation`。
- 渲染时，建筑根节点的矩阵是锚点处 ENU 坐标系乘以 RotZ(−heading)，在 float64 的模型视图矩阵下没有抖动。

## 4. 文档格式（`three-geo-building` v1.0）

文件扩展名建议用 `*.building.json`（拖入页面即可加载）。字段如下（完整类型见 `schema.ts`）。面向数据制作的完整说明（坐标与高度、各字段、类别词表、模型、自检）见 [建筑数据制作手册](../building-data-manual.md)，样例见 [sample-office.building.json](../examples/sample-office.building.json)：

```jsonc
{
  "format": "three-geo-building",
  "version": "1.0",
  "id": "demo-office-a",            // 文档内唯一；建议使用 IFC GlobalId
  "name": "示例办公楼 · A 座",
  "category": "office",
  "ifcType": "IfcBuilding",
  "properties": { "建成年份": 2021 },
  "anchor": { "longitude": 116.3929, "latitude": 39.9994, "heading": 0 },   // 省略 height = 贴地
  "footprint": [[-30, -12], [30, -12], [30, 12], [-30, 12]],               // 本地米，逆时针
  "exterior": { "color": "#7fa6d6", "opacity": 0.55 },                      // 或 { "model": { "uri": "shell.glb" } }
  "label": { "title": "示例办公楼 · A 座", "subtitle": "5 层", "icon": "🏢", "style": "card" },
  "viewpoint": { "heading": 30, "pitch": -35, "range": 180 },              // 可选：进入该层级时的视点（任何元素都可以写）
  "floors": [
    {
      "id": "F3", "name": "3F", "index": 2, "elevation": 8.4, "height": 4.2,
      "model": { "uri": "F3.glb" },                                          // 可选：整层 BIM 导出
      "rooms": [
        {
          "id": "F3-R10", "name": "303 办公室", "category": "office",
          "footprint": [[-10, -12], [0, -12], [0, -1.6], [-10, -1.6]],
          "doors": [{ "edge": 2, "at": 0.5, "width": 1.1 }],                 // 边从 0 起编号：edge 2 是北侧临走廊的边，在其中点开门
          "properties": { "用途": "办公" }
        }
      ],
      "things": [
        {
          "id": "F3-TH05", "name": "303 温湿度", "category": "sensor",
          "position": [-0.4, -6.8, 1.6], "size": [0.12, 0.08, 0.16],
          "properties": { "温度": "23.1 ℃", "湿度": "56 %", "状态": "正常" },
          "tags": ["hvac", "monitored"],                                     // 可选：选择器 tags:or(...) 和层级规则用
          "label": { "title": "23.1℃ · 56%", "icon": "🌡", "mode": "level", "style": "pin" }
        }
      ],
      "elements": [{ "id": "F3-W01", "kind": "wall", "path": [[0, 0], [5, 0]], "height": 3 }]
    }
  ]
}
```

校验（`parseBuildingDoc`）：缺字段、类型错误、id 重复、多边形少于 3 个点、层高非正、门洞边号越界或位置超出 0..1、构件 `kind` 不在 6 种之内或既没有 `path` 也没有 `position`、`tags` 不是字符串数组、`viewpoint` 的俯仰超出 −90°..90° 或距离非正等问题，都会抛出带 JSON 路径的错误（例如 `$.floors[0].rooms[0].footprint: expected at least 3 [x, y] points`）。楼层按 `index` 排序，默认值也在这里统一填充。

所有元素（建筑、楼层、房间、设备、构件）都可以带这三个可选字段：

| 字段 | 说明 |
| --- | --- |
| `tags` | 字符串数组。墙、楼板、柱子自动带 `structure` 和自身类别（`wall` / `slab` / `column`），门窗等构件带自身类别。带 `structure` 的实体在楼层、房间层级不参与交互 |
| `viewpoint` | `{ heading, pitch, range }`：进入该层级时的视点。`heading` 是相对建筑本地 +Y 轴顺时针的角度（度；建筑朝向为 0 时就是相对正北），`pitch` 为 −90..90 度（负值向下看），`range` 是到实体包围球中心的距离（米）。缺的字段用该层级的默认取景（§6.2） |
| `splats` | 数组：绑定在该元素上的高斯泼溅场景（实景）。每项 `{ uri, position, rotation, pitch, roll, scale, upAxis, pivot, show, entityOpacity, opacity, maxSplats, format, name }`，只有 `uri` 必填。`position` 是场景枢轴在**该元素坐标系**里的位置（米，默认原点）：建筑用建筑本地坐标，楼层、房间、构件用楼层内坐标（z = 0 是楼面），设备相对设备自身。`rotation` 自坐标系 +Y 顺时针（度）。`show`、`entityOpacity` 见 §6.5；其余同 `viewer.addSplats` 的选项（[splats.md](splats.md)）。场景在第一次显示时才加载 |

```jsonc
"floors": [{
  "id": "F3", "elevation": 8.4, "height": 4.2,
  "splats": [{ "uri": "scans/F3.spz", "position": [0, 0, 0], "entityOpacity": 0.15 }],   // 进入三层时显示实景，模型淡成 15%
  "rooms": [{ "id": "F3-R10", "footprint": [...], "splats": [{ "uri": "scans/server-room.ply", "position": [-5, -7, 0], "show": "current" }] }]
}]
```

### 4.1 glTF 与实体的映射

- `floor.model` 里，节点的 `name` 或 `extras.id`（three 里是 `userData.id`）等于某个房间、设备或构件的 `id` 时，该节点子树会被挂到这个实体下（保持世界变换不变），并克隆材质，让样式修改只影响它自己。
- `thing.model` 整体属于该设备。`exterior.model` 是外壳。
- 从 IFC 转换的建议：用 IfcOpenShell 或 xeokit-convert 导出 glTF，节点名使用 GlobalId；空间结构和属性集导出为本格式的 floors / rooms / things 与 `properties`。

### 4.2 顶牌（label）

数据驱动，对应 ThingJS 用 userData 配置顶牌的做法：

| 字段 | 说明 |
| --- | --- |
| `title` / `subtitle` | 默认 title 为实体名；房间的 subtitle 默认为面积 |
| `mode` | `always`：实体可见就显示；`level`：父层级被进入时显示（默认，例如进入楼层后显示房间牌）；`hover`：悬停时显示；`click`：选中时显示 |
| `style` | `card`：气泡加引线（建筑和告警默认）；`pin`：圆点加文字（设备默认）；`tag`：紧凑标签（房间默认）。也可以用点位样式：`pulse`（告警呼吸点）、`badge`、`poi`、`beacon`、`label`，见 [markers.md](markers.md) §2 |
| `color` / `icon` / `offset` | 强调色、前置图标、距实体顶部的额外高度（米） |

建筑和房间会自动生成顶牌，设备只有在文档里写了 `label` 才有。顶牌按优先级避让：卡片样式（建筑、告警）始终显示，其余按 选中 > 悬停 > 房间 > 设备 排序，同优先级近者优先。

## 5. 运行时 API

```ts
const b = viewer.indoor.add(doc, baseUrl);       // 解析、构建、贴地，并生成顶牌
await viewer.indoor.enter(b);                     // 进入建筑；返回 false 表示被新的 enter() 取消
await viewer.indoor.enter(viewer.indoor.getById('F3-R10'), { jumping: false }); // 逐级飞行：建筑 → 楼层 → 房间
viewer.indoor.back();                             // 房间 → 楼层 → 建筑 → 地球（优先飞回进入前的视点）
viewer.indoor.query('.room && [category=office]').setStyle({ color: '#ffcc00' });
viewer.indoor.query('.floor').query('tags:or(alarm)'); // 链式查询：楼层下带 alarm 标签的实体
viewer.indoor.select(entity);                     // 描边（selectOutline）并弹出属性
viewer.indoor.filterObject(hit);                  // 当前层级下，拾取到的实体对应的交互单元
viewer.indoor.expandFloors = true;                // 楼层展开（建筑层级生效）
viewer.indoor.showLabels = false;
viewer.indoor.events.on('enterLevel', ({ object, previous, next, path }) => { /* ... */ });
viewer.flyToEntity(entity, { pitch: -40 });       // camera.fit
```

`enter(target, options)` 的选项：`fly`（默认 true）、`duration`（秒）、`jumping`（默认 true，只在终点飞行；false 时每进入一级都飞一次）、`transition`（默认 true，切换时让上一帧按深度重投影后溶解，见 §7.1）。

`BimEntity`：`id` `type` `name` `category` `properties` `tags` `viewpoint` `label` `parent` `children` `group`，以及 `setStyle({ color, opacity, emissive })`、`effects` / `setEffects({ outline, glow, glowColor })`（描边与发光，§5.5）、`levelOpacity`（层级效果用的不透明度系数，与样式相乘）、`visible`、`effectivelyVisible`、`worldBounds()`、`labelPosition()`、`closest(type)`、`traverse(cb)`、`isDescendantOf(e)`、`meshes`（自有网格）、`instances`（合批实例，§5.2）、`refreshTransform()`（改了合批实体 `group` 的位姿后调用）。`setStyle`、`visible`、`levelOpacity`、`refreshTransform()` 会经建筑根上的 `onChange`（内部）通知 `IndoorManager`，再转给 viewer：恢复全帧率；显隐、移动还会让拾取缓冲和贡献剔除失效，宿主不用自己调 `requestRender()` 或 `pickBuffer.invalidate()`。

`query()` 返回 `EntitySet`：它就是数组（`length`、下标、`forEach`、`map`），另有 `query(selector)`（在结果的后代里继续查）、`where(selector)`（筛选结果本身）、`setStyle(style)`、`visible`、`first`。`getById(id)` 直接比较 id，不经过选择器。

事件：`beforeEnterLevel` / `enterLevel` / `leaveLevel`（`{ object, previous, next, path }`：`object` 是这一步进入或离开的层级，`previous` / `next` 是整个切换的起点和终点，`path` 是依次离开、进入的层级）、`select`、`hover`、`buildings-changed`。

### 5.1 选择器

字符串选择器先编译成函数再求值，按字符串缓存（最多 256 条，最久未用的先淘汰）。语法错误抛出 `SelectorError`，`index` 是出错位置（从 0 起）。

| 写法 | 含义 |
| --- | --- |
| `.room` `.Building` | 按类型，不区分大小写 |
| `#F3-R10` | 按 id |
| `[category=camera]` `[状态!=正常]` `[温度>=26]` `[name=303*]` | 属性比较：`=` `!=` `<` `>` `<=` `>=`。`id` `type` `name` `category` 读实体字段，其他键（或 `prop.键`）读 `properties`。不加引号的值以 `*` 结尾时做前缀匹配。大小比较按数值，`"23.1 ℃"` 读作 23.1。属性不存在时 `!=` 成立 |
| `[温度]` | 属性存在 |
| `tags:or(a, b)`（或 `tags(a, b)`）、`tags:and(a, b)`、`tags:not(a, b)` | 标签任一、全部、都没有 |
| `/^Cam/i` | 正则匹配名称 |
| `"303 办公室"`、`Cam 1` | 名称完全相等（不加引号时保留中间空格） |
| `&&` `\|\|` `!` `( )` `,` | 组合。优先级从低到高：`,` 与 `\|\|`（或）、`&&`、`!`。紧挨着写（中间没有空格）的项按"且"处理，如 `.thing[category=camera]` |

另外可以直接传 RegExp（匹配名称）或谓词函数。空字符串不匹配任何实体。

### 5.2 设备合批与样式池（M3.6）

设备（`thing`）默认不再各建一个网格和一份材质，而是按楼层合成实例化绘制（`indoor/InstanceBatch.ts`、`indoor/StylePool.ts`）：

- **分批规则**：同一楼层、同一几何、同一基础材质、同一渲染状态的设备是一个 `InstancedMesh`（`BatchMesh`），挂在楼层 `group` 下的 `batches` 组里，楼层显隐和楼层展开自动作用于整批。
  - 几何体：基本形状用单位几何（`unit:box` / `unit:cylinder` / `unit:sphere`），尺寸写进实例矩阵，所以不同尺寸、不同颜色的盒子是同一批。glTF 模型每个 URL 只加载一次（模板，不进场景），模型里的每个网格各成一批；带蒙皮、变形目标、多材质的模型退回逐设备挂载（`attachModel`）。
  - 渲染状态：不透明 / 半透明写深度 / 半透明不写深度（层级淡化）三种，各是一个 `NodeMaterialInstance`，共用基础节点材质的一次着色器构建。设备在状态之间切换时从一批移到另一批。
- **逐实例样式**：颜色走 three 的 `instanceColor`（乘到漫反射上，贴图照常），发光和不透明度走实例属性 `bimStyle`（rgb = emissive，a = opacity），材质用 `referenceAttribute('bimStyle')` 按对象读取，所以所有批次共用一个着色器。共享材质本身的颜色、发光为白、不透明度为 1，实例携带完整值。`setStyle`、`levelOpacity`、选择器查询的行为与逐网格时一致（悬停 / 选中是描边，不改实例属性，§5.5）：样式规则只写在 `resolveLook`（`BimEntity.ts`）一处，网格和实例共用。
- **实例 id**：实例按"可见即在批内"紧凑排列，隐藏的设备离开批次（`count` 减一，末尾实例补位）。`BatchMesh.entityAt(instanceId)` 把实例下标映射回实体；CPU 拾取（`IndoorManager.pick`）用射线命中的 `instanceId`，M2.1 GPU 拾取读回的实例 id 也走这里。
- **样式池**：几何和材质按唯一键共享并计引用数（`sharedStylePool`，所有建筑共用）：几何键为 `unit:<形状>` 或 `geo:<glTF 几何 uuid>`，基础材质键为 `thing:standard` 或 `mat:<glTF 材质 uuid>`，变体键再加渲染状态。批次在建筑移除时整体释放，引用数归零即 `dispose()`。用过的渲染状态在建筑存续期间保留（空批次 `visible = false`，不画），避免进出房间时反复建管线。`sharedStylePool.stats` 可查现存资源数。
- **注意**：
  - 显隐用 `entity.visible`，不要直接改 `entity.group.visible`（实例跟不上）；移动合批设备后调用 `entity.refreshTransform()`。
  - 合批设备的 `meshes` 为空，自定义效果要改外观请用 `setStyle` / `levelOpacity`，不要去找设备的材质。
  - 半透明批次内部不按距离排序（整批作为一个对象排序）；层级淡化不写深度，影响很小，大量透明面的正确排序见路线图 M3.9（OIT）。
  - `viewer.indoor.batchDevices = false`（在 `add()` 之前设置）或 `new Building(..., { batching: false })` 恢复逐设备网格，用于对照和排查。
- **实测**（2026-11-09，WebGPU，10 层 × 1000 个设备）：建筑共 40 次绘制（30 批 + 10 块楼板），帧 CPU 约 9 ms；关闭合批时 10,000 次绘制、约 129 ms。选型依据见 roadmap.md M3.6。

### 5.3 贡献剔除（M2.3）

设备和非结构构件在屏幕上太小时不渲染（`indoor/ContributionCulling.ts`，算法移植自 t3d 示例 `renderer_culling_contribution`，许可见 `THIRD_PARTY_NOTICES.md`）。**默认关闭**，按需开启和调参：

```ts
// 创建时
await GeoViewer.create({ container, contributionCulling: { enabled: true, threshold: 0.005 } });
// 运行时（只改传入的字段，其余保持）
viewer.indoor.culling.configure({
  enabled: true,
  threshold: 0.005,   // 屏幕占比（取视口宽、高中较大的一边，0..1），默认 0.005 = 0.5%
  hysteresis: 0.1,    // 被剔除后要超过 threshold × (1 + hysteresis) 才恢复，默认 0.1
  interval: 5,        // 每隔几帧评估一次（≥ 1），默认 5
  selector: '.thing', // 只让匹配的实体参与，null（默认）= 所有可剔除实体
  rules: [            // 按类别单独设阈值，第一条匹配的生效；threshold 0 = 永不剔除
    { selector: '[category=camera]', threshold: 0 },
    { selector: '[category=sensor]', threshold: 0.01 },
  ],
});
viewer.indoor.culling.enabled = false; // 关闭并立即恢复全部
viewer.indoor.culling.stats;           // { candidates, culled }：上一次评估的参与数、剔除数
```

- **算法**：包围球中心变换到视空间，按两条切线分别在水平、垂直平面上精确求出投影范围（NDC），取较大的一边 / 2 作为屏幕占比。球包住相机或在相机后方时按全屏处理（不剔除）。包围球按实体自身坐标系缓存（网格 + 合批实例），模型异步加载使网格数变化时重算；楼层展开、建筑贴地、`refreshTransform()` 移动后用当前世界矩阵变换，不必重算。
- **谁参与**：`thing`（设备）和不带 `structure` 标签的 `element`（门、窗、楼梯等）。墙、楼板、柱（`structure`）、楼层（含楼板网格）、房间、建筑**始终不参与**，`selector` / `rules` 也改变不了。当前进入的层级和选中的实体不剔除。
- **与显隐分开**：剔除只设 `entity.culled`（隐藏实体自己的网格，合批实例离开批次），不改 `entity.visible`；用户或层级控制设的显隐照常生效，`visible = true` 不会把被剔除的实体提前显示出来。被隐藏的子树（其他楼层）跳过评估、保留原状态；进入层级、改变选中时立即重新评估，不等间隔。
- **拾取**：被剔除的设备不画进拾取缓冲，CPU 射线也会跳过（网格不可见、实例不在批内）；状态变化时 `indoor.update()` 返回 true，viewer 随之让拾取缓冲失效。
- **顶牌不受影响**：设备顶牌按自己的 `maxDistance`（设备默认 120 m）和显示模式显示，告警卡片不会因为剔除而消失。
- **演示应用**：URL `?cull=1`（`?cullThreshold=0.01`、`?cullHysteresis`、`?cullInterval`、`?cullSelector=.thing`，非法值忽略；不带 `?cull=1` 时只预设参数）；面板"室内 / BIM"里的"远景剔除小设备"开关、阈值滑块（0.1%–5%）和当前剔除数。

### 5.4 模型按需加载与显存预算（P2.2 / M3.8）

楼层的 glTF（`floor.model`）和该楼层设备的模型（`thing.model`）不再在 `indoor.add()` 时全部加载，而是在**楼层第一次显示时**才加载（`indoor/Building.ts`，规则在 `indoor/modelBudget.ts`）：

- **什么时候加载**：每帧（`IndoorManager.update`）检查哪些楼层正显示着（`effectivelyVisible`），显示着而模型没加载的就开始加载。进入建筑时全部楼层显示，所以都会加载；从地球直接进入某层时只加载那一层。另外 `building.modelsLoaded(entity)` 会主动加载该实体用到的模型（它下面的楼层、它所在楼层、它的设备和外壳）并等待，层级切换在飞行前就是这样等模型的（最多 `modelWaitMs`），宿主也可以用它预加载。外壳模型（`exterior.model`）在地球层级就看得见，照常随建筑加载。
- **什么时候卸载**：所有建筑已加载模型的估算字节数（`indoor.modelBytes`，也是 `viewer.memory.buildings`）超过 `indoor.modelBytesTarget` 时，把隐藏了至少 `modelUnloadDelayMs` 的楼层模型按"最近一次显示"从早到晚卸载，直到回到预算以内。**显示着的楼层永远不卸载**（所以只靠可见部分超过预算时总量会一直高于预算），正在加载的也不卸载。卸载的楼层再显示时重新加载（走浏览器 HTTP 缓存）。设备模型按 URL 共享、合批，加载后不卸载。
- **预算按显存档位给**（`viewer.gpu.indoor`，viewer 创建时写进 `indoor`）：`low` 64 MB / 5 s，`medium` 128 MB / 10 s，`high` 256 MB / 10 s，`ultra` 512 MB / 20 s。可以随时改 `indoor.modelBytesTarget`、`indoor.modelUnloadDelayMs`。
- **估算**：每个模型的顶点属性、索引和纹理字节（RGBA8，生成 mipmap 时乘 4/3；压缩纹理按自带的 mip 链），同一几何、同一纹理只算一次。不含程序生成的楼板、墙和合批设备的实例数据。
- **卸载做了什么**：挂到房间、设备、构件上的模型节点从实体上摘下（`meshes` 和样式记录一并去掉），连同静态几何一起释放几何、材质和纹理；经 `onChange` 通知 viewer（全帧率、拾取缓冲失效）。贡献剔除按网格数变化重算包围球。重新加载后，实体当时的样式和层级半透明会重新应用到新网格上。
- **关闭**：`indoor.lazyModels = false`（在 `add()` 之前设置，或 `new Building(..., { lazyModels: false })`）恢复原来的行为：所有模型随建筑加载，也不卸载。
- **顺带修复**：移除建筑时，模型的纹理原来没有释放（只释放了几何和材质），现在一起释放；建筑移除后才到达的模型直接释放，不再挂到已移除的建筑上。
- **不计入加载状态**：模型加载仍不算进 `viewer.loadState` / `idle`（docs/api.md §1.7）。

### 5.5 描边与发光（M3.2）

选中、悬停和告警用描边和发光表示，不改实体的材质和样式（原来改的是自发光颜色，会和 `setStyle({ emissive })` 互相覆盖，合批设备还要写实例属性）。API 见 [api.md](../api.md) §1.9，实现在 `src/post/`。

- **两个槽位**：`entity.effects`（用户 / 业务设的，如告警 `{ outline: 'alarm', glow: 0.6 }`）和内部的 `entity.highlight`（`IndoorManager` 按 `selectOutline` / `hoverOutline` 设）。描边取 `highlight ?? effects.outline`，发光只看 `effects`；取消选中后自己的描边自动回来，同"层级半透明与用户样式分开"的做法。
- **范围**：实体和它下面正在显示、未被剔除的内容（`collectDrawables`）：选中楼层描整层，选中合批设备只描它自己的实例（按实例矩阵单独画一次，不拆批）。从外面看建筑时设备是隐藏的，所以不画。
- **登记**：`effects` / `highlight` 变化经建筑根上的 `onEffects`（内部）通知 `IndoorManager`，它维护 `markedEntities`，viewer 每帧只遍历这些实体；移除建筑时清掉。
- **不要**为了高亮去改 `setStyle({ emissive })` 或网格材质；要换选中的样子，改 `indoor.selectOutline` 或 `viewer.effects.defineOutline('select', …)`。

### 5.6 楼层环境光遮蔽（M3.4）

楼层地面沿墙根、柜体和桌子周围柔和变暗，墙面底部随高度淡出（`indoor/FloorOcclusion.ts`，API 见 [api.md](../api.md) §1.10）。默认开，`viewer.indoor.ambientOcclusion.enabled = false` 关闭。

- **烘焙**（每层一次，GPU）：楼层显示着、还没有烘焙或内容变了时，`IndoorManager.update` 每次开始一层：
  1. 把楼层上立着的东西（墙、柱、门、窗、合批设备的实例、楼层模型）按楼层本地坐标放进一个临时场景，正交相机从 `height`（默认 1.8 m）高处朝下看，画一张覆盖楼层范围的遮挡图（纹素约 8 cm，长边不超过 `maxResolution`）。相机在 `height` 处切开了墙这类封闭体，从上面看进去是它们朝内的面，所以规则是**"背面，或高于地面 5 cm 的正面"算遮挡物**；楼板、房间地面（朝上的正面，贴着地面）不算。楼板底面在地面 1.5 cm 以下，被远平面切掉。
  2. 两次可分离滤波：接触项是高斯加权的**最大值**（σ = 半径的一半，至多 5 个纹素）：只看到最近遮挡物的距离，所以 14 cm 的薄墙和柜子一样能把墙根压暗；柔和项是高斯**平均**（σ = 半径）：周围立着的东西越多越暗，墙角、桌下最明显。遮挡 = min(1, 0.6 × 接触 + 0.8 × 柔和)。
  3. 结果读回 CPU（`readRenderTargetPixelsAsync`，一两帧后到达），存成单通道 `DataTexture`：第 0 行是楼层 -y 边，两个后端都一样。不直接把渲染目标挂到材质上：经 `materialReference` 采样渲染目标纹理时，实测两个后端的上下方向都和预期相反、手动翻转也不可靠（AGENTS.md §7）。
- **接收**：所有接收网格共用一个 `colorNode`（漫反射颜色 × (1 − 强度 × 遮挡 × 权重)），贴图、范围、强度是材质属性（`materialReference`），网格到楼层本地坐标的变换是逐对象 uniform（`mesh.userData.floorAoMatrix`），所以只编译一次着色器。权重：朝上、离地 10 cm 以内的面取满，35 cm 以上为 0（桌面、窗台不暗）；竖直的面在法线前方 15 cm 处取样，随高度在 `radius` 内淡出；朝下的面为 0。
- **哪些网格**（`mesh.userData.aoRole`）：`'floor'` 只接收（楼板、房间地面、`kind: slab` 构件），`'occluder'` 只投射（窗；设备一律只投射），没写的两者都是（墙、柱、门、楼层模型的网格）。只有节点材质且没有自己 `colorNode` 的材质能接收；楼层、外壳和不能合批的设备的 glTF 材质在加载时转成节点材质（渲染器本来在第一次绘制时做同样的转换），所以楼层模型的地面和墙也会接收。
- **什么时候重新烘焙**：`Building.contentVersion(floor)` 变了：楼层模型加载或卸载、楼层上的设备模型到达、楼层内实体的 `visible` 或 `refreshTransform()`（楼层、建筑自身的显隐是层级切换，不算）。改动稳定 250 ms 后才重新烘焙（拖动设备时不会每帧重烘），烘焙期间沿用旧贴图。改 `radius` / `height` / `texelSize` / `maxResolution` 后显示着的楼层立即重新烘焙；改 `intensity` 只改材质参数。隐藏的楼层保留贴图，移除建筑时释放。
- **代价**（2026-11-19，RTX 4060 笔记本，示例办公楼，每层 796 × 346 纹素）：每层主线程 3–4 ms（WebGPU）/ 5–7 ms（WebGL），读回在 10–170 ms 后到达（第一层含着色器编译）；5 层贴图共 1.4 MB，计入 `viewer.memory.buildings`。每帧只是接收材质多一次贴图采样。
- **对楼层模型的要求**：地面朝上、在楼层标高处；墙、柜体做成封闭体（单面片的墙从上面看是一条线，投不出遮挡）；楼板底面至少在地面 2 cm 以下（更薄的地面底面会被当成遮挡物，整层变暗）。见 [建筑数据制作手册](../building-data-manual.md) §7.1。

### 5.7 日照阴影与透明（M3.9）

打开真实光照（`viewer.lighting`）时，建筑和设备投下日照阴影（`viewer.shadows`，API 见 [api.md](../api.md) §1.11）；透明表面可选顺序无关混合（`viewer.transparency`）。

- **谁投影、谁接收**：程序生成的楼板、墙、房间、构件、外壳，楼层 / 外壳 / 设备的 glTF，以及设备批次（`BatchMesh`）都是 `castShadow` + `receiveShadow`（`Building` 的 `shadowed()`、`BatchMesh` 构造、`adoptModelMaterials`）。画阴影图时跳过透明材质：玻璃外壳、窗、层级里半透明的兄弟房间（`levelOpacity` < 1 的实体变成透明材质）都不挡光，阳光能从窗户照进房间。被层级隐藏的楼层不画，所以进入某层时，上面几层不再遮住它（"揭开屋顶"的样子，和楼层视角一致）。
- **范围**：每栋显示着的建筑按文档的平面范围（外轮廓、楼层轮廓、房间，外扩 2 m）和标高范围（最低楼板到屋顶，含楼层展开的间距）算一个局部包围盒（`Building.shadowBounds`），阴影图按这些包围盒的足迹 ∩ 视锥足迹适配，光源坐标系挂在进入的建筑（否则最近的建筑）的锚点上。glTF 外壳明显超出文档平面范围时，超出部分的影子可能被裁掉。
- **何时重画**：建筑经实体发生的变化（显隐、样式、移动、模型加载 / 卸载、层级切换、楼层展开、贡献剔除）都让阴影图在下一帧重画；直接改了建筑网格（不经实体 API）后调用 `viewer.shadows.invalidate()`。
- **透明顺序无关混合**：开了 `viewer.transparency.orderIndependent`（WebGPU）时，带 `userData.entity` 的网格和设备批次中的透明材质走 OIT，宿主自己的物体不受影响。
- **对数据的要求**：不用额外字段。窗、玻璃隔断做成透明材质（`kind: window` 默认就是）就不会挡光；单面片的屋顶 / 楼板也能投影（阴影图两面都画）。

## 6. 层级控制

### 6.1 切换流程

`enter(target)` 先求当前层级与目标的公共祖先，然后：

1. 从当前层级往上逐级离开，直到公共祖先（不含）：对每一级执行层级控制的 `resetEffect`、恢复 `configureCamera` 改过的相机参数，然后触发 `leaveLevel`。
2. 从公共祖先往下逐级进入，直到目标：每一级触发 `beforeEnterLevel`，执行 `setEffect` 和 `configureCamera`，再触发 `enterLevel`。往上返回时，目标就是公共祖先本身，它会被重新进入一次。
3. 在终点（`jumping: false` 时是每一级）先等待该层级的 glTF 模型挂好（最多 `modelWaitMs`，默认 1500 ms），再飞行。房间、设备、构件在终点被选中。

新的 `enter()` 会取消进行中的切换：旧的切换停在已完成的那一步（状态是一致的），它的 Promise 以 false 结束。监听器里调用 `enter()` 也一样。

视点缓存：从某一级往下钻时，记住当前相机位姿；之后返回这一级时飞回这个位姿（只用一次）。从地球进入时，只有相机离建筑不远（50 倍包围半径以内，至少 5 km）才记住，否则返回地球时取建筑的远景。建筑贴地抬升时，缓存的位姿跟着平移。

### 6.2 内置控制

按 `condition` 选择器匹配，`priority` 大者优先，同优先级后注册的优先。内置控制以标签 `builtin` 注册：

| 控制 | 条件 | 进入时（`setEffect`） | 离开时（`resetEffect`） | 默认取景（俯仰、距离） |
| --- | --- | --- | --- | --- |
| building | `.building` | 隐藏外壳，显示全部楼层（`expandFloors` 时展开），按 `hideTilesetsIndoor` 隐藏 3D Tiles | 恢复外壳、隐藏楼层、收拢，显示 3D Tiles | −35°，2.8 倍半径（半径至少按 30 m 算） |
| floor | `.floor` | 只显示本层，收拢 | 显示全部楼层 | −55°，2.1 倍（至少 15 m） |
| placement | `.room, .thing, .element` | 同层其他实体设为 25% 不透明度（`levelOpacity`）。房间保留它本身和位于其中的设备、构件；设备保留它本身和所在房间；带 `structure` 的不变 | 恢复同层不透明度 | 房间 −50°、3 倍（至少 7 m）；设备 −35°、7 倍（至少 3 m）；构件 −40°、5 倍（至少 3 m） |

取景用"最近对角视点"：在包围球周围取 4 个候选位置（相对建筑 +Y 轴 45° / 135° / 225° / 315°），选离当前相机最近的一个，所以每次都落在规整的四分之三视角上，相机移动最少。距离以 60° 视场为准，再乘 `tan(30°) / tan(fov / 2)`，换视场后主体在画面中的大小不变。实体有 `viewpoint` 时覆盖对应字段。

没有任何控制匹配时用 `basicLevelControl`：没有效果，拾取映射和取景用默认规则。

### 6.3 拾取映射（`filterObject`）

悬停、单击、双击都先把拾取到的实体映射为当前层级下的交互单元，规则同 ThingJS，交互单元始终是"下一个可以进入的层级"：

- 在地球层级：整栋建筑。
- 命中当前层级本身或它的祖先（例如房间层级下点到楼板）：就是它自己。
- 命中当前层级的后代：路径上当前层级的直接子节点（建筑层级点到房间 → 楼层）。
- 命中别处（同级房间、其他楼层、其他建筑）：公共祖先下那一支的根。
- 结果带 `structure` 标签时为 null（不交互）。

`nextLevel(hit)`（双击要进入的层级）就是映射结果，等于当前层级时为 null。

### 6.4 自定义控制

```ts
import { defaultFilterObject, framedView } from './indoor/LevelControl';

viewer.indoor.registerLevelControl(
  {
    condition: '.room && tags:or(server)',
    priority: 10,
    setEffect: ({ object }) => object.setStyle({ color: '#7c3aed' }),
    resetEffect: ({ object }) => object.setStyle({ color: null }),
    filterObject: (hit, ctx) => defaultFilterObject(hit, ctx.object),
    viewFor: (entity, ctx) => framedView(entity, ctx, { pitch: -70, radii: 2, minRadius: 6 }),
    configureCamera: () => {
      const c = viewer.controller;
      const saved = c.pitchRangeDeg;
      c.pitchRangeDeg = [-90, -30];
      return () => (c.pitchRangeDeg = saved);
    },
  },
  'my-app',
);
viewer.indoor.unregisterLevelControls('my-app');
```

`LevelContext` 提供 `object`（该控制负责的层级）、`origin` / `target`（切换的起点和终点）、`indoor`、`camera`、`ellipsoid`。`setEffect` / `resetEffect` 可以返回 Promise，切换会等它完成。效果要写成幂等的绝对状态：返回上级时会重新进入父级，`indoor.refresh()` 和改 `expandFloors` 也会把当前路径上的 `setEffect` 从上到下重跑一遍。`viewFor` 返回 null 表示该层级不飞行。

### 6.5 层级绑定（`indoor.bindings`）

**一棵层级树，多种内容。** 层级树只有一棵：地球 → 建筑 → 楼层 → 房间 / 设备，节点是 BIM 实体。实景数据（高斯泼溅、倾斜摄影）和其他图层不是层级，也不另起一棵平行的树，而是**绑定在某个节点上的内容**：所在层级决定它什么时候显示，实体自己的模型可以在它显示时让位。这样分工：

| | 实体（BIM） | 绑定的内容（泼溅、3D Tiles、宿主自己的对象） |
| --- | --- | --- |
| 提供 | 语义：编号、分类、属性、选择器、事件、顶牌、进出层级、取景 | 外观：真实的样子 |
| 拾取 | 点到内容等于点到它的实体（`pickEntity`） | 给出命中点 |
| 显隐 | 层级控制（§6.2）决定 | 绑定规则决定，跟着层级走 |

为什么不让泼溅场景自己成为一个层级（与建筑并列）：层级带着进出、路径、事件、选择器、顶牌这一整套，再来一棵树就要把它们复制一遍并保持同步；而泼溅文件内部没有结构（没有"房间"可进），人们要的是"看到**这个层级**真实的样子"。只有实景、没有 BIM 的场地，做法见本节末尾。

```ts
// 图层的 level 选项（高斯泼溅、3D Tiles 都有）
viewer.addSplats({ url: 'f3.spz', level: { entity: 'F3', position: [0, 0, 0], entityOpacity: 0 } }); // 三层的实景：进入三层时加载并显示，模型隐去但仍可交互
viewer.addSplats({ url: 'shell.spz', position: { longitude, latitude }, level: { entity: 'office-a' } }); // 外立面实景：在楼外时显示
viewer.addTileset({ source, level: { entity: 'office-a', show: 'outside' } }); // 这栋楼自己的倾斜摄影
viewer.addTileset({ source, level: { show: 'always' } }); // 进楼也不隐藏的 3D Tiles

// 宿主自己的东西
viewer.indoor.bindings.bind(mesh, { entity: 'F3', show: 'inside' }, { onChange: (b) => (mesh.visible = b.shown) });
```

`LevelBindingOptions`：

| 字段 | 说明 |
| --- | --- |
| `entity` | 内容属于哪个节点：实体，或它的 `id`。按 id 绑定可以早于建筑加载（"先绑定、后加载"），建筑移除后绑定保留，同 id 的建筑再加载时重新接上。不写（或 null）表示地球：内容不属于任何实体，但同样按层级显隐 |
| `show` | 何时显示（下表），或一个函数 `({ entity, current, relation, visible }) => boolean`。默认：建筑 `'outside'`，楼层 / 房间 / 设备 `'inside'`，不绑实体 `'current'`（只在地球层级） |
| `entityOpacity` | 内容显示**且已就绪**时，实体及其下级自身几何的不透明度，0–1（默认 1 不变）。小于 1 时模型让位；0 时完全看不见，但仍然被拾取、描边、带顶牌 |

| `show` | 显示的条件 | 典型用途 |
| --- | --- | --- |
| `'inside'` | 所在层级是该实体或它的下级 | 楼层、房间的室内实景 |
| `'current'` | 所在层级正是该实体 | 只在这一级看的内容 |
| `'outside'` | 所在层级不是该实体及其下级，且实体本身可见 | 建筑的外立面实景、它自己的倾斜摄影 |
| `'entity'` | 实体可见时（跟着层级控制走，像实体自己的网格一样） | 摆在房间里的一件实物 |
| `'always'` | 实体存在时 | 不受层级影响 |

规则（`levelBinding.ts`，纯函数 `levelRelation` / `levelShown`，有单测）：

- `relation`：所在层级就是该实体为 `'at'`，在它下面为 `'below'`，其余（地球、兄弟、**它的祖先**）都是 `'outside'`。地球（不绑实体）包含一切层级：在地球层级是 `'at'`，进了任何层级是 `'below'`。
- 求值时机：层级切换的每一步（`current` 改变后、`enterLevel` / `leaveLevel` 事件之前），以及每帧 `indoor.update`（实体被代码隐藏、建筑增删都能跟上）。所以内容和层级效果同一帧切换，切换过渡（§7.1）截到的是切换前的完整画面。
- `entityOpacity` 是实体上独立的一个系数（`bindingOpacity`，内部），与用户样式的不透明度、层级的同级半透明（`levelOpacity`）三者相乘，互不覆盖；多个绑定重叠时取最小值。它只在内容"确实在屏幕上"时生效（图层已加载且没有被用户隐藏），所以懒加载期间看到的仍是模型，不会出现"模型隐去、实景还没到"的空白。
- 不透明度为 0 的实体仍然绘制（全透明、不写深度），所以 CPU 射线和 GPU 拾取缓冲都还认它，描边遮罩也照常：实景做外观、BIM 做语义的"隐形代理"就是这样实现的。

**图层这一侧**（[splats.md](splats.md) §7.1）：高斯泼溅图层还可以**放进实体的坐标系**（`level.position`，米）。这样它跟着实体走：建筑贴地抬升、楼层展开时一起移动；`heading` 等角度相对该坐标系。绑定的图层默认**懒加载**（第一次显示时才下载）。3D Tiles 只绑显隐（瓦片自带地理位置）。没有绑定的图层保持原来的规则：进入建筑时随 `hideTilesetsIndoor` 隐藏。

**文档里声明**：任何元素都可以带 `splats`（§4），加载建筑时自动建图层并绑定，移除建筑时一并移除。

**只有实景、没有 BIM 的场地**：写一份最小的建筑文档（轮廓 + 一层），把场景声明在建筑或楼层上并设 `entityOpacity: 0`。文档提供层级节点、包围范围和拾取代理，于是进出层级、顶牌、取景、返回都照常工作，画面上只有实景。

## 7. 默认交互与可见性

| 操作 | 结果 |
| --- | --- |
| 双击建筑（地球层级） | 进入建筑：隐藏外壳，显示全部楼层（可展开），压制 3D Tiles，相机取最近的对角视点 |
| 双击楼层 / 楼层按钮 | 进入楼层：只显示该层，显示房间顶牌，相机俯视约 55° |
| 双击房间 / 设备 | 进入并选中，同层其他实体变为 25% 不透明度，相机拉近 |
| 单击 | 选中映射后的交互单元（地球层级是整栋，建筑层级是楼层），弹出属性面板；单击顶牌选中顶牌所属的实体 |
| 悬停 | 描边映射后的交互单元（`indoor.hoverOutline`；当前所在层级本身和建筑不描边） |
| 右键单击 / Esc / 面包屑 / ‹ 按钮 | 返回上一级（Esc 先关闭属性弹窗） |

顶牌盖在 canvas 上。实体顶牌的单击、双击、右键单击经 `MarkerManager.eventProxy` 转成 `viewer.interaction` 上对该实体的事件（`event.marker` 指向顶牌），所有监听器都能收到；滚轮会转发给 canvas。

上表的内置行为注册在 `tag: 'indoor'`（双击进入、右键返回、单击选中）和 `tag: 'indoor-hover'`（悬停高亮）上，可以整体暂停：

```ts
// 弹窗打开期间：不选中、不进出层级，相机双击飞近也不生效
const resume = viewer.interaction.pause({ tag: 'indoor', blockDefault: true });
// 只屏蔽某个范围：楼层内的单击
viewer.interaction.pause({ type: 'click', selector: '.floor' });
resume(); // 或 viewer.interaction.resume() 撤销全部
```

暂停不挡默认行为（相机双击飞近），需要时加 `blockDefault: true`。`selector` 按命中的实体（或其祖先）判断，点到地球、3D Tiles 或空白处不受影响。Esc 返回由演示应用（`main.ts`）的键盘监听处理，不经过 `interaction`，不受暂停影响。

### 7.1 切换过渡与无地表背景

- **上一帧按深度重投影后溶解**（`viewer.levelTransition`，`post/LevelTransition.ts`，2026-11-18 起取代 DOM 版 `FrameCrossfade`）：层级切换会改变显示内容时（压制 3D Tiles、隐藏外壳、切换楼层、同级半透明），先截下当前画面和它的深度（后期管线画出的显示画面，画面静止时直接用超采样的结果；都在 GPU 上，不读回 CPU），之后 450 ms 内逐帧把它叠在新画面上并淡出（先快后慢），相机同时开始飞行。
  - 重投影：每 4 CSS 像素一个网格点，按截帧时的深度还原成旧相机下的位置，再用当前相机投影（矩阵"新投影 × 新视图 × 旧相机"在 CPU 上用 float64 算，平移量只是相机的位移，float32 足够；单测在北京 ECEF 坐标下与直接投影相差不到 0.05 像素）。所以旧画面随相机飞行一起缩放、移动，消失的外壳、楼层留在原处溶解，地面不会出现两层错开的网格；DOM 版是把截图钉在屏幕上，相机一动新旧两层就错开。
  - 天空按方向（只随相机转动）重投影；深度跳变处（轮廓对着远处背景）只丢掉背景一侧的三角形，前景保留完整轮廓，那里直接显示新画面。
  - `reproject = false` 退回不重投影的整屏溶解；`duration = 0` 关闭；重新进入当前层级、`transition: false`、移除建筑时不过渡。面板"层级切换淡入淡出"。顶牌是 DOM，不参与过渡。
  - 它是后期管线 display 阶段的 `transition` 效果（调色之后、描边之前，新层级的描边清晰地画在溶解的旧画面上），过渡开着就一直在节点图里（不过渡时只采样一张 1×1 的透明纹理），开始过渡不会重编最后的全屏 pass；截帧目标和网格只在过渡期间存在（显存见 gpu-memory.md）。
- **短途注视飞行**：层级之间的飞行都带注视点（取景目标，返回时用缓存视点记下的屏幕中心点），短途时主体始终在画面里，见 [camera-controller.md](camera-controller.md) §4。
- **展台背景**（`viewer.backdrop`，`IndoorBackdrop`）：进入建筑后，如果周围什么都不画（地球隐藏，且没有显示中的 3D Tiles，例如 Google 3D Tiles 被压制），就在建筑下方铺一块地面：1 m / 10 m 网格（离建筑越远越淡）、建筑轮廓下的接触阴影、向地平线渐亮；背景换成与界面一致的深色渐变天空，地平线处有微光。地面按建筑锚点 ENU 定向，放在最低可见楼层以下 0.35 m（进入地下室时跟着下移），半径至少 4 km，边缘透明融入背景；不参与拾取。显示和隐藏都有 0.35 s 渐变。`viewer.indoorBackdrop = false` 关闭，面板"无地表时显示展台背景"。
- **无地球时的手势**：光标下落空时，相机拾取用建筑地面高度的参考面，抓地平移、右键环绕、滚轮缩放都正常；相机不能低于建筑地面。见 camera-controller.md §3.4。
- 无地球时建筑贴在 3D Tiles 表面上（`viewer.surfaceHeight`）；进入建筑压制 3D Tiles 后沿用压制前测到的高度，地表数据不可靠时保持当前高度，不会被拉回椭球面 0 m。还没贴过地就进入了建筑（如 `?demo`）时，3D Tiles 在后台继续加载但不绘制，拿到可靠高度后建筑落地、相机随之平移（见 roadmap.md ISSUE-1）。展台背景和参考地面都以这个高度为准。

## 8. 扩展守则

- 新增实体类型：先扩展 `EntityType` 和 `schema.ts`，在 `Building` 中构建，再按需要注册层级控制（§6.4）或在 `LEVEL_FRAMING` 里补默认取景，最后同步本文与测试。
- 实时数据（如 IoT 状态）：更新 `entity.properties`，调用 `setStyle()` 改颜色；顶牌内容改变后调用 `marker.invalidateSize()`。
- 大规模设备（成千上万个）：设备已按楼层合批（§5.2），1 万个设备约 40 次绘制。新增设备类的构建要走 `InstanceBatcher.add`（给出几何键、基础材质键和 `BaseLook`），不要给设备单独建网格；需要逐实例的新外观参数时扩展 `bimStyle` 与 `resolveLook`，不要克隆材质。
- 让层级之外的东西（图层、宿主自己的对象）跟着层级显隐：用层级绑定（§6.5），不要在 `enterLevel` 监听里手写显隐，也不要为它新建一种实体类型或另一套层级。新的图层类型要支持绑定时：选项里加 `level?: LevelBindingOptions`，创建时 `indoor.bindings.bind(layer, options, { showing })`，每帧读 `bindings.get(layer)?.shown`，移除时 `unbind`（参照 `GeoViewer.hiddenByLevel`）。
- 层级效果写在层级控制里，不要在别处直接改楼层的 `group.visible`；同级半透明用 `levelOpacity`，不要占用 `setStyle` 的 `opacity`（那是用户样式）。
- 新增建筑网格时设 `castShadow` / `receiveShadow`（用 `Building.ts` 的 `shadowed()`），透明的东西自然不投影（§5.7）。
- 新增楼层上的网格（新构件种类、新的程序几何）：想清楚它在楼层 AO 里的角色（§5.6），贴着地面的面设 `mesh.userData.aoRole = 'floor'`，透明或不该变暗的设 `'occluder'`；材质用 `Building.ts` 的 `material()`（节点材质，带空气透视）。改了楼层上的内容又不经过 `visible` / `refreshTransform()` / 模型加载时，调 `building.floorContentChanged(entity)`（内部）让 AO 重新烘焙。

## 9. 路线图

- 层级绑定已完成（§6.5，2026-11-23）：高斯泼溅和 3D Tiles 绑到层级节点，文档里声明 `splats`。以后可做：点位图层和 GeoJSON 图层的 `level` 选项；绑定内容计入实体的包围范围（现在取景只看实体自己的几何）；隐藏已久的绑定图层按预算卸载（同楼层模型，§5.4）；通用的层级节点（园区 / 场地，不必是建筑）；实景与模型的对齐工具（点对解算位置、朝向、尺度）。

- 日照阴影、透明顺序无关混合已完成（§5.7，M3.9）。以后可做：透明物体按透明度投出浅影（彩色玻璃）、3D Tiles 作为遮挡物投影到建筑上（每次重画要画大量瓦片，按需评估）。
- 楼层环境光遮蔽已完成（§5.6，M3.4）。以后可做：透明物体（玻璃隔断）按透明度投射、按房间分区烘焙超大楼层、楼层模型的单面片墙（需要按法线朝向补厚度）。
- IFC 直读（web-ifc）；楼层模型使用 3D Tiles 或 glTF LOD。楼层模型按需加载、按预算卸载已完成（§5.4）。
- 剖切面 / 剖切盒（ThingJS"剖切"）、室内导航（路网 + A*）、热力图和点位聚合。
- 顶牌的遮挡判断（深度采样）。设备实例化渲染已完成（§5.2）。
