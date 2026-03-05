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

  const runtimeVersion = configV3.runtimeVersion ?? "v2";

  const snapshotPayload = {
    ...buildV3SnapshotPayload(configV3),
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
}
