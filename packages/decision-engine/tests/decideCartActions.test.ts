import { describe, it, expect } from "vitest";
import {
  decideCartActions,
  createMoney,
  CartSnapshot,
  Product,
  StoreMetrics,
  DecisionReason,
} from "../src";

function buildCart(items: CartSnapshot["items"]): CartSnapshot {
  return {
    id: "cart-1",
    items,
  };
}

function buildStoreMetrics(options: {
  freeShippingThresholdAmount?: number | null;
  baselineAOVAmount?: number | null;
  currency?: string;
}): StoreMetrics {
  const currency = options.currency ?? "USD";
  return {
    currency,
    freeShippingThreshold:
      options.freeShippingThresholdAmount != null
        ? createMoney(options.freeShippingThresholdAmount, currency)
        : null,
    baselineAOV:
      options.baselineAOVAmount != null
        ? createMoney(options.baselineAOVAmount, currency)
        : null,
  };
}

const baseCatalog: Product[] = [
  {
    id: "p1",
    variantId: "v1",
    title: "Cart Product 1",
    price: createMoney(50, "USD"),
    inStock: true,
    collections: ["c1"],
  },
  {
    id: "p2",
    variantId: "v2",
    title: "Cross-sell small",
    price: createMoney(10, "USD"),
    inStock: true,
    collections: ["c1"],
  },
  {
    id: "p3",
    variantId: "v3",
    title: "Cross-sell medium",
    price: createMoney(15, "USD"),
    inStock: true,
    collections: ["c1"],
  },
  {
    id: "p4",
    variantId: "v4",
    title: "Cross-sell expensive",
    price: createMoney(40, "USD"),
    inStock: true,
    collections: ["c1"],
  },
  {
    id: "p5",
    variantId: "v5",
    title: "Out of stock",
    price: createMoney(5, "USD"),
    inStock: false,
    collections: ["c1"],
  },
  {
    id: "p6",
    variantId: "v6",
    title: "Different collection",
    price: createMoney(10, "USD"),
    inStock: true,
    collections: ["c2"],
  },
];

