/**
 * Post-processing skeleton (roadmap M3.1): every frame renders the scene into a render target
 * of its own (HDR color, depth, and the extra attachments active effects ask for), lets the
 * active effects run their own passes, then composes one full-screen pass to the canvas:
 *
 *   scene color → linear effects (by order) → tone mapping + sRGB → display effects → canvas
 *
 * With no active effect this is exactly what `renderer.render(scene, camera)` does on its own
 * (the renderer also draws into an HDR target and tone-maps in a full-screen pass when tone
 * mapping is on), so the pipeline is always used: no switch, no second HDR target, no shader
 * rebuild of scene materials when an effect turns on.
 *
 * The node graph is rebuilt only when the list of active effects, one of their `graphVersion`s
 * or the renderer's tone mapping changes. Attachments (MRT outputs such as normals) are written
 * by the scene pass only while an active effect reads them; they are global nodes evaluated by
 * every material, so effects must not set `material.mrtNode` on scene materials (a material
 * with its own MRT replaces its output in every render target, the pick buffer's included).
 *
 * Still supersampling (roadmap M3.3, `renderSample`): while the view is still, each frame shifts
 * the camera by a sub-pixel offset (Halton(2, 3); the first sample is not shifted), draws the
 * scene and the effects as usual, and blends the finished (display) picture into a half-float
 * history with weight 1 / (n + 1), which is then shown: after n samples the history is the mean
 * of n shifted pictures (anti-aliasing beyond MSAA, steady textures and thin lines). Averaging
 * the tone-mapped picture keeps high-contrast edges smooth. No velocity buffer or reprojection:
 * only a still view is refined, and any change goes back to live frames (`render`). three's
 * `TRAANode` was not used: its velocity pass multiplies float32 ECEF matrices on the GPU (meters
 * of error at globe scale) and its history never converges to a plain mean.
 *
 * Order-independent transparency (roadmap M3.9, `viewer.transparency`; WebGPU): transparent
 * surfaces the viewer marks (`oitTest`: buildings and devices) leave the scene pass and are
 * drawn in a pass of their own into a weighted color sum and a revealage (weighted blended OIT,
 * McGuire and Bavoil, as three's `OITPassNode`), tested against the scene depth without writing
 * it; the first node of the graph composes them over the scene color. Glass shells, faded rooms
 * and windows then blend the same from every angle instead of popping as their sort order
 * changes. The two targets share the scene target's (multisampled) depth, so they are
 * multisampled like it: 9 bytes per sample and pixel, allocated the first time marked surfaces
 * are drawn. The WebGL backend keeps sorted transparency (no depth sharing with MSAA).
 */
import {
  CustomBlending,
  DepthTexture,
  DepthFormat,
  FloatType,
  HalfFloatType,
  LinearFilter,
  NormalBlending,
  OneFactor,
  OneMinusSrcColorFactor,
  RedFormat,
  RenderTarget,
  UnsignedByteType,
  UnsignedIntType,
  Vector2,
  ZeroFactor,
  type Material,
  type Object3D,
  type PerspectiveCamera,
  type Scene,
  type Texture,
  type TextureDataType,
} from 'three';
import { float, mix, mrt, output, positionView, renderOutput, texture, uniform, vec4 } from 'three/tsl';
import { BlendMode, NodeMaterial, QuadMesh, RenderPipeline, RendererUtils, type WebGPURenderer } from 'three/webgpu';
import type { TSLNode } from '../core/tsl';
import { collectAttachments, graphKey, jitterOffset, sampleWeight, sortEffects, type PostStage } from './postMath';

export type { PostStage } from './postMath';

/** Inputs an effect builds its part of the node graph from. */
export interface PostInputs {
  /**
   * Scene color (linear HDR), with order-independent transparency composed in when it is on: a
   * node for the fragment's own pixel (not a texture to sample elsewhere).
   */
  readonly sceneColor: TSLNode;
  /** Scene depth (`renderer.reversedDepthBuffer`: 1 is near) as a texture node. */
  readonly sceneDepth: TSLNode;
  /** A scene attachment the effect declared in `attachments`, as a texture node. */
  attachment(name: string): TSLNode;
}

/** State of the frame being drawn, for effects that render passes of their own. */
export interface PostFrame {
  readonly renderer: WebGPURenderer;
  readonly scene: Scene;
  readonly camera: PerspectiveCamera;
  /** Drawing buffer size, device pixels. */
  readonly width: number;
  readonly height: number;
  /** Device pixels per CSS pixel. */
  readonly pixelRatio: number;
  /** Depth of the scene pass (read it in shaders through a texture node). */
  readonly depthTexture: DepthTexture;
  /** Seconds since the pipeline was created (animations). */
  readonly time: number;
}

