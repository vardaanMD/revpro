import { prisma } from "~/lib/prisma.server";
import type { Capabilities } from "~/lib/capabilities.server";
import { normalizeShopDomain } from "~/lib/shop-domain.server";
import { logWarn, logResilience } from "~/lib/logger.server";

// --- Analytics with configurable date range (single view) ---

/** Preset range key for URL (e.g. ?range=30d). */
export type AnalyticsRangePreset = "7d" | "30d" | "90d";

/** Parsed date range for analytics. All metrics are computed for this window. */
export type AnalyticsDateRange = {
  startDate: Date;
  endDate: Date;
  /** Human label e.g. "Last 30 days" or "Jan 1 – Jan 31, 2025". */
  label: string;
  /** Preset used, if any. */
  preset?: AnalyticsRangePreset;
};

const MAX_ANALYTICS_DAYS = 365;

/**
 * Parse analytics date range from URL search params.
 * Supports ?range=7d|30d|90d or ?start=YYYY-MM-DD&end=YYYY-MM-DD.
 * Default: last 30 days. Max range: MAX_ANALYTICS_DAYS.
 */
export function parseAnalyticsRange(url: URL): AnalyticsDateRange {
  const rangeParam = url.searchParams.get("range");
  const startParam = url.searchParams.get("start");
  const endParam = url.searchParams.get("end");
  const now = new Date();
  const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0));

  if (rangeParam === "7d" || rangeParam === "30d" || rangeParam === "90d") {
    const days = rangeParam === "7d" ? 7 : rangeParam === "30d" ? 30 : 90;
    const startDate = new Date(todayStart);
    startDate.setUTCDate(startDate.getUTCDate() - (days - 1));
    const endDate = new Date(todayStart);
    const label = days === 7 ? "Last 7 days" : days === 30 ? "Last 30 days" : "Last 90 days";
    return { startDate, endDate, label, preset: rangeParam };
  }

  if (startParam && endParam) {
    const start = parseISODate(startParam);
    const end = parseISODate(endParam);
    if (start && end && start <= end) {
      const startDate = startOfDayUtcDate(start);
      let endDate = startOfDayUtcDate(end);
      const days = Math.ceil((endDate.getTime() - startDate.getTime()) / (24 * 60 * 60 * 1000)) + 1;
      if (days > MAX_ANALYTICS_DAYS) {
        endDate = new Date(startDate);
        endDate.setUTCDate(endDate.getUTCDate() + MAX_ANALYTICS_DAYS - 1);
      }
      const label = formatRangeLabel(startDate, endDate);
      return { startDate, endDate, label };
    }
  }

  // Default: last 30 days
  const startDate = new Date(todayStart);
  startDate.setUTCDate(startDate.getUTCDate() - 29);
  return {
    startDate,
    endDate: new Date(todayStart),
    label: "Last 30 days",
    preset: "30d",
  };
}

function parseISODate(s: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.trim());
  if (!match) return null;
  const y = parseInt(match[1], 10);
  const m = parseInt(match[2], 10) - 1;
  const d = parseInt(match[3], 10);
  const date = new Date(Date.UTC(y, m, d, 0, 0, 0, 0));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m || date.getUTCDate() !== d) return null;
  return date;
}

function startOfDayUtcDate(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0));
}

function formatRangeLabel(start: Date, end: Date): string {
  const fmt = (d: Date) => d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  return `${fmt(start)} – ${fmt(end)}`;
}

