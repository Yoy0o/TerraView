/**
 * Glow (roadmap M3.2): selective bloom of marked objects (`EffectMarks`, `glow` > 0).
 *
 * The glowing meshes are re-drawn into a mask (glow color × intensity, visible parts only: the
 * fragment is compared with the scene depth like the outline mask), three's `BloomNode` blurs
 * the mask, and the linear stage adds the halo plus a little of the mask itself (the surface
 * lights up too). Scene materials are not touched and the scene pass writes no extra output,
 * so glowing costs nothing while nothing glows.
 */
import { BackSide, Color, DoubleSide, FrontSide, HalfFloatType, LinearFilter, Mesh, NoBlending, RenderTarget, Scene, type Side } from 'three';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { Discard, Fn, fwidth, materialReference, max, perspectiveDepthToViewZ, positionView, screenUV, texture, uniform, uv, vec4 } from 'three/tsl';
import { NodeMaterial } from 'three/webgpu';
import type { TSLNode } from '../atmosphere/AtmosphereNodes';
import type { EffectMarks } from './EffectMarks';
import type { PostEffect, PostFrame, PostInputs } from './PostPipeline';
import { outlineMaskScale, pulseFactor } from './postMath';

/** Mask value of full glow (intensity 1): how far above the scene's brightness the halo starts. */
const GLOW_GAIN = 1.5;
/** Share of the mask added to the glowing surface itself. */
const SURFACE_GAIN = 0.25;
/** Weights of the bloom mips, finest first (three's default is 1 for all five). */
const MIP_WEIGHTS = [1, 1, 0.6, 0.25, 0.08];

class GlowMaterial extends NodeMaterial {
  /** Linear glow color × intensity × pulse. */
  tvGlow = new Color();
  usedAt = 0;
}

/** A material property as a node (typed loosely: the TSL typings do not cover comparisons on references). */
const ref = (name: string, type: string): TSLNode => materialReference(name, type);

const SIDES: Side[] = [FrontSide, BackSide, DoubleSide];

export class GlowEffect implements PostEffect {
  readonly name = 'glow';
  readonly stage = 'linear' as const;
  readonly order = 100;
  readonly graphVersion = 0;
  /** Bloom strength (multiplier of the halo, default 1). */
  readonly strength = uniform(1);
  /** Bloom radius, 0..1 (default 0.5). */
  readonly radius = uniform(0.5);

  private readonly scene = new Scene();
  private readonly proxies: Mesh[] = [];
  private readonly materials = new Map<string, GlowMaterial>();
  private readonly mask: RenderTarget;
  private readonly near = uniform(1);
  private readonly far = uniform(2);
  private sceneDepth: TSLNode = null;
  private outputNode: TSLNode = null;
  private bloomNode: TSLNode = null;
  private frame = 0;
  private readonly clear = new Color();

  constructor(private readonly marks: EffectMarks) {
    this.scene.name = 'Glow mask';
    this.scene.matrixWorldAutoUpdate = false;
    this.mask = new RenderTarget(1, 1, { type: HalfFloatType, depthBuffer: true, minFilter: LinearFilter, magFilter: LinearFilter, generateMipmaps: false });
  }

  get active(): boolean {
    return this.marks.hasGlow;
  }

  get animating(): boolean {
    return this.marks.pulsing;
  }

  get gpuBytes(): number {
    // Mask RGBA16F + depth; bloom: bright target and 5 mip levels × 2 at half resolution and below (≈ 0.6 of one half-res target).
    const px = this.mask.width * this.mask.height;
    return this.bloomNode ? px * 12 + px * 0.25 * 8 * 1.7 : px * 12;
  }

