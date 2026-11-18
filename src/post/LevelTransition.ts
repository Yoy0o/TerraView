/**
 * Level transition on the GPU (roadmap M1.4 / P3.4): when a level change alters what is shown
 * (3D Tiles suppressed, the building shell hidden, floors switched), the picture on screen and
 * its depth are captured, and for `duration` ms the following frames dissolve it over the new
 * scene. It replaces the DOM crossfade (a 2D canvas copy faded with CSS), which froze the old
 * picture on screen while the camera flew off underneath it: the old and new pictures slid
 * against each other, at different scales.
 *
 * Here the old picture is reprojected with its depth: a grid of points (one every few CSS
 * pixels) takes each point's view distance from the captured depth, goes back to where it was in
 * the world, and is drawn from the moving camera. The old picture therefore stays attached to
 * the world while it fades (the shell stays where it was and dissolves, the ground does not
 * double), and zooms with the camera as it flies in or out. Sky points are reprojected as
 * directions. Triangles that would stretch across a depth edge (from a silhouette to what lies far
 * behind it) are left out on the far side; there the new picture shows at once.
 *
 * Precision: the grid works in the old camera's view space (float32 is plenty there) and one
 * matrix, new projection × new view × old camera, computed in float64 on the CPU, carries it to
 * the new clip space; its translation is the camera's own displacement, not ECEF coordinates.
 *
 * The capture comes from `PostPipeline.capture` (the finished display picture, or the
 * supersampled one when the view was still), so nothing is read back to the CPU. The effect is a
 * `display` effect between the color grading (order 0) and the outlines (order 100): the new
 * outlines are drawn crisp over the dissolving picture. Its capture targets and grid exist only
 * during a transition.
 */
import {
  BufferAttribute,
  BufferGeometry,
  Color,
  FloatType,
  Matrix4,
  Mesh,
  NearestFilter,
  NoBlending,
  RedFormat,
  RenderTarget,
  Scene,
  UnsignedByteType,
  LinearFilter,
  Vector2,
  type DepthTexture,
  type PerspectiveCamera,
} from 'three';
import { Discard, Fn, float, min, mix, perspectiveDepthToViewZ, select, texture, uniform, uv, vec2, vec4, vertexStage } from 'three/tsl';
import { NodeMaterial, QuadMesh, type WebGPURenderer } from 'three/webgpu';
import type { TSLNode } from '../atmosphere/AtmosphereNodes';
import type { PostEffect, PostFrame, PostPipeline } from './PostPipeline';
import { DEFAULT_TRANSITION_MS, TRANSITION_EDGE_RATIO, transitionGrid, transitionOpacity } from './postMath';

const _size = new Vector2();
const _clear = new Color();

/** `viewer.levelTransition`: the dissolve over level changes (registered as `transition` in `viewer.postProcessing`). */
export class LevelTransition implements PostEffect {
  readonly name = 'transition';
  readonly stage = 'display' as const;
  /** After the color grading (0), before the outlines (100). */
  readonly order = 50;
  readonly graphVersion = 0;
  /** Length of the dissolve in milliseconds (default 450); 0 turns level transitions off. */
  duration = DEFAULT_TRANSITION_MS;
  /**
   * Keep the old picture attached to the world while the camera moves, using its depth (default
   * true). False: a plain dissolve of the old picture as it was on screen.
   */
  reproject = true;

