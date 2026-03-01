/**
 * App proxy path: /apps/cart-pro/ai/v2
 * AI overlay: same-collection recommendations for last added product.
 * Reads from ShopProduct table only. No Redis. If product not found, return empty array.
 */
import { data, type ActionFunctionArgs } from "react-router";
import { authenticate } from "~/shopify.server";
import { normalizeShopDomain } from "~/lib/shop-domain.server";
import { prisma } from "~/lib/prisma.server";
import { getShopConfig } from "~/lib/shop-config.server";
import { extractNumericProductId } from "~/lib/upsell-engine-v2/buildSnapshot";
import type { ProductSnapshot } from "~/lib/upsell-engine-v2/types";

const DEFAULT_RECOMMENDATION_LIMIT = 4;
const CURRENCY = "USD";

function dbRowToSnapshot(
  r: { id: string; variantId: string; title: string; featuredImageUrl: string | null; priceCents: number; handle: string; collectionIds: unknown }
): ProductSnapshot {
  const collections = Array.isArray(r.collectionIds) ? (r.collectionIds as string[]) : [];
  const productId = extractNumericProductId(r.id);
  return {
    id: r.id,
    productId,
    variantId: r.variantId,
    title: r.title,
    imageUrl: r.featuredImageUrl ?? null,
    price: r.priceCents,
    currency: CURRENCY,
    handle: r.handle,
    collections,
  };
}

export async function action({ request }: ActionFunctionArgs) {
  await authenticate.public.appProxy(request);
  const shopRaw = new URL(request.url).searchParams.get("shop") ?? "";
  const shop = normalizeShopDomain(shopRaw);
  if (!shop || shop === "unknown") {
    return data(
      { error: "Missing or invalid shop", products: [] as ProductSnapshot[] },
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  let lastAddedProductId = "";
  if (request.method === "POST") {
    try {
      const body = await request.json();
      lastAddedProductId = typeof body?.lastAddedProductId === "string" ? body.lastAddedProductId : "";
    } catch {
      return data(
        { products: [] as ProductSnapshot[] },
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
  }

  const rows = await prisma.shopProduct.findMany({ where: { shopDomain: shop } });
  const added = rows.find((r) => r.id === lastAddedProductId);
  if (!added) {
    return data(
      { products: [] as ProductSnapshot[] },
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }

  const collectionIds = Array.isArray(added.collectionIds) ? (added.collectionIds as string[]) : [];
  if (collectionIds.length === 0) {
    return data(
      { products: [] as ProductSnapshot[] },
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }

  const config = await getShopConfig(shop);
  const limit =
    typeof config.recommendationLimit === "number" && Number.isInteger(config.recommendationLimit)
      ? Math.max(1, config.recommendationLimit)
      : DEFAULT_RECOMMENDATION_LIMIT;

  const candidateIds = new Set<string>();
  for (const cid of collectionIds) {
    for (const r of rows) {
      const cols = Array.isArray(r.collectionIds) ? (r.collectionIds as string[]) : [];
      if (cols.includes(cid)) candidateIds.add(r.id);
    }
  }
  candidateIds.delete(lastAddedProductId);

  const products: ProductSnapshot[] = [];
  for (const id of candidateIds) {
    if (products.length >= limit) break;
    const r = rows.find((x) => x.id === id);
    if (r) products.push(dbRowToSnapshot(r));
  }

  return data(
    { products },
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}
