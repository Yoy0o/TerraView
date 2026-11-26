# Quick start

This chapter puts the globe on a page from scratch: installation, a minimal setup, using it in React / Vue, and the issues people run into most often when integrating.

## Requirements

| Item | Requirement |
| --- | --- |
| Browser | Chrome / Edge 113+ use WebGPU; browsers without WebGPU fall back to WebGL 2 automatically (the GPU pick buffer and order-independent transparency are WebGPU-only) |
| Module format | ES modules only (no CommonJS / UMD); requires a bundler or native browser `import` |
| Bundler | Tested with Vite 8 and webpack 5, including Workers and Draco / KTX2 / Meshopt decoding; no extra configuration needed |
| Peer dependencies | `three` 0.187.x and `3d-tiles-renderer` 0.5.x, installed by your project |
| TypeScript | Optional. With TypeScript, also install `@types/three@0.187.0` |

## Installation

```bash
npm install terra-viewer three@0.187.0 3d-tiles-renderer@0.5.4
npm install -D @types/three@0.187.0        # when using TypeScript
```

`three` and `3d-tiles-renderer` are peer dependencies and are not bundled into the `terra-viewer` package: if your project also uses three, the page has only one copy of it. three does not follow semver, so the version range is pinned to 0.187.x.

You can also download `terra-viewer-<version>.tgz` from [GitHub Releases](https://github.com/Yoy0o/TerraView/releases) and install it with `npm install ./terra-viewer-0.2.0.tgz`.

## Minimal setup

Put a container **with a size** on the page (it does not have to fill the window):

```html
<div id="map" style="width: 100%; height: 600px"></div>
```

```ts
import 'terra-viewer/style.css';
import { AWS_TERRARIUM, findImageryPreset, GeoViewer } from 'terra-viewer';

const viewer = await GeoViewer.create({
  container: document.getElementById('map')!,
  imagery: findImageryPreset('esri-imagery')!.create(), // base imagery, required
  terrain: AWS_TERRARIUM,                               // terrain, optional
  initialView: { longitude: 116.391, latitude: 39.9, height: 2200, heading: 0, pitch: -38 },
});
```

Three things to note:

1. **The stylesheet** `terra-viewer/style.css` only covers the elements the SDK creates itself (the canvas, markers). All class names start with `tv-`, so it does not affect the rest of the page.
2. **`GeoViewer.create` is asynchronous**: it first has to request a GPU device from the browser. `container` and `imagery` are required; if either is missing, it throws a `TerraViewError` (`code: 'option-invalid'`) before creating the renderer.
3. **Units**: longitude, latitude, heading and pitch are in degrees; height is the WGS84 ellipsoidal height in meters. Heading is clockwise from true north; pitch is negative looking down (-90 is straight down).

Once it is created, users can browse with the mouse: left-drag to pan, scroll to zoom toward the cursor, right-drag to change heading and pitch, double-click to fly closer.

<ExampleFrame id="hello-globe" />

Example source: [examples/hello-globe/main.ts](../../../examples/hello-globe/main.ts).

## Data sources that need no key

The example above uses only services that need no key, so it runs as is:

| Purpose | Code | Notes |
| --- | --- | --- |
| Satellite imagery | `findImageryPreset('esri-imagery')!.create()` | ArcGIS World Imagery |
| Street map | `findImageryPreset('osm')!.create()` | OpenStreetMap (the official tile servers are not suitable for high-traffic production apps) |
| Offline debugging | `findImageryPreset('debug')!.create()` | A grid texture that needs no network, good for testing |
| Global terrain | `AWS_TERRARIUM` | AWS Terrain Tiles |

For services that need a key, such as Tianditu, Mapbox, MapTiler, Cesium ion and Google, you pass the key in ([Imagery, overlays and terrain](../../guide/imagery-terrain.md) (Chinese), [3D Tiles](../../guide/tiles3d.md) (Chinese)). The SDK neither stores nor bundles any credentials.

Before going live, check the terms of use of the services you use: public tile services usually require attribution (imagery sources carry an `attribution`, which your UI has to display), and some limit traffic or commercial use.

## Using it in a framework

Create the viewer after the component mounts and call `dispose()` when it unmounts. Because `create()` is asynchronous, you have to handle the case where the component unmounts before creation finishes (React's StrictMode in development deliberately mounts twice):

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
      if (unmounted) v.dispose(); // the component unmounted while the viewer was being created
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
// Do not put it in ref() / reactive(): Vue's proxy would wrap three.js objects, which is slow and breaks things
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

Key points:

- **Do not put the viewer in reactive state** (Vue's `ref` / `reactive`, MobX observables and so on). If you need it in a template, use `shallowRef` or `markRaw` in Vue.
- **Server-side rendering** (Next.js, Nuxt): the viewer can only be created in the browser. In Next.js use `dynamic(() => import('./Globe'), { ssr: false })`; in Nuxt use `<ClientOnly>`.
- After `dispose()`, GPU resources, Workers and event listeners are released, the canvas is removed and the container is restored to its original state; you can create a new viewer in the same container.

## Bundlers

- **Vite**: works out of the box; tested with both the dev server and production builds. The SDK references its Workers with `new URL('./x.worker.js', import.meta.url)`, and Vite emits them as separate files.
- **webpack 5**: works out of the box; CSS needs `style-loader` + `css-loader` (or whatever CSS setup you prefer).
- **Decoders**: the glTF Draco and KTX2 decoders default to the copies shipped with your installed three.js and are handled by the bundler. To serve them from a CDN or a static folder, pass `decoderPath` (Draco) and `transcoderPath` (Basis).

```ts
GeoViewer.create({ container, imagery, decoderPath: '/libs/draco/gltf/', transcoderPath: '/libs/basis/' });
```

## Debugging

- Check the backend and tier in the browser console: `viewer.info` (`backend` is `'WebGPU'` or `'WebGL2'`, `adapter` is the graphics card) and `viewer.gpu.tier`.
- Frame time and draw calls: `viewer.stats`; GPU memory estimate: `viewer.memory`; a diagnostic snapshot you can attach to an issue report: `viewer.snapshot()`.
- Force WebGL 2: `GeoViewer.create({ ..., forceWebGL: true })`, to compare how the two backends behave.

## Next steps

- [Basic concepts](../../guide/concepts.md) (Chinese): coordinates and units, events, and when you need `requestRender()`. Reading it will save you from a lot of pitfalls.
- [Creation, container and disposal](../../guide/viewer.md) (Chinese): all creation options, theming, keyboard focus, multiple viewers.
- Then read the feature chapters as needed, or go straight to modifying the [examples](https://yoy0o.github.io/TerraView/examples/).
