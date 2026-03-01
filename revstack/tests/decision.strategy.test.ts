/**
 * PHASE 6 — Strategy behavior matrix tests.
 * Controlled catalog + cart fixtures; validate each strategy mode.
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

describe("decision strategy behavior matrix", () => {
  const storeMetrics = buildStoreMetrics();

  describe("COLLECTION_MATCH", () => {
    it("returns only products that share a collection with the cart", () => {
      const catalog: Product[] = [
        product({ id: "p1", collections: ["c1"] }),
        product({ id: "p2", collections: ["c1"] }),
        product({ id: "p3", collections: ["c2"] }),
      ];
      const cart = buildCart([
        { id: "line-1", productId: "p1", quantity: 1, unitPrice: createMoney(50, "USD") },
      ]);
      const result = decideCartActions({
        cart,
        catalog,
        storeMetrics,
        strategy: "COLLECTION_MATCH",
      });
      const ids = new Set(result.crossSell.map((p) => p.id));
      expect(ids.has("p3")).toBe(false);
      result.crossSell.forEach((p) => {
        expect(p.collections.some((c) => c === "c1")).toBe(true);
      });
    });
  });

  describe("TAG_MATCH", () => {
    it("returns only products that share a tag with the cart", () => {
      const catalog: Product[] = [
        product({ id: "p1", collections: ["c1"], tags: ["t1"] }),
        product({ id: "p2", collections: ["c1"], tags: ["t1"] }),
        product({ id: "p3", collections: ["c1"], tags: ["t2"] }),
      ];
      const cart = buildCart([
        { id: "line-1", productId: "p1", quantity: 1, unitPrice: createMoney(50, "USD") },
      ]);
      const result = decideCartActions({
        cart,
        catalog,
        storeMetrics,
        strategy: "TAG_MATCH",
      });
      const ids = new Set(result.crossSell.map((p) => p.id));
      expect(ids.has("p3")).toBe(false);
      result.crossSell.forEach((p) => {
        expect((p.tags ?? []).some((t) => t === "t1")).toBe(true);
      });
    });

    it("returns empty when no product shares a tag with cart", () => {
      const catalog: Product[] = [
        product({ id: "p1", collections: ["c1"], tags: ["t1"] }),
        product({ id: "p2", collections: ["c1"], tags: ["t2"] }),
      ];
      const cart = buildCart([
        { id: "line-1", productId: "p1", quantity: 1, unitPrice: createMoney(50, "USD") },
      ]);
      const result = decideCartActions({
        cart,
        catalog,
        storeMetrics,
        strategy: "TAG_MATCH",
      });
      expect(result.crossSell).toEqual([]);
    });

    it("degrades to COLLECTION_MATCH when cart has no tags", () => {
      const catalog: Product[] = [
        product({ id: "p1", collections: ["c1"] }),
        product({ id: "p2", collections: ["c1"] }),
      ];
      const cart = buildCart([
        { id: "line-1", productId: "p1", quantity: 1, unitPrice: createMoney(50, "USD") },
      ]);
      const result = decideCartActions({
        cart,
        catalog,
        storeMetrics,
        strategy: "TAG_MATCH",
      });
      expect(result.crossSell.length).toBeGreaterThan(0);
      result.crossSell.forEach((p) => {
        expect(p.collections.some((c) => c === "c1")).toBe(true);
      });
    });
  });

  describe("MANUAL_COLLECTION", () => {
    it("returns products even when no cart overlap (no overlap → still returns manual products)", () => {
      const catalog: Product[] = [
        product({ id: "p1", collections: ["c1"] }),
        product({ id: "p2", collections: ["c2"] }),
        product({ id: "p3", collections: ["c2"] }),
      ];
      const cart = buildCart([
        { id: "line-1", productId: "p1", quantity: 1, unitPrice: createMoney(50, "USD") },
      ]);
      const result = decideCartActions({
        cart,
        catalog,
        storeMetrics,
        strategy: "MANUAL_COLLECTION",
      });
      expect(result.crossSell.length).toBeGreaterThan(0);
    });

    it("when overlap exists, overlapping products ranked first", () => {
      const catalog: Product[] = [
        product({ id: "p1", collections: ["c1"] }),
        product({ id: "p2", collections: ["c1"] }),
        product({ id: "p3", collections: ["c2"] }),
      ];
      const cart = buildCart([
        { id: "line-1", productId: "p1", quantity: 1, unitPrice: createMoney(50, "USD") },
      ]);
      const result = decideCartActions({
        cart,
        catalog,
        storeMetrics,
        strategy: "MANUAL_COLLECTION",
      });
      const ids = result.crossSell.map((p) => p.id);
      const p2Index = ids.indexOf("p2");
      const p3Index = ids.indexOf("p3");
      if (p2Index >= 0 && p3Index >= 0) {
        expect(p2Index).toBeLessThan(p3Index);
      }
    });
  });

  describe("BEST_SELLING", () => {
    it("orders by salesCount primary, score tiebreaker", () => {
      const catalog: Product[] = [
        product({ id: "p1", collections: ["c1"] }),
        product({ id: "p2", collections: ["c1"], salesCount: 10 }),
        product({ id: "p3", collections: ["c1"], salesCount: 5 }),
        product({ id: "p4", collections: ["c1"], salesCount: 20 }),
      ];
      const cart = buildCart([
        { id: "line-1", productId: "p1", quantity: 1, unitPrice: createMoney(50, "USD") },
      ]);
      const result = decideCartActions({
        cart,
        catalog,
        storeMetrics,
        strategy: "BEST_SELLING",
      });
      const ids = result.crossSell.map((p) => p.id);
      const p4Index = ids.indexOf("p4");
      const p2Index = ids.indexOf("p2");
      const p3Index = ids.indexOf("p3");
      expect(p4Index).toBeGreaterThanOrEqual(0);
      expect(p2Index).toBeGreaterThanOrEqual(0);
      expect(p3Index).toBeGreaterThanOrEqual(0);
      if (p4Index >= 0 && p2Index >= 0) expect(p4Index).toBeLessThan(p2Index);
      if (p2Index >= 0 && p3Index >= 0) expect(p2Index).toBeLessThan(p3Index);
    });
  });

  describe("NEW_ARRIVALS", () => {
    it("orders by createdAt descending primary, score tiebreaker", () => {
      const catalog: Product[] = [
        product({ id: "p1", collections: ["c1"] }),
        product({ id: "p2", collections: ["c1"], createdAt: "2024-01-01" }),
        product({ id: "p3", collections: ["c1"], createdAt: "2024-06-01" }),
        product({ id: "p4", collections: ["c1"], createdAt: "2024-03-01" }),
      ];
      const cart = buildCart([
        { id: "line-1", productId: "p1", quantity: 1, unitPrice: createMoney(50, "USD") },
      ]);
      const result = decideCartActions({
        cart,
        catalog,
        storeMetrics,
        strategy: "NEW_ARRIVALS",
      });
      const ids = result.crossSell.map((p) => p.id);
      const p3Index = ids.indexOf("p3");
      const p4Index = ids.indexOf("p4");
      const p2Index = ids.indexOf("p2");
      expect(p3Index).toBeGreaterThanOrEqual(0);
      expect(p4Index).toBeGreaterThanOrEqual(0);
      expect(p2Index).toBeGreaterThanOrEqual(0);
      if (p3Index >= 0 && p4Index >= 0) expect(p3Index).toBeLessThan(p4Index);
      if (p4Index >= 0 && p2Index >= 0) expect(p4Index).toBeLessThan(p2Index);
    });
  });
});
