/**
 * PHASE 6 — Analytics math validation.
 * Mock database layer; seed controlled rows; assert AOV, revenue difference, adds-per-session.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { getAnalyticsMetrics } from "~/lib/analytics.server";
import { getDashboardMetrics } from "~/lib/dashboard-metrics.server";
import { resolveCapabilities, type Plan } from "~/lib/capabilities.server";
import { prisma } from "~/lib/prisma.server";

const TEST_SHOP = "analytics-math-test.myshopify.com";

vi.mock("~/lib/prisma.server", () => ({
  prisma: {
    $queryRaw: vi.fn(),
    decisionMetric: { count: vi.fn().mockResolvedValue(1) },
  },
}));

function emptyDayRow() {
  return [] as { day: Date; total: bigint; shown: bigint; sum_cart: bigint; adds: bigint }[];
}

function emptyDashboardAgg() {
  return [
    {
      today_count: 0n,
      total_7d: 0n,
      shown_7d: 0n,
      avg_cart: null as number | null,
      count_7d: 0n,
      added_7d: 0n,
      sum_cart_with: 0n,
    },
  ];
}

describe("analytics math validation", () => {
  beforeEach(() => {
    vi.mocked(prisma.$queryRaw).mockReset();
    vi.mocked(prisma.decisionMetric.count).mockResolvedValue(1);
  });

  it("Case 1: orderImpact exists when both counts >= 30; lift 20%", async () => {
    const shop = `${TEST_SHOP}-case1`;
    const thirtyRow = {
      total: 100n,
      shown: 50n,
      avg_cart: 110,
      count_all: 100n,
      added: 0n,
      sum_cart_with: 6000n,
    };
    const orderInfluence7d = [
      { avg_with: 120, count_with: 50n, avg_without: 100, count_without: 50n },
    ];
    const prevThirtyRow = [{ ...thirtyRow, total: 20n, shown: 10n, added: 0n }];
    const prevSevenRow = [{ total: 10n, shown: 5n, added: 0n }];
    vi.mocked(prisma.$queryRaw)
      .mockResolvedValueOnce(emptyDayRow())
      .mockResolvedValueOnce([thirtyRow])
      .mockResolvedValueOnce(orderInfluence7d)
      .mockResolvedValueOnce(prevThirtyRow)
      .mockResolvedValueOnce(prevSevenRow);
    const capabilities = resolveCapabilities("growth" as Plan);
    const data = await getAnalyticsMetrics(shop, capabilities);

    expect(data.orderImpact).toBeDefined();
    expect(data.orderImpact!.stage).toBe("full");
    expect(data.orderImpact!.liftPercent).toBe(20);
    expect(data.orderImpact!.avgWith).toBe(120);
    expect(data.orderImpact!.avgWithout).toBe(100);
    expect(data.orderImpact!.influencedOrders).toBe(50);
  });

  it("count_with = 29 → no orderImpact", async () => {
    const shop = `${TEST_SHOP}-c29`;
    const thirtyRow = {
      total: 100n,
      shown: 50n,
      avg_cart: 110,
      count_all: 100n,
      added: 0n,
      sum_cart_with: 6000n,
    };
    const orderInfluence7d = [
      { avg_with: 120, count_with: 29n, avg_without: 100, count_without: 50n },
    ];
    const prevThirtyRow = [{ ...thirtyRow, total: 20n, shown: 10n, added: 0n }];
    const prevSevenRow = [{ total: 10n, shown: 5n, added: 0n }];
    vi.mocked(prisma.$queryRaw)
      .mockResolvedValueOnce(emptyDayRow())
      .mockResolvedValueOnce([thirtyRow])
      .mockResolvedValueOnce(orderInfluence7d)
      .mockResolvedValueOnce(prevThirtyRow)
      .mockResolvedValueOnce(prevSevenRow);
    const data = await getAnalyticsMetrics(shop, resolveCapabilities("growth" as Plan));
    expect(data.orderImpact).toBeUndefined();
  });

  it("count_with = 30, count_without = 0 → no orderImpact", async () => {
    const shop = `${TEST_SHOP}-c30w0`;
    const thirtyRow = {
      total: 100n,
      shown: 50n,
      avg_cart: 110,
      count_all: 100n,
      added: 0n,
      sum_cart_with: 6000n,
    };
    const orderInfluence7d = [
      { avg_with: 120, count_with: 30n, avg_without: null as number | null, count_without: 0n },
    ];
    const prevThirtyRow = [{ ...thirtyRow, total: 20n, shown: 10n, added: 0n }];
    const prevSevenRow = [{ total: 10n, shown: 5n, added: 0n }];
    vi.mocked(prisma.$queryRaw)
      .mockResolvedValueOnce(emptyDayRow())
      .mockResolvedValueOnce([thirtyRow])
      .mockResolvedValueOnce(orderInfluence7d)
      .mockResolvedValueOnce(prevThirtyRow)
      .mockResolvedValueOnce(prevSevenRow);
    const data = await getAnalyticsMetrics(shop, resolveCapabilities("growth" as Plan));
    expect(data.orderImpact).toBeUndefined();
  });

  it("count_with = 30, count_without = 1 → orderImpact stage early, no liftPercent", async () => {
    const shop = `${TEST_SHOP}-early1`;
    const thirtyRow = {
      total: 100n,
      shown: 50n,
      avg_cart: 110,
      count_all: 100n,
      added: 0n,
      sum_cart_with: 6000n,
    };
    const orderInfluence7d = [
      { avg_with: 120, count_with: 30n, avg_without: 100, count_without: 1n },
    ];
    const prevThirtyRow = [{ ...thirtyRow, total: 20n, shown: 10n, added: 0n }];
    const prevSevenRow = [{ total: 10n, shown: 5n, added: 0n }];
    vi.mocked(prisma.$queryRaw)
      .mockResolvedValueOnce(emptyDayRow())
      .mockResolvedValueOnce([thirtyRow])
      .mockResolvedValueOnce(orderInfluence7d)
      .mockResolvedValueOnce(prevThirtyRow)
      .mockResolvedValueOnce(prevSevenRow);
    const data = await getAnalyticsMetrics(shop, resolveCapabilities("growth" as Plan));
    expect(data.orderImpact).toBeDefined();
    expect(data.orderImpact!.stage).toBe("early");
    expect(Object.hasOwnProperty.call(data.orderImpact!, "liftPercent")).toBe(false);
    expect(data.orderImpact!.avgWith).toBe(120);
    expect(data.orderImpact!.avgWithout).toBe(100);
    expect(data.orderImpact!.influencedOrders).toBe(30);
  });

  it("count_with = 30, count_without = 29 → stage early", async () => {
    const shop = `${TEST_SHOP}-early29`;
    const thirtyRow = {
      total: 100n,
      shown: 50n,
      avg_cart: 110,
      count_all: 100n,
      added: 0n,
      sum_cart_with: 6000n,
    };
    const orderInfluence7d = [
      { avg_with: 120, count_with: 30n, avg_without: 100, count_without: 29n },
    ];
    const prevThirtyRow = [{ ...thirtyRow, total: 20n, shown: 10n, added: 0n }];
    const prevSevenRow = [{ total: 10n, shown: 5n, added: 0n }];
    vi.mocked(prisma.$queryRaw)
      .mockResolvedValueOnce(emptyDayRow())
      .mockResolvedValueOnce([thirtyRow])
      .mockResolvedValueOnce(orderInfluence7d)
      .mockResolvedValueOnce(prevThirtyRow)
      .mockResolvedValueOnce(prevSevenRow);
    const data = await getAnalyticsMetrics(shop, resolveCapabilities("growth" as Plan));
    expect(data.orderImpact).toBeDefined();
    expect(data.orderImpact!.stage).toBe("early");
    expect(Object.hasOwnProperty.call(data.orderImpact!, "liftPercent")).toBe(false);
  });

  it("Case 2: orderImpact undefined when count_with < 30", async () => {
    const shop = `${TEST_SHOP}-case2`;
    const thirtyRow = {
      total: 20n,
      shown: 10n,
      avg_cart: 105,
      count_all: 20n,
      added: 0n,
      sum_cart_with: 1200n,
    };
    const orderInfluence7d = [
      { avg_with: 120, count_with: 10n, avg_without: 100, count_without: 10n },
    ];
    const prevThirtyRow = [{ ...thirtyRow, total: 20n, shown: 10n, added: 0n }];
    const prevSevenRow = [{ total: 10n, shown: 5n, added: 0n }];
    vi.mocked(prisma.$queryRaw)
      .mockResolvedValueOnce(emptyDayRow())
      .mockResolvedValueOnce([thirtyRow])
      .mockResolvedValueOnce(orderInfluence7d)
      .mockResolvedValueOnce(prevThirtyRow)
      .mockResolvedValueOnce(prevSevenRow);
    const capabilities = resolveCapabilities("growth" as Plan);
    const data = await getAnalyticsMetrics(shop, capabilities);

    expect(data.orderImpact).toBeUndefined();
  });

  it("Case 3: Adds per recommendation session — addRate 1.5", async () => {
    const shop = `${TEST_SHOP}-case3`;
    const thirtyRow = {
      total: 100n,
      shown: 50n,
      avg_cart: 100,
      count_all: 100n,
      added: 75n,
      sum_cart_with: 5000n,
    };
    const orderInfluence7d = [
      { avg_with: null as number | null, count_with: 0n, avg_without: null as number | null, count_without: 0n },
    ];
    const prevThirtyRow = [{ ...thirtyRow, total: 50n, shown: 25n, added: 0n }];
    const prevSevenRow = [{ total: 20n, shown: 10n, added: 0n }];
    vi.mocked(prisma.$queryRaw)
      .mockResolvedValueOnce(emptyDayRow())
      .mockResolvedValueOnce([thirtyRow])
      .mockResolvedValueOnce(orderInfluence7d)
      .mockResolvedValueOnce(prevThirtyRow)
      .mockResolvedValueOnce(prevSevenRow);
    const capabilities = resolveCapabilities("growth" as Plan);
    const data = await getAnalyticsMetrics(shop, capabilities);

    expect(data.cartPerformance.thirtyDaySummary.addRate).toBe(1.5);
  });

  it("orderImpact omitted when avg_without_7d === 0", async () => {
    const shop = `${TEST_SHOP}-avg0`;
    const thirtyRow = {
      total: 100n,
      shown: 50n,
      avg_cart: 100,
      count_all: 100n,
      added: 0n,
      sum_cart_with: 5000n,
    };
    const orderInfluence7d = [
      { avg_with: 120, count_with: 30n, avg_without: 0, count_without: 30n },
    ];
    const prevThirtyRow = [{ ...thirtyRow, total: 50n, shown: 25n, added: 0n }];
    const prevSevenRow = [{ total: 20n, shown: 10n, added: 0n }];
    vi.mocked(prisma.$queryRaw)
      .mockResolvedValueOnce(emptyDayRow())
      .mockResolvedValueOnce([thirtyRow])
      .mockResolvedValueOnce(orderInfluence7d)
      .mockResolvedValueOnce(prevThirtyRow)
      .mockResolvedValueOnce(prevSevenRow);
    const data = await getAnalyticsMetrics(shop, resolveCapabilities("growth" as Plan));
    expect(data.orderImpact).toBeUndefined();
  });

  it("lift_raw > 100 → lift_display === 100", async () => {
    const shop = `${TEST_SHOP}-cap100`;
    const thirtyRow = {
      total: 100n,
      shown: 50n,
      avg_cart: 100,
      count_all: 100n,
      added: 0n,
      sum_cart_with: 5000n,
    };
    const orderInfluence7d = [
      { avg_with: 250, count_with: 30n, avg_without: 100, count_without: 30n },
    ];
    const prevThirtyRow = [{ ...thirtyRow }];
    const prevSevenRow = [{ total: 20n, shown: 10n, added: 0n }];
    vi.mocked(prisma.$queryRaw)
      .mockResolvedValueOnce(emptyDayRow())
      .mockResolvedValueOnce([thirtyRow])
      .mockResolvedValueOnce(orderInfluence7d)
      .mockResolvedValueOnce(prevThirtyRow)
      .mockResolvedValueOnce(prevSevenRow);
    const data = await getAnalyticsMetrics(shop, resolveCapabilities("growth" as Plan));
    expect(data.orderImpact).toBeDefined();
    expect(data.orderImpact!.stage).toBe("full");
    expect(data.orderImpact!.liftPercent).toBe(100);
  });

  it("lift_raw < -100 → lift_display === -100", async () => {
    const shop = `${TEST_SHOP}-capNeg100`;
    const thirtyRow = {
      total: 100n,
      shown: 50n,
      avg_cart: 100,
      count_all: 100n,
      added: 0n,
      sum_cart_with: 5000n,
    };
    const orderInfluence7d = [
      { avg_with: 0, count_with: 30n, avg_without: 100, count_without: 30n },
    ];
    const prevThirtyRow = [{ ...thirtyRow }];
    const prevSevenRow = [{ total: 20n, shown: 10n, added: 0n }];
    vi.mocked(prisma.$queryRaw)
      .mockResolvedValueOnce(emptyDayRow())
      .mockResolvedValueOnce([thirtyRow])
      .mockResolvedValueOnce(orderInfluence7d)
      .mockResolvedValueOnce(prevThirtyRow)
      .mockResolvedValueOnce(prevSevenRow);
    const data = await getAnalyticsMetrics(shop, resolveCapabilities("growth" as Plan));
    expect(data.orderImpact).toBeDefined();
    expect(data.orderImpact!.stage).toBe("full");
    expect(data.orderImpact!.liftPercent).toBe(-100);
  });

  it("dashboard: orderImpact undefined when count_with_7d < 30", async () => {
    vi.mocked(prisma.$queryRaw)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(emptyDashboardAgg())
      .mockResolvedValueOnce([
        { avg_with: 120, count_with: 10n, avg_without: 100, count_without: 30n },
      ]);
    const data = await getDashboardMetrics(TEST_SHOP, resolveCapabilities("growth" as Plan));
    expect(data.orderImpact).toBeUndefined();
  });

  it("dashboard: orderImpact undefined when count_without_7d === 0", async () => {
    const shop = `${TEST_SHOP}-dash-w0`;
    vi.mocked(prisma.$queryRaw)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(emptyDashboardAgg())
      .mockResolvedValueOnce([
        { avg_with: 120, count_with: 30n, avg_without: null as number | null, count_without: 0n },
      ]);
    const data = await getDashboardMetrics(shop, resolveCapabilities("growth" as Plan));
    expect(data.orderImpact).toBeUndefined();
  });

  it("dashboard: orderImpact stage early when count_without_7d = 10", async () => {
    const shop = `${TEST_SHOP}-dash-early`;
    vi.mocked(prisma.$queryRaw)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(emptyDashboardAgg())
      .mockResolvedValueOnce([
        { avg_with: 120, count_with: 30n, avg_without: 100, count_without: 10n },
      ]);
    const data = await getDashboardMetrics(shop, resolveCapabilities("growth" as Plan));
    expect(data.orderImpact).toBeDefined();
    expect(data.orderImpact!.stage).toBe("early");
    expect(Object.hasOwnProperty.call(data.orderImpact!, "liftPercent")).toBe(false);
    expect(data.orderImpact!.influencedOrders).toBe(30);
  });

  it("dashboard: orderImpact exists when both >= 30", async () => {
    const shop = `${TEST_SHOP}-dash-ok`;
    vi.mocked(prisma.$queryRaw)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(emptyDashboardAgg())
      .mockResolvedValueOnce([
        { avg_with: 120, count_with: 30n, avg_without: 100, count_without: 30n },
      ]);
    const data = await getDashboardMetrics(shop, resolveCapabilities("growth" as Plan));
    expect(data.orderImpact).toBeDefined();
    expect(data.orderImpact!.stage).toBe("full");
    expect(data.orderImpact!.liftPercent).toBe(20);
    expect(data.orderImpact!.influencedOrders).toBe(30);
  });
});
