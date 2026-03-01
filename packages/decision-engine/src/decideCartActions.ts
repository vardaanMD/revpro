import {
  CartDecision,
  CartSnapshot,
  DecisionReason,
  Money,
  Product,
  StoreMetrics,
} from "./types";

/**
 * Monetary contract:
 * - All amounts are integer cents.
 * - No floats.
 * - No currency conversion inside engine.
 */

const MAX_CROSS_SELL_ITEMS = 8;

/**
 * Core decision engine entrypoint. Pure and deterministic: no side effects, no I/O.
 * Monetary contract: all input/output amounts are integer cents.
 */
export function decideCartActions(input: {
  cart: CartSnapshot;
  catalog: Product[];
  storeMetrics: StoreMetrics;
}): {
  crossSell: Product[];
  freeShippingRemaining: number | null;
  suppressCheckout: boolean;
  decisionLog: CartDecision[];
} {
  const { cart, catalog, storeMetrics } = input;

  const decisions: CartDecision[] = [];

  const { crossSell, decisions: crossSellDecisions } = decideCrossSell(
    cart,
    catalog
  );
  decisions.push(...crossSellDecisions);

  const {
    freeShippingRemaining,
    decisions: freeShippingDecisions,
  } = decideFreeShippingRemaining(cart, storeMetrics);
  decisions.push(...freeShippingDecisions);

  const {
    suppressCheckout,
    decisions: checkoutDecisions,
  } = decideCheckoutSuppression();
  decisions.push(...checkoutDecisions);

  return {
    crossSell,
    freeShippingRemaining,
    suppressCheckout,
    decisionLog: decisions,
  };
}

// ---------- Cross-sell decision ----------

// Applies the V1 cross-sell rules:
// - Recommend up to MAX_CROSS_SELL_ITEMS products from the same collection(s) as the cart
// - Product must: be in stock, not already in the cart, share at least one collection with a cart item
// - Sorted by price descending so higher-value recommendations appear first
function decideCrossSell(
  cart: CartSnapshot,
  catalog: Product[]
): { crossSell: Product[]; decisions: CartDecision[] } {
  const decisions: CartDecision[] = [];

  const cartTotal = calculateCartTotal(cart);
  if (cart.items.length === 0 || cartTotal <= 0) {
    decisions.push({
      decisionType: "CROSS_SELL",
      reason: DecisionReason.CROSS_SELL_CART_EMPTY,
      message:
        "Skipped cross-sell recommendation because the cart is empty or has zero total value.",
      context: { cartItemCount: cart.items.length, cartTotal },
    });
    return { crossSell: [], decisions };
  }

  const cartCollections = determineCartCollections(cart, catalog);
  if (cartCollections.size === 0) {
    decisions.push({
      decisionType: "CROSS_SELL",
      reason: DecisionReason.CROSS_SELL_NO_COLLECTION_MATCH,
      message:
        "Skipped cross-sell recommendation because no collections could be derived from cart items.",
      context: { cartItemCount: cart.items.length },
    });
    return { crossSell: [], decisions };
  }

  const cartProductIds = new Set(cart.items.map((item) => item.productId));
  const eligibleProducts = catalog.filter((product) => {
    if (!product.inStock) return false;
    if (cartProductIds.has(product.id)) return false;
    return product.collections.some((c) => cartCollections.has(c));
  });

  if (eligibleProducts.length === 0) {
    decisions.push({
      decisionType: "CROSS_SELL",
      reason: DecisionReason.CROSS_SELL_NO_ELIGIBLE_PRODUCTS,
      message:
        "No cross-sell product was selected because no catalog products satisfied stock, price, and collection rules.",
      context: { cartCollections: Array.from(cartCollections) },
    });
    return { crossSell: [], decisions };
  }

  const sorted = [...eligibleProducts].sort(
    (a, b) => b.price.amount - a.price.amount
  );
  const selected = sorted.slice(0, MAX_CROSS_SELL_ITEMS);

  decisions.push({
    decisionType: "CROSS_SELL",
    reason: DecisionReason.CROSS_SELL_SELECTED_HIGHEST_PRICED,
    message:
      "Selected eligible cross-sell products (same collection as cart), sorted by price descending.",
    context: {
      selectedCount: selected.length,
      selectedProductIds: selected.map((p) => p.id),
      cartTotal,
    },
  });

  return { crossSell: selected, decisions };
}