  /** `performance.now()` of the capture, -1 when no transition runs. */
  private startedAt = -1;
  /** Captured display picture (RGBA8) and view distance per pixel (R32F; 0 = sky). */
  private color: RenderTarget | null = null;
  private distance: RenderTarget | null = null;
  /** The old picture reprojected for this frame, premultiplied by its opacity. */
  private readonly ghost: RenderTarget;
  private readonly gridScene = new Scene();
  private grid: Mesh<BufferGeometry, NodeMaterial> | null = null;
  private gridKey = '';
  /** Grid material kept between transitions (compiled once). */
  private gridMaterialKept: NodeMaterial | null = null;
  private readonly distanceQuad = new QuadMesh(new NodeMaterial());
  /** Old camera: world matrix and inverse projection at the capture. */
  private readonly oldWorld = new Matrix4();
  private readonly oldInverseProjection = uniform(new Matrix4());
  /** New projection × new view × old camera world (float64 product, uploaded as float32). */
  private readonly reprojection = uniform(new Matrix4());
  private readonly opacity = uniform(1);
  private readonly warp = uniform(1);
  /** One grid cell in texture coordinates. */
  private readonly cell = uniform(new Vector2(1, 1));
  private readonly near = uniform(1);
  private readonly far = uniform(2);
  private readonly colorNode: TSLNode;
  private readonly distanceNode: TSLNode;
  private readonly sceneDepthNode: TSLNode;
  private readonly placeholder: RenderTarget;

  /** Created by the viewer. */
  constructor(
    private readonly pipeline: PostPipeline,
    private readonly renderer: WebGPURenderer,
    private readonly camera: PerspectiveCamera,
  ) {
    this.gridScene.name = 'Level transition';
    this.gridScene.matrixWorldAutoUpdate = false;
    this.ghost = new RenderTarget(1, 1, { type: UnsignedByteType, depthBuffer: false, minFilter: LinearFilter, magFilter: LinearFilter, generateMipmaps: false });
    this.ghost.texture.name = 'transition ghost';
    // Stands in for the capture targets between transitions (texture nodes need a value).
    this.placeholder = new RenderTarget(1, 1, { type: FloatType, format: RedFormat, depthBuffer: false, minFilter: NearestFilter, magFilter: NearestFilter, generateMipmaps: false });
    this.colorNode = texture(this.ghost.texture);
    this.distanceNode = texture(this.placeholder.texture);
    this.sceneDepthNode = texture(this.placeholder.texture);
    this.buildDistancePass();
  }

  /**
   * Part of the final pass whenever transitions are on, so that starting one does not rebuild
   * (and compile) the final pass. Between transitions it costs one sample of a 1 × 1 transparent
   * texture per pixel and nothing else.
   */
  get active(): boolean {
    return this.duration > 0 || this.startedAt >= 0;
  }

  get animating(): boolean {
    return this.startedAt >= 0;
  }

  get gpuBytes(): number {
    if (!this.color) return 0;
    const px = this.color.width * this.color.height;
    const gridBytes = this.grid ? this.grid.geometry.getAttribute('uv').count * 20 + (this.grid.geometry.index?.count ?? 0) * 4 : 0;
    // Color RGBA8, distance R32F, ghost RGBA8.
    return px * 12 + gridBytes;
  }

  /**
   * @internal Captures the picture on screen and starts dissolving it. `fromHistory`: the view
   * was still and its supersampled picture is current (copied instead of drawing the scene).
   */
  begin(fromHistory: boolean): void {
    if (!(this.duration > 0)) return;
    const r = this.renderer;
    const size = r.getDrawingBufferSize(_size);
    if (size.x === 0 || size.y === 0) return;
    const { color, distance } = this.captureTargets(size.x, size.y);
    const depth: DepthTexture = this.pipeline.capture(color, fromHistory);

    // View distance per pixel from the scene depth, with the camera the picture was drawn with.
    this.sceneDepthNode.value = depth;
    this.near.value = this.camera.near;
    this.far.value = this.camera.far;
    const prevTarget = r.getRenderTarget();
    r.setRenderTarget(distance);
    this.distanceQuad.render(r);
    r.setRenderTarget(prevTarget);

    this.camera.updateMatrixWorld();
    this.oldWorld.copy(this.camera.matrixWorld);
    (this.oldInverseProjection.value as Matrix4).copy(this.camera.projectionMatrixInverse);
    this.colorNode.value = color.texture;
    this.distanceNode.value = distance.texture;
    this.startedAt = performance.now();
  }

  build(input: TSLNode): TSLNode {
    const g = texture(this.ghost.texture, uv());
    return vec4(input.rgb.mul(g.a.oneMinus()).add(g.rgb), input.a);
  }

