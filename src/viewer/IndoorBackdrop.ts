/**
 * Studio backdrop for buildings shown without any ground (globe hidden and
 * 3D Tiles suppressed indoors): a ground disk with a measuring grid and a
 * soft contact shadow under the building, and a dark gradient sky matching
 * the UI, blended into the scene background. Without it the building floats
 * in pure black.
 */
import { CircleGeometry, Group, Mesh, Vector3, Vector4 } from 'three';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import { sunShadowFactor } from '../lighting/SunShadows';
import {
  abs,
  color,
  dot,
  exp,
  float,
  fract,
  fwidth,
  length,
  max,
  min,
  mix,
  positionLocal,
  smoothstep,
  uniform,
  vec2,
} from 'three/tsl';
import type { TSLNode } from '../atmosphere/AtmosphereNodes';
import type { Ellipsoid } from '../core/Ellipsoid';
import { bounds2 } from '../indoor/schema';
import type { Building } from '../indoor/Building';

/** Palette (sRGB), tuned to the UI's dark panels (--bg #04070d, --accent #5aa9ff). */
const ZENITH = 0x060a12;
/** The lightest tone: ground and sky both run into it, like haze at a real horizon. */
const HORIZON = 0x1c2a3e;
/** Background straight down (only seen past the ground disk). */
const BELOW = 0x0c131d;
const GROUND_NEAR = 0x223147;
const GROUND_FAR = 0x131d2b;
const GRID_MINOR = 0x2b3d55;
const GRID_MAJOR = 0x36577e;

/** Disk radius in meters: at least this, or this many building radii. */
const MIN_RADIUS = 4_000;
const RADIUS_PER_BUILDING_RADIUS = 40;
/** Seconds for the backdrop to fade in or out. */
const FADE_TIME = 0.35;
/** Below the lowest visible floor slab (slabs reach 0.25 m below their floor). */
const DROP = 0.35;

const _v = new Vector3();

/** Anti-aliased grid lines every `spacing` meters, faded out where cells get too small on screen. */
function gridLines(p: TSLNode, spacing: number): TSLNode {
  const c: TSLNode = p.div(spacing);
  const w: TSLNode = fwidth(c);
  const g: TSLNode = abs(fract(c.sub(0.5)).sub(0.5)).div(max(w, vec2(1e-4)));
  const line = float(1).sub(min(min(g.x, g.y), 1));
  return line.mul(float(1).sub(smoothstep(0.12, 0.35, max(w.x, w.y))));
}

export class IndoorBackdrop {
  /** Holds the disk in the building's anchor frame (matrix copied from `building.root`). */
  readonly group = new Group();
  /** 0..1, animated: how much of the studio replaces the atmosphere background. */
  readonly amount = uniform(0);
  /** Geodetic up at the building (background horizon). */
  private readonly up = uniform(new Vector3(0, 0, 1));
  private readonly radius = uniform(MIN_RADIUS);
  /** Building footprint bounds [x0, y0, x1, y1] in its local meters (contact shadow). */
  private readonly footprint = uniform(new Vector4(-10, -10, 10, 10));
  private readonly mesh: Mesh;
  private target = 0;
  private building: Building | null = null;

