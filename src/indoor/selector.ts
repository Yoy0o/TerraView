/**
 * Entity selector expressions (ThingJS `app.query` style), compiled once into
 * a predicate and cached by string. Pure: no three.js, usable in Workers.
 *
 * Terms:
 * - `.room`: entity type (case-insensitive: `.Room` works too)
 * - `#F3-R10`: id
 * - `[category=camera]`, `[状态!=正常]`, `[温度>=26]`, `[name=303*]`: attribute
 *   comparison with `=` `!=` `<` `>` `<=` `>=`; a trailing `*` on an unquoted
 *   value matches a prefix; `[key]` tests that the attribute exists. Keys
 *   `id` `type` `name` `category` read the entity, anything else (or
 *   `prop.<key>`) reads `properties`. `<` `>` compare numbers (`"23.1 ℃"` reads as 23.1).
 * - `tags:or(a,b)` (or `tags(a,b)`), `tags:and(a,b)`, `tags:not(a,b)`
 * - `/^Cam/i`: regular expression on the name
 * - `"303 办公室"` or a bare name (`Cam 1`): exact name
 *
 * Operators, loosest first: `,` and `||` (or), `&&` (and), `!` (not), and
 * parentheses. Terms written back to back without spaces are and-ed, as in
 * CSS: `.thing[category=camera]`.
 */

/** What a selector can look at. */
export interface Selectable {
  readonly id: string;
  readonly type: string;
  readonly name: string;
  readonly category: string;
  readonly properties: Readonly<Record<string, unknown>>;
  readonly tags: ReadonlySet<string>;
}

export type SelectorPredicate = (e: Selectable) => boolean;

/** A malformed selector; `index` is the 0-based position of the problem. */
export class SelectorError extends Error {
  constructor(
    readonly selector: string,
    readonly index: number,
    message: string,
  ) {
    super(`Selector "${selector}" at index ${index}: ${message}`);
    this.name = 'SelectorError';
  }
}

const CACHE_LIMIT = 256;
const cache = new Map<string, SelectorPredicate>();
const never: SelectorPredicate = () => false;

/**
 * Compiles a selector (cached, least recently used entries are dropped past
 * 256). Throws `SelectorError` with the position of a syntax error. An empty
 * selector matches nothing.
 */
export function compileSelector(selector: string): SelectorPredicate {
  const hit = cache.get(selector);
  if (hit) {
    // Refresh: Map iteration order is insertion order, so the first key is the least recent.
    cache.delete(selector);
    cache.set(selector, hit);
    return hit;
  }
  const fn = selector.trim() === '' ? never : new Parser(selector).parse();
  cache.set(selector, fn);
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
  return fn;
}

/** Number of compiled selectors held in the cache (for tests). */
export function selectorCacheSize(): number {
  return cache.size;
}

type Op = '=' | '!=' | '<' | '>' | '<=' | '>=';

