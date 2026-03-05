/**
 * AUDIT: Analytics relies on loader data only. No Suspense boundaries.
 * No skeleton fallback. Entire page waits for loader to finish before render.
 */
import { performance } from "node:perf_hooks";
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useNavigation } from "react-router";
import { AppLink } from "~/components/AppLink";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "~/shopify.server";
import { getShopConfig, getFallbackShopConfig } from "~/lib/shop-config.server";
import { getAppLayoutFromContext } from "~/lib/request-context.server";
import { logResilience } from "~/lib/logger.server";
import { normalizeShopDomain, warnIfShopNotCanonical } from "~/lib/shop-domain.server";
import { getBillingContext } from "~/lib/billing-context.server";
import {
  getAnalyticsMetrics,
  type AnalyticsMetrics,
} from "~/lib/analytics.server";
import { formatCurrency } from "~/lib/format";
import { generateSparkline } from "~/lib/sparkline.server";
import type { Plan } from "~/lib/capabilities.server";
import { StatCard } from "~/components/ui/StatCard";
import { DataPanel } from "~/components/ui/DataPanel";
import { FeatureGate } from "~/components/ui/FeatureGate";
import { MetricSection } from "~/components/ui/MetricSection";
import analyticsStyles from "~/styles/analyticsPage.module.css";
import dashboardStyles from "~/styles/dashboardIndex.module.css";
import { MetricCardSkeleton } from "~/components/skeleton/MetricCardSkeleton";
import { TableSkeleton } from "~/components/skeleton/TableSkeleton";
import skeletonStyles from "~/styles/skeleton.module.css";
import { useRef, useState, useEffect } from "react";
import { logInfo } from "~/lib/logger.server";

const CURRENCY = process.env.STORE_CURRENCY ?? "USD";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const requestStart = performance.now();
  const timings: Record<string, number> = {};

  const appLayout = getAppLayoutFromContext();
  let shop: string;
  let config: Awaited<ReturnType<typeof getShopConfig>>;
  if (appLayout) {
    shop = appLayout.shop;
    config = appLayout.config;
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
        route: "app.analytics",
        message: "getShopConfig failed; using fallback config",
        meta: { errorType: err instanceof Error ? err.name : "Unknown", fallbackUsed: true },
      });
      config = getFallbackShopConfig(shop);
    }
  }

  const billing = await getBillingContext(shop, config);

  // Analytics reads from same source V3 runtime writes to: DecisionMetric + CrossSellConversion
  // (cart.analytics.v3.ts). No separate V2 vs V3 pipeline — unified store.
  const tMetrics = performance.now();
  const [metrics] = await Promise.all([
    getAnalyticsMetrics(shop, billing.capabilities),
  ]);
  timings.getAnalyticsMetrics = performance.now() - tMetrics;

  timings.total = performance.now() - requestStart;
  if (process.env.NODE_ENV !== "production") {
    logInfo({
      message: "admin route timing",
      shop,
      meta: { route: "/app/analytics", timings },
    });
  }

  const configV3 = config.configV3 as { runtimeVersion?: "v1" | "v2" | "v3" } | null | undefined;
  const runtimeVersion: "v1" | "v2" | "v3" =
    configV3?.runtimeVersion === "v1" || configV3?.runtimeVersion === "v2" || configV3?.runtimeVersion === "v3"
      ? configV3.runtimeVersion
      : "v3";

  const sparklineDecisions = generateSparkline(
    metrics.cartPerformance.sevenDayTrend.map((p) => p.decisions)
  );
  const sparklineAddRate = generateSparkline(
    metrics.cartPerformance.sevenDayTrend.map((p) => p.addRate * 100)
  );
  return {
    metrics,
    plan: billing.plan,
    capabilities: billing.capabilities,
    billingStatus: billing.billingStatus,
    isEntitled: billing.isEntitled,
    sparklineDecisions,
    sparklineAddRate,
    configV3: configV3 ?? null,
    runtimeVersion,
  };
};

type LoaderData = {
  metrics: AnalyticsMetrics;
  plan: Plan;
  capabilities: import("~/lib/capabilities.server").Capabilities;
  billingStatus: string;
  isEntitled: boolean;
  sparklineDecisions: string;
  sparklineAddRate: string;
  configV3: { runtimeVersion?: "v1" | "v2" | "v3" } | null;
  runtimeVersion: "v1" | "v2" | "v3";
};

function formatPctChange(prev: number, curr: number): string {
  if (prev === 0) return curr > 0 ? "+100%" : "0%";
  const pct = ((curr - prev) / prev) * 100;
  const sign = pct >= 0 ? "+" : "";
  return `${sign}${pct.toFixed(1)}%`;
}

