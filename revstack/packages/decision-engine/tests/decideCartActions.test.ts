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

  it("COLLECTION_MATCH never returns products without collection overlap", () => {
    const cart = buildCart([
      { id: "line-1", productId: "p1", quantity: 1, unitPrice: createMoney(50, "USD") },
    ]);
    const storeMetrics = buildStoreMetrics({
      freeShippingThresholdAmount: 100,
      baselineAOVAmount: 80,
    });
    const result = decideCartActions({
      cart,
      catalog: baseCatalog,
      storeMetrics,
      strategy: "COLLECTION_MATCH",
    });
    const ids = new Set(result.crossSell.map((p) => p.id));
    expect(ids.has("p6")).toBe(false);
    result.crossSell.forEach((p) => {
      expect(p.collections.some((c) => c === "c1")).toBe(true);
    });
  });

  it("TAG_MATCH returns empty when no product shares a tag with cart", () => {
    const catalogWithTags: Product[] = [
      { ...baseCatalog[0], collections: ["c1"], tags: ["t1"] },
      { ...baseCatalog[1], collections: ["c1"], tags: ["t2"] },
    ];
    const cart = buildCart([
      { id: "line-1", productId: "p1", quantity: 1, unitPrice: createMoney(50, "USD") },
    ]);
    const storeMetrics = buildStoreMetrics({
      freeShippingThresholdAmount: 100,
      baselineAOVAmount: 80,
    });
    const result = decideCartActions({
      cart,
      catalog: catalogWithTags,
      storeMetrics,
      strategy: "TAG_MATCH",
    });
    expect(result.crossSell).toEqual([]);
  });

  it("TAG_MATCH degrades to collection overlap when cart has no tags", () => {
    const cart = buildCart([
      { id: "line-1", productId: "p1", quantity: 1, unitPrice: createMoney(50, "USD") },
    ]);
    const storeMetrics = buildStoreMetrics({
      freeShippingThresholdAmount: 100,
      baselineAOVAmount: 80,
    });
    const result = decideCartActions({
      cart,
      catalog: baseCatalog,
      storeMetrics,
      strategy: "TAG_MATCH",
    });
    expect(result.crossSell.length).toBeGreaterThan(0);
    result.crossSell.forEach((p) => {
      expect(p.collections.some((c) => c === "c1")).toBe(true);
    });
  });

  it("NEW_ARRIVALS orders by createdAt DESC then score", () => {
    const catalogWithDates: Product[] = [
      { ...baseCatalog[1], id: "a", createdAt: "2024-01-01", collections: ["c1"] },
      { ...baseCatalog[2], id: "b", createdAt: "2024-01-01", collections: ["c1"] },
      { ...baseCatalog[3], id: "c", createdAt: "2024-06-01", collections: ["c1"] },
    ].filter((p) => p.id !== "p1");
    const cart = buildCart([
      { id: "line-1", productId: "p1", quantity: 1, unitPrice: createMoney(50, "USD") },
    ]);
    const storeMetrics = buildStoreMetrics({
      freeShippingThresholdAmount: 100,
      baselineAOVAmount: 80,
    });
    const result = decideCartActions({
      cart,
      catalog: catalogWithDates,
      storeMetrics,
      strategy: "NEW_ARRIVALS",
    });
    const ids = result.crossSell.map((p) => p.id);
    const cIndex = ids.indexOf("c");
    const aIndex = ids.indexOf("a");
    const bIndex = ids.indexOf("b");
    expect(cIndex).toBeGreaterThanOrEqual(0);
    expect(cIndex).toBeLessThan(aIndex === -1 ? Infinity : aIndex);
    expect(cIndex).toBeLessThan(bIndex === -1 ? Infinity : bIndex);
  });

  it("deterministic: same input produces same cross-sell order", () => {
    const cart = buildCart([
      { id: "line-1", productId: "p1", quantity: 1, unitPrice: createMoney(50, "USD") },
    ]);
    const storeMetrics = buildStoreMetrics({
      freeShippingThresholdAmount: 100,
      baselineAOVAmount: 80,
    });
    const run = () =>
      decideCartActions({
        cart,
        catalog: baseCatalog,
        storeMetrics,
        strategy: "COLLECTION_MATCH",
      });
    const a = run().crossSell.map((p) => p.id);
    const b = run().crossSell.map((p) => p.id);
    expect(a).toEqual(b);
  });

  it("BEST_SELLING density guard uses collection overlap when sales spread <= 1", () => {
    const catalogUniformSales: Product[] = [
      { ...baseCatalog[0], collections: ["c1"] },
      { ...baseCatalog[1], id: "p2", collections: ["c1"], salesCount: 1 },
      { ...baseCatalog[2], id: "p3", collections: ["c1"], salesCount: 1 },
      { ...baseCatalog[3], id: "p4", collections: ["c2"], salesCount: 1 },
    ];
    const cart = buildCart([
      { id: "line-1", productId: "p1", quantity: 1, unitPrice: createMoney(50, "USD") },
    ]);
    const storeMetrics = buildStoreMetrics({
      freeShippingThresholdAmount: 100,
      baselineAOVAmount: 80,
    });
    const result = decideCartActions({
      cart,
      catalog: catalogUniformSales,
      storeMetrics,
      strategy: "BEST_SELLING",
    });
    const ids = new Set(result.crossSell.map((p) => p.id));
    expect(ids.has("p4")).toBe(false);
    result.crossSell.forEach((p) => {
      expect(p.collections.some((c) => c === "c1")).toBe(true);
    });
  });

  it("debug flag returns crossSellDebug when set", () => {
    const cart = buildCart([
      { id: "line-1", productId: "p1", quantity: 1, unitPrice: createMoney(50, "USD") },
    ]);
    const storeMetrics = buildStoreMetrics({
      freeShippingThresholdAmount: 100,
      baselineAOVAmount: 80,
    });
    const result = decideCartActions({
      cart,
      catalog: baseCatalog,
      storeMetrics,
      strategy: "COLLECTION_MATCH",
      debug: true,
    });
    expect(result.crossSellDebug).toBeDefined();
    expect(Array.isArray(result.crossSellDebug)).toBe(true);
    expect(result.crossSellDebug!.length).toBeGreaterThan(0);
    expect(result.crossSellDebug![0]).toMatchObject({
      productId: expect.any(String),
      score: expect.any(Number),
      sharedCollections: expect.any(Number),
      sharedTags: expect.any(Number),
      priceDelta: expect.any(Number),
    });
  });
});
