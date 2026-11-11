/**
 * Checks the package the way a host application gets it (`npm run check:package`, CI, release).
 *
 *   1. `npm pack` the current build (run `npm run build` first) and inspect the tarball:
 *      entry, stylesheet, workers and declarations are in; sources, tests and the demo are out;
 *      three.js is imported, not bundled.
 *   2. Install the tarball into a fresh copy of scripts/host-fixture with the pinned three /
 *      3d-tiles-renderer / Vite versions, then type-check and build that host.
 *
 * Needs network access for step 2 (`--no-host` skips it). Works in a temp folder, removed at the end.
 */
import { execSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const withHost = !process.argv.includes('--no-host');
const work = mkdtempSync(join(tmpdir(), 'terraview-check-'));

/** Runs through the shell (npm and npx are .cmd shims on Windows); arguments with spaces are quoted. */
function run(command, args, cwd) {
  const line = [command, ...args.map((a) => (/\s/.test(a) ? `"${a}"` : a))].join(' ');
  return execSync(line, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
}

function fail(message) {
  console.error(`✗ ${message}`);
  process.exitCode = 1;
}

function listFiles(dir, base = dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? listFiles(path, base) : [path.slice(base.length + 1).replace(/\\/g, '/')];
  });
}

try {
  if (!existsSync(join(root, 'dist', 'terraview.js'))) throw new Error('dist/ is missing: run `npm run build` first');

  // ---------------------------------------------------------------- 1. tarball
  const packed = JSON.parse(run('npm', ['pack', '--json', '--pack-destination', work], root));
  const tarball = join(work, packed[0].filename);
  const files = packed[0].files.map((f) => f.path);
  const required = ['package.json', 'README.md', 'THIRD_PARTY_NOTICES.md', 'dist/terraview.js', 'dist/terraview.css', 'dist/types/index.d.ts'];
  for (const path of required) if (!files.includes(path)) fail(`tarball is missing ${path}`);
  for (const worker of ['tileMesh', 'vector', 'clusterTree']) {
    if (!files.some((f) => f.startsWith(`dist/assets/${worker}.worker`) && f.endsWith('.js'))) fail(`tarball is missing the ${worker} worker`);
  }
  const leaked = files.filter((f) => /^(src|demo|tests|scripts|docs|node_modules)\//.test(f) || /\.env/.test(f));
  if (leaked.length) fail(`tarball contains files that must not ship: ${leaked.slice(0, 5).join(', ')}`);

  const entry = readFileSync(join(root, 'dist', 'terraview.js'), 'utf8');
  if (!/from "three"/.test(entry)) fail('dist/terraview.js does not import three (it must stay external)');
  if (/class WebGPURenderer\b|class Object3D\b/.test(entry)) fail('three.js is bundled into dist/terraview.js');
  const exported = pkg.exports?.['.']?.import;
  if (exported !== './dist/terraview.js') fail(`package.json exports["."].import is ${exported}`);
  console.log(`✓ tarball ${packed[0].filename}: ${files.length} files, ${(packed[0].size / 1024).toFixed(0)} kB packed, entry ${(entry.length / 1024).toFixed(0)} kB`);

  // ---------------------------------------------------------------- 2. host project
  if (withHost && !process.exitCode) {
    const host = join(work, 'host');
    cpSync(join(root, 'scripts', 'host-fixture'), host, { recursive: true });
    cpSync(join(root, 'docs', 'examples', 'sample-office.building.json'), join(host, 'public', 'sample-office.building.json'));
    const dev = pkg.devDependencies;
    writeFileSync(
      join(host, 'package.json'),
      JSON.stringify(
        {
          name: 'terraview-host-check',
          private: true,
          type: 'module',
          dependencies: { [pkg.name]: `file:${tarball.replace(/\\/g, '/')}`, three: dev.three, '3d-tiles-renderer': dev['3d-tiles-renderer'] },
          devDependencies: { '@types/three': dev['@types/three'], typescript: dev.typescript, vite: dev.vite },
        },
        null,
        2,
      ),
    );
    // Same peer-dependency resolution as this repository (.npmrc).
    writeFileSync(join(host, '.npmrc'), 'legacy-peer-deps=true\n');
    run('npm', ['install', '--no-audit', '--no-fund'], host);
    run('npx', ['tsc', '--noEmit'], host);
    run('npx', ['vite', 'build'], host);

    const built = listFiles(join(host, 'dist'));
    for (const worker of ['tileMesh', 'vector', 'clusterTree']) {
      if (!built.some((f) => f.includes(`${worker}.worker`))) fail(`host build did not emit the ${worker} worker`);
    }
    if (!built.some((f) => f.endsWith('.css'))) fail('host build has no stylesheet');
    const installed = existsSync(join(host, 'node_modules', pkg.name, 'node_modules', 'three'));
    if (installed) fail('the package brought its own copy of three into the host');
    if (!process.exitCode) console.log(`✓ host project: installed ${pkg.name}, type-checked, built (${built.length} files)`);
  }
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
} finally {
  rmSync(work, { recursive: true, force: true });
}
