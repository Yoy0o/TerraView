/**
 * On-demand building models (roadmap P2.2 / M3.8): which hidden floor models
 * to unload when the loaded models exceed the memory budget, and an estimate
 * of what a loaded glTF scene costs. The rule is a pure function, unit tested;
 * `IndoorManager` applies it every frame. See docs/agents/indoor-bim.md §5.4.
 */
import type { BufferAttribute, BufferGeometry, Material, Mesh, Object3D, Texture } from 'three';

/** What the budget rule needs to know about one unloadable model. */
export interface ModelResidency {
  /** Estimated bytes while loaded (0 otherwise). */
  readonly bytes: number;
  /** Loaded and attached; models still loading are never unloaded. */
  readonly loaded: boolean;
  /** Its floor is shown on screen (effectively visible). */
  readonly visible: boolean;
  /** Clock time (ms) the floor was last seen shown; ignored while `visible`. */
  readonly lastVisible: number;
}

/**
 * The models to unload so that `totalBytes` (every loaded building model,
 * unloadable or not) gets back within `budget`: hidden, loaded models that
 * have been hidden for at least `delayMs`, the least recently shown first.
 * Shown floors are never unloaded, so the total may stay above the budget
 * while they alone exceed it. Returns an empty list when within budget.
 */
export function modelsToUnload<T extends ModelResidency>(models: readonly T[], totalBytes: number, budget: number, now: number, delayMs: number): T[] {
  if (totalBytes <= budget) return [];
  const candidates = models.filter((m) => m.loaded && !m.visible && m.bytes > 0 && now - m.lastVisible >= delayMs).sort((a, b) => a.lastVisible - b.lastVisible);
  const out: T[] = [];
  let total = totalBytes;
  for (const m of candidates) {
    if (total <= budget) break;
    out.push(m);
    total -= m.bytes;
  }
  return out;
}

/** Bytes of a texture on the GPU: its compressed mip chain as stored, else RGBA8 with a third more for mipmaps. */
function textureBytes(t: Texture): number {
  const compressed = t as Texture & { isCompressedTexture?: boolean; mipmaps?: { data?: ArrayBufferView }[] };
  if (compressed.isCompressedTexture && Array.isArray(compressed.mipmaps)) {
    return compressed.mipmaps.reduce((sum, level) => sum + (level.data?.byteLength ?? 0), 0);
  }
  const image = t.image as { width?: number; height?: number } | null | undefined;
  const w = image?.width ?? 0;
  const h = image?.height ?? 0;
  return w * h * 4 * (t.generateMipmaps ? 4 / 3 : 1);
}

/**
 * Estimated GPU bytes of the meshes under `root`: vertex attributes and
 * indices of each geometry, plus each texture its materials use. Shared
 * geometries and textures (cloned materials keep their maps) count once.
 * An estimate for budgets and readings, not an exact figure.
 */
export function estimateModelBytes(root: Object3D): number {
  const geometries = new Set<BufferGeometry>();
  const textures = new Set<Texture>();
  root.traverse((o) => {
    const mesh = o as Mesh;
    if (!mesh.isMesh) return;
    geometries.add(mesh.geometry);
    for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) collectTextures(m, textures);
  });
  let bytes = 0;
  for (const g of geometries) {
    for (const name in g.attributes) bytes += (g.attributes[name] as BufferAttribute).array.byteLength;
    bytes += g.index?.array.byteLength ?? 0;
  }
  for (const t of textures) bytes += textureBytes(t);
  return bytes;
}

/** Every texture a material references (maps of any kind). */
export function collectTextures(material: Material, out: Set<Texture>): Set<Texture> {
  for (const key in material) {
    const v = (material as unknown as Record<string, unknown>)[key] as Texture | null;
    if (v && (v as { isTexture?: boolean }).isTexture) out.add(v);
  }
  return out;
}

/**
 * Frees the GPU resources of the meshes under the given roots (geometries,
 * materials, their textures; each once). Meshes marked `userData.pooled`
 * (device batches) are skipped: the style pool owns them.
 */
export function disposeModel(...roots: Object3D[]): void {
  const textures = new Set<Texture>();
  const disposed = new Set<{ dispose(): void }>();
  const once = (x: { dispose(): void }) => {
    if (disposed.has(x)) return;
    disposed.add(x);
    x.dispose();
  };
  for (const root of roots) {
    root.traverse((o) => {
      const mesh = o as Mesh;
      if (!mesh.isMesh || mesh.userData.pooled) return;
      once(mesh.geometry);
      for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        collectTextures(m, textures);
        once(m);
      }
    });
  }
  for (const t of textures) t.dispose();
}
