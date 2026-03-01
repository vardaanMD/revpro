/**
 * Cart Pro V3 — free gift pure logic.
 * No side effects. Used by Engine.syncFreeGifts().
 */

export interface FreeGiftConfigItem {
  variantId: number;
  minSubtotalCents: number;
  maxQuantity: number;
}

/**
 * Get cart subtotal in cents from Shopify cart.js raw.
 */
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

/**
 * Compute expected gift quantities from cart and config.
 * If cart subtotal >= minSubtotalCents → gift eligible; quantity capped by maxQuantity.
 * Returns Map<variantId, quantity>. No side effects.
 */
export function computeExpectedGifts(
  cartRaw: any,
  freeGiftConfig: FreeGiftConfigItem[]
): Map<number, number> {
  const result = new Map<number, number>();
  if (!Array.isArray(freeGiftConfig) || freeGiftConfig.length === 0) return result;
  const subtotalCents = getSubtotalCents(cartRaw);
  for (const rule of freeGiftConfig) {
    const variantId = Number(rule.variantId);
    const maxQty = Math.max(0, Math.floor(Number(rule.maxQuantity) || 0));
    if (!Number.isInteger(variantId) || variantId <= 0 || maxQty === 0) continue;
    if (subtotalCents >= (rule.minSubtotalCents ?? 0)) {
      result.set(variantId, maxQty);
    }
  }
  return result;
}

export interface DiffGiftsToAdd {
  variantId: number;
  quantity: number;
}

export interface DiffGiftsToRemove {
  lineKey: string;
}

export interface DiffGiftsResult {
  toAdd: DiffGiftsToAdd[];
  toRemove: DiffGiftsToRemove[];
}

/**
 * Get line key from cart item (Shopify cart.js shape).
 */
function getLineKey(item: any): string {
  return item?.key ?? item?.id ?? String(item?.variant_id ?? '');
}

/**
 * Get variant id from cart item.
 */
function getVariantId(item: any): number {
  const id = item?.variant_id ?? item?.id;
  return typeof id === 'number' ? id : Number(id) || 0;
}

/**
 * Diff actual cart vs expected gifts. Returns toAdd and toRemove.
 * Strategy: remove all existing gift lines (by config variant ids), then add expected.
 * Prevents duplicates and keeps logic deterministic.
 */
export function diffGifts(
  cartRaw: any,
  expectedMap: Map<number, number>,
  giftVariantIds: Set<number>
): DiffGiftsResult {
  const toAdd: DiffGiftsToAdd[] = [];
  const toRemove: DiffGiftsToRemove[] = [];
  const items = cartRaw?.items;
  if (!Array.isArray(items)) {
    expectedMap.forEach((qty, variantId) => {
      if (qty > 0) toAdd.push({ variantId, quantity: qty });
    });
    return { toAdd, toRemove };
  }

  for (const item of items) {
    const variantId = getVariantId(item);
    if (giftVariantIds.has(variantId)) {
      toRemove.push({ lineKey: getLineKey(item) });
    }
  }
  expectedMap.forEach((qty, variantId) => {
    if (qty > 0) toAdd.push({ variantId, quantity: qty });
  });
  return { toAdd, toRemove };
}

/**
 * Build set of variant IDs that are configured as gifts (for diffGifts).
 */
export function getGiftVariantIds(config: FreeGiftConfigItem[]): Set<number> {
  const set = new Set<number>();
  if (!Array.isArray(config)) return set;
  for (const rule of config) {
    const id = Number(rule.variantId);
    if (Number.isInteger(id) && id > 0) set.add(id);
  }
  return set;
}
