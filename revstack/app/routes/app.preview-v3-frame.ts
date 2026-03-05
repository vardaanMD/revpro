/**
 * Returns HTML document for V3 preview iframe: sets __CART_PRO_V3_SNAPSHOT__ and loads cart-pro-v3.js.
 * Uses same snapshot shape as cart.snapshot.v3 (mergeWithDefaultV3 + featureFlags + recommendations).
 * Auth: runs under app layout (runAppAuth); uses getAppLayoutFromContext for shop/config.
 */
import type { LoaderFunctionArgs } from "react-router";
import { getAppLayoutFromContext } from "~/lib/request-context.server";
import { getShopConfig } from "~/lib/shop-config.server";
import { getBillingContext } from "~/lib/billing-context.server";
import { featureFlagsFromCapabilities } from "~/lib/feature-flags-from-billing.server";
import { normalizeShopDomain } from "~/lib/shop-domain.server";
import { mergeWithDefaultV3, type CartProConfigV3 } from "~/lib/config-v3";
import {
  getHydratedRecommendationsForShop,
  buildV3SnapshotPayload,
} from "~/lib/upsell-engine-v2/buildSnapshot";
import { authenticate } from "~/shopify.server";

function escapeJsonForScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

export async function loader({ request }: LoaderFunctionArgs) {
  const ctx = getAppLayoutFromContext();
  let shop: string;
  let config: Awaited<ReturnType<typeof getShopConfig>>;
  if (ctx) {
    shop = ctx.shop;
    config = ctx.config;
  } else {
    const auth = await authenticate.admin(request);
    shop = normalizeShopDomain(auth.session.shop);
    config = await getShopConfig(shop);
  }

  const billing = await getBillingContext(shop, config);
  const configMerged = mergeWithDefaultV3(
    config.configV3 as Partial<CartProConfigV3> | null
  );
  const configV3: CartProConfigV3 = {
    ...configMerged,
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
  } catch {
    // use empty list
  }

  const runtimeVersion = configV3.runtimeVersion ?? "v3";
  const snapshotPayload = {
    ...buildV3SnapshotPayload(configV3),
    recommendations,
    runtimeVersion,
  };

  const scriptPath = "/extensions-assets/cart-pro-v3.js";
  const snapshotJson = escapeJsonForScript(snapshotPayload);

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Cart Pro V3 Preview</title>
  <style>
    body { margin: 0; min-height: 100vh; background: #f5f5f5; }
    #cart-pro-root { position: fixed; inset: 0; width: 100vw; height: 100vh; }
  </style>
</head>
<body>
  <div id="cart-pro-root"></div>
  <script>
    window.__CART_PRO_V3_SNAPSHOT__ = ${snapshotJson};
  </script>
  <script src="${scriptPath}" defer></script>
</body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