function ComparisonRow({
  label,
  current,
  previous,
  format = "number",
  currency,
}: {
  label: string;
  current: number;
  previous: number;
  format?: "number" | "percent" | "currency" | "addRate";
  currency: string;
}) {
  const improved = current > previous;
  const declined = current < previous;
  const displayCurrent =
    format === "percent"
      ? `${(current * 100).toFixed(1)}%`
      : format === "currency"
        ? formatCurrency(current, currency)
        : format === "addRate"
          ? current > 1
            ? current.toFixed(2)
            : `${(current * 100).toFixed(1)}%`
          : String(current);
  return (
    <div className={analyticsStyles.comparisonRow}>
      <s-text tone="neutral">{label}</s-text>
      <span className={analyticsStyles.comparisonValue}>
        <span>{displayCurrent}</span>
        {improved && <span className={analyticsStyles.improved}>▲</span>}
        {declined && <span className={analyticsStyles.declined}>▼</span>}
        {!improved && !declined && <span className={analyticsStyles.neutral}>—</span>}
      </span>
    </div>
  );
}

export default function AnalyticsPage() {
  const navigation = useNavigation();
  const isLoading = navigation.state === "loading";
  const { metrics, plan, capabilities, billingStatus, isEntitled, sparklineDecisions, sparklineAddRate, runtimeVersion } =
    useLoaderData<LoaderData>();

  const cp = metrics.cartPerformance;

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

  const isBillingActive = isEntitled;
  const blurAdvanced = !capabilities.allowComparison || !isBillingActive;

  const current7Decisions = cp.sevenDayTrend.reduce(
    (s, p) => s + p.decisions,
    0
  );
  const current7Shown = cp.sevenDayTrend.reduce(
    (s, p) => s + Math.round(p.decisions * p.showRate),
    0
  );
  const current7Added = cp.sevenDayTrend.reduce(
    (s, p) => s + Math.round(p.decisions * p.showRate * p.addRate),
    0
  );
  const current7AddRate =
    current7Shown > 0 ? current7Added / current7Shown : 0;
  const hasPrev7 =
    capabilities.allowComparison &&
    cp.previousSevenDaySummary != null;
  const prev7 = hasPrev7 ? cp.previousSevenDaySummary! : null;
  const pctChangeDecisions = hasPrev7 && prev7 != null
    ? formatPctChange(prev7.totalDecisions, current7Decisions)
    : "—";
  const pctChangeAddRate = hasPrev7 && prev7 != null
    ? formatPctChange(prev7.addRate * 100, current7AddRate * 100)
    : "—";

  const current7AddRatePct = current7AddRate * 100;
  const prev7AddRatePct = hasPrev7 && prev7 != null ? prev7.addRate * 100 : 0;
  const addRateFlat = hasPrev7 && prev7 != null && Math.abs(current7AddRatePct - prev7AddRatePct) < 0.5;
  const decisionsFlat = hasPrev7 && prev7 != null && prev7.totalDecisions > 0 && Math.abs((current7Decisions - prev7.totalDecisions) / prev7.totalDecisions) < 0.05;

  const addRate30Display =
    cp.thirtyDaySummary.addRate > 1
      ? cp.thirtyDaySummary.addRate.toFixed(2)
      : `${(cp.thirtyDaySummary.addRate * 100).toFixed(1)}%`;
  const engagement = metrics.engagement;

  const runtimeLabel = runtimeVersion === "v3" ? "V3" : runtimeVersion === "v1" ? "V1" : "V2";

  return (
    <s-page heading="Analytics">
      <div className={analyticsStyles.runtimeBadgeWrap}>
        <span className={dashboardStyles.runtimeBadge} title={`Cart Pro runtime: ${runtimeLabel}. Analytics show events from this runtime.`}>
          Runtime: {runtimeLabel}
        </span>
      </div>
      {isLoading ? (
        <>
          <s-section heading="Last 7 Days">
            <s-stack direction="block" gap="large">
              <MetricSection>
                <MetricCardSkeleton />
                <MetricCardSkeleton />
              </MetricSection>
            </s-stack>
          </s-section>
          <s-section heading="30 Day Summary">
            <MetricSection>
              <MetricCardSkeleton />
              <MetricCardSkeleton />
              <MetricCardSkeleton />
              <MetricCardSkeleton />
              <MetricCardSkeleton />
            </MetricSection>
          </s-section>
          <s-section heading="Compared to previous 30 days">
            <DataPanel>
              <TableSkeleton rows={4} />
            </DataPanel>
          </s-section>
          <s-section heading="Snapshot">
            <MetricSection>
              <MetricCardSkeleton />
            </MetricSection>
          </s-section>
        </>
      ) : (
        <div className={skeletonStyles.contentFade} style={{ opacity: transitionFromSkeleton ? 0.6 : 1 }}>
      {isBillingActive && (addRateFlat || decisionsFlat) && (
        <s-banner tone="info" dismissible={false}>
          Try adjusting your recommendation strategy in Settings to see more movement in your funnel.
          <AppLink to="/app/settings">
            <s-button variant="tertiary">Open Settings</s-button>
          </AppLink>
        </s-banner>
      )}

      {/* Cart metrics */}
      <div>
        <s-section heading="Cart drawer metrics (30 days)">
          <p className={analyticsStyles.sectionSubtext}>
            One row per drawer open when the cart was evaluated. All values are cart state at that moment only — not revenue or completed orders.
          </p>
          <MetricSection>
            <StatCard label="Drawer opens" value={cp.thirtyDaySummary.totalDecisions} contextLabel="30 days" />
            <StatCard label="Drawer opens with ≥1 recommendation shown" value={`${(cp.thirtyDaySummary.showRate * 100).toFixed(1)}%`} contextLabel="of drawer opens" />
            <StatCard label="Add-to-carts from recommendations" value={addRate30Display} contextLabel="per drawer open with recommendations shown" />
            <StatCard label="Avg. cart total at drawer open" contextLabel="30 days" value={formatCurrency(cp.thirtyDaySummary.avgCartValue, CURRENCY)} />
            <StatCard label="Sum of cart totals (at each drawer open)" contextLabel="30 days, not revenue" value={formatCurrency(cp.cartValueAtEvaluation, CURRENCY)} />
          </MetricSection>
        </s-section>

        <s-section heading="Drawer opens (7-day trend)">
          <s-stack direction="block" gap="large">
            <MetricSection>
              <StatCard
                label="Drawer opens (last 7 days)"
                value={
                  <>
                    <div
                      dangerouslySetInnerHTML={{ __html: sparklineDecisions }}
                      className={analyticsStyles.sparkline}
                    />
                    <s-text>
                      {current7Decisions} <span className={analyticsStyles.subduedSpan}>{pctChangeDecisions} vs prev 7 days</span>
                    </s-text>
                  </>
                }
              />
              <StatCard
                label="Add-to-carts from recommendations (7 days)"
                value={
                  <>
                    <div
                      dangerouslySetInnerHTML={{ __html: sparklineAddRate }}
                      className={analyticsStyles.sparkline}
                    />
                    <s-text>
                      {current7AddRate > 1 ? current7AddRate.toFixed(2) : `${(current7AddRate * 100).toFixed(1)}%`}{" "}
                      <span className={analyticsStyles.subduedSpan}>{pctChangeAddRate} vs prev 7 days</span>
                    </s-text>
                  </>
                }
              />
            </MetricSection>
          </s-stack>
        </s-section>

        <s-section heading="Compared to previous 30 days">
          <FeatureGate locked={blurAdvanced} ctaLabel="Activate plan" ctaTo="/app/upgrade">
            <DataPanel>
              <s-stack direction="block" gap="base">
                {capabilities.allowComparison && cp.previousThirtyDaySummary != null && (
                  <>
                    <ComparisonRow
                      label="Drawer opens"
                      current={cp.thirtyDaySummary.totalDecisions}
                      previous={cp.previousThirtyDaySummary.totalDecisions}
                      currency={CURRENCY}
                    />
                    <ComparisonRow
                      label="Drawer opens with recommendations shown (%)"
                      current={cp.thirtyDaySummary.showRate}
                      previous={cp.previousThirtyDaySummary.showRate}
                      format="percent"
                      currency={CURRENCY}
                    />
                    <ComparisonRow
                      label="Add-to-carts from recommendations (per session shown)"
                      current={cp.thirtyDaySummary.addRate}
                      previous={cp.previousThirtyDaySummary.addRate}
                      format="addRate"
                      currency={CURRENCY}
                    />
                    <ComparisonRow
                      label="Avg. cart total at drawer open"
                      current={cp.thirtyDaySummary.avgCartValue}
                      previous={cp.previousThirtyDaySummary.avgCartValue}
                      format="currency"
                      currency={CURRENCY}
                    />
                  </>
                )}
              </s-stack>
            </DataPanel>
          </FeatureGate>
        </s-section>

        <s-section heading="Recommendation block engagement (30 days)">
          <p className={analyticsStyles.sectionSubtext}>
            Times a recommendation card was shown (impressions) and clicked (clicks). CTR = recommendation clicks ÷ recommendation impressions.
          </p>
          <MetricSection>
            <StatCard label="Recommendation card impressions" value={engagement.impressions30d} contextLabel="30 days" />
            <StatCard label="Recommendation card clicks" value={engagement.clicks30d} contextLabel="30 days" />
            <StatCard
              label="Recommendation CTR (clicks ÷ impressions)"
              value={engagement.impressions30d > 0 ? `${(engagement.ctr30d * 100).toFixed(2)}%` : "—"}
              contextLabel="30 days"
            />
          </MetricSection>
        </s-section>
      </div>
        </div>
      )}
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
