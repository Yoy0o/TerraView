import { describe, expect, it } from 'vitest';
import { compileSelector, SelectorError, selectorCacheSize, type Selectable } from '../src/indoor/selector';

function entity(overrides: Partial<Selectable> & { tags?: string[] } = {}): Selectable {
  const { tags, ...rest } = overrides;
  return {
    id: 'F3-TH05',
    type: 'thing',
    name: '303 温湿度',
    category: 'sensor',
    properties: { 温度: '23.1 ℃', 湿度: 56, 状态: '正常', floor: 3, online: true },
    tags: new Set(tags ?? ['hvac', 'monitored']),
    ...rest,
  };
}

const e = entity();
const match = (selector: string, target: Selectable = e) => compileSelector(selector)(target);

describe('selector terms', () => {
  it('matches type, id and names', () => {
    expect(match('.thing')).toBe(true);
    expect(match('.Thing')).toBe(true);
    expect(match('.room')).toBe(false);
    expect(match('#F3-TH05')).toBe(true);
    expect(match('#F3-TH06')).toBe(false);
    expect(match('303 温湿度')).toBe(true);
    expect(match('"303 温湿度"')).toBe(true);
    expect(match("'303 温湿度'")).toBe(true);
    expect(match('303')).toBe(false);
    expect(match('/^303/')).toBe(true);
    expect(match('/温湿度$/')).toBe(true);
    expect(match('/^abc/i')).toBe(false);
    expect(match('/^ABC|^303/gi')).toBe(true);
    // 'g' would make RegExp.test stateful: matching twice must give the same answer.
    expect(match('/^ABC|^303/gi')).toBe(true);
  });

  it('compares attributes', () => {
    expect(match('[category=sensor]')).toBe(true);
    expect(match('[category = sensor]')).toBe(true);
    expect(match('[category==sensor]')).toBe(true);
    expect(match('[category!=sensor]')).toBe(false);
    expect(match('[状态=正常]')).toBe(true);
    expect(match('[prop.状态=正常]')).toBe(true);
    expect(match('[状态!=告警]')).toBe(true);
    // Missing attributes are "not equal".
    expect(match('[missing!=x]')).toBe(true);
    expect(match('[missing=x]')).toBe(false);
    expect(match('[name="303 温湿度"]')).toBe(true);
    expect(match('[id=F3-*]')).toBe(true);
    expect(match('[id="F3-*"]')).toBe(false);
    expect(match('[online=true]')).toBe(true);
    expect(match('[湿度=56.0]')).toBe(true);
  });

  it('compares numbers, reading the leading number of values with units', () => {
    expect(match('[温度>23]')).toBe(true);
    expect(match('[温度>=23.1]')).toBe(true);
    expect(match('[温度<23.1]')).toBe(false);
    expect(match('[湿度<=56]')).toBe(true);
    expect(match('[floor>2]')).toBe(true);
    expect(match('[状态>1]')).toBe(false);
    expect(match('[missing>1]')).toBe(false);
  });

  it('tests existence', () => {
    expect(match('[温度]')).toBe(true);
    expect(match('[missing]')).toBe(false);
  });

  it('matches tags', () => {
    expect(match('tags:or(hvac, alarm)')).toBe(true);
    expect(match('tags(alarm, hvac)')).toBe(true);
    expect(match('tags:and(hvac, monitored)')).toBe(true);
    expect(match('tags:and(hvac, alarm)')).toBe(false);
    expect(match('tags:not(alarm)')).toBe(true);
    expect(match('tags:not(alarm, hvac)')).toBe(false);
    expect(match('tags:or("hvac")')).toBe(true);
  });
});

describe('selector operators', () => {
  it('combines with &&, ||, ! and parentheses', () => {
    expect(match('.thing && [category=sensor]')).toBe(true);
    expect(match('.thing && [category=camera]')).toBe(false);
    expect(match('.room || .thing')).toBe(true);
    expect(match('!.room')).toBe(true);
    expect(match('!(.room || .thing)')).toBe(false);
    expect(match('!!.thing')).toBe(true);
  });

  it('binds && tighter than || and commas loosest', () => {
    // a || b && c  ==  a || (b && c)
    expect(match('.thing || .room && .floor')).toBe(true);
    expect(match('(.thing || .room) && .floor')).toBe(false);
    expect(match('.room && .floor || .thing')).toBe(true);
    expect(match('.room, .thing')).toBe(true);
    expect(match('.room, .floor')).toBe(false);
    expect(match('.room, .thing && [category=camera]')).toBe(false);
  });

  it('and-s terms written back to back', () => {
    expect(match('.thing[category=sensor]')).toBe(true);
    expect(match('.thing[category=camera]')).toBe(false);
    expect(match('#F3-TH05.thing')).toBe(true);
    expect(match('[category=sensor][状态=正常]')).toBe(true);
  });

  it('keeps inner spaces of bare names', () => {
    const cam = entity({ name: 'Cam 1', type: 'thing' });
    expect(match('Cam 1', cam)).toBe(true);
    expect(match('  Cam 1  ', cam)).toBe(true);
    expect(match('Cam 1 || .room', cam)).toBe(true);
    expect(match('Cam 2, Cam 1', cam)).toBe(true);
  });

  it('treats an empty selector as matching nothing', () => {
    expect(match('')).toBe(false);
    expect(match('   ')).toBe(false);
  });
});

describe('selector errors and cache', () => {
  function errorAt(selector: string): number {
    try {
      compileSelector(selector);
    } catch (err) {
      expect(err).toBeInstanceOf(SelectorError);
      return (err as SelectorError).index;
    }
    throw new Error(`"${selector}" compiled`);
  }

  it('reports the position of syntax errors', () => {
    expect(errorAt('.room &&')).toBe(8);
    expect(errorAt('(.room || .thing')).toBe(16);
    expect(errorAt('.room)')).toBe(5);
    expect(errorAt('[category')).toBe(9);
    expect(errorAt('[=x]')).toBe(1);
    expect(errorAt('[a x]')).toBe(3);
    expect(errorAt('.')).toBe(0);
    expect(errorAt('#')).toBe(0);
    expect(errorAt('/abc')).toBe(0);
    expect(errorAt('/(/')).toBe(0);
    expect(errorAt('"abc')).toBe(0);
    expect(errorAt('tags:or()')).toBe(8);
    expect(errorAt('.room .thing')).toBe(6);
    expect(() => compileSelector('.room &&')).toThrow('index 8');
  });

  it('caches compiled selectors and drops the least recently used past 256', () => {
    const first = compileSelector('.cache-test-0');
    expect(compileSelector('.cache-test-0')).toBe(first);
    for (let i = 1; i <= 300; i++) compileSelector(`.cache-test-${i}`);
    expect(selectorCacheSize()).toBeLessThanOrEqual(256);
    // Evicted: compiles again into a new function.
    expect(compileSelector('.cache-test-0')).not.toBe(first);
    const recent = compileSelector('.cache-test-300');
    expect(compileSelector('.cache-test-300')).toBe(recent);
  });
});
