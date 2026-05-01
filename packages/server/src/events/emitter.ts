/**
 * Simple in-process event emitter for broadcasting invalidation events.
 * SSE connections subscribe per-organization to receive cache invalidation signals.
 */

interface InvalidationEvent {
  /** Query keys to invalidate (e.g. ['resolve-path'], ['workspace-bootstrap']) */
  keys: string[];
  /** Optional: specific resource that changed */
  resource?: { type: string; id: string | number };
}

type Listener = (event: InvalidationEvent) => void;

const listeners = new Map<string, Set<Listener>>();

export function subscribe(organizationId: string, listener: Listener): () => void {
  if (!listeners.has(organizationId)) {
    listeners.set(organizationId, new Set());
  }
  listeners.get(organizationId)!.add(listener);

  return () => {
    const set = listeners.get(organizationId);
    if (set) {
      set.delete(listener);
      if (set.size === 0) listeners.delete(organizationId);
    }
  };
}

export function emit(organizationId: string, event: InvalidationEvent): void {
  const set = listeners.get(organizationId);
  if (!set) return;
  // Snapshot to avoid issues if a listener unsubscribes during iteration
  for (const listener of [...set]) {
    try {
      listener(event);
    } catch {
      // Don't let one listener break others
    }
  }
}