  prepare(frame: PostFrame): void {
    if (this.startedAt < 0) return;
    const r = frame.renderer;
    const opacity = transitionOpacity(performance.now() - this.startedAt, this.duration);
    this.ghost.setSize(frame.width, frame.height);
    const prevTarget = r.getRenderTarget();
    r.getClearColor(_clear);
    const prevAlpha = r.getClearAlpha();
    r.setClearColor(0x000000, 0);
    r.setRenderTarget(this.ghost);
    if (opacity > 0 && this.color) {
      const grid = this.gridMesh(frame.width, frame.height, frame.pixelRatio);
      this.opacity.value = opacity;
      this.warp.value = this.reproject ? 1 : 0;
      frame.camera.updateMatrixWorld();
      (this.reprojection.value as Matrix4).multiplyMatrices(frame.camera.projectionMatrix, frame.camera.matrixWorldInverse).multiply(this.oldWorld);
      grid.visible = true;
      r.render(this.gridScene, frame.camera);
    } else {
      // Done: this frame composes a cleared ghost, then it stays 1 × 1 and transparent.
      r.clear();
      this.finish();
    }
    r.setRenderTarget(prevTarget);
    r.setClearColor(_clear, prevAlpha);
  }

  /** Ends the transition and frees what only a transition needs. */
  private finish(): void {
    this.startedAt = -1;
    this.color?.dispose();
    this.distance?.dispose();
    this.color = null;
    this.distance = null;
    this.colorNode.value = this.ghost.texture;
    this.distanceNode.value = this.placeholder.texture;
    // The grid's geometry goes; its material stays, so the next transition does not compile it again.
    if (this.grid) {
      this.grid.geometry.dispose();
      this.grid.removeFromParent();
      this.gridMaterialKept = this.grid.material;
      this.grid = null;
      this.gridKey = '';
    }
    this.ghost.setSize(1, 1);
  }

  private captureTargets(width: number, height: number): { color: RenderTarget; distance: RenderTarget } {
    if (!this.color) {
      this.color = new RenderTarget(width, height, { type: UnsignedByteType, depthBuffer: false, minFilter: LinearFilter, magFilter: LinearFilter, generateMipmaps: false });
      this.color.texture.name = 'transition capture';
      this.distance = new RenderTarget(width, height, { type: FloatType, format: RedFormat, depthBuffer: false, minFilter: NearestFilter, magFilter: NearestFilter, generateMipmaps: false });
      this.distance.texture.name = 'transition distance';
    }
    this.color.setSize(width, height);
    this.distance!.setSize(width, height);
    return { color: this.color, distance: this.distance! };
  }

  /** Pass that turns the scene depth into view distance (0 for the sky: nothing was drawn there). */
  private buildDistancePass(): void {
    const reversed = this.renderer.reversedDepthBuffer === true;
    const m = this.distanceQuad.material as NodeMaterial;
    m.name = 'Transition distance';
    m.fragmentNode = Fn(() => {
      const z = this.sceneDepthNode.sample(uv()).r;
      const sky = reversed ? z.lessThanEqual(0) : z.greaterThanEqual(1);
      const viewZ = perspectiveDepthToViewZ(z, this.near, this.far);
      return vec4(select(sky, float(0), viewZ.negate()), 0, 0, 1);
    })();
  }

  /** The reprojection grid for a drawing buffer size (rebuilt when the size changes). */
  private gridMesh(width: number, height: number, pixelRatio: number): Mesh<BufferGeometry, NodeMaterial> {
    const { columns, rows } = transitionGrid(width, height, pixelRatio);
    const key = `${columns}x${rows}`;
    if (this.grid && this.gridKey === key) return this.grid;
    if (this.grid) {
      this.grid.geometry.dispose();
      this.grid.removeFromParent();
    }
    const geometry = gridGeometry(columns, rows);
    const material = this.grid?.material ?? this.gridMaterialKept ?? this.gridMaterial();
    const mesh = new Mesh(geometry, material);
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = false;
    mesh.name = 'transition grid';
    this.gridScene.add(mesh);
    (this.cell.value as Vector2).set(1 / (columns - 1), 1 / (rows - 1));
    this.grid = mesh;
    this.gridKey = key;
    return mesh;
  }