  build(input: TSLNode, inputs: PostInputs): TSLNode {
    this.sceneDepth = inputs.sceneDepth;
    const glow = texture(this.mask.texture, uv());
    if (!this.bloomNode) {
      this.bloomNode = bloom(glow, this.strength, this.radius, 0);
      // The coarse mips spread the halo over hundreds of pixels and tint everything nearby: keep the glow close to the object.
      MIP_WEIGHTS.forEach((w, i) => this.bloomNode.bloomTintColors[i]?.setScalar(w));
    }
    return vec4(input.rgb.add(glow.rgb.mul(SURFACE_GAIN)).add(this.bloomNode.rgb), input.a);
  }

  prepare(frame: PostFrame): void {
    const r = frame.renderer;
    this.frame++;
    const scale = outlineMaskScale(frame.pixelRatio);
    this.mask.setSize(Math.max(1, Math.round(frame.width / scale)), Math.max(1, Math.round(frame.height / scale)));
    this.near.value = frame.camera.near;
    this.far.value = frame.camera.far;

    const items = this.marks.gather(frame.time);
    let n = 0;
    for (const item of items) {
      if (item.glow <= 0) continue;
      const p = this.proxy(n++);
      p.geometry = item.geometry;
      p.matrixWorld.copy(item.matrixWorld);
      const pulse = item.outline?.pulse ?? 0;
      const m = this.material(item.glowColor, item.glow, pulse, item.side);
      m.tvGlow.copy(item.glowColor).multiplyScalar(item.glow * GLOW_GAIN * pulseFactor(frame.time, pulse));
      p.material = m;
      p.visible = true;
    }
    for (let i = n; i < this.proxies.length; i++) {
      this.proxies[i].visible = false;
      this.proxies[i].geometry = undefined as never;
    }
    for (const [key, m] of this.materials) {
      if (this.frame - m.usedAt < 600) continue;
      m.dispose();
      this.materials.delete(key);
    }

    const prevTarget = r.getRenderTarget();
    r.getClearColor(this.clear);
    const prevAlpha = r.getClearAlpha();
    r.setClearColor(0x000000, 0);
    r.setRenderTarget(this.mask);
    if (n > 0) r.render(this.scene, frame.camera);
    else r.clear();
    r.setRenderTarget(prevTarget);
    r.setClearColor(this.clear, prevAlpha);
  }

  private proxy(i: number): Mesh {
    let p = this.proxies[i];
    if (!p) {
      p = new Mesh();
      p.matrixAutoUpdate = false;
      p.matrixWorldAutoUpdate = false;
      p.name = 'glow proxy';
      this.proxies.push(p);
      this.scene.add(p);
    }
    return p;
  }

  /** One material per glow color, intensity, pulse and side in use (all share one graph). */
  private material(color: Color, glow: number, pulse: number, side: Side): GlowMaterial {
    const key = `${color.getHexString()}/${glow.toFixed(3)}/${pulse}/${side}`;
    let m = this.materials.get(key);
    if (!m) {
      m = new GlowMaterial();
      m.name = `glow mask ${key}`;
      m.side = SIDES.includes(side) ? side : FrontSide;
      m.outputNode = this.maskNode();
      m.lights = false;
      m.fog = false;
      m.blending = NoBlending;
      this.materials.set(key, m);
    }
    m.usedAt = this.frame;
    return m;
  }

  private maskNode(): TSLNode {
    if (this.outputNode) return this.outputNode;
    const depth = this.sceneDepth;
    this.outputNode = Fn(() => {
      const sceneZ = perspectiveDepthToViewZ(depth.sample(screenUV), this.near, this.far);
      const z = positionView.z;
      const tolerance = max(z.negate().mul(0.002), fwidth(z).mul(1.5)).add(0.02);
      // Only what is visible glows (the halo still spreads over what is in front).
      Discard(z.lessThan(sceneZ.sub(tolerance)));
      return vec4(ref('tvGlow', 'color'), 1);
    })();
    return this.outputNode;
  }

  dispose(): void {
    for (const m of this.materials.values()) m.dispose();
    this.materials.clear();
    for (const p of this.proxies) p.removeFromParent();
    this.proxies.length = 0;
    this.mask.dispose();
    this.bloomNode?.dispose();
  }
}
