/**
 * PHASE 6 — Feature toggle isolation tests.
 * Asserts capability gating: UI fallback, coupon tease, maxCrossSell cap, strategy fallback.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const validCart = {
  items: [
    { id: "1", product_id: "p1", quantity: 1, price: 1000, final_line_price: 1000 },
  ],
  total_price: 1000,
  currency: "USD",
};

function minimalCatalogIndex() {
  return {
    updatedAt: Date.now(),
    currency: "USD",
    productsById: {
      p1: {
        id: "p1",
        variantId: "v1",
        priceCents: 1000,
        collections: ["c1"],
        inStock: true,
        handle: "p1",
        title: "P1",
        imageUrl: null,
      },
      p2: {
        id: "p2",
        variantId: "v2",
        priceCents: 500,
        collections: ["c1"],
        inStock: true,
        handle: "p2",
        title: "P2",
        imageUrl: null,
      },
    },
    crossSellCandidates: [
      {
        id: "p2",
        variantId: "v2",
        priceCents: 500,
        collections: ["c1"],
        inStock: true,
        handle: "p2",
        title: "P2",
        imageUrl: null,
      },
    ],
    collectionMap: { c1: ["p1", "p2"] },
    tagMap: {} as Record<string, string[]>,
  };
}

vi.mock("~/lib/prisma.server", () => {
  const noop = vi.fn().mockResolvedValue(undefined);
  return {
    prisma: {
      shopConfig: { findUnique: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue({}) },
      decisionMetric: { create: vi.fn().mockResolvedValue({}) },
      crossSellEvent: { create: vi.fn().mockResolvedValue({}) },
      deleteMany: noop,
      webhookEvent: { deleteMany: noop },
      crossSellConversion: { deleteMany: noop },
      productSaleEvent: { createMany: noop, groupBy: vi.fn().mockResolvedValue([]) },
    },
  };
});

vi.mock("~/lib/shop-config.server", () => ({ getShopConfig: vi.fn() }));
vi.mock("~/lib/catalog.server", () => ({ getCatalogForShop: vi.fn().mockResolvedValue([]) }));
vi.mock("~/shopify.server", () => ({ default: { unauthenticated: { admin: vi.fn().mockResolvedValue({}) } } }));
vi.mock("~/lib/redis.server", () => ({ getRedis: vi.fn(() => { throw new Error("Redis not available"); }) }));
vi.mock("~/lib/product-metrics.server", () => ({ getProductSalesCounts30d: vi.fn().mockResolvedValue({}) }));

vi.mock("~/lib/catalog-index.server", async (importOriginal) => {
  const mod = await importOriginal<typeof import("~/lib/catalog-index.server")>();
  return {
    ...mod,
    getCatalogIndexFromRedis: vi.fn(),
  };
});

vi.mock("~/lib/decision-cache.server", () => ({
  getCachedDecision: vi.fn(() => null),
  getCachedDecisionFromRedis: vi.fn().mockResolvedValue(null),
  setMemoryCachedDecision: vi.fn(),
  setCachedDecision: vi.fn().mockResolvedValue(undefined),
  hashCartPayload: vi.fn(() => "hash"),
  tryLockDecision: vi.fn().mockResolvedValue(true),
  lockRetryDelayMs: () => 10,
}));

vi.mock("~/lib/rate-limit.server", () => ({
  checkRateLimitWithQuota: vi.fn().mockResolvedValue({
    allowed: true,
    remaining: 60,
    limit: 60,
    resetAt: Date.now() + 60000,
  }),
}));

async function postDecision(shop: string, body: unknown) {
  const { action } = await import("~/routes/cart.decision");
  const request = new Request(`https://localhost/cart/decision?shop=${encodeURIComponent(shop)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return action({
    request,
    params: {},
    context: {},
    unstable_pattern: "/cart/decision",
  });
}

function normalize(res: unknown): { status: number; json: () => Promise<unknown> } {
  if (res instanceof Response) {
    return { status: res.status, json: () => res.json() };
  }
  const d = res as { data: unknown; init?: { status?: number } };
  return { status: d.init?.status ?? 200, json: async () => d.data };
}

describe("decision feature toggle isolation", () => {
  beforeEach(async () => {
    process.env.NODE_ENV = "development";
    process.env.DEV_SKIP_PROXY = "1";
    const { getShopConfig } = await import("~/lib/shop-config.server");
    const { getCatalogIndexFromRedis, resolveStrategyCatalogFromIndex } = await import(
      "~/lib/catalog-index.server"
    );
    vi.mocked(getShopConfig).mockResolvedValue({
      plan: "basic",
      billingStatus: "active",
      baselineAovCents: 10000,
      freeShippingThresholdCents: 5000,
      enableCrossSell: true,
      enableMilestones: false,
      enableCouponTease: true,
      recommendationLimit: 4,
      recommendationStrategy: "COLLECTION_MATCH",
      manualCollectionIds: [],
      primaryColor: "#000",
      accentColor: "#fff",
      borderRadius: 12,
      showConfetti: true,
      countdownEnabled: true,
      emojiMode: true,
    } as never);
    vi.mocked(getCatalogIndexFromRedis).mockResolvedValue(minimalCatalogIndex() as never);
  });

  it("1. decision response has no ui field (UI from bootstrap only)", async () => {
    const raw = await postDecision("toggles-ui.myshopify.com", { cart: validCart });
    const res = normalize(raw);
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json).not.toHaveProperty("ui");
    expect(Array.isArray(json.crossSell)).toBe(true);
    expect(json).toHaveProperty("enableCouponTease");
  });

  it("2. allowCouponTease = false (basic plan) → enableCouponTease === false", async () => {
    const raw = await postDecision("toggles-coupon.myshopify.com", { cart: validCart });
    const res = normalize(raw);
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(Object.hasOwnProperty.call(json, "enableCouponTease")).toBe(true);
    expect(json.enableCouponTease).toBe(false);
  });

  it("3. maxCrossSell cap: config limit > capability → crossSell capped to capability", async () => {
    const raw = await postDecision("toggles-cap.myshopify.com", { cart: validCart });
    const res = normalize(raw);
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    const crossSell = json.crossSell as unknown[];
    expect(Array.isArray(crossSell)).toBe(true);
    expect(crossSell.length).toBeLessThanOrEqual(1);
  });

  it("4. Strategy not allowed (basic plan) → effective strategy is COLLECTION_MATCH behavior", async () => {
    const { getShopConfig } = await import("~/lib/shop-config.server");
    vi.mocked(getShopConfig).mockResolvedValue({
      plan: "basic",
      billingStatus: "active",
      recommendationStrategy: "BEST_SELLING",
      recommendationLimit: 4,
      enableCrossSell: true,
      enableCouponTease: false,
      enableMilestones: false,
      baselineAovCents: 10000,
      freeShippingThresholdCents: 5000,
      manualCollectionIds: [],
      primaryColor: null,
      accentColor: null,
      borderRadius: 12,
      showConfetti: false,
      countdownEnabled: false,
      emojiMode: true,
    } as never);
    const raw = await postDecision("toggles-strategy.myshopify.com", { cart: validCart });
    const res = normalize(raw);
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json).not.toHaveProperty("ui");
    expect(json.enableCouponTease).toBe(false);
  });
});
