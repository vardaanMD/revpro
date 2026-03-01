/**
 * Retention & behavioral loop: health score, milestones, momentum context.
 * No new tables; uses ShopConfig (activatedAt, lastActiveAt, milestoneFlags) and existing metrics.
 * All Prisma calls wrapped: on failure log and return safe fallback (void or minimal context).
 */

import { prisma } from "~/lib/prisma.server";
import type { Capabilities } from "~/lib/capabilities.server";
import type { DashboardMetrics } from "~/lib/dashboard-metrics.server";
import { logResilience } from "~/lib/logger.server";

export type HealthStatus = "active" | "improving" | "needs_attention";

export type MilestoneKey = "100_decisions" | "10k_revenue" | "30_days_active";

export type RetentionContext = {
  activatedAt: Date | null;
  lastActiveAt: Date | null;
  daysActive: number;
  totalDecisionsAllTime: number;
  revenueInfluenced30d: number;
  milestoneFlags: Record<MilestoneKey, boolean>;
  firstTimeAchieved: MilestoneKey[];
  healthStatus: HealthStatus;
  daysSinceLastActive: number | null;
  thisWeekDecisions: number;
  lastWeekDecisions: number;
  upliftThisWeek: number;
};

const MILESTONE_10K_CENTS = 1_000_000;

function startOfDayUtc(daysAgo: number): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - daysAgo);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

/**
 * Touch lastActiveAt on app load so we can show "here's what happened while you were away".
 * On Prisma failure logs and returns; never throws.
 */
export async function touchLastActive(shop: string): Promise<void> {
  try {
    await prisma.shopConfig.updateMany({
      where: { shopDomain: shop },
      data: { lastActiveAt: new Date() },
    });
  } catch (err) {
    logResilience({
      shop,
      route: "retention-touchLastActive",
      message: "touchLastActive failed",
      meta: { errorType: err instanceof Error ? err.name : "Unknown" },
    });
  }
}

/**
 * Set activatedAt when onboarding is completed (called from onboarding completion flow).
 * On Prisma failure logs and returns; never throws.
 */
export async function setActivatedAtIfNeeded(shop: string): Promise<void> {
  try {
    const config = await prisma.shopConfig.findUnique({
      where: { shopDomain: shop },
      select: { onboardingCompleted: true, activatedAt: true },
    });
    if (config?.onboardingCompleted && !config.activatedAt) {
      await prisma.shopConfig.update({
        where: { shopDomain: shop },
        data: { activatedAt: new Date() },
      });
    }
  } catch (err) {
    logResilience({
      shop,
      route: "retention-setActivatedAtIfNeeded",
      message: "setActivatedAtIfNeeded failed",
      meta: { errorType: err instanceof Error ? err.name : "Unknown" },
    });
  }
}

/**
 * Ensure activatedAt is set when merchant has completed onboarding (idempotent).
 * Pass config to avoid an extra Prisma read when caller already has it.
 * On Prisma failure logs and returns; never throws.
 */
export async function ensureActivatedAt(
  shop: string,
  config?: { onboardingCompleted: boolean; activatedAt: Date | null } | null
): Promise<void> {
  try {
    const resolved =
      config != null
        ? config
        : await prisma.shopConfig.findUnique({
            where: { shopDomain: shop },
            select: { onboardingCompleted: true, activatedAt: true },
          });
    if (resolved?.onboardingCompleted && !resolved.activatedAt) {
      await prisma.shopConfig.update({
        where: { shopDomain: shop },
        data: { activatedAt: new Date() },
      });
    }
  } catch (err) {
    logResilience({
      shop,
      route: "retention-ensureActivatedAt",
      message: "ensureActivatedAt failed",
      meta: { errorType: err instanceof Error ? err.name : "Unknown" },
    });
  }
}

function parseMilestoneFlags(raw: unknown): Record<MilestoneKey, boolean> {
  const def: Record<MilestoneKey, boolean> = {
    "100_decisions": false,
    "10k_revenue": false,
    "30_days_active": false,
  };
  if (raw == null || typeof raw !== "object") return def;
  const o = raw as Record<string, unknown>;
  if (typeof o["100_decisions"] === "boolean") def["100_decisions"] = o["100_decisions"];
  if (typeof o["10k_revenue"] === "boolean") def["10k_revenue"] = o["10k_revenue"];
  if (typeof o["30_days_active"] === "boolean") def["30_days_active"] = o["30_days_active"];
  return def;
}

/**
 * Compute health status from billing, decision volume, and trend.
 */