  private gridMaterial(): NodeMaterial {
    const m = new NodeMaterial();
    m.name = 'Transition grid';
    m.blending = NoBlending;
    m.depthTest = false;
    m.depthWrite = false;
    m.toneMapped = false;
    const coord = uv();
    const distanceAt = (dx: number, dy: number): TSLNode => this.distanceNode.sample(coord.add(this.cell.mul(vec2(dx, dy)))).r;
    const d = distanceAt(0, 0);
    // Far side of a silhouette (`isFarSideOfEdge`): a neighbor is much nearer, or this is sky next
    // to geometry. Sky neighbors count as infinitely far.
    const solid = (x: TSLNode): TSLNode => select(x.lessThanEqual(0), float(1e30), x);
    const nearest = min(min(solid(distanceAt(-1, 0)), solid(distanceAt(1, 0))), min(solid(distanceAt(0, -1)), solid(distanceAt(0, 1))));
    const edge = select(
      d.lessThanEqual(0),
      select(nearest.lessThan(1e29), float(1), float(0)),
      select(d.greaterThan(nearest.mul(1 + TRANSITION_EDGE_RATIO)), float(1), float(0)),
    );
    m.vertexNode = Fn(() => {
      // Texture coordinates have v = 0 at the top of the picture.
      const ndc = vec2(coord.x.mul(2).sub(1), coord.y.mul(2).oneMinus());
      const q = this.oldInverseProjection.mul(vec4(ndc, 0.5, 1));
      const view = q.xyz.div(q.w);
      // Point on the pixel's ray at view depth 1, then at its distance (sky: a direction).
      const dir = view.div(view.z.negate());
      const point = select(d.lessThanEqual(0), vec4(dir, 0), vec4(dir.mul(d), 1));
      const clip = mix(vec4(ndc, 0, 1), this.reprojection.mul(point), this.warp);
      // Never clipped by the near and far planes (only behind the camera).
      return vec4(clip.xy, clip.w.mul(0.5), clip.w);
    })();
    const edgeVarying = vertexStage(edge);
    m.fragmentNode = Fn(() => {
      Discard(edgeVarying.mul(this.warp).greaterThan(0.001));
      const c = this.colorNode.sample(uv());
      return vec4(c.rgb.mul(this.opacity), this.opacity);
    })();
    return m;
  }

  dispose(): void {
    this.finish();
    this.gridMaterialKept?.dispose();
    this.ghost.dispose();
    this.placeholder.dispose();
    (this.distanceQuad.material as NodeMaterial).dispose();
  }
}

/** Grid of `columns` × `rows` points over the picture: texture coordinates (v = 0 at the top) and triangles. */
function gridGeometry(columns: number, rows: number): BufferGeometry {
  const count = columns * rows;
  const uvs = new Float32Array(count * 2);
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < columns; x++) {
      const i = (y * columns + x) * 2;
      uvs[i] = x / (columns - 1);
      uvs[i + 1] = y / (rows - 1);
    }
  }
  const indices = new Uint32Array((columns - 1) * (rows - 1) * 6);
  let k = 0;
  for (let y = 0; y < rows - 1; y++) {
    for (let x = 0; x < columns - 1; x++) {
      const a = y * columns + x;
      const b = a + 1;
      const c = a + columns;
      const d = c + 1;
      indices[k++] = a;
      indices[k++] = c;
      indices[k++] = b;
      indices[k++] = b;
      indices[k++] = c;
      indices[k++] = d;
    }
  }
  const g = new BufferGeometry();
  // Positions come from the vertex node; three still wants the attribute.
  g.setAttribute('position', new BufferAttribute(new Float32Array(count * 3), 3));
  g.setAttribute('uv', new BufferAttribute(uvs, 2));
  g.setIndex(new BufferAttribute(indices, 1));
  return g;
}

