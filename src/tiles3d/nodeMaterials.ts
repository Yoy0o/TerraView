import {
  DoubleSide,
  LinearFilter,
  LinearMipmapLinearFilter,
  LinearMipmapNearestFilter,
  NearestFilter,
  NearestMipmapLinearFilter,
  NearestMipmapNearestFilter,
  type Material,
  type Mesh,
  type Object3D,
} from 'three';
import { float, Fn, materialReference, screenCoordinate } from 'three/tsl';
import { aerialPerspectiveOutputNode } from '../atmosphere/AtmosphereNodes';
import type { TSLNode } from '../core/tsl';
import { unlitShadowOutputNode } from '../lighting/SunShadows';
import { registerRegionMaskVariant, regionMaskNode } from '../region/regionMask';

/** Converts plain materials to their node equivalents (`renderer.library.fromMaterial`). */
export interface NodeMaterialLibrary {
  fromMaterial(material: Material): Material | null;
}

interface FadeableMaterial extends Material {
  isNodeMaterial?: boolean;
  maskNode?: TSLNode | null;
  fadeIn: number;
  fadeOut: number;
}

/** Tile materials clipped to the local scene region (`setMaterialClipped`). */
const clippedMaterials = new WeakSet<Material>();
let fadeAndRegionMask: TSLNode | null = null;

/**
 * The mask a 3D Tiles material needs: the LOD fade dither, the local scene clip, both, or none.
 * Shared nodes, so materials of one kind keep sharing pipelines.
 */
export function tileMaskNode(fading: boolean, clipped: boolean): TSLNode | null {
  if (fading && clipped) {
    if (!fadeAndRegionMask) {
      fadeAndRegionMask = fadeMaskNode().and(regionMaskNode());
      registerRegionMaskVariant(fadeAndRegionMask);
    }
    return fadeAndRegionMask;
  }
  if (fading) return fadeMaskNode();
  return clipped ? regionMaskNode() : null;
}

function isFading(m: FadeableMaterial): boolean {
  const a = m.fadeIn ?? 0;
  const b = m.fadeOut ?? 0;
  return !(a === 0 || a === 1) || !(b === 0 || b === 1);
}

function applyMask(m: FadeableMaterial, fading: boolean): void {
  const node = tileMaskNode(fading, clippedMaterials.has(m));
  if ((m.maskNode ?? null) === node) return;
  m.maskNode = node;
  m.needsUpdate = true;
}

/** Clips a 3D Tiles material to the local scene region of the renderer drawing it, or stops clipping. */
export function setMaterialClipped(material: Material, clipped: boolean): void {
  const m = material as FadeableMaterial;
  if (!m.isNodeMaterial || clippedMaterials.has(m) === clipped) return;
  if (clipped) clippedMaterials.add(m);
  else clippedMaterials.delete(m);
  applyMask(m, isFading(m));
}

/** Clips (or stops clipping) every material under an object. */
export function setObjectClipped(object: Object3D, clipped: boolean): void {
  object.traverse((child) => {
    for (const m of materialsOf(child)) setMaterialClipped(m, clipped);
  });
}

function materialsOf(object: Object3D): Material[] {
  const m = (object as Mesh).material;
  if (!m) return [];
  return Array.isArray(m) ? m : [m];
}

const MIPMAP_FILTERS: ReadonlySet<number> = new Set([LinearMipmapLinearFilter, LinearMipmapNearestFilter, NearestMipmapLinearFilter, NearestMipmapNearestFilter]);

/** How tile textures are filtered (`TilesQuality` has these fields). */
export interface TexturePolicy {
  /** Keep generated mipmaps (a third more texture memory, and a pass per level on upload). */
  mipmaps: boolean;
  /** Anisotropic filtering (1 = off); only with mipmaps. */
  anisotropy: number;
}

/** What `applyTexturePolicy` needs of a texture (a structural subset of three's `Texture`). */
export interface PolicyTexture {
  isTexture?: boolean;
  isCompressedTexture?: boolean;
  generateMipmaps: boolean;
  minFilter: number;
  anisotropy: number;
}

/**
 * Sets mipmaps and anisotropy on every texture of a material. Must run
 * before the first render: the GPU texture is created with or without a mip
 * chain. Compressed textures keep the mip chain they ship with.
 *
 * Tile textures arrive with trilinear filtering and no anisotropy, which
 * blurs ground seen at a shallow angle; anisotropy sharpens it at no memory
 * cost. Without mipmaps a texture takes a quarter less memory and uploads
 * faster, but oblique ground shimmers while moving (the `low` tier's trade).
 */
export function applyTexturePolicy(material: object, policy: TexturePolicy): void {
  const props = material as Record<string, unknown>;
  for (const key in props) {
    const tex = props[key] as PolicyTexture | null;
    if (!tex || typeof tex !== 'object' || tex.isTexture !== true) continue;
    if (tex.isCompressedTexture) {
      tex.anisotropy = Math.max(1, policy.anisotropy);
      continue;
    }
    if (policy.mipmaps) {
      tex.anisotropy = Math.max(1, policy.anisotropy);
    } else {
      tex.generateMipmaps = false;
      if (MIPMAP_FILTERS.has(tex.minFilter)) tex.minFilter = tex.minFilter === NearestMipmapNearestFilter || tex.minFilter === NearestMipmapLinearFilter ? NearestFilter : LinearFilter;
      tex.anisotropy = 1;
    }
  }
}

