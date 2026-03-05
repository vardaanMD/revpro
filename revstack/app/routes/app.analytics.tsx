/**
 * AUDIT: Analytics relies on loader data only. No Suspense boundaries.
 * No skeleton fallback. Entire page waits for loader to finish before render.
 */
import { performance } from "node:perf_hooks";
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, useLoaderData, useNavigation } from "react-router";
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
  parseAnalyticsRange,
  type AnalyticsMetrics,
  type AnalyticsRangePreset,
} from "~/lib/analytics.server";
import { formatCurrency } from "~/lib/format";
import { generateSparkline } from "~/lib/sparkline.server";
import type { Plan } from "~/lib/capabilities.server";
import { StatCard } from "~/components/ui/StatCard";
import { MetricSection } from "~/components/ui/MetricSection";
import analyticsStyles from "~/styles/analyticsPage.module.css";
import dashboardStyles from "~/styles/dashboardIndex.module.css";
import { MetricCardSkeleton } from "~/components/skeleton/MetricCardSkeleton";
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

  const url = new URL(request.url);
  const range = parseAnalyticsRange(url);
  const configV3ForMetrics = config.configV3 as { allowOrderMetrics?: boolean } | null | undefined;
  const allowOrderMetrics = configV3ForMetrics?.allowOrderMetrics !== false;

  const tMetrics = performance.now();
  const metrics = await getAnalyticsMetrics(shop, billing.capabilities, {
    allowOrderMetrics,
    range,
  });
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
    metrics.cartPerformance.trend.map((p) => p.decisions)
  );
  const sparklineAddRate = generateSparkline(
    metrics.cartPerformance.trend.map((p) => p.addRate * 100)
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

const RANGE_OPTIONS: { value: AnalyticsRangePreset; label: string }[] = [
  { value: "7d", label: "Last 7 days" },
  { value: "30d", label: "Last 30 days" },
  { value: "90d", label: "Last 90 days" },
];

export default function AnalyticsPage() {
  const navigation = useNavigation();
  const isLoading = navigation.state === "loading";
  const { metrics, plan, capabilities, billingStatus, isEntitled, sparklineDecisions, sparklineAddRate, runtimeVersion } =
    useLoaderData<LoaderData>();

  const cp = metrics.cartPerformance;
  const rangeLabel = metrics.range.label;
  const currentPreset = metrics.range.preset;

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

  const addRateDisplay =
    cp.summary.addRate > 1
      ? cp.summary.addRate.toFixed(2)
      : `${(cp.summary.addRate * 100).toFixed(1)}%`;
  const engagement = metrics.engagement;
  const totalDecisions = cp.trend.reduce((s, p) => s + p.decisions, 0);

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
          <s-section heading="Analytics">
            <MetricSection>
              <MetricCardSkeleton />
              <MetricCardSkeleton />
              <MetricCardSkeleton />
              <MetricCardSkeleton />
              <MetricCardSkeleton />
            </MetricSection>
          </s-section>
        </>
      ) : (
        <div className={skeletonStyles.contentFade} style={{ opacity: transitionFromSkeleton ? 0.6 : 1 }}>
      {/* Timeframe selector */}
      <s-section>
        <s-stack direction="block" gap="base">
          <s-text tone="subdued">Timeframe</s-text>
          <s-stack direction="inline" gap="small" wrap>
            {RANGE_OPTIONS.map(({ value, label }) => (
              <AppLink
                key={value}
                to={`/app/analytics?range=${value}`}
                prefetch="intent"
              >
                <s-button variant={currentPreset === value ? "primary" : "secondary"} size="slim">
                  {label}
                </s-button>
              </AppLink>
            ))}
          </s-stack>
          <Form method="get" action="/app/analytics" className={analyticsStyles.customRangeForm}>
            <label className={analyticsStyles.customRangeLabel}>
              <span>From</span>
              <input
                type="date"
                name="start"
                defaultValue={metrics.range.startDate.toISOString().slice(0, 10)}
              />
            </label>
            <label className={analyticsStyles.customRangeLabel}>
              <span>To</span>
              <input
                type="date"
                name="end"
                defaultValue={metrics.range.endDate.toISOString().slice(0, 10)}
              />
            </label>
            <button type="submit" className={analyticsStyles.customRangeSubmit}>Apply</button>
          </Form>
          <s-text tone="auto">{rangeLabel}</s-text>
        </s-stack>
      </s-section>

      {/* Single view: cart, trend, engagement, revenue */}
      <div>
        <s-section heading="Cart drawer metrics">
          <p className={analyticsStyles.sectionSubtext}>
            One row per drawer open. All values are cart state at that moment only — not revenue or completed orders. {rangeLabel}.
          </p>
          <MetricSection>
            <StatCard label="Drawer opens" value={cp.summary.totalDecisions} contextLabel={rangeLabel} />
            <StatCard label="Drawer opens with ≥1 recommendation shown" value={`${(cp.summary.showRate * 100).toFixed(1)}%`} contextLabel="of drawer opens" />
            <StatCard label="Add-to-carts from recommendations" value={addRateDisplay} contextLabel="per drawer open with recommendations shown" />
            <StatCard label="Avg. cart total at drawer open" contextLabel={rangeLabel} value={formatCurrency(cp.summary.avgCartValue, CURRENCY)} />
            <StatCard label="Sum of cart totals (at each drawer open)" contextLabel={`${rangeLabel}, not revenue`} value={formatCurrency(cp.cartValueAtEvaluation, CURRENCY)} />
          </MetricSection>
        </s-section>

        <s-section heading="Drawer opens (daily trend)">
          <MetricSection>
            <StatCard
              label="Drawer opens"
              value={
                <>
                  <div
                    dangerouslySetInnerHTML={{ __html: sparklineDecisions }}
                    className={analyticsStyles.sparkline}
                  />
                  <s-text>{totalDecisions} total</s-text>
                </>
              }
            />
            <StatCard
              label="Add-to-carts from recommendations"
              value={
                <>
                  <div
                    dangerouslySetInnerHTML={{ __html: sparklineAddRate }}
                    className={analyticsStyles.sparkline}
                  />
                  <s-text>
                    {cp.summary.addRate > 1 ? cp.summary.addRate.toFixed(2) : `${(cp.summary.addRate * 100).toFixed(1)}%`} rate
                  </s-text>
                </>
              }
            />
          </MetricSection>
          {cp.trend.length > 0 && cp.trend.length <= 90 && (
            <div className={analyticsStyles.tableWrapper}>
              <table className={analyticsStyles.table}>
                <thead>
                  <tr>
                    <th><s-text tone="neutral">Date</s-text></th>
                    <th><s-text tone="neutral">Drawer opens</s-text></th>
                    <th><s-text tone="neutral">Add rate</s-text></th>
                  </tr>
                </thead>
                <tbody>
                  {cp.trend.map((p) => (
                    <tr key={p.date}>
                      <td><s-text tone="auto">{p.date}</s-text></td>
                      <td><s-text tone="auto">{p.decisions}</s-text></td>
                      <td><s-text tone="auto">{p.addRate > 0 ? `${(p.addRate * 100).toFixed(1)}%` : "—"}</s-text></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </s-section>

        <s-section heading="Recommendation engagement">
          <p className={analyticsStyles.sectionSubtext}>
            Impressions, Clicks, Click-through rate, Conversion rate. {rangeLabel}.
          </p>
          <MetricSection>
            <StatCard label="Impressions" value={engagement.impressions} contextLabel={rangeLabel} />
            <StatCard label="Clicks" value={engagement.clicks} contextLabel={rangeLabel} />
            <StatCard
              label="Click-through rate"
              value={engagement.impressions > 0 ? `${(engagement.ctr * 100).toFixed(2)}%` : "—"}
              contextLabel={rangeLabel}
            />
            <StatCard
              label="Conversion rate"
              value={engagement.conversionRate > 0 ? `${(engagement.conversionRate * 100).toFixed(2)}%` : "—"}
              contextLabel="adds ÷ sessions with recs shown"
            />
          </MetricSection>
        </s-section>

        {metrics.revenue != null && (
          <s-section heading="Revenue (paid orders)">
            <p className={analyticsStyles.sectionSubtext}>
              Actual order revenue from paid orders webhook. We do not claim this revenue is attributable to the app. To stop storing order data, turn off in Settings → Order data &amp; revenue.
            </p>
            <MetricSection>
              <StatCard label="Revenue" value={formatCurrency(metrics.revenue.revenueCents, CURRENCY)} contextLabel={rangeLabel} />
            </MetricSection>
          </s-section>
        )}
      </div>
        </div>
      )}
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
