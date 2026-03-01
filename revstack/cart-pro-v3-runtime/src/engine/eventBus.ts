/**
 * Cart Pro V3 — event bus.
 * Multiple listeners, safe removal, no memory leaks, no globals.
 */
type Handler = (payload?: unknown) => void;

export interface EventBus {
  on(eventName: string, handler: Handler): void;
  off(eventName: string, handler: Handler): void;
  emit(eventName: string, payload?: unknown): void;
}

export function createEventBus(): EventBus {
  const listeners = new Map<string, Set<Handler>>();

  function on(eventName: string, handler: Handler): void {
    let set = listeners.get(eventName);
    if (!set) {
      set = new Set();
      listeners.set(eventName, set);
    }
    set.add(handler);
  }

  function off(eventName: string, handler: Handler): void {
    const set = listeners.get(eventName);
    if (set) {
      set.delete(handler);
      if (set.size === 0) listeners.delete(eventName);
    }
  }

  function emit(eventName: string, payload?: unknown): void {
    const set = listeners.get(eventName);
    if (!set) return;
    set.forEach((handler) => {
      try {
        handler(payload);
      } catch (err) {
        console.error('[Cart Pro V3] Event handler error:', eventName, err);
      }
    });
  }

  return { on, off, emit };
}
