---
layout: home

hero:
  name: TerraView
  text: WebGPU 优先的三维地球 SDK
  tagline: 从全球视角到街道，再无缝进入建筑、楼层、房间。基于 three.js，以 npm 包 terra-viewer 嵌入你的应用。
  actions:
    - theme: brand
      text: 快速开始
      link: /guide/getting-started
    - theme: alt
      text: 示例
      link: /examples/
      target: _self
    - theme: alt
      text: 在线演示
      link: /demo/
      target: _self

features:
  - icon: 🌏
    title: 行星尺度的地球
    details: WGS84 椭球、四叉树影像与全球地形，float64 精度从太空到街道都不抖动；加载不闪烁、不出空洞。
  - icon: 🌅
    title: 大气、光照与云
    details: 物理大气与昼夜晨昏，光照跟随大气，建筑的日照阴影，远看云壳、近看可以穿行的体积云。
  - icon: 🏙️
    title: 3D Tiles 与高斯泼溅
    details: OGC 3D Tiles（含 Cesium ion、Google 真实感 3D Tiles）要素拾取与高亮；.ply / .splat / .spz 高斯泼溅场景锚定在地球上。
  - icon: 📍
    title: 矢量、顶牌与点位
    details: GeoJSON 贴地渲染与注记避让，HTML 顶牌与 8 种点位样式、属性规则和聚合，被遮挡时淡出。
  - icon: 🏢
    title: 室内与 BIM
    details: 建筑文档描述楼层、房间、设备；双击逐级进入、右键返回，选择器查询、批量样式、描边与发光。
  - icon: 🧩
    title: 为嵌入而设计
    details: 任意容器、同页多个 viewer、完整释放；统一的交互事件与拾取、加载状态与错误码、静止后停画省电。
---

## 先看一眼

| 室内楼层与顶牌 | 进入房间：高亮、属性与告警 |
| --- | --- |
| ![室内楼层](./images/indoor-floor.jpg) | ![进入房间](./images/indoor-room.jpg) |

| 北京西山日落（地形 + 大气） | GeoJSON 分色与注记避让 |
| --- | --- |
| ![日落](./images/sunset.jpg) | ![GeoJSON](./images/geojson-labels.jpg) |

截图早于后期管线、阴影和体积云，现在的画面会有差别；最新效果请直接打开[在线演示](https://yoy0o.github.io/TerraView/demo/)。

## 三行接入

```bash
npm install terra-viewer three@0.187.0 3d-tiles-renderer@0.5.4
```

```ts
import 'terra-viewer/style.css';
import { AWS_TERRARIUM, findImageryPreset, GeoViewer } from 'terra-viewer';

const viewer = await GeoViewer.create({
  container: document.getElementById('map')!,
  imagery: findImageryPreset('esri-imagery')!.create(),
  terrain: AWS_TERRARIUM,
  initialView: { longitude: 116.391, latitude: 39.9, height: 2200, heading: 0, pitch: -38 },
});
```

接下来读[快速开始](/guide/getting-started)，或者在[示例](https://yoy0o.github.io/TerraView/examples/)里挑一个改起来。

TerraView 免费开源，由个人维护者业余开发。觉得有用的话，欢迎[赞助支持](/sponsor)。English readers: see the [English pages](/en/).