export function getHealthStatus(
  billingActive: boolean,
  metrics: { todayDecisions: number; last7DaysTrend: { decisions: number }[]; observedAovDifference: number }
): HealthStatus {
  if (!billingActive) return "needs_attention";
  const thisWeek = metrics.last7DaysTrend.reduce((s, d) => s + d.decisions, 0);
  if (thisWeek === 0) return "needs_attention";
  const prevWeek = 0; // dashboard doesn't pass prev week; use improving if we have activity and observed diff
  if (metrics.observedAovDifference > 0) return "improving";
  return "active";
}

/** Minimal shop config needed for retention (pass from loader to avoid re-fetch). */
export type RetentionShopConfig = {
  activatedAt: Date | null;
  lastActiveAt: Date | null;
  milestoneFlags: unknown;
};

type ThirtyDayRow = {
  count_with: bigint;
  avg_with: number | null;
  count_without: bigint;
  avg_without: number | null;
};

type WeekCountRow = { this_week: bigint; last_week: bigint };

/** Safe minimal retention context when Prisma fails. */
function zeroedRetentionContext(): RetentionContext {
  return {
    activatedAt: null,
    lastActiveAt: null,
    daysActive: 0,
    totalDecisionsAllTime: 0,
    revenueInfluenced30d: 0,
    milestoneFlags: { "100_decisions": false, "10k_revenue": false, "30_days_active": false },
    firstTimeAchieved: [],
    healthStatus: "needs_attention",
    daysSinceLastActive: null,
    thisWeekDecisions: 0,
    lastWeekDecisions: 0,
    upliftThisWeek: 0,
  };
}

/**
 * Full retention context for dashboard: days active, milestones, health, re-engagement.
 * Pass shopConfig from loader to avoid re-fetching; if omitted, config is loaded from DB.
 * Gated metrics (e.g. observedAovDifference) are only read when capabilities allow; explicit guard, no optional chaining.
 * On Prisma failure returns zeroed retention context; never throws.
 */
