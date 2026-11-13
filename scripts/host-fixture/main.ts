// Host application used by scripts/check-package.mjs: it sees the SDK only as the installed
// package, with two viewers that do not fill the window.
import 'terra-view/style.css';
import { AWS_TERRARIUM, GeoViewer, IMAGERY_PRESETS, type BuildingDoc, type GeoViewerOptions } from 'terra-view';

async function start(id: string, view: GeoViewerOptions['initialView']): Promise<GeoViewer> {
  return GeoViewer.create({
    container: document.getElementById(id)!,
    imagery: IMAGERY_PRESETS[0].create(),
    terrain: AWS_TERRARIUM,
    initialView: view,
    // ?webgl: the browser smoke test (tests/e2e/host.e2e.ts) runs both backends.
    forceWebGL: new URLSearchParams(location.search).has('webgl'),
  });
}

const left = await start('left', { longitude: 116.39, latitude: 39.9, height: 4000, heading: 20, pitch: -40 });
const right = await start('right', { longitude: 112, latitude: 26, height: 1.75e7 });

left.addPoints({
  data: [
    { lon: 116.3972, lat: 39.9163, name: 'Forbidden City', status: 'alarm' },
    { lon: 116.4074, lat: 39.9042, name: 'Wangfujing', status: 'ok' },
  ],
  cluster: false,
  style: { style: 'poi', title: '{name}' },
  rules: [{ when: { status: 'alarm' }, style: { style: 'pulse', color: '#ff4d4f' } }],
});

const doc = (await (await fetch('/sample-office.building.json')).json()) as BuildingDoc;
const building = right.indoor.add(doc);
void right.indoor.enter(building);
right.interaction.on('click', (e) => console.log('click', e.object?.name ?? e.kind), { tag: 'host' });

// Load-state and error events, as a host would watch them (read by tests/e2e/host.e2e.ts).
const hostEvents = { idle: { left: 0, right: 0 }, errors: [] as string[] };
for (const [name, viewer] of [['left', left], ['right', right]] as const) {
  viewer.events.on('idle', () => hostEvents.idle[name]++);
  viewer.events.on('error', ({ source, error }) => hostEvents.errors.push(`${name} ${source}: ${error.message}`));
}

Object.assign(window, { left, right, hostEvents });
