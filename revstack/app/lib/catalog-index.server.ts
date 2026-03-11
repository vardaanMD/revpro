/**
 * Precomputed decision-ready catalog index. Pure transform of Redis catalog snapshot.
 * No Shopify calls. No Prisma. Used for O(1) warm decision path.
 */
import type { Product } from "@revpro/decision-engine";
import type { CartSnapshot } from "@revpro/decision-engine";
import type { RedisCatalogPayload, MinimalProduct } from "~/lib/catalog-warm.server";
import { getRedis, redisKey } from "~/lib/redis.server";
import { logWarn } from "~/lib/logger.server";

/** Minimal product shape for decision; JSON-serializable. */
export interface ProductLite {
  id: string;
  variantId: string;
  priceCents: number;
  collections: string[];
  inStock: boolean;
  handle: string;
  title: string;
  imageUrl: string | null;
  tags?: string[];
  /** ISO date string for NEW_ARRIVALS strategy. */
  createdAt?: string;
}

/**
 * JSON-serializable catalog index. Stored at catalog_index:${shop}.
 * Decision route only selects/slices from these structures; no per-request catalog transform.
 */
export interface CatalogIndexSerialized {
  updatedAt: number;
  currency: string;
  /** id -> ProductLite */
  productsById: Record<string, ProductLite>;
  /** In-stock products for cross-sell; capped. */
  crossSellCandidates: ProductLite[];
  /** collectionId -> product ids (for COLLECTION_MATCH / MANUAL_COLLECTION). */
  collectionMap: Record<string, string[]>;
  /** tag -> product ids (for TAG_MATCH). */
  tagMap: Record<string, string[]>;
}

const MAX_PRODUCTS = 200;
const MAX_INDEX_JSON_BYTES = 512 * 1024; // 512 KB

function minimalToProductLite(m: MinimalProduct): ProductLite {
  return {
    id: m.id,
    variantId: m.variantId,
    priceCents: m.priceCents,
    collections: m.collections ?? [],
    inStock: m.inStock,
    handle: m.handle ?? "",
    title: m.title,
    imageUrl: m.imageUrl ?? null,
    ...(m.tags && m.tags.length > 0 ? { tags: m.tags } : {}),
    ...(typeof m.createdAt === "string" ? { createdAt: m.createdAt } : {}),
  };
}

/**
 * Builds a decision-ready index from a Redis catalog snapshot.
 * Pure transform: no I/O. Cap product count and warn on large payload.
 */
export function buildCatalogIndexFromSnapshot(
  payload: RedisCatalogPayload,
  currency: string
): CatalogIndexSerialized {
  const products = Array.isArray(payload.products) ? payload.products : [];
  const capped = products.slice(0, MAX_PRODUCTS);

  const productsById: Record<string, ProductLite> = {};
  const crossSellCandidates: ProductLite[] = [];
  const collectionMap: Record<string, string[]> = {};
  const tagMap: Record<string, string[]> = {};

  for (const m of capped) {
    const lite = minimalToProductLite(m);
    productsById[m.id] = lite;
    if (m.inStock) {
      crossSellCandidates.push(lite);
    }
    for (const cid of m.collections ?? []) {
      if (!collectionMap[cid]) collectionMap[cid] = [];
      collectionMap[cid].push(m.id);
    }
    const tags = (m as MinimalProduct & { tags?: string[] }).tags;
    if (Array.isArray(tags)) {
      for (const t of tags) {
        if (typeof t === "string" && t) {
          if (!tagMap[t]) tagMap[t] = [];
          tagMap[t].push(m.id);
        }
      }
    }
  }

  const index: CatalogIndexSerialized = {
    updatedAt: payload.updatedAt ?? Date.now(),
    currency,
    productsById,
    crossSellCandidates,
    collectionMap,
    tagMap,
  };

  const jsonSize = new Blob([JSON.stringify(index)]).size;
  if (jsonSize > MAX_INDEX_JSON_BYTES) {
    logWarn({
      message: "Catalog index size exceeds threshold",
      meta: { jsonSize, threshold: MAX_INDEX_JSON_BYTES, productCount: capped.length },
    });
  }

  return index;
}

