/**
 * Response shape tests by plan. Asserts cartPerformance always present; orderImpact only when capability + threshold.
 * BASIC: no orderImpact. ADVANCED: comparison in cartPerformance, no orderImpact. GROWTH: orderImpact when threshold met.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { getDashboardMetrics } from "~/lib/dashboard-metrics.server";
import { getAnalyticsMetrics } from "~/lib/analytics.server";
import { resolveCapabilities, type Plan } from "~/lib/capabilities.server";
import { prisma } from "~/lib/prisma.server";

const TEST_SHOP = "gating-test.myshopify.com";

vi.mock("~/lib/prisma.server", () => ({
  prisma: {
    $queryRaw: vi.fn(),
    decisionMetric: { count: vi.fn().mockResolvedValue(1) },
  },
}));

function emptyDashboardAggRow() {
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

function orderInfluence7dValid() {
  return [{ avg_with: 120, count_with: 30n, avg_without: 100, count_without: 30n }];
}

function emptyDayRow() {
  return [] as { day: Date; total: bigint; shown: bigint; sum_cart: bigint; adds: bigint }[];
}

function emptyThirtyBase() {
  return [
    {
      total: 0n,
      shown: 0n,
      avg_cart: null as number | null,
      count_all: 0n,
      added: 0n,
      sum_cart_with: 0n,
    },
  ];
}

function orderInfluence7dValidAnalytics() {
  return [{ avg_with: 120, count_with: 30n, avg_without: 100, count_without: 30n }];
}

describe("analytics gating (response shape by plan)", () => {
  beforeEach(() => {
    vi.mocked(prisma.$queryRaw).mockReset();
    vi.mocked(prisma.decisionMetric.count).mockResolvedValue(1);
  });

  function mockDashboardCalls(includeOrderImpact: boolean) {
    vi.mocked(prisma.$queryRaw).mockResolvedValueOnce([]);
    vi.mocked(prisma.$queryRaw).mockResolvedValueOnce(emptyDashboardAggRow());
    if (includeOrderImpact) {
      vi.mocked(prisma.$queryRaw).mockResolvedValueOnce(orderInfluence7dValid());
    }
  }

  function mockAnalyticsBasic() {
    vi.mocked(prisma.$queryRaw)
      .mockResolvedValueOnce(emptyDayRow())
      .mockResolvedValueOnce(emptyThirtyBase());
  }

  function mockAnalyticsAdvanced() {
    vi.mocked(prisma.$queryRaw)
      .mockResolvedValueOnce(emptyDayRow())
      .mockResolvedValueOnce(emptyThirtyBase())
      .mockResolvedValueOnce([{ ...emptyThirtyBase()[0], total: 0n, shown: 0n, added: 0n }])
      .mockResolvedValueOnce([{ total: 0n, shown: 0n, added: 0n }]);
  }

  function mockAnalyticsGrowth(withOrderImpact: boolean) {
    vi.mocked(prisma.$queryRaw)
      .mockResolvedValueOnce(emptyDayRow())
      .mockResolvedValueOnce(emptyThirtyBase())
      .mockResolvedValueOnce(
        withOrderImpact
          ? orderInfluence7dValidAnalytics()
          : [{ avg_with: 120, count_with: 10n, avg_without: 100, count_without: 10n }]
      )
      .mockResolvedValueOnce([{ ...emptyThirtyBase()[0], total: 0n, shown: 0n, added: 0n }])
      .mockResolvedValueOnce([{ total: 0n, shown: 0n, added: 0n }]);
  }

  describe("BASIC plan", () => {
    const capabilities = resolveCapabilities("basic" as Plan);

    it("dashboard has cartPerformance, no orderImpact", async () => {
      mockDashboardCalls(false);
      const data = await getDashboardMetrics(TEST_SHOP, capabilities);

      expect(data.cartPerformance).toBeDefined();
      expect(data.cartPerformance.todayDecisions).toBeDefined();
      expect(data.cartPerformance.last7DaysTrend).toBeDefined();
      expect(data.orderImpact).toBeUndefined();
    });

    it("analytics has cartPerformance only, no comparison or orderImpact", async () => {
      mockAnalyticsBasic();
      const data = await getAnalyticsMetrics(TEST_SHOP, capabilities);

      expect(data.cartPerformance).toBeDefined();
      expect(data.cartPerformance.sevenDayTrend).toBeDefined();
      expect(data.cartPerformance.thirtyDaySummary).toBeDefined();
      expect(data.cartPerformance.previousSevenDaySummary).toBeUndefined();
      expect(data.cartPerformance.previousThirtyDaySummary).toBeUndefined();
      expect(data.orderImpact).toBeUndefined();
    });
  });

  describe("ADVANCED plan", () => {
    const capabilities = resolveCapabilities("advanced" as Plan);

    it("dashboard has cartPerformance, no orderImpact", async () => {
      mockDashboardCalls(false);
      const data = await getDashboardMetrics(TEST_SHOP, capabilities);

      expect(data.cartPerformance).toBeDefined();
      expect(data.orderImpact).toBeUndefined();
    });

    it("analytics has cartPerformance with comparison, no orderImpact", async () => {
      mockAnalyticsAdvanced();
      const data = await getAnalyticsMetrics(TEST_SHOP, capabilities);

      expect(data.cartPerformance.previousSevenDaySummary).toBeDefined();
      expect(data.cartPerformance.previousThirtyDaySummary).toBeDefined();
      expect(data.orderImpact).toBeUndefined();
    });
  });

  describe("GROWTH plan", () => {
    const capabilities = resolveCapabilities("growth" as Plan);

    it("dashboard has orderImpact stage full when both >= 30", async () => {
      mockDashboardCalls(true);
      const data = await getDashboardMetrics(TEST_SHOP, capabilities);

      expect(data.cartPerformance).toBeDefined();
      expect(data.orderImpact).toBeDefined();
      expect(data.orderImpact!.stage).toBe("full");
      expect(data.orderImpact!.liftPercent).toBeDefined();
      expect(data.orderImpact!.influencedOrders).toBe(30);
    });

    it("analytics has orderImpact stage full when both >= 30", async () => {
      mockAnalyticsGrowth(true);
      const data = await getAnalyticsMetrics(TEST_SHOP, capabilities);

      expect(data.cartPerformance.previousSevenDaySummary).toBeDefined();
      expect(data.orderImpact).toBeDefined();
      expect(data.orderImpact!.stage).toBe("full");
      expect(data.orderImpact!.liftPercent).toBe(20);
      expect(data.orderImpact!.influencedOrders).toBe(30);
    });
  });
});
