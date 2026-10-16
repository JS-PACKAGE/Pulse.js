import type { PulseEvent } from '../shared/types.ts';

type Listener = (event: PulseEvent) => void;

/** In-process fan-out of panel events (single server process, see PLAN.md §5). */
export class EventHub {
  private readonly listeners = new Set<Listener>();

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  publish(event: PulseEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  get size(): number {
    return this.listeners.size;
  }
}
