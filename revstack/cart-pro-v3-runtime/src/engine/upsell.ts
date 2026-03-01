/**
 * Cart Pro V3 — upsell pure logic.
 * Standard upsell: subtotal-based rules, exclude variants already in cart.
 * No side effects.
 */

export interface StandardUpsellRule {
  variantId: number;
  conditionSubtotalCents: number;
}

function getSubtotalCents(cartRaw: any): number {
  if (cartRaw == null) return 0;
  const sub = cartRaw.items_subtotal_price;
  if (typeof sub === 'number' && !Number.isNaN(sub)) return Math.round(sub);
  const items = cartRaw.items;
  if (!Array.isArray(items)) return 0;
  let sum = 0;
  for (const item of items) {
    const linePrice = item?.line_price ?? item?.line_price_cents ?? 0;
    sum += typeof linePrice === 'number' ? linePrice : 0;
  }
  return Math.round(sum);
}

function getVariantIdsInCart(cartRaw: any): Set<number> {
  const set = new Set<number>();
  const items = cartRaw?.items;
  if (!Array.isArray(items)) return set;
  for (const item of items) {
    const id = item?.variant_id ?? item?.id;
    const n = typeof id === 'number' ? id : Number(id);
    if (Number.isInteger(n) && n > 0) set.add(n);
  }
  return set;
}

/**
 * Compute standard upsell list from cart and config.
 * - Subtotal >= conditionSubtotalCents for each rule.
 * - Exclude variants already in cart.
 * Pure function only.
 */
export function computeStandardUpsell(
  cartRaw: any,
  config: StandardUpsellRule[]
): StandardUpsellRule[] {
  if (!Array.isArray(config) || config.length === 0) return [];
  const subtotalCents = getSubtotalCents(cartRaw);
  const inCart = getVariantIdsInCart(cartRaw);
  const result: StandardUpsellRule[] = [];
  for (const rule of config) {
    const variantId = Number(rule.variantId);
    const conditionSubtotalCents = Number(rule.conditionSubtotalCents) || 0;
    if (!Number.isInteger(variantId) || variantId <= 0) continue;
    if (inCart.has(variantId)) continue;
    if (subtotalCents >= conditionSubtotalCents) {
      result.push({ variantId, conditionSubtotalCents });
    }
  }
  return result;
}
