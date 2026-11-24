/**
 * Outlines (roadmap M3.2): selection, hover and alarm outlines of marked objects
 * (`EffectMarks`), drawn after tone mapping so their colors come out exactly as given.
 *
 * 1. Mask pass: only the marked meshes, re-drawn with a flat material into a small mask (full
 *    resolution, half on high-density screens). Each fragment compares its depth with the scene
 *    depth: in front of or on the visible surface it writes the style's edge color, behind other
 *    content (x-ray) its hidden color, or nothing when the style has none. A second output
 *    holds the fill tint of visible parts.
 * 2. Edge pass: every uncovered mask pixel looks for the nearest covered pixel within the edge
 *    width and takes its color; covered pixels keep their fill. Premultiplied, so the final
 *    pass can sample it with bilinear filtering.
 * 3. Final pass: `color × (1 − edge.a) + edge.rgb`.
 *
 * Unlike three's `OutlineNode`, nothing renders the whole scene again (the scene pass already
 * has the depth), one pass handles every style, and a single device of an instanced batch can
 * be outlined (the mask draws its instance alone).
 */
import {
  BackSide,
  Color,
  NoBlending,
  DoubleSide,
  FrontSide,
  Mesh,
  NearestFilter,
  LinearFilter,
  RenderTarget,
  Scene,
  UnsignedByteType,
  type Side,
} from 'three';
import {
  Discard,
  float,
  Fn,
  fwidth,
  materialReference,
  max,
  mrt,
  output,
  perspectiveDepthToViewZ,
  positionView,
  screenUV,
  select,
  texture,
  uniform,
  uv,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import { NodeMaterial, QuadMesh } from 'three/webgpu';
import type { TSLNode } from '../core/tsl';
import type { EffectMarks, ResolvedOutline } from './EffectMarks';
import type { PostEffect, PostFrame, PostInputs } from './PostPipeline';
import { DEFAULT_OUTLINE_WIDTH, edgeSamples, MAX_OUTLINE_WIDTH, MIN_OUTLINE_WIDTH, outlineMaskScale, outlineRadius, pulseFactor } from './postMath';

/** Mask material of one outline style and face side (its look is read through `materialReference`). */
class MaskMaterial extends NodeMaterial {
  /** Edge color, sRGB components. */
  tvEdgeColor = new Color();
  tvHiddenColor = new Color();
  /** 1 when hidden parts get an edge (x-ray). */
  tvXray = 0;
  /** Fill tint of visible parts, 0..1 (pulse included). */
  tvFill = 0;
  /** Edge strength, 0..1 (pulse). */
  tvStrength = 1;
  /** Last frame the material was used (unused ones are disposed). */
  usedAt = 0;
}

/** A material property as a node (typed loosely: the TSL typings do not cover comparisons on references). */
const ref = (name: string, type: string): TSLNode => materialReference(name, type);

const SIDES: Side[] = [FrontSide, BackSide, DoubleSide];

export class OutlineEffect implements PostEffect {
  readonly name = 'outline';
  readonly stage = 'display' as const;
  readonly order = 100;
  graphVersion = 0;

  private _width = DEFAULT_OUTLINE_WIDTH;
  private readonly scene = new Scene();
  private readonly proxies: Mesh[] = [];
  private readonly materials = new Map<string, MaskMaterial>();
  private readonly mask: RenderTarget;
  private readonly edges: RenderTarget;
  private readonly edgeQuad = new QuadMesh(new NodeMaterial());
  /** Radius the edge material was built for (mask pixels). */
  private builtRadius = -1;
  private readonly near = uniform(1);
  private readonly far = uniform(2);
  private maskMRT: TSLNode = null;
  private colorNode: TSLNode = null;
  private readonly texel = uniform(vec2(1, 1));
  private sceneDepth: TSLNode = null;
  private readonly maskColor: TSLNode;
  private readonly maskFill: TSLNode;
  private frame = 0;
  private readonly clear = new Color();

  constructor(private readonly marks: EffectMarks) {
    this.scene.name = 'Outline mask';
    this.scene.matrixWorldAutoUpdate = false;
    this.mask = new RenderTarget(1, 1, { type: UnsignedByteType, count: 2, depthBuffer: true, minFilter: NearestFilter, magFilter: NearestFilter, generateMipmaps: false });
    this.mask.textures[0].name = 'output';
    this.mask.textures[1].name = 'fill';
    this.edges = new RenderTarget(1, 1, { type: UnsignedByteType, depthBuffer: false, minFilter: LinearFilter, magFilter: LinearFilter, generateMipmaps: false });
    this.maskColor = texture(this.mask.textures[0]);
    this.maskFill = texture(this.mask.textures[1]);
    this.edgeQuad.name = 'Outline edges';
  }

  get active(): boolean {
    return this.marks.hasOutline;
  }

  get animating(): boolean {
    return this.marks.pulsing;
  }

  /** Edge width in CSS pixels (1–6, default 2). */
  get width(): number {
    return this._width;
  }

  set width(v: number) {
    this._width = Math.min(MAX_OUTLINE_WIDTH, Math.max(MIN_OUTLINE_WIDTH, Number.isFinite(v) ? v : DEFAULT_OUTLINE_WIDTH));
  }

  get gpuBytes(): number {
    // Mask: two RGBA8 outputs + 32-bit depth; edges: RGBA8.
    return this.mask.width * this.mask.height * 12 + this.edges.width * this.edges.height * 4;
  }

  build(input: TSLNode, inputs: PostInputs): TSLNode {
    this.sceneDepth = inputs.sceneDepth;
    const edge = texture(this.edges.texture, uv());
    return vec4(input.rgb.mul(edge.a.oneMinus()).add(edge.rgb), input.a);
  }

  prepare(frame: PostFrame): void {
    const r = frame.renderer;
    this.frame++;
    const scale = outlineMaskScale(frame.pixelRatio);
    const w = Math.max(1, Math.round(frame.width / scale));
    const h = Math.max(1, Math.round(frame.height / scale));
    this.mask.setSize(w, h);
    this.edges.setSize(w, h);
    const radius = Math.round(outlineRadius(this._width, frame.pixelRatio) * 4) / 4;
    if (radius !== this.builtRadius) this.buildEdgeMaterial(radius);
    this.texel.value.set(1 / w, 1 / h);
    this.near.value = frame.camera.near;
    this.far.value = frame.camera.far;

    // Proxies of the marked meshes with their style's material.
    const items = this.marks.gather(frame.time);
    this.maskNode();
    let n = 0;
    for (const item of items) {
      if (!item.outline) continue;
      const proxy = this.proxy(n++);
      proxy.geometry = item.geometry;
      proxy.matrixWorld.copy(item.matrixWorld);
      proxy.material = this.material(item.outline, item.side, frame.time);
      proxy.visible = true;
    }
    for (let i = n; i < this.proxies.length; i++) {
      this.proxies[i].visible = false;
      // Do not keep geometries alive that may have been disposed.
      this.proxies[i].geometry = undefined as never;
    }
    this.sweepMaterials();

    const prevTarget = r.getRenderTarget();
    const prevMRT = r.getMRT();
    r.getClearColor(this.clear);
    const prevAlpha = r.getClearAlpha();
    r.setClearColor(0x000000, 0);
    r.setRenderTarget(this.mask);
    r.setMRT(this.maskMRT);
    if (n > 0) r.render(this.scene, frame.camera);
    else r.clear();
    r.setMRT(null);
    r.setRenderTarget(this.edges);
    this.edgeQuad.render(r);
    r.setRenderTarget(prevTarget);
    r.setMRT(prevMRT);
    r.setClearColor(this.clear, prevAlpha);
  }

  private proxy(i: number): Mesh {
    let p = this.proxies[i];
    if (!p) {
      p = new Mesh();
      p.matrixAutoUpdate = false;
      p.matrixWorldAutoUpdate = false;
      p.name = 'outline proxy';
      this.proxies.push(p);
      this.scene.add(p);
    }
    return p;
  }

  private material(style: ResolvedOutline, side: Side, time: number): MaskMaterial {
    const key = `${style.name}/${side}`;
    let m = this.materials.get(key);
    if (!m) {
      m = new MaskMaterial();
      m.name = `outline mask ${key}`;
      m.side = SIDES.includes(side) ? side : FrontSide;
      m.outputNode = this.maskNode();
      m.lights = false;
      m.fog = false;
      m.blending = NoBlending;
      this.materials.set(key, m);
    }
    const p = pulseFactor(time, style.pulse);
    m.tvEdgeColor.copy(style.edge);
    if (style.hidden) m.tvHiddenColor.copy(style.hidden);
    m.tvXray = style.hidden ? 1 : 0;
    m.tvStrength = p;
    m.tvFill = style.fill * p;
    m.usedAt = this.frame;
    return m;
  }

  /**
   * The mask output shared by every mask material of this effect (and the MRT that adds the
   * fill output): edge color and strength, nothing or the hidden color behind other content.
   */
  private maskNode(): TSLNode {
    if (this.colorNode) return this.colorNode;
    const depth = this.sceneDepth;
    const sceneZ = perspectiveDepthToViewZ(depth.sample(screenUV), this.near, this.far);
    const z = positionView.z;
    // Same surface within a tolerance: depth precision, MSAA sample position, grazing angles.
    const tolerance = max(z.negate().mul(0.002), fwidth(z).mul(1.5)).add(0.02);
    const hidden = z.lessThan(sceneZ.sub(tolerance));
    this.colorNode = Fn(() => {
      Discard(hidden.and(ref('tvXray', 'float').lessThan(0.5)));
      const color = select(hidden, ref('tvHiddenColor', 'color'), ref('tvEdgeColor', 'color'));
      return vec4(color, ref('tvStrength', 'float'));
    })();
    // Fill tints visible parts only.
    this.maskMRT = mrt({ output, fill: vec4(select(hidden, float(0), ref('tvFill', 'float')), 0, 0, 1) });
    return this.colorNode;
  }

  /** Edge search over the mask for an edge `radius` mask pixels wide. */
  private buildEdgeMaterial(radius: number): void {
    this.builtRadius = radius;
    const samples = edgeSamples(radius);
    const reach = Math.max(1, radius) + 0.5;
    const mask = this.maskColor;
    const fill = this.maskFill;
    const node = Fn(() => {
      const coord = uv();
      const texel = this.texel;
      const center = mask.sample(coord);
      const color = vec3(0).toVar();
      const strength = float(0).toVar();
      const distance = float(1e3).toVar();
      // Farthest first: the nearest covered sample is written last.
      for (const s of samples) {
        const v = mask.sample(coord.add(texel.mul(vec2(s.dx, s.dy))));
        const covered = v.a.greaterThan(0);
        color.assign(select(covered, v.rgb, color));
        strength.assign(select(covered, v.a, strength));
        distance.assign(select(covered, float(s.distance), distance));
      }
      const edge = float(reach).sub(distance).clamp(0, 1).mul(strength);
      const covered = center.a.greaterThan(0);
      const a = select(covered, fill.sample(coord).r, edge);
      const rgb = select(covered, center.rgb, color);
      return vec4(rgb.mul(a), a);
    })();
    const m = this.edgeQuad.material as NodeMaterial;
    m.fragmentNode = node;
    m.needsUpdate = true;
  }

  private sweepMaterials(): void {
    for (const [key, m] of this.materials) {
      if (this.frame - m.usedAt < 600) continue;
      m.dispose();
      this.materials.delete(key);
    }
  }

  dispose(): void {
    for (const m of this.materials.values()) m.dispose();
    this.materials.clear();
    for (const p of this.proxies) p.removeFromParent();
    this.proxies.length = 0;
    this.mask.dispose();
    this.edges.dispose();
    (this.edgeQuad.material as NodeMaterial).dispose();
  }
}
