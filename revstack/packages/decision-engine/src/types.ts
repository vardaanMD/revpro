// Core, framework-agnostic domain types for the decision engine.
// All types are plain data structures with no behavior.

// Represents a monetary value in a specific currency.
export interface Money {
  /**
   * Amount in integer cents (store currency). No floats; no currency conversion inside engine.
   */
  amount: number;
  currency: string;
}

// A single line item in the cart.
export interface CartItem {
  id: string;
  productId: string;
  quantity: number;
  unitPrice: Money;
}

// Snapshot of the current cart at a point in time.
export interface CartSnapshot {
  id: string;
  items: CartItem[];
}

// Product available for cross-sell.
export interface Product {
  id: string;
  /** Shopify variant GID; used when adding the recommended product to cart. */
  variantId: string;
  /** Product handle for building /products/{handle} URLs. */
  handle?: string;
  /** Featured image URL for recommendation card. */
  imageUrl?: string | null;
  title: string;
  price: Money;
  inStock: boolean;
  /**
   * Collections or categories this product belongs to.
   * Used to ensure cross-sells are relevant to items already in the cart.
   */
  collections: string[];
  /** Tags for TAG_MATCH strategy and relevance scoring. */
  tags?: string[];
  /** Vendor for same-vendor penalty in scoring. */
  vendor?: string;
  /** ISO date string; used by NEW_ARRIVALS strategy and debug. */
  createdAt?: string;
  /** Sales count (e.g. 30d); used by BEST_SELLING strategy and debug. */
  salesCount?: number;
}

/**
 * Cart context computed once per decision. Used for deterministic scoring.
 * All sets and values are derived from cart + catalog; no randomness.
 */
export interface CartContext {
  cartProductIds: Set<string>;
  cartCollections: Set<string>;
  cartTags: Set<string>;
  cartVendors: Set<string>;
  /** Average price per unit in cart (cents). */
  cartAveragePrice: number;
}

// Baseline store-level metrics and configuration. All monetary fields (e.g. baselineAOV, freeShippingThreshold) use integer cents.
export interface StoreMetrics {
  /**
   * Currency used by the store. The engine assumes all Money values
   * in a single evaluation share this currency.
   */
  currency: string;

  /**
   * Real free shipping threshold, if configured.
   * If provided and amount > 0, this is preferred over a virtual threshold.
   */
  freeShippingThreshold?: Money | null;

  /**
   * Baseline Average Order Value (AOV).
   * Used to derive a virtual free-shipping threshold when a real threshold
   * is not configured.
   */
  baselineAOV: Money | null;
}

// Reasons explaining why a particular decision was made or skipped.
export enum DecisionReason {
  // Cross-sell related
  CROSS_SELL_CART_EMPTY = "CROSS_SELL_CART_EMPTY",
  CROSS_SELL_NO_COLLECTION_MATCH = "CROSS_SELL_NO_COLLECTION_MATCH",
  CROSS_SELL_CART_VALUE_TOO_LOW = "CROSS_SELL_CART_VALUE_TOO_LOW",
  CROSS_SELL_NO_ELIGIBLE_PRODUCTS = "CROSS_SELL_NO_ELIGIBLE_PRODUCTS",
  CROSS_SELL_SELECTED_HIGHEST_PRICED = "CROSS_SELL_SELECTED_HIGHEST_PRICED",

  // Free shipping related
  FREE_SHIPPING_REAL_THRESHOLD_USED = "FREE_SHIPPING_REAL_THRESHOLD_USED",
  FREE_SHIPPING_VIRTUAL_THRESHOLD_USED = "FREE_SHIPPING_VIRTUAL_THRESHOLD_USED",
  FREE_SHIPPING_BASELINE_MISSING = "FREE_SHIPPING_BASELINE_MISSING",
  FREE_SHIPPING_ALREADY_ELIGIBLE = "FREE_SHIPPING_ALREADY_ELIGIBLE",

  // Checkout suppression related
  CHECKOUT_SUPPRESSION_DISABLED_V1 = "CHECKOUT_SUPPRESSION_DISABLED_V1",
}

export type DecisionType =
  | "CROSS_SELL"
  | "FREE_SHIPPING"
  | "CHECKOUT_SUPPRESSION";

// A single logged decision, suitable for later persistence.
export interface CartDecision {
  decisionType: DecisionType;
  reason: DecisionReason;
  /**
   * Human-readable explanation of what was evaluated, which rule applied,
   * and why an action was taken or skipped.
   */
  message: string;
  /**
   * Optional machine-friendly context for analytics and debugging.
   * Must remain JSON-serializable.
   */
  context?: Record<string, unknown>;
}
