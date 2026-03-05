/**
 * Analytics math validation: cart performance and engagement (impressions, clicks, CTR).
 * Order Impact removed; engagement from CrossSellEvent.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { getAnalyticsMetrics, parseAnalyticsRange } from "~/lib/analytics.server";
import { getDashboardMetrics } from "~/lib/dashboard-metrics.server";
import { resolveCapabilities, type Plan } from "~/lib/capabilities.server";
import { prisma } from "~/lib/prisma.server";

const TEST_SHOP = "analytics-math-test.myshopify.com";

function defaultRange() {
  return parseAnalyticsRange(new URL("http://x/?range=30d"));
}

vi.mock("~/lib/prisma.server", () => ({
  prisma: {
    $queryRaw: vi.fn(),
    decisionMetric: { count: vi.fn().mockResolvedValue(1) },
  },
}));

function emptyDayRow() {
  return [] as { day: Date; total: bigint; shown: bigint; sum_cart: bigint; adds: bigint }[];
}

function emptyEngagement() {
  return [{ impressions: 0n, clicks: 0n }];
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

  it("analytics returns cartPerformance and engagement", async () => {
    const summaryRow = {
      total: 100n,
      shown: 50n,
      avg_cart: 110,
      count_all: 100n,
      added: 0n,
      sum_cart_with: 6000n,
    };
    vi.mocked(prisma.$queryRaw)
      .mockResolvedValueOnce(emptyDayRow())
      .mockResolvedValueOnce([summaryRow])
      .mockResolvedValueOnce(emptyEngagement())
      .mockResolvedValueOnce([{ revenue: 0n }]);
    const data = await getAnalyticsMetrics(TEST_SHOP, resolveCapabilities("growth" as Plan), { range: defaultRange() });

    expect(data.range).toBeDefined();
    expect(data.cartPerformance).toBeDefined();
    expect(data.cartPerformance.summary.totalDecisions).toBe(100);
    expect(data.cartPerformance.trend).toBeDefined();
    expect(data.engagement).toBeDefined();
    expect(data.engagement.impressions).toBe(0);
    expect(data.engagement.clicks).toBe(0);
    expect(data.engagement.ctr).toBe(0);
    expect(data.engagement.conversionRate).toBeDefined();
  });

  it("engagement CTR = clicks / impressions when impressions > 0", async () => {
    const summaryRow = {
      total: 100n,
      shown: 50n,
      avg_cart: 100,
      count_all: 100n,
      added: 0n,
      sum_cart_with: 5000n,
    };
    vi.mocked(prisma.$queryRaw)
      .mockResolvedValueOnce(emptyDayRow())
      .mockResolvedValueOnce([summaryRow])
      .mockResolvedValueOnce([{ impressions: 100n, clicks: 15n }])
      .mockResolvedValueOnce([{ revenue: 0n }]);
    const data = await getAnalyticsMetrics(TEST_SHOP, resolveCapabilities("basic" as Plan), { range: defaultRange() });

    expect(data.engagement.impressions).toBe(100);
    expect(data.engagement.clicks).toBe(15);
    expect(data.engagement.ctr).toBe(0.15);
  });

  it("adds per recommendation session — addRate 1.5", async () => {
    const summaryRow = {
      total: 100n,
      shown: 50n,
      avg_cart: 100,
      count_all: 100n,
      added: 75n,
      sum_cart_with: 5000n,
    };
    vi.mocked(prisma.$queryRaw)
      .mockResolvedValueOnce(emptyDayRow())
      .mockResolvedValueOnce([summaryRow])
      .mockResolvedValueOnce(emptyEngagement())
      .mockResolvedValueOnce([{ revenue: 0n }]);
    const data = await getAnalyticsMetrics(TEST_SHOP, resolveCapabilities("advanced" as Plan), { range: defaultRange() });

    expect(data.cartPerformance.summary.addRate).toBe(1.5);
  });

  it("dashboard returns cartPerformance and engagement", async () => {
    vi.mocked(prisma.$queryRaw)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(emptyDashboardAgg())
      .mockResolvedValueOnce([{ impressions: 50n, clicks: 5n }])
      .mockResolvedValueOnce([{ revenue: 0n }]);
    const data = await getDashboardMetrics(TEST_SHOP, resolveCapabilities("growth" as Plan));

    expect(data.cartPerformance).toBeDefined();
    expect(data.engagement).toBeDefined();
    expect(data.engagement.impressions7d).toBe(50);
    expect(data.engagement.clicks7d).toBe(5);
    expect(data.engagement.ctr7d).toBe(0.1);
    expect(data.engagement.conversionRate7d).toBeDefined();
  });

  it("dashboard engagement CTR 0 when no impressions", async () => {
    vi.mocked(prisma.$queryRaw)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(emptyDashboardAgg())
      .mockResolvedValueOnce(emptyEngagement())
      .mockResolvedValueOnce([{ revenue: 0n }]);
    const data = await getDashboardMetrics(TEST_SHOP, resolveCapabilities("basic" as Plan));

    expect(data.engagement.ctr7d).toBe(0);
  });

  it("analytics always includes revenue", async () => {
    vi.mocked(prisma.$queryRaw)
      .mockResolvedValueOnce(emptyDayRow())
      .mockResolvedValueOnce([{ total: 10n, shown: 5n, avg_cart: 100, count_all: 10n, added: 0n, sum_cart_with: 1000n }])
      .mockResolvedValueOnce(emptyEngagement())
      .mockResolvedValueOnce([{ revenue: 50000n }]);
    const data = await getAnalyticsMetrics(TEST_SHOP, resolveCapabilities("basic" as Plan), { range: defaultRange() });
    expect(data.revenue).toBeDefined();
    expect(data.revenue.revenueCents).toBe(50000);
  });
});