/**
 * A post-processing effect (`viewer.postProcessing.add`). The pipeline keeps the effects of one
 * viewer; an effect instance must not be shared between viewers.
 */
export interface PostEffect {
  /** Unique within the pipeline. */
  readonly name: string;
  /** `linear`: before tone mapping (light); `display`: after (exact colors, overlays). */
  readonly stage: PostStage;
  /** Lower runs first within the stage. */
  readonly order: number;
  /** Whether the effect changes the next frame; inactive effects cost nothing. */
  readonly active: boolean;
  /** Whether the effect animates on its own while active: the viewer keeps the full frame rate and the view is never still (no supersampling). */
  readonly animating?: boolean;
  /** Changes whenever `build` would return a different graph (settings that are not uniforms). */
  readonly graphVersion: number;
  /**
   * Scene attachments the effect reads while active: name → node every scene material writes
   * there (e.g. `normalView`). Global nodes only (see the module comment).
   */
  readonly attachments?: Readonly<Record<string, TSLNode>>;
  /**
   * Per drawn frame while active, after the scene pass and before the final pass: render own passes, update uniforms.
   * During supersampling `frame.camera` is shifted by the sample's sub-pixel offset: render with it, do not keep its matrices.
   */
  prepare?(frame: PostFrame): void;
  /** Composes the effect: color in (linear or display, see `stage`) → color out. */
  build(input: TSLNode, inputs: PostInputs): TSLNode;
  /** GPU bytes of the effect's own render targets (estimate, `viewer.memory`). */
  readonly gpuBytes?: number;
  /** Frees the effect's GPU resources (called by `remove` and when the viewer is disposed). */
  dispose(): void;
}

const _size = new Vector2();

/** Order-independent transparency targets and nodes (created the first time marked surfaces are drawn). */
interface OitState {
  /** Weighted color sum (RGBA16F) and revealage (R8), sharing the scene target's depth. */
  readonly target: RenderTarget;
  readonly mrt: TSLNode;
  readonly accum: TSLNode;
  readonly revealage: TSLNode;
}

let rendererState: ReturnType<typeof RendererUtils.saveRendererState> | undefined;
let sceneState: ReturnType<typeof RendererUtils.resetSceneState> | undefined;

/**
 * @advanced The viewer's frame pipeline (`viewer.postProcessing`): scene pass, effects, final
 * pass. The built-in outline and glow effects are registered as `outline` and `glow`.
 */
export class PostPipeline {
  private readonly list: PostEffect[] = [];
  private readonly pipeline: RenderPipeline;
  private target: RenderTarget;
  /** Attachment names of the current target, in texture order after `output`. */
  private attachmentNames: string[] = [];
  private mrtNode: TSLNode = null;
  private readonly colorNode: TSLNode;
  private readonly depthNode: TSLNode;
  private readonly attachmentNodes = new Map<string, TSLNode>();
  private key: string | null = null;
  private readonly start = performance.now();
  private disposed = false;
  /** Supersampling history: mean of the samples so far, display values (created on the first sample). */
  private history: RenderTarget | null = null;
  /** The composed picture with the sample's weight as alpha, blended over the history. */
  private readonly sampleQuad: QuadMesh;
  private readonly weight = uniform(1);
  /** Shows the history on the canvas. */
  private presentPipeline: RenderPipeline | null = null;
  private historyNode: TSLNode = null;
  /** Copies the history into another target (`capture`). */
  private copyQuad: QuadMesh | null = null;
  private _samples = 0;
  /** @internal Order-independent transparency wanted (`viewer.transparency`); used only where `oitSupported`. */
  oitEnabled = false;
  /** @internal Whether the backend can share the multisampled scene depth with the OIT targets (WebGPU). */
  oitSupported = false;
  /** @internal Which transparent surfaces go through OIT (the viewer marks buildings and devices). */
  oitTest: (object: Object3D, material: Material) => boolean = () => false;
  private oit: OitState | null = null;
  /** The OIT pass runs (the graph composes it); decided from what the previous scene pass met. */
  private oitActive = false;
  /** Marked transparent surfaces the last scene pass met. */
  private oitSeen = 0;

