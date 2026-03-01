import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Outlet, useLoaderData, useNavigation, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";

import { AppLink } from "~/components/AppLink";
import { LoadingBar } from "~/components/LoadingBar";
import { authenticate } from "../shopify.server";
import { getShopConfig, getFallbackShopConfig } from "~/lib/shop-config.server";
import { getBillingContext } from "~/lib/billing-context.server";
import { logResilience } from "~/lib/logger.server";
import { ensureActivatedAt } from "~/lib/retention.server";
import { getAppLayoutFromContext, setAppLayoutInContext } from "~/lib/request-context.server";
import { normalizeShopDomain, warnIfShopNotCanonical } from "~/lib/shop-domain.server";
import type { Plan } from "~/lib/capabilities.server";
import { recordTiming, recordTotal } from "~/lib/dev-metrics.server";
import { performance } from "node:perf_hooks";

/**
 * APP FLOW ARCHITECTURE (production-grade Shopify embedded app)
 * ===========================================================
 * Stage 1 — Install: User installs → session + ShopConfig created. No billing required yet.
 * Stage 2 — Billing Gate: Before premium/dashboard access, require billing.isEntitled; else redirect to /app/billing.
 * Stage 3 — Onboarding: Verifies infrastructure (decision engine + wiring). Does NOT require DecisionMetric or live traffic.
 * Stage 4 — Runtime: Decision endpoint enforces billing; when !isEntitled returns safe response (no premium behavior).
 * Stage 5 — Analytics: DecisionMetric is observational only; optional "Live Traffic Verified" badge when count > 0.
 *
 * Layout loader order (server-side, no auth loop):
 *   1. authenticate.admin (or use request context when set by custom server)
 *   2. getShopConfig, ensureActivatedAt (when onboarding complete)
 *   3. getBillingContext
 *   4. BILLING GATE: if !billing.isEntitled and path not exempt → redirect /app/billing
 *   5. ONBOARDING GATE: if billing.isEntitled && !onboardingCompleted && path not exempt → redirect /app/onboarding
 *   6. render app
 * Exempt paths: billing = [/app/billing, /app/upgrade]; onboarding = [/app/onboarding, /app/billing].
 */

/** Route id for the app layout; use with useRouteLoaderData(APP_LAYOUT_ROUTE_ID) in child components to read config without duplicate loader calls. */
export const APP_LAYOUT_ROUTE_ID = "routes/app";

const BILLING_EXEMPT_PATHS = ["/app/billing", "/app/upgrade", "/app/dev/flush"];
const ONBOARDING_EXEMPT_PATHS = ["/app/onboarding", "/app/billing", "/app/dev/flush"];

