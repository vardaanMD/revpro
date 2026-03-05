import { prisma } from "~/lib/prisma.server";
import type { Capabilities } from "~/lib/capabilities.server";
import { normalizeShopDomain } from "~/lib/shop-domain.server";
import { logWarn, logResilience } from "~/lib/logger.server";

/** Recursively freeze an object so it cannot be mutated (future-proof against cross-request leakage). */
function deepFreeze<T>(obj: T): T {
  if (obj === null || typeof obj !== "object") return obj;
  Object.freeze(obj);
  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) deepFreeze(obj[i]);
  } else {
    for (const key of Object.keys(obj)) {
      deepFreeze((obj as Record<string, unknown>)[key]);
    }
  }
  return obj;
}

/** Cart Performance: behavioral only (7-day). */
export type CartPerformance = {
  todayDecisions: number;
  crossSellShowRate: number;
  crossSellAddRate: number;
  avgCartValue: number;
  /** Sum of cart value at decision time (last 7 days). Not revenue. */
  cartValueAtEvaluation: number;
  last7DaysTrend: {
    date: string;
    decisions: number;
  }[];
};

/** Engagement: recommendation impressions, clicks, CTR from CrossSellEvent (7-day). */
export type EngagementMetrics = {
  impressions7d: number;
  clicks7d: number;
  ctr7d: number;
};

export type DashboardMetrics = {
  cartPerformance: CartPerformance;
  engagement: EngagementMetrics;
};

/** Zeroed metrics when DB has no data for shop or on error. */
function zeroedDashboardMetrics(): DashboardMetrics {
  const sevenDayStart = (() => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - 6);
    d.setUTCHours(0, 0, 0, 0);
    return d;
  })();
  const last7DaysTrend: { date: string; decisions: number }[] = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(sevenDayStart);
    d.setUTCDate(d.getUTCDate() + i);
    last7DaysTrend.push({
      date: d.toISOString().slice(0, 10),
      decisions: 0,
    });
  }
  return deepFreeze({
    cartPerformance: {
      todayDecisions: 0,
      crossSellShowRate: 0,
      crossSellAddRate: 0,
      avgCartValue: 0,
      cartValueAtEvaluation: 0,
      last7DaysTrend,
    },
    engagement: {
      impressions7d: 0,
      clicks7d: 0,
      ctr7d: 0,
    },
  });
}

/** No-op for dev flush: in-memory dashboard cache removed. */
export function clearDashboardMetricsCache(_shop?: string): void {}

function twentyFourHoursAgo(): Date {
  return new Date(Date.now() - 24 * 60 * 60 * 1000);
}

function startOfDayUtc(daysAgo: number): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - daysAgo);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

function toDateKey(date: Date): string {
  return date instanceof Date
    ? date.toISOString().slice(0, 10)
    : String(date).slice(0, 10);
}

/**
 * Dashboard metrics for /app home. All aggregations server-side, scoped to shop.
 * No in-memory cache. DB truth gate: if DecisionMetric count for shop is zero, return zeroed metrics. Fail-safe: on error return zeroed metrics.
 */
export async function getDashboardMetrics(
  shop: string,
  capabilities: Capabilities
): Promise<DashboardMetrics> {
  const normalized = normalizeShopDomain(shop);
  try {
    const total = await prisma.decisionMetric.count({
      where: { shopDomain: normalized },
    });
    if (total === 0) {
      return zeroedDashboardMetrics();
    }
  } catch (err) {
    logResilience({
      shop: normalized,
      route: "dashboard-metrics",
      message: "Dashboard DB truth check failed; returning zeroed metrics",
      meta: {
        errorType: err instanceof Error ? err.name : "Unknown",
        fallbackUsed: true,
      },
    });
    return zeroedDashboardMetrics();
  }
  try {
    return await getDashboardMetricsUncached(normalized, capabilities);
  } catch (err) {
    logResilience({
      shop: normalized,
      route: "dashboard-metrics",
      message: "Dashboard computation failed; returning zeroed metrics",
      meta: {
        errorType: err instanceof Error ? err.name : "Unknown",
        fallbackUsed: true,
      },
    });
    return zeroedDashboardMetrics();
  }
}

type AggRowBase = {
  today_count: bigint;
  total_7d: bigint;
  shown_7d: bigint;
  avg_cart: number | null;
  count_7d: bigint;
  added_7d: bigint;
  sum_cart_with: bigint;
};

