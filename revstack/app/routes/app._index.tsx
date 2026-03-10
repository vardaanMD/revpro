/**
 * AUDIT: Dashboard relies on loader data only. No Suspense boundaries.
 * No skeleton fallback. Entire page waits for loader to finish before render.
 */
import { performance } from "node:perf_hooks";
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useNavigation } from "react-router";
import { AppLink } from "~/components/AppLink";
import { authenticate } from "../shopify.server";
import { getShopConfig, getFallbackShopConfig } from "~/lib/shop-config.server";
import { getAppLayoutFromContext } from "~/lib/request-context.server";
import { logResilience } from "~/lib/logger.server";
import { normalizeShopDomain, warnIfShopNotCanonical } from "~/lib/shop-domain.server";
import { getBillingContext } from "~/lib/billing-context.server";
import { getDashboardMetrics } from "~/lib/dashboard-metrics.server";
import { getRetentionContext, touchLastActive } from "~/lib/retention.server";
import { formatCurrency } from "~/lib/format";
import { boundary } from "@shopify/shopify-app-react-router/server";
import type { Plan } from "~/lib/capabilities.server";
import type { DashboardMetrics } from "~/lib/dashboard-metrics.server";
import { StatCard } from "~/components/ui/StatCard";
import { DataPanel } from "~/components/ui/DataPanel";
import { FeatureGate } from "~/components/ui/FeatureGate";
import { MetricSection } from "~/components/ui/MetricSection";
import { RevenueBanner } from "~/components/ui/RevenueBanner";
import { PerformanceDelta } from "~/components/ui/PerformanceDelta";
import { AchievementBanner } from "~/components/ui/AchievementBanner";
import { HealthBadge } from "~/components/ui/HealthBadge";
import type { RetentionContext } from "~/lib/retention.server";
import { logInfo } from "~/lib/logger.server";
import dashboardStyles from "~/styles/dashboardIndex.module.css";
import { MetricCardSkeleton } from "~/components/skeleton/MetricCardSkeleton";
import { ChartSkeleton } from "~/components/skeleton/ChartSkeleton";
import skeletonStyles from "~/styles/skeleton.module.css";
import { useRef, useState, useEffect } from "react";

const FALLBACK_CURRENCY = "USD";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const requestStart = performance.now();
  const timings: Record<string, number> = {};

  const tAuth = performance.now();
  const ctx = getAppLayoutFromContext();
  let shop: string;
  let config: Awaited<ReturnType<typeof getShopConfig>>;
  if (ctx) {
    shop = ctx.shop;
    config = ctx.config;
  } else {
    const { session } = await authenticate.admin(request);
    const rawShop = session.shop;
    shop = normalizeShopDomain(rawShop);
    warnIfShopNotCanonical(rawShop, shop);
    try {
      config = await getShopConfig(shop);
    } catch (err) {
      logResilience({
        shop,
        route: "app._index",
        message: "getShopConfig failed; using fallback config",
        meta: { errorType: err instanceof Error ? err.name : "Unknown", fallbackUsed: true },
      });
      config = getFallbackShopConfig(shop);
    }
  }
  timings.authContext = performance.now() - tAuth;

  const billing = await getBillingContext(shop, config);

  const tMetrics = performance.now();
  const [metrics] = await Promise.all([
    getDashboardMetrics(shop, billing.capabilities),
  ]);
  timings.getDashboardMetrics = performance.now() - tMetrics;

  const currency =
    (process.env.STORE_CURRENCY ?? FALLBACK_CURRENCY).trim() || FALLBACK_CURRENCY;
  const url = new URL(request.url);
  const onboardingJustCompleted =
    url.searchParams.get("onboarding") === "complete";

  let retention: RetentionContext | null;
  if (config.onboardingCompleted) {
    const tRetention = performance.now();
    retention = await getRetentionContext(shop, {
      billingStatus: billing.billingStatus,
      dashboardMetrics: metrics,
      capabilities: billing.capabilities,
      shopConfig: {
        activatedAt: config.activatedAt ?? null,
        lastActiveAt: config.lastActiveAt ?? null,
        milestoneFlags: config.milestoneFlags ?? null,
      },
    });
    timings.getRetentionContext = performance.now() - tRetention;
  } else {
    retention = null;
  }

  if (retention) {
    const tTouch = performance.now();
    await touchLastActive(shop);
    timings.touchLastActive = performance.now() - tTouch;
  }

  timings.total = performance.now() - requestStart;
  if (process.env.NODE_ENV !== "production") {
    logInfo({
      message: "admin route timing",
      shop,
      meta: { route: "/app", timings },
    });
  }

  const configV3 = config.configV3 as { runtimeVersion?: "v3" } | null | undefined;

  return {
    metrics,
    plan: billing.plan,
    capabilities: billing.capabilities,
    billingStatus: billing.billingStatus,
    isEntitled: billing.isEntitled,
    currency,
    onboardingCompleted: config.onboardingCompleted,
    onboardingJustCompleted,
    retention,
    configV3: configV3 ?? null,
  };
};

