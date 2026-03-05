import { prisma } from "~/lib/prisma.server";
import type { Capabilities } from "~/lib/capabilities.server";
import { normalizeShopDomain } from "~/lib/shop-domain.server";
import { logWarn, logResilience } from "~/lib/logger.server";

// --- Phase 6.3 analytics metrics (7d trend, 30d summary, period comparison) ---

export type SevenDayTrendPoint = {
  date: string;
  decisions: number;
  showRate: number;
  addRate: number;
  avgCartValue: number;
};

export type PeriodSummary = {
  totalDecisions: number;
  showRate: number;
  addRate: number;
  avgCartValue: number;
};

export type PreviousSevenDaySummary = {
  totalDecisions: number;
  addRate: number;
};

const ORDER_IMPACT_MIN_SAMPLES = 30;

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

/** Cart Performance: behavioral (7d trend, 30d summary, cart revenue at decision). */
export type CartPerformanceAnalytics = {
  sevenDayTrend: SevenDayTrendPoint[];
  thirtyDaySummary: PeriodSummary;
  /** Sum of cartValue at decision time (30-day). */
  cartRevenue: number;
  previousSevenDaySummary?: PreviousSevenDaySummary;
  previousThirtyDaySummary?: PeriodSummary;
};

/** Order Impact: 7-day only, from OrderInfluenceEvent. Two-stage: early (no lift) when count_without < 30, full (with lift) when both >= 30. */
export type OrderImpact = {
  stage: "early" | "full";
  avgWith: number;
  avgWithout: number;
  influencedOrders: number;
  liftPercent?: number;
};

export type AnalyticsMetrics = {
  cartPerformance: CartPerformanceAnalytics;
  orderImpact?: OrderImpact;
};

/** Zeroed metrics when DB has no data for shop or on error. No analytics served from stale memory. */
function zeroedAnalyticsMetrics(): AnalyticsMetrics {
  const sevenDayStart = (() => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - 6);
    d.setUTCHours(0, 0, 0, 0);
    return d;
  })();
  const trend: SevenDayTrendPoint[] = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(sevenDayStart);
    d.setUTCDate(d.getUTCDate() + i);
    trend.push({
      date: d.toISOString().slice(0, 10),
      decisions: 0,
      showRate: 0,
      addRate: 0,
      avgCartValue: 0,
    });
  }
  return deepFreeze({
    cartPerformance: {
      sevenDayTrend: trend,
      thirtyDaySummary: {
        totalDecisions: 0,
        showRate: 0,
        addRate: 0,
        avgCartValue: 0,
      },
      cartRevenue: 0,
    },
  });
}

/** No-op for dev flush: in-memory analytics cache removed. */
export function clearAnalyticsCache(_shop?: string): void {}

function startOfDayUtc(daysAgo: number): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - daysAgo);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

/**
 * Analytics: cartPerformance (7d trend, 30d summary, optional previous period, cart revenue) and optional orderImpact (7d, OrderInfluenceEvent only).
 * Reads from same source V3 runtime writes to: DecisionMetric + CrossSellConversion (cart.analytics.v3.ts). V2 writes via cart.decision + cart.analytics.event.
 * Single pipeline for all runtime versions; use configV3.runtimeVersion in the route only for UI (e.g. badge). No in-memory cache. DB truth gate: if DecisionMetric count for shop is zero, return zeroed metrics. Fail-safe: on Prisma/Redis error return zeroed metrics.
 */
export async function getAnalyticsMetrics(
  shop: string,
  capabilities: Capabilities
): Promise<AnalyticsMetrics> {
  const normalized = normalizeShopDomain(shop);
  try {
    const total = await prisma.decisionMetric.count({
      where: { shopDomain: normalized },
    });
    if (total === 0) {
      return zeroedAnalyticsMetrics();
    }
  } catch (err) {
    logResilience({
      shop: normalized,
      route: "analytics",
      message: "Analytics DB truth check failed; returning zeroed metrics",
      meta: {
        errorType: err instanceof Error ? err.name : "Unknown",
        fallbackUsed: true,
        stack: process.env.NODE_ENV === "development" && err instanceof Error ? err.stack : undefined,
      },
    });
    return zeroedAnalyticsMetrics();
  }
  try {
    return await getAnalyticsMetricsUncached(normalized, capabilities);
  } catch (err) {
    logResilience({
      shop: normalized,
      route: "analytics",
      message: "Analytics computation failed; returning zeroed metrics",
      meta: {
        errorType: err instanceof Error ? err.name : "Unknown",
        fallbackUsed: true,
        stack: process.env.NODE_ENV === "development" && err instanceof Error ? err.stack : undefined,
      },
    });
    return zeroedAnalyticsMetrics();
  }
}