  constructor(
    private readonly renderer: WebGPURenderer,
    private readonly scene: Scene,
    private readonly camera: PerspectiveCamera,
  ) {
    this.target = this.createTarget([]);
    this.colorNode = texture(this.target.texture);
    this.depthNode = texture(this.target.depthTexture!);
    this.pipeline = new RenderPipeline(renderer);
    // Tone mapping and color space are applied in the graph, between the two stages.
    this.pipeline.outputColorTransform = false;
    const blend = new NodeMaterial();
    blend.name = 'Supersampling blend';
    blend.blending = NormalBlending;
    blend.transparent = true;
    blend.depthTest = false;
    blend.depthWrite = false;
    blend.toneMapped = false;
    this.sampleQuad = new QuadMesh(blend);
    this.sampleQuad.name = 'Supersampling sample';
  }

  /**
   * Supersampling samples averaged in the picture on the canvas: 0 after a live frame (`render`),
   * n after `renderSample` was called n times since.
   */
  get samples(): number {
    return this._samples;
  }

  /** Registered effects, in registration order. */
  get effects(): readonly PostEffect[] {
    return this.list;
  }

  /** Adds an effect (it takes part while `active`). Names are unique: an effect with the same name is replaced. */
  add(effect: PostEffect): void {
    const same = this.list.findIndex((e) => e.name === effect.name);
    if (same >= 0) this.remove(this.list[same]);
    this.list.push(effect);
    this.key = null;
  }

  /** Removes an effect and disposes it. */
  remove(effect: PostEffect): void {
    const i = this.list.indexOf(effect);
    if (i < 0) return;
    this.list.splice(i, 1);
    effect.dispose();
    this.key = null;
  }

  /** The registered effect with a name, or null. */
  get(name: string): PostEffect | null {
    return this.list.find((e) => e.name === name) ?? null;
  }

  /** @internal Order-independent transparency drew marked surfaces in the last frame (`viewer.transparency.active`). */
  get oitDrawn(): boolean {
    return this.oitActive;
  }

  /** Whether an active effect animates on its own (the viewer keeps drawing at full rate). */
  get animating(): boolean {
    return this.list.some((e) => e.active && e.animating === true);
  }

  /** Estimated GPU bytes of the effects' own render targets (the scene target replaces the renderer's own HDR target). */
  get gpuBytes(): number {
    let bytes = 0;
    for (const e of this.list) bytes += e.gpuBytes ?? 0;
    // Attachments: one RGBA16F texture per name, multisampled like the scene.
    const { width, height } = this.target;
    const samples = Math.max(1, this.target.samples);
    bytes += this.attachmentNames.length * width * height * 8 * (samples > 1 ? samples + 1 : 1);
    // Supersampling history, RGBA16F.
    if (this.history) bytes += this.history.width * this.history.height * 8;
    // OIT: RGBA16F + R8 per sample, and their resolved copies.
    if (this.oit) bytes += this.oit.target.width * this.oit.target.height * 9 * (samples > 1 ? samples + 1 : 1);
    return bytes;
  }

  /** Draws a live frame: scene pass, effect passes, final pass to the canvas. Discards the supersampling samples. */
  render(): void {
    if (this.disposed) return;
    this._samples = 0;
    this.drawScene();
    this.pipeline.render();
  }

  /**
   * Draws supersampling sample `samples` (see the module comment): the scene and the effects with
   * the camera shifted by its sub-pixel offset, blended into the history, which is then shown on
   * the canvas. The first sample after a live frame (or a size change) restarts the history.
   * Call only while the view is still; the caller decides when enough samples were taken.
   */
  renderSample(): void {
    if (this.disposed) return;
    const r = this.renderer;
    // A rebuilt graph (an effect turned on or off) restarts the history.
    this.update(sortEffects(this.list.filter((e) => e.active)));
    const size = r.getDrawingBufferSize(_size);
    const history = this.historyTarget(size.x, size.y);
    const k = history.width === size.x && history.height === size.y && this._samples > 0 ? this._samples : 0;
    history.setSize(size.x, size.y);

    // Sub-pixel shift of the whole view (unless the host uses view offsets itself), for the scene
    // pass and the effects' own passes (outline and glow masks line up with the shifted scene).
    // `setViewOffset` also sets the aspect from the full size: keep the camera's own, exactly, or
    // the restored projection would differ in the last bits and the view would no longer be still.
    const [jx, jy] = jitterOffset(k);
    const cam = this.camera;
    const jitter = (jx !== 0 || jy !== 0) && !(cam.view && cam.view.enabled);
    const aspect = cam.aspect;
    if (jitter) {
      const fullWidth = aspect * size.y;
      cam.setViewOffset(fullWidth, size.y, (jx * fullWidth) / size.x, jy, fullWidth, size.y);
    }
    try {
      this.drawScene();
    } finally {
      if (jitter) {
        cam.aspect = aspect;
        cam.clearViewOffset();
      }
    }

    // Blend the finished picture over the history: history × (1 − w) + picture × w. The first
    // sample clears the history (w = 1 replaces it, but a cleared target never keeps a NaN).
    this.weight.value = sampleWeight(k);
    const prevTarget = r.getRenderTarget();
    const prevAutoClear = r.autoClear;
    r.setRenderTarget(history);
    r.autoClear = k === 0;
    this.sampleQuad.render(r);
    r.autoClear = prevAutoClear;
    r.setRenderTarget(prevTarget);
    this._samples = k + 1;
    this.presentHistory();
  }

