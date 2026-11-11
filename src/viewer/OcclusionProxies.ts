/**
 * Occlusion proxies for HTML markers (M2.2): a fixed pool of tiny meshes,
 * one per marker that asks for occlusion, drawn after the opaque scene
 * without writing color or depth and wrapped in three's occlusion queries
 * (`occlusionTest`). `renderer.isOccluded` answers only while a render is in
 * progress, so each proxy reads its result in `onBeforeRender`. Results are
 * a few frames late; a recycled slot ignores results until its proxy has been
 * queried again. Implements `MarkerOcclusion` (markers/occlusion.ts).
 */
import { Group, Mesh, OctahedronGeometry, type Object3D } from 'three';
import { MeshBasicNodeMaterial, type WebGPURenderer } from 'three/webgpu';
import { ProxySlots, type MarkerOcclusion } from '../markers/occlusion';

/** Proxies are drawn after every opaque object (the occluders), still in the opaque pass. */
const PROXY_RENDER_ORDER = 1_000_000;
/**
 * Renders of a (re)acquired proxy before its query result counts: the first
 * render issues the query, the result is resolved asynchronously after it.
 */
const WARMUP_RENDERS = 3;

export class OcclusionProxies implements MarkerOcclusion {
  /** Add to the scene. */
  readonly group = new Group();
  readonly slots: ProxySlots;
  private readonly meshes: (Mesh | null)[];
  private readonly results: Uint8Array;
  /** Renders since the slot was acquired (results count from `WARMUP_RENDERS` on). */
  private readonly renders: Uint16Array;
  private readonly geometry = new OctahedronGeometry(1, 0);
  private readonly material = new MeshBasicNodeMaterial();

  constructor(
    private readonly renderer: WebGPURenderer,
    capacity = 256,
  ) {
    this.slots = new ProxySlots(capacity);
    this.meshes = new Array<Mesh | null>(capacity).fill(null);
    this.results = new Uint8Array(capacity);
    this.renders = new Uint16Array(capacity);
    this.group.name = 'Marker occlusion proxies';
    const m = this.material;
    m.name = 'OcclusionProxy';
    m.colorWrite = false;
    m.depthWrite = false;
    m.depthTest = true;
    m.transparent = false;
    m.fog = false;
  }

  acquire(): number {
    const slot = this.slots.acquire();
    if (slot < 0) return -1;
    this.results[slot] = 0;
    this.renders[slot] = 0;
    this.meshOf(slot).visible = true;
    return slot;
  }

  release(slot: number): void {
    if (!this.slots.isUsed(slot)) return;
    this.slots.release(slot);
    const mesh = this.meshes[slot];
    if (mesh) mesh.visible = false;
    this.results[slot] = 0;
  }

  place(slot: number, x: number, y: number, z: number, radius: number): void {
    const mesh = this.meshes[slot];
    if (!mesh) return;
    mesh.position.set(x, y, z);
    mesh.scale.setScalar(Math.max(radius, 1e-3));
    mesh.updateMatrix();
    mesh.updateMatrixWorld();
  }

  occluded(slot: number): boolean {
    return this.slots.isUsed(slot) && this.renders[slot] >= WARMUP_RENDERS && this.results[slot] === 1;
  }

  private meshOf(slot: number): Mesh {
    let mesh = this.meshes[slot];
    if (mesh) return mesh;
    mesh = new Mesh(this.geometry, this.material);
    mesh.name = `occlusion proxy ${slot}`;
    mesh.matrixAutoUpdate = false;
    mesh.renderOrder = PROXY_RENDER_ORDER;
    (mesh as Object3D & { occlusionTest: boolean }).occlusionTest = true;
    mesh.onBeforeRender = () => {
      if (!this.slots.isUsed(slot)) return;
      // The query result of earlier renders of this mesh (fully hidden = no sample passed).
      this.results[slot] = this.renderer.isOccluded(mesh!) ? 1 : 0;
      if (this.renders[slot] < 0xffff) this.renders[slot]++;
    };
    this.meshes[slot] = mesh;
    this.group.add(mesh);
    return mesh;
  }

  dispose(): void {
    this.group.removeFromParent();
    this.geometry.dispose();
    this.material.dispose();
  }
}