type SummaryRowBase = {
  total: bigint;
  shown: bigint;
  avg_cart: number | null;
  count_all: bigint;
  added: bigint;
  sum_cart_with: bigint;
};

function toDateKey(d: Date): string {
  return d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10);
}

async function getAnalyticsMetricsUncached(
  shop: string,
  capabilities: Capabilities
): Promise<AnalyticsMetrics> {
  const sevenDayStart = startOfDayUtc(6);
  const thirtyDayStart = startOfDayUtc(29);

  if (process.env.NODE_ENV === "development") {
    const distinctShops = await prisma.decisionMetric.findMany({
      where: { shopDomain: shop, createdAt: { gte: sevenDayStart } },
      select: { shopDomain: true },
      distinct: ["shopDomain"],
    });
    console.assert(
      distinctShops.every((s) => s.shopDomain === shop),
      "Cross-tenant contamination detected"
    );
  }

  type DayRow = { day: Date; total: bigint; shown: bigint; sum_cart: bigint; adds: bigint };

  type OrderInfluence7dRow = {
    avg_with: number | null;
    count_with: bigint;
    avg_without: number | null;
    count_without: bigint;
  };

  const [sevenDayRowsWithAdds, thirtyDayRow, orderInfluence7dRows] = await Promise.all([
    prisma.$queryRaw<DayRow[]>`
      WITH dm AS (
        SELECT
          DATE_TRUNC('day', "createdAt")::date AS day,
          COUNT(*)::bigint AS total,
          COUNT(*) FILTER (WHERE "hasCrossSell" = true)::bigint AS shown,
          COALESCE(SUM("cartValue")::bigint, 0) AS sum_cart
        FROM "DecisionMetric"
        WHERE "shopDomain" = ${shop} AND "createdAt" >= ${sevenDayStart}
        GROUP BY DATE_TRUNC('day', "createdAt")
      ),
      conv AS (
        SELECT
          DATE_TRUNC('day', "createdAt")::date AS day,
          COUNT(*)::bigint AS adds
        FROM "CrossSellConversion"
        WHERE "shopDomain" = ${shop} AND "createdAt" >= ${sevenDayStart}
        GROUP BY DATE_TRUNC('day', "createdAt")
      )
      SELECT dm.day, dm.total, dm.shown, dm.sum_cart, COALESCE(conv.adds, 0)::bigint AS adds
      FROM dm
      LEFT JOIN conv ON dm.day = conv.day
      ORDER BY dm.day ASC
    `,
    prisma.$queryRaw<SummaryRowBase[]>`
      WITH dm AS (
        SELECT
          COUNT(*)::bigint AS total,
          COUNT(*) FILTER (WHERE "hasCrossSell" = true)::bigint AS shown,
          AVG("cartValue") FILTER (WHERE "createdAt" >= ${thirtyDayStart}) AS avg_cart,
          COUNT(*) FILTER (WHERE "createdAt" >= ${thirtyDayStart})::bigint AS count_all,
          COALESCE(SUM("cartValue") FILTER (WHERE "hasCrossSell" = true AND "createdAt" >= ${thirtyDayStart}), 0)::bigint AS sum_cart_with
        FROM "DecisionMetric"
        WHERE "shopDomain" = ${shop}
      ),
      conv AS (
        SELECT COUNT(*)::bigint AS added
        FROM "CrossSellConversion"
        WHERE "shopDomain" = ${shop} AND "createdAt" >= ${thirtyDayStart}
      )
      SELECT dm.total, dm.shown, dm.avg_cart, dm.count_all, conv.added, dm.sum_cart_with FROM dm, conv
    `,
    capabilities.allowRevenueDifference
      ? prisma.$queryRaw<OrderInfluence7dRow[]>`
          SELECT
            AVG("orderValue") FILTER (WHERE influenced = true) AS avg_with,
            COUNT(*) FILTER (WHERE influenced = true)::bigint AS count_with,
            AVG("orderValue") FILTER (WHERE influenced = false) AS avg_without,
            COUNT(*) FILTER (WHERE influenced = false)::bigint AS count_without
          FROM "OrderInfluenceEvent"
          WHERE "shopDomain" = ${shop} AND "createdAt" >= ${sevenDayStart}
        `
      : Promise.resolve([] as OrderInfluence7dRow[]),
  ]);

  const s30 = thirtyDayRow[0];
  const total30 = s30 ? Number(s30.total) : 0;
  const shown30 = s30 ? Number(s30.shown) : 0;
  const added30 = s30 ? Number(s30.added) : 0;
  const cartRevenue = s30 && "sum_cart_with" in s30 ? Number(s30.sum_cart_with) : 0;
  const avgCartValue30 =
    s30 && s30.count_all > 0n && s30.avg_cart != null
      ? Math.round(s30.avg_cart)
      : 0;
  const showRate30 = total30 > 0 ? shown30 / total30 : 0;
  const addRate30 = shown30 > 0 ? added30 / shown30 : 0;

  const sevenDayTrend: SevenDayTrendPoint[] = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(sevenDayStart);
    d.setUTCDate(d.getUTCDate() + i);
    const dateStr = toDateKey(d);
    const row = sevenDayRowsWithAdds.find((r) => toDateKey(r.day) === dateStr);
    const total = row ? Number(row.total) : 0;
    const shown = row ? Number(row.shown) : 0;
    const sumCart = row ? Number(row.sum_cart) : 0;
    const adds = row ? Number(row.adds) : 0;
    sevenDayTrend.push({
      date: dateStr,
      decisions: total,
      showRate: total > 0 ? shown / total : 0,
      addRate: shown > 0 ? adds / shown : 0,
      avgCartValue: total > 0 ? Math.round(sumCart / total) : 0,
    });
  }

  const cartPerformance: CartPerformanceAnalytics = {
    sevenDayTrend,
    thirtyDaySummary: {
      totalDecisions: total30,
      showRate: showRate30,
      addRate: addRate30,
      avgCartValue: avgCartValue30,
    },
    cartRevenue,
  };

  let orderImpact: OrderImpact | undefined;
  if (capabilities.allowRevenueDifference) {
    const oi = orderInfluence7dRows[0];
    const count_with_7d = oi ? Number(oi.count_with) : 0;
    const count_without_7d = oi ? Number(oi.count_without) : 0;
    const avg_with_7d = oi && oi.count_with > 0n && oi.avg_with != null ? oi.avg_with : null;
    const avg_without_7d = oi && oi.count_without > 0n && oi.avg_without != null ? oi.avg_without : null;

    const visible =
      count_with_7d >= ORDER_IMPACT_MIN_SAMPLES &&
      count_without_7d >= 1 &&
      avg_without_7d != null &&
      avg_without_7d !== 0;
    if (visible) {
      const avgWith = avg_with_7d ?? 0;
      const avgWithout = avg_without_7d;
      const fullStage = count_without_7d >= ORDER_IMPACT_MIN_SAMPLES;
      const lift_display = fullStage ? Math.min(100, Math.max(-100, ((avgWith - avgWithout) / avgWithout) * 100)) : undefined;
      orderImpact = {
        stage: fullStage ? "full" : "early",
        avgWith: Math.round(avgWith),
        avgWithout: Math.round(avgWithout),
        influencedOrders: count_with_7d,
        ...(lift_display !== undefined && { liftPercent: lift_display }),
      };
    }
  }

  if (capabilities.allowComparison) {
    const previousThirtyStart = startOfDayUtc(59);
    const previousThirtyEnd = startOfDayUtc(29);
    const prevSevenDayStart = startOfDayUtc(13);
    const prevSevenDayEnd = startOfDayUtc(6);
    const [prevThirtyRow, prevSevenRow] = await Promise.all([
      prisma.$queryRaw<SummaryRowBase[]>`
        WITH dm AS (
          SELECT
            COUNT(*) FILTER (WHERE "createdAt" >= ${previousThirtyStart} AND "createdAt" < ${previousThirtyEnd})::bigint AS total,
            COUNT(*) FILTER (WHERE "hasCrossSell" = true AND "createdAt" >= ${previousThirtyStart} AND "createdAt" < ${previousThirtyEnd})::bigint AS shown,
            AVG("cartValue") FILTER (WHERE "createdAt" >= ${previousThirtyStart} AND "createdAt" < ${previousThirtyEnd}) AS avg_cart,
            COUNT(*) FILTER (WHERE "createdAt" >= ${previousThirtyStart} AND "createdAt" < ${previousThirtyEnd})::bigint AS count_all
            FROM "DecisionMetric"
            WHERE "shopDomain" = ${shop}
        ),
        conv AS (
          SELECT COUNT(*)::bigint AS added
          FROM "CrossSellConversion"
          WHERE "shopDomain" = ${shop} AND "createdAt" >= ${previousThirtyStart} AND "createdAt" < ${previousThirtyEnd}
        )
        SELECT dm.total, dm.shown, dm.avg_cart, dm.count_all, conv.added FROM dm, conv
      `,
      prisma.$queryRaw<{ total: bigint; shown: bigint; added: bigint }[]>`
        WITH dm AS (
          SELECT
            COUNT(*) FILTER (WHERE "createdAt" >= ${prevSevenDayStart} AND "createdAt" < ${prevSevenDayEnd})::bigint AS total,
            COUNT(*) FILTER (WHERE "hasCrossSell" = true AND "createdAt" >= ${prevSevenDayStart} AND "createdAt" < ${prevSevenDayEnd})::bigint AS shown
          FROM "DecisionMetric"
          WHERE "shopDomain" = ${shop}
        ),
        conv AS (
          SELECT COUNT(*)::bigint AS added
          FROM "CrossSellConversion"
          WHERE "shopDomain" = ${shop} AND "createdAt" >= ${prevSevenDayStart} AND "createdAt" < ${prevSevenDayEnd}
        )
        SELECT dm.total, dm.shown, conv.added FROM dm, conv
      `,
    ]);
    const p30 = prevThirtyRow[0];
    const p7 = prevSevenRow[0];
    const totalPrev30 = p30 ? Number(p30.total) : 0;
    const shownPrev30 = p30 ? Number(p30.shown) : 0;
    const addedPrev30 = p30 ? Number(p30.added) : 0;
    const totalPrev7 = p7 ? Number(p7.total) : 0;
    const shownPrev7 = p7 ? Number(p7.shown) : 0;
    const addedPrev7 = p7 ? Number(p7.added) : 0;
    const showRatePrev = totalPrev30 > 0 ? shownPrev30 / totalPrev30 : 0;
    const addRatePrev = shownPrev30 > 0 ? addedPrev30 / shownPrev30 : 0;
    const avgCartValuePrev =
      p30 && p30.count_all > 0n && p30.avg_cart != null ? Math.round(p30.avg_cart) : 0;
    const prev7AddRate = shownPrev7 > 0 ? addedPrev7 / shownPrev7 : 0;
    cartPerformance.previousSevenDaySummary = { totalDecisions: totalPrev7, addRate: prev7AddRate };
    cartPerformance.previousThirtyDaySummary = {
      totalDecisions: totalPrev30,
      showRate: showRatePrev,
      addRate: addRatePrev,
      avgCartValue: avgCartValuePrev,
    };
  }

  const result: AnalyticsMetrics = { cartPerformance };
  if (orderImpact != null) {
    result.orderImpact = orderImpact;
  }
  return result;
}

