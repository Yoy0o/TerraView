/**
 * Smoke test of the runnable examples (dist-examples/, `npm run build:examples`): the gallery lists
 * every entry of examples/catalog.ts, and every example starts a viewer that draws frames without
 * an uncaught error.
 *
 * Offline like the other smoke tests (`watch`): basemap and terrain requests get the local stand-in
 * tiles, anything else from another origin (the 3D Tiles and splat samples on GitHub) is aborted.
 * The examples that load such data then show a load error in their panel, which is expected here;
 * what must not happen is an exception escaping the example (a `pageerror`): an example has to
 * survive its data failing to load, like a host application should.
 *
 * One project, whichever backend the browser offers (the examples do not force one): WebGPU on a
 * local GPU, SwiftShader's WebGPU on CI.
 */
import { expect, test } from '@playwright/test';
import { EXAMPLES } from '../../examples/catalog';
import { framesOf, watch, type SmokeWindow } from './smoke';

test('the gallery lists every example', async ({ page, baseURL }) => {
  const w = await watch(page, baseURL!);
  await page.goto('/');
  for (const example of EXAMPLES) {
    await expect(page.locator(`.ex-card h3 a[href="./${example.id}/"]`), example.id).toHaveText(example.title);
  }
  expect(w.errors).toEqual([]);
});

for (const example of EXAMPLES) {
  test(`example: ${example.id}`, async ({ page, baseURL }) => {
    const w = await watch(page, baseURL!);
    await page.goto(`/${example.id}/`);
    await expect(page.locator('.ex-panel h1')).toHaveText(example.title);
    // Not just `window.viewer`: wait for an instance field (AGENTS.md §7, smoke tests).
    await page.waitForFunction(() => !!(window as unknown as SmokeWindow).viewer?.info, undefined, { timeout: 60_000 });
    await framesOf(page, 'viewer', 3);
    // Let startup work that runs after the first frames (data loads, flights) settle or fail.
    await page.waitForTimeout(1500);

    const uncaught = w.errors.filter((e) => e.startsWith('pageerror'));
    expect(uncaught, `uncaught errors in ${example.id}`).toEqual([]);
    expect(w.threeCopies).toEqual([]);
    if (w.blocked.length) test.info().annotations.push({ type: 'blocked', description: [...new Set(w.blocked.map((u) => new URL(u).host))].join(', ') });
  });
}
