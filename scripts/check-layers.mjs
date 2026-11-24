/**
 * Checks the layering of `src/`: which directories may import which at runtime,
 * and that no two source files import each other in a cycle.
 *
 * Only runtime imports count. With `verbatimModuleSyntax`, an import is type-only
 * when it is written `import type` / `export type`, or when every named specifier
 * carries `type`; those are erased from the build and cannot create a runtime
 * cycle, so they are allowed in any direction (a module may describe the shape of
 * a lower layer's caller without depending on it).
 *
 *   node scripts/check-layers.mjs            check; exit 1 on a violation (part of `npm run verify`)
 *   node scripts/check-layers.mjs --report   also print every cross-directory edge
 *   node scripts/check-layers.mjs --types    count type-only imports too (stricter, for audits;
 *                                            the cycles in ACCEPTED_TYPE_CYCLES are let through)
 *
 * The allowed directions are the table below (AGENTS.md §2 explains the layers).
 * A directory may always import itself and anything listed for it; `index.ts` may
 * import everything. Adding an edge here is a design decision: say why in the commit.
 * No dependencies beyond the TypeScript compiler the build already uses.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import ts from 'typescript';

const root = resolve(import.meta.dirname, '..');
const rel = (from, file) => relative(from, file).split(sep).join('/');
const srcDir = join(root, 'src');

/**
 * Runtime dependencies each directory may have (on top of itself), lowest layers
 * first. The table must stay acyclic (checked below): a directory never appears in
 * the list of one it is listed for, directly or through others.
 */
const ALLOWED = {
  // Ellipsoid, geodesy, math, events, errors, i18n, GPU tiers, the TSL node type.
  core: [],
  // Atmosphere scattering nodes and their CPU model, stars.
  atmosphere: ['core'],
  // Local scene region math and the shared clip mask (globe, 3D Tiles and pick materials use it).
  region: ['core'],
  // Sun shadow map and its receiver nodes (shadowed aerial perspective for unlit materials).
  lighting: ['core', 'atmosphere'],
  // Post-processing pipeline and its effects.
  post: ['core'],
  // Cloud shell and volumetric clouds (a post effect casting cloud shadows).
  clouds: ['core', 'atmosphere', 'lighting', 'post'],
  globe: ['core', 'atmosphere', 'lighting', 'region'],
  tiles3d: ['core', 'atmosphere', 'lighting', 'region'],
  vector: ['core', 'globe'],
  markers: ['core'],
  indoor: ['core', 'atmosphere', 'lighting', 'post', 'markers'],
  // Local scene: region walls, dimming, camera bounds over the globe and 3D Tiles.
  local: ['core', 'region', 'post', 'globe', 'tiles3d'],
  // The viewer assembles everything.
  viewer: ['core', 'atmosphere', 'region', 'lighting', 'post', 'clouds', 'globe', 'tiles3d', 'vector', 'markers', 'indoor', 'local'],
};

/**
 * Type-only file cycles kept on purpose (`--types` reports any other; a runtime cycle is
 * never accepted). Paths relative to `src/`, POSIX separators.
 */
const ACCEPTED_TYPE_CYCLES = [
  // The public `LevelContext.indoor` is the IndoorManager, which registers the built-in controls.
  ['indoor/IndoorManager.ts', 'indoor/LevelControl.ts'],
];

const report = process.argv.includes('--report');
const withTypes = process.argv.includes('--types');

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...walk(path));
    else if (/\.ts$/.test(name) && !/\.d\.ts$/.test(name)) out.push(path);
  }
  return out;
}

/** Top-level directory under `src/` (`''` for files directly in it). */
function layerOf(file) {
  const parts = relative(srcDir, file).split(sep);
  return parts.length > 1 ? parts[0] : '';
}

function resolveImport(from, spec) {
  if (!spec.startsWith('.')) return null; // packages: three, 3d-tiles-renderer, …
  const base = resolve(dirname(from), spec);
  for (const candidate of [base, `${base}.ts`, join(base, 'index.ts')]) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // try the next form
    }
  }
  return undefined;
}

