import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Outlet, useLoaderData, useLocation, useNavigation, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";

import { AppLink } from "~/components/AppLink";
import { LoadingBar } from "~/components/LoadingBar";
import appNavStyles from "~/styles/appNav.module.css";
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

  // 1) Authenticate (or use request context when set by custom server for GET /app/*)
  const ctx = getAppLayoutFromContext();
  let shop: string;
  let config: Awaited<ReturnType<typeof getShopConfig>>;
  if (ctx) {
    shop = ctx.shop;
    config = ctx.config;
    recordTiming("adminLayout", "auth", 0);
    recordTiming("adminLayout", "config", 0);
  } else {
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

  // 2) Billing gate: before dashboard/premium access, require entitlement; exempt billing/upgrade paths
  if (!billing.isEntitled && !pathMatches(pathname, BILLING_EXEMPT_PATHS)) {
    const redirectUrl = `/app/billing${url.search}`;
    throw new Response(null, { status: 302, headers: { Location: redirectUrl } });
  }

  // 3) Onboarding gate: if entitled but onboarding not complete, only allow onboarding or billing
  if (billing.isEntitled && !onboardingCompleted && !pathMatches(pathname, ONBOARDING_EXEMPT_PATHS)) {
    const redirectUrl = `/app/onboarding${url.search}`;
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

function isNavActive(pathname: string, to: string): boolean {
  const base = to.replace(/\?.*$/, "").replace(/#.*$/, "");
  if (base === "/app" || base === "/app/") {
    return pathname === "/app" || pathname === "/app/";
  }
  return pathname === base || pathname.startsWith(base + "/");
}

export default function App() {
  const { apiKey, onboardingCompleted, billing } = useLoaderData<typeof loader>();
  const location = useLocation();
  const navigation = useNavigation();
  const pathname = location.pathname;
  const isLoading = navigation.state === "loading" || navigation.state === "submitting";
  const isBillingActive = billing.isEntitled;
  const billingTo = billing.isEntitled ? "/app/billing" : "/app/upgrade";

  return (
    <AppProvider embedded apiKey={apiKey}>
      <LoadingBar isLoading={isLoading} />
      <s-app-nav role="navigation" aria-label="App navigation">
        <AppLink
          to="/app"
          className={isNavActive(pathname, "/app") ? appNavStyles.active : undefined}
          aria-current={isNavActive(pathname, "/app") ? "page" : undefined}
        >
          Overview
        </AppLink>
        <AppLink
          to="/app/additional"
          className={isNavActive(pathname, "/app/additional") ? appNavStyles.active : undefined}
          aria-current={isNavActive(pathname, "/app/additional") ? "page" : undefined}
        >
          Additional page
        </AppLink>
        {!onboardingCompleted && (
          <AppLink
            to="/app/onboarding"
            className={isNavActive(pathname, "/app/onboarding") ? appNavStyles.active : undefined}
            aria-current={isNavActive(pathname, "/app/onboarding") ? "page" : undefined}
          >
            Onboarding
          </AppLink>
        )}
        <AppLink
          to="/app/settings"
          className={isNavActive(pathname, "/app/settings") ? appNavStyles.active : undefined}
          aria-current={isNavActive(pathname, "/app/settings") ? "page" : undefined}
        >
          Settings
        </AppLink>
        <AppLink
          to="/app/analytics"
          className={isNavActive(pathname, "/app/analytics") ? appNavStyles.active : undefined}
          aria-current={isNavActive(pathname, "/app/analytics") ? "page" : undefined}
        >
          Analytics
        </AppLink>
        <AppLink
          to={billingTo}
          className={isNavActive(pathname, billingTo) ? appNavStyles.active : undefined}
          aria-current={isNavActive(pathname, billingTo) ? "page" : undefined}
        >
          {isBillingActive ? "Billing" : "Activate Plan"}
        </AppLink>
      </s-app-nav>

      <main role="main">
        <Outlet />
      </main>
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
