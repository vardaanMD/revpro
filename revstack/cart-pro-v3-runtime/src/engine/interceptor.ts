/**
 * Cart Pro V3 — cart mutation interceptor.
 * Detects external Shopify cart requests (add/change/clear) via PerformanceObserver.
 * Emits events only; does not mutate state or call syncCart.
 */

const CART_URL_PATTERNS = ['/cart/add', '/cart/change', '/cart/clear'] as const;

function isCartMutationUrl(url: string): boolean {
  return CART_URL_PATTERNS.some((p) => url.includes(p));
}

function isFetchOrXhr(initiatorType: string): boolean {
  return initiatorType === 'fetch' || initiatorType === 'xmlhttprequest';
}

export interface EngineLike {
  emit(eventName: string, payload?: unknown): void;
  getInternalMutationInProgress?(): boolean;
}

/**
 * Creates an interceptor that observes resource entries for Shopify cart mutations
 * and emits "cart:external-update" when external add/change/clear is detected.
 * Does not call syncCart or mutate state; only emits.
 * Ignores events when engine reports internal mutation in progress (loop prevention).
 * Returns a teardown function that disconnects the observer (call on engine destroy).
 */
export function createCartInterceptor(engine: EngineLike): (() => void) | null {
  if (typeof PerformanceObserver === 'undefined') return null;

  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      const name = (entry as PerformanceResourceTiming).name ?? '';
      const initiatorType = (entry as PerformanceResourceTiming).initiatorType ?? '';

      if (!name.includes('/cart/') || !isFetchOrXhr(initiatorType)) continue;
      if (!isCartMutationUrl(name)) continue;

      if (engine.getInternalMutationInProgress?.()) continue;

      engine.emit('cart:external-update');
    }
  });

  try {
    observer.observe({ entryTypes: ['resource'] });
  } catch {
    return null;
  }
  return () => {
    try {
      observer.disconnect();
    } catch {
      // already disconnected
    }
  };
}
