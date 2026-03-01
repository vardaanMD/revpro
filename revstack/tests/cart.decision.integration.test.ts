/**
 * Backend contract tests for POST /cart/decision.
 * Mocks Prisma and Shopify; no real DB or API. DEV_SKIP_PROXY=1 so no signature.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const MAX_PAYLOAD_BYTES = 50_000;

const validCart = {
  items: [
    { id: "1", product_id: "p1", quantity: 2, price: 1500, final_line_price: 3000 },
  ],
  total_price: 3000,
  currency: "USD",
};

const defaultMockConfig = {
  plan: "basic",
  billingStatus: "active" as const,
  baselineAovCents: 10000,
  freeShippingThresholdCents: 5000,
  enableCrossSell: true,
  enableMilestones: false,
  enableCouponTease: false,
  recommendationLimit: 4,
  recommendationStrategy: "COLLECTION_MATCH",
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
      shopConfig: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockImplementation((args: { data: Record<string, unknown> }) =>
          Promise.resolve({ ...args.data, id: "cuid", version: 1 })
        ),
      },
      decisionMetric: {
        create: vi.fn().mockResolvedValue({}),
        deleteMany: noop,
      },
      crossSellEvent: {
        create: vi.fn().mockResolvedValue({}),
        deleteMany: noop,
      },
      webhookEvent: { deleteMany: noop },
      crossSellConversion: { deleteMany: noop },
      productSaleEvent: {
        createMany: noop,
        groupBy: vi.fn().mockResolvedValue([]),
      },
    },
  };
});

vi.mock("~/lib/shop-config.server", () => ({
  getShopConfig: vi.fn(),
}));

vi.mock("~/lib/catalog.server", () => ({
  getCatalogForShop: vi.fn().mockResolvedValue([]),
}));

vi.mock("~/shopify.server", () => ({
  default: {
    unauthenticated: {
      admin: vi.fn().mockResolvedValue({}),
    },
  },
}));

vi.mock("~/lib/redis.server", () => ({
  getRedis: vi.fn(() => {
    throw new Error("Redis not available");
  }),
}));

vi.mock("~/lib/product-metrics.server", () => ({
  getProductSalesCounts30d: vi.fn().mockResolvedValue({}),
}));

// So request reaches config + billing (otherwise getCachedDecisionFromRedis throws when Redis is unavailable)
vi.mock("~/lib/decision-cache.server", () => ({
  getCachedDecision: vi.fn(() => null),
  getCachedDecisionFromRedis: vi.fn().mockResolvedValue(null),
  setMemoryCachedDecision: vi.fn(),
  setCachedDecision: vi.fn().mockResolvedValue(undefined),
  hashCartPayload: vi.fn((_s: string) => "hash"),
  tryLockDecision: vi.fn().mockResolvedValue(true),
  lockRetryDelayMs: () => 10,
}));

/** Normalize action return (Response or DataWithResponseInit) to status + json. */
function normalize(res: unknown): { status: number; json: () => Promise<unknown> } {
  if (res instanceof Response) {
    return {
      status: res.status,
      json: () => res.json(),
    };
  }
  const d = res as { data: unknown; init?: { status?: number } };
  return {
    status: d.init?.status ?? 200,
    json: async () => d.data,
  };
}

