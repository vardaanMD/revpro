/**
 * Redis-backed catalog cache and warm function. Key: catalog:${shop}.
 * Payload: { updatedAt, products: MinimalProduct[] }. TTL: 1 hour.
 * Circuit breaker: after 3 consecutive Shopify Admin failures for a shop, skip fetch for 60s.
 */
import type { Product } from "@revpro/decision-engine";
import { getRedis, redisKey } from "~/lib/redis.server";
import { getCatalogForShop } from "~/lib/catalog.server";
import shopify from "~/shopify.server";
import { logWarn, logResilience } from "~/lib/logger.server";
import { prisma } from "~/lib/prisma.server";

const REDIS_TTL_SECONDS = 3600; // 1 hour
const CIRCUIT_OPEN_TTL_SECONDS = 60;
const CIRCUIT_FAILURES_WINDOW_SECONDS = 120;
const CIRCUIT_THRESHOLD = 3;

export interface MinimalProduct {
  id: string;
  variantId: string;
  priceCents: number;
  collections: string[];
  inStock: boolean;
  handle: string;
  title: string;
  imageUrl: string | null;
  tags?: string[];
  /** ISO date string for NEW_ARRIVALS strategy (product creation date). */
  createdAt?: string;
}

function catalogRedisKey(shop: string): string {
  return redisKey(shop, "catalog");
}

function productToMinimal(p: Product): MinimalProduct {
  const withCreatedAt = p as Product & { createdAt?: string };
  return {
    id: p.id,
    variantId: p.variantId,
    priceCents: p.price.amount,
    collections: p.collections ?? [],
    inStock: p.inStock,
    handle: p.handle ?? "",
    title: p.title,
    imageUrl: p.imageUrl ?? null,
    tags: (p as Product & { tags?: string[] }).tags,
    ...(typeof withCreatedAt.createdAt === "string"
      ? { createdAt: withCreatedAt.createdAt }
      : {}),
  };
}

function minimalToProduct(m: MinimalProduct, currency: string): Product {
  return {
    id: m.id,
    variantId: m.variantId,
    price: { amount: m.priceCents, currency },
    collections: m.collections ?? [],
    inStock: m.inStock,
    handle: m.handle,
    title: m.title,
    imageUrl: m.imageUrl,
    ...(m.tags ? { tags: m.tags } : {}),
  } as Product;
}

export type RedisCatalogPayload = {
  updatedAt: number;
  products: MinimalProduct[];
};

/**
 * Reads catalog from Redis for the shop and hydrates to Product[] with the given currency.
 * Returns null on miss, parse error, or Redis error.
 */
/**
 * Reads catalog from Redis. On Redis/parse error logs and returns null; never throws.
 */
export async function getCatalogFromRedis(
  shop: string,
  currency: string
): Promise<Product[] | null> {
  try {
    const redis = getRedis();
    const raw = await redis.get(catalogRedisKey(shop));
    if (raw == null || raw === "") return null;
    const parsed = JSON.parse(raw) as RedisCatalogPayload;
    if (!parsed || !Array.isArray(parsed.products)) return null;
    return parsed.products.map((m) => minimalToProduct(m, currency));
  } catch (err) {
    logResilience({
      shop,
      route: "catalog-warm",
      message: "Redis get catalog failed; continuing without cache",
      meta: { errorType: err instanceof Error ? err.name : "Unknown" },
    });
    return null;
  }
}

/**
 * Returns true if catalog circuit is open for this shop (Shopify Admin failed 3x in a row).
 * Uses Redis catalog:circuit:open:{shop} with 60s TTL.
 */
async function isCatalogCircuitOpen(shop: string): Promise<boolean> {
  try {
    const redis = getRedis();
    const key = redisKey(shop, "catalog", "circuit", "open");
    const v = await redis.get(key);
    return v === "1";
  } catch {
    return false;
  }
}

/**
 * Record Shopify Admin success: reset failure count so circuit can close.
 */
async function recordCatalogSuccess(shop: string): Promise<void> {
  try {
    const redis = getRedis();
    await redis.del(redisKey(shop, "catalog", "circuit", "failures"));
  } catch {
    // ignore
  }
}

/**
 * Record Shopify Admin failure. If 3 in a row, open circuit for 60s.
 */