export type TrendPoint = {
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

/** Cart drawer metrics for the selected date range. One row per drawer open. Not revenue. */
export type CartPerformanceAnalytics = {
  trend: TrendPoint[];
  summary: PeriodSummary;
  /** Sum of cart total at each drawer open in range. Cart state only, not revenue. */
  cartValueAtEvaluation: number;
};

/** Recommendation engagement for the selected date range. */
export type EngagementAnalytics = {
  impressions: number;
  clicks: number;
  ctr: number;
  conversionRate: number;
};

/** Revenue from paid orders (webhook) for the selected date range. We do not claim attribution. */
export type RevenueAnalytics = {
  revenueCents: number;
};

export type AnalyticsMetrics = {
  /** Date range these metrics apply to. */
  range: AnalyticsDateRange;
  cartPerformance: CartPerformanceAnalytics;
  engagement: EngagementAnalytics;
  /** Revenue from paid orders (orders/paid webhook). */
  revenue: RevenueAnalytics;
};

/** Zeroed metrics when DB has no data or on error. Uses the given range for trend length. */
function zeroedAnalyticsMetrics(range: AnalyticsDateRange): AnalyticsMetrics {
  const trend: TrendPoint[] = [];
  const start = new Date(range.startDate);
  const end = new Date(range.endDate);
  for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    trend.push({
      date: d.toISOString().slice(0, 10),
      decisions: 0,
      showRate: 0,
      addRate: 0,
      avgCartValue: 0,
    });
  }
  return deepFreeze({
    range,
    cartPerformance: {
      trend,
      summary: { totalDecisions: 0, showRate: 0, addRate: 0, avgCartValue: 0 },
      cartValueAtEvaluation: 0,
    },
    engagement: { impressions: 0, clicks: 0, ctr: 0, conversionRate: 0 },
    revenue: { revenueCents: 0 },
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

export type GetAnalyticsMetricsOptions = {
  /** Date range for all metrics. */
  range: AnalyticsDateRange;
};

/**
 * Analytics for a single date range: cart performance (trend + summary), engagement, optional revenue.
 * Reads from DecisionMetric + CrossSellConversion + CrossSellEvent + OrderInfluenceEvent. Fail-safe: on error returns zeroed metrics.
 */
export async function getAnalyticsMetrics(
  shop: string,
  capabilities: Capabilities,
  options: GetAnalyticsMetricsOptions
): Promise<AnalyticsMetrics> {
  const normalized = normalizeShopDomain(shop);
  const { range } = options;
  try {
    const total = await prisma.decisionMetric.count({
      where: { shopDomain: normalized },
    });
    if (total === 0) {
      return zeroedAnalyticsMetrics(range);
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
    return zeroedAnalyticsMetrics(range);
  }
  try {
    return await getAnalyticsMetricsUncached(normalized, capabilities, range);
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
    return zeroedAnalyticsMetrics(range);
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

/** End of day (exclusive) for SQL: next day 00:00:00 UTC. */
function endOfRangeExclusive(endDate: Date): Date {
  const d = new Date(endDate);
  d.setUTCDate(d.getUTCDate() + 1);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

async function getAnalyticsMetricsUncached(
  shop: string,
  capabilities: Capabilities,
  range: AnalyticsDateRange
): Promise<AnalyticsMetrics> {
  const rangeEndExclusive = endOfRangeExclusive(range.endDate);

  if (process.env.NODE_ENV === "development") {
    const distinctShops = await prisma.decisionMetric.findMany({
      where: { shopDomain: shop, createdAt: { gte: range.startDate, lt: rangeEndExclusive } },
      select: { shopDomain: true },
      distinct: ["shopDomain"],
    });
    console.assert(
      distinctShops.every((s) => s.shopDomain === shop),
      "Cross-tenant contamination detected"
    );
  }

  type DayRow = { day: Date; total: bigint; shown: bigint; sum_cart: bigint; adds: bigint };
  type EngagementRow = { impressions: bigint; clicks: bigint };

  const [dayRows, summaryRow, engagementRow] = await Promise.all([
    prisma.$queryRaw<DayRow[]>`
      WITH dm AS (
        SELECT
          DATE_TRUNC('day', "createdAt")::date AS day,
          COUNT(*)::bigint AS total,
          COUNT(*) FILTER (WHERE "hasCrossSell" = true)::bigint AS shown,
          COALESCE(SUM("cartValue")::bigint, 0) AS sum_cart
        FROM "DecisionMetric"
        WHERE "shopDomain" = ${shop} AND "createdAt" >= ${range.startDate} AND "createdAt" < ${rangeEndExclusive}
        GROUP BY DATE_TRUNC('day', "createdAt")
      ),
      conv AS (
        SELECT
          DATE_TRUNC('day', "createdAt")::date AS day,
          COUNT(*)::bigint AS adds
        FROM "CrossSellConversion"
        WHERE "shopDomain" = ${shop} AND "createdAt" >= ${range.startDate} AND "createdAt" < ${rangeEndExclusive}
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
          AVG("cartValue") AS avg_cart,
          COUNT(*)::bigint AS count_all,
          COALESCE(SUM("cartValue") FILTER (WHERE "hasCrossSell" = true), 0)::bigint AS sum_cart_with
        FROM "DecisionMetric"
        WHERE "shopDomain" = ${shop} AND "createdAt" >= ${range.startDate} AND "createdAt" < ${rangeEndExclusive}
      ),
      conv AS (
        SELECT COUNT(*)::bigint AS added
        FROM "CrossSellConversion"
        WHERE "shopDomain" = ${shop} AND "createdAt" >= ${range.startDate} AND "createdAt" < ${rangeEndExclusive}
      )
      SELECT dm.total, dm.shown, dm.avg_cart, dm.count_all, conv.added, dm.sum_cart_with FROM dm, conv
    `,
    prisma.$queryRaw<EngagementRow[]>`
      SELECT
        COUNT(*) FILTER (WHERE "eventType" = 'impression')::bigint AS impressions,
        COUNT(*) FILTER (WHERE "eventType" = 'click')::bigint AS clicks
      FROM "CrossSellEvent"
      WHERE "shopDomain" = ${shop} AND "createdAt" >= ${range.startDate} AND "createdAt" < ${rangeEndExclusive}
    `,
  ]);

  let revenue: RevenueAnalytics;
  try {
    const revRows = await prisma.$queryRaw<{ revenue: bigint }[]>`
      SELECT COALESCE(SUM("orderValue" - "refundedCents"), 0)::bigint AS revenue
      FROM "OrderInfluenceEvent"
      WHERE "shopDomain" = ${shop} AND "createdAt" >= ${range.startDate} AND "createdAt" < ${rangeEndExclusive}
    `;
    revenue = { revenueCents: Number(revRows[0]?.revenue ?? 0) };
  } catch {
    revenue = { revenueCents: 0 };
  }

  const s = summaryRow[0];
  const total = s ? Number(s.total) : 0;
  const shown = s ? Number(s.shown) : 0;
  const added = s ? Number(s.added) : 0;
  const cartValueAtEvaluation = s && "sum_cart_with" in s ? Number(s.sum_cart_with) : 0;
  const avgCartValue =
    s && s.count_all > 0n && s.avg_cart != null ? Math.round(s.avg_cart) : 0;
  const showRate = total > 0 ? shown / total : 0;
  const addRate = shown > 0 ? added / shown : 0;

  const dayRowMap = new Map<string, (typeof dayRows)[number]>();
  for (const r of dayRows) dayRowMap.set(toDateKey(r.day), r);

  const trend: TrendPoint[] = [];
  for (let d = new Date(range.startDate); d <= range.endDate; d.setUTCDate(d.getUTCDate() + 1)) {
    const dateStr = toDateKey(d);
    const row = dayRowMap.get(dateStr);
    const dayTotal = row ? Number(row.total) : 0;
    const dayShown = row ? Number(row.shown) : 0;
    const sumCart = row ? Number(row.sum_cart) : 0;
    const adds = row ? Number(row.adds) : 0;
    trend.push({
      date: dateStr,
      decisions: dayTotal,
      showRate: dayTotal > 0 ? dayShown / dayTotal : 0,
      addRate: dayShown > 0 ? adds / dayShown : 0,
      avgCartValue: dayTotal > 0 ? Math.round(sumCart / dayTotal) : 0,
    });
  }

  const cartPerformance: CartPerformanceAnalytics = {
    trend,
    summary: { totalDecisions: total, showRate, addRate, avgCartValue },
    cartValueAtEvaluation,
  };

  const eng = engagementRow[0];
  const impressions = eng ? Number(eng.impressions) : 0;
  const clicks = eng ? Number(eng.clicks) : 0;
  const engagement: EngagementAnalytics = {
    impressions,
    clicks,
    ctr: impressions > 0 ? clicks / impressions : 0,
    conversionRate: addRate,
  };

  return { range, cartPerformance, engagement, revenue };
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
  // Single raw SQL query replaces 6 parallel Prisma queries — uses 1 DB connection instead of 6.
  const [dmRow] = await prisma.$queryRaw<
    {
      total: bigint;
      shown: bigint;
      avg_cart: number | null;
      avg_with: number | null;
      avg_without: number | null;
    }[]
  >`
    SELECT
      COUNT(*)::bigint                                                     AS total,
      COUNT(*) FILTER (WHERE "hasCrossSell" = true)::bigint                AS shown,
      AVG("cartValue")                                                     AS avg_cart,
      AVG("cartValue") FILTER (WHERE "hasCrossSell" = true)                AS avg_with,
      AVG("cartValue") FILTER (WHERE "hasCrossSell" = false)               AS avg_without
    FROM "DecisionMetric"
    WHERE "shopDomain" = ${shop} AND "createdAt" >= ${startDate}
  `;

  const [convRow] = await prisma.$queryRaw<{ cnt: bigint }[]>`
    SELECT COUNT(*)::bigint AS cnt
    FROM "CrossSellConversion"
    WHERE "shopDomain" = ${shop} AND "createdAt" >= ${startDate}
  `;

  const totalDecisions = Number(dmRow?.total ?? 0);
  const shown = Number(dmRow?.shown ?? 0);
  const addedCount = Number(convRow?.cnt ?? 0);
  const crossSellShowRate =
    totalDecisions > 0 ? shown / totalDecisions : 0;
  const crossSellAddRate =
    shown > 0 ? addedCount / shown : 0;
  const avgCartValue =
    dmRow?.avg_cart != null ? Math.round(dmRow.avg_cart) : 0;

  const withAvg = dmRow?.avg_with ?? null;
  const withoutAvg = dmRow?.avg_without ?? null;
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

