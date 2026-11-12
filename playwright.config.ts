/**
 * Browser smoke tests (`npm run smoke`; roadmap §0.2 P1.5). Two targets, each on both renderer
 * backends (projects `<target>-webgl` / `<target>-webgpu`; WebGPU skips itself when the browser
 * has no adapter, as on GPU-less CI runners):
 *
 *   demo   dist-demo/ (`npm run build:demo`)                          → tests/e2e/demo.e2e.ts
 *   host   .smoke/host (`node scripts/check-package.mjs --keep-host .smoke/host`, after
 *          `npm run build`): the packed SDK inside scripts/host-fixture → tests/e2e/host.e2e.ts
 *
 * Browser: locally the installed Chrome (`channel: 'chrome'`, nothing to download, real GPU); on CI
 * Playwright's Chromium (`npx playwright install --with-deps --no-shell chromium`). SMOKE_CHANNEL
 * overrides (`chromium`, `chrome`, `msedge`). Ports 4180 / 4181, away from the dev server (5173).
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
const browser = {
  ...devices['Desktop Chrome'],
  channel,
  viewport: { width: 1280, height: 720 },
  launchOptions: {
    // WebGL on CPU (SwiftShader) where there is no GPU; WebGPU where the platform allows it.
    // SMOKE_NO_GPU=1 turns the GPU off to reproduce a GPU-less CI runner locally.
    args: ['--enable-unsafe-swiftshader', '--enable-unsafe-webgpu', '--ignore-gpu-blocklist', ...(process.env.SMOKE_NO_GPU ? ['--disable-gpu'] : [])],
  },
};

type Project = NonNullable<PlaywrightTestConfig['projects']>[number];
const target = (name: 'demo' | 'host', port: number): Project[] =>
  (['webgl', 'webgpu'] as const).map((backend) => ({
    name: `${name}-${backend}`,
    testMatch: `${name}.e2e.ts`,
    use: { ...browser, baseURL: `http://127.0.0.1:${port}` },
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
  // Software rendering (SwiftShader, no GPU) needs about 1.5 min for the two-viewer host test.
  timeout: 300_000,
  expect: { timeout: 15_000 },
  // One GPU, one browser at a time: parallel WebGL / WebGPU contexts only make timings noisy.
  workers: 1,
  fullyParallel: false,
  forbidOnly: CI,
  retries: CI ? 1 : 0,
  reporter: CI ? [['github'], ['list'], ['html', { outputFolder: 'test-output/e2e-report', open: 'never' }]] : [['list']],
  use: { trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [...target('demo', DEMO_PORT), ...(hasHost ? target('host', HOST_PORT) : [])],
  webServer: [server('dist-demo', DEMO_PORT), ...(hasHost ? [server(HOST_DIR, HOST_PORT)] : [])],
});