  /**
   * Shows the supersampled picture again without drawing the scene (screenshots and transition
   * captures of a still view). False when there is none (the last frame was live).
   */
  present(): boolean {
    if (this.disposed || this._samples === 0 || !this.history) return false;
    this.presentHistory();
    return true;
  }

  /**
   * @internal Draws the current picture, finished as it would appear on the canvas (display
   * values), into `color` and returns the scene depth texture it was drawn with (valid until the
   * next scene pass). `fromHistory`: copy the supersampled picture instead of drawing the scene
   * again (the depth is then that of its last sample). Used by the level transition.
   */
  capture(color: RenderTarget, fromHistory: boolean): DepthTexture {
    const r = this.renderer;
    const prevTarget = r.getRenderTarget();
    const prevAutoClear = r.autoClear;
    r.autoClear = true;
    r.setRenderTarget(color);
    if (fromHistory && this.history && this._samples > 0) {
      if (!this.copyQuad) {
        const m = new NodeMaterial();
        m.name = 'Supersampling copy';
        m.fragmentNode = vec4(this.historyNode.rgb, 1);
        m.toneMapped = false;
        this.copyQuad = new QuadMesh(m);
      }
      this.copyQuad.render(r);
    } else {
      r.setRenderTarget(prevTarget);
      this.drawScene();
      r.setRenderTarget(color);
      // The composed picture at full weight (the blend material, over a cleared target).
      this.weight.value = 1;
      this.sampleQuad.render(r);
    }
    r.setRenderTarget(prevTarget);
    r.autoClear = prevAutoClear;
    return this.target.depthTexture!;
  }

  /** Frees the supersampling history (supersampling turned off); the next sample creates it again. */
  releaseHistory(): void {
    this._samples = 0;
    this.history?.dispose();
    this.history = null;
    if (this.historyNode) this.historyNode.value = this.target.texture;
  }

  private presentHistory(): void {
    if (!this.presentPipeline) {
      // Display values already: written to the canvas as they are.
      this.presentPipeline = new RenderPipeline(this.renderer, vec4(this.historyNode.rgb, 1));
      this.presentPipeline.outputColorTransform = false;
    }
    this.presentPipeline.render();
  }

  private historyTarget(width: number, height: number): RenderTarget {
    if (!this.history) {
      this.history = new RenderTarget(width, height, { type: HalfFloatType, depthBuffer: false, minFilter: LinearFilter, magFilter: LinearFilter, generateMipmaps: false });
      this.history.texture.name = 'supersampling history';
      if (this.historyNode) this.historyNode.value = this.history.texture;
      else this.historyNode = texture(this.history.texture);
      this._samples = 0;
    }
    return this.history;
  }