// --- Phase 5.6 aggregation types (per-shop analytics from DecisionMetric + conversions) ---

export interface AnalyticsSummary {
  totalDecisions: number;
  crossSellShowRate: number;
  crossSellAddRate: number;
  avgCartValue: number;
  upliftProxy: number;
}

export interface AnalyticsTimeseriesPoint {
  date: string;
  decisions: number;
  crossSellAdds: number;
}

type Range = "7d" | "30d";

function rangeToDays(range: Range): number {
  return range === "7d" ? 7 : 30;
}

function startDateForRange(range: Range): Date {
  const days = rangeToDays(range);
  const start = new Date();
  start.setUTCDate(start.getUTCDate() - days);
  start.setUTCHours(0, 0, 0, 0);
  return start;
}

/** Safe zero summary when DB fails. */
function zeroedAnalyticsSummary(): AnalyticsSummary {
  return {
    totalDecisions: 0,
    crossSellShowRate: 0,
    crossSellAddRate: 0,
    avgCartValue: 0,
    upliftProxy: 0,
  };
}

/**
 * Aggregation summary for a shop: decisions, cross-sell show/add rates, avg cart value, uplift.
 * Uses DecisionMetric and CrossSellConversion; all aggregations in DB.
 * On Prisma failure returns zeroed summary.
 */
