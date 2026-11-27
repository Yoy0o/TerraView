/**
 * Per-host request slots for downloads made in workers (docs/agents/tile-loading.md §3.1).
 * Dependency-free (the mesh worker imports the client half).
 *
 * The host queues of `RequestScheduler` live on the main thread, where
 * imagery downloads take their slots. A worker cannot see them, and each
 * worker of the pool limiting on its own would let `workers × limit`
 * requests through. So the worker asks the main thread for a slot before a
 * download (`SlotClient.acquire`), the main thread takes one from the shared
 * queue on its behalf (`SlotBroker`) and answers, and the worker gives it
 * back once the body is read. The round trip costs well under a frame; the
 * downloads it orders take hundreds of milliseconds on the servers that
 * need it (HTTP/1.1).
 */
import { acquireRequestSlot } from './imagery/RequestScheduler';

/** Worker → main thread. */
export type SlotRequest =
  | { type: 'slot'; op: 'acquire'; ticket: number; host: string; limit: number; ifFree: boolean }
  | { type: 'slot'; op: 'release'; ticket: number };

/** Main thread → worker: whether the slot was granted (false only for `ifFree`). */
export interface SlotGrant {
  type: 'slot';
  op: 'grant';
  ticket: number;
  granted: boolean;
}

function abortError(): Error {
  return new DOMException('Aborted', 'AbortError');
}

/** Worker side: asks for slots and gives them back. */
export class SlotClient {
  private nextTicket = 1;
  private readonly pending = new Map<number, (granted: boolean) => void>();

  constructor(private readonly post: (message: SlotRequest) => void) {}

  /**
   * Waits for a slot of `host`. Resolves to its release function (call it
   * when the response body has been read), or to null when `ifFree` and the
   * host has no free slot. Aborting while waiting rejects with an
   * `AbortError` and withdraws the request.
   */
  acquire(host: string, limit: number, options: { signal?: AbortSignal; ifFree?: boolean } = {}): Promise<(() => void) | null> {
    const { signal } = options;
    if (signal?.aborted) return Promise.reject(abortError());
    const ticket = this.nextTicket++;
    return new Promise((resolve, reject) => {
      const onAbort = (): void => {
        this.pending.delete(ticket);
        // The broker drops the waiting request, or frees the slot if its grant is on the way.
        this.post({ type: 'slot', op: 'release', ticket });
        reject(abortError());
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.pending.set(ticket, (granted) => {
        this.pending.delete(ticket);
        signal?.removeEventListener('abort', onAbort);
        if (!granted) {
          resolve(null);
          return;
        }
        let released = false;
        resolve(() => {
          if (released) return;
          released = true;
          this.post({ type: 'slot', op: 'release', ticket });
        });
      });
      this.post({ type: 'slot', op: 'acquire', ticket, host, limit, ifFree: options.ifFree ?? false });
    });
  }

  /** Handles a grant from the main thread (late grants of withdrawn requests are ignored). */
  receive(message: SlotGrant): void {
    this.pending.get(message.ticket)?.(message.granted);
  }
}

interface BrokeredSlot {
  readonly waiting: AbortController;
  release: (() => void) | null;
}

/** Main-thread side: takes slots from the shared host queues for one worker. */
export class SlotBroker {
  private readonly slots = new Map<number, BrokeredSlot>();
  private disposed = false;

  constructor(private readonly post: (message: SlotGrant) => void) {}

  receive(message: SlotRequest): void {
    if (this.disposed) return;
    const { ticket } = message;
    if (message.op === 'release') {
      const slot = this.slots.get(ticket);
      if (!slot) return;
      this.slots.delete(ticket);
      if (slot.release) slot.release();
      else slot.waiting.abort();
      return;
    }
    const slot: BrokeredSlot = { waiting: new AbortController(), release: null };
    this.slots.set(ticket, slot);
    acquireRequestSlot(message.host, { limit: message.limit, signal: slot.waiting.signal, ifFree: message.ifFree }).then(
      (release) => {
        if (this.slots.get(ticket) !== slot) {
          // Withdrawn or disposed in the meantime.
          release?.();
          return;
        }
        if (!release) this.slots.delete(ticket);
        else slot.release = release;
        this.post({ type: 'slot', op: 'grant', ticket, granted: release !== null });
      },
      () => undefined, // aborted while waiting: already removed
    );
  }

  /** Slots held or waited for (tests, debugging). */
  get size(): number {
    return this.slots.size;
  }

  /** Gives back every slot the worker holds and withdraws its waiting requests (worker terminated). */
  dispose(): void {
    this.disposed = true;
    const slots = [...this.slots.values()];
    this.slots.clear();
    // Withdraw the waiting requests first, or a released slot would be handed to one of them.
    for (const slot of slots) if (!slot.release) slot.waiting.abort();
    for (const slot of slots) slot.release?.();
  }
}