async function recordCatalogFailure(shop: string): Promise<void> {
  try {
    const redis = getRedis();
    const key = redisKey(shop, "catalog", "circuit", "failures");
    const count = await redis.incr(key);
    if (count === 1) {
      await redis.expire(key, CIRCUIT_FAILURES_WINDOW_SECONDS);
    }
    if (count >= CIRCUIT_THRESHOLD) {
      await redis.set(redisKey(shop, "catalog", "circuit", "open"), "1", "EX", CIRCUIT_OPEN_TTL_SECONDS);
      logWarn({
        route: "catalog-warm",
        message: "Catalog circuit open: Shopify Admin failed 3 times in a row",
        meta: { shop, openForSeconds: CIRCUIT_OPEN_TTL_SECONDS },
      });
    }
  } catch {
    // ignore
  }
}

/**
 * Fetches catalog from Shopify Admin, writes to Redis (catalog:${shop}),
 * builds and stores catalog_index:${shop}, returns snapshot.
 * Uses shopify.unauthenticated.admin(shop) for the GraphQL client.
 * If circuit is open (3 consecutive failures), skips fetch and returns [].
 */
export async function warmCatalogForShop(shop: string): Promise<Product[]> {
  console.log("[CATALOG WARM TRACE] warmCatalogForShop ENTER", shop);
  if (await isCatalogCircuitOpen(shop)) {
    return [];
  }
  let products: Product[];
  try {
    const admin = await shopify.unauthenticated.admin(shop);
    const auth = admin?.admin ?? null;
    console.log("[CATALOG WARM TRACE] admin client created");
    if (!auth) return [];
    products = await getCatalogForShop(auth, shop, "USD");
    console.log("[CATALOG WARM TRACE] products fetched:", products.length);
  } catch (err) {
    await recordCatalogFailure(shop);
    throw err;
  }
  await recordCatalogSuccess(shop);
  console.log("[CATALOG WARM] fetched products:", products.length);

  // DB write first: persist catalog to ShopProduct so V2 bootstrap never depends on Redis.
  console.log("[CATALOG WARM TRACE] starting upserts");
  const now = new Date();
  for (const p of products) {
    const withCreatedAt = p as Product & { createdAt?: string };
    const createdAt = typeof withCreatedAt.createdAt === "string"
      ? new Date(withCreatedAt.createdAt)
      : now;
    const fields = {
      id: p.id,
      shopDomain: shop,
      title: p.title,
      handle: p.handle ?? "",
      variantId: p.variantId,
      featuredImageUrl: p.imageUrl ?? null,
      priceCents: p.price.amount,
      available: p.inStock,
      collectionIds: (p.collections ?? []) as unknown as object,
      createdAt,
      updatedAt: now,
    };
    await prisma.shopProduct.upsert({
      where: { shopDomain_id: { shopDomain: shop, id: p.id } },
      update: fields,
      create: fields,
    });
  }
  const verifyCount = await prisma.shopProduct.count({
    where: { shopDomain: shop },
  });
  console.log("[CATALOG WARM TRACE] DB count after warm:", verifyCount);
  console.log("[CATALOG WARM] DB count:", verifyCount);

  try {
    const redis = getRedis();
    const payload: RedisCatalogPayload = {
      updatedAt: Date.now(),
      products: products.map(productToMinimal),
    };
    await redis.set(catalogRedisKey(shop), JSON.stringify(payload), "EX", REDIS_TTL_SECONDS);
    // Build and store precomputed decision index (no per-request catalog transform).
    const { buildCatalogIndexFromSnapshot } = await import("~/lib/catalog-index.server");
    const index = buildCatalogIndexFromSnapshot(payload, "USD");
    await redis.set(
      redisKey(shop, "catalog_index"),
      JSON.stringify(index),
      "EX",
      REDIS_TTL_SECONDS
    );
  } catch (err) {
    logResilience({
      shop,
      route: "catalog-warm",
      message: "Redis set catalog failed; returning catalog without cache",
      meta: { errorType: err instanceof Error ? err.name : "Unknown" },
    });
  }
  return products;
}

/**
 * Triggers catalog warm in the background. Does not await.
 * Use when index is missing so the next request can hit a warm index.
 */
export function triggerAsyncCatalogWarm(shop: string): void {
  warmCatalogForShop(shop).catch(() => {
    // Fire-and-forget; failures logged by warmCatalogForShop or caller
  });
}