  constructor(private readonly ellipsoid: Ellipsoid) {
    this.group.name = 'IndoorBackdrop';
    this.group.matrixAutoUpdate = false;
    this.group.visible = false;
    const material = new MeshBasicNodeMaterial();
    material.name = 'IndoorBackdrop';
    material.transparent = true;
    material.depthWrite = true;
    const p = positionLocal.xy.mul(this.radius);
    const r = length(p);
    const fp = this.footprint;
    const center = fp.xy.add(fp.zw).mul(0.5);
    const half = fp.zw.sub(fp.xy).mul(0.5);
    // Distance to the footprint rectangle: a soft contact shadow and a lighter "stage" around it.
    const outside = length(max(abs(p.sub(center)).sub(half), vec2(0)));
    const size = length(half);
    let ground: TSLNode = mix(color(GROUND_NEAR), color(GROUND_FAR), smoothstep(size, size.mul(8), outside));
    ground = mix(ground, color(HORIZON), smoothstep(this.radius.mul(0.08), this.radius.mul(0.45), r));
    const shadow = float(1).sub(smoothstep(0, 9, outside)).mul(0.45);
    ground = ground.mul(float(1).sub(shadow));
    // The building's sun shadow (M3.9) with real lighting, as dark as the contact shadow.
    ground = ground.mul(mix(0.55, 1, sunShadowFactor()));
    // Fine lines near the building only; 10 m lines fade out within a few hundred meters (a full-screen grid is busy).
    const minor = gridLines(p, 1).mul(0.22).mul(float(1).sub(smoothstep(25, 90, outside)));
    const major = gridLines(p, 10).mul(0.38).mul(float(1).sub(smoothstep(80, 450, outside)));
    ground = mix(ground, color(GRID_MINOR), minor);
    material.colorNode = mix(ground, color(GRID_MAJOR), major);
    // Fades into the background at the rim, so the disk has no visible edge.
    material.opacityNode = this.amount.mul(float(1).sub(smoothstep(this.radius.mul(0.55), this.radius, r)));
    this.mesh = new Mesh(new CircleGeometry(1, 128), material);
    this.mesh.name = 'IndoorBackdrop ground';
    // Drawn before other transparent meshes (faded rooms blend over it).
    this.mesh.renderOrder = -1;
    this.mesh.frustumCulled = false;
    this.group.add(this.mesh);
  }

  /** Whether the backdrop shows (or is fading). */
  get visible(): boolean {
    return this.group.visible;
  }

  /**
   * Studio sky for a world direction: a dark gradient above the building's
   * horizon with a faint glow at the horizon, fading darker below. Mix it into the
   * scene background with `amount`.
   */
  backgroundNode(direction: TSLNode): TSLNode {
    const t = dot(direction, this.up);
    const sky = mix(color(HORIZON), color(ZENITH), smoothstep(0, 0.65, t));
    const below = mix(color(HORIZON), color(BELOW), smoothstep(0, -0.3, t));
    const studio = mix(below, sky, smoothstep(-0.002, 0.002, t));
    return studio.add(color(HORIZON).mul(exp(abs(t).mul(-40))).mul(0.3));
  }

  /**
   * Shows the backdrop under `building` (null hides it), fading over a third
   * of a second. Returns true while something changed this frame.
   */
  update(building: Building | null, dt: number): boolean {
    if (building) {
      if (building !== this.building) this.attach(building);
      this.target = 1;
    } else {
      this.target = 0;
    }
    const b = this.building;
    if (b) {
      this.group.matrix.copy(b.root.matrixWorld);
      this.group.matrixWorldNeedsUpdate = true;
      // Under the lowest visible floor, so basements entered from above stay above the ground.
      let lowest = 0;
      for (const f of b.floors) if (f.visible) lowest = Math.min(lowest, f.group.position.z);
      this.mesh.position.z = lowest - DROP;
      this.mesh.updateMatrix();
    }
    const a = this.amount.value;
    const k = Math.min(1, dt / FADE_TIME);
    const next = a < this.target ? Math.min(this.target, a + k) : Math.max(this.target, a - k);
    this.amount.value = next;
    this.group.visible = next > 0.001;
    if (!this.group.visible) this.building = null;
    return next !== a;
  }

  private attach(b: Building): void {
    this.building = b;
    const doc = b.doc;
    const outline = doc.footprint ?? doc.floors.flatMap((f) => [...(f.outline ?? []), ...(f.rooms ?? []).flatMap((r) => r.footprint)]);
    const [x0, y0, x1, y1] = outline.length ? bounds2(outline) : [-10, -10, 10, 10];
    this.footprint.value.set(x0, y0, x1, y1);
    const radius = Math.max(MIN_RADIUS, Math.hypot(x1 - x0, y1 - y0) * 0.5 * RADIUS_PER_BUILDING_RADIUS);
    this.radius.value = radius;
    this.mesh.scale.set(radius, radius, 1);
    this.ellipsoid.geodeticNormal(_v.setFromMatrixPosition(b.root.matrixWorld), this.up.value);
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as MeshBasicNodeMaterial).dispose();
    this.group.removeFromParent();
  }
}
