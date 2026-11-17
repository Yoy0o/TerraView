/**
 * Objects drawn with per-object effects (roadmap M3.2): the outline styles, the effects set on
 * three.js objects (`viewer.effects.set`), and the sources the viewer adds each frame (BIM
 * entities with `entity.effects` or a selection / hover highlight). Once per drawn frame the
 * outline and glow passes ask for the meshes to draw: every visible mesh or batched instance of
 * every marked source, with its world matrix.
 *
 * Effects are drawn by re-rendering only these meshes into small masks (see OutlineEffect,
 * GlowEffect), never by changing the objects' own materials: batched devices keep one shader,
 * and nothing has to be restored.
 */
import { Color, LinearSRGBColorSpace, Matrix4, type BufferGeometry, type Material, type Mesh, type Object3D, type Side } from 'three';
import {
  BUILTIN_OUTLINES,
  mergeEffects,
  normalizeOutlineStyle,
  resolveEffects,
  type ObjectEffects,
  type OutlineStyle,
  type ResolvedEffects,
} from './postMath';

/** Receives one drawn mesh of a marked source: geometry, face side, world (ECEF) matrix. */
export type DrawableSink = (geometry: BufferGeometry, side: Side, matrixWorld: Matrix4) => void;

/** Something drawn with effects (a BIM entity, a three.js object). */
export interface EffectSource {
  /** Effects to draw this frame, or null for none. */
  resolvedEffects(): ResolvedEffects | null;
  /** Calls `add` for every mesh drawn for the source this frame (visible ones only). */
  collectDrawables(add: DrawableSink): void;
}

/** An outline style with numbers in range and its colors decoded. */
export interface ResolvedOutline extends Required<OutlineStyle> {
  readonly name: string;
  /** Edge color as sRGB-encoded components (the outline is composed after tone mapping). */
  readonly edge: Color;
  /** Hidden edge color, sRGB-encoded (null: no x-ray). */
  readonly hidden: Color | null;
  /** Linear color, for glow without a color of its own. */
  readonly linear: Color;
}

/** One mesh to draw in an effect pass. */
export interface MarkItem {
  geometry: BufferGeometry;
  side: Side;
  readonly matrixWorld: Matrix4;
  outline: ResolvedOutline | null;
  /** Glow intensity 0..1 (0: none). */
  glow: number;
  /** Linear glow color (shared per color; do not modify). */
  glowColor: Color;
}

const WHITE = new Color(1, 1, 1);

function sideOf(material: Material | Material[]): Side {
  return (Array.isArray(material) ? material[0] : material)?.side ?? 0;
}

/** Visible including every ancestor (three.js does not keep this). */
function shown(o: Object3D | null): boolean {
  for (let x = o; x; x = x.parent) if (!x.visible) return false;
  return true;
}

/** A three.js object marked through `viewer.effects.set`. */
class ObjectSource implements EffectSource {
  constructor(
    readonly object: Object3D,
    public effects: ObjectEffects,
    private readonly root: Object3D,
  ) {}

  resolvedEffects(): ResolvedEffects | null {
    return resolveEffects(this.effects);
  }

  collectDrawables(add: DrawableSink): void {
    // Only while it is in the viewer's scene and shown.
    let attached = false;
    for (let x: Object3D | null = this.object; x; x = x.parent) {
      if (!x.visible) return;
      if (x === this.root) attached = true;
    }
    if (!attached) return;
    this.object.traverseVisible((o) => {
      const mesh = o as Mesh & { isInstancedMesh?: boolean };
      // Instanced meshes would need their instances: not supported for plain objects.
      if (mesh.isMesh && !mesh.isInstancedMesh) add(mesh.geometry, sideOf(mesh.material), mesh.matrixWorld);
    });
  }
}

export class EffectMarks {
  /** Sources the viewer adds each frame (BIM entities); called once per drawn frame. */
  extraSources: () => Iterable<EffectSource> = () => [];
  /** Called when something changed how marked objects are drawn (the viewer redraws). */
  onChange: (() => void) | null = null;

  private readonly styles = new Map<string, ResolvedOutline>();
  private readonly objects = new Map<Object3D, ObjectSource>();
  private readonly glowColors = new Map<string, Color>();
  /** Sources with effects this frame and what they need (from `refresh`). */
  private current: { source: EffectSource; effects: ResolvedEffects }[] = [];
  private readonly items: MarkItem[] = [];
  private itemCount = 0;
  private gathered = -1;
  private _hasOutline = false;
  private _hasGlow = false;
  private _pulsing = false;

  constructor(private readonly root: Object3D) {
    for (const [name, style] of Object.entries(BUILTIN_OUTLINES)) this.defineOutline(name, style);
  }

  // ---------------------------------------------------------------------------
  // Styles

