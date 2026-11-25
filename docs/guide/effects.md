# 描边、调色与自定义对象

这一章的主体是**把你自己的 three.js 对象放到地球上**：坐标系怎么建、什么时候要通知 viewer 重画、glTF 模型怎么摆、它们和 SDK 的拾取、阴影等功能是什么关系。后半部分是画面层面的工具：描边与发光、调色、静止超采样、透明顺序无关混合，以及自定义后期效果。

BIM 实体（建筑、楼层、房间、设备）的描边和发光用实体自己的 `entity.setEffects()`，见[建筑、层级与实体](./indoor.md)；这里的 `viewer.effects` 管的是你自己加进场景的对象。

## 在地球上放自己的 three.js 对象

`viewer.scene`、`viewer.camera`、`viewer.renderer` 是 three.js 的场景、相机和渲染器（**高级 API**：直接接触引擎对象，次版本可能调整）。往场景里加对象和普通 three.js 程序一样，只是有三条规矩：

1. **顶点用局部坐标，原点放在对象的 `position` 上。** 世界坐标是 ECEF（米），数值在 640 万左右，float32 的顶点只有半米精度。网格的 `position` 设成一个附近的 ECEF 原点（JavaScript 的 number 是 float64，模型视图矩阵也在 CPU 上以 float64 计算），顶点用相对原点的米数。
2. **用东北天（ENU）坐标系摆放**：X 朝东、Y 朝北、Z 朝上。three.js 的很多几何体（圆柱、圆锥、glTF 模型）默认 Y 朝上，要转一下。
3. **绕过 SDK 直接改了 three.js 对象后，调用 `viewer.requestRender()`。** 画面静止后 viewer 不再重画，它看不到你对场景的改动（[基本概念](./concepts.md#画面什么时候重画)）。

### 东北天坐标系

`viewer.ellipsoid.eastNorthUpToFixedFrame(原点)` 给出某点的 ENU → ECEF 矩阵（平移部分就是原点），分解到一个 `Group` 上，之后组里的东西就按"东、北、上"摆放：

```ts
import { DEG2RAD } from 'terra-viewer';
import { CylinderGeometry, Group, Mesh, MeshStandardMaterial } from 'three';

const longitude = 116.3915, latitude = 39.9925; // 度

const site = new Group();
const ground = viewer.surfaceHeight(longitude, latitude); // 地面的椭球高（米），带可信度
const origin = viewer.ellipsoid.cartographicToCartesian(longitude * DEG2RAD, latitude * DEG2RAD, ground.height); // 注意是弧度
viewer.ellipsoid.eastNorthUpToFixedFrame(origin).decompose(site.position, site.quaternion, site.scale);

const mast = new Mesh(new CylinderGeometry(1.2, 2.2, 48, 24), new MeshStandardMaterial({ color: '#cbd5e1' }));
mast.rotation.x = Math.PI / 2; // three.js 的圆柱沿 Y 轴，转到沿 Z 轴（朝上）
mast.position.set(0, 0, 24);   // 局部坐标，米：底面落在原点
site.add(mast);

viewer.scene.add(site);
viewer.requestRender();
```

在组内改位置、旋转都用局部量：`box.position.x += 10` 是向东 10 米，`box.rotation.z = -heading * DEG2RAD` 让朝北的物体转到航向 `heading`（度，自北顺时针；绕 +Z 的正旋转是逆时针）。

### 贴地

`viewer.surfaceHeight(经度, 纬度)` 返回当前能拿到的最好的地面高度：地球显示时用地形，地球隐藏时用可见 3D Tiles 的表面。刚启动时地形还很粗，结果带 `reliable: false`；地形加载得更精细，高度还会变几米。所以先放下，再在加载有进展时跟上可靠的新高度：

```ts
let placedHeight: number | null = null;
function placeOnGround() {
  const g = viewer.surfaceHeight(longitude, latitude);
  if (placedHeight !== null && (!g.reliable || Math.abs(g.height - placedHeight) < 0.05)) return;
  placedHeight = g.height;
  const origin = viewer.ellipsoid.cartographicToCartesian(longitude * DEG2RAD, latitude * DEG2RAD, g.height);
  viewer.ellipsoid.eastNorthUpToFixedFrame(origin).decompose(site.position, site.quaternion, site.scale);
  viewer.requestRender();
}
placeOnGround();
viewer.events.on('load-progress', placeOnGround);
```

已经知道椭球高（GNSS 测量、3D Tiles 里量出来的）就直接用，不必贴地。不要用 `viewer.globe.getHeight`：它只看地形，地球隐藏时没有结果。

### 让它动起来

```ts
// 一次性的改动：改完通知一次
box.rotation.z += 30 * DEG2RAD;
viewer.requestRender();

// 持续的动画：每帧都通知，否则画面静止后就停在某一帧
function spin() {
  ring.rotation.z += 0.02;
  viewer.requestRender();
  requestAnimationFrame(spin);
}
spin();
```

场景里有很多自己驱动的动画时，也可以创建时设 `idleFrameRate: 0`：viewer 每帧都画、永远不进入静止，代价是静止时也占着 CPU 和 GPU（[加载、错误与性能](./performance.md)）。

### glTF 模型

`viewer.loadModel(url)` 用 viewer 配好的加载器读 glTF / GLB（Draco、KTX2、Meshopt 都支持，解码器路径同 `decoderPath` / `transcoderPath`），返回模型的根对象（`gltf.scene`），**不做任何摆放**：

```ts
const model = await viewer.loadModel('/models/pump.glb');
model.rotation.x = Math.PI / 2;                // glTF 规定 Y 朝上，转成 Z 朝上；模型正面（glTF 的 +Z）随之朝南
const holder = new Group();
holder.rotation.z = -heading * DEG2RAD;        // 再按航向转（度，自北顺时针）
holder.add(model);
site.add(holder);                              // site 是上面建好的 ENU 组
viewer.requestRender();
```

要放进建筑、随楼层显隐、被点选的设备模型，写进建筑文档更合适（`model` 字段，见[建筑数据制作手册](../building-data-manual.md)）：SDK 会负责摆放、合批、按需加载和卸载。

### 和 SDK 功能的关系

你的对象就是场景里普通的 three.js 对象，SDK 的各项功能对它们的处理如下：

| 功能 | 对你的对象 |
| --- | --- |
| 精度 | 和 SDK 自己的网格一样：模型视图矩阵在 CPU 上以 float64 计算，按上面的方式摆放就不抖动 |
| 灯光 | 带光照的材质（`MeshStandardMaterial` 等）被照亮：地图模式下是相机上方的头灯和半球光，真实光照下是跟随大气的太阳光和天光 |
| 空气透视 | 不带。远处的自定义模型不会像地面和建筑那样变淡 |
| 日照阴影 | 不投影（阴影图只画建筑）；也不要给太阳光打开 three.js 自己的阴影图 |
| 拾取 | `viewer.pick` / `pickAt` 和 `viewer.interaction` 的事件**不会命中**你的对象，见下一节 |
| 局部场景 | 不被裁剪；需要时用 `viewer.localScene.contains(经度, 纬度)` 自己控制显隐 |
| 描边与发光 | 可以，`viewer.effects.set(对象, …)`，见下文 |
| 静止与重画 | 改动后调用 `requestRender()` |
| 释放 | 你创建的几何、材质、纹理由你释放；移除前先 `viewer.effects.set(对象, null)` |

移除：

```ts
viewer.effects.set(box, null); // viewer 对设了效果的对象保留着引用
viewer.scene.remove(site);
site.traverse((o) => {
  if (o instanceof Mesh) {
    o.geometry.dispose();
    o.material.dispose();
  }
});
viewer.requestRender();
```

### 点选自己的对象

SDK 的拾取只认地球、3D Tiles、建筑和高斯泼溅。要点选自己的对象，在 `viewer.interaction` 的事件里用 three.js 的 `Raycaster` 只对它们求交，再和事件拾取到的表面比远近（对象在表面之前才算点中）：

```ts
import { Raycaster, Vector2 } from 'three';

const raycaster = new Raycaster();
const ndc = new Vector2();
viewer.interaction.on('click', (e) => {
  const rect = viewer.canvas.getBoundingClientRect();
  ndc.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
  raycaster.setFromCamera(ndc, viewer.camera);
  const hit = raycaster.intersectObject(site, true)[0];
  const surface = e.point ? e.point.distanceTo(viewer.camera.position) : Infinity;
  if (hit && hit.distance < surface) console.log('点中了', hit.object.name);
}, { tag: 'my-objects' });
```

只对自己的对象求交，不要对整个 `viewer.scene` 做射线：地球瓦片、3D Tiles 的网格又多又大，而且 SDK 的拾取已经处理了显隐、裁剪和合批。

## 描边与发光

`viewer.effects` 给场景里的 three.js 对象加描边和发光（选择性泛光），不改对象的材质：

```ts
viewer.effects.set(box, { outline: 'select' });                 // 内置样式：select、hover、alarm
viewer.effects.set(beacon, { glow: 0.9, glowColor: '#f59e0b' }); // 发光强度 0..1
viewer.effects.set(box, { outline: null });                      // 合并：给 null 的字段清除
viewer.effects.set(box, null);                                   // 全部移除
viewer.effects.get(box);                                          // 当前效果
viewer.effects.clear();                                           // 清掉所有 three.js 对象的效果（实体不受影响）
```

效果覆盖对象及其子孙中可见的网格；实例化网格、蒙皮网格按普通几何画。

自定义描边样式，实体和对象都可以用：

```ts
viewer.effects.defineOutline('beacon', {
  color: '#fbbf24',       // 可见部分的边
  hiddenColor: '#92400e', // 被遮挡部分的边（透视显示）；不给就只描可见部分
  fill: 0.1,              // 可见表面的染色 0..1
  pulse: 1.6,             // 闪烁周期，秒；0 或不给是常亮
});
viewer.effects.set(tower, { outline: 'beacon' });
```

| 属性 | 说明 |
| --- | --- |
| `outlineWidth` | 描边宽度，CSS 像素，1–6（默认 2） |
| `glowStrength` | 光晕强度（默认 1） |
| `glowRadius` | 光晕扩散，0..1（默认 0.5） |
| `outlineNames`、`outlineStyle(name)` | 已定义的样式名、某个样式的设置 |

内置样式（`BUILTIN_OUTLINES`）：`select` 蓝色、透视、染色 0.18；`hover` 浅蓝；`alarm` 红色、透视、1.2 s 闪烁。

代价：有描边时每帧多画一次被标记的网格（小遮罩）和一次全屏边缘搜索；有发光时再加几个半分辨率的 pass。**闪烁的描边让画面一直在动**，有它在时 viewer 不进入静止。

## 调色

`viewer.colorGrading` 调整整幅画面的曝光、对比度和饱和度，创建时也可以传 `colorGrading`：

```ts
import { COLOR_GRADING_PRESETS } from 'terra-viewer';

viewer.colorGrading.set({ contrast: 1.1, saturation: 1.15 }); // 只改给出的项，超出范围的夹紧
viewer.colorGrading.set(COLOR_GRADING_PRESETS.vivid);         // 预设：neutral（默认）、vivid
viewer.colorGrading.reset();                                  // 回到中性
```

| 项 | 范围 | 说明 |
| --- | --- | --- |
| `exposure` | 0.1–4，默认 1 | 色调映射前的亮度倍数（就是渲染器的曝光，没有额外开销） |
| `contrast` | 0–2，默认 1 | 以中灰为中心的对比度 |
| `saturation` | 0–2，默认 1 | 0 为灰度 |

`vivid` 是对比度 1.05、饱和度 1.1，大屏上影像和模型不发灰。对比度和饱和度在色调映射之后、描边之前应用，描边颜色不受影响；都为 1 时没有开销，调节时不重编着色器。

## 静止超采样

画面安静 1 秒后，viewer 把相机错开不到一个像素再画十几帧、逐帧平均，得到比 MSAA 更平滑的边缘，然后停止重画（[加载、错误与性能](./performance.md)）。一般不用管它；需要时：

```ts
viewer.supersampling.enabled = false;  // 关掉：静止画面改为按 idleFrameRate 重画
viewer.supersampling.samples = 32;     // 每幅静止画面平均的帧数，4–64（默认有 MSAA 时 16、没有时 32）
viewer.supersampling.converged;        // 已画完、不再重画
```

截图（`viewer.captureFrame()`、`viewer.navigation.screenshot()`）在画面已超采样时直接输出超采样的结果。

## 透明顺序无关混合

建筑的玻璃幕墙、窗、层级里半透明的房间互相叠加时，按物体排序会在转动视角时跳变。`viewer.transparency` 让建筑和设备的透明表面改用加权混合 OIT，结果与绘制顺序无关：

```ts
viewer.transparency.orderIndependent = true; // 默认只在 ultra 档位开
viewer.transparency.supported;               // WebGPU 才支持；WebGL 后端保持按距离排序
```

代价是两张与画布同样大小、同样多重采样的缓冲（1080p 约 93 MB），所以默认只在 `ultra` 档开。它只处理建筑和设备，你自己的透明对象、云、注记照旧排序。加权混合是近似，适合玻璃这类低不透明度的场合。

## 自定义后期效果（高级）

每帧都经过后期管线 `viewer.postProcessing`：场景画进 HDR 目标 → `linear` 阶段的效果（色调映射前，光照类）→ 色调映射 → `display` 阶段的效果（色调映射后，叠加类）。实现 `PostEffect` 就能加自己的效果，节点用 TSL 写：

```ts
import type { PostEffect } from 'terra-viewer';
import { float, screenUV, vec4 } from 'three/tsl';

const vignette: PostEffect = {
  name: 'vignette',
  stage: 'display', // 色调映射之后
  order: 50,        // 同一阶段按 order 从小到大；内置调色是 0、描边是 100
  active: true,     // 为 false 时不运行、不花钱
  graphVersion: 0,  // 非 uniform 的设置变了就加一，节点图会重建
  build(input) {
    const d = screenUV.sub(0.5).length();
    return vec4(input.rgb.mul(float(1).sub(d.mul(d).mul(1.2))), input.a);
  },
  dispose() {},
};
viewer.postProcessing.add(vignette);
viewer.requestRender();
```

需要场景法线等额外输出时用 `attachments` 声明；自己画 pass 的效果实现 `prepare(frame)`，并用 `frame.camera` 画（静止超采样期间它带着亚像素平移）；会自己动的效果设 `animating`。**不要给场景材质设 `material.mrtNode`**：带自己 MRT 输出的材质会在拾取缓冲等所有渲染目标里替换输出。完整接口见 [API 参考 §1.9](../api.md#_1-9-描边、发光、调色与后期处理)。

## 示例

<ExampleFrame id="custom-objects" />

示例源码：[examples/custom-objects/main.ts](../../examples/custom-objects/main.ts)。在鸟巢北侧放了一座信号塔、一个机房和一个光环：可以开关描边和发光、旋转和移动机房、让光环逐帧转动，点击塔或机房会选中它，最后一组滑块是调色。
