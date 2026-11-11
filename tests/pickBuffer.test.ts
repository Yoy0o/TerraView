/**
 * M2.1 GPU pick buffer: octahedral normals, snorm packing, depth
 * unprojection (pure math shared with the TSL pass), sample decoding,
 * pick material variants and the refresh / freshness rules (fake renderer).
 */
import { BackSide, BoxGeometry, DoubleSide, Matrix4, Mesh, MeshStandardMaterial, PerspectiveCamera, Scene, Vector3, type Object3D } from 'three';
import { float, positionLocal } from 'three/tsl';
import { MeshBasicNodeMaterial, NodeMaterialInstance, type WebGPURenderer } from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { Ellipsoid } from '../src/core/Ellipsoid';
import { createTileMaterial, tileMorphPositionNode } from '../src/globe/TileMaterial';
import { PickBuffer, PickFrame, PickMaterials, type PickTarget } from '../src/viewer/PickBuffer';
import {
  bufferPixel,
  decodeTexel,
  floatBitsToUint,
  octDecode,
  octEncode,
  packSnorm2x16,
  transformDirection,
  transformPoint,
  uintBitsToFloat,
  unpackSnorm2x16,
  viewPositionFromDepth,
} from '../src/viewer/pickMath';

const E = Ellipsoid.WGS84;

/** Unit directions covering both hemispheres, the axes and the octahedron's folds. */
function directions(): [number, number, number][] {
  const out: [number, number, number][] = [
    [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
    [1, 1, -1], [-1, 1, -1], [1, -1, -1], [-1, -1, -1], [0.3, -0.2, -0.93],
  ];
  for (let i = 0; i < 200; i++) {
    const z = 1 - (2 * (i + 0.5)) / 200;
    const r = Math.sqrt(1 - z * z);
    const a = i * 2.399963;
    out.push([r * Math.cos(a), r * Math.sin(a), z]);
  }
  return out.map(([x, y, z]) => {
    const l = Math.hypot(x, y, z);
    return [x / l, y / l, z / l];
  });
}

function angleDeg(a: [number, number, number], b: [number, number, number]): number {
  const d = Math.min(1, Math.max(-1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]));
  return (Math.acos(d) * 180) / Math.PI;
}

describe('pick math', () => {
  it('round-trips octahedral normals exactly and within 0.01° through snorm16', () => {
    for (const n of directions()) {
      const [u, v] = octEncode(...n);
      // Upper hemisphere inside the diamond |u| + |v| <= 1, lower one folded into the corners of the square.
      expect(Math.max(Math.abs(u), Math.abs(v))).toBeLessThanOrEqual(1 + 1e-12);
      if (n[2] > 0) expect(Math.abs(u) + Math.abs(v)).toBeLessThanOrEqual(1 + 1e-12);
      // Exact up to float rounding (acos near 1 resolves ~1e-6°).
      expect(angleDeg(octDecode(u, v), n)).toBeLessThan(1e-5);
      const [pu, pv] = unpackSnorm2x16(packSnorm2x16(u, v));
      expect(angleDeg(octDecode(pu, pv), n)).toBeLessThan(0.01);
    }
  });

  it('packs snorm2x16 like WGSL (first value in the low half)', () => {
    expect(packSnorm2x16(1, -1)).toBe(0x80017fff);
    expect(packSnorm2x16(0, 0)).toBe(0);
    expect(packSnorm2x16(-1, 1)).toBe(0x7fff8001);
    expect(unpackSnorm2x16(0x80017fff)).toEqual([1, -1]);
    // Out-of-range values clamp.
    expect(unpackSnorm2x16(packSnorm2x16(3, -7))).toEqual([1, -1]);
  });

  it('bitcasts floats like floatBitsToUint', () => {
    for (const f of [-123.456, -0.5, 0, 1e-7, -6_000_000]) expect(uintBitsToFloat(floatBitsToUint(f))).toBe(Math.fround(f));
  });

  it('reconstructs view positions from depth for any depth convention', () => {
    const camera = new PerspectiveCamera(60, 1.7, 0.5, 5e6);
    camera.updateProjectionMatrix();
    const reversed = camera.projectionMatrix.clone();
    // Reversed-Z rows (depth 1 at near, 0 at far): only the ray direction may come from the matrix.
    const n = camera.near;
    reversed.elements[10] = 0;
    reversed.elements[14] = n;
    const views = [new Vector3(3, -2, -10), new Vector3(-400, 250, -2000), new Vector3(0.1, 0.05, -0.8), new Vector3(1e5, -3e4, -4e6)];
    for (const proj of [camera.projectionMatrix, reversed]) {
      const inv = proj.clone().invert();
      for (const p of views) {
        const clip = p.clone().applyMatrix4(proj);
        const r = viewPositionFromDepth(clip.x, clip.y, p.z, inv.elements);
        expect(Math.hypot(r[0] - p.x, r[1] - p.y, r[2] - p.z)).toBeLessThan(Math.abs(p.z) * 1e-9);
      }
    }
  });

  it('maps canvas fractions to buffer pixels and rejects points outside', () => {
    expect(bufferPixel(0, 0, 10, 5)).toEqual([0, 0]);
    expect(bufferPixel(0.999, 0.999, 10, 5)).toEqual([9, 4]);
    expect(bufferPixel(0.55, 0.3, 10, 5)).toEqual([5, 1]);
    expect(bufferPixel(1, 0.5, 10, 5)).toBeNull();
    expect(bufferPixel(-0.01, 0.5, 10, 5)).toBeNull();
    expect(bufferPixel(NaN, 0.5, 10, 5)).toBeNull();
  });

  it('transforms points and directions with column-major matrices', () => {
    const m = new Matrix4().makeRotationZ(Math.PI / 2).setPosition(10, 20, 30);
    expect(transformPoint(m.elements, 1, 0, 0).map((v) => +v.toFixed(9))).toEqual([10, 21, 30]);
    expect(transformDirection(m.elements, 2, 0, 0).map((v) => +v.toFixed(9))).toEqual([0, 1, 0]);
  });
});

