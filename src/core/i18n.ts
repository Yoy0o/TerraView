/**
 * Text the SDK itself puts in front of end users, per locale. Default `zh-CN`.
 *
 * What is localized here: property names the SDK adds to BIM entities (shown in property
 * popups, usable in selectors such as `[面积>20]` / `[Area>20]`), the default name of a point
 * layer, and the labels of the built-in imagery / overlay presets (`LocalizedText`).
 * What is not: error messages (English, with a `code`, see `core/errors.ts`), attributions
 * (each provider's own credit line), and the field-name aliases accepted in input data
 * ("经度", "名称", ...), which are data compatibility rather than display text.
 *
 * Dependency-free.
 */

export type LocaleId = 'zh-CN' | 'en';

export const DEFAULT_LOCALE: LocaleId = 'zh-CN';

/** The same text in every supported locale. */
export type LocalizedText = Readonly<Record<LocaleId, string>>;

export interface ViewerMessages {
  /** Property names the SDK adds to BIM entities (values are numbers or strings with units). */
  readonly entityProperties: {
    /** Building: number of floors. */
    readonly floorCount: string;
    /** Building: height from the lowest floor to the top (`"12.0 m"`). */
    readonly buildingHeight: string;
    /** Floor: its name. */
    readonly floor: string;
    /** Floor: elevation of the floor level (`"3.60 m"`). */
    readonly elevation: string;
    /** Floor: storey height (`"3.60 m"`). */
    readonly storeyHeight: string;
    /** Floor and room: outline area (`"80.0 m²"`); also the default subtitle of room labels. */
    readonly area: string;
    /** Structural element: its kind (`wall`, `column`, ...). */
    readonly kind: string;
  };
  /** Name of a point layer created without `name` or `url`. */
  readonly pointLayerName: string;
}

/** Overrides for `GeoViewerOptions.messages`: any subset, merged over the locale's text. */
export interface ViewerMessageOverrides {
  entityProperties?: Partial<ViewerMessages['entityProperties']>;
  pointLayerName?: string;
}

export const MESSAGES: Readonly<Record<LocaleId, ViewerMessages>> = {
  'zh-CN': {
    entityProperties: {
      floorCount: '楼层数',
      buildingHeight: '建筑高度',
      floor: '楼层',
      elevation: '标高',
      storeyHeight: '层高',
      area: '面积',
      kind: '类型',
    },
    pointLayerName: '点位',
  },
  en: {
    entityProperties: {
      floorCount: 'Floors',
      buildingHeight: 'Building height',
      floor: 'Floor',
      elevation: 'Elevation',
      storeyHeight: 'Storey height',
      area: 'Area',
      kind: 'Type',
    },
    pointLayerName: 'Points',
  },
};

/** The text for `locale` (default `zh-CN`) with `overrides` merged over it. */
export function resolveMessages(locale: LocaleId = DEFAULT_LOCALE, overrides: ViewerMessageOverrides = {}): ViewerMessages {
  const base = MESSAGES[locale] ?? MESSAGES[DEFAULT_LOCALE];
  return {
    entityProperties: { ...base.entityProperties, ...overrides.entityProperties },
    pointLayerName: overrides.pointLayerName ?? base.pointLayerName,
  };
}

/** Picks the text for `locale` (default `zh-CN`). */
export function localize(text: LocalizedText, locale: LocaleId = DEFAULT_LOCALE): string {
  return text[locale] ?? text[DEFAULT_LOCALE];
}
