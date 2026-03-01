/**
 * PHASE 6 — Decision engine determinism tests.
 * Proves same input → same output; no timing or randomness.
 */
import { describe, it, expect } from "vitest";
import {
  decideCartActions,
  createMoney,
  type CartSnapshot,
  type Product,
  type StoreMetrics,
} from "@revpro/decision-engine";

function buildCart(items: CartSnapshot["items"]): CartSnapshot {
  return { id: "cart-1", items };
}

function buildStoreMetrics(currency = "USD"): StoreMetrics {
  return {
    currency,
    freeShippingThreshold: null,
    baselineAOV: createMoney(100, currency),
  };
}

function product(overrides: Partial<Product> & { id: string }): Product {
  return {
    id: overrides.id,
    variantId: `v-${overrides.id}`,
    title: "Product",
    price: createMoney(100, "USD"),
    inStock: true,
    collections: overrides.collections ?? ["c1"],
    ...overrides,
  };
}

describe("decision engine determinism", () => {
  const catalog: Product[] = [
    product({ id: "p1", collections: ["c1"] }),
    product({ id: "p2", collections: ["c1"] }),
    product({ id: "p3", collections: ["c1"] }),
  ];
  const cart = buildCart([
    { id: "line-1", productId: "p1", quantity: 1, unitPrice: createMoney(50, "USD") },
  ]);
  const storeMetrics = buildStoreMetrics();

  it("1. same cart payload sent 10 times produces identical responses (deep equality)", () => {
    const runs = Array.from({ length: 10 }, () =>
      decideCartActions({ cart, catalog, storeMetrics, strategy: "COLLECTION_MATCH" })
    );
    const first = runs[0];
    for (let i = 1; i < runs.length; i++) {
      expect(runs[i].crossSell).toEqual(first.crossSell);
      expect(runs[i].freeShippingRemaining).toBe(first.freeShippingRemaining);
      expect(runs[i].suppressCheckout).toBe(first.suppressCheckout);
      expect(runs[i].decisionLog.length).toBe(first.decisionLog.length);
    }
  });

  it("2. same cart payload sent 10 times produces identical crossSell ordering", () => {
    const orderings = Array.from({ length: 10 }, () =>
      decideCartActions({ cart, catalog, storeMetrics, strategy: "COLLECTION_MATCH" }).crossSell.map((p) => p.id)
    );
    const first = orderings[0];
    for (let i = 1; i < orderings.length; i++) {
      expect(orderings[i]).toEqual(first);
    }
  });

  it("3. same catalog and cart, different invocation order, produces identical ranking", () => {
    const result1 = decideCartActions({ cart, catalog, storeMetrics, strategy: "COLLECTION_MATCH" });
    const result2 = decideCartActions({ cart, catalog, storeMetrics, strategy: "COLLECTION_MATCH" });
    expect(result1.crossSell.map((p) => p.id)).toEqual(result2.crossSell.map((p) => p.id));
  });

  it("4. two products with identical score are sorted by product.id ascending", () => {
    const sameScoreCatalog: Product[] = [
      product({ id: "p1", collections: ["c1"] }),
      product({ id: "pA", collections: ["c1"] }),
      product({ id: "pB", collections: ["c1"] }),
    ];
    const result = decideCartActions({
      cart,
      catalog: sameScoreCatalog,
      storeMetrics,
      strategy: "COLLECTION_MATCH",
    });
    const ids = result.crossSell.map((p) => p.id);
    const sorted = [...ids].sort((a, b) => a.localeCompare(b));
    expect(ids).toEqual(sorted);
  });

  it("5. BEST_SELLING density guard: uniform salesCounts apply collection-overlap eligibility", () => {
    const uniformSales: Product[] = [
      product({ id: "p1", collections: ["c1"] }),
      product({ id: "p2", collections: ["c1"], salesCount: 1 }),
      product({ id: "p3", collections: ["c1"], salesCount: 1 }),
      product({ id: "p4", collections: ["c2"], salesCount: 1 }),
    ];
    const result = decideCartActions({
      cart,
      catalog: uniformSales,
      storeMetrics,
      strategy: "BEST_SELLING",
    });
    const ids = new Set(result.crossSell.map((p) => p.id));
    expect(ids.has("p4")).toBe(false);
    result.crossSell.forEach((p) => {
      expect((p.collections ?? []).some((c) => c === "c1")).toBe(true);
    });
  });

  it("6. TAG_MATCH with no cart tags degrades to collection-overlap eligibility", () => {
    const result = decideCartActions({
      cart,
      catalog,
      storeMetrics,
      strategy: "TAG_MATCH",
    });
    expect(result.crossSell.length).toBeGreaterThan(0);
    result.crossSell.forEach((p) => {
      expect((p.collections ?? []).some((c) => c === "c1")).toBe(true);
    });
  });

  it("7. performance safety: catalog size 200 resolves under 50ms", () => {
    const largeCatalog: Product[] = Array.from({ length: 200 }, (_, i) =>
      product({ id: `prod-${i}`, collections: ["c1"] })
    );
    const start = performance.now();
    decideCartActions({
      cart,
      catalog: largeCatalog,
      storeMetrics,
      strategy: "COLLECTION_MATCH",
    });
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(50);
  });
});
