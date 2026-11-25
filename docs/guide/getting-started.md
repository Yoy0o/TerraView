# 快速开始

这一章从零开始把地球放进页面：安装、最小接入、在 React / Vue 里使用，以及接入时最常碰到的几个问题。

## 环境要求

| 项 | 要求 |
| --- | --- |
| 浏览器 | Chrome / Edge 113+ 走 WebGPU；不支持 WebGPU 的浏览器自动回退 WebGL 2（GPU 拾取缓冲、透明顺序无关混合只在 WebGPU 下有） |
| 模块格式 | 只有 ES 模块（没有 CommonJS / UMD），需要打包工具或浏览器原生 `import` |
| 打包工具 | Vite 8、webpack 5 已实测，包括 Worker 和 Draco / KTX2 / Meshopt 解码，不需要额外配置 |
| peer 依赖 | `three` 0.187.x、`3d-tiles-renderer` 0.5.x，由你的工程安装 |
| TypeScript | 可选。用 TypeScript 时另装 `@types/three@0.187.0` |

## 安装

```bash
npm install terra-viewer three@0.187.0 3d-tiles-renderer@0.5.4
npm install -D @types/three@0.187.0        # 用 TypeScript 时
```

`three` 和 `3d-tiles-renderer` 是 peer 依赖，不打进 `terra-viewer` 的包里：你的工程自己也用 three 时，页面上只有一份。three 不按 semver 发版，所以版本范围锁在 0.187.x。

