import { describe, expect, it } from 'vitest';
import { Ellipsoid } from '../src/core/Ellipsoid';
import { isTerraViewError, TerraViewError } from '../src/core/errors';
import { DEFAULT_LOCALE, localize, MESSAGES, resolveMessages, type LocaleId } from '../src/core/i18n';
import { IMAGERY_PRESETS, OVERLAY_PRESETS } from '../src/globe/imagery/presets';
import { Building } from '../src/indoor/Building';
import { parseBuildingDoc } from '../src/indoor/schema';
import { parsePoints } from '../src/markers/points';
import { checkViewerOptions } from '../src/viewer/viewerOptions';

const E = Ellipsoid.WGS84;
const LOCALES: LocaleId[] = ['zh-CN', 'en'];

function doc(): Record<string, unknown> {
  return {
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
        elements: [{ id: 'c1', kind: 'column', position: [1, 2, 0] }],
      },
    ],
  };
}

describe('locales', () => {
  it('defaults to zh-CN', () => {
    expect(DEFAULT_LOCALE).toBe('zh-CN');
    expect(resolveMessages()).toEqual(MESSAGES['zh-CN']);
    expect(resolveMessages().entityProperties.area).toBe('面积');
  });

  it('has every text in every locale', () => {
    const keys = (l: LocaleId) => Object.keys(MESSAGES[l].entityProperties).sort();
    for (const l of LOCALES) {
      expect(keys(l)).toEqual(keys('zh-CN'));
      for (const v of Object.values(MESSAGES[l].entityProperties)) expect(v.trim()).not.toBe('');
      expect(MESSAGES[l].pointLayerName.trim()).not.toBe('');
    }
    // Property names are keys of one object: they must not collide within a locale.
    for (const l of LOCALES) {
      const names = Object.values(MESSAGES[l].entityProperties);
      expect(new Set(names).size).toBe(names.length);
    }
  });

  it('merges overrides over the locale', () => {
    const m = resolveMessages('en', { entityProperties: { area: 'Floor area' }, pointLayerName: 'Sites' });
    expect(m.entityProperties.area).toBe('Floor area');
    expect(m.entityProperties.elevation).toBe('Elevation');
    expect(m.pointLayerName).toBe('Sites');
    // The shared tables are not modified.
    expect(MESSAGES.en.entityProperties.area).toBe('Area');
  });

  it('labels every preset in every locale', () => {
    for (const p of [...IMAGERY_PRESETS, ...OVERLAY_PRESETS]) {
      for (const l of LOCALES) expect(localize(p.label, l).trim(), `${p.id} ${l}`).not.toBe('');
    }
    expect(localize(IMAGERY_PRESETS[0].label)).toBe(IMAGERY_PRESETS[0].label['zh-CN']);
  });
});

describe('entity property names', () => {
  it('uses zh-CN names by default', () => {
    const b = new Building(parseBuildingDoc(doc()), E, null);
    expect(b.properties).toMatchObject({ 楼层数: 1, 建筑高度: '4.0 m' });
    const [floor] = b.floors;
    expect(floor.properties).toMatchObject({ 楼层: '1F', 标高: '0.00 m', 层高: '4.00 m', 面积: '80.0 m²' });
    expect(floor.children.find((c) => c.type === 'room')?.properties).toMatchObject({ 面积: '80.0 m²' });
    expect(floor.children.find((c) => c.type === 'element')?.properties).toMatchObject({ 类型: 'column' });
  });

  it('follows the messages passed in', () => {
    const b = new Building(parseBuildingDoc(doc()), E, null, undefined, { messages: resolveMessages('en') });
    expect(b.properties).toMatchObject({ Floors: 1, 'Building height': '4.0 m' });
    const [floor] = b.floors;
    expect(floor.properties).toMatchObject({ Floor: '1F', Elevation: '0.00 m', 'Storey height': '4.00 m', Area: '80.0 m²' });
    expect(floor.properties).not.toHaveProperty('面积');
    expect(floor.children.find((c) => c.type === 'element')?.properties).toMatchObject({ Type: 'column' });
  });

  it('lets the document override an automatic property', () => {
    const d = doc();
    (d.floors as Record<string, unknown>[])[0].properties = { 面积: '79 m² (measured)' };
    const b = new Building(parseBuildingDoc(d), E, null);
    expect(b.floors[0].properties['面积']).toBe('79 m² (measured)');
  });
});