function calculateCartTotal(cart: CartSnapshot): number {
  return cart.items.reduce((sum, item) => {
    const lineTotal = item.unitPrice.amount * item.quantity;
    return sum + (Number.isFinite(lineTotal) ? lineTotal : 0);
  }, 0);
}

function determineCartCollections(
  cart: CartSnapshot,
  catalog: Product[]
): Set<string> {
  const productById = new Map<string, Product>();
  for (const product of catalog) {
    productById.set(product.id, product);
  }

  const collections = new Set<string>();
  for (const item of cart.items) {
    const product = productById.get(item.productId);
    if (!product) continue;
    for (const collection of product.collections) {
      collections.add(collection);
    }
  }
  return collections;
}

// ---------- Free shipping decision ----------

// Applies the V1 free-shipping logic:
// - If store has a real free-shipping threshold: use it
// - Else: compute virtual threshold = baselineAOV * 1.2
// - Return remaining amount to reach threshold
// - Never return negative numbers
function decideFreeShippingRemaining(
  cart: CartSnapshot,
  storeMetrics: StoreMetrics
): { freeShippingRemaining: number | null; decisions: CartDecision[] } {
  const decisions: CartDecision[] = [];

  const cartTotal = calculateCartTotal(cart);

  const realThreshold = storeMetrics.freeShippingThreshold;
  let thresholdAmount: number | null = null;
  let reason: DecisionReason | null = null;

  if (realThreshold && realThreshold.amount > 0) {
    thresholdAmount = realThreshold.amount;
    reason = DecisionReason.FREE_SHIPPING_REAL_THRESHOLD_USED;
  } else if (storeMetrics.baselineAOV && storeMetrics.baselineAOV.amount > 0) {
    thresholdAmount = storeMetrics.baselineAOV.amount * 1.2;
    reason = DecisionReason.FREE_SHIPPING_VIRTUAL_THRESHOLD_USED;
  } else {
    decisions.push({
      decisionType: "FREE_SHIPPING",
      reason: DecisionReason.FREE_SHIPPING_BASELINE_MISSING,
      message:
        "Could not compute free-shipping remaining because neither a real threshold nor a positive baseline AOV was provided.",
      context: {
        hasRealThreshold: Boolean(realThreshold),
        baselineAOVAmount: storeMetrics.baselineAOV?.amount ?? null,
      },
    });
    return { freeShippingRemaining: null, decisions };
  }

  let remaining = thresholdAmount - cartTotal;
  if (remaining <= 0) {
    remaining = 0;
    decisions.push({
      decisionType: "FREE_SHIPPING",
      reason: DecisionReason.FREE_SHIPPING_ALREADY_ELIGIBLE,
      message:
        "Cart is already at or above the free-shipping threshold. Remaining amount set to zero.",
      context: {
        cartTotal,
        thresholdAmount,
      },
    });
    return { freeShippingRemaining: remaining, decisions };
  }

  decisions.push({
    decisionType: "FREE_SHIPPING",
    reason: reason!,
    message:
      "Computed remaining amount to reach free-shipping threshold using configured rules.",
    context: {
      cartTotal,
      thresholdAmount,
      remaining,
      thresholdSource:
        reason === DecisionReason.FREE_SHIPPING_REAL_THRESHOLD_USED
          ? "real"
          : "virtual",
    },
  });

  return { freeShippingRemaining: remaining, decisions };
}

// ---------- Checkout suppression decision ----------

// V1 rule:
// - Always return false
// - Structured so that logic can become dynamic later (Lane B)
function decideCheckoutSuppression(): {
  suppressCheckout: boolean;
  decisions: CartDecision[];
} {
  const decisions: CartDecision[] = [
    {
      decisionType: "CHECKOUT_SUPPRESSION",
      reason: DecisionReason.CHECKOUT_SUPPRESSION_DISABLED_V1,
      message:
        "Checkout suppression is disabled in v1. Always allow checkout to proceed.",
    },
  ];

  return {
    suppressCheckout: false,
    decisions,
  };
}

// Utility for constructing Money values in tests or callers, kept here to
// avoid any framework dependencies.
export function createMoney(amount: number, currency: string): Money {
  return { amount, currency };
}

