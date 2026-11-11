# 室内与 BIM 模型规范

代码：`src/indoor/schema.ts`（格式与校验）、`src/indoor/selector.ts`（选择器编译）、`src/indoor/BimEntity.ts`（实体、样式、标签）、`src/indoor/EntitySet.ts`（查询结果）、`src/indoor/Building.ts`（构建与地理定位）、`src/indoor/LevelControl.ts`（层级控制策略）、`src/indoor/levelView.ts`（取景）、`src/indoor/IndoorManager.ts`（层级路径切换、视点缓存、拾取、顶牌）、`demo/data/demoBuilding.ts`（示例，不进包）。UI：`demo/ui/IndoorPanel.ts`。测试：`tests/indoor.test.ts`、`tests/selector.test.ts`、`tests/interaction.test.ts`。

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

所有元素（建筑、楼层、房间、设备、构件）都可以带这两个可选字段：

| 字段 | 说明 |
| --- | --- |
| `tags` | 字符串数组。墙、楼板、柱子自动带 `structure` 和自身类别（`wall` / `slab` / `column`），门窗等构件带自身类别。带 `structure` 的实体在楼层、房间层级不参与交互 |
| `viewpoint` | `{ heading, pitch, range }`：进入该层级时的视点。`heading` 是相对建筑本地 +Y 轴顺时针的角度（度；建筑朝向为 0 时就是相对正北），`pitch` 为 −90..90 度（负值向下看），`range` 是到实体包围球中心的距离（米）。缺的字段用该层级的默认取景（§6.2） |

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
viewer.indoor.select(entity);                     // 高亮并弹出属性
viewer.indoor.filterObject(hit);                  // 当前层级下，拾取到的实体对应的交互单元
viewer.indoor.expandFloors = true;                // 楼层展开（建筑层级生效）
viewer.indoor.showLabels = false;
viewer.indoor.events.on('enterLevel', ({ object, previous, next, path }) => { /* ... */ });
viewer.flyToEntity(entity, { pitch: -40 });       // camera.fit
```

`enter(target, options)` 的选项：`fly`（默认 true）、`duration`（秒）、`jumping`（默认 true，只在终点飞行；false 时每进入一级都飞一次）、`transition`（默认 true，切换时淡出上一帧，见 §7.1）。

`BimEntity`：`id` `type` `name` `category` `properties` `tags` `viewpoint` `label` `parent` `children` `group`，以及 `setStyle({ color, opacity, emissive })`、`levelOpacity`（层级效果用的不透明度系数，与样式相乘）、`visible`、`effectivelyVisible`、`worldBounds()`、`labelPosition()`、`closest(type)`、`traverse(cb)`、`isDescendantOf(e)`、`meshes`（自有网格）、`instances`（合批实例，§5.2）、`refreshTransform()`（改了合批实体 `group` 的位姿后调用）。

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
- **逐实例样式**：颜色走 three 的 `instanceColor`（乘到漫反射上，贴图照常），发光和不透明度走实例属性 `bimStyle`（rgb = emissive，a = opacity），材质用 `referenceAttribute('bimStyle')` 按对象读取，所以所有批次共用一个着色器。共享材质本身的颜色、发光为白、不透明度为 1，实例携带完整值。`setStyle`、`levelOpacity`、悬停 / 选中高亮、选择器查询的行为与逐网格时一致：样式规则只写在 `resolveLook`（`BimEntity.ts`）一处，网格和实例共用。
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

## 7. 默认交互与可见性

| 操作 | 结果 |
| --- | --- |
| 双击建筑（地球层级） | 进入建筑：隐藏外壳，显示全部楼层（可展开），压制 3D Tiles，相机取最近的对角视点 |
| 双击楼层 / 楼层按钮 | 进入楼层：只显示该层，显示房间顶牌，相机俯视约 55° |
| 双击房间 / 设备 | 进入并选中，同层其他实体变为 25% 不透明度，相机拉近 |
| 单击 | 选中映射后的交互单元（地球层级是整栋，建筑层级是楼层），弹出属性面板；单击顶牌选中顶牌所属的实体 |
| 悬停 | 高亮映射后的交互单元（当前所在层级本身不高亮） |
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

- **淡出上一帧**（`viewer.levelTransition`，`FrameCrossfade`）：层级切换会改变显示内容时（压制 3D Tiles、隐藏外壳、切换楼层、同级半透明），先同步渲染一帧，拷到盖在 canvas 上的 2D 画布，再用 CSS 不透明度过渡在 450 ms 内淡出，相机同时开始飞行。重新进入当前层级、`transition: false`、移除建筑时不淡出。`duration = 0` 关闭。面板"层级切换淡入淡出"。顶牌在它上面，不参与淡出。
- **短途注视飞行**：层级之间的飞行都带注视点（取景目标，返回时用缓存视点记下的屏幕中心点），短途时主体始终在画面里，见 [camera-controller.md](camera-controller.md) §4。
- **展台背景**（`viewer.backdrop`，`IndoorBackdrop`）：进入建筑后，如果周围什么都不画（地球隐藏，且没有显示中的 3D Tiles，例如 Google 3D Tiles 被压制），就在建筑下方铺一块地面：1 m / 10 m 网格（离建筑越远越淡）、建筑轮廓下的接触阴影、向地平线渐亮；背景换成与界面一致的深色渐变天空，地平线处有微光。地面按建筑锚点 ENU 定向，放在最低可见楼层以下 0.35 m（进入地下室时跟着下移），半径至少 4 km，边缘透明融入背景；不参与拾取。显示和隐藏都有 0.35 s 渐变。`viewer.indoorBackdrop = false` 关闭，面板"无地表时显示展台背景"。
- **无地球时的手势**：光标下落空时，相机拾取用建筑地面高度的参考面，抓地平移、右键环绕、滚轮缩放都正常；相机不能低于建筑地面。见 camera-controller.md §3.4。
- 无地球时建筑贴在 3D Tiles 表面上（`viewer.surfaceHeight`）；进入建筑压制 3D Tiles 后沿用压制前测到的高度，地表数据不可靠时保持当前高度，不会被拉回椭球面 0 m。还没贴过地就进入了建筑（如 `?demo`）时，3D Tiles 在后台继续加载但不绘制，拿到可靠高度后建筑落地、相机随之平移（见 roadmap.md ISSUE-1）。展台背景和参考地面都以这个高度为准。

## 8. 扩展守则

- 新增实体类型：先扩展 `EntityType` 和 `schema.ts`，在 `Building` 中构建，再按需要注册层级控制（§6.4）或在 `LEVEL_FRAMING` 里补默认取景，最后同步本文与测试。
- 实时数据（如 IoT 状态）：更新 `entity.properties`，调用 `setStyle()` 改颜色；顶牌内容改变后调用 `marker.invalidateSize()`。
- 大规模设备（成千上万个）：设备已按楼层合批（§5.2），1 万个设备约 40 次绘制。新增设备类的构建要走 `InstanceBatcher.add`（给出几何键、基础材质键和 `BaseLook`），不要给设备单独建网格；需要逐实例的新外观参数时扩展 `bimStyle` 与 `resolveLook`，不要克隆材质。
- 层级效果写在层级控制里，不要在别处直接改楼层的 `group.visible`；同级半透明用 `levelOpacity`，不要占用 `setStyle` 的 `opacity`（那是用户样式）。

## 9. 路线图

- IFC 直读（web-ifc）及按楼层流式加载；楼层模型使用 3D Tiles 或 glTF LOD。
- 剖切面 / 剖切盒（ThingJS"剖切"）、室内导航（路网 + A*）、热力图和点位聚合。
- 顶牌的遮挡判断（深度采样）。设备实例化渲染已完成（§5.2）。