describe('errors', () => {
  it('carries a code and details next to an English message', () => {
    const err = new TerraViewError('building-already-loaded', 'building b1 is already loaded', { id: 'b1' });
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('TerraViewError');
    expect(err.details.id).toBe('b1');
    expect(isTerraViewError(err)).toBe(true);
    expect(isTerraViewError(err, 'building-already-loaded')).toBe(true);
    expect(isTerraViewError(err, 'points-empty')).toBe(false);
    expect(isTerraViewError(new Error('x'))).toBe(false);
  });

  it('reports building schema errors with their JSON path', () => {
    const d = doc();
    (d.floors as Record<string, unknown>[])[0].height = -1;
    let caught: unknown;
    try {
      parseBuildingDoc(d);
    } catch (e) {
      caught = e;
    }
    expect(isTerraViewError(caught, 'building-invalid')).toBe(true);
    const err = caught as TerraViewError;
    expect(err.details.path).toBe('$.floors[0].height');
    expect(err.message.startsWith('$.floors[0].height: ')).toBe(true);
    expect(err.name).toBe('BuildingSchemaError');
  });

  it('rejects missing required viewer options before any GPU work', () => {
    const container = { appendChild: () => undefined };
    const imagery = { requestImage: async () => null };
    const codeOf = (o: unknown) => {
      try {
        checkViewerOptions(o);
        return 'ok';
      } catch (e) {
        return isTerraViewError(e, 'option-invalid') ? `${e.code}:${e.details.option}` : String(e);
      }
    };
    expect(codeOf({ container, imagery })).toBe('ok');
    expect(codeOf({ container })).toBe('option-invalid:imagery');
    expect(codeOf({ container, imagery: {} })).toBe('option-invalid:imagery');
    expect(codeOf({ imagery })).toBe('option-invalid:container');
    expect(codeOf(undefined)).toBe('option-invalid:container');
  });

  it('writes point parse warnings in English', () => {
    expect(parsePoints(42).warnings).toEqual(['unrecognized data: expected a JSON object or array']);
    const parsed = parsePoints([{ lon: 500, lat: 0 }, { name: 'x' }]);
    expect(parsed.warnings[0]).toContain('invalid coordinates (500, 0)');
    expect(parsed.warnings[1]).toContain('no longitude / latitude field');
  });
});

/**
 * Guard: display text lives in core/i18n.ts, errors are English. Chinese in other SDK code is
 * allowed only where it is data rather than text (input field aliases, a provider's own credit
 * line, preset labels that sit next to their English version).
 */
describe('no stray Chinese text in the SDK', () => {
  const ALLOWED: { file: string; line?: RegExp }[] = [
    { file: 'core/i18n.ts' },
    { file: 'globe/imagery/presets.ts', line: /^\s*(label: \{ 'zh-CN'|attribution:)/ },
    { file: 'markers/points.ts', line: /^const [A-Z_]+_KEYS = \[/ },
    { file: 'vector/vector.worker.ts', line: /^const LABEL_FIELDS = \[/ },
  ];
  /** Every SDK source file as text (Vite's glob import: no Node APIs, which the tests have no types for). */
  const sources = import.meta.glob<string>('../src/**/*.ts', { query: '?raw', import: 'default', eager: true });

  /** Lines with CJK characters outside comments. */
  function chineseLines(text: string): { line: number; text: string }[] {
    const out: { line: number; text: string }[] = [];
    let inBlock = false;
    text.split('\n').forEach((raw, i) => {
      let code = raw;
      if (inBlock) {
        const end = code.indexOf('*/');
        if (end < 0) return;
        code = code.slice(end + 2);
        inBlock = false;
      }
      code = code.replace(/\/\*.*?\*\//g, '');
      const open = code.indexOf('/*');
      if (open >= 0) {
        code = code.slice(0, open);
        inBlock = true;
      }
      code = code.replace(/(^|[^:'"`])\/\/.*$/, '$1');
      if (/[一-鿿]/.test(code)) out.push({ line: i + 1, text: raw });
    });
    return out;
  }

  it('keeps Chinese to the allowed places', () => {
    const stray: string[] = [];
    expect(Object.keys(sources).length).toBeGreaterThan(50);
    for (const [path, text] of Object.entries(sources)) {
      const file = path.replace(/^\.\.\/src\//, '');
      const rules = ALLOWED.filter((a) => a.file === file);
      if (rules.some((r) => !r.line)) continue;
      for (const l of chineseLines(text)) {
        if (!rules.some((r) => r.line!.test(l.text))) stray.push(`src/${file}:${l.line}: ${l.text.trim()}`);
      }
    }
    expect(stray).toEqual([]);
  });
});