/**
 * 3DTilesRendererJS plugin that turns tile materials into node materials while
 * the tile is being parsed (`processTileModel` runs before the renderer
 * records the materials it will dispose, so nothing leaks). Node materials are
 * what WebGPURenderer would create internally anyway; owning them lets us add
 * TSL features such as the LOD fade.
 */
export class NodeMaterialPlugin {
  readonly name = 'NODE_MATERIAL_PLUGIN';
  /** New tiles are clipped to the local scene region (see `setMaterialClipped`). */
  clipped = false;

  constructor(
    private readonly library: NodeMaterialLibrary,
    /** Texture filtering of the GPU tier; applied here because the textures have not been uploaded yet. */
    private readonly textures: TexturePolicy = { mipmaps: true, anisotropy: 1 },
  ) {}

  processTileModel(scene: Object3D): void {
    scene.traverse((child) => {
      const mesh = child as Mesh;
      if (!mesh.material) return;
      const convert = (m: Material): Material => {
        const node = this.library.fromMaterial(m) ?? m;
        // Photogrammetry often has inconsistent winding; avoid holes.
        node.side = DoubleSide;
        // Hazed by the atmosphere like the globe tiles around it (M3.5); one shared node keeps pipelines shared.
        // Unlit ones (photogrammetry, light baked in) also darken in the buildings' sun shadows (M3.9).
        const n = node as Material & { isNodeMaterial?: boolean; outputNode?: TSLNode | null; isMeshBasicNodeMaterial?: boolean };
        if (n.isNodeMaterial && n.outputNode === null) n.outputNode = n.isMeshBasicNodeMaterial ? unlitShadowOutputNode() : aerialPerspectiveOutputNode();
        applyTexturePolicy(node, this.textures);
        if (this.clipped) setMaterialClipped(node, true);
        return node;
      };
      mesh.material = Array.isArray(mesh.material) ? mesh.material.map(convert) : convert(mesh.material);
      // Lit tiles receive the sun shadows through the sun light (M3.9).
      mesh.receiveShadow = true;
    });
  }
}

let sharedMask: TSLNode | null = null;

/**
 * Screen-space 4x4 Bayer dither (same pattern as 3DTilesRendererJS's GLSL
 * fade): keeps fragments whose threshold lies in [fadeOut, fadeIn). One node
 * instance is shared by every material so they keep sharing pipelines.
 */
export function fadeMaskNode(): TSLNode {
  if (sharedMask) return sharedMask;
  const fadeIn: TSLNode = materialReference('fadeIn', 'float');
  const fadeOut: TSLNode = materialReference('fadeOut', 'float');
  sharedMask = Fn(() => {
    const v: TSLNode = (screenCoordinate.xy as TSLNode).mod(4).floor();
    const bayer2 = (p: TSLNode): TSLNode => p.y.mul(3).add(p.x.mul(2)).mod(4);
    const bayer4: TSLNode = bayer2(v.mod(2)).mul(4).add(bayer2(v.mod(4).mul(0.5).floor()));
    const dither: TSLNode = bayer4.add(0.5).div(float(16));
    return dither.lessThan(fadeIn).and(dither.greaterThanEqual(fadeOut));
  })();
  return sharedMask;
}

/**
 * Drop-in replacement for the library's FadeMaterialManager, whose shader
 * patching relies on `onBeforeCompile` and therefore does nothing under
 * WebGPU. Fading materials get the shared dither `maskNode`; finished ones
 * drop it again so steady-state tiles keep early depth testing.
 */
export class NodeFadeMaterialManager {
  /** Number of materials currently fading (read by the plugin). */
  fading = 0;
  private readonly state = new WeakMap<Material, { fading: boolean }>();

  prepareScene(scene: Object3D): void {
    scene.traverse((child) => {
      for (const m of materialsOf(child)) this.prepareMaterial(m);
    });
  }

  prepareMaterial(material: Material): void {
    const m = material as FadeableMaterial;
    if (!m.isNodeMaterial || this.state.has(m)) return;
    m.fadeIn = 0;
    m.fadeOut = 0;
    this.state.set(m, { fading: false });
  }

  setFade(scene: Object3D | null, fadeIn: number, fadeOut: number): void {
    if (!scene) return;
    const fading = !(fadeIn === 0 || fadeIn === 1) || !(fadeOut === 0 || fadeOut === 1);
    scene.traverse((child) => {
      for (const material of materialsOf(child)) {
        const s = this.state.get(material);
        if (!s) continue;
        const m = material as FadeableMaterial;
        m.fadeIn = fadeIn;
        m.fadeOut = fadeOut;
        if (s.fading !== fading) {
          s.fading = fading;
          this.fading += fading ? 1 : -1;
          applyMask(m, fading);
        }
      }
    });
  }

  deleteScene(scene: Object3D | null): void {
    if (!scene) return;
    this.setFade(scene, 1, 0);
    scene.traverse((child) => {
      for (const m of materialsOf(child)) this.state.delete(m);
    });
  }
}
