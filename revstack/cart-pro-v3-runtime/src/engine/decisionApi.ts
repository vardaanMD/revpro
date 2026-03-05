/**
 * Cart Pro V3 — decision endpoint API.
 * POST /apps/cart-pro/decision with cart body; parse crossSell and map to UI shape.
 * Used for background refinement of snapshot recommendations (Phase 4).
 */

import type { SnapshotRecommendationItem } from './state';

const DECISION_ENDPOINT = '/apps/cart-pro/decision';

/**
 * Build request body for the decision route. Backend expects cart in schema:
 * { items: [{ id?, product_id?, quantity, price, final_line_price? }], total_price, currency? }.
 * Shopify cart.js raw may use line_price; we map to final_line_price.
 */
function buildDecisionBody(cartRaw: any): { items: Array<{ id?: number | string; product_id?: number | string; quantity: number; price: number; final_line_price?: number }>; total_price: number; currency?: string } {
  const items = Array.isArray(cartRaw?.items) ? cartRaw.items : [];
  const totalPrice = typeof cartRaw?.total_price === 'number' ? cartRaw.total_price : 0;
  const currency = typeof cartRaw?.currency === 'string' && cartRaw.currency.length >= 2 ? cartRaw.currency : 'USD';
  return {
    items: items.map((item: any) => ({
      id: item?.id,
      product_id: item?.product_id,
      quantity: Number(item?.quantity) || 0,
      price: Number(item?.price) ?? 0,
      final_line_price: typeof item?.line_price === 'number' ? item.line_price : undefined,
    })),
    total_price: totalPrice,
    currency,
  };
}

/**
 * Map decision engine Product to SnapshotRecommendationItem (variantId number, title, imageUrl, price, handle).
 * Decision returns Product with variantId as string (GID or numeric string); we normalize to number.
 */
function mapCrossSellItem(p: any): SnapshotRecommendationItem | null {
  if (!p || typeof p.title !== 'string') return null;
  const variantIdRaw = p?.variantId ?? p?.variant_id ?? p?.id;
  let variantId = 0;
  if (typeof variantIdRaw === 'number' && Number.isFinite(variantIdRaw)) {
    variantId = variantIdRaw;
  } else if (typeof variantIdRaw === 'string') {
    const parsed = parseInt(variantIdRaw, 10);
    if (Number.isFinite(parsed)) variantId = parsed;
    else {
      const gidMatch = /\/Variant\/(\d+)/.exec(variantIdRaw) ?? /^(\d+)$/.exec(variantIdRaw);
      if (gidMatch) variantId = parseInt(gidMatch[1], 10);
    }
  }
  if (!variantId || variantId <= 0) return null;
  const priceAmount = typeof p?.price?.amount === 'number' ? p.price.amount : (typeof p?.price === 'number' ? p.price : 0);
  return {
    variantId,
    title: p.title,
    imageUrl: p?.imageUrl ?? p?.image_url ?? null,
    price: { amount: priceAmount },
    handle: p?.handle ?? '',
  };
}

export interface FetchDecisionCrossSellResult {
  items: SnapshotRecommendationItem[];
  ok: boolean;
}

/**
 * POST current cart to the decision endpoint (app proxy). Parse response.crossSell and map to SnapshotRecommendationItem[].
 * Does not block; call from background (e.g. after applyCartRaw). Only run when cart has at least one item.
 */
export async function fetchDecisionCrossSell(cartRaw: any): Promise<FetchDecisionCrossSellResult> {
  const items = Array.isArray(cartRaw?.items) ? cartRaw.items : [];
  if (items.length === 0) {
    return { items: [], ok: true };
  }

  const url = typeof window !== 'undefined'
    ? `${window.location.origin}${DECISION_ENDPOINT}`
    : DECISION_ENDPOINT;
  const body = buildDecisionBody(cartRaw);

  try {
    const res = await fetch(url, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) return { items: [], ok: false };
    const data = await res.json();
    const crossSell = Array.isArray(data?.crossSell) ? data.crossSell : [];
    const mapped = crossSell
      .map((p: any) => mapCrossSellItem(p))
      .filter((x: SnapshotRecommendationItem | null): x is SnapshotRecommendationItem => x != null);
    return { items: mapped, ok: true };
  } catch {
    return { items: [], ok: false };
  }
}
