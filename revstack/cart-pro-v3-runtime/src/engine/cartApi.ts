/**
 * Cart Pro V3 — Shopify Cart API layer.
 * GET /cart.js, POST /cart/add.js, POST /cart/change.js.
 * No discount logic. credentials: same-origin.
 */

function getCartBaseUrl(): string {
  if (typeof window !== 'undefined' && (window as any).Shopify?.routes?.root) {
    return (window as any).Shopify.routes.root;
  }
  return '/';
}

function cartJsUrl(): string {
  return getCartBaseUrl() + 'cart.js';
}

function cartAddUrl(): string {
  return getCartBaseUrl() + 'cart/add.js';
}

function cartChangeUrl(): string {
  return getCartBaseUrl() + 'cart/change.js';
}

function cartUpdateUrl(): string {
  return getCartBaseUrl() + 'cart/update.js';
}

const FETCH_OPTIONS: RequestInit = {
  credentials: 'same-origin',
  headers: {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  },
};

/** Timeout for cart API requests so a stuck network doesn't leave the app syncing forever. */
const CART_FETCH_TIMEOUT_MS = 15000;

function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number = CART_FETCH_TIMEOUT_MS
): Promise<Response> {
  const ac = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timeoutId = ac
    ? setTimeout(() => ac.abort(), timeoutMs)
    : null;
  const signal = ac?.signal;
  const resPromise = fetch(url, { ...init, signal });
  if (!timeoutId) return resPromise;
  return resPromise.finally(() => clearTimeout(timeoutId));
}

/**
 * GET /cart.js — fetch current cart.
 * Uses cache: 'no-store' so we never get a stale cart after mutations (avoids qty/price snap-back).
 * Times out after CART_FETCH_TIMEOUT_MS so a stuck request doesn't leave syncing true forever.
 */
export async function fetchCart(): Promise<any> {
  const res = await fetchWithTimeout(cartJsUrl(), {
    credentials: 'same-origin',
    headers: { Accept: 'application/json' },
    cache: 'no-store',
  });
  if (!res.ok) {
    throw new Error(`Cart fetch failed: ${res.status}`);
  }
  return res.json();
}

/**
 * POST /cart/add.js — add variant to cart.
 * Times out after CART_FETCH_TIMEOUT_MS so add-to-cart doesn't hang indefinitely.
 */
export async function addToCart(variantId: number, quantity: number): Promise<any> {
  const res = await fetchWithTimeout(
    cartAddUrl(),
    {
      ...FETCH_OPTIONS,
      method: 'POST',
      body: JSON.stringify({
        items: [{ id: variantId, quantity }],
      }),
    }
  );
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.description || data.message || `Add to cart failed: ${res.status}`);
  }
  return data;
}

/**
 * POST /cart/change.js — change line item quantity. Use quantity 0 to remove.
 */
export async function changeCart(lineKey: string, quantity: number): Promise<any> {
  const res = await fetchWithTimeout(cartChangeUrl(), {
    ...FETCH_OPTIONS,
    method: 'POST',
    body: JSON.stringify({ id: lineKey, quantity }),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.description || data.message || `Cart change failed: ${res.status}`);
  }
  return data;
}

/**
 * Remove line item (change quantity to 0).
 */
export async function removeItem(lineKey: string): Promise<any> {
  return changeCart(lineKey, 0);
}

/**
 * POST /cart/update.js — set cart-level attributes (e.g. revpro_session_id for order attribution).
 * Attributes are sent to checkout and appear in order note_attributes.
 */
export async function updateCartAttributes(attributes: Record<string, string>): Promise<any> {
  const res = await fetchWithTimeout(cartUpdateUrl(), {
    ...FETCH_OPTIONS,
    method: 'POST',
    body: JSON.stringify({ attributes }),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error((data as { description?: string }).description ?? `Cart update failed: ${res.status}`);
  }
  return data;
}
