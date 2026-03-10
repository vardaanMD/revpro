/**
 * @deprecated This route is no longer active. Archived for reference.
 * App proxy path: /apps/cart-pro/snapshot/v2
 * Snapshot JSON for Liquid embedding only. No Redis, no SAFE, no locking.
 * Same shape as bootstrap.v2 (including engineVersion: "v2").
 */
import { data, type LoaderFunctionArgs } from "react-router";
import { authenticate } from "~/shopify.server";
import { normalizeShopDomain } from "~/lib/shop-domain.server";
import { buildBootstrapSnapshotV2 } from "~/lib/upsell-engine-v2/buildSnapshot";

export async function loader({ request }: LoaderFunctionArgs) {
  await authenticate.public.appProxy(request);
  const shopRaw = new URL(request.url).searchParams.get("shop") ?? "";
  const shop = normalizeShopDomain(shopRaw);
  if (!shop || shop === "unknown") {
    return data(
      { error: "Missing or invalid shop" },
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  const snapshot = await buildBootstrapSnapshotV2(shop);
  return data(
    { ...snapshot, engineVersion: "v2" },
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}
