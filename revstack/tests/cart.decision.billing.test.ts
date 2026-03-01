/**
 * Billing transition tests for POST /cart/decision.
 * Test 1: Paid shop → real decision, metrics written.
 * Test 2 & 3: Covered in cart.decision.integration.test (unpaid / cancelled).
 * Test 4: Dev whitelist → billingStatus inactive but isEntitled true, decision runs.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const validCart = {
  items: [
    { id: "1", product_id: "p1", quantity: 2, price: 1500, final_line_price: 3000 },
  ],
  total_price: 3000,
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
        priceCents: 1500,
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

const paidConfig = {
  plan: "growth" as const,
  billingStatus: "active" as const,
  baselineAovCents: 10000,
  freeShippingThresholdCents: 5000,
  enableCrossSell: true,
  enableMilestones: false,
  enableCouponTease: true,
  recommendationLimit: 4,
  recommendationStrategy: "COLLECTION_MATCH" as const,
  manualCollectionIds: [] as string[],
  primaryColor: null,
  accentColor: null,
  borderRadius: 12,
  showConfetti: true,
  countdownEnabled: true,
  emojiMode: true,
};

vi.mock("~/lib/prisma.server", () => {
  const noop = vi.fn().mockResolvedValue(undefined);
  return {
    prisma: {
      shopConfig: { findUnique: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue({}) },
      decisionMetric: { create: vi.fn().mockResolvedValue({}), deleteMany: noop },
      crossSellEvent: { create: vi.fn().mockResolvedValue({}), deleteMany: noop },
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
  return { ...mod, getCatalogIndexFromRedis: vi.fn() };
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

function normalize(res: unknown): { status: number; json: () => Promise<unknown> } {
  if (res instanceof Response) {
    return { status: res.status, json: () => res.json() };
  }
  const d = res as { data: unknown; init?: { status?: number } };
  return { status: d.init?.status ?? 200, json: async () => d.data };
}

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

describe("cart.decision billing transition", () => {
  beforeEach(async () => {
    process.env.NODE_ENV = "development";
    process.env.DEV_SKIP_PROXY = "1";
    delete process.env.PAYWALL_WHITELIST;
    const { getShopConfig } = await import("~/lib/shop-config.server");
    const { getCatalogIndexFromRedis } = await import("~/lib/catalog-index.server");
    vi.mocked(getShopConfig).mockResolvedValue(paidConfig as never);
    vi.mocked(getCatalogIndexFromRedis).mockResolvedValue(minimalCatalogIndex() as never);
  });

  it("1. Paid shop (billingStatus active) returns real decision and writes DecisionMetric", async () => {
    const { prisma } = await import("~/lib/prisma.server");
    vi.mocked(prisma.decisionMetric.create).mockClear();
    vi.mocked(prisma.crossSellEvent.create).mockClear();

    const raw = await postDecision("paid.myshopify.com", { cart: validCart });
    const res = normalize(raw);
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json).not.toHaveProperty("error");
    expect(Array.isArray(json.crossSell)).toBe(true);
    expect(json).toHaveProperty("ui");

    expect(prisma.decisionMetric.create).toHaveBeenCalled();
  });

  it("4. Dev whitelist: shop in PAYWALL_WHITELIST with billingStatus inactive is entitled, decision runs", async () => {
    process.env.PAYWALL_WHITELIST = "whitelist-dev.myshopify.com";
    const { getShopConfig } = await import("~/lib/shop-config.server");
    vi.mocked(getShopConfig).mockResolvedValue({
      ...paidConfig,
      billingStatus: "inactive",
    } as never);

    const { prisma } = await import("~/lib/prisma.server");
    vi.mocked(prisma.decisionMetric.create).mockClear();

    const raw = await postDecision("whitelist-dev.myshopify.com", { cart: validCart });
    const res = normalize(raw);
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json).not.toHaveProperty("error");
    // Whitelisted shop is entitled; we proceed to catalog and decision
    expect(prisma.decisionMetric.create).toHaveBeenCalled();
  });
});
