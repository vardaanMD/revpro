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
import type { Plan } from "~/lib/capabilities.server";
import { StatCard } from "~/components/ui/StatCard";
import { LineChart } from "~/components/ui/LineChart";
import { MetricSection } from "~/components/ui/MetricSection";
import analyticsStyles from "~/styles/analyticsPage.module.css";
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

  const tMetrics = performance.now();
  const metrics = await getAnalyticsMetrics(shop, billing.capabilities, { range });
  timings.getAnalyticsMetrics = performance.now() - tMetrics;

  timings.total = performance.now() - requestStart;
  if (process.env.NODE_ENV !== "production") {
    logInfo({
      message: "admin route timing",
      shop,
      meta: { route: "/app/analytics", timings },
    });
  }

  const configV3 = config.configV3 as { runtimeVersion?: "v3" } | null | undefined;

  return {
    metrics,
    plan: billing.plan,
    capabilities: billing.capabilities,
    billingStatus: billing.billingStatus,
    isEntitled: billing.isEntitled,
    configV3: configV3 ?? null,
  };
};

type LoaderData = {
  metrics: AnalyticsMetrics;
  plan: Plan;
  capabilities: import("~/lib/capabilities.server").Capabilities;
  billingStatus: string;
  isEntitled: boolean;
  configV3: { runtimeVersion?: "v3" } | null;
};

const RANGE_OPTIONS: { value: AnalyticsRangePreset; label: string }[] = [
  { value: "7d", label: "Last 7 days" },
  { value: "30d", label: "Last 30 days" },
  { value: "90d", label: "Last 90 days" },
];

export default function AnalyticsPage() {
  const navigation = useNavigation();
  const isLoading = navigation.state === "loading";
  const { metrics, plan, capabilities, billingStatus, isEntitled } =
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

  return (
    <s-page heading="Analytics">
      {!isLoading && (
        <p className={analyticsStyles.pageRange} aria-live="polite">
          Showing: <strong>{rangeLabel}</strong>
        </p>
      )}
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

      {/* Order: recommendation engagement first, then cart metrics, then chart, then revenue (always shown) */}
      <div>
        <s-section heading="Recommendation engagement">
          <p className={analyticsStyles.sectionSubtext}>
            How often customers saw and clicked your recommendations. {rangeLabel}.
          </p>
          <MetricSection>
            <StatCard label="Recommendation cards shown" value={engagement.impressions} contextLabel={rangeLabel} />
            <StatCard label="Recommendation cards clicked" value={engagement.clicks} contextLabel={rangeLabel} />
            <StatCard
              label="Click rate"
              value={engagement.impressions > 0 ? `${(engagement.ctr * 100).toFixed(2)}%` : "—"}
              contextLabel="clicks ÷ shown"
            />
            <StatCard
              label="Conversion rate"
              value={engagement.conversionRate > 0 ? `${(engagement.conversionRate * 100).toFixed(2)}%` : "—"}
              contextLabel="added to cart ÷ saw recommendations"
            />
          </MetricSection>
        </s-section>

        <s-section heading="Cart activity">
          <p className={analyticsStyles.sectionSubtext}>
            How often the cart was opened and what was in it at that moment. Not completed orders. {rangeLabel}.
          </p>
          <MetricSection>
            <StatCard label="Cart opens" value={cp.summary.totalDecisions} contextLabel={rangeLabel} />
            <StatCard label="Carts that saw recommendations" value={`${(cp.summary.showRate * 100).toFixed(1)}%`} contextLabel="of cart opens" />
            <StatCard label="Added to cart from recommendations" value={addRateDisplay} contextLabel="when recommendations were shown" />
            <StatCard label="Average cart total when opened" contextLabel={rangeLabel} value={formatCurrency(cp.summary.avgCartValue, CURRENCY)} />
            <StatCard label="Total cart value (sum when opened)" contextLabel={`${rangeLabel} — not revenue`} value={formatCurrency(cp.cartValueAtEvaluation, CURRENCY)} />
          </MetricSection>
        </s-section>

        <s-section heading="Cart opens over time">
          <p className={analyticsStyles.sectionSubtext}>
            Daily view for {rangeLabel}.
          </p>
          <MetricSection>
            <StatCard label="Cart opens (total)" value={totalDecisions} contextLabel={rangeLabel} />
            <StatCard
              label="Add rate"
              value={cp.summary.addRate > 1 ? cp.summary.addRate.toFixed(2) : `${(cp.summary.addRate * 100).toFixed(1)}%`}
              contextLabel="added from recommendations when shown"
            />
          </MetricSection>
          {cp.trend.length > 0 && (
            <div className={analyticsStyles.chartBlock}>
              <LineChart
                data={cp.trend.map((p) => ({ date: p.date, value: p.decisions }))}
                width={520}
                height={220}
                label="Cart opens by date"
                maxXLabels={8}
                className={analyticsStyles.trendChart}
              />
            </div>
          )}
        </s-section>

        <s-section heading="Revenue from paid orders">
          <p className={analyticsStyles.sectionSubtext}>
            Revenue from your store’s paid orders (we use the orders/paid webhook; permission is granted when you install the app). We don’t claim this is caused by the app.
          </p>
          <MetricSection>
            <StatCard label="Revenue" value={formatCurrency(metrics.revenue.revenueCents, CURRENCY)} contextLabel={`${rangeLabel} from paid orders`} />
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
