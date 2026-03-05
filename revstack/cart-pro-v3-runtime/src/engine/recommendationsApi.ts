/**
 * Cart Pro V3 — AI recommendations API.
 * POST /apps/cart-pro/ai/v2 with { lastAddedProductId }; response { products: ProductSnapshot[] }.
 * Debounced (0ms = parity with cart.txt; cache by cart signature still dedupes same cart). Does not block cart UI.
 */

const DEBOUNCE_MS = 0;

const AI_V2_ENDPOINT = '/apps/cart-pro/ai/v2';

/**
 * Build cart signature: sorted variant IDs joined, for cache key.
 */
export function getCartSignature(cartRaw: any): string {
  const items = cartRaw?.items;
  if (!Array.isArray(items) || items.length === 0) return '';
  const ids = items
    .map((item: any) => {
      const id = item?.variant_id ?? item?.id;
      return typeof id === 'number' ? id : Number(id);
    })
    .filter((n: number) => Number.isInteger(n) && n > 0)
    .sort((a: number, b: number) => a - b);
  return ids.join(',');
}

/** Variant IDs currently in cart (for filtering recommendations). */
function getCartVariantIds(cartRaw: any): Set<number> {
  const items = cartRaw?.items ?? [];
  const set = new Set<number>();
  for (const item of items) {
    const id = item?.variant_id ?? item?.id;
    const n = typeof id === 'number' ? id : Number(id);
    if (Number.isInteger(n) && n > 0) set.add(n);
  }
  return set;
}

export interface AIRecommendationItem {
  variantId: number;
}

/**
 * Fetch AI recommendations. POST /apps/cart-pro/ai/v2 with body { lastAddedProductId: string }.
 * Response: { products: ProductSnapshot[] }. Maps to { variantId } and excludes variants already in cart.
 */
export async function postRecommendations(cartRaw: any): Promise<AIRecommendationItem[]> {
  const items = cartRaw?.items ?? [];
  const lastAddedProductId =
    items.length > 0
      ? String(items[0]?.product_id ?? items[0]?.variant_id ?? '')
      : '';
  const cartVariantIds = getCartVariantIds(cartRaw);
  try {
    const res = await fetch(AI_V2_ENDPOINT, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ lastAddedProductId }),
    });
    if (!res.ok) return [];
    const data = await res.json();
    const products = Array.isArray(data?.products) ? data.products : [];
    return products
      .map((p: any) => {
        const id = p?.variantId ?? p?.variant_id ?? p?.id;
        const n = typeof id === 'number' ? id : Number(id);
        return Number.isInteger(n) && n > 0 ? { variantId: n } : null;
      })
      .filter((x: AIRecommendationItem | null): x is AIRecommendationItem => x != null && !cartVariantIds.has(x.variantId));
  } catch {
    return [];
  }
}

/**
 * Create a debounced version of a function. Last call wins; result delivered via callback.
 */
export function debounce<T, R>(
  fn: (arg: T) => Promise<R>,
  ms: number
): (arg: T, onResult: (result: R) => void) => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastArg: T | null = null;
  return (arg: T, onResult: (result: R) => void) => {
    lastArg = arg;
    if (timer) clearTimeout(timer);
    timer = setTimeout(async () => {
      timer = null;
      const a = lastArg;
      lastArg = null;
      if (a == null) return;
      try {
        const result = await fn(a);
        onResult(result);
      } catch {
        onResult([] as R);
      }
    }, ms);
  };
}

export const debouncedPostRecommendations = debounce<
  any,
  AIRecommendationItem[]
>(postRecommendations, DEBOUNCE_MS);
