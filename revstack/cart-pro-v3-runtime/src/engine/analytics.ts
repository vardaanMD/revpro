/**
 * Cart Pro V3 — analytics event schema and batch send.
 * Used by Engine for queue, flush, and retry. No state; Engine holds queue/sending/lastFlushAt.
 */

export const BATCH_SIZE = 10;
export const FLUSH_INTERVAL_MS = 5000;
export const DEDUP_WINDOW_MS = 300;

export interface CartSnapshot {
  itemCount: number;
  subtotal: number;
}

export interface AnalyticsEvent {
  id: string;
  name: string;
  payload: object;
  timestamp: number;
  cartSnapshot: CartSnapshot;
  sessionId: string;
}

let eventIdCounter = 0;
function generateEventId(): string {
  return `ev_${Date.now()}_${++eventIdCounter}`;
}

/**
 * Build a single analytics event. Engine supplies cart snapshot and sessionId.
 */
export function buildAnalyticsEvent(
  name: string,
  payload: object,
  cartSnapshot: CartSnapshot,
  sessionId: string
): AnalyticsEvent {
  return {
    id: generateEventId(),
    name,
    payload,
    timestamp: Date.now(),
    cartSnapshot: { ...cartSnapshot },
    sessionId,
  };
}

function getAnalyticsUrl(): string {
  return '/apps/cart-pro/analytics/v3';
}

/**
 * POST a batch of events to the analytics endpoint.
 * Returns true on success, false on failure (caller handles retry with backoff).
 */
export async function sendAnalyticsBatch(events: AnalyticsEvent[]): Promise<boolean> {
  if (events.length === 0) return true;
  try {
    const res = await fetch(getAnalyticsUrl(), {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ events }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Dedup key for identical events (name + payload). Used by Engine to skip duplicates within DEDUP_WINDOW_MS.
 */
export function getDedupKey(name: string, payload: object): string {
  try {
    return `${name}:${JSON.stringify(payload)}`;
  } catch {
    return `${name}:${String(payload)}`;
  }
}