const OPS: Op[] = ['!=', '<=', '>=', '=', '<', '>'];
/** Characters that end an id. */
const ID_END = /[\s&|,()[\]!#.]/;
/** Characters that end a type name. */
const TYPE_CHAR = /[A-Za-z0-9_-]/;

class Parser {
  private pos = 0;

  constructor(private readonly src: string) {}

  parse(): SelectorPredicate {
    const fn = this.list();
    this.ws();
    if (this.pos < this.src.length) this.fail(`unexpected "${this.src[this.pos]}"`);
    return fn;
  }

  private fail(message: string, at = this.pos): never {
    throw new SelectorError(this.src, at, message);
  }

  private ws(): void {
    while (this.pos < this.src.length && /\s/.test(this.src[this.pos])) this.pos++;
  }

  private at(s: string): boolean {
    return this.src.startsWith(s, this.pos);
  }

  private expect(s: string): void {
    this.ws();
    if (!this.at(s)) this.fail(`expected "${s}"`);
    this.pos += s.length;
  }

  private list(): SelectorPredicate {
    let fn = this.or();
    for (this.ws(); this.at(','); this.ws()) {
      this.pos++;
      const a = fn;
      const b = this.or();
      fn = (e) => a(e) || b(e);
    }
    return fn;
  }

  private or(): SelectorPredicate {
    let fn = this.and();
    for (this.ws(); this.at('||'); this.ws()) {
      this.pos += 2;
      const a = fn;
      const b = this.and();
      fn = (e) => a(e) || b(e);
    }
    return fn;
  }

  private and(): SelectorPredicate {
    let fn = this.unary();
    for (this.ws(); this.at('&&'); this.ws()) {
      this.pos += 2;
      const a = fn;
      const b = this.unary();
      fn = (e) => a(e) && b(e);
    }
    return fn;
  }

  private unary(): SelectorPredicate {
    this.ws();
    if (this.at('!')) {
      this.pos++;
      const a = this.unary();
      return (e) => !a(e);
    }
    return this.compound();
  }

  /** Terms written back to back (`.thing[category=camera]`) are and-ed. */
  private compound(): SelectorPredicate {
    let fn = this.primary();
    while (this.pos < this.src.length && '.#['.includes(this.src[this.pos])) {
      const a = fn;
      const b = this.primary();
      fn = (e) => a(e) && b(e);
    }
    return fn;
  }

  private primary(): SelectorPredicate {
    this.ws();
    const start = this.pos;
    const c = this.src[this.pos];
    if (c === undefined) this.fail('expected a selector term');
    if (c === '(') {
      this.pos++;
      const fn = this.list();
      this.expect(')');
      return fn;
    }
    if (c === '.') {
      this.pos++;
      let type = '';
      while (this.pos < this.src.length && TYPE_CHAR.test(this.src[this.pos])) type += this.src[this.pos++];
      if (!type) this.fail('expected a type after "."', start);
      const t = type.toLowerCase();
      return (e) => e.type === t;
    }
    if (c === '#') {
      this.pos++;
      let id = '';
      while (this.pos < this.src.length && !ID_END.test(this.src[this.pos])) id += this.src[this.pos++];
      if (!id) this.fail('expected an id after "#"', start);
      return (e) => e.id === id;
    }
    if (c === '[') return this.attribute();
    if (c === '/') return this.regex();
    if (c === '"' || c === "'") {
      const name = this.quoted();
      return (e) => e.name === name;
    }
    const tags = /^tags(?::(or|and|not))?\s*\(/.exec(this.src.slice(this.pos));
    if (tags) {
      this.pos += tags[0].length;
      return this.tags((tags[1] as 'or' | 'and' | 'not' | undefined) ?? 'or');
    }
    if (')&|,!'.includes(c)) this.fail('expected a selector term');
    return this.name();
  }

  /** Bare name: everything up to an operator, a parenthesis or a comma (inner spaces kept). */
  private name(): SelectorPredicate {
    let end = this.pos;
    while (end < this.src.length) {
      const ch = this.src[end];
      if (ch === ',' || ch === '(' || ch === ')') break;
      if ((ch === '&' && this.src[end + 1] === '&') || (ch === '|' && this.src[end + 1] === '|')) break;
      end++;
    }
    const name = this.src.slice(this.pos, end).trim();
    this.pos = end;
    return (e) => e.name === name;
  }

  private quoted(): string {
    const quote = this.src[this.pos];
    const start = this.pos++;
    let out = '';
    while (this.pos < this.src.length && this.src[this.pos] !== quote) {
      if (this.src[this.pos] === '\\' && this.pos + 1 < this.src.length) this.pos++;
      out += this.src[this.pos++];
    }
    if (this.pos >= this.src.length) this.fail('unterminated string', start);
    this.pos++;
    return out;
  }

  private regex(): SelectorPredicate {
    const start = this.pos++;
    let body = '';
    let inClass = false;
    while (this.pos < this.src.length) {
      const ch = this.src[this.pos];
      if (ch === '\\' && this.pos + 1 < this.src.length) {
        body += ch + this.src[this.pos + 1];
        this.pos += 2;
        continue;
      }
      if (ch === '[') inClass = true;
      else if (ch === ']') inClass = false;
      else if (ch === '/' && !inClass) break;
      body += ch;
      this.pos++;
    }
    if (this.pos >= this.src.length) this.fail('unterminated regular expression', start);
    this.pos++;
    let flags = '';
    while (this.pos < this.src.length && /[a-z]/i.test(this.src[this.pos])) flags += this.src[this.pos++];
    let re: RegExp;
    try {
      // 'g' / 'y' make test() stateful.
      re = new RegExp(body, flags.replace(/[gy]/g, ''));
    } catch (err) {
      this.fail((err as Error).message, start);
    }
    return (e) => re.test(e.name);
  }

  private attribute(): SelectorPredicate {
    const start = this.pos++;
    this.ws();
    let key = '';
    while (this.pos < this.src.length && !/[=!<>\]\s]/.test(this.src[this.pos])) key += this.src[this.pos++];
    if (!key) this.fail('expected an attribute name', this.pos);
    this.ws();
    if (this.at(']')) {
      this.pos++;
      return (e) => {
        const v = attr(e, key);
        return v !== undefined && v !== null;
      };
    }
    const op = OPS.find((o) => this.at(o));
    if (!op) this.fail('expected =, !=, <, >, <= or >=');
    this.pos += op.length;
    if (op === '=' && this.at('=')) this.pos++; // tolerate "=="
    this.ws();
    let value: string;
    let prefix = false;
    if (this.at('"') || this.at("'")) {
      value = this.quoted();
    } else {
      let end = this.pos;
      while (end < this.src.length && this.src[end] !== ']') end++;
      value = this.src.slice(this.pos, end).trim();
      this.pos = end;
      if (value.endsWith('*')) {
        prefix = true;
        value = value.slice(0, -1);
      }
    }
    this.ws();
    if (!this.at(']')) this.fail('expected "]"', this.pos < this.src.length ? this.pos : start);
    this.pos++;
    return compare(key, op, value, prefix);
  }

  private tags(mode: 'or' | 'and' | 'not'): SelectorPredicate {
    const list: string[] = [];
    for (;;) {
      this.ws();
      let tag: string;
      if (this.at('"') || this.at("'")) {
        tag = this.quoted();
      } else {
        let end = this.pos;
        while (end < this.src.length && this.src[end] !== ',' && this.src[end] !== ')') end++;
        tag = this.src.slice(this.pos, end).trim();
        this.pos = end;
      }
      if (!tag) this.fail('expected a tag');
      list.push(tag);
      this.ws();
      if (this.at(',')) {
        this.pos++;
        continue;
      }
      this.expect(')');
      break;
    }
    if (mode === 'and') return (e) => list.every((t) => e.tags.has(t));
    if (mode === 'not') return (e) => !list.some((t) => e.tags.has(t));
    return (e) => list.some((t) => e.tags.has(t));
  }
}

function attr(e: Selectable, key: string): unknown {
  switch (key) {
    case 'id':
      return e.id;
    case 'type':
      return e.type;
    case 'name':
      return e.name;
    case 'category':
      return e.category;
  }
  if (key.startsWith('prop.')) return e.properties[key.slice(5)];
  return e.properties[key];
}

function equals(v: unknown, value: string, prefix: boolean): boolean {
  if (v === undefined || v === null) return false;
  const s = String(v);
  if (prefix) return s.startsWith(value);
  if (s === value) return true;
  // 23 and "23.0" are the same number.
  const a = Number(s);
  const b = Number(value);
  return value.trim() !== '' && s.trim() !== '' && Number.isFinite(a) && a === b;
}

function compare(key: string, op: Op, value: string, prefix: boolean): SelectorPredicate {
  if (op === '=') return (e) => equals(attr(e, key), value, prefix);
  if (op === '!=') return (e) => !equals(attr(e, key), value, prefix);
  const b = parseFloat(value);
  return (e) => {
    const v = attr(e, key);
    if (v === undefined || v === null || Number.isNaN(b)) return false;
    // parseFloat reads the leading number of values such as "23.1 ℃".
    const a = typeof v === 'number' ? v : parseFloat(String(v));
    if (Number.isNaN(a)) return false;
    switch (op) {
      case '<':
        return a < b;
      case '>':
        return a > b;
      case '<=':
        return a <= b;
      default:
        return a >= b;
    }
  };
}
