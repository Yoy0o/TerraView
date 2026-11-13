/**
 * Checks that the published declarations (`dist/types/index.d.ts`, after
 * `build:types`) export exactly what the package entry (`src/index.ts`) does.
 *
 * `stripInternal` drops any declaration whose leading comment contains the
 * text of the internal tag, even in prose or backticks; a comment above an
 * export statement can silently strip a public export (it happened to
 * `GeoViewer`). `tsconfig.dts.json` cannot see that: a declaration file with
 * an export missing is still valid.
 *
 *   node scripts/check-dts.mjs
 */
import { resolve } from 'node:path';
import ts from 'typescript';

const root = resolve(import.meta.dirname, '..');
const source = resolve(root, 'src/index.ts');
const published = resolve(root, 'dist/types/index.d.ts');

const program = ts.createProgram([source, published], {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  noEmit: true,
  skipLibCheck: true,
  types: [],
});
const checker = program.getTypeChecker();

function exportsOf(file) {
  const sf = program.getSourceFile(file);
  if (!sf) throw new Error(`cannot read ${file}`);
  const symbol = checker.getSymbolAtLocation(sf);
  if (!symbol) throw new Error(`${file} is not a module`);
  return new Set(checker.getExportsOfModule(symbol).map((s) => s.getName()));
}

const want = exportsOf(source);
const got = exportsOf(published);
const missing = [...want].filter((n) => !got.has(n)).sort();
const extra = [...got].filter((n) => !want.has(n)).sort();

if (missing.length || extra.length) {
  if (missing.length) console.error(`✗ missing from dist/types/index.d.ts: ${missing.join(', ')}`);
  if (extra.length) console.error(`✗ only in dist/types/index.d.ts: ${extra.join(', ')}`);
  console.error('  A leading comment with the internal tag text strips the declaration it precedes (stripInternal).');
  process.exit(1);
}
console.log(`✓ dist/types/index.d.ts exports the same ${want.size} names as src/index.ts`);