describe("decideCartActions", () => {
  it("handles an empty cart", () => {
    const cart = buildCart([]);
    const storeMetrics = buildStoreMetrics({
      freeShippingThresholdAmount: 100,
      baselineAOVAmount: 80,
    });

    const result = decideCartActions({
      cart,
      catalog: baseCatalog,
      storeMetrics,
    });

    expect(result.crossSell).toEqual([]);
    expect(result.freeShippingRemaining).toBe(100);
    expect(result.suppressCheckout).toBe(false);
    expect(
      result.decisionLog.some(
        (d) => d.reason === DecisionReason.CROSS_SELL_CART_EMPTY
      )
    ).toBe(true);
  });

  it("calculates remaining amount when cart is below real free-shipping threshold", () => {
    const cart = buildCart([
      {
        id: "line-1",
        productId: "p1",
        quantity: 1,
        unitPrice: createMoney(50, "USD"),
      },
    ]);
    const storeMetrics = buildStoreMetrics({
      freeShippingThresholdAmount: 100,
      baselineAOVAmount: 80,
    });

    const result = decideCartActions({
      cart,
      catalog: baseCatalog,
      storeMetrics,
    });

    expect(result.freeShippingRemaining).toBe(50);
    expect(
      result.decisionLog.some(
        (d) => d.reason === DecisionReason.FREE_SHIPPING_REAL_THRESHOLD_USED
      )
    ).toBe(true);
  });

  it("uses virtual free-shipping threshold when real threshold is missing", () => {
    const cart = buildCart([
      {
        id: "line-1",
        productId: "p1",
        quantity: 1,
        unitPrice: createMoney(50, "USD"),
      },
    ]);
    const storeMetrics = buildStoreMetrics({
      freeShippingThresholdAmount: null,
      baselineAOVAmount: 100,
    });

    const result = decideCartActions({
      cart,
      catalog: baseCatalog,
      storeMetrics,
    });

    // Virtual threshold = 100 * 1.2 = 120, remaining = 70
    expect(result.freeShippingRemaining).toBeCloseTo(70);
    expect(
      result.decisionLog.some(
        (d) => d.reason === DecisionReason.FREE_SHIPPING_VIRTUAL_THRESHOLD_USED
      )
    ).toBe(true);
  });

  it("never returns negative free-shipping remaining when cart is above threshold", () => {
    const cart = buildCart([
      {
        id: "line-1",
        productId: "p1",
        quantity: 3,
        unitPrice: createMoney(50, "USD"), // cart total 150
      },
    ]);
    const storeMetrics = buildStoreMetrics({
      freeShippingThresholdAmount: 100,
      baselineAOVAmount: 80,
    });

    const result = decideCartActions({
      cart,
      catalog: baseCatalog,
      storeMetrics,
    });

    expect(result.freeShippingRemaining).toBe(0);
    expect(
      result.decisionLog.some(
        (d) => d.reason === DecisionReason.FREE_SHIPPING_ALREADY_ELIGIBLE
      )
    ).toBe(true);
  });

  it("selects the highest priced valid cross-sell candidate", () => {
    const cart = buildCart([
      {
        id: "line-1",
        productId: "p1",
        quantity: 1,
        unitPrice: createMoney(50, "USD"),
      },
    ]);
    const storeMetrics = buildStoreMetrics({
      freeShippingThresholdAmount: 100,
      baselineAOVAmount: 80,
    });

    const result = decideCartActions({
      cart,
      catalog: baseCatalog,
      storeMetrics,
    });

    // p2, p3, p4 share collection c1, are in stock, not in cart; sorted by price desc so p4 first.
    expect(result.crossSell?.length).toBe(3);
    expect(result.crossSell?.[0]?.id).toBe("p4");
    expect(
      result.decisionLog.some(
        (d) => d.reason === DecisionReason.CROSS_SELL_SELECTED_HIGHEST_PRICED
      )
    ).toBe(true);
  });

  it("does not recommend a cross-sell when no product matches collections or is not in cart", () => {
    const cart = buildCart([
      { id: "line-1", productId: "p1", quantity: 1, unitPrice: createMoney(50, "USD") },
      { id: "line-2", productId: "p2", quantity: 1, unitPrice: createMoney(10, "USD") },
      { id: "line-3", productId: "p3", quantity: 1, unitPrice: createMoney(15, "USD") },
      { id: "line-4", productId: "p4", quantity: 1, unitPrice: createMoney(40, "USD") },
    ]);

    const storeMetrics = buildStoreMetrics({
      freeShippingThresholdAmount: 100,
      baselineAOVAmount: 80,
    });

    const result = decideCartActions({
      cart,
      catalog: baseCatalog,
      storeMetrics,
    });

    // All c1 products (p1–p4) are in cart; p5 out of stock, p6 different collection → no eligible.
    expect(result.crossSell).toEqual([]);
    expect(
      result.decisionLog.some(
        (d) => d.reason === DecisionReason.CROSS_SELL_NO_ELIGIBLE_PRODUCTS
      )
    ).toBe(true);
  });

  it("logs that checkout suppression is disabled in v1", () => {
    const cart = buildCart([]);
    const storeMetrics = buildStoreMetrics({
      freeShippingThresholdAmount: 100,
      baselineAOVAmount: 80,
    });

    const result = decideCartActions({
      cart,
      catalog: baseCatalog,
      storeMetrics,
    });

    expect(result.suppressCheckout).toBe(false);
    expect(
      result.decisionLog.some(
        (d) =>
          d.reason === DecisionReason.CHECKOUT_SUPPRESSION_DISABLED_V1 &&
          d.decisionType === "CHECKOUT_SUPPRESSION"
      )
    ).toBe(true);
  });
});

