/**
 * Style pool (M3.6): geometries and materials shared by unique key with
 * reference counts, so batched devices of the same model and style use one
 * GPU resource set, and the last user frees it. Materials come in two
 * tiers: one node material per base look ("resource" key, e.g. a glTF
 * material or the primitive device material) builds the shader once; each
 * render state of it (transparent / depth write) is a `NodeMaterialInstance`
 * sharing that build.
 */
import { NodeMaterialInstance, type NodeMaterial } from 'three/webgpu';

interface Disposable {
  dispose(): void;
}

interface Entry<T extends Disposable> {
  value: T;
  refs: number;
}

/** Values shared by key; the value is disposed when its last reference is released. */
export class RefCountedPool<T extends Disposable = Disposable> {
  private readonly entries = new Map<string, Entry<T>>();

  /** Returns the value for `key` (created on first use) and adds a reference. */
  acquire(key: string, create: () => T): T {
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { value: create(), refs: 0 };
      this.entries.set(key, entry);
    }
    entry.refs++;
    return entry.value;
  }

  /** Drops a reference; at zero the value is disposed and forgotten. Unknown keys are ignored. */
  release(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    if (--entry.refs > 0) return;
    this.entries.delete(key);
    entry.value.dispose();
  }

  /** Current reference count of a key (0 when absent). */
  refs(key: string): number {
    return this.entries.get(key)?.refs ?? 0;
  }

  /** Number of live values. */
  get size(): number {
    return this.entries.size;
  }

  keys(): IterableIterator<string> {
    return this.entries.keys();
  }
}

/** Render state of a pooled material variant (part of its key). */
export interface MaterialState {
  transparent: boolean;
  depthWrite: boolean;
}

/** Key of a material variant: base key plus render state. */
export function variantKey(baseKey: string, state: MaterialState): string {
  return `${baseKey}|${state.transparent ? 't' : 'o'}${state.depthWrite ? 'd' : ''}`;
}

/**
 * Pooled geometries and materials of batched devices. One pool can serve
 * every building (`sharedStylePool`); tests use their own.
 */
export class StylePool {
  readonly geometries = new RefCountedPool();
  /** Base node materials (one shader build each). */
  readonly bases = new RefCountedPool<NodeMaterial>();
  /** Render-state variants of the bases. */
  readonly materials = new RefCountedPool<NodeMaterialInstance>();

  /**
   * Material for `baseKey` in a render state: a `NodeMaterialInstance` of the
   * base node material (created by `createBase` on first use). Release with
   * `releaseMaterial(key)` using the returned key.
   */
  acquireMaterial(baseKey: string, createBase: () => NodeMaterial, state: MaterialState): { key: string; material: NodeMaterialInstance } {
    const key = variantKey(baseKey, state);
    const material = this.materials.acquire(key, () => {
      const base = this.bases.acquire(baseKey, createBase);
      const instance = new NodeMaterialInstance(base);
      instance.transparent = state.transparent;
      instance.depthWrite = state.depthWrite;
      // The variant holds one reference on its base; disposing it gives it back.
      const dispose = instance.dispose.bind(instance);
      instance.dispose = () => {
        dispose();
        this.bases.release(baseKey);
      };
      return instance;
    });
    return { key, material };
  }

  releaseMaterial(key: string): void {
    this.materials.release(key);
  }

  /** Live pooled resources (all zero once every building using the pool is removed). */
  get stats(): { geometries: number; bases: number; materials: number } {
    return { geometries: this.geometries.size, bases: this.bases.size, materials: this.materials.size };
  }
}

/** Pool shared by every building unless one is given explicitly. */
export const sharedStylePool = new StylePool();
