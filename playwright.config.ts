/**
 * Browser smoke tests (`npm run smoke`; roadmap §0.2 P1.5). Two targets, each on both renderer
 * backends (projects `<target>-webgl` / `<target>-webgpu`; a project skips itself when the browser
 * has no adapter for its backend):
 *
 *   demo   dist-demo/ (`npm run build:demo`)                          → tests/e2e/demo.e2e.ts
 *   host   .smoke/host (`node scripts/check-package.mjs --keep-host .smoke/host`, after
 *          `npm run build`): the packed SDK inside scripts/host-fixture → tests/e2e/host.e2e.ts
 *
 * Browser: locally the installed Chrome (`channel: 'chrome'`, nothing to download, real GPU); on CI
 * Playwright's Chromium (`npx playwright install --with-deps --no-shell chromium`). SMOKE_CHANNEL
 * overrides (`chromium`, `chrome`, `msedge`). Ports 4180 / 4181, away from the dev server (5173).
 *
 * Software rendering (CI, or SMOKE_NO_GPU=1 to reproduce it locally): each backend is pointed at
 * SwiftShader, WebGL through ANGLE and WebGPU through Dawn's fallback adapter. The two switches
 * do not mix in one browser (with ANGLE on SwiftShader, Chrome offers no WebGPU adapter), hence
 * per project. `--disable-gpu` is not used: it leaves WebGPU without any adapter. The tests ask
 * the browser whether it renders in software (`probeBackend`) and then skip the checks that only
 * measure SwiftShader's speed.
 * Real-browser checks by hand (Claude in Chrome etc.) stay the first choice where available;
 * this is the fallback that also runs on CI.
 */
import { existsSync } from 'node:fs';
import { defineConfig, devices, type PlaywrightTestConfig } from '@playwright/test';

const CI = !!process.env.CI;
const DEMO_PORT = 4180;
const HOST_PORT = 4181;
const HOST_DIR = '.smoke/host';
const hasHost = existsSync(`${HOST_DIR}/index.html`);
if (!hasHost) {
  const hint = `${HOST_DIR} is missing: run \`npm run build && node scripts/check-package.mjs --keep-host ${HOST_DIR}\``;
  if (CI) throw new Error(hint);
  console.warn(`[smoke] host tests skipped: ${hint}`);
}

const channel = process.env.SMOKE_CHANNEL ?? (CI ? 'chromium' : 'chrome');
const software = CI || !!process.env.SMOKE_NO_GPU;
const SOFTWARE_ARGS = { webgl: ['--use-angle=swiftshader'], webgpu: ['--use-webgpu-adapter=swiftshader'] };

type Backend = keyof typeof SOFTWARE_ARGS;
const browser = (backend: Backend) => ({
  ...devices['Desktop Chrome'],
  channel,
  viewport: { width: 1280, height: 720 },
  launchOptions: {
    args: ['--enable-unsafe-swiftshader', '--enable-unsafe-webgpu', '--ignore-gpu-blocklist', ...(software ? SOFTWARE_ARGS[backend] : [])],
  },
});

type Project = NonNullable<PlaywrightTestConfig['projects']>[number];
const target = (name: 'demo' | 'host', port: number): Project[] =>
  (['webgl', 'webgpu'] as const).map((backend) => ({
    name: `${name}-${backend}`,
    testMatch: `${name}.e2e.ts`,
    use: { ...browser(backend), baseURL: `http://127.0.0.1:${port}` },
  }));

const server = (dir: string, port: number) => ({
  command: `node tests/e2e/server.mjs ${dir} ${port}`,
  url: `http://127.0.0.1:${port}/index.html`,
  reuseExistingServer: !CI,
  timeout: 20_000,
});

export default defineConfig({
  testDir: 'tests/e2e',
  testMatch: '*.e2e.ts',
  outputDir: 'test-output/e2e',
  // Software rendering is slow: the globe wait alone may take up to 3 min on a 2-core runner.
  timeout: 300_000,
  expect: { timeout: 15_000 },
  // One GPU, one browser at a time: parallel WebGL / WebGPU contexts only make timings noisy.
  workers: 1,
  fullyParallel: false,
  forbidOnly: CI,
  // No retries: a slow software renderer fails the same way twice, only later.
  retries: 0,
  reporter: CI ? [['github'], ['list'], ['html', { outputFolder: 'test-output/e2e-report', open: 'never' }]] : [['list']],
  use: { trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [...target('demo', DEMO_PORT), ...(hasHost ? target('host', HOST_PORT) : [])],
  webServer: [server('dist-demo', DEMO_PORT), ...(hasHost ? [server(HOST_DIR, HOST_PORT)] : [])],
});
