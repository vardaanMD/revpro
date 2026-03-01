/**
 * PHASE 6 — Cold start test.
 * No sales data, no tags, minimal metadata; assert no crash, no unexpected empty output,
 * BEST_SELLING density guard fallback, TAG_MATCH degrade.
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
    collections: overrides.collections ?? [],
    ...overrides,
  };
}

describe("decision cold start", () => {
  const storeMetrics = buildStoreMetrics();

  it("does not crash with no sales data, no tags, minimal metadata", () => {
    const catalog: Product[] = [
      product({ id: "p1", collections: ["c1"], tags: undefined, salesCount: undefined, createdAt: undefined }),
      product({ id: "p2", collections: ["c1"], tags: undefined, salesCount: undefined, createdAt: undefined }),
    ];
    const cart = buildCart([
      { id: "line-1", productId: "p1", quantity: 1, unitPrice: createMoney(50, "USD") },
    ]);
    expect(() => {
      decideCartActions({ cart, catalog, storeMetrics, strategy: "COLLECTION_MATCH" });
    }).not.toThrow();
    const result = decideCartActions({ cart, catalog, storeMetrics, strategy: "COLLECTION_MATCH" });
    expect(result.crossSell).toBeDefined();
    expect(Array.isArray(result.crossSell)).toBe(true);
    expect(result.decisionLog).toBeDefined();
    expect(Array.isArray(result.decisionLog)).toBe(true);
  });

  it("does not produce unexpected empty output when catalog has eligible products", () => {
    const catalog: Product[] = [
      product({ id: "p1", collections: ["c1"] }),
      product({ id: "p2", collections: ["c1"] }),
    ];
    const cart = buildCart([
      { id: "line-1", productId: "p1", quantity: 1, unitPrice: createMoney(50, "USD") },
    ]);
    const result = decideCartActions({ cart, catalog, storeMetrics, strategy: "COLLECTION_MATCH" });
    expect(result.crossSell.length).toBeGreaterThan(0);
  });

  it("BEST_SELLING density guard fallback works when no sales data (uniform zero)", () => {
    const catalog: Product[] = [
      product({ id: "p1", collections: ["c1"] }),
      product({ id: "p2", collections: ["c1"], salesCount: 0 }),
      product({ id: "p3", collections: ["c2"], salesCount: 0 }),
    ];
    const cart = buildCart([
      { id: "line-1", productId: "p1", quantity: 1, unitPrice: createMoney(50, "USD") },
    ]);
    const result = decideCartActions({ cart, catalog, storeMetrics, strategy: "BEST_SELLING" });
    expect(result.crossSell).toBeDefined();
    expect(Array.isArray(result.crossSell)).toBe(true);
    const ids = new Set(result.crossSell.map((p) => p.id));
    expect(ids.has("p3")).toBe(false);
    result.crossSell.forEach((p) => {
      expect((p.collections ?? []).some((c) => c === "c1")).toBe(true);
    });
  });

  it("TAG_MATCH degrade works when no cart tags (uses collection overlap)", () => {
    const catalog: Product[] = [
      product({ id: "p1", collections: ["c1"] }),
      product({ id: "p2", collections: ["c1"] }),
    ];
    const cart = buildCart([
      { id: "line-1", productId: "p1", quantity: 1, unitPrice: createMoney(50, "USD") },
    ]);
    const result = decideCartActions({ cart, catalog, storeMetrics, strategy: "TAG_MATCH" });
    expect(result.crossSell).toBeDefined();
    expect(result.crossSell.length).toBeGreaterThan(0);
    result.crossSell.forEach((p) => {
      expect((p.collections ?? []).some((c) => c === "c1")).toBe(true);
    });
  });

  it("empty cart returns empty crossSell without crashing", () => {
    const catalog: Product[] = [product({ id: "p1", collections: ["c1"] })];
    const cart = buildCart([]);
    const result = decideCartActions({ cart, catalog, storeMetrics, strategy: "COLLECTION_MATCH" });
    expect(result.crossSell).toEqual([]);
    expect(result.decisionLog.length).toBeGreaterThan(0);
  });
});