  /** Scene pass into the pipeline's target, then the active effects' own passes. */
  private drawScene(): void {
    const r = this.renderer;
    // OIT runs when the last scene pass met marked surfaces (the first frame they appear in is sorted).
    const oit = this.oitEnabled && this.oitSupported;
    const useOit = oit && this.oitSeen > 0;
    if (useOit !== this.oitActive) {
      this.oitActive = useOit;
      this.key = null;
    }
    const active = sortEffects(this.list.filter((e) => e.active));
    this.update(active);

    const size = r.getDrawingBufferSize(_size);
    const target = this.target;
    target.setSize(size.x, size.y);
    const prevTarget = r.getRenderTarget();
    const prevMRT = r.getMRT();
    const prevFunction = r.getRenderObjectFunction();
    r.setRenderTarget(target);
    r.setMRT(this.mrtNode);
    let seen = 0;
    if (oit) {
      const test = this.oitTest;
      r.setRenderObjectFunction((object, scene, camera, geometry, material, group, lightsNode, clippingContext, passId) => {
        if (material.transparent === true && material.blending === NormalBlending && test(object, material)) {
          seen++;
          if (useOit) return;
        }
        r.renderObject(object, scene, camera, geometry, material, group, lightsNode, clippingContext, passId);
      });
    }
    try {
      r.render(this.scene, this.camera);
    } finally {
      r.setRenderObjectFunction(prevFunction);
      r.setRenderTarget(prevTarget);
      r.setMRT(prevMRT);
    }
    this.oitSeen = seen;
    if (useOit) this.drawTransparent(size.x, size.y);

    if (active.length > 0) {
      const frame: PostFrame = {
        renderer: r,
        scene: this.scene,
        camera: this.camera,
        width: size.x,
        height: size.y,
        pixelRatio: r.getPixelRatio(),
        depthTexture: target.depthTexture!,
        time: (performance.now() - this.start) / 1000,
      };
      for (const e of active) e.prepare?.(frame);
    }
  }

  /** Rebuilds the node graph (and the scene target's attachments) when the active set changed. */
  private update(active: PostEffect[]): void {
    const r = this.renderer;
    const infos = active.map((e) => ({ name: e.name, stage: e.stage, order: e.order, graphVersion: e.graphVersion, attachments: Object.keys(e.attachments ?? {}) }));
    const key = graphKey(infos, `${r.toneMapping}/${r.outputColorSpace}/${this.oitActive ? 'oit' : ''}`);
    if (key === this.key) return;
    this.key = key;

    const names = collectAttachments(infos);
    if (names.join(',') !== this.attachmentNames.join(',')) this.setAttachments(names, active);

    const sceneColor = this.oitActive ? this.composeTransparent(this.colorNode) : this.colorNode;
    const inputs: PostInputs = {
      sceneColor,
      sceneDepth: this.depthNode,
      attachment: (name) => {
        const node = this.attachmentNodes.get(name);
        if (!node) throw new Error(`post: attachment "${name}" was not declared by an active effect`);
        return node;
      },
    };
    let color: TSLNode = sceneColor;
    let displayed = false;
    for (const e of active) {
      if (e.stage === 'display' && !displayed) {
        color = renderOutput(color, r.toneMapping, r.outputColorSpace);
        displayed = true;
      }
      color = e.build(color, inputs);
    }
    if (!displayed) color = renderOutput(color, r.toneMapping, r.outputColorSpace);
    this.pipeline.outputNode = vec4(color);
    this.pipeline.needsUpdate = true;
    // Same picture for supersampling samples, with the sample's weight as alpha (blended over the history).
    const blend = this.sampleQuad.material as NodeMaterial;
    blend.fragmentNode = vec4(vec4(color).rgb, this.weight);
    blend.needsUpdate = true;
    // The history holds the previous graph's picture.
    this._samples = 0;
  }

  private setAttachments(names: string[], active: PostEffect[]): void {
    const old = this.target;
    this.target = this.createTarget(names);
    this.colorNode.value = this.target.texture;
    this.depthNode.value = this.target.depthTexture;
    if (this.oit) this.oit.target.depthTexture = this.target.depthTexture;
    old.dispose();
    this.attachmentNames = names;
    this.attachmentNodes.clear();
    if (names.length === 0) {
      this.mrtNode = null;
      return;
    }
    const outputs: Record<string, TSLNode> = { output };
    for (const name of names) {
      const owner = active.find((e) => e.attachments && name in e.attachments)!;
      outputs[name] = owner.attachments![name];
      this.attachmentNodes.set(name, texture(this.target.textures[names.indexOf(name) + 1]));
    }
    this.mrtNode = mrt(outputs);
  }

