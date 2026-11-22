/**
 * Loading state of a viewer (`viewer.loadState`, the 'load-progress' and 'idle' events):
 * pure functions over counters the viewer gathers once per frame, so the rules are unit-tested
 * without a renderer.
 */

/** What is still loading, as of the last frame. */
export interface LoadState {
  /** Globe tile requests in flight or waiting for a slot (terrain, imagery, overlays); 0 while the globe is hidden. */
  globe: number;
  /** 3D Tiles waiting for, or in, download and parsing, over the tilesets being drawn (`Tiles3DLayer.pending`). */
  tilesets: number;
  /** GeoJSON, point and Gaussian splat layers still loading their data. */
  layers: number;
  /** `globe + tilesets + layers`. */
  pending: number;
  /**
   * Nothing pending, and every globe tile on screen shows its own imagery (not a magnified
   * ancestor). Once the imagery source is reported unreachable, tiles still waiting for it do
   * not hold `idle` back.
   */
  idle: boolean;
}

/** The counters `summarizeLoad` works from. */
export interface LoadInputs {
  /** Globe statistics of this frame, or null while the globe is hidden (they are not updated then). */
  globe: { loading: number; queued: number; waitingImagery: number } | null;
  /** The imagery source has been reported unreachable (`imagery-unreachable`). */
  imageryUnreachable: boolean;
  /** Sum of `Tiles3DLayer.pending`. */
  tilesets: number;
  /** GeoJSON and point layers neither ready nor failed. */
  layers: number;
}

export function summarizeLoad(inputs: LoadInputs): LoadState {
  const g = inputs.globe;
  const globe = g ? g.loading + g.queued : 0;
  const pending = globe + inputs.tilesets + inputs.layers;
  const waiting = g !== null && g.waitingImagery > 0 && !inputs.imageryUnreachable;
  return { globe, tilesets: inputs.tilesets, layers: inputs.layers, pending, idle: pending === 0 && !waiting };
}

/**
 * Decides which events a new state calls for: 'load-progress' when the counts or `idle` changed
 * since the last state, 'idle' when it became idle. The first state counts as a change, and as
 * becoming idle if it is idle, so a viewer with nothing to load still reports 'idle' once.
 */
export class LoadTracker {
  private last: LoadState | null = null;

  step(state: LoadState): { progress: boolean; idle: boolean } {
    const last = this.last;
    this.last = state;
    if (!last) return { progress: true, idle: state.idle };
    const progress =
      last.globe !== state.globe || last.tilesets !== state.tilesets || last.layers !== state.layers || last.idle !== state.idle;
    return { progress, idle: state.idle && !last.idle };
  }
}
