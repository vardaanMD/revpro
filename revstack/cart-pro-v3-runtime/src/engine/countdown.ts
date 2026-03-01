/**
 * Cart Pro V3 — urgency countdown timer.
 * Same structure as V2/cart.txt: expiresAt, remainingMs, 1s tick, stop when expired.
 * Reset when cart syncs (Engine calls start() again).
 */
import { writable, get } from 'svelte/store';
import type { Writable } from 'svelte/store';

export interface CountdownState {
  expiresAt: number | null;
  remainingMs: number;
  running: boolean;
}

const INITIAL: CountdownState = {
  expiresAt: null,
  remainingMs: 0,
  running: false,
};

export interface CountdownApi {
  store: Writable<CountdownState>;
  start(durationMs: number): void;
  stop(): void;
  isRunning(): boolean;
  destroy(): void;
}

/**
 * Create countdown: start(durationMs) sets expiry and runs 1s tick;
 * updates remainingMs every second; stops when expired.
 */
export function createCountdown(): CountdownApi {
  const store = writable<CountdownState>({ ...INITIAL });
  let intervalId: ReturnType<typeof setInterval> | null = null;

  function tick(): void {
    const now = Date.now();
    store.update((s) => {
      if (s.expiresAt == null || s.expiresAt <= now) {
        return { expiresAt: null, remainingMs: 0, running: false };
      }
      const remainingMs = Math.max(0, s.expiresAt - now);
      return {
        ...s,
        remainingMs,
        running: remainingMs > 0,
      };
    });
  }

  function start(durationMs: number): void {
    if (durationMs <= 0) return;
    if (intervalId != null) {
      clearInterval(intervalId);
      intervalId = null;
    }
    const expiresAt = Date.now() + durationMs;
    store.set({ expiresAt, remainingMs: durationMs, running: true });
    intervalId = setInterval(() => {
      tick();
      const s = get(store);
      if (!s.running && intervalId != null) {
        clearInterval(intervalId);
        intervalId = null;
      }
    }, 1000);
  }

  function stop(): void {
    if (intervalId != null) {
      clearInterval(intervalId);
      intervalId = null;
    }
    store.set({ ...INITIAL });
  }

  function isRunning(): boolean {
    return get(store).running;
  }

  function destroy(): void {
    stop();
  }

  return { store, start, stop, isRunning, destroy };
}