type LoaderData = {
  metrics: DashboardMetrics;
  plan: Plan;
  capabilities: import("~/lib/capabilities.server").Capabilities;
  billingStatus: string;
  isEntitled: boolean;
  currency: string;
  onboardingCompleted: boolean;
  onboardingJustCompleted: boolean;
  retention: RetentionContext | null;
  configV3: { runtimeVersion?: "v3" } | null;
};

const PLAN_LABELS: Record<Plan, string> = {
  basic: "Basic",
  advanced: "Advanced",
  growth: "Growth",
};

export default function DashboardIndex() {
  const navigation = useNavigation();
  const isLoading = navigation.state === "loading";
  const {
    metrics,
    plan,
    capabilities,
    billingStatus,
    isEntitled,
    currency,
    onboardingCompleted,
    onboardingJustCompleted,
    retention,
    configV3,
  } = useLoaderData<LoaderData>();

  const [transitionFromSkeleton, setTransitionFromSkeleton] = useState(false);
  const prevLoading = useRef(isLoading);
  useEffect(() => {
    if (prevLoading.current && !isLoading) {
      setTransitionFromSkeleton(true);
      const t = setTimeout(() => setTransitionFromSkeleton(false), 200);
      return () => clearTimeout(t);
    }
    prevLoading.current = isLoading;
  }, [isLoading]);

  const cp = metrics.cartPerformance;
  const showRatePct = (cp.crossSellShowRate * 100).toFixed(2);
  const addRateDisplay =
    cp.crossSellAddRate > 1
      ? cp.crossSellAddRate.toFixed(2)
      : `${(cp.crossSellAddRate * 100).toFixed(1)}%`;
  const avgCartFormatted = formatCurrency(cp.avgCartValue, currency);
  const isEmpty = cp.todayDecisions === 0;
  const isBillingActive = isEntitled;
  const isHighestPlan = capabilities.allowRevenueDifference;
  const uniqueCartsEvaluated7d = cp.last7DaysTrend.reduce((s, d) => s + d.decisions, 0);
  const engagement = metrics.engagement;
  const firstMilestone = retention?.firstTimeAchieved?.[0];

  return (
    <s-page heading="Overview">
      {isLoading ? (
        <>
          <s-section heading="Snapshot">
            <MetricSection>
              <MetricCardSkeleton />
              <MetricCardSkeleton />
              <MetricCardSkeleton />
              <MetricCardSkeleton />
            </MetricSection>
          </s-section>
          <s-section>
            <DataPanel>
              <s-stack direction="block" gap="base">
                <s-heading>Drawer opens (7-day trend)</s-heading>
                <ChartSkeleton />
              </s-stack>
            </DataPanel>
          </s-section>
          <s-section>
            <s-stack direction="block" gap="base">
              <MetricSection>
                <MetricCardSkeleton />
              </MetricSection>
            </s-stack>
          </s-section>
        </>
      ) : (
        <div className={skeletonStyles.contentFade} style={{ opacity: transitionFromSkeleton ? 0.6 : 1 }}>
      {retention && (
        <s-section>
          <s-stack direction="inline" gap="base" style={{ alignItems: "center" }}>
            <s-text tone="neutral">Status:</s-text>
            <HealthBadge status={retention.healthStatus} />
          </s-stack>
        </s-section>
      )}

      {retention &&
        retention.daysSinceLastActive != null &&
        retention.daysSinceLastActive >= 5 && (
          <s-banner tone="info" dismissible={false}>
            Here’s what happened while you were away — check your Snapshot and 7-day trend below.
          </s-banner>
        )}

      {onboardingJustCompleted && (
        <s-banner tone="success" dismissible={false}>
          Recommendations are live. Metrics will appear after customer interactions.
        </s-banner>
      )}
      {!onboardingCompleted && !onboardingJustCompleted && (
        <s-banner tone="warning" dismissible={false}>
          Finish setup to see metrics.{" "}
          <AppLink to="/app/onboarding">
            <s-button variant="tertiary">Complete setup</s-button>
          </AppLink>
        </s-banner>
      )}

      {!isBillingActive && (
        <s-banner tone="warning" dismissible={false}>
          Your plan is inactive — activate to access recommendation settings and analytics.
          <AppLink to="/app/upgrade">
            <s-button variant="primary">Activate plan</s-button>
          </AppLink>
        </s-banner>
      )}

      {firstMilestone === "100_decisions" && (
        <AchievementBanner
          message="Milestone: 100 cart decisions recorded."
          tone="info"
        />
      )}
      {firstMilestone === "10k_revenue" && (
        <AchievementBanner
          message="Milestone: $10,000 in cart value at evaluation with recommendations (30-day window, sufficient data)."
          tone="info"
        />
      )}
      {firstMilestone === "30_days_active" && (
        <AchievementBanner
          message="Milestone: 30 days active."
          tone="info"
        />
      )}

      {isEmpty ? (
        <s-section>
          <s-box padding="base" borderWidth="base" borderRadius="base" background="subdued">
            <s-stack direction="block" gap="base">
              <s-text tone="auto">
                Recommendations are live. Data will appear after customer
                interactions.
              </s-text>
            </s-stack>
          </s-box>
        </s-section>
      ) : (
        <>
          {/* Recommendation engagement first */}
          <s-section>
            <div className={dashboardStyles.sectionCartMetrics}>
              <div className={dashboardStyles.sectionHeader}>
                <s-text tone="auto">👆 Recommendation engagement</s-text>
              </div>
              <p className={dashboardStyles.sectionSubtext}>
                How often customers saw and clicked your recommendations. Last 7 days.
              </p>
              <MetricSection>
                <StatCard label="Recommendation cards shown" value={engagement.impressions7d} contextLabel="7 days" />
                <StatCard label="Recommendation cards clicked" value={engagement.clicks7d} contextLabel="7 days" />
                <StatCard
                  label="Click rate"
                  value={engagement.impressions7d > 0 ? `${(engagement.ctr7d * 100).toFixed(2)}%` : "—"}
                  contextLabel="clicks ÷ shown"
                />
                <StatCard
                  label="Conversion rate"
                  value={engagement.conversionRate7d > 0 ? `${(engagement.conversionRate7d * 100).toFixed(2)}%` : "—"}
                  contextLabel="added to cart ÷ saw recommendations"
                />
              </MetricSection>
            </div>
          </s-section>

          <div className={dashboardStyles.divider} />

          {/* Cart activity */}
          <s-section>
            <div className={dashboardStyles.sectionCartMetrics}>
              <div className={dashboardStyles.sectionHeader}>
                <s-text tone="auto">🛒 Cart activity</s-text>
              </div>
              <p className={dashboardStyles.sectionSubtext}>
                How often the cart was opened and what was in it. Not completed orders. Last 7 days.
              </p>
              <MetricSection>
                <StatCard label="Cart opens" value={uniqueCartsEvaluated7d} contextLabel="7 days" />
                <StatCard label="Cart opens (today)" value={cp.todayDecisions} contextLabel="so far" />
                <StatCard
                  label="Carts that saw recommendations"
                  value={`${showRatePct}%`}
                  contextLabel="of cart opens"
                />
                <StatCard
                  label="Added to cart from recommendations"
                  value={addRateDisplay}
                  subtext="when recommendations were shown"
                  contextLabel="add rate"
                />
                <StatCard
                  label="Average cart total when opened"
                  contextLabel="7 days"
                  value={avgCartFormatted}
                />
                <StatCard
                  label="Total cart value (sum when opened)"
                  contextLabel="7 days — not revenue"
                  value={formatCurrency(cp.cartValueAtEvaluation, currency)}
                />
              </MetricSection>
            </div>
          </s-section>

          {/* Revenue from paid orders */}
          <s-section>
            <div className={dashboardStyles.sectionCartMetrics}>
              <div className={dashboardStyles.sectionHeader}>
                <s-text tone="auto">Revenue from paid orders</s-text>
              </div>
              <p className={dashboardStyles.sectionSubtext}>
                Revenue from your store’s paid orders (orders/paid webhook; permission is granted when you install the app). We don’t claim this is caused by the app.
              </p>
              <MetricSection>
                <StatCard label="Revenue (7 days)" value={formatCurrency(metrics.revenue.revenue7d, currency)} contextLabel="from paid orders" />
              </MetricSection>
            </div>
          </s-section>

          {retention && (
            <s-section heading="Momentum">
              <s-stack direction="block" gap="base">
                <MetricSection>
                  <StatCard
                    label="Cart opens this week"
                    value={retention.thisWeekDecisions}
                    subtext="Times cart was opened"
                    tone={retention.thisWeekDecisions >= (retention.lastWeekDecisions || 0) ? "success" : "default"}
                  />
                  <StatCard
                    label="Days since first use"
                    value={retention.daysActive > 0 ? `${retention.daysActive} days` : "Just started"}
                    subtext="Since app setup"
                  />
                </MetricSection>
                {retention.lastWeekDecisions > 0 && (
                  <DataPanel>
                    <s-stack direction="block" gap="small">
                      <s-text tone="neutral">This week vs last week</s-text>
                      <PerformanceDelta
                        label="Cart opens"
                        current={retention.thisWeekDecisions}
                        previous={retention.lastWeekDecisions}
                        format="number"
                      />
                    </s-stack>
                  </DataPanel>
                )}
              </s-stack>
            </s-section>
          )}

          <s-section>
            <FeatureGate locked={!isBillingActive} ctaLabel="Activate plan" ctaTo="/app/upgrade">
              <DataPanel>
                <s-stack direction="block" gap="base">
                  <s-heading>Cart opens (7-day trend)</s-heading>
                  <div className={dashboardStyles.tableWrapper}>
                    <table className={dashboardStyles.table}>
                      <thead>
                        <tr>
                          <th><s-text tone="neutral">Date</s-text></th>
                          <th><s-text tone="neutral">Cart opens</s-text></th>
                        </tr>
                      </thead>
                      <tbody>
                        {cp.last7DaysTrend.map((row) => (
                          <tr key={row.date}>
                            <td><s-text tone="auto">{row.date}</s-text></td>
                            <td><s-text tone="auto">{row.decisions}</s-text></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </s-stack>
              </DataPanel>
            </FeatureGate>
          </s-section>
        </>
      )}

      <s-section>
        <s-stack direction="block" gap="base">
          <StatCard
            label="Current Plan"
            value={PLAN_LABELS[plan]}
            subtext={!isHighestPlan ? "Access strategy selection and comparison metrics" : undefined}
          />
          {!isHighestPlan && (
            <AppLink to="/app/upgrade">
              <s-button variant="secondary">Activate plan</s-button>
            </AppLink>
          )}
        </s-stack>
      </s-section>
        </div>
      )}
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