也可以从 [GitHub Release](https://github.com/Yoy0o/TerraView/releases) 下载 `terra-viewer-<版本>.tgz`，用 `npm install ./terra-viewer-0.2.0.tgz` 安装。

## 最小接入

页面上准备一个**有尺寸**的容器（不必铺满窗口）：

```html
<div id="map" style="width: 100%; height: 600px"></div>
```

```ts
import 'terra-viewer/style.css';
import { AWS_TERRARIUM, findImageryPreset, GeoViewer } from 'terra-viewer';

const viewer = await GeoViewer.create({
  container: document.getElementById('map')!,
  imagery: findImageryPreset('esri-imagery')!.create(), // 底图，必填
  terrain: AWS_TERRARIUM,                               // 地形，可选
  initialView: { longitude: 116.391, latitude: 39.9, height: 2200, heading: 0, pitch: -38 },
});
```

三件事：

1. **样式表** `terra-viewer/style.css` 只管 SDK 自己创建的元素（canvas、顶牌），类名都以 `tv-` 开头，不影响页面其他部分。
2. **`GeoViewer.create` 是异步的**：它要先向浏览器申请 GPU 设备。`container` 和 `imagery` 是必填项，缺了会在创建渲染器之前抛出 `TerraViewError`（`code: 'option-invalid'`）。
3. **单位**：经纬度、航向、俯仰用度；高度是 WGS84 椭球高，单位米。航向自正北顺时针，俯仰向下为负（-90 是垂直俯视）。

创建完成后，用户就可以用鼠标浏览：左键拖动平移，滚轮缩放到光标处，右键拖动调航向和俯仰，双击飞近。

<ExampleFrame id="hello-globe" />

示例源码：[examples/hello-globe/main.ts](../../examples/hello-globe/main.ts)。

## 不需要密钥的数据源

上面的例子只用了免密钥的服务，可以直接跑起来：

| 用途 | 写法 | 说明 |
| --- | --- | --- |
| 卫星影像 | `findImageryPreset('esri-imagery')!.create()` | ArcGIS World Imagery |
| 街道地图 | `findImageryPreset('osm')!.create()` | OpenStreetMap（官方瓦片服务器不适合大流量的生产应用） |
| 离线调试 | `findImageryPreset('debug')!.create()` | 不联网的网格贴图，适合测试 |
| 全球地形 | `AWS_TERRARIUM` | AWS Terrain Tiles |

天地图、Mapbox、MapTiler、Cesium ion、Google 等需要密钥的服务由你传入密钥（[影像、叠加层与地形](./imagery-terrain.md)、[3D Tiles](./tiles3d.md)）。SDK 不保存、也不内置任何凭证。

上线前请确认所用服务的使用条款：公共瓦片服务通常要求显示署名（影像源自带 `attribution`，需要由你的界面显示），有的限制访问量或商业使用。

## 在框架里使用

viewer 应该在组件挂载后创建、卸载时 `dispose()`。因为 `create()` 是异步的，要处理"还没创建完组件就卸载了"的情况（React 开发模式下的 StrictMode 会故意挂载两次）：

::: code-group

```tsx [React]
import { useEffect, useRef } from 'react';
import 'terra-viewer/style.css';
import { AWS_TERRARIUM, findImageryPreset, GeoViewer } from 'terra-viewer';

export function Globe() {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let viewer: GeoViewer | undefined;
    let unmounted = false;
    GeoViewer.create({
      container: ref.current!,
      imagery: findImageryPreset('esri-imagery')!.create(),
      terrain: AWS_TERRARIUM,
    }).then((v) => {
      if (unmounted) v.dispose(); // 创建期间组件已卸载
      else viewer = v;
    });
    return () => {
      unmounted = true;
      viewer?.dispose();
    };
  }, []);

  return <div ref={ref} style={{ width: '100%', height: 600 }} />;
}
```

```vue [Vue]
<script setup lang="ts">
import { onBeforeUnmount, onMounted, useTemplateRef } from 'vue';
import 'terra-viewer/style.css';
import { AWS_TERRARIUM, findImageryPreset, GeoViewer } from 'terra-viewer';

const map = useTemplateRef<HTMLDivElement>('map');
// 不要放进 ref() / reactive()：Vue 的代理会包住 three.js 对象，既慢又会出错
let viewer: GeoViewer | undefined;
let unmounted = false;

onMounted(async () => {
  const v = await GeoViewer.create({
    container: map.value!,
    imagery: findImageryPreset('esri-imagery')!.create(),
    terrain: AWS_TERRARIUM,
  });
  if (unmounted) v.dispose();
  else viewer = v;
});

onBeforeUnmount(() => {
  unmounted = true;
  viewer?.dispose();
});
</script>

<template>
  <div ref="map" style="width: 100%; height: 600px" />
</template>
```

:::

要点：

- **不要把 viewer 放进响应式状态**（Vue 的 `ref` / `reactive`、MobX 的 observable 等）。需要在模板里用时，Vue 用 `shallowRef` 或 `markRaw`。
- **服务端渲染**（Next.js、Nuxt）：viewer 只能在浏览器里创建。Next.js 用 `dynamic(() => import('./Globe'), { ssr: false })`，Nuxt 用 `<ClientOnly>`。
- `dispose()` 之后 GPU 资源、Worker、事件监听都会释放，canvas 被移除，容器恢复原样；同一个容器可以再创建新的 viewer。

## 打包工具

- **Vite**：开箱即用，开发服务器和生产构建都实测过。SDK 里的 Worker 用 `new URL('./x.worker.js', import.meta.url)` 引用，Vite 会把它们输出成独立文件。
- **webpack 5**：开箱即用，CSS 需要 `style-loader` + `css-loader`（或你习惯的 CSS 方案）。
- **解码器**：glTF 的 Draco、KTX2 解码器默认用你安装的 three.js 自带的那份，由打包工具处理。要放到 CDN 或静态目录时，传 `decoderPath`（Draco）和 `transcoderPath`（Basis）。

```ts
GeoViewer.create({ container, imagery, decoderPath: '/libs/draco/gltf/', transcoderPath: '/libs/basis/' });
```

## 调试

- 浏览器控制台里看后端和档位：`viewer.info`（`backend` 是 `'WebGPU'` 或 `'WebGL2'`，`adapter` 是显卡）、`viewer.gpu.tier`。
- 帧耗时与绘制数：`viewer.stats`；显存估算：`viewer.memory`；一份可以附到问题报告里的诊断快照：`viewer.snapshot()`。
- 强制 WebGL 2：`GeoViewer.create({ ..., forceWebGL: true })`，用来对比两个后端的表现。

## 下一步

- [基本概念](./concepts.md)：坐标与单位、事件、什么时候需要 `requestRender()`，读完能少踩很多坑。
- [创建、容器与释放](./viewer.md)：全部创建选项、主题样式、键盘焦点、多个 viewer。
- 然后按需要阅读各功能章节，或者直接改[示例](https://yoy0o.github.io/TerraView/examples/)。