/** Camera 300 m above a point on the ellipsoid, looking straight down (ECEF-scale coordinates). */
function ecefCamera(): { camera: PerspectiveCamera; ground: Vector3 } {
  const ground = E.cartographicToCartesian((116.39 * Math.PI) / 180, (39.9 * Math.PI) / 180, 50);
  const up = E.geodeticNormal(ground, new Vector3());
  const camera = new PerspectiveCamera(50, 2, 1, 1e6);
  camera.position.copy(ground).addScaledVector(up, 300);
  camera.up.set(0, 0, 1);
  camera.lookAt(ground);
  camera.updateMatrixWorld();
  camera.updateProjectionMatrix();
  return { camera, ground };
}

/** A buffer of `w` × `h` texels with one texel set. */
function fabricate(w: number, h: number, px: number, py: number, texel: [number, number, number, number]): Uint32Array {
  const data = new Uint32Array(w * h * 4);
  data.set(texel, (py * w + px) * 4);
  return data;
}

describe('pick frame decoding', () => {
  it('turns a texel into the object, instance, world point and normal', () => {
    const { camera, ground } = ecefCamera();
    const object = new Mesh(new BoxGeometry());
    const target: PickTarget = { kind: 'entity' };
    // The surface under the canvas center, 300 m below the camera, facing it.
    const viewZ = -300;
    const [u, v] = octEncode(0, 0, 1);
    const data = fabricate(8, 4, 4, 2, [1, 7, floatBitsToUint(viewZ), packSnorm2x16(u, v)]);
    const frame = new PickFrame(data, 8, 4, [null, object], [null, target], camera.projectionMatrixInverse.toArray(), camera.matrixWorld.toArray(), new Float64Array(37));
    const hit = frame.sample(0.5, 0.5)!;
    expect(hit.object).toBe(object);
    expect(hit.instanceId).toBe(7);
    expect(hit.target).toBe(target);
    expect(hit.point.distanceTo(ground)).toBeLessThan(1e-3); // float64 ECEF, sub-millimeter
    expect(hit.distance).toBeCloseTo(300, 6);
    // View +Z (towards the camera) is world up here.
    expect(hit.normal.dot(E.geodeticNormal(ground, new Vector3()))).toBeCloseTo(1, 6);
    // The point stays on the exact cursor ray, not the texel center.
    const off = frame.sample(0.52, 0.55)!;
    const ray = off.point.clone().sub(camera.position).normalize();
    const expected = new Vector3(0.52 * 2 - 1, 1 - 0.55 * 2, 0.5).unproject(camera).sub(camera.position).normalize();
    expect(ray.angleTo(expected)).toBeLessThan(1e-9);
    // Sky and outside.
    expect(frame.sample(0.05, 0.05)).toBeNull();
    expect(frame.sample(1.2, 0.5)).toBeUndefined();
    expect(decodeTexel(data, 8, 0, 0)).toBeNull();
  });
});