  /** Defines or replaces an outline style; objects using the name pick it up on the next frame. */
  defineOutline(name: string, style: OutlineStyle): void {
    const s = normalizeOutlineStyle(style);
    this.styles.set(name, {
      ...s,
      name,
      // Stored as given (sRGB components): the outline is composed in display space.
      edge: new Color().setStyle(s.color, LinearSRGBColorSpace),
      hidden: s.hiddenColor === null ? null : new Color().setStyle(s.hiddenColor, LinearSRGBColorSpace),
      linear: new Color().setStyle(s.color),
    });
    this.onChange?.();
  }

  /** An outline style by name, or null. */
  outlineStyle(name: string): Required<OutlineStyle> | null {
    const s = this.styles.get(name);
    return s ? { color: s.color, hiddenColor: s.hiddenColor, fill: s.fill, pulse: s.pulse } : null;
  }

  /** Names of the defined outline styles. */
  get outlineNames(): string[] {
    return [...this.styles.keys()];
  }

  // ---------------------------------------------------------------------------
  // Plain three.js objects

  /** Sets (merges) or, with null, clears the effects of a three.js object. */
  set(object: Object3D, effects: ObjectEffects | null): void {
    const existing = this.objects.get(object);
    const next = effects === null ? {} : mergeEffects(existing?.effects ?? {}, effects);
    if (resolveEffects(next) === null) this.objects.delete(object);
    else if (existing) existing.effects = next;
    else this.objects.set(object, new ObjectSource(object, next, this.root));
    this.onChange?.();
  }

  /** The effects set on a three.js object (empty when none). */
  get(object: Object3D): Readonly<ObjectEffects> {
    return this.objects.get(object)?.effects ?? {};
  }

  /** Clears the effects of every three.js object (entities keep theirs). */
  clear(): void {
    this.objects.clear();
    this.onChange?.();
  }

  // ---------------------------------------------------------------------------
  // Per frame

  /** Re-reads which sources have effects (before the frame is drawn). */
  refresh(): void {
    this.current.length = 0;
    this._hasOutline = this._hasGlow = this._pulsing = false;
    const visit = (source: EffectSource) => {
      const effects = source.resolvedEffects();
      if (!effects) return;
      const style = effects.outline !== null ? this.styles.get(effects.outline) : undefined;
      if (style) {
        this._hasOutline = true;
        if (style.pulse > 0) this._pulsing = true;
      }
      if (effects.glow > 0) this._hasGlow = true;
      this.current.push({ source, effects });
    };
    for (const s of this.objects.values()) visit(s);
    for (const s of this.extraSources()) visit(s);
  }

  /** Whether a marked source has a (known) outline style. */
  get hasOutline(): boolean {
    return this._hasOutline;
  }

  get hasGlow(): boolean {
    return this._hasGlow;
  }

  /** Whether a used outline style pulses (the frame rate stays up). */
  get pulsing(): boolean {
    return this._pulsing;
  }

  /**
   * Meshes to draw this frame (call after the scene was rendered: world matrices are current).
   * Gathered once per `stamp`; the array and its items are reused between frames.
   */
  gather(stamp: number): readonly MarkItem[] {
    if (stamp === this.gathered) return this.items.slice(0, this.itemCount);
    this.gathered = stamp;
    this.itemCount = 0;
    for (const { source, effects } of this.current) {
      const outline = effects.outline !== null ? (this.styles.get(effects.outline) ?? null) : null;
      const glowColor = effects.glowColor !== null ? this.colorOf(effects.glowColor) : (outline?.linear ?? WHITE);
      if (!outline && effects.glow === 0) continue;
      source.collectDrawables((geometry, side, matrixWorld) => {
        let item = this.items[this.itemCount];
        if (!item) {
          item = { geometry, side, matrixWorld: new Matrix4(), outline, glow: 0, glowColor };
          this.items.push(item);
        }
        item.geometry = geometry;
        item.side = side;
        item.matrixWorld.copy(matrixWorld);
        item.outline = outline;
        item.glow = effects.glow;
        item.glowColor = glowColor;
        this.itemCount++;
      });
    }
    // Do not keep references to geometries that are gone.
    for (let i = this.itemCount; i < this.items.length; i++) this.items[i].geometry = null as unknown as BufferGeometry;
    return this.items.slice(0, this.itemCount);
  }

  private colorOf(css: string): Color {
    let c = this.glowColors.get(css);
    if (!c) {
      c = new Color().setStyle(css);
      if (this.glowColors.size > 256) this.glowColors.clear();
      this.glowColors.set(css, c);
    }
    return c;
  }

  /** Forgets every object (viewer disposed). */
  dispose(): void {
    this.objects.clear();
    this.current.length = 0;
    this.items.length = 0;
    this.itemCount = 0;
  }
}

export { shown as isShownInScene, sideOf as materialSide };
