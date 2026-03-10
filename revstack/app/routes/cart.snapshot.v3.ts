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
import { warmCatalogForShop } from "~/lib/catalog-warm.server";
import { prisma } from "~/lib/prisma.server";
import {
  buildCollectionAwareRecommendations,
  buildV3SnapshotPayload,
} from "~/lib/upsell-engine-v2/buildSnapshot";
import { parseMilestonesForUI } from "~/lib/settings-validation.server";

export async function loader({ request }: LoaderFunctionArgs) {
  try {
    await authenticate.public.appProxy(request);
  } catch (err) {
    console.error("[CartPro Snapshot V3] appProxy auth failed", err);
    // Return safe fallback so storefront UI still loads
    return Response.json(safeFallbackSnapshot(), {
      headers: { "Cache-Control": "no-store" },
    });
  }

  const shopRaw = new URL(request.url).searchParams.get("shop") ?? "";
  const shop = normalizeShopDomain(shopRaw);
  console.log("[CATALOG WARM TRACE] shop:", shop);
  if (!shop || shop === "unknown") {
    return Response.json(safeFallbackSnapshot(), {
      headers: { "Cache-Control": "no-store" },
    });
  }

  try {
    const count = await prisma.shopProduct.count({
      where: { shopDomain: shop },
    });
    console.log("[CATALOG WARM TRACE] count before warm:", count);
    if (count === 0) {
      console.log("[CATALOG WARM TRACE] calling warmCatalogForShop");
      await warmCatalogForShop(shop);
    }

    const rows = await prisma.shopProduct.findMany({
      where: { shopDomain: shop },
    });
    console.log("[CATALOG WARM TRACE] shopProduct rows:", rows);

    const shopConfig = await getShopConfig(shop);
    const billing = await getBillingContext(shop, shopConfig);

    const config = mergeWithDefaultV3(
      shopConfig.configV3 as Partial<CartProConfigV3> | null
    );
    const configV3: CartProConfigV3 = {
      ...config,
      featureFlags: {
        ...featureFlagsFromCapabilities(billing.capabilities),
        enableCheckoutOverride: true,
      },
      checkout: {
        mode: "overlay",
        overlay: { enabled: true, checkoutUrl: "/checkout" },
      },
    };

    let collectionAware: Awaited<ReturnType<typeof buildCollectionAwareRecommendations>> = {
      recommendationsByCollection: { default: [] },
      productToCollections: {},
    };
    try {
      collectionAware = await buildCollectionAwareRecommendations(shop);
    } catch (err) {
      console.log("[CartPro Snapshot V3] collection-aware recommendations build failed", err);
    }

    // Backward compat: clients that only read 'recommendations' get the same default list as before.
    const recommendations = collectionAware.recommendationsByCollection["default"] ?? [];

    console.log("[CartPro Snapshot] freeShipping threshold:", configV3.freeShipping?.thresholdCents);
    console.log("[CartPro Snapshot] teaseMessage:", configV3.discounts?.teaseMessage);
    console.log("[CartPro Snapshot] recommendations count:", recommendations.length);

    const runtimeVersion = configV3.runtimeVersion ?? "v3";

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
    };

    return Response.json(snapshotPayload, {
      headers: {
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    console.error("[CartPro Snapshot V3] loader failed, returning fallback", err);
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
    appearance: {
      primaryColor: "#333",
      accentColor: "#16a34a",
      borderRadius: 12,
      backgroundColor: "#ffffff",
      showConfetti: true,
      countdownEnabled: true,
      emojiMode: true,
      countdownDurationMs: 600000,
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
    discounts: { allowStacking: false, whitelist: [] },
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
