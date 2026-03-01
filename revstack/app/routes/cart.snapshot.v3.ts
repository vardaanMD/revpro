/**
 * App proxy path: /apps/cart-pro/snapshot/v3
 * Returns canonical CartProConfigV3 (mergeWithDefaultV3 + billing-derived featureFlags).
 * Recommendations from ShopProduct via shared helper (no V2 bootstrap). Billing gates feature flags.
 */
import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "~/shopify.server";
import { normalizeShopDomain } from "~/lib/shop-domain.server";
import { getShopConfig } from "~/lib/shop-config.server";
import { getBillingContext } from "~/lib/billing-context.server";
import type { Capabilities } from "~/lib/capabilities.server";
import {
  mergeWithDefaultV3,
  type CartProConfigV3,
  type CartProConfigV3FeatureFlags,
} from "~/lib/config-v3";
import { warmCatalogForShop } from "~/lib/catalog-warm.server";
import { prisma } from "~/lib/prisma.server";
import {
  getHydratedRecommendationsForShop,
  buildV3SnapshotPayload,
} from "~/lib/upsell-engine-v2/buildSnapshot";

/** Map billing capabilities to V3 feature flags. Billing gates features. */
function featureFlagsFromCapabilities(
  capabilities: Capabilities
): CartProConfigV3FeatureFlags {
  return {
    enableUpsell: capabilities.allowCrossSell ?? false,
    enableRewards: capabilities.allowMilestones ?? false,
    enableDiscounts: capabilities.allowCouponTease ?? false,
    enableFreeGifts: false,
    enableCheckoutOverride: false,
    enableAnalytics: capabilities.analyticsLevel === "advanced",
  };
}

export async function loader({ request }: LoaderFunctionArgs) {
  await authenticate.public.appProxy(request);
  const shopRaw = new URL(request.url).searchParams.get("shop") ?? "";
  const shop = normalizeShopDomain(shopRaw);
  console.log("[CATALOG WARM TRACE] shop:", shop);
  if (!shop || shop === "unknown") {
    return Response.json(
      { error: "Missing or invalid shop" },
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

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

  let recommendations: Awaited<ReturnType<typeof getHydratedRecommendationsForShop>> = [];
  try {
    recommendations = await getHydratedRecommendationsForShop(shop);
  } catch (err) {
    console.log("[CartPro Snapshot V3] recommendations build failed", err);
  }

  console.log("[CartPro Snapshot] freeShipping threshold:", configV3.freeShipping?.thresholdCents);
  console.log("[CartPro Snapshot] teaseMessage:", configV3.discounts?.teaseMessage);

  const runtimeVersion = configV3.runtimeVersion ?? "v2";

  const snapshotPayload = {
    ...buildV3SnapshotPayload(configV3),
    recommendations,
    runtimeVersion,
  };

  return Response.json(snapshotPayload, {
    headers: {
      "Cache-Control": "no-store",
    },
  });
}
