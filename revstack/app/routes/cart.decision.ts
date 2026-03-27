/**
 * Storefront cart decision. Rate-limited; bounded writes (impressions ≤ recommendationLimit, 1 DecisionMetric).
 * Schema: DecisionMetric, CrossSellConversion use @@index([shopDomain, createdAt]).
 */
import crypto from "crypto";
import { performance } from "node:perf_hooks";
import { data, type ActionFunctionArgs, type LoaderFunctionArgs } from "react-router";
import {
  decideCartActions,
  type CartSnapshot,
  type CartItem,
  type Money,
  type StoreMetrics,
} from "@revpro/decision-engine";
import { prisma } from "~/lib/prisma.server";
import { getShopConfig } from "~/lib/shop-config.server";
import { getBillingContext } from "~/lib/billing-context.server";
import { normalizeShopDomain, warnIfShopNotCanonical } from "~/lib/shop-domain.server";
import {
  getCatalogIndexFromRedis,
  resolveStrategyCatalogFromIndex,
} from "~/lib/catalog-index.server";
import { getProductSalesCounts30d } from "~/lib/product-metrics.server";
import { triggerAsyncCatalogWarm } from "~/lib/catalog-warm.server";
import {
  checkRateLimitWithQuota,
  type RateLimitResult,
} from "~/lib/rate-limit.server";
import type { ZodIssue } from "zod";
import { cartSchema, type CartSchema } from "~/lib/validation.server";
import { withSafeHandler } from "~/lib/safe-handler.server";
import { requestContext } from "~/lib/request-context.server";
import { logInfo, logWarn, logResilience } from "~/lib/logger.server";
import type { DecisionResponse } from "~/lib/decision-response.server";
import {
  getCachedDecision,
  getCachedDecisionFromRedis,
  setMemoryCachedDecision,
  setCachedDecision,
  hashCartPayload,
  tryLockDecision,
  lockRetryDelayMs,
} from "~/lib/decision-cache.server";
import { verifyProxySignature, checkReplayTimestamp } from "~/lib/proxy-auth.server";
import { bearerTokenMatches } from "~/lib/auth-utils.server";
import { triggerCleanupIfNeeded } from "~/lib/cleanup.server";
import { recordTiming, recordTotal } from "~/lib/dev-metrics.server";

const MAX_PAYLOAD_BYTES = 50_000;
const MAX_CART_ITEMS = 100;

/** Default rate limit headers when no Redis rate limit call is made (e.g. cache hit). */
function defaultRateLimitHeaders(): RateLimitResult {
  const windowMs = 60_000;
  return {
    allowed: true,
    remaining: 60,
    limit: 60,
    resetAt: Date.now() + windowMs,
  };
}

/** All monetary amounts in cart, storeMetrics, and catalog are in cents. */

function toMoney(amount: number, currency: string): Money {
  return { amount, currency };
}

/**
 * Transforms validated cart payload into engine snapshot.
 * Unit contract: all monetary values (item prices, totals) are in cents.
 */
function transformValidatedCartToSnapshot(validated: CartSchema): { cart: CartSnapshot } {
  const transformedItems: CartItem[] = validated.items.map((item, index) => {
    const rawProductId = item.product_id ?? item.id;
    const productId =
      rawProductId !== undefined && rawProductId !== null
        ? String(rawProductId)
        : `product-${index}`;
    return {
      id: String(item.id ?? `item-${index}`),
      productId,
      quantity: item.quantity,
      unitPrice: toMoney(item.price, validated.currency),
    };
  });

  const cart: CartSnapshot = {
    id: "cart-decision",
    items: transformedItems,
  };

  return { cart };
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, Accept, X-Cart-Pro-Runtime",
};

function responseHeaders(
  requestId: string,
  responseTimeMs: number,
  rateLimit: RateLimitResult
): Record<string, string> {
  return {
    ...CORS_HEADERS,
    "X-Request-Id": requestId,
    "X-Response-Time": `${responseTimeMs}`,
    "X-RateLimit-Limit": `${rateLimit.limit}`,
    "X-RateLimit-Remaining": `${rateLimit.remaining}`,
    "X-RateLimit-Reset": `${Math.ceil(rateLimit.resetAt / 1000)}`,
  };
}