export async function getShopAnalyticsSummary(
  shop: string,
  range: Range
): Promise<AnalyticsSummary> {
  const startDate = startDateForRange(range);
  const normalized = normalizeShopDomain(shop);

  try {
  const [totalResult, shownResult, avgResult, avgWithCrossSell, avgWithoutCrossSell, addedCount] =
    await Promise.all([
      prisma.decisionMetric.count({
        where: { shopDomain: shop, createdAt: { gte: startDate } },
      }),
      prisma.decisionMetric.count({
        where: {
          shopDomain: shop,
          hasCrossSell: true,
          createdAt: { gte: startDate },
        },
      }),
      prisma.decisionMetric.aggregate({
        where: { shopDomain: shop, createdAt: { gte: startDate } },
        _avg: { cartValue: true },
        _count: { id: true },
      }),
      prisma.decisionMetric.aggregate({
        where: {
          shopDomain: shop,
          hasCrossSell: true,
          createdAt: { gte: startDate },
        },
        _avg: { cartValue: true },
        _count: { id: true },
      }),
      prisma.decisionMetric.aggregate({
        where: {
          shopDomain: shop,
          hasCrossSell: false,
          createdAt: { gte: startDate },
        },
        _avg: { cartValue: true },
        _count: { id: true },
      }),
      prisma.crossSellConversion.count({
        where: { shopDomain: shop, createdAt: { gte: startDate } },
      }),
    ]);

  const totalDecisions = totalResult;
  const shown = shownResult;
  const crossSellShowRate =
    totalDecisions > 0 ? shown / totalDecisions : 0;
  const crossSellAddRate =
    shown > 0 ? addedCount / shown : 0;
  const avgCartValue =
    avgResult._count.id > 0 && avgResult._avg.cartValue != null
      ? Math.round(avgResult._avg.cartValue)
      : 0;

  const withAvg =
    avgWithCrossSell._count.id > 0 && avgWithCrossSell._avg.cartValue != null
      ? avgWithCrossSell._avg.cartValue
      : null;
  const withoutAvg =
    avgWithoutCrossSell._count.id > 0 && avgWithoutCrossSell._avg.cartValue != null
      ? avgWithoutCrossSell._avg.cartValue
      : null;
  const upliftProxy =
    withAvg != null && withoutAvg != null
      ? Math.round(withAvg - withoutAvg)
      : 0;

  return {
    totalDecisions,
    crossSellShowRate,
    crossSellAddRate,
    avgCartValue,
    upliftProxy,
  };
  } catch (err) {
    logResilience({
      shop: normalized,
      route: "analytics-summary",
      message: "getShopAnalyticsSummary failed; returning zeroed summary",
      meta: {
        errorType: err instanceof Error ? err.name : "Unknown",
        fallbackUsed: true,
      },
    });
    return zeroedAnalyticsSummary();
  }
}

