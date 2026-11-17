/**
 * `viewer.effects`: per-object outlines and glow (roadmap M3.2) for three.js objects, outline
 * styles, and the look of the two effects. BIM entities carry their own (`entity.effects`);
 * selection and hover outlines come from `indoor.selectOutline` / `hoverOutline`.
 */
import type { Object3D } from 'three';
import type { EffectMarks } from './EffectMarks';
import type { GlowEffect } from './GlowEffect';
import type { OutlineEffect } from './OutlineEffect';
import type { ObjectEffects, OutlineStyle } from './postMath';

export class ViewerEffects {
  /** Created by the viewer (`viewer.effects`). */
  constructor(
    private readonly marks: EffectMarks,
    private readonly outline: OutlineEffect,
    private readonly glow: GlowEffect,
    private readonly changed: () => void,
  ) {}

  /**
   * Defines or replaces an outline style. Built in: `select` (selection), `hover`, `alarm`
   * (red, pulsing, shown through walls). Entities and objects using the name follow at once.
   */
  defineOutline(name: string, style: OutlineStyle): void {
    this.marks.defineOutline(name, style);
  }

  /** An outline style by name (numbers normalized), or null. */
  outlineStyle(name: string): Required<OutlineStyle> | null {
    return this.marks.outlineStyle(name);
  }

  /** Names of the defined outline styles. */
  get outlineNames(): string[] {
    return this.marks.outlineNames;
  }

  /**
   * Sets effects on a three.js object added to `viewer.scene` (merged with what it has; a
   * null field clears it), or with `null` removes them. Covers the object's visible meshes;
   * instanced and skinned meshes are drawn as their plain geometry. The viewer keeps a
   * reference until the effects are removed.
   */
  set(object: Object3D, effects: ObjectEffects | null): void {
    this.marks.set(object, effects);
  }

  /** The effects set on a three.js object (empty when none). */
  get(object: Object3D): Readonly<ObjectEffects> {
    return this.marks.get(object);
  }

  /** Removes the effects of every three.js object (entities keep theirs). */
  clear(): void {
    this.marks.clear();
  }

  /** Outline width in CSS pixels, 1–6 (default 2). */
  get outlineWidth(): number {
    return this.outline.width;
  }

  set outlineWidth(v: number) {
    this.outline.width = v;
    this.changed();
  }

  /** Strength of the glow halo, ≥ 0 (default 1). */
  get glowStrength(): number {
    return this.glow.strength.value as number;
  }

  set glowStrength(v: number) {
    this.glow.strength.value = Number.isFinite(v) ? Math.max(0, v) : 1;
    this.changed();
  }

  /** Spread of the glow halo, 0..1 (default 0.5). */
  get glowRadius(): number {
    return this.glow.radius.value as number;
  }

  set glowRadius(v: number) {
    this.glow.radius.value = Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0.5;
    this.changed();
  }
}
