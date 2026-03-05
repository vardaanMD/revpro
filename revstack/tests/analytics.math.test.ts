/**
 * Analytics math validation: cart performance and engagement (impressions, clicks, CTR).
 * Order Impact removed; engagement from CrossSellEvent.
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
    const thirtyRow = {
      total: 100n,
      shown: 50n,
      avg_cart: 110,
      count_all: 100n,
      added: 0n,
      sum_cart_with: 6000n,
    };
    const prevThirtyRow = [{ ...thirtyRow, total: 20n, shown: 10n, added: 0n }];
    const prevSevenRow = [{ total: 10n, shown: 5n, added: 0n }];
    vi.mocked(prisma.$queryRaw)
      .mockResolvedValueOnce(emptyDayRow())
      .mockResolvedValueOnce([thirtyRow])
      .mockResolvedValueOnce(emptyEngagement())
      .mockResolvedValueOnce(prevThirtyRow)
      .mockResolvedValueOnce(prevSevenRow);
    const data = await getAnalyticsMetrics(TEST_SHOP, resolveCapabilities("growth" as Plan));

    expect(data.cartPerformance).toBeDefined();
    expect(data.cartPerformance.thirtyDaySummary.totalDecisions).toBe(100);
    expect(data.engagement).toBeDefined();
    expect(data.engagement.impressions30d).toBe(0);
    expect(data.engagement.clicks30d).toBe(0);
    expect(data.engagement.ctr30d).toBe(0);
  });

  it("engagement CTR = clicks / impressions when impressions > 0", async () => {
    const thirtyRow = {
      total: 100n,
      shown: 50n,
      avg_cart: 100,
      count_all: 100n,
      added: 0n,
      sum_cart_with: 5000n,
    };
    vi.mocked(prisma.$queryRaw)
      .mockResolvedValueOnce(emptyDayRow())
      .mockResolvedValueOnce([thirtyRow])
      .mockResolvedValueOnce([{ impressions: 100n, clicks: 15n }]);
    const data = await getAnalyticsMetrics(TEST_SHOP, resolveCapabilities("basic" as Plan));

    expect(data.engagement.impressions30d).toBe(100);
    expect(data.engagement.clicks30d).toBe(15);
    expect(data.engagement.ctr30d).toBe(0.15);
  });

  it("adds per recommendation session — addRate 1.5", async () => {
    const thirtyRow = {
      total: 100n,
      shown: 50n,
      avg_cart: 100,
      count_all: 100n,
      added: 75n,
      sum_cart_with: 5000n,
    };
    const prevThirtyRow = [{ ...thirtyRow, total: 50n, shown: 25n, added: 0n }];
    const prevSevenRow = [{ total: 20n, shown: 10n, added: 0n }];
    vi.mocked(prisma.$queryRaw)
      .mockResolvedValueOnce(emptyDayRow())
      .mockResolvedValueOnce([thirtyRow])
      .mockResolvedValueOnce(emptyEngagement())
      .mockResolvedValueOnce(prevThirtyRow)
      .mockResolvedValueOnce(prevSevenRow);
    const data = await getAnalyticsMetrics(TEST_SHOP, resolveCapabilities("advanced" as Plan));

    expect(data.cartPerformance.thirtyDaySummary.addRate).toBe(1.5);
  });

  it("dashboard returns cartPerformance and engagement", async () => {
    vi.mocked(prisma.$queryRaw)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(emptyDashboardAgg())
      .mockResolvedValueOnce([{ impressions: 50n, clicks: 5n }]);
    const data = await getDashboardMetrics(TEST_SHOP, resolveCapabilities("growth" as Plan));

    expect(data.cartPerformance).toBeDefined();
    expect(data.engagement).toBeDefined();
    expect(data.engagement.impressions7d).toBe(50);
    expect(data.engagement.clicks7d).toBe(5);
    expect(data.engagement.ctr7d).toBe(0.1);
  });

  it("dashboard engagement CTR 0 when no impressions", async () => {
    vi.mocked(prisma.$queryRaw)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(emptyDashboardAgg())
      .mockResolvedValueOnce(emptyEngagement());
    const data = await getDashboardMetrics(TEST_SHOP, resolveCapabilities("basic" as Plan));

    expect(data.engagement.ctr7d).toBe(0);
  });
});