function safeDecisionResponse(): DecisionResponse {
  return {
    crossSell: [],
    freeShippingRemaining: 0,
    suppressCheckout: false,
    milestones: [],
    enableCouponTease: false,
  };
}

const DECISION_ROUTE = "cart.decision";

/** Hard time limit: abort catalog/engine and return SAFE_DECISION. Cart UX > perfect logic. */
const DECISION_TIMEOUT_MS = 300;

async function cartDecisionAction({ request }: ActionFunctionArgs) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  const requestId = crypto.randomUUID();
  const startTime = Date.now();
  const requestStartPerf = performance.now();

  const singleSiteToken = process.env.SINGLE_SITE_TOKEN;
  const singleSiteShop = process.env.SINGLE_SITE_SHOP;
  const isSingleSite = !!(
    singleSiteToken &&
    singleSiteShop &&
    bearerTokenMatches(request.headers.get("Authorization"), singleSiteToken)
  );

  let shopRaw = new URL(request.url).searchParams.get("shop") ?? "unknown";
  if (isSingleSite) shopRaw = singleSiteShop;
  let shop = normalizeShopDomain(shopRaw);
  warnIfShopNotCanonical(shopRaw, shop);

  logInfo({
    shop,
    requestId,
    route: DECISION_ROUTE,
    message: "Decision request start",
  });

  const runWithTiming = async (): Promise<ReturnType<typeof data>> => {
    let ctxRateLimit: RateLimitResult = defaultRateLimitHeaders();
    const responseTime = () => Date.now() - startTime;
    const overTime = () => Date.now() - startTime > DECISION_TIMEOUT_MS;

    const timings: Record<string, number> = {
      proxy: 0,
      replay: 0,
      rateLimit: 0,
      parse: 0,
      validation: 0,
      cacheLookup: 0,
      config: 0,
      catalog: 0,
      strategy: 0,
      engine: 0,
      cacheSet: 0,
      crossSellWrite: 0,
      decisionMetricWrite: 0,
      cleanup: 0,
      total: 0,
      cacheTime: 0,
      computeTime: 0,
      writeTime: 0,
    };
    let cacheHit = false;
    let usedSafeDecision = false;
    let catalogSource: "index" | "fallback" = "fallback";

    const logTiming = (extraMeta?: Record<string, unknown>): void => {
      timings.total = performance.now() - requestStartPerf;
      recordTotal("decision", timings.total);
      timings.cacheTime =
        timings.cacheLookup + timings.rateLimit + timings.config + timings.catalog;
      timings.computeTime = timings.strategy + timings.engine;
      timings.writeTime = timings.crossSellWrite + timings.decisionMetricWrite;
      const summary: Record<string, unknown> = {
        totalMs: Math.round(timings.total),
        cacheHit,
        usedSafeDecision,
        rateLimitMs: Math.round(timings.rateLimit),
        configMs: Math.round(timings.config),
        catalogMs: Math.round(timings.catalog),
        engineMs: Math.round(timings.engine),
        ...extraMeta,
      };
      logInfo({
        shop,
        requestId,
        route: DECISION_ROUTE,
        message: "Decision request end",
        meta: { summary },
      });
    };

    try {
      if (request.method !== "POST") {
        logTiming();
        return data(
          { error: "Method not allowed" },
          { status: 405, headers: responseHeaders(requestId, responseTime(), ctxRateLimit) }
        );
      }

      let t0 = performance.now();
      let proxyOk: boolean;
      let replayOk: boolean;
      if (isSingleSite) {
        proxyOk = true;
        replayOk = true;
      } else if (
        process.env.NODE_ENV === "development" &&
        process.env.DEV_SKIP_PROXY === "1"
      ) {
        proxyOk = true;
        replayOk = true;
      } else {
        proxyOk = verifyProxySignature(request);
        timings.proxy = performance.now() - t0;
        t0 = performance.now();
        replayOk = checkReplayTimestamp(request);
        timings.replay = performance.now() - t0;
      }
      if (!proxyOk || !replayOk) {
        logTiming();
        return data(
          { error: "Invalid proxy request" },
          { status: 401, headers: responseHeaders(requestId, responseTime(), ctxRateLimit) }
        );
      }

      let body: unknown;
      try {
        t0 = performance.now();
        const buf = await request.arrayBuffer();
        if (buf.byteLength > MAX_PAYLOAD_BYTES) {
          timings.parse = performance.now() - t0;
          logTiming();
          return data(
            { error: "Payload too large" },
            { status: 400, headers: responseHeaders(requestId, responseTime(), ctxRateLimit) }
          );
        }
        body = JSON.parse(new TextDecoder().decode(buf)) as unknown;
        timings.parse = performance.now() - t0;
      } catch (err) {
        logWarn({
          shop,
          requestId,
          route: DECISION_ROUTE,
          message: "Invalid JSON body in cart decision request",
          meta: { error: err instanceof Error ? err.message : String(err) },
        });
        logTiming();
        return data(
          {
            error: "Bad request",
            message: "Request body must be valid JSON (Shopify cart format).",
          },
          { status: 400, headers: responseHeaders(requestId, responseTime(), ctxRateLimit) }
        );
      }

      t0 = performance.now();
      const rawCart = body && typeof body === "object" && "cart" in body ? (body as { cart: unknown }).cart : body;
      const toValidate = rawCart ?? body;
      const parsed = cartSchema.safeParse(toValidate);

      if (!parsed.success) {
        timings.validation = performance.now() - t0;
        const message = parsed.error.issues.map((e: ZodIssue) => e.message).join("; ");
        logTiming();
        return data(
          { error: "Validation failed", message },
          { status: 400, headers: responseHeaders(requestId, responseTime(), ctxRateLimit) }
        );
      }

      const validatedCart = parsed.data;
      if (validatedCart.items.length > MAX_CART_ITEMS) {
        timings.validation = performance.now() - t0;
        logTiming();
        return data(
          { error: "Too many cart items" },
          { status: 400, headers: responseHeaders(requestId, responseTime(), ctxRateLimit) }
        );
      }
      timings.validation = performance.now() - t0;

      t0 = performance.now();
      const cartJson = JSON.stringify(validatedCart);
      const cartHash = hashCartPayload(cartJson);

      const cached = getCachedDecision(shop, cartHash);
      timings.cacheLookup = performance.now() - t0;

      if (cached) {
        cacheHit = true;
        logTiming();
        return data(cached, {
          headers: responseHeaders(requestId, responseTime(), ctxRateLimit),
        });
      }

      // 2) Check Redis decision cache (cross-replica)
      if (overTime()) {
        usedSafeDecision = true;
        logTiming();
        return data(safeDecisionResponse(), {
          headers: responseHeaders(requestId, responseTime(), ctxRateLimit),
        });
      }
      t0 = performance.now();
      const redisCached = await getCachedDecisionFromRedis(shop, cartHash);
      timings.cacheLookup += performance.now() - t0;

      if (redisCached) {
        cacheHit = true;
        setMemoryCachedDecision(shop, cartHash, redisCached);
        logTiming();
        return data(redisCached, {
          headers: responseHeaders(requestId, responseTime(), ctxRateLimit),
        });
      }

      if (overTime()) {
        usedSafeDecision = true;
        logTiming();
        return data(safeDecisionResponse(), {
          headers: responseHeaders(requestId, responseTime(), ctxRateLimit),
        });
      }
      const rateLimitStart = performance.now();
      ctxRateLimit = await checkRateLimitWithQuota(shop);
      timings.rateLimit = performance.now() - rateLimitStart;
      recordTiming("decision", "rateLimit", timings.rateLimit);
      const store = requestContext.getStore();
      if (store) store.rateLimit = ctxRateLimit;
      if (!ctxRateLimit.allowed) {
        logWarn({
          shop,
          requestId,
          route: DECISION_ROUTE,
          message: "Rate limit exceeded",
          meta: { resetAt: ctxRateLimit.resetAt },
        });
        logTiming();
        return data(
          { error: "Too many requests" },
          { status: 429, headers: responseHeaders(requestId, responseTime(), ctxRateLimit) }
        );
      }

      // Config (Prisma only on cache miss; allowed for config)
      let config: Awaited<ReturnType<typeof getShopConfig>>;
      try {
        t0 = performance.now();
        config = await getShopConfig(shop);
        timings.config = performance.now() - t0;

        recordTiming("decision", "config", timings.config);
      } catch (err) {
        usedSafeDecision = true;
        logResilience({
          shop,
          requestId,
          route: DECISION_ROUTE,
          message: "SAFE_DECISION fallback used: config load failed",
          meta: {
            errorType: err instanceof Error ? err.name : "Unknown",
            fallbackUsed: true,
            decisionOutcome: "safe_fallback",
            stack: process.env.NODE_ENV === "development" && err instanceof Error ? err.stack : undefined,
          },
        });
        logTiming();
        return data(safeDecisionResponse(), {
          headers: responseHeaders(requestId, responseTime(), ctxRateLimit),
        });
      }

      // Billing gate: before any catalog fetch, decision computation, or metric writes
      const billing = await getBillingContext(shop, config);

      if (!billing.isEntitled) {
        usedSafeDecision = true;
        logResilience({
          shop,
          requestId,
          route: DECISION_ROUTE,
          message: "Decision request: not entitled, returning safe fallback",
          meta: {
            billingState: billing.billingStatus,
            isEntitled: false,
            decisionExecuted: false,
            fallbackUsed: true,
          },
        });
        logTiming();
        return data(safeDecisionResponse(), {
          headers: responseHeaders(requestId, responseTime(), ctxRateLimit),
        });
      }

      // Prebuilt index only; no Admin API, no catalog transform per request
      if (overTime()) {
        usedSafeDecision = true;
        logTiming();
        return data(safeDecisionResponse(), {
          headers: responseHeaders(requestId, responseTime(), ctxRateLimit),
        });
      }
      t0 = performance.now();
      const index = await getCatalogIndexFromRedis(shop);
      timings.catalog = performance.now() - t0;

      recordTiming("decision", "catalog", timings.catalog);
      if (!index) {
        usedSafeDecision = true;
        triggerAsyncCatalogWarm(shop);
        catalogSource = "fallback";
        logWarn({
          shop,
          requestId,
          route: DECISION_ROUTE,
          message: "SAFE_DECISION fallback used: no catalog index; async warm triggered",
          meta: { catalogSource: "fallback" },
        });
        logTiming();
        return data(safeDecisionResponse(), {
          headers: responseHeaders(requestId, responseTime(), ctxRateLimit),
        });
      }
      catalogSource = "index";

      if (overTime()) {
        usedSafeDecision = true;
        logTiming();
        return data(safeDecisionResponse(), {
          headers: responseHeaders(requestId, responseTime(), ctxRateLimit),
        });
      }
      // Concurrency guard: avoid duplicate compute under burst
      const lockAcquired = await tryLockDecision(shop, cartHash);
      if (!lockAcquired) {
        await new Promise((r) => setTimeout(r, lockRetryDelayMs()));
        const retryCached = await getCachedDecisionFromRedis(shop, cartHash);
        if (retryCached) {
          cacheHit = true;
          setMemoryCachedDecision(shop, cartHash, retryCached);
          logTiming();
          return data(retryCached, {
            headers: responseHeaders(requestId, responseTime(), ctxRateLimit),
          });
        }
        usedSafeDecision = true;
        logWarn({
          shop,
          requestId,
          route: DECISION_ROUTE,
          message: "SAFE_DECISION fallback used: lock contention, no cache after retry",
        });
        logTiming();
        return data(safeDecisionResponse(), {
          headers: responseHeaders(requestId, responseTime(), ctxRateLimit),
        });
      }

      if (overTime()) {
        usedSafeDecision = true;
        logTiming();
        return data(safeDecisionResponse(), {
          headers: responseHeaders(requestId, responseTime(), ctxRateLimit),
        });
      }
    const capabilities = billing.capabilities;

    // AUDIT: All entitlement enforcement flows through capabilities only. No plan checks.
    // If a capability is false, the corresponding field must not be configurable via request or config override.
    // Request body is cart-only (validated by cartSchema); strategy and recommendationLimit are never read from body.

    if (process.env.NODE_ENV !== "production") {
      if (!capabilities.allowStrategySelection && config.recommendationStrategy !== "COLLECTION_MATCH") {
        logWarn({
          shop,
          requestId,
          route: DECISION_ROUTE,
          message: "[dev] allowStrategySelection=false but config.recommendationStrategy !== COLLECTION_MATCH; effectiveStrategy will be COLLECTION_MATCH",
          meta: { recommendationStrategy: config.recommendationStrategy },
        });
      }
    }

    let response: DecisionResponse;
    try {
      const { cart } = transformValidatedCartToSnapshot(validatedCart);
      const storeMetrics: StoreMetrics = {
        currency: validatedCart.currency,
        baselineAOV: {
          amount: config.baselineAovCents,
          currency: validatedCart.currency,
        },
        freeShippingThreshold: {
          amount: config.freeShippingThresholdCents,
          currency: validatedCart.currency,
        },
      };

      const manualCollectionIds = Array.isArray(config.manualCollectionIds)
        ? (config.manualCollectionIds as string[])
        : [];
      const effectiveStrategy = capabilities.allowStrategySelection
        ? config.recommendationStrategy
        : "COLLECTION_MATCH";
      // Select/slice from prebuilt index only; no catalog transform per request

      t0 = performance.now();
      let strategyCatalog = resolveStrategyCatalogFromIndex(
        index,
        effectiveStrategy,
        cart,
        manualCollectionIds
      );
      if (effectiveStrategy === "BEST_SELLING") {
        const salesCounts = await getProductSalesCounts30d(shop);
        const hasAnySales =
          Object.keys(salesCounts).length > 0 &&
          Object.values(salesCounts).some((n) => n > 0);
        if (!hasAnySales) {
          logWarn({
            shop,
            requestId,
            route: DECISION_ROUTE,
            message: "BEST_SELLING fallback to COLLECTION_MATCH: no sales data",
            meta: {},
          });
          strategyCatalog = resolveStrategyCatalogFromIndex(
            index,
            "COLLECTION_MATCH",
            cart,
            manualCollectionIds
          );
        } else {
          strategyCatalog = strategyCatalog.map((p) => ({
            ...p,
            salesCount: salesCounts[p.id] ?? 0,
          }));
        }
      }
      timings.strategy = performance.now() - t0;

      const cartProDebug = process.env.NODE_ENV !== "production" && process.env.CART_PRO_DEBUG === "1";
      t0 = performance.now();
      const decision = decideCartActions({
        cart,
        catalog: strategyCatalog,
        storeMetrics,
        strategy: effectiveStrategy,
        debug: cartProDebug,
      });
      timings.engine = performance.now() - t0;

      recordTiming("decision", "engine", timings.engine);

      const milestonesRaw =
        capabilities.allowMilestones && config.enableMilestones && Array.isArray(config.milestonesJson)
          ? (config.milestonesJson as unknown[])
          : [];
      const filteredMilestones = capabilities.allowMilestones ? milestonesRaw : [];

      const crossSellEnabled = capabilities.allowCrossSell && config.enableCrossSell;
      // Cap by capability: config may request more; we never exceed maxCrossSell (blocks request tampering).
      const recommendationLimit =
        typeof config.recommendationLimit === "number" && Number.isInteger(config.recommendationLimit)
          ? config.recommendationLimit
          : 4;
      const effectiveLimit = Math.min(
        Math.max(1, recommendationLimit),
        capabilities.maxCrossSell
      );
      const crossSellRaw = Array.isArray(decision.crossSell) ? decision.crossSell : [];
      const crossSell = crossSellEnabled
        ? crossSellRaw.slice(0, effectiveLimit)
        : [];

      // Only attach crossSellDebug/decisionLog when defined; avoid undefined properties in response payload.
      response = {
        crossSell,
        freeShippingRemaining: decision.freeShippingRemaining ?? 0,
        suppressCheckout: decision.suppressCheckout,
        milestones: capabilities.allowMilestones ? filteredMilestones : [],
        enableCouponTease: capabilities.allowCouponTease && config.enableCouponTease,
        ...(decision.crossSellDebug != null ? { crossSellDebug: decision.crossSellDebug } : {}),
        ...(cartProDebug && Array.isArray(decision.decisionLog) ? { decisionLog: decision.decisionLog } : {}),
      };
    } catch (err) {
      usedSafeDecision = true;
      logWarn({
        shop,
        requestId,
        route: DECISION_ROUTE,
        message: "SAFE_DECISION fallback used: decision build failed",
        meta: { error: err instanceof Error ? err.message : String(err) },
      });
      response = safeDecisionResponse();
    }

    t0 = performance.now();
    await setCachedDecision(shop, cartHash, response);
    timings.cacheSet = performance.now() - t0;


    // Double-layer safety: never write metrics when not entitled (guards against refactor moving logic)
    const tDbWrite = performance.now();
    if (billing.isEntitled) {
      if (response.crossSell.length > 0) {
        const cartValue = validatedCart.total_price;
        t0 = performance.now();
        const impressionData = response.crossSell.map((product) => ({
          shopDomain: shop,
          productId: product.id,
          eventType: "impression" as const,
          cartValue,
        }));
        try {
          await prisma.crossSellEvent.createMany({ data: impressionData });
        } catch (err) {
          logWarn({
            shop,
            requestId,
            route: DECISION_ROUTE,
            message: "CrossSellEvent createMany failed",
            meta: { error: err instanceof Error ? err.message : String(err) },
          });
        }
        timings.crossSellWrite = performance.now() - t0;
      }

      // V3 runtime sends cart:evaluated to analytics v3; skip DecisionMetric here to avoid double-count.
      const isV3Runtime = request.headers.get("X-Cart-Pro-Runtime") === "v3";
      const tMetricStart = performance.now();
      if (!isV3Runtime) {
        const metricData = {
          shopDomain: shop,
          hasCrossSell: response.crossSell.length > 0,
          cartValue: validatedCart.total_price,
        };
        try {
          await prisma.decisionMetric.create({ data: metricData });
        } catch (err) {
          logWarn({
            shop,
            requestId,
            route: DECISION_ROUTE,
            message: "DecisionMetric create failed",
            meta: { error: err instanceof Error ? err.message : String(err) },
          });
        }
      }
      timings.decisionMetricWrite = performance.now() - tMetricStart;
    }
    const dbWriteMs = performance.now() - tDbWrite;
    recordTiming("decision", "dbWrite", dbWriteMs);

    t0 = performance.now();
    void triggerCleanupIfNeeded();
    timings.cleanup = performance.now() - t0;

    logTiming({
      billingState: billing.billingStatus,
      isEntitled: billing.isEntitled,
      decisionExecuted: !usedSafeDecision,
      fallbackUsed: usedSafeDecision,
    });

    return data(response, {
      headers: responseHeaders(requestId, Date.now() - startTime, ctxRateLimit),
    });
    } catch (err: unknown) {
      usedSafeDecision = true;
      const responseTimeMs = Date.now() - startTime;
      logWarn({
        shop,
        requestId,
        route: DECISION_ROUTE,
        message: "SAFE_DECISION fallback used: decision request failed",
        meta: { error: err instanceof Error ? err.message : String(err) },
      });
      try {
        logTiming();
      } catch {
        // ignore log failures
      }
      return data(safeDecisionResponse(), {
        status: 200,
        headers: responseHeaders(requestId, responseTimeMs, defaultRateLimitHeaders()),
      });
    }
  };

  return requestContext.run({ requestId }, () => runWithTiming());
}

/** GET returns 200 "ok" so you can verify app proxy reachability (e.g. open https://<tunnel>/cart/decision). */
export function loader(_args: LoaderFunctionArgs) {
  return new Response("ok", {
    status: 200,
    headers: { "Content-Type": "text/plain" },
  });
}

export const action = withSafeHandler(cartDecisionAction) as typeof cartDecisionAction;
