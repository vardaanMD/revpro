/**
 * Redis-backed catalog cache and warm function. Key: catalog:${shop}.
 * Payload: { updatedAt, products: MinimalProduct[] }. TTL: 1 hour.
 * Circuit breaker: after 3 consecutive Shopify Admin failures for a shop, skip fetch for 60s.
 */
import type { Product } from "@revpro/decision-engine";
import { getRedis, redisKey } from "~/lib/redis.server";
import { getCatalogForShop } from "~/lib/catalog.server";
import { getShopConfig } from "~/lib/shop-config.server";
import { getShopCurrency } from "~/lib/shop-currency.server";
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

// Lua: atomic INCR + EXPIRE on first count (no race between INCR and EXPIRE).
const CIRCUIT_FAILURES_LUA = `
  local c = redis.call('INCR', KEYS[1])
  if c == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
  return c
`;

/**
 * Record Shopify Admin failure. If 3 in a row, open circuit for 60s.
 */
async function recordCatalogFailure(shop: string): Promise<void> {
  try {
    const redis = getRedis();
    const key = redisKey(shop, "catalog", "circuit", "failures");
    const count = (await redis.eval(
      CIRCUIT_FAILURES_LUA,
      1,
      key,
      CIRCUIT_FAILURES_WINDOW_SECONDS
    )) as number;
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
 * Creates an AdminGraphQL-compatible adapter from a bare Shopify access token.
 * Used for single-site installs where no app session exists.
 */
function makeAdminFromToken(shop: string, accessToken: string) {
  return {
    async graphql(query: string, options?: { variables?: Record<string, unknown> }) {
      return fetch(`https://${shop}/admin/api/2024-10/graphql.json`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": accessToken,
        },
        body: JSON.stringify({ query, variables: options?.variables }),
      });
    },
  };
}

/**
 * Fetches catalog from Shopify Admin, writes to Redis (catalog:${shop}),
 * builds and stores catalog_index:${shop}, returns snapshot.
 * Uses shopify.unauthenticated.admin(shop) for the GraphQL client.
 * If accessToken is provided, uses it directly (for single-site installs without app session).
 * If circuit is open (3 consecutive failures), skips fetch and returns [].
 */
export async function warmCatalogForShop(shop: string, accessToken?: string): Promise<Product[]> {
  if (await isCatalogCircuitOpen(shop)) {
    return [];
  }
  let products: Product[];
  const config = await getShopConfig(shop);
  const currency = getShopCurrency(config);
  try {
    const auth = accessToken
      ? makeAdminFromToken(shop, accessToken)
      : (await shopify.unauthenticated.admin(shop))?.admin ?? null;
    if (!auth) return [];
    products = await getCatalogForShop(auth, shop, currency);
  } catch (err) {
    await recordCatalogFailure(shop);
    throw err;
  }
  await recordCatalogSuccess(shop);

  // DB write: persist catalog to ShopProduct so V2 bootstrap never depends on Redis.
  // Wrapped in a transaction so upserts + stale-product cleanup are atomic.
  const now = new Date();
  const fetchedIds = products.map((p) => p.id);
  const upsertOps = products.map((p) => {
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
    return prisma.shopProduct.upsert({
      where: { shopDomain_id: { shopDomain: shop, id: p.id } },
      update: fields,
      create: fields,
    });
  });
  // Remove products no longer in fetch (e.g. archived) so they don't appear in recommendations.
  const deleteOp = fetchedIds.length > 0
    ? prisma.shopProduct.deleteMany({
        where: { shopDomain: shop, id: { notIn: fetchedIds } },
      })
    : prisma.shopProduct.deleteMany({ where: { shopDomain: shop } });
  await prisma.$transaction([...upsertOps, deleteOp]);

  try {
    const redis = getRedis();
    const payload: RedisCatalogPayload = {
      updatedAt: Date.now(),
      products: products.map(productToMinimal),
    };
    await redis.set(catalogRedisKey(shop), JSON.stringify(payload), "EX", REDIS_TTL_SECONDS);
    // Build and store precomputed decision index (no per-request catalog transform).
    const { buildCatalogIndexFromSnapshot } = await import("~/lib/catalog-index.server");
    const index = buildCatalogIndexFromSnapshot(payload, currency);
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
