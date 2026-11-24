/**
 * Default indoor interactions of a viewer (ThingJS level behavior), registered with the tags
 * `indoor` and `indoor-hover` so hosts can remove or pause them (`interaction.off(type, tag)`).
 */
import type { IndoorManager } from '../indoor/IndoorManager';
import type { InteractionManager } from './InteractionManager';

/**
 * Double click enters the next level under the cursor (building → floor →
 * room / thing), right click or Esc goes back, hovering highlights. What a
 * pick acts on comes from the current level control (`indoor.filterObject`).
 */
export function installIndoorBehaviors(interaction: InteractionManager, indoor: IndoorManager): void {
  interaction.on(
    'dblclick',
    (e) => {
      const next = e.entity ? indoor.nextLevel(e.entity) : null;
      if (!next) return;
      e.preventDefault();
      void indoor.enter(next);
    },
    { tag: 'indoor' },
  );
  interaction.on(
    'rightclick',
    () => {
      if (indoor.current) void indoor.back();
    },
    { tag: 'indoor' },
  );
  // A label click selects its own entity (e.g. an alarm card seen from the globe); scene picks select the level unit.
  interaction.on('click', (e) => indoor.select(e.entity ? (e.marker ? e.entity : indoor.filterObject(e.entity)) : null), { tag: 'indoor' });
  // Hover picking costs a ray cast per frame of pointer motion: only while buildings exist.
  let hoverOn = false;
  indoor.events.on('buildings-changed', (buildings) => {
    const want = buildings.length > 0;
    if (want === hoverOn) return;
    hoverOn = want;
    if (want) {
      interaction.on(
        'mousemove',
        (e) => {
          const unit = e.entity ? indoor.filterObject(e.entity) : null;
          // The level the camera is in is not highlighted, nor a building from inside.
          indoor.setHovered(unit && unit !== indoor.current && !(unit.type === 'building' && indoor.current) ? unit : null);
        },
        { tag: 'indoor-hover' },
      );
      interaction.on('mouseleave', (e) => !e.entity && indoor.setHovered(null), { tag: 'indoor-hover' });
    } else {
      interaction.off('mousemove', 'indoor-hover');
      interaction.off('mouseleave', 'indoor-hover');
      indoor.setHovered(null);
    }
  });
}