/** Runtime imports of a file: `[{ target, line }]`. */
function runtimeImports(file) {
  const text = readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true);
  const out = [];
  const add = (node, spec) => {
    const target = resolveImport(file, spec);
    if (target === undefined) {
      unresolved.push(`${rel(root, file)}: ${spec}`);
      return;
    }
    if (target) out.push({ target, line: sf.getLineAndCharacterOfPosition(node.getStart()).line + 1 });
  };
  for (const stmt of sf.statements) {
    if (ts.isImportDeclaration(stmt)) {
      const clause = stmt.importClause;
      if (clause?.isTypeOnly && !withTypes) continue;
      const named = clause?.namedBindings;
      if (clause && !clause.name && named && ts.isNamedImports(named) && named.elements.length > 0
        && named.elements.every((e) => e.isTypeOnly) && !withTypes) continue;
      add(stmt, stmt.moduleSpecifier.text);
    } else if (ts.isExportDeclaration(stmt) && stmt.moduleSpecifier) {
      if (stmt.isTypeOnly && !withTypes) continue;
      const named = stmt.exportClause;
      if (named && ts.isNamedExports(named) && named.elements.length > 0
        && named.elements.every((e) => e.isTypeOnly) && !withTypes) continue;
      add(stmt, stmt.moduleSpecifier.text);
    }
  }
  // Dynamic `import('./x')` is a runtime edge too (lazy, but still a dependency).
  const visit = (node) => {
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
      && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0])) {
      add(node, node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

const unresolved = [];
const errors = [];

// 0. The table itself is acyclic and names known directories.
{
  const seen = new Map();
  const visit = (layer, path) => {
    if (seen.get(layer) === 'done') return;
    if (seen.get(layer) === 'open') {
      errors.push(`ALLOWED is cyclic: ${[...path, layer].join(' → ')}`);
      return;
    }
    seen.set(layer, 'open');
    for (const next of ALLOWED[layer] ?? []) {
      if (!(next in ALLOWED)) errors.push(`ALLOWED.${layer} lists unknown layer '${next}'`);
      else visit(next, [...path, layer]);
    }
    seen.set(layer, 'done');
  };
  for (const layer of Object.keys(ALLOWED)) visit(layer, []);
}

const files = walk(srcDir);
const graph = new Map(files.map((f) => [f, runtimeImports(f)]));

// 1. Directory direction.
const crossEdges = new Map();
for (const [file, imports] of graph) {
  const from = layerOf(file);
  if (from !== '' && !ALLOWED[from]) {
    errors.push(`unknown layer '${from}' (${rel(root, file)}): add it to ALLOWED in scripts/check-layers.mjs`);
    continue;
  }
  for (const { target, line } of imports) {
    const to = layerOf(target);
    if (from === to || from === '') continue;
    const key = `${from} → ${to}`;
    crossEdges.set(key, (crossEdges.get(key) ?? 0) + 1);
    if (to === '' || !ALLOWED[from].includes(to)) {
      errors.push(`${rel(root, file)}:${line} imports ${rel(root, target)} (${key} is not allowed)`);
    }
  }
}

// 2. File cycles (Tarjan's strongly connected components).
let index = 0;
const stack = [];
const state = new Map();
const cycles = [];
function strongConnect(v) {
  const s = { index, low: index, onStack: true };
  state.set(v, s);
  index++;
  stack.push(v);
  for (const { target: w } of graph.get(v) ?? []) {
    if (!graph.has(w)) continue;
    const t = state.get(w);
    if (!t) {
      strongConnect(w);
      s.low = Math.min(s.low, state.get(w).low);
    } else if (t.onStack) {
      s.low = Math.min(s.low, t.index);
    }
  }
  if (s.low === s.index) {
    const component = [];
    let w;
    do {
      w = stack.pop();
      state.get(w).onStack = false;
      component.push(w);
    } while (w !== v);
    const selfLoop = (graph.get(v) ?? []).some((e) => e.target === v);
    if (component.length > 1 || selfLoop) cycles.push(component);
  }
}
for (const f of files) if (!state.has(f)) strongConnect(f);
const accepted = new Set(ACCEPTED_TYPE_CYCLES.map((c) => [...c].sort().join(' ↔ ')));
for (const c of cycles) {
  const key = c.map((f) => rel(srcDir, f)).sort().join(' ↔ ');
  if (withTypes && accepted.has(key)) continue;
  errors.push(`import cycle: ${key}`);
}
for (const u of unresolved) errors.push(`unresolved import ${u}`);

if (report) {
  console.log(`Cross-directory ${withTypes ? '' : 'runtime '}imports (count):`);
  for (const [key, n] of [...crossEdges].sort()) console.log(`  ${key.padEnd(24)} ${n}`);
}
if (errors.length) {
  for (const e of errors) console.error(`✗ ${e}`);
  console.error(`  Allowed directions: ALLOWED in scripts/check-layers.mjs (AGENTS.md §2).${withTypes ? '' : ' Type-only imports are exempt.'}`);
  process.exit(1);
}
console.log(`✓ ${files.length} files in src/: layering holds, no import cycles${withTypes ? ' (type-only imports included)' : ''}`);