describe("cart.decision integration (backend contract)", () => {
  beforeEach(async () => {
    process.env.NODE_ENV = "development";
    process.env.DEV_SKIP_PROXY = "1";
    const { getShopConfig } = await import("~/lib/shop-config.server");
    vi.mocked(getShopConfig).mockResolvedValue(defaultMockConfig as never);
  });

  async function postDecision(shop: string, body: unknown) {
    const { action } = await import("~/routes/cart.decision");
    const url = `https://localhost/cart/decision?shop=${encodeURIComponent(shop)}`;
    const request = new Request(url, {
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

  it("1. valid decision payload returns 200 and response shape", async () => {
    const raw = await postDecision("test.myshopify.com", { cart: validCart });
    const res = normalize(raw);
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json).toHaveProperty("crossSell");
    expect(json).not.toHaveProperty("error");
    expect(json).toHaveProperty("freeShippingRemaining");
    expect(json).toHaveProperty("suppressCheckout");
    expect(json).toHaveProperty("milestones");
    expect(json).toHaveProperty("enableCouponTease");
    expect(json).not.toHaveProperty("ui");
    expect(Array.isArray(json.crossSell)).toBe(true);
    expect(Array.isArray(json.milestones)).toBe(true);
    if (raw instanceof Response) {
      expect(raw.headers.get("X-RateLimit-Limit")).toBeDefined();
      expect(raw.headers.get("X-RateLimit-Remaining")).toBeDefined();
    }
  });

  it("2. invalid payload (malformed cart) returns 400", async () => {
    const raw = await postDecision("test.myshopify.com", {
      cart: { items: "not-an-array", total_price: 0 },
    });
    const res = normalize(raw);
    expect(res.status).toBe(400);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json).toHaveProperty("error");
  });

  it("2b. missing required fields returns 400", async () => {
    const raw = await postDecision("test.myshopify.com", { cart: {} });
    const res = normalize(raw);
    expect(res.status).toBe(400);
  });

  it("3. oversized payload returns 400", async () => {
    const longId = "x".repeat(500);
    const manyItems = Array.from({ length: 100 }, (_, i) => ({
      id: `item-${i}`,
      product_id: longId,
      quantity: 1,
      price: 1000,
      final_line_price: 1000,
    }));
    const raw = await postDecision("test.myshopify.com", {
      cart: {
        items: manyItems,
        total_price: 100000,
        currency: "USD",
      },
    });
    const res = normalize(raw);
    expect(res.status).toBe(400);
    const json = (await res.json()) as Record<string, unknown>;
    expect(String(json.error)).toMatch(/large|payload/i);
  });

  it("4. rate limit exceeded returns 429", async () => {
    const shop = "ratelimit-test.myshopify.com";
    let lastNorm: { status: number; json: () => Promise<unknown> } | null = null;
    for (let i = 0; i < 65; i++) {
      const raw = await postDecision(shop, { cart: validCart });
      lastNorm = normalize(raw);
      if (lastNorm.status === 429) break;
    }
    expect(lastNorm).not.toBeNull();
    expect(lastNorm!.status).toBe(429);
    const json = (await lastNorm!.json()) as Record<string, unknown>;
    expect(String(json.error)).toMatch(/many requests|rate/i);
  });

  it("5. SAFE_DECISION fallback on config failure returns 200 with safe shape", async () => {
    const { getShopConfig } = await import("~/lib/shop-config.server");
    vi.mocked(getShopConfig).mockRejectedValueOnce(new Error("Config unavailable"));
    const raw = await postDecision("safe-fallback.myshopify.com", { cart: validCart });
    const res = normalize(raw);
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.crossSell).toEqual([]);
    expect(json.freeShippingRemaining).toBe(0);
    expect(json.suppressCheckout).toBe(false);
    expect(json.milestones).toEqual([]);
    expect(json.enableCouponTease).toBe(false);
    expect(json).not.toHaveProperty("ui");
  });

  describe("billing gate (unpaid / cancelled → safe fallback, no metric writes)", () => {
    it("6. Unpaid shop (billingStatus inactive) returns safe decision and does not write metrics", async () => {
      const { getShopConfig } = await import("~/lib/shop-config.server");
      const { prisma } = await import("~/lib/prisma.server");
      vi.mocked(getShopConfig).mockResolvedValue({
        ...defaultMockConfig,
        billingStatus: "inactive",
      } as never);
      vi.mocked(prisma.decisionMetric.create).mockClear();
      vi.mocked(prisma.crossSellEvent.create).mockClear();

      const raw = await postDecision("unpaid.myshopify.com", { cart: validCart });
      const res = normalize(raw);
      expect(res.status).toBe(200);
      const json = (await res.json()) as Record<string, unknown>;
      expect(json.crossSell).toEqual([]);
      expect(json.freeShippingRemaining).toBe(0);
      expect(json.suppressCheckout).toBe(false);
      expect(json.milestones).toEqual([]);
      expect(json.enableCouponTease).toBe(false);

      expect(prisma.decisionMetric.create).not.toHaveBeenCalled();
      expect(prisma.crossSellEvent.create).not.toHaveBeenCalled();
    });

    it("7. Canceled subscription (billingStatus cancelled) returns safe fallback and does not write metrics", async () => {
      const { getShopConfig } = await import("~/lib/shop-config.server");
      const { prisma } = await import("~/lib/prisma.server");
      vi.mocked(getShopConfig).mockResolvedValue({
        ...defaultMockConfig,
        billingStatus: "cancelled",
      } as never);
      vi.mocked(prisma.decisionMetric.create).mockClear();
      vi.mocked(prisma.crossSellEvent.create).mockClear();

      const raw = await postDecision("canceled.myshopify.com", { cart: validCart });
      const res = normalize(raw);
      expect(res.status).toBe(200);
      const json = (await res.json()) as Record<string, unknown>;
      expect(json.crossSell).toEqual([]);
      expect(json.freeShippingRemaining).toBe(0);

      expect(prisma.decisionMetric.create).not.toHaveBeenCalled();
      expect(prisma.crossSellEvent.create).not.toHaveBeenCalled();
    });
  });
});