/**
 * Per-day timeseries: decisions and cross-sell adds. Uses raw SQL for date truncation.
 * On Prisma failure returns empty array.
 */
export async function getShopAnalyticsTimeseries(
  shop: string,
  range: Range
): Promise<AnalyticsTimeseriesPoint[]> {
  const startDate = startDateForRange(range);
  const normalized = normalizeShopDomain(shop);

  try {
  type DecisionRow = { day: Date; decisions: bigint };
  type ConversionRow = { day: Date; cross_sell_adds: bigint };

  const [decisionRows, conversionRows] = await Promise.all([
    prisma.$queryRaw<DecisionRow[]>`
      SELECT DATE_TRUNC('day', "createdAt") AS day, COUNT(id)::bigint AS decisions
      FROM "DecisionMetric"
      WHERE "shopDomain" = ${shop} AND "createdAt" >= ${startDate}
      GROUP BY DATE_TRUNC('day', "createdAt")
      ORDER BY day ASC
    `,
    prisma.$queryRaw<ConversionRow[]>`
      SELECT DATE_TRUNC('day', "createdAt") AS day, COUNT(id)::bigint AS cross_sell_adds
      FROM "CrossSellConversion"
      WHERE "shopDomain" = ${shop} AND "createdAt" >= ${startDate}
      GROUP BY DATE_TRUNC('day', "createdAt")
      ORDER BY day ASC
    `,
  ]);

  const toDateKey = (d: Date): string =>
    d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10);

  const byDay = new Map<string, { decisions: number; crossSellAdds: number }>();
  for (const r of decisionRows) {
    const key = toDateKey(r.day);
    byDay.set(key, { decisions: Number(r.decisions), crossSellAdds: 0 });
  }
  for (const r of conversionRows) {
    const key = toDateKey(r.day);
    const cur = byDay.get(key);
    const adds = Number(r.cross_sell_adds);
    if (cur) {
      cur.crossSellAdds = adds;
    } else {
      byDay.set(key, { decisions: 0, crossSellAdds: adds });
    }
  }

  const sorted = Array.from(byDay.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  return sorted.map(([date, v]) => ({
    date,
    decisions: v.decisions,
    crossSellAdds: v.crossSellAdds,
  }));
  } catch (err) {
    logResilience({
      shop: normalized,
      route: "analytics-timeseries",
      message: "getShopAnalyticsTimeseries failed; returning empty array",
      meta: {
        errorType: err instanceof Error ? err.name : "Unknown",
        fallbackUsed: true,
      },
    });
    return [];
  }
}