describe('pick materials', () => {
  it('shares one graph: per-side variants for plain materials', () => {
    const mats = new PickMaterials();
    const a = mats.forSource(new MeshStandardMaterial());
    const b = mats.forSource(new MeshStandardMaterial());
    expect(a).toBe(b);
    const back = mats.forSource(new MeshStandardMaterial({ side: BackSide }));
    const both = mats.forSource(new MeshStandardMaterial({ side: DoubleSide }));
    expect(new Set([a, back, both]).size).toBe(3);
    expect([back.side, both.side]).toEqual([BackSide, DoubleSide]);
    expect((a as NodeMaterialInstance).nodeMaterial).toBe((back as NodeMaterialInstance).nodeMaterial);
    expect([a.transparent, a.blending]).toEqual([false, 0]); // NoBlending: integer targets cannot blend
    expect(mats.stats).toEqual({ sources: 0, bases: 0 });
  });

  it('reuses custom position nodes, follows their values and frees them with the source', () => {
    const mats = new PickMaterials();
    const custom = new MeshBasicNodeMaterial();
    custom.positionNode = positionLocal.add(float(1));
    (custom as unknown as { wobble: number }).wobble = 2;
    const pick = mats.forSource(custom) as NodeMaterialInstance & { wobble: number };
    expect(pick.nodeMaterial.positionNode).toBe(custom.positionNode);
    expect(pick.wobble).toBe(2);
    (custom as unknown as { wobble: number }).wobble = 5;
    expect(mats.forSource(custom)).toBe(pick);
    expect(pick.wobble).toBe(5);
    // A second source with the same node shares the base.
    const twin = new MeshBasicNodeMaterial();
    twin.positionNode = custom.positionNode;
    const twinPick = mats.forSource(twin) as NodeMaterialInstance;
    expect(twinPick).not.toBe(pick);
    expect(twinPick.nodeMaterial).toBe(pick.nodeMaterial);
    expect(mats.stats).toEqual({ sources: 2, bases: 1 });
    let baseDisposed = false;
    pick.nodeMaterial.addEventListener('dispose', () => (baseDisposed = true));
    custom.dispose();
    expect(mats.stats).toEqual({ sources: 1, bases: 1 });
    twin.dispose();
    expect(mats.stats).toEqual({ sources: 0, bases: 0 });
    expect(baseDisposed).toBe(true);
  });

  it('draws globe tiles with the morph-only position node and their morph value', () => {
    const mats = new PickMaterials();
    const tile = createTileMaterial();
    tile.morph = 0.25;
    const pick = mats.forSource(tile) as NodeMaterialInstance & { morph: number };
    expect(pick.nodeMaterial.positionNode).toBe(tileMorphPositionNode());
    expect(pick.morph).toBe(0.25);
    tile.morph = 1;
    mats.forSource(tile);
    expect(pick.morph).toBe(1);
    tile.dispose();
    expect(mats.stats.sources).toBe(0);
  });
});

