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
 */
import {
  DepthTexture,
  DepthFormat,
  FloatType,
  HalfFloatType,
  LinearFilter,
  RenderTarget,
  UnsignedIntType,
  Vector2,
  type PerspectiveCamera,
  type Scene,
  type Texture,
  type TextureDataType,
} from 'three';
import { mrt, output, renderOutput, texture, vec4 } from 'three/tsl';
import { RenderPipeline, type WebGPURenderer } from 'three/webgpu';
import type { TSLNode } from '../atmosphere/AtmosphereNodes';
import { collectAttachments, graphKey, sortEffects, type PostStage } from './postMath';

export type { PostStage } from './postMath';

/** Inputs an effect builds its part of the node graph from. */
export interface PostInputs {
  /** Scene color (linear HDR) as a texture node. */
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
  /** Whether the effect animates on its own while active (keeps the viewer at full frame rate). */
  readonly animating?: boolean;
  /** Changes whenever `build` would return a different graph (settings that are not uniforms). */
  readonly graphVersion: number;
  /**
   * Scene attachments the effect reads while active: name → node every scene material writes
   * there (e.g. `normalView`). Global nodes only (see the module comment).
   */
  readonly attachments?: Readonly<Record<string, TSLNode>>;
  /** Per drawn frame while active, after the scene pass and before the final pass: render own passes, update uniforms. */
  prepare?(frame: PostFrame): void;
  /** Composes the effect: color in (linear or display, see `stage`) → color out. */
  build(input: TSLNode, inputs: PostInputs): TSLNode;
  /** GPU bytes of the effect's own render targets (estimate, `viewer.memory`). */
  readonly gpuBytes?: number;
  /** Frees the effect's GPU resources (called by `remove` and when the viewer is disposed). */
  dispose(): void;
}

const _size = new Vector2();

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
    return bytes;
  }

  /** Draws a frame: scene pass, effect passes, final pass to the canvas. */
  render(): void {
    if (this.disposed) return;
    const r = this.renderer;
    const active = sortEffects(this.list.filter((e) => e.active));
    this.update(active);

    const size = r.getDrawingBufferSize(_size);
    const target = this.target;
    target.setSize(size.x, size.y);
    const prevTarget = r.getRenderTarget();
    const prevMRT = r.getMRT();
    r.setRenderTarget(target);
    r.setMRT(this.mrtNode);
    r.render(this.scene, this.camera);
    r.setRenderTarget(prevTarget);
    r.setMRT(prevMRT);

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
    this.pipeline.render();
  }

  /** Rebuilds the node graph (and the scene target's attachments) when the active set changed. */
  private update(active: PostEffect[]): void {
    const r = this.renderer;
    const infos = active.map((e) => ({ name: e.name, stage: e.stage, order: e.order, graphVersion: e.graphVersion, attachments: Object.keys(e.attachments ?? {}) }));
    const key = graphKey(infos, `${r.toneMapping}/${r.outputColorSpace}`);
    if (key === this.key) return;
    this.key = key;

    const names = collectAttachments(infos);
    if (names.join(',') !== this.attachmentNames.join(',')) this.setAttachments(names, active);

    const inputs: PostInputs = {
      sceneColor: this.colorNode,
      sceneDepth: this.depthNode,
      attachment: (name) => {
        const node = this.attachmentNodes.get(name);
        if (!node) throw new Error(`post: attachment "${name}" was not declared by an active effect`);
        return node;
      },
    };
    let color: TSLNode = this.colorNode;
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
  }

  private setAttachments(names: string[], active: PostEffect[]): void {
    const old = this.target;
    this.target = this.createTarget(names);
    this.colorNode.value = this.target.texture;
    this.depthNode.value = this.target.depthTexture;
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
    this.target.dispose();
  }
}