async function getDashboardMetricsUncached(
  shop: string,
  capabilities: Capabilities
): Promise<DashboardMetrics> {
  const since24h = twentyFourHoursAgo();
  const sevenDayStart = startOfDayUtc(6);

  type DayRow = { day: Date; total: bigint };
  type EngagementRow = { impressions: bigint; clicks: bigint };

  const [decisionRows, aggRows, engagementRow] = await Promise.all([
    prisma.$queryRaw<DayRow[]>`
      SELECT DATE_TRUNC('day', "createdAt")::date AS day, COUNT(*)::bigint AS total
      FROM "DecisionMetric"
      WHERE "shopDomain" = ${shop} AND "createdAt" >= ${sevenDayStart}
      GROUP BY DATE_TRUNC('day', "createdAt")
      ORDER BY day ASC
    `,
    prisma.$queryRaw<AggRowBase[]>`
      WITH dm AS (
        SELECT
          COUNT(*) FILTER (WHERE "createdAt" >= ${since24h})::bigint AS today_count,
          COUNT(*) FILTER (WHERE "createdAt" >= ${sevenDayStart})::bigint AS total_7d,
          COUNT(*) FILTER (WHERE "hasCrossSell" = true AND "createdAt" >= ${sevenDayStart})::bigint AS shown_7d,
          AVG("cartValue") FILTER (WHERE "createdAt" >= ${sevenDayStart}) AS avg_cart,
          COUNT(*) FILTER (WHERE "createdAt" >= ${sevenDayStart})::bigint AS count_7d,
          COALESCE(SUM("cartValue") FILTER (WHERE "hasCrossSell" = true AND "createdAt" >= ${sevenDayStart}), 0)::bigint AS sum_cart_with
        FROM "DecisionMetric"
        WHERE "shopDomain" = ${shop}
      ),
      conv AS (
        SELECT COUNT(*)::bigint AS added_7d
        FROM "CrossSellConversion"
        WHERE "shopDomain" = ${shop} AND "createdAt" >= ${sevenDayStart}
      )
      SELECT dm.today_count, dm.total_7d, dm.shown_7d, dm.avg_cart, dm.count_7d, conv.added_7d, dm.sum_cart_with
      FROM dm, conv
    `,
    prisma.$queryRaw<EngagementRow[]>`
      SELECT
        COUNT(*) FILTER (WHERE "eventType" = 'impression')::bigint AS impressions,
        COUNT(*) FILTER (WHERE "eventType" = 'click')::bigint AS clicks
      FROM "CrossSellEvent"
      WHERE "shopDomain" = ${shop} AND "createdAt" >= ${sevenDayStart}
    `,
  ]);

  const a = aggRows[0];
  const todayCount = a ? Number(a.today_count) : 0;
  const total7d = a ? Number(a.total_7d) : 0;
  const shown7d = a ? Number(a.shown_7d) : 0;
  const added7d = a ? Number(a.added_7d) : 0;

  const crossSellShowRate =
    total7d > 0 ? Math.round((shown7d / total7d) * 100) / 100 : 0;
  const crossSellAddRate =
    shown7d > 0 ? Math.round((added7d / shown7d) * 100) / 100 : 0;
  const avgCartValue =
    a && a.count_7d > 0n && a.avg_cart != null
      ? Math.round(a.avg_cart)
      : 0;

  const cartValueAtEvaluation = a && a.sum_cart_with != null ? Number(a.sum_cart_with) : 0;

  const decisionsByDay = new Map<string, number>();
  for (const r of decisionRows) {
    decisionsByDay.set(toDateKey(r.day), Number(r.total));
  }

  const last7DaysTrend: { date: string; decisions: number }[] = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(sevenDayStart);
    d.setUTCDate(d.getUTCDate() + i);
    const dateStr = toDateKey(d);
    last7DaysTrend.push({
      date: dateStr,
      decisions: decisionsByDay.get(dateStr) ?? 0,
    });
  }

  const cartPerformance: CartPerformance = {
    todayDecisions: todayCount,
    crossSellShowRate,
    crossSellAddRate,
    avgCartValue,
    cartValueAtEvaluation,
    last7DaysTrend,
  };

  const eng = engagementRow[0];
  const impressions7d = eng ? Number(eng.impressions) : 0;
  const clicks7d = eng ? Number(eng.clicks) : 0;
  const engagement: EngagementMetrics = {
    impressions7d,
    clicks7d,
    ctr7d: impressions7d > 0 ? clicks7d / impressions7d : 0,
  };

  return { cartPerformance, engagement };
}
