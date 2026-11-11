import { Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { Ellipsoid } from '../src/core/Ellipsoid';
import { Building } from '../src/indoor/Building';
import { parseBuildingDoc } from '../src/indoor/schema';
import type { Marker } from '../src/markers/MarkerManager';
import { InteractionManager, type InteractionEvent, type PickInfo } from '../src/viewer/InteractionManager';

const building = new Building(
  parseBuildingDoc({
    format: 'three-geo-building',
    version: '1.0',
    id: 'b1',
    anchor: { longitude: 116.39, latitude: 39.9, height: 50 },
    floors: [
      {
        id: 'f1',
        index: 0,
        elevation: 0,
        height: 4,
        rooms: [{ id: 'r1', footprint: [[0, 0], [10, 0], [10, 8], [0, 8]] }],
        things: [{ id: 't1', position: [5, 4, 0] }],
      },
    ],
  }),
  Ellipsoid.WGS84,
  null,
);
const floor = building.floors[0];
const [room, thing] = floor.children;

function setup(hit: () => PickInfo['entity'] = () => room) {
  const dom = new EventTarget() as unknown as HTMLElement;
  const pickAt = (clientX: number, clientY: number): PickInfo => {
    const entity = hit();
    return { kind: entity ? 'entity' : 'globe', entity, tileset: null, point: null, cartographic: null, clientX, clientY, marker: null };
  };
  const im = new InteractionManager({ domElement: dom, pickAt, toCartographic: (p) => Ellipsoid.WGS84.cartesianToCartographic(p) });
  const pointer = (type: string, init: Record<string, unknown>) => dom.dispatchEvent(Object.assign(new Event(type), { isPrimary: true, button: 0, buttons: 0, clientX: 10, clientY: 10, ...init }));
  const click = (button = 0) => {
    pointer('pointerdown', { button });
    pointer('pointerup', { button });
  };
  return { im, dom, pointer, click };
}

describe('InteractionManager listeners', () => {
  it('runs by priority, then deepest match, then registration order', () => {
    const { im, click } = setup();
    const log: string[] = [];
    im.on('click', () => log.push('plain'));
    im.on('click', (e) => log.push(`building:${e.object?.id}`), { selector: '.building' });
    im.on('click', (e) => log.push(`floor:${e.object?.id}`), { selector: '.floor' });
    im.on('click', () => log.push('urgent'), { priority: 5 });
    im.on('click', () => log.push('plain2'));
    click();
    expect(log).toEqual(['urgent', 'plain', 'plain2', 'floor:f1', 'building:b1']);
  });

  it('removes once listeners after their first call', () => {
    const { im, click } = setup();
    let n = 0;
    im.on('click', () => n++, { once: true });
    click();
    click();
    expect(n).toBe(1);
  });

  it('stops propagation to lower priorities and ancestors, but not peers', () => {
    const { im, click } = setup();
    const log: string[] = [];
    im.on('click', (e) => {
      log.push('room-a');
      e.stopPropagation();
    }, { selector: '.room' });
    im.on('click', () => log.push('room-b'), { selector: '.room' });
    im.on('click', () => log.push('floor'), { selector: '.floor' });
    im.on('click', () => log.push('low'), { priority: -1 });
    click();
    expect(log).toEqual(['room-a', 'room-b']);
  });

  it('stops every remaining listener with stopImmediatePropagation', () => {
    const { im, click } = setup();
    const log: string[] = [];
    im.on('click', (e) => {
      log.push('a');
      e.stopImmediatePropagation();
    });
    im.on('click', () => log.push('b'));
    click();
    expect(log).toEqual(['a']);
  });

  it('reports preventDefault from any listener', () => {
    const { im } = setup();
    im.on('dblclick', () => undefined);
    im.on('dblclick', (e) => e.preventDefault(), { selector: '.room' });
    expect(im.dispatchDoubleClick({ clientX: 1, clientY: 2, button: 0 } as MouseEvent)).toBe(true);
  });

  it('ignores drags and removes listeners by tag', () => {
    const { im, pointer, click } = setup();
    let n = 0;
    im.on('click', () => n++, { tag: 'x' });
    pointer('pointerdown', { clientX: 0 });
    pointer('pointerup', { clientX: 50 });
    expect(n).toBe(0);
    click();
    expect(n).toBe(1);
    im.off('click', 'x');
    click();
    expect(n).toBe(1);
  });
});

describe('InteractionManager hover', () => {
  it('fires leave before enter with selector bubbling, once per change', () => {
    let target: PickInfo['entity'] = room;
    const { im, pointer } = setup(() => target);
    const log: string[] = [];
    im.on('mouseenter', (e) => log.push(`enter:${e.object?.id}`), { selector: '.room, .thing' });
    im.on('mouseleave', (e) => log.push(`leave:${e.object?.id}`), { selector: '.room, .thing' });
    im.on('mouseenter', (e) => log.push(`enter-floor:${e.object?.id}`), { selector: '.floor', once: true });
    const move = () => {
      pointer('pointermove', {});
      im.update();
    };
    move();
    move();
    target = thing;
    move();
    target = null;
    move();
    target = room;
    move();
    expect(log).toEqual(['enter:r1', 'enter-floor:f1', 'leave:r1', 'enter:t1', 'leave:t1', 'enter:r1']);
    // Leaving the canvas clears hover.
    pointer('pointerleave', {});
    expect(log.at(-1)).toBe('leave:r1');
  });

  it('does not pick while a button is held (camera drag)', () => {
    let picks = 0;
    const { im, pointer } = setup(() => {
      picks++;
      return room;
    });
    im.on('mousemove', () => undefined);
    pointer('pointermove', { buttons: 1 });
    im.update();
    expect(picks).toBe(0);
    pointer('pointermove', {});
    im.update();
    expect(picks).toBe(1);
  });
});

describe('InteractionManager event proxy', () => {
  it('dispatches label events as events on the entity', () => {
    const { im } = setup(() => null);
    const events: InteractionEvent[] = [];
    im.on('click', (e) => events.push(e), { selector: '.floor' });
    im.on('rightclick', (e) => events.push(e));
    const marker = {} as Marker;
    const point = Ellipsoid.WGS84.cartographicToCartesian(116.39 * (Math.PI / 180), 39.9 * (Math.PI / 180), 60);
    im.dispatchProxy('click', room, { clientX: 3, clientY: 4 } as MouseEvent, { marker, point });
    im.dispatchProxy('rightclick', thing, null);
    expect(events).toHaveLength(2);
    const [click, right] = events;
    expect(click.entity).toBe(room);
    expect(click.object).toBe(floor);
    expect(click.marker).toBe(marker);
    expect(click.kind).toBe('entity');
    expect(click.clientX).toBe(3);
    expect(click.cartographic!.height).toBeCloseTo(60, 3);
    expect((click.point as Vector3).equals(point)).toBe(true);
    expect(right.button).toBe(2);
    expect(right.entity).toBe(thing);
    expect(right.marker).toBeNull();
  });

  it('does nothing while disabled or without listeners', () => {
    const { im } = setup();
    expect(im.dispatchProxy('dblclick', room, null)).toBe(false);
    im.on('dblclick', (e) => e.preventDefault());
    im.enabled = false;
    expect(im.dispatchProxy('dblclick', room, null)).toBe(false);
    im.enabled = true;
    expect(im.dispatchProxy('dblclick', room, null)).toBe(true);
  });
});

describe('InteractionManager pause', () => {
  it('pauses all, by tag, by type, and resumes', () => {
    const { im, click } = setup();
    const log: string[] = [];
    im.on('click', () => log.push('a'), { tag: 'x' });
    im.on('click', () => log.push('b'));
    const resumeAll = im.pause();
    expect(im.paused).toBe(true);
    click();
    expect(log).toEqual([]);
    resumeAll();
    im.pause({ tag: 'x' });
    click();
    expect(log).toEqual(['b']);
    im.pause({ type: 'dblclick' });
    click();
    expect(log).toEqual(['b', 'b']);
    im.resume({ tag: 'x' });
    click();
    expect(log).toEqual(['b', 'b', 'a', 'b']);
    im.resume();
    expect(im.paused).toBe(false);
  });

  it('covers listeners registered while paused; stacked pauses lift one by one', () => {
    const { im, click } = setup();
    let n = 0;
    const r1 = im.pause({ type: ['click', 'rightclick'] });
    const r2 = im.pause({ type: 'click' });
    im.on('click', () => n++);
    click();
    r1();
    click();
    expect(n).toBe(0);
    r2();
    click();
    expect(n).toBe(1);
  });

  it('pauses by selector range: only picks inside matching entities', () => {
    let target: PickInfo['entity'] = room;
    const { im, click } = setup(() => target);
    const log: string[] = [];
    im.on('click', (e) => log.push(e.entity?.id ?? 'globe'));
    im.pause({ selector: '#r1' });
    click();
    target = thing;
    click();
    target = null;
    click();
    expect(log).toEqual(['t1', 'globe']);
    im.resume({ selector: '#r1' });
    target = room;
    click();
    expect(log.at(-1)).toBe('r1');
  });

  it('keeps once listeners while paused and respects priority after resuming', () => {
    const { im, click } = setup();
    const log: string[] = [];
    im.on('click', () => log.push('once'), { once: true, tag: 'p' });
    im.on('click', (e) => {
      log.push('high');
      e.stopPropagation();
    }, { priority: 5, tag: 'p' });
    im.on('click', () => log.push('low'));
    im.pause({ tag: 'p' });
    click();
    // The paused high-priority listener cannot stop the others.
    expect(log).toEqual(['low']);
    im.resume({ tag: 'p' });
    click();
    click();
    expect(log).toEqual(['low', 'high', 'high']);
  });

  it('does not block the default unless asked; blockDefault prevents it', () => {
    const { im } = setup();
    const dbl = { clientX: 1, clientY: 2, button: 0 } as MouseEvent;
    im.on('dblclick', (e) => e.preventDefault(), { tag: 'indoor' });
    expect(im.dispatchDoubleClick(dbl)).toBe(true);
    im.pause({ tag: 'indoor' });
    // Listener silenced, camera default (fly closer) goes ahead.
    expect(im.dispatchDoubleClick(dbl)).toBe(false);
    im.pause({ type: 'dblclick', blockDefault: true });
    expect(im.dispatchDoubleClick(dbl)).toBe(true);
    im.resume();
    im.off('dblclick');
    // blockDefault works without any listener too, and for label proxies.
    im.pause({ blockDefault: true, selector: '.floor' });
    expect(im.dispatchDoubleClick(dbl)).toBe(true);
    expect(im.dispatchProxy('dblclick', room, null)).toBe(true);
    expect(im.dispatchProxy('dblclick', building, null)).toBe(false);
  });

  it('skips hover picking when all hover listeners are paused, then catches up', () => {
    let picks = 0;
    let target: PickInfo['entity'] = room;
    const { im, pointer } = setup(() => {
      picks++;
      return target;
    });
    const log: string[] = [];
    im.on('mouseenter', (e) => log.push(`enter:${e.object?.id}`), { selector: '.room, .thing' });
    im.on('mouseleave', (e) => log.push(`leave:${e.object?.id}`), { selector: '.room, .thing' });
    const move = () => {
      pointer('pointermove', {});
      im.update();
    };
    move();
    const resume = im.pause();
    target = thing;
    move();
    expect(picks).toBe(1);
    expect(log).toEqual(['enter:r1']);
    resume();
    move();
    expect(log).toEqual(['enter:r1', 'leave:r1', 'enter:t1']);
  });
});
