import type { Product } from "@revpro/decision-engine";

/** Debug entry for cross-sell (only when CART_PRO_DEBUG=1). */
export type CrossSellDebugEntry = {
  productId: string;
  score: number;
  sharedCollections: number;
  sharedTags: number;
  priceDelta: number;
  salesCount?: number;
};

/**
 * Strict decision API response contract. Cart route must explicitly construct this;
 * never spread raw engine output or leak internal fields (e.g. decisionLog).
 * UI config is served only from /bootstrap; this type is cart intelligence only.
 */
export type DecisionResponse = {
  crossSell: Product[];
  freeShippingRemaining: number;
  suppressCheckout: boolean;
  milestones: unknown[];
  enableCouponTease: boolean;
  /** Only present when CART_PRO_DEBUG=1. */
  crossSellDebug?: CrossSellDebugEntry[];
};
