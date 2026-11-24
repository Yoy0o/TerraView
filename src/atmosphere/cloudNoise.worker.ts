/**
 * Builds the volumetric cloud noise off the main thread (`generateCloudNoise`, ~0.5 s
 * for 64³). No three.js imports (AGENTS.md §3.6); the volume's buffer is transferred back.
 */
import { generateCloudNoise } from './cloudNoise';

self.onmessage = (event: MessageEvent<{ size: number }>) => {
  const data = generateCloudNoise(event.data.size);
  (self as unknown as Worker).postMessage({ data }, [data.buffer as ArrayBuffer]);
};
