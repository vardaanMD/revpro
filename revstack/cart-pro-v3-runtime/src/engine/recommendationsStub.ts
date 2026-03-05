/**
 * Cart Pro V3 — stub recommendations (no AI or external fetch).
 * Builds a small list from current cart items for UI display.
 */
import type { StandardUpsellRule } from './state';

export interface StubRecommendationItem extends StandardUpsellRule {
  title?: string;
  handle?: string;
  imageUrl?: string;
  price?: { amount: number };
}

export function buildStubRecommendations(cart: { items?: Array<{ variant_id?: number; id?: number; product_title?: string; handle?: string; image?: string; price?: number }> } | null | undefined): StubRecommendationItem[] {
  if (!cart?.items?.length) return [];

  const inCartVariantIds = new Set<number>(
    cart.items.map((item) => Number(item.variant_id ?? item.id) || 0).filter((id) => id > 0)
  );

  return cart.items
    .map((item) => ({
      variantId: Number(item.variant_id ?? item.id) || 0,
      conditionSubtotalCents: 0,
      title: item.product_title,
      handle: item.handle,
      imageUrl: item.image,
      price: {
        amount: typeof item.price === 'number' ? item.price : 0,
      },
    }))
    .filter((r) => r.variantId > 0 && !inCartVariantIds.has(r.variantId))
    .slice(0, 2);
}