/**
 * Reads the prebuilt catalog index from Redis. Returns null on miss or parse error.
 * Decision route uses this only; no catalog transformation per request.
 */
export async function getCatalogIndexFromRedis(
  shop: string
): Promise<CatalogIndexSerialized | null> {
  try {
    const redis = getRedis();
    const raw = await redis.get(redisKey(shop, "catalog_index"));
    if (raw == null || raw === "") return null;
    const parsed = JSON.parse(raw) as CatalogIndexSerialized;
    if (!parsed || typeof parsed.productsById !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}

function productLiteToProduct(lite: ProductLite, currency: string): Product {
  return {
    id: lite.id,
    variantId: lite.variantId,
    handle: lite.handle,
    title: lite.title,
    imageUrl: lite.imageUrl,
    price: { amount: lite.priceCents, currency },
    inStock: lite.inStock,
    collections: lite.collections ?? [],
    ...(lite.tags && lite.tags.length > 0 ? { tags: lite.tags } : {}),
    ...(typeof lite.createdAt === "string" ? { createdAt: lite.createdAt } : {}),
  } as Product;
}

/**
 * Resolves strategy-specific catalog from prebuilt index: select/slice only, no full catalog filter.
 * Returns Product[] for decideCartActions. Pure; no I/O.
 */
export function resolveStrategyCatalogFromIndex(
  index: CatalogIndexSerialized,
  strategy: string,
  cart: CartSnapshot,
  manualCollectionIds: string[]
): Product[] {
  const currency = index.currency;
  const { productsById, crossSellCandidates, collectionMap, tagMap } = index;

  switch (strategy) {
    case "COLLECTION_MATCH":
      return crossSellCandidates.map((p) => productLiteToProduct(p, currency));

    case "MANUAL_COLLECTION": {
      if (manualCollectionIds.length === 0) return [];
      const ids = new Set<string>();
      for (const cid of manualCollectionIds) {
        const list = collectionMap[cid];
        if (Array.isArray(list)) for (const id of list) ids.add(id);
      }
      const list: Product[] = [];
      for (const id of ids) {
        const lite = productsById[id];
        if (lite && lite.inStock) list.push(productLiteToProduct(lite, currency));
      }
      return list;
    }

    case "TAG_MATCH": {
      const cartProductIds = new Set(cart.items.map((i) => i.productId));
      const cartTags = new Set<string>();
      for (const id of cartProductIds) {
        const lite = productsById[id];
        if (lite && Array.isArray(lite.tags)) {
          for (const t of lite.tags) if (typeof t === "string") cartTags.add(t);
        }
      }
      if (cartTags.size === 0) {
        return crossSellCandidates.map((p) => productLiteToProduct(p, currency));
      }
      const ids = new Set<string>();
      for (const tag of cartTags) {
        const list = tagMap[tag];
        if (Array.isArray(list)) for (const id of list) ids.add(id);
      }
      const list: Product[] = [];
      for (const id of ids) {
        const lite = productsById[id];
        if (lite && lite.inStock) list.push(productLiteToProduct(lite, currency));
      }
      return list.length > 0 ? list : crossSellCandidates.map((p) => productLiteToProduct(p, currency));
    }

    case "BEST_SELLING":
      return crossSellCandidates.map((p) => productLiteToProduct(p, currency));

    case "NEW_ARRIVALS": {
      const sorted = [...crossSellCandidates].sort((a, b) => {
        const ca = typeof a.createdAt === "string" ? a.createdAt : "";
        const cb = typeof b.createdAt === "string" ? b.createdAt : "";
        return cb.localeCompare(ca);
      });
      return sorted.map((p) => productLiteToProduct(p, currency));
    }

    default:
      return crossSellCandidates.map((p) => productLiteToProduct(p, currency));
  }
}
