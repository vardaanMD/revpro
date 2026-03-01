import {
  CartContext,
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

/** Fixed scoring weights (no config). */
const WEIGHT_SHARED_COLLECTION = 3;
const WEIGHT_SHARED_TAG = 2;
const WEIGHT_PRICE_PROXIMITY = 1;
const PENALTY_SAME_VENDOR = 2;
/** Price proximity: max contribution 5; overlap weights dominate. */
const PRICE_PROXIMITY_SCALE = 10000;
const PRICE_PROXIMITY_DIVISOR = 2000;
const PRICE_PROXIMITY_CAP = 5;
/** Cap score components to prevent runaway inflation. */
const CAP_SHARED_COLLECTIONS = 3;
const CAP_SHARED_TAGS = 5;

/** Debug entry for a single cross-sell candidate (only when CART_PRO_DEBUG=1). */
export interface CrossSellDebugEntry {
  productId: string;
  score: number;
  sharedCollections: number;
  sharedTags: number;
  priceDelta: number;
  salesCount?: number;
}

/**
 * Core decision engine entrypoint. Pure and deterministic: no side effects, no I/O.
 * Monetary contract: all input/output amounts are integer cents.
 * Strategy dominates ordering; score refines within strategy tier.
 */
export function decideCartActions(input: {
  cart: CartSnapshot;
  catalog: Product[];
  storeMetrics: StoreMetrics;
  strategy?: string;
  debug?: boolean;
}): {
  crossSell: Product[];
  freeShippingRemaining: number | null;
  suppressCheckout: boolean;
  decisionLog: CartDecision[];
  crossSellDebug?: CrossSellDebugEntry[];
} {
  const { cart, catalog, storeMetrics, strategy, debug } = input;

  const decisions: CartDecision[] = [];

  const { crossSell, decisions: crossSellDecisions, crossSellDebug } =
    decideCrossSell(cart, catalog, strategy, debug ?? false);
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

  const result: {
    crossSell: Product[];
    freeShippingRemaining: number | null;
    suppressCheckout: boolean;
    decisionLog: CartDecision[];
    crossSellDebug?: CrossSellDebugEntry[];
  } = {
    crossSell,
    freeShippingRemaining,
    suppressCheckout,
    decisionLog: decisions,
  };
  if (crossSellDebug !== undefined) result.crossSellDebug = crossSellDebug;
  return result;
}

// ---------- Cart context (computed once per decision) ----------

function buildCartContext(cart: CartSnapshot, catalog: Product[]): CartContext {
  const cartProductIds = new Set(cart.items.map((item) => item.productId));
  const productById = new Map(catalog.map((p) => [p.id, p]));

  const cartCollections = new Set<string>();
  const cartTags = new Set<string>();
  const cartVendors = new Set<string>();
  let totalCents = 0;
  let totalQuantity = 0;

  for (const item of cart.items) {
    const product = productById.get(item.productId);
    if (product) {
      for (const c of product.collections ?? []) cartCollections.add(c);
      for (const t of product.tags ?? []) cartTags.add(t);
      if (typeof product.vendor === "string" && product.vendor)
        cartVendors.add(product.vendor);
    }
    const q = Math.max(0, item.quantity);
    totalCents += item.unitPrice.amount * q;
    totalQuantity += q;
  }

  const cartAveragePrice =
    totalQuantity > 0 ? Math.round(totalCents / totalQuantity) : 0;

  return {
    cartProductIds,
    cartCollections,
    cartTags,
    cartVendors,
    cartAveragePrice,
  };
}

// ---------- Scoring (relevance refinement within strategy) ----------

/**
 * Price proximity: rawProximity = max(0, 10000 - priceDelta) / 2000;
 * priceProximityScore = min(5, rawProximity). Max contribution from price is 5.
 */
function priceProximityScore(priceDeltaCents: number): number {
  const priceDelta = Math.abs(priceDeltaCents);
  const rawProximity = Math.max(0, PRICE_PROXIMITY_SCALE - priceDelta) / PRICE_PROXIMITY_DIVISOR;
  return Math.min(PRICE_PROXIMITY_CAP, rawProximity);
}

/**
 * Unified scoring: +3×cappedCollections +2×cappedTags +1×priceProximity −2×sameVendor.
 * sharedCollectionCount capped at 3, sharedTagCount capped at 5. Price contribution capped at 5.
 */
export function scoreProduct(
  product: Product,
  cartContext: CartContext
): { score: number; sharedCollections: number; sharedTags: number; priceDelta: number } {
  const rawSharedCollections = (product.collections ?? []).filter((c) =>
    cartContext.cartCollections.has(c)
  ).length;
  const rawSharedTags = (product.tags ?? []).filter((t) =>
    cartContext.cartTags.has(t)
  ).length;
  const sharedCollections = Math.min(rawSharedCollections, CAP_SHARED_COLLECTIONS);
  const sharedTags = Math.min(rawSharedTags, CAP_SHARED_TAGS);
  const priceDelta = product.price.amount - cartContext.cartAveragePrice;
  const priceScore = priceProximityScore(priceDelta);
  const sameVendor =
    typeof product.vendor === "string" &&
    product.vendor &&
    cartContext.cartVendors.has(product.vendor)
      ? 1
      : 0;
  const score =
    WEIGHT_SHARED_COLLECTION * sharedCollections +
    WEIGHT_SHARED_TAG * sharedTags +
    WEIGHT_PRICE_PROXIMITY * priceScore -
    PENALTY_SAME_VENDOR * sameVendor;
  return { score, sharedCollections, sharedTags, priceDelta };
}

// ---------- Cross-sell decision (strategy dominance, then score refinement) ----------

function decideCrossSell(
  cart: CartSnapshot,
  catalog: Product[],
  strategy?: string,
  debug: boolean = false
): {
  crossSell: Product[];
  decisions: CartDecision[];
  crossSellDebug?: CrossSellDebugEntry[];
} {
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

  const cartContext = buildCartContext(cart, catalog);
  const effectiveStrategy = strategy ?? "COLLECTION_MATCH";

  /** Enriched candidate: all values precomputed; sort uses only stored values, no recomputation. */
  type Scored = {
    product: Product;
    score: number;
    sharedCollectionCount: number;
    sharedTagCount: number;
    priceDelta: number;
    salesCount: number;
    createdAt: string;
  };
  const scoreCandidates = (products: Product[]): Scored[] =>
    products.map((p) => {
      const s = scoreProduct(p, cartContext);
      return {
        product: p,
        score: s.score,
        sharedCollectionCount: s.sharedCollections,
        sharedTagCount: s.sharedTags,
        priceDelta: s.priceDelta,
        salesCount: typeof p.salesCount === "number" ? p.salesCount : 0,
        createdAt: typeof p.createdAt === "string" ? p.createdAt : "",
      };
    });

  /** Final tiebreaker: deterministic order by product.id ascending. No reliance on sort stability. */
  const compareScoreThenId = (a: Scored, b: Scored): number => {
    if (b.score !== a.score) return b.score - a.score;
    return a.product.id.localeCompare(b.product.id);
  };

  let eligible: Scored[] = [];
  let selected: Product[] = [];

  switch (effectiveStrategy) {
    case "COLLECTION_MATCH": {
      if (cartContext.cartCollections.size === 0) {
        decisions.push({
          decisionType: "CROSS_SELL",
          reason: DecisionReason.CROSS_SELL_NO_COLLECTION_MATCH,
          message:
            "Skipped cross-sell recommendation because no collections could be derived from cart items.",
          context: { cartItemCount: cart.items.length },
        });
        return { crossSell: [], decisions };
      }
      const withOverlap = catalog.filter((p) => {
        if (!p.inStock || cartContext.cartProductIds.has(p.id)) return false;
        return (p.collections ?? []).some((c) => cartContext.cartCollections.has(c));
      });
      eligible = scoreCandidates(withOverlap);
      eligible.sort(compareScoreThenId);
      selected = eligible.slice(0, MAX_CROSS_SELL_ITEMS).map((s) => s.product);
      decisions.push({
        decisionType: "CROSS_SELL",
        reason: DecisionReason.CROSS_SELL_SELECTED_HIGHEST_PRICED,
        message:
          "Selected eligible cross-sell products (same collection as cart), sorted by score descending.",
        context: {
          selectedCount: selected.length,
          selectedProductIds: selected.map((p) => p.id),
          cartTotal,
        },
      });
      break;
    }

    case "TAG_MATCH": {
      let tagMatchEligible: Product[];
      if (cartContext.cartTags.size === 0) {
        if (cartContext.cartCollections.size === 0) {
          decisions.push({
            decisionType: "CROSS_SELL",
            reason: DecisionReason.CROSS_SELL_NO_COLLECTION_MATCH,
            message:
              "Skipped cross-sell recommendation because no collections could be derived from cart items.",
            context: { cartItemCount: cart.items.length },
          });
          return { crossSell: [], decisions };
        }
        tagMatchEligible = catalog.filter((p) => {
          if (!p.inStock || cartContext.cartProductIds.has(p.id)) return false;
          return (p.collections ?? []).some((c) => cartContext.cartCollections.has(c));
        });
      } else {
        tagMatchEligible = catalog.filter((p) => {
          if (!p.inStock || cartContext.cartProductIds.has(p.id)) return false;
          return (p.tags ?? []).some((t) => cartContext.cartTags.has(t));
        });
      }
      eligible = scoreCandidates(tagMatchEligible);
      eligible.sort(compareScoreThenId);
      selected = eligible.slice(0, MAX_CROSS_SELL_ITEMS).map((s) => s.product);
      decisions.push({
        decisionType: "CROSS_SELL",
        reason: DecisionReason.CROSS_SELL_SELECTED_HIGHEST_PRICED,
        message:
          cartContext.cartTags.size === 0
            ? "TAG_MATCH degraded to collection overlap (no cart tags); sorted by score."
            : "Selected cross-sell products with shared tag, sorted by score descending.",
        context: {
          selectedCount: selected.length,
          selectedProductIds: selected.map((p) => p.id),
          cartTotal,
        },
      });
      break;
    }

    case "MANUAL_COLLECTION": {
      const inCatalog = catalog.filter(
        (p) => p.inStock && !cartContext.cartProductIds.has(p.id)
      );
      if (inCatalog.length === 0) {
        decisions.push({
          decisionType: "CROSS_SELL",
          reason: DecisionReason.CROSS_SELL_NO_ELIGIBLE_PRODUCTS,
          message:
            "No cross-sell product from manual collections (catalog empty or all in cart).",
          context: {},
        });
        return { crossSell: [], decisions };
      }
      const scored = scoreCandidates(inCatalog);
      const hasCollectionOverlap = (s: Scored) => s.sharedCollectionCount > 0;
      scored.sort((a, b) => {
        const aTier = hasCollectionOverlap(a) ? 1 : 0;
        const bTier = hasCollectionOverlap(b) ? 1 : 0;
        if (bTier !== aTier) return bTier - aTier;
        return compareScoreThenId(a, b);
      });
      selected = scored.slice(0, MAX_CROSS_SELL_ITEMS).map((s) => s.product);
      eligible = scored;
      decisions.push({
        decisionType: "CROSS_SELL",
        reason: DecisionReason.CROSS_SELL_SELECTED_HIGHEST_PRICED,
        message:
          "Selected from manual collections; tier by cart collection overlap, then by score.",
        context: {
          selectedCount: selected.length,
          selectedProductIds: selected.map((p) => p.id),
          cartTotal,
        },
      });
      break;
    }

    case "BEST_SELLING": {
      const inCatalog = catalog.filter(
        (p) => p.inStock && !cartContext.cartProductIds.has(p.id)
      );
      const scored = scoreCandidates(inCatalog);
      const maxSales = scored.length > 0 ? Math.max(...scored.map((s) => s.salesCount)) : 0;
      const minSales = scored.length > 0 ? Math.min(...scored.map((s) => s.salesCount)) : 0;
      const densityWeak = maxSales - minSales <= 1;
      if (densityWeak && cartContext.cartCollections.size > 0) {
        const withOverlap = inCatalog.filter((p) =>
          (p.collections ?? []).some((c) => cartContext.cartCollections.has(c))
        );
        eligible = scoreCandidates(withOverlap);
        eligible.sort((a, b) => {
          if (b.score !== a.score) return b.score - a.score;
          if (b.salesCount !== a.salesCount) return b.salesCount - a.salesCount;
          return a.product.id.localeCompare(b.product.id);
        });
      } else {
        eligible = scored;
        eligible.sort((a, b) => {
          if (b.salesCount !== a.salesCount) return b.salesCount - a.salesCount;
          return compareScoreThenId(a, b);
        });
      }
      selected = eligible.slice(0, MAX_CROSS_SELL_ITEMS).map((s) => s.product);
      decisions.push({
        decisionType: "CROSS_SELL",
        reason: DecisionReason.CROSS_SELL_SELECTED_HIGHEST_PRICED,
        message: densityWeak
          ? "BEST_SELLING density guard: collection overlap eligibility, score then salesCount tie-break."
          : "Selected cross-sell by sales count (BEST_SELLING), ties broken by score.",
        context: {
          selectedCount: selected.length,
          selectedProductIds: selected.map((p) => p.id),
          cartTotal,
        },
      });
      break;
    }

    case "NEW_ARRIVALS": {
      const inCatalog = catalog.filter(
        (p) => p.inStock && !cartContext.cartProductIds.has(p.id)
      );
      const scored = scoreCandidates(inCatalog);
      scored.sort((a, b) => {
        const dateCmp = b.createdAt.localeCompare(a.createdAt);
        if (dateCmp !== 0) return dateCmp;
        return compareScoreThenId(a, b);
      });
      selected = scored.slice(0, MAX_CROSS_SELL_ITEMS).map((s) => s.product);
      eligible = scored;
      decisions.push({
        decisionType: "CROSS_SELL",
        reason: DecisionReason.CROSS_SELL_SELECTED_HIGHEST_PRICED,
        message:
          "Selected cross-sell by newest first (NEW_ARRIVALS), ties broken by score.",
        context: {
          selectedCount: selected.length,
          selectedProductIds: selected.map((p) => p.id),
          cartTotal,
        },
      });
      break;
    }

    default: {
      if (cartContext.cartCollections.size === 0) {
        decisions.push({
          decisionType: "CROSS_SELL",
          reason: DecisionReason.CROSS_SELL_NO_COLLECTION_MATCH,
          message:
            "Skipped cross-sell recommendation because no collections could be derived from cart items.",
          context: { cartItemCount: cart.items.length },
        });
        return { crossSell: [], decisions };
      }
      const withOverlap = catalog.filter((p) => {
        if (!p.inStock || cartContext.cartProductIds.has(p.id)) return false;
        return (p.collections ?? []).some((c) => cartContext.cartCollections.has(c));
      });
      eligible = scoreCandidates(withOverlap);
      eligible.sort(compareScoreThenId);
      selected = eligible.slice(0, MAX_CROSS_SELL_ITEMS).map((s) => s.product);
      decisions.push({
        decisionType: "CROSS_SELL",
        reason: DecisionReason.CROSS_SELL_SELECTED_HIGHEST_PRICED,
        message:
          "Selected eligible cross-sell products (same collection as cart), sorted by score descending.",
        context: {
          selectedCount: selected.length,
          selectedProductIds: selected.map((p) => p.id),
          cartTotal,
        },
      });
    }
  }

  const out: {
    crossSell: Product[];
    decisions: CartDecision[];
    crossSellDebug?: CrossSellDebugEntry[];
  } = { crossSell: selected, decisions };
  if (debug && eligible.length > 0) {
    out.crossSellDebug = eligible.slice(0, MAX_CROSS_SELL_ITEMS).map((s) => ({
      productId: s.product.id,
      score: s.score,
      sharedCollections: s.sharedCollectionCount,
      sharedTags: s.sharedTagCount,
      priceDelta: s.priceDelta,
      ...(s.salesCount > 0 || s.product.salesCount !== undefined ? { salesCount: s.salesCount } : {}),
    }));
  }
  return out;
}

function calculateCartTotal(cart: CartSnapshot): number {
  return cart.items.reduce((sum, item) => {
    const lineTotal = item.unitPrice.amount * item.quantity;
    return sum + (Number.isFinite(lineTotal) ? lineTotal : 0);
  }, 0);
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
