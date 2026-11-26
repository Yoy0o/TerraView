---
layout: home

hero:
  name: TerraView
  text: A WebGPU-first 3D globe SDK
  tagline: From the whole planet down to the street, then seamlessly into buildings, floors and rooms. Built on three.js and embedded in your app as the npm package terra-viewer.
  actions:
    - theme: brand
      text: Quick start
      link: /en/guide/getting-started
    - theme: alt
      text: Examples
      link: /examples/
      target: _self
    - theme: alt
      text: Live demo
      link: /demo/
      target: _self

features:
  - icon: 🌏
    title: A planet-scale globe
    details: WGS84 ellipsoid, quadtree imagery and global terrain, float64 precision with no jitter from space down to the street; loading without flicker or holes.
  - icon: 🌅
    title: Atmosphere, lighting and clouds
    details: Physical atmosphere with day, night and twilight; lighting that follows the atmosphere, sun shadows on buildings, a cloud shell from afar and volumetric clouds you can fly through up close.
  - icon: 🏙️
    title: 3D Tiles and Gaussian splats
    details: OGC 3D Tiles (including Cesium ion and Google Photorealistic 3D Tiles) with feature picking and highlighting; .ply / .splat / .spz Gaussian splat scenes anchored on the globe.
  - icon: 📍
    title: Vectors, markers and points
    details: GeoJSON draped on the terrain with label decluttering; HTML markers with 8 point styles, attribute rules and clustering, fading out when occluded.
  - icon: 🏢
    title: Indoor and BIM
    details: Building documents describe floors, rooms and equipment; double-click to go down level by level, right-click to go back; selector queries, batch styling, outline and glow.
  - icon: 🧩
    title: Designed for embedding
    details: Any container, multiple viewers per page, complete disposal; unified interaction events and picking, load state and error codes, and no redraws once the view is still, to save power.
---

## At a glance

| Indoor floor and markers | Entering a room: highlight, properties and alerts |
| --- | --- |
| ![Indoor floor](../images/indoor-floor.jpg) | ![Entering a room](../images/indoor-room.jpg) |

| Sunset over the Western Hills, Beijing (terrain + atmosphere) | GeoJSON fill colors and label decluttering |
| --- | --- |
| ![Sunset](../images/sunset.jpg) | ![GeoJSON](../images/geojson-labels.jpg) |

These screenshots predate the post-processing pipeline, shadows and volumetric clouds, so the current rendering looks different; for the latest, open the [live demo](https://yoy0o.github.io/TerraView/demo/).

## Three lines to get started

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

Next, read [Quick start](/en/guide/getting-started), or pick one of the [examples](https://yoy0o.github.io/TerraView/examples/) and start modifying it.

The full [user manual](/guide/) and [API reference](/api) are currently in Chinese; English versions of the most-used pages are under /en/.

[Support the project](/en/sponsor).
