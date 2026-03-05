/**
 * Response shape by plan: cartPerformance and engagement always present.
 * Order Impact removed.
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

function emptyEngagement() {
  return [{ impressions: 0n, clicks: 0n }];
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

describe("analytics gating (response shape by plan)", () => {
  beforeEach(() => {
    vi.mocked(prisma.$queryRaw).mockReset();
    vi.mocked(prisma.decisionMetric.count).mockResolvedValue(1);
  });

  function mockDashboardCalls() {
    vi.mocked(prisma.$queryRaw)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(emptyDashboardAggRow())
      .mockResolvedValueOnce(emptyEngagement());
  }

  function mockAnalyticsBasic() {
    vi.mocked(prisma.$queryRaw)
      .mockResolvedValueOnce(emptyDayRow())
      .mockResolvedValueOnce(emptyThirtyBase())
      .mockResolvedValueOnce(emptyEngagement());
  }

  function mockAnalyticsAdvanced() {
    vi.mocked(prisma.$queryRaw)
      .mockResolvedValueOnce(emptyDayRow())
      .mockResolvedValueOnce(emptyThirtyBase())
      .mockResolvedValueOnce(emptyEngagement())
      .mockResolvedValueOnce([{ ...emptyThirtyBase()[0], total: 0n, shown: 0n, added: 0n }])
      .mockResolvedValueOnce([{ total: 0n, shown: 0n, added: 0n }]);
  }

  describe("BASIC plan", () => {
    const capabilities = resolveCapabilities("basic" as Plan);

    it("dashboard has cartPerformance and engagement", async () => {
      mockDashboardCalls();
      const data = await getDashboardMetrics(TEST_SHOP, capabilities);

      expect(data.cartPerformance).toBeDefined();
      expect(data.cartPerformance.todayDecisions).toBeDefined();
      expect(data.cartPerformance.last7DaysTrend).toBeDefined();
      expect(data.engagement).toBeDefined();
      expect(data.engagement.impressions7d).toBe(0);
      expect(data.engagement.clicks7d).toBe(0);
    });

    it("analytics has cartPerformance and engagement, no comparison", async () => {
      mockAnalyticsBasic();
      const data = await getAnalyticsMetrics(TEST_SHOP, capabilities);

      expect(data.cartPerformance).toBeDefined();
      expect(data.cartPerformance.sevenDayTrend).toBeDefined();
      expect(data.cartPerformance.thirtyDaySummary).toBeDefined();
      expect(data.cartPerformance.previousSevenDaySummary).toBeUndefined();
      expect(data.cartPerformance.previousThirtyDaySummary).toBeUndefined();
      expect(data.engagement).toBeDefined();
    });
  });

  describe("ADVANCED plan", () => {
    const capabilities = resolveCapabilities("advanced" as Plan);

    it("dashboard has cartPerformance and engagement", async () => {
      mockDashboardCalls();
      const data = await getDashboardMetrics(TEST_SHOP, capabilities);

      expect(data.cartPerformance).toBeDefined();
      expect(data.engagement).toBeDefined();
    });

    it("analytics has cartPerformance with comparison and engagement", async () => {
      mockAnalyticsAdvanced();
      const data = await getAnalyticsMetrics(TEST_SHOP, capabilities);

      expect(data.cartPerformance.previousSevenDaySummary).toBeDefined();
      expect(data.cartPerformance.previousThirtyDaySummary).toBeDefined();
      expect(data.engagement).toBeDefined();
    });
  });

  describe("GROWTH plan", () => {
    const capabilities = resolveCapabilities("growth" as Plan);

    it("dashboard has cartPerformance and engagement", async () => {
      mockDashboardCalls();
      const data = await getDashboardMetrics(TEST_SHOP, capabilities);

      expect(data.cartPerformance).toBeDefined();
      expect(data.engagement).toBeDefined();
    });

    it("analytics has cartPerformance and engagement", async () => {
      mockAnalyticsAdvanced();
      const data = await getAnalyticsMetrics(TEST_SHOP, capabilities);

      expect(data.cartPerformance).toBeDefined();
      expect(data.engagement).toBeDefined();
    });
  });
});
