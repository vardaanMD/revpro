/**
 * App proxy path: /apps/cart-pro/snapshot/v3
 * Returns canonical CartProConfigV3 (mergeWithDefaultV3 + billing-derived featureFlags).
 * Recommendations from ShopProduct via shared helper (no V2 bootstrap). Billing gates feature flags.
 * Never throws 500 — returns safe fallback on any error so storefront UI always renders.
 */
import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "~/shopify.server";
import { normalizeShopDomain } from "~/lib/shop-domain.server";
import { getShopConfig } from "~/lib/shop-config.server";
import { getBillingContext } from "~/lib/billing-context.server";
import { featureFlagsFromCapabilities } from "~/lib/feature-flags-from-billing.server";
import {
  mergeWithDefaultV3,
  type CartProConfigV3,
} from "~/lib/config-v3";
import { getShopCurrency } from "~/lib/shop-currency.server";
import { triggerAsyncCatalogWarm } from "~/lib/catalog-warm.server";
import { prisma } from "~/lib/prisma.server";
import {
  buildCollectionAwareRecommendationsWithContext,
  buildV3SnapshotPayload,
} from "~/lib/upsell-engine-v2/buildSnapshot";
import { parseMilestonesForUI } from "~/lib/settings-validation.server";
import { logWarn } from "~/lib/logger.server";

/** In-memory cache for shopProduct count to avoid querying on every request. */
const catalogCountCache = new Map<string, { count: number; ts: number }>();
const CATALOG_COUNT_TTL_MS = 60_000; // 1 minute

async function getShopProductCount(shop: string): Promise<number> {
  const cached = catalogCountCache.get(shop);
  if (cached && Date.now() - cached.ts < CATALOG_COUNT_TTL_MS) {
    return cached.count;
  }
  const count = await prisma.shopProduct.count({ where: { shopDomain: shop } });
  catalogCountCache.set(shop, { count, ts: Date.now() });
  return count;
}

export async function loader({ request }: LoaderFunctionArgs) {
  try {
    await authenticate.public.appProxy(request);
  } catch {
    // Return safe fallback so storefront UI still loads
    return Response.json(safeFallbackSnapshot(), {
      headers: { "Cache-Control": "no-store" },
    });
  }

  const shopRaw = new URL(request.url).searchParams.get("shop") ?? "";
  const shop = normalizeShopDomain(shopRaw);
  if (!shop || shop === "unknown") {
    return Response.json(safeFallbackSnapshot(), {
      headers: { "Cache-Control": "no-store" },
    });
  }

  try {
    const count = await getShopProductCount(shop);
    // When catalog is empty, do not block snapshot on warm (CART_FIRST_LOAD_IMPROVEMENT_PLAN Task 1).
    // Trigger warm in background so next request gets full recommendations.
    if (count === 0) {
      triggerAsyncCatalogWarm(shop);
    }

    const shopConfig = await getShopConfig(shop);
    const billing = await getBillingContext(shop, shopConfig);

    const config = mergeWithDefaultV3(
      shopConfig.configV3 as Partial<CartProConfigV3> | null
    );
    const billingFlags = featureFlagsFromCapabilities(billing.capabilities);
    const configV3: CartProConfigV3 = {
      ...config,
      featureFlags: {
        ...billingFlags,
        enableRewards: (config.featureFlags?.enableRewards ?? true) && billingFlags.enableRewards,
        enableCheckoutOverride: true,
      },
      checkout: {
        mode: "overlay",
        overlay: { enabled: true, checkoutUrl: "/checkout" },
      },
      // Align analytics.enabled with capabilities (same source as featureFlags.enableAnalytics).
      analytics: {
        ...config.analytics,
        enabled: featureFlagsFromCapabilities(billing.capabilities).enableAnalytics,
      },
    };

    let collectionAware: Awaited<ReturnType<typeof buildCollectionAwareRecommendationsWithContext>> = {
      recommendationsByCollection: { default: [] },
      productToCollections: {},
    };
    if (count > 0) {
      try {
        collectionAware = await buildCollectionAwareRecommendationsWithContext(shop, shopConfig, billing);
      } catch {
        // collection-aware recommendations build failed — use empty default
      }
    }

    // Backward compat: clients that only read 'recommendations' get the same default list as before.
    const recommendations = collectionAware.recommendationsByCollection["default"] ?? [];

    // Cart drawer is always V3; payload always reports v3 for compatibility.
    const runtimeVersion = "v3";

    // Backfill rewards.tiers from flat milestonesJson when configV3 has none (e.g. pre-migration or never saved from settings).
    let configForPayload: CartProConfigV3 = configV3;
    const tiersFromV3 = configV3.rewards?.tiers;
    if ((!Array.isArray(tiersFromV3) || tiersFromV3.length === 0) && shopConfig.milestonesJson != null) {
      const flatTiers = parseMilestonesForUI(shopConfig.milestonesJson);
      if (flatTiers.length > 0) {
        configForPayload = {
          ...configV3,
          rewards: {
            ...configV3.rewards,
            tiers: flatTiers as unknown[],
          },
        };
      }
    }

    const snapshotPayload = {
      ...buildV3SnapshotPayload(configForPayload),
      recommendationsByCollection: collectionAware.recommendationsByCollection,
      productToCollections: collectionAware.productToCollections,
      recommendations,
      runtimeVersion,
      currency: getShopCurrency(shopConfig),
    };

    return Response.json(snapshotPayload, {
      headers: {
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    logWarn({
      shop,
      route: "cart.snapshot.v3",
      message: "Snapshot failed, returning safe fallback",
      meta: { error: err instanceof Error ? err.message : String(err), stack: err instanceof Error ? err.stack : undefined },
    });
    return Response.json(safeFallbackSnapshot(), {
      headers: { "Cache-Control": "no-store" },
    });
  }
}

/** Safe fallback snapshot so the storefront UI always renders with defaults. */
function safeFallbackSnapshot() {
  return {
    version: "3.0.0",
    runtimeVersion: "v3",
    currency: "USD",
    appearance: {
      primaryColor: "#333",
      accentColor: "#16a34a",
      borderRadius: 12,
      backgroundColor: "#ffffff",
      bannerBackgroundColor: "#16a34a",
      showConfetti: true,
      countdownEnabled: true,
      emojiMode: true,
      countdownDurationMs: 600000,
      showHeaderBanner: true,
    },
    featureFlags: {
      enableUpsell: true,
      enableRewards: true,
      enableDiscounts: true,
      enableFreeGifts: true,
      enableCheckoutOverride: false,
      enableAnalytics: true,
    },
    rewards: { tiers: [], milestones: [] },
    discounts: { allowStacking: false, whitelist: [], teaseMessage: "Apply coupon at checkout to unlock savings", showTeaseMessage: true },
    freeGifts: { rules: [] },
    upsell: { standardRules: [], ai: { enabled: false } },
    checkout: { mode: "default", overlay: { enabled: false } },
    analytics: { enabled: true },
    freeShipping: { enabled: false },
    recommendations: [],
    recommendationsByCollection: { default: [] },
    productToCollections: {},
  };
}