  /** The marked transparent surfaces into the OIT targets, over the scene pass's depth (not written). */
  private drawTransparent(width: number, height: number): void {
    const r = this.renderer;
    const state = this.oitTargets();
    const target = state.target;
    if (target.depthTexture !== this.target.depthTexture) target.depthTexture = this.target.depthTexture;
    target.samples = this.target.samples;
    target.setSize(width, height);
    const scene = this.scene;
    rendererState = RendererUtils.saveRendererState(r, rendererState!);
    // No sky in the sums; and the scene's statistics hook (`stats`, pick signature) belongs to the scene pass.
    sceneState = RendererUtils.resetSceneState(scene, sceneState!);
    const afterRender = scene.onAfterRender;
    scene.onAfterRender = () => {};
    const test = this.oitTest;
    try {
      r.setRenderTarget(target);
      r.setMRT(state.mrt);
      r.setRenderObjectFunction((object, sc, camera, geometry, material, group, lightsNode, clippingContext, passId) => {
        if (material.transparent !== true || material.blending !== NormalBlending || !test(object, material)) return;
        const depthWrite = material.depthWrite;
        material.depthWrite = false;
        r.renderObject(object, sc, camera, geometry, material, group, lightsNode, clippingContext, passId);
        material.depthWrite = depthWrite;
      });
      r.autoClear = true;
      r.autoClearColor = true;
      r.autoClearDepth = false; // the scene pass's depth
      r.autoClearStencil = false;
      r.opaque = false;
      r.transparent = true;
      r.render(scene, this.camera);
    } finally {
      scene.onAfterRender = afterRender;
      RendererUtils.restoreSceneState(scene, sceneState!);
      RendererUtils.restoreRendererState(r, rendererState!);
    }
  }

  private oitTargets(): OitState {
    if (this.oit) return this.oit;
    const target = new RenderTarget(1, 1, { count: 2, depthBuffer: true, samples: this.target.samples, generateMipmaps: false });
    target.depthTexture = this.target.depthTexture;
    const accum = target.textures[0];
    // MRT outputs are matched to the target's textures by name.
    accum.name = 'accum';
    accum.type = HalfFloatType;
    const revealage = target.textures[1];
    revealage.name = 'revealage';
    revealage.format = RedFormat;
    revealage.type = UnsignedByteType;
    // Weighted sums (equation 9 of the paper, view depth in meters): rgb·a·w and a·w add up,
    // the revealage multiplies by (1 − a).
    const alpha = output.a;
    const z = positionView.z.negate();
    const weight = alpha.mul(float(0.03).div(z.div(200).pow(4).add(1e-5)).clamp(1e-2, 3e3));
    const add = new BlendMode(CustomBlending);
    add.blendSrc = OneFactor;
    add.blendDst = OneFactor;
    const reveal = new BlendMode(CustomBlending);
    reveal.blendSrc = ZeroFactor;
    reveal.blendDst = OneMinusSrcColorFactor;
    const node: TSLNode = mrt({ accum: vec4(output.rgb.mul(alpha), alpha).mul(weight), revealage: alpha });
    node.setBlendMode('accum', add).setBlendMode('revealage', reveal).setClearColor('accum', 0x000000, 0).setClearColor('revealage', 0xffffff, 1);
    this.oit = { target, mrt: node, accum: texture(accum), revealage: texture(revealage) };
    return this.oit;
  }

  /** Scene color with the OIT sums composed over it (the first node of the graph). */
  private composeTransparent(scene: TSLNode): TSLNode {
    const { accum, revealage } = this.oitTargets();
    const color = accum.rgb.div(accum.a.max(1e-5));
    return vec4(mix(color, scene.rgb, revealage.r), scene.a);
  }

  private createTarget(attachments: string[]): RenderTarget {
    const r = this.renderer;
    const target = new RenderTarget(1, 1, {
      type: (r as unknown as { getOutputBufferType?: () => TextureDataType }).getOutputBufferType?.() ?? HalfFloatType,
      depthBuffer: true,
      samples: r.samples,
      count: 1 + attachments.length,
      minFilter: LinearFilter,
      magFilter: LinearFilter,
      generateMipmaps: false,
    });
    target.texture.name = 'output';
    attachments.forEach((name, i) => {
      const t: Texture = target.textures[i + 1];
      t.name = name;
    });
    // Same depth format as the renderer's own targets, so scene materials keep their pipelines.
    const depth = new DepthTexture(1, 1);
    depth.format = DepthFormat;
    depth.type = r.reversedDepthBuffer ? FloatType : UnsignedIntType;
    depth.name = 'depth';
    target.depthTexture = depth;
    return target;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const e of this.list) e.dispose();
    this.list.length = 0;
    this.pipeline.dispose();
    this.presentPipeline?.dispose();
    (this.sampleQuad.material as NodeMaterial).dispose();
    (this.copyQuad?.material as NodeMaterial | undefined)?.dispose();
    this.history?.dispose();
    this.oit?.target.dispose();
    this.target.dispose();
  }
}