export async function getRetentionContext(
  shop: string,
  options: {
    billingStatus: string;
    dashboardMetrics: DashboardMetrics;
    capabilities: Capabilities;
    shopConfig?: RetentionShopConfig;
  }
): Promise<RetentionContext> {
  const { billingStatus, dashboardMetrics, capabilities, shopConfig: passedConfig } = options;
  const now = new Date();
  const sevenDayStart = startOfDayUtc(6);
  const fourteenDayStart = startOfDayUtc(13);
  const thirtyDayStart = startOfDayUtc(29);

  try {
  const configPromise =
    passedConfig != null
      ? Promise.resolve({
          activatedAt: passedConfig.activatedAt,
          lastActiveAt: passedConfig.lastActiveAt,
          milestoneFlags: passedConfig.milestoneFlags,
        })
      : prisma.shopConfig.findUnique({
          where: { shopDomain: shop },
          select: { activatedAt: true, lastActiveAt: true, milestoneFlags: true },
        });

  const [configRes, totalDecisionsAllTime, thirtyRow, weekRow] = await Promise.all([
    configPromise,
    prisma.decisionMetric.count({ where: { shopDomain: shop } }),
    prisma.$queryRaw<ThirtyDayRow[]>`
      SELECT
        COUNT(*) FILTER (WHERE "hasCrossSell" = true AND "createdAt" >= ${thirtyDayStart})::bigint AS count_with,
        AVG("cartValue") FILTER (WHERE "hasCrossSell" = true AND "createdAt" >= ${thirtyDayStart}) AS avg_with,
        COUNT(*) FILTER (WHERE "hasCrossSell" = false AND "createdAt" >= ${thirtyDayStart})::bigint AS count_without,
        AVG("cartValue") FILTER (WHERE "hasCrossSell" = false AND "createdAt" >= ${thirtyDayStart}) AS avg_without
      FROM "DecisionMetric"
      WHERE "shopDomain" = ${shop}
    `,
    prisma.$queryRaw<WeekCountRow[]>`
      SELECT
        COUNT(*) FILTER (WHERE "createdAt" >= ${sevenDayStart})::bigint AS this_week,
        COUNT(*) FILTER (WHERE "createdAt" >= ${fourteenDayStart} AND "createdAt" < ${sevenDayStart})::bigint AS last_week
      FROM "DecisionMetric"
      WHERE "shopDomain" = ${shop}
    `,
  ]);

  const activatedAt =
    configRes && typeof configRes === "object" && configRes !== null
      ? (configRes as RetentionShopConfig).activatedAt ?? null
      : null;
  const lastActiveAt =
    configRes && typeof configRes === "object" && configRes !== null
      ? (configRes as RetentionShopConfig).lastActiveAt ?? null
      : null;
  const milestoneFlags = parseMilestoneFlags(
    configRes && typeof configRes === "object" && configRes !== null
      ? (configRes as RetentionShopConfig).milestoneFlags ?? null
      : null
  );

  const t = thirtyRow[0];
  const avgWith = t && t.count_with > 0n && t.avg_with != null ? t.avg_with : null;
  const avgWithout = t && t.count_without > 0n && t.avg_without != null ? t.avg_without : null;
  const countWith = t ? Number(t.count_with) : 0;
  const countWithout = t ? Number(t.count_without) : 0;
  const thisWeekCount = weekRow[0] ? Number(weekRow[0].this_week) : 0;
  const lastWeekCount = weekRow[0] ? Number(weekRow[0].last_week) : 0;

  const daysActive = activatedAt
    ? Math.max(0, Math.floor((now.getTime() - activatedAt.getTime()) / (24 * 60 * 60 * 1000)))
    : 0;

  const upliftPerCart = avgWith != null && avgWithout != null ? avgWith - avgWithout : 0;
  const MIN_SAMPLES_FOR_REVENUE = 30;
  const revenue30d =
    countWith >= MIN_SAMPLES_FOR_REVENUE && countWithout >= MIN_SAMPLES_FOR_REVENUE
      ? Math.round(upliftPerCart * countWith)
      : 0;
  const upliftThisWeek =
    capabilities.allowRevenueDifference &&
    dashboardMetrics.orderImpact != null
      ? dashboardMetrics.orderImpact.avgWith - dashboardMetrics.orderImpact.avgWithout
      : 0;

  const newMilestones: Record<MilestoneKey, boolean> = { ...milestoneFlags };
  if (totalDecisionsAllTime >= 100) newMilestones["100_decisions"] = true;
  if (revenue30d >= MILESTONE_10K_CENTS) newMilestones["10k_revenue"] = true;
  if (daysActive >= 30) newMilestones["30_days_active"] = true;

  const firstTimeAchieved: MilestoneKey[] = [];
  if (newMilestones["100_decisions"] && !milestoneFlags["100_decisions"])
    firstTimeAchieved.push("100_decisions");
  if (newMilestones["10k_revenue"] && !milestoneFlags["10k_revenue"])
    firstTimeAchieved.push("10k_revenue");
  if (newMilestones["30_days_active"] && !milestoneFlags["30_days_active"])
    firstTimeAchieved.push("30_days_active");
  if (firstTimeAchieved.length > 0) {
    await prisma.shopConfig.update({
      where: { shopDomain: shop },
      data: { milestoneFlags: newMilestones as unknown as object },
    });
  }

  const observedAovForHealth =
    capabilities.allowRevenueDifference && dashboardMetrics.orderImpact != null
      ? dashboardMetrics.orderImpact.avgWith - dashboardMetrics.orderImpact.avgWithout
      : 0;
  const healthStatus = getHealthStatus(billingStatus === "active", {
    todayDecisions: dashboardMetrics.cartPerformance.todayDecisions,
    last7DaysTrend: dashboardMetrics.cartPerformance.last7DaysTrend,
    observedAovDifference: observedAovForHealth,
  });

  let daysSinceLastActive: number | null = null;
  if (lastActiveAt) {
    daysSinceLastActive = Math.floor(
      (now.getTime() - lastActiveAt.getTime()) / (24 * 60 * 60 * 1000)
    );
  }

  return {
    activatedAt,
    lastActiveAt,
    daysActive,
    totalDecisionsAllTime,
    revenueInfluenced30d: revenue30d,
    milestoneFlags: newMilestones,
    firstTimeAchieved,
    healthStatus,
    daysSinceLastActive,
    thisWeekDecisions: thisWeekCount,
    lastWeekDecisions: lastWeekCount,
    upliftThisWeek,
  };
  } catch (err) {
    logResilience({
      shop,
      route: "retention-getRetentionContext",
      message: "getRetentionContext failed; returning zeroed context",
      meta: {
        errorType: err instanceof Error ? err.name : "Unknown",
        fallbackUsed: true,
      },
    });
    return zeroedRetentionContext();
  }
}

/**
 * Mark a milestone as acknowledged so we don't show the banner again.
 * On Prisma failure logs and returns; never throws.
 */
export async function acknowledgeMilestone(
  shop: string,
  key: MilestoneKey
): Promise<void> {
  try {
    const config = await prisma.shopConfig.findUnique({
      where: { shopDomain: shop },
      select: { milestoneFlags: true },
    });
    const current = parseMilestoneFlags(config?.milestoneFlags ?? null);
    current[key] = true;
    await prisma.shopConfig.update({
      where: { shopDomain: shop },
      data: { milestoneFlags: current as unknown as object },
    });
  } catch (err) {
    logResilience({
      shop,
      route: "retention-acknowledgeMilestone",
      message: "acknowledgeMilestone failed",
      meta: { errorType: err instanceof Error ? err.name : "Unknown" },
    });
  }
}