function pathMatches(pathname: string, prefixes: string[]): boolean {
  return prefixes.some((p) => pathname === p || pathname.startsWith(p + "/"));
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const layoutStart = performance.now();
  const url = new URL(request.url);
  const pathname = url.pathname;
  const reqTag = `[PERF][${request.method} ${pathname}]`;
  const logPerf = process.env.NODE_ENV === "development";

  // 1) Authenticate (or use request context when set by custom server for GET /app/*)
  const ctx = getAppLayoutFromContext();
  let shop: string;
  let config: Awaited<ReturnType<typeof getShopConfig>>;
  if (ctx) {
    if (logPerf) console.log(`${reqTag} layout: using CONTEXT (no auth/getShopConfig)`);
    shop = ctx.shop;
    config = ctx.config;
    recordTiming("adminLayout", "auth", 0);
    recordTiming("adminLayout", "config", 0);
  } else {
    if (logPerf) console.log(`${reqTag} layout: FALLBACK authenticate.admin + getShopConfig`);
    const tAuthStart = performance.now();
    let auth: Awaited<ReturnType<typeof authenticate.admin>>;
    try {
      auth = await authenticate.admin(request);
    } catch (e) {
      if (e instanceof Response && e.status >= 300 && e.status < 400) throw e;
      logResilience({
        route: "app.layout",
        message: "authenticate.admin threw; redirecting to re-auth",
        meta: {
          errorType: "AuthFailure",
          redirecting: true,
          sessionPresent: false,
        },
      });
      if (pathname.startsWith("/auth")) throw e;
      const search = url.searchParams.toString();
      throw new Response(null, {
        status: 302,
        headers: { Location: search ? `/auth/login?${search}` : "/auth/login" },
      });
    }
    const authMs = performance.now() - tAuthStart;
    recordTiming("adminLayout", "auth", authMs);
    if (logPerf) console.log(`${reqTag} layout: authenticate.admin end ${authMs}ms`);
    const rawShop = auth.session.shop;
    shop = normalizeShopDomain(rawShop);
    warnIfShopNotCanonical(rawShop, shop);
    const tConfigStart = performance.now();
    try {
      config = await getShopConfig(shop);
    } catch (err) {
      logResilience({
        shop,
        route: "app.layout",
        message: "getShopConfig failed; using fallback config",
        meta: {
          errorType: err instanceof Error ? err.name : "Unknown",
          fallbackUsed: true,
          sessionPresent: true,
          redirecting: false,
        },
      });
      config = getFallbackShopConfig(shop);
    }
    const configMs = performance.now() - tConfigStart;
    recordTiming("adminLayout", "config", configMs);
    if (logPerf) console.log(`${reqTag} layout: getShopConfig end ${configMs}ms`);
    setAppLayoutInContext(shop, config, {
      session: auth.session,
      admin: auth.admin as import("~/lib/request-context.server").AppLayoutAuth["admin"],
      redirect: auth.redirect,
    });
  }

  const tEnsureStart = performance.now();
  if (config.onboardingCompleted) {
    await ensureActivatedAt(shop, {
      onboardingCompleted: config.onboardingCompleted,
      activatedAt: config.activatedAt ?? null,
    });
  }
  const ensureActivatedAtMs = performance.now() - tEnsureStart;
  recordTiming("adminLayout", "ensureActivatedAt", ensureActivatedAtMs);

  const tChildStart = performance.now();
  const billing = await getBillingContext(shop, config);
  const childLoaderMs = performance.now() - tChildStart;
  recordTiming("adminLayout", "childLoader", childLoaderMs);

  recordTotal("adminLayout", performance.now() - layoutStart);

  const onboardingCompleted = config.onboardingCompleted;

  if (process.env.NODE_ENV === "development") {
    console.log("[SHOP CONTEXT]", shop);
  }

  // 2) Billing gate: before dashboard/premium access, require entitlement; exempt billing/upgrade paths
  if (!billing.isEntitled && !pathMatches(pathname, BILLING_EXEMPT_PATHS)) {
    const redirectUrl = `/app/billing${url.search}`;
    if (logPerf) console.log(`${reqTag} layout: redirect to ${redirectUrl} (billing required)`);
    throw new Response(null, { status: 302, headers: { Location: redirectUrl } });
  }

  // 3) Onboarding gate: if entitled but onboarding not complete, only allow onboarding or billing
  if (billing.isEntitled && !onboardingCompleted && !pathMatches(pathname, ONBOARDING_EXEMPT_PATHS)) {
    const redirectUrl = `/app/onboarding${url.search}`;
    if (logPerf) console.log(`${reqTag} layout: redirect to ${redirectUrl} (onboarding incomplete)`);
    throw new Response(null, { status: 302, headers: { Location: redirectUrl } });
  }

  return {
    apiKey: process.env.SHOPIFY_API_KEY ?? "",
    config,
    billing,
    onboardingCompleted,
    onboardingStep: config.onboardingStep,
    billingStatus: billing.billingStatus,
    plan: billing.plan,
  };
};

export default function App() {
  const { apiKey, onboardingCompleted, billing } = useLoaderData<typeof loader>();
  const navigation = useNavigation();
  const isLoading = navigation.state === "loading" || navigation.state === "submitting";
  const isBillingActive = billing.isEntitled;

  return (
    <AppProvider embedded apiKey={apiKey}>
      <LoadingBar isLoading={isLoading} />
      <s-app-nav>
        <AppLink to="/app">Overview</AppLink>
        <AppLink to="/app/additional">Additional page</AppLink>
        {!onboardingCompleted && (
          <AppLink to="/app/onboarding">Onboarding</AppLink>
        )}
        <AppLink to="/app/settings">Settings</AppLink>
        <AppLink to="/app/analytics">Analytics</AppLink>
        <AppLink to={billing.isEntitled ? "/app/billing" : "/app/upgrade"}>
          {isBillingActive ? "Billing" : "Activate Plan"}
        </AppLink>
      </s-app-nav>

      <Outlet />
      <footer className="app-branding-footer" aria-label="App branding">
        RevPRO
      </footer>
    </AppProvider>
  );
}


// Shopify needs React Router to catch some thrown responses, so that their headers are included in the response.
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