/** Minimal stand-in for WebGPURenderer: replays the render object function and answers read backs. */
function fakeRenderer(objects: Mesh[], texels: (ids: Map<Object3D, number>, w: number, h: number) => Uint32Array) {
  let fn: ((...a: unknown[]) => void) | null = null;
  let target: unknown = null;
  const drawn: { object: Object3D; material: unknown }[] = [];
  const ids = new Map<Object3D, number>();
  const r = {
    domElement: { width: 16, height: 8 },
    getClearColor: <T>(c: T) => c,
    getClearAlpha: () => 1,
    setClearColor: () => undefined,
    getRenderTarget: () => target,
    setRenderTarget: (t: unknown) => (target = t),
    getRenderObjectFunction: () => fn,
    setRenderObjectFunction: (f: typeof fn) => (fn = f),
    renderObject: (object: Object3D, _s: unknown, _c: unknown, _g: unknown, material: unknown) => drawn.push({ object, material }),
    render: (scene: Scene, camera: PerspectiveCamera) => {
      ids.clear();
      for (const o of objects) {
        const before = drawn.length;
        fn?.(o, scene, camera, o.geometry, o.material, null, null, null, null);
        if (drawn.length > before) ids.set(o, ids.size + 1);
      }
    },
    readRenderTargetPixelsAsync: async (_t: unknown, _x: number, _y: number, w: number, h: number) => texels(ids, w, h),
  };
  return { renderer: r as unknown as WebGPURenderer, drawn, ids };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('pick buffer refresh', () => {
  function setup() {
    const scene = new Scene();
    const camera = new PerspectiveCamera(50, 2, 1, 1000);
    camera.position.set(0, 0, 10);
    camera.updateMatrixWorld();
    const device = new Mesh(new BoxGeometry(), new MeshStandardMaterial());
    const sky = new Mesh(new BoxGeometry(), new MeshStandardMaterial());
    device.userData.kind = 'entity';
    const fake = fakeRenderer([sky, device], (ids, w, h) => fabricate(w, h, w / 2, h / 2, [ids.get(device) ?? 0, 3, floatBitsToUint(-10), packSnorm2x16(...octEncode(0, 0, 1))]));
    const buffer = new PickBuffer({ renderer: fake.renderer, scene, camera, classify: (o) => (o.userData.kind ? { kind: 'entity' } : null) });
    return { buffer, camera, device, sky, ...fake };
  }

  it('renders only pickable meshes, with pick materials, and answers once fresh', async () => {
    const { buffer, device, drawn } = setup();
    expect(buffer.lookup(0.5, 0.5)).toBeUndefined(); // nothing yet; also marks the buffer as in use
    buffer.update(1000, 10, 100);
    expect(drawn.map((d) => d.object)).toEqual([device]);
    expect(drawn[0].material).not.toBe(device.material);
    expect(buffer.stats.renders).toBe(1);
    await tick();
    expect(buffer.fresh).toBe(true);
    const hit = buffer.lookup(0.5, 0.5)!;
    expect(hit.object).toBe(device);
    expect(hit.instanceId).toBe(3);
    expect(hit.distance).toBeCloseTo(10, 6);
    expect(buffer.lookup(0.1, 0.1)).toBeNull();
  });

  it('goes stale when the camera or scene changes and re-renders at most every interval', async () => {
    const { buffer, camera } = setup();
    buffer.lookup(0.5, 0.5);
    buffer.update(1000, 10, 100);
    await tick();
    buffer.update(1016, 10, 100);
    expect(buffer.fresh).toBe(true);
    // Same view and scene: no new render.
    buffer.update(1500, 10, 100);
    expect(buffer.stats.renders).toBe(1);
    // The camera moved: stale at once (lookups fall back), new render only after the interval.
    camera.position.x += 0.01;
    camera.updateMatrixWorld();
    buffer.update(1100, 10, 100);
    expect(buffer.fresh).toBe(false);
    expect(buffer.lookup(0.5, 0.5)).toBeUndefined();
    buffer.update(1200, 10, 100);
    expect(buffer.stats.renders).toBe(1);
    buffer.update(1300, 10, 100);
    expect(buffer.stats.renders).toBe(2);
    await tick();
    buffer.update(1316, 10, 100);
    expect(buffer.fresh).toBe(true);
    // Draw statistics and explicit invalidation are part of the signature.
    buffer.update(1332, 11, 100);
    expect(buffer.fresh).toBe(false);
    buffer.update(1348, 10, 100);
    expect(buffer.fresh).toBe(true);
    buffer.invalidate();
    buffer.update(1364, 10, 100);
    expect(buffer.fresh).toBe(false);
  });

  it('goes stale at once between frames: invalidation and camera moves need no update()', async () => {
    const { buffer, camera } = setup();
    buffer.lookup(0.5, 0.5);
    buffer.update(1000, 10, 100);
    await tick();
    expect(buffer.lookup(0.5, 0.5)).not.toBeUndefined();
    // E.g. a level change right before a click in the same tick.
    buffer.invalidate();
    expect(buffer.lookup(0.5, 0.5)).toBeUndefined();
    buffer.update(1300, 10, 100);
    await tick();
    expect(buffer.lookup(0.5, 0.5)).not.toBeUndefined();
    // E.g. setView() and a pick before the next frame (matrixWorld not yet updated).
    camera.position.y += 1;
    expect(buffer.fresh).toBe(false);
    expect(buffer.lookup(0.5, 0.5)).toBeUndefined();
  });

  it('does not render while nobody picks, or when disabled', () => {
    const { buffer } = setup();
    buffer.update(1000, 10, 100);
    expect(buffer.stats.renders).toBe(0);
    buffer.lookup(0.5, 0.5);
    buffer.enabled = false;
    buffer.update(performance.now(), 10, 100);
    expect(buffer.stats.renders).toBe(0);
    expect(buffer.lookup(0.5, 0.5)).toBeUndefined();
    buffer.enabled = true;
    buffer.update(performance.now() + buffer.keepAliveMs + 1, 10, 100);
    expect(buffer.stats.renders).toBe(0);
  });
});
