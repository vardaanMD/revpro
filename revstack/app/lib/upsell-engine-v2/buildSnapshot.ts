/**
 * V2 bootstrap snapshot builder. Uses DB catalog (ShopProduct) + ShopConfig + billing only.
 * No Redis, no decision route, no decision cache, no SAFE fallback, no locking.
 */
import type { Product } from "@revpro/decision-engine";
import type { CartSnapshot } from "@revpro/decision-engine";
import type { ShopConfig } from "@prisma/client";
import type { BillingContext } from "~/lib/billing-context.server";
import { getShopConfig } from "~/lib/shop-config.server";
import { getShopCurrency } from "~/lib/shop-currency.server";
import { getBillingContext } from "~/lib/billing-context.server";
import { resolveStrategyCatalogFromIndex } from "~/lib/catalog-index.server";
import type { CatalogIndexSerialized, ProductLite } from "~/lib/catalog-index.server";
import { prisma } from "~/lib/prisma.server";
import type { BootstrapV2Response, ProductSnapshot } from "./types";

/** V3 snapshot milestone shape. Runtime expects rewards.milestones with these fields. */
export type V3SnapshotMilestone = {
  id: string;
  type: string;
  thresholdCents: number;
  emoji?: string | null;
  icon?: string | null;
  label?: string | null;
  rewardType?: string | null;
};

/**
 * Transforms rewards.tiers into rewards.milestones for V3 runtime.
 * Includes id, type, thresholdCents, emoji, icon, label, rewardType.
 */
/** Backend/settings save tiers as { amount: number (cents), label }. Snapshot must output thresholdCents for runtime. */
export function transformTiersToMilestones(tiers: unknown[]): V3SnapshotMilestone[] {
  return tiers.map((t, index) => {
    const o = t && typeof t === "object" ? (t as Record<string, unknown>) : {};
    const thresholdCents =
      typeof o.thresholdCents === "number" && Number.isFinite(o.thresholdCents)
        ? Math.max(0, Math.floor(o.thresholdCents))
        : typeof o.amount === "number" && Number.isFinite(o.amount)
          ? Math.max(0, Math.floor(o.amount))
          : 0;
    const rewardType = typeof o.rewardType === "string" ? o.rewardType : undefined;
    return {
      id: `ms_${index}`,
      type: rewardType ?? "generic",
      thresholdCents,
      emoji: typeof o.emoji === "string" ? o.emoji : undefined,
      icon: typeof o.icon === "string" ? o.icon : undefined,
      label: typeof o.label === "string" ? o.label : undefined,
      rewardType,
    };
  });
}

/**
 * Builds the V3 snapshot payload shape expected by the runtime.
 * Ensures: appearance (primaryColor, accentColor, radius), freeShipping (enabled, thresholdCents),
 * rewards.milestones (from tiers), discounts, featureFlags, checkout.
 * Also sets rewards.tiers = milestones so runtime that reads tiers still works.
 */
export function buildV3SnapshotPayload<T extends { rewards?: { tiers?: unknown[] }; appearance?: unknown; freeShipping?: unknown }>(
  config: T
): T & {
  appearance: { primaryColor: string; accentColor: string; radius: number };
  freeShipping: { enabled: boolean; thresholdCents?: number | null };
  rewards: { milestones: V3SnapshotMilestone[]; tiers: V3SnapshotMilestone[] };
} {
  const tiers = Array.isArray(config.rewards?.tiers) ? config.rewards.tiers : [];
  const milestones = transformTiersToMilestones(tiers);

  const appearance = (config.appearance as Record<string, unknown>) ?? {};
  const primaryColor =
    typeof appearance.primaryColor === "string" && appearance.primaryColor.trim()
      ? appearance.primaryColor.trim()
      : "#111111";
  const accentColor =
    typeof appearance.accentColor === "string" && appearance.accentColor.trim()
      ? appearance.accentColor.trim()
      : "#16a34a";
  const radiusRaw =
    typeof appearance.radius === "number" && Number.isFinite(appearance.radius) && (appearance.radius as number) >= 0
      ? appearance.radius as number
      : typeof appearance.borderRadius === "number" &&
          Number.isFinite(appearance.borderRadius) &&
          (appearance.borderRadius as number) >= 0
        ? (appearance.borderRadius as number)
        : 12;
  const radius = Math.floor(radiusRaw);

  const freeShipping = (config.freeShipping as { thresholdCents?: number | null } | undefined) ?? {};
  const thresholdCents =
    typeof freeShipping.thresholdCents === "number" && Number.isFinite(freeShipping.thresholdCents)
      ? freeShipping.thresholdCents
      : 5000;

  const cartHeaderMessages = Array.isArray(appearance.cartHeaderMessages)
    ? appearance.cartHeaderMessages.filter((m): m is string => typeof m === "string" && m.trim() !== "").slice(0, 3).map((m) => m.trim())
    : undefined;
  const backgroundColor =
    typeof appearance.backgroundColor === "string" && appearance.backgroundColor.trim()
      ? (appearance.backgroundColor as string).trim()
      : "#ffffff";
  const bannerBackgroundColor =
    typeof appearance.bannerBackgroundColor === "string" && appearance.bannerBackgroundColor.trim()
      ? (appearance.bannerBackgroundColor as string).trim()
      : "#16a34a";
  // Preserve all appearance keys from config (showHeaderBanner, showConfetti, countdownEnabled, emojiMode, countdownDurationMs, etc.)
  // so the storefront receives them and toggles/colour pickers reflect correctly.
  const appearancePassThrough = { ...appearance } as Record<string, unknown>;
  return {
    ...config,
    appearance: {
      ...appearancePassThrough,
      primaryColor,
      accentColor,
      radius,
      borderRadius: radius,
      backgroundColor,
      bannerBackgroundColor,
      ...(cartHeaderMessages && cartHeaderMessages.length > 0 ? { cartHeaderMessages } : {}),
    },
    freeShipping: {
      enabled: true,
      thresholdCents,
    },
    rewards: {
      milestones,
      tiers: milestones,
    },
  } as T & {
    appearance: { primaryColor: string; accentColor: string; radius: number; borderRadius: number; backgroundColor: string; bannerBackgroundColor: string };
    freeShipping: { enabled: boolean; thresholdCents?: number | null };
    rewards: { milestones: V3SnapshotMilestone[]; tiers: V3SnapshotMilestone[] };
  };
}

/**
 * Extract numeric product ID from Shopify GID (e.g. gid://shopify/Product/8231199047714).
 * Throws if invalid. Use for cart.js product_id comparison.
 */
export function extractNumericProductId(gid: string): number {
  const parts = gid.split("/");
  const last = parts[parts.length - 1];
  if (last === undefined || last === "") {
    throw new Error(`V2: invalid product GID (split failed): ${gid}`);
  }
  const numericId = Number(last);
  if (!Number.isFinite(numericId) || Number.isNaN(numericId)) {
    throw new Error(`V2: invalid product GID (not numeric): ${gid}`);
  }
  return numericId;
}

/**
 * Ensures ShopProduct catalog exists for shop. If count is 0, runs warm synchronously once, then re-checks.
 * Use only in bootstrap.v2. Throws if catalog still missing after warm.
 */
export async function ensureCatalogReady(shop: string): Promise<void> {
  const count = await prisma.shopProduct.count({ where: { shopDomain: shop } });
  if (count > 0) return;
  const { warmCatalogForShop } = await import("~/lib/catalog-warm.server");
  await warmCatalogForShop(shop);
  const countAfter = await prisma.shopProduct.count({ where: { shopDomain: shop } });
  if (countAfter === 0) {
    throw new Error(`V2 bootstrap: catalog still missing for shop ${shop} after warm`);
  }
}

const EMPTY_CART: CartSnapshot = {
  id: "bootstrap-v2",
  items: [],
};

/** Build in-memory catalog index from ShopProduct rows. No Redis. */
function buildCatalogIndexFromDbRows(
  rows: Awaited<ReturnType<typeof prisma.shopProduct.findMany>>,
  currency: string
): CatalogIndexSerialized {
  const productsById: Record<string, ProductLite> = {};
  const crossSellCandidates: ProductLite[] = [];
  const collectionMap: Record<string, string[]> = {};
  const tagMap: Record<string, string[]> = {};

  for (const r of rows) {
    const collectionIds = Array.isArray(r.collectionIds) ? (r.collectionIds as string[]) : [];
    const lite: ProductLite = {
      id: r.id,
      variantId: r.variantId,
      priceCents: r.priceCents,
      collections: collectionIds,
      inStock: r.available,
      handle: r.handle,
      title: r.title,
      imageUrl: r.featuredImageUrl ?? null,
      createdAt: r.createdAt.toISOString(),
    };
    productsById[r.id] = lite;
    if (r.available) crossSellCandidates.push(lite);
    for (const cid of collectionIds) {
      if (!collectionMap[cid]) collectionMap[cid] = [];
      collectionMap[cid].push(r.id);
    }
  }

  return {
    updatedAt: Date.now(),
    currency,
    productsById,
    crossSellCandidates,
    collectionMap,
    tagMap,
  };
}

function productToSnapshot(p: Product, currency: string): ProductSnapshot {
  const productId = extractNumericProductId(p.id);
  return {
    id: p.id,
    productId,
    variantId: p.variantId,
    title: p.title,
    imageUrl: p.imageUrl ?? null,
    price: p.price.amount,
    currency: currency ?? p.price.currency,
    handle: p.handle ?? "",
    collections: p.collections ?? [],
  };
}

/**
 * Builds the V2 bootstrap snapshot: UI, capabilities, and cross-sell product pool.
 * Fails fast if catalog index is missing (triggers async warm and throws).
 */
export async function buildBootstrapSnapshotV2(
  shop: string
): Promise<BootstrapV2Response> {
  const config = await getShopConfig(shop);
  const billing = await getBillingContext(shop, config);
  const capabilities = billing.capabilities;

  const responseCapabilities: BootstrapV2Response["capabilities"] = {
    allowUIConfig: capabilities.allowUIConfig,
    allowCrossSell: capabilities.allowCrossSell,
    allowMilestones: capabilities.allowMilestones,
    allowCouponTease: capabilities.allowCouponTease,
  };

  const ui: BootstrapV2Response["ui"] = capabilities.allowUIConfig
    ? {
        primaryColor: config.primaryColor ?? null,
        accentColor: config.accentColor ?? null,
        borderRadius: config.borderRadius ?? null,
        showConfetti: config.showConfetti ?? true,
        countdownEnabled: config.countdownEnabled ?? true,
        emojiMode: config.emojiMode ?? true,
      }
    : {
        primaryColor: null,
        accentColor: null,
        borderRadius: null,
        showConfetti: false,
        countdownEnabled: false,
        emojiMode: true,
      };

  await ensureCatalogReady(shop);
  const rows = await prisma.shopProduct.findMany({ where: { shopDomain: shop } });
  if (rows.length === 0) {
    throw new Error(`V2 bootstrap: catalog missing for shop ${shop} (no ShopProduct rows)`);
  }
  const currency = getShopCurrency(config);
  const index = buildCatalogIndexFromDbRows(rows, currency);

  const manualCollectionIds = Array.isArray(config.manualCollectionIds)
    ? (config.manualCollectionIds as string[])
    : [];
  const effectiveStrategy = capabilities.allowStrategySelection
    ? config.recommendationStrategy
    : "COLLECTION_MATCH";

  const strategyCatalog: Product[] = resolveStrategyCatalogFromIndex(
    index,
    effectiveStrategy,
    EMPTY_CART,
    manualCollectionIds
  );

  const strategy = { limit: config.recommendationLimit };
  const limit = Math.max(strategy.limit ?? 4, 4);
  const effectiveLimit = Math.min(limit, capabilities.maxCrossSell);

  const sliced = strategyCatalog.slice(0, effectiveLimit);
  const products: ProductSnapshot[] = sliced.map((p) =>
    productToSnapshot(p, index.currency)
  );
  const variantIds = products.map((p) => p.variantId);

  return {
    ui,
    capabilities: responseCapabilities,
    upsell: {
      products,
      strategy: effectiveStrategy,
    },
    variantIds,
    aiEnabled: capabilities.allowCrossSell,
  };
}

function productLiteToSnapshot(lite: ProductLite, currency: string): ProductSnapshot {
  const productId = extractNumericProductId(lite.id);
  return {
    id: lite.id,
    productId,
    variantId: lite.variantId,
    title: lite.title,
    imageUrl: lite.imageUrl ?? null,
    price: lite.priceCents,
    currency,
    handle: lite.handle ?? "",
    collections: lite.collections ?? [],
  };
}

/**
 * Resolves products from same collections as lastAddedProductId, excluding that product.
 * Pure; no I/O. Used by AI overlay endpoint.
 */
export function resolveAiOverlayProducts(
  index: CatalogIndexSerialized,
  lastAddedProductId: string,
  limit: number
): ProductSnapshot[] {
  const { productsById, collectionMap } = index;
  const added = productsById[lastAddedProductId];
  if (!added) return [];

  const collectionIds = added.collections ?? [];
  if (collectionIds.length === 0) return [];

  const candidateIds = new Set<string>();
  for (const cid of collectionIds) {
    const list = collectionMap[cid];
    if (Array.isArray(list)) for (const id of list) candidateIds.add(id);
  }
  candidateIds.delete(lastAddedProductId);

  const result: ProductSnapshot[] = [];
  for (const id of candidateIds) {
    const lite = productsById[id];
    if (lite && result.length < limit) {
      result.push(productLiteToSnapshot(lite, index.currency));
    }
  }
  return result.slice(0, limit);
}

/** Hydrated product shape for recommendations (e.g. snapshot v3). amount is in cents (UI divides by 100). */
export type HydratedRecommendation = {
  id: string;
  variantId: number;
  title: string;
  imageUrl: string | null;
  price: { amount: number; compare_at_amount: number | null };
  handle: string;
};

/** Collection-aware snapshot shape: keyed recommendations + product → collections map. */
export type CollectionAwareRecommendations = {
  recommendationsByCollection: Record<string, HydratedRecommendation[]>;
  productToCollections: Record<string, string[]>;
};

/**
 * Computes the "default" bucket of recommendations from an existing catalog index.
 * Same strategy/limit/capabilities logic as getHydratedRecommendationsForShop but without DB.
 * Used by buildCollectionAwareRecommendationsWithContext to avoid a second findMany.
 */
function getDefaultBucketFromIndex(
  index: CatalogIndexSerialized,
  config: ShopConfig,
  capabilities: BillingContext["capabilities"]
): HydratedRecommendation[] {
  const manualCollectionIds = Array.isArray(config.manualCollectionIds)
    ? (config.manualCollectionIds as string[])
    : [];
  const effectiveStrategy = capabilities.allowStrategySelection
    ? config.recommendationStrategy
    : "COLLECTION_MATCH";

  const strategyCatalog: Product[] = resolveStrategyCatalogFromIndex(
    index,
    effectiveStrategy,
    EMPTY_CART,
    manualCollectionIds
  );

  const limit = Math.max(typeof config.recommendationLimit === "number" ? config.recommendationLimit : 4, 4);
  const effectiveLimit = Math.min(limit, capabilities.maxCrossSell);
  const sliced = strategyCatalog.slice(0, effectiveLimit);

  const validProducts = sliced.filter((p) => {
    const variantId = Number((p as { variantId?: string | number }).variantId);
    if (!variantId || variantId <= 0) return false;
    if (!p.title || p.title.trim().length === 0) return false;
    if (!p.handle || p.handle.trim().length === 0) return false;
    if ((p as { inStock?: boolean }).inStock === false) return false;
    return true;
  });

  return validProducts.map((p) => {
    const variantId = Number((p as { variantId?: string | number }).variantId);
    const priceCents = typeof p.price?.amount === "number" ? p.price.amount : 0;
    return {
      id: p.id,
      variantId,
      title: p.title,
      imageUrl: p.imageUrl ?? null,
      price: {
        amount: priceCents,
        compare_at_amount: null,
      },
      handle: p.handle ?? "",
    };
  });
}

/**
 * Returns hydrated recommendations from ShopProduct for a shop.
 * Uses same DB + strategy/limit logic as V2 but returns only the product list.
 * Used by snapshot v3 so it does not depend on buildBootstrapSnapshotV2.
 */
export async function getHydratedRecommendationsForShop(
  shop: string
): Promise<HydratedRecommendation[]> {
  await ensureCatalogReady(shop);
  const config = await getShopConfig(shop);
  const currency = getShopCurrency(config);
  const rows = await prisma.shopProduct.findMany({ where: { shopDomain: shop } });
  if (rows.length === 0) return [];

  const index = buildCatalogIndexFromDbRows(rows, currency);
  const billing = await getBillingContext(shop, config);
  const capabilities = billing.capabilities;

  const manualCollectionIds = Array.isArray(config.manualCollectionIds)
    ? (config.manualCollectionIds as string[])
    : [];
  const effectiveStrategy = capabilities.allowStrategySelection
    ? config.recommendationStrategy
    : "COLLECTION_MATCH";

  const strategyCatalog: Product[] = resolveStrategyCatalogFromIndex(
    index,
    effectiveStrategy,
    EMPTY_CART,
    manualCollectionIds
  );

  const strategy = { limit: config.recommendationLimit };
  const limit = Math.max(strategy.limit ?? 4, 4);
  const effectiveLimit = Math.min(limit, capabilities.maxCrossSell);

  const sliced = strategyCatalog.slice(0, effectiveLimit);

  const validProducts = sliced.filter((p) => {
    const variantId = Number((p as { variantId?: string | number }).variantId);
    if (!variantId || variantId <= 0) return false;
    if (!p.title || p.title.trim().length === 0) return false;
    if (!p.handle || p.handle.trim().length === 0) return false;
    // Exclude archived/unavailable products so they can't be shown or added to cart
    if ((p as { inStock?: boolean }).inStock === false) return false;
    return true;
  });

  return validProducts.map((p) => {
    const variantId = Number((p as { variantId?: string | number }).variantId);
    const priceCents = typeof p.price?.amount === "number" ? p.price.amount : 0;
    return {
      id: p.id,
      variantId,
      title: p.title,
      imageUrl: p.imageUrl ?? null,
      price: {
        amount: priceCents,
        compare_at_amount: null,
      },
      handle: p.handle ?? "",
    };
  });
}

const COLLECTION_RECOS_PER_BUCKET = 8;
const MAX_COLLECTIONS_IN_SNAPSHOT = 20;

function productLiteToHydratedRecommendation(
  lite: ProductLite,
  _currency: string
): HydratedRecommendation {
  const variantId = Number(lite.variantId);
  return {
    id: lite.id,
    variantId: Number.isFinite(variantId) ? variantId : 0,
    title: lite.title,
    imageUrl: lite.imageUrl ?? null,
    price: { amount: lite.priceCents, compare_at_amount: null },
    handle: lite.handle ?? "",
  };
}

/**
 * Builds collection-aware recommendations: keyed buckets per collection plus product→collections map.
 * Uses ensureCatalogReady + ShopProduct + buildCatalogIndexFromDbRows. "default" bucket uses the same
 * logic as getHydratedRecommendationsForShop (strategy, limit, capabilities, EMPTY_CART).
 */
export async function buildCollectionAwareRecommendations(
  shop: string
): Promise<CollectionAwareRecommendations> {
  await ensureCatalogReady(shop);
  const config = await getShopConfig(shop);
  const currency = getShopCurrency(config);
  const rows = await prisma.shopProduct.findMany({ where: { shopDomain: shop } });
  if (rows.length === 0) {
    return {
      recommendationsByCollection: { default: [] },
      productToCollections: {},
    };
  }

  const index = buildCatalogIndexFromDbRows(rows, currency);
  const { productsById, collectionMap } = index;

  const productToCollections: Record<string, string[]> = {};
  for (const [productId, lite] of Object.entries(productsById)) {
    productToCollections[productId] = Array.isArray(lite.collections) ? lite.collections : [];
  }

  const recommendationsByCollection: Record<string, HydratedRecommendation[]> = {};

  const collectionIdsByProductCount = Object.entries(collectionMap)
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, MAX_COLLECTIONS_IN_SNAPSHOT)
    .map(([cid]) => cid);

  for (const collectionId of collectionIdsByProductCount) {
    const productIds = collectionMap[collectionId] ?? [];
    const hydrated: HydratedRecommendation[] = [];
    for (const pid of productIds) {
      if (hydrated.length >= COLLECTION_RECOS_PER_BUCKET) break;
      const lite = productsById[pid];
      if (!lite || !lite.inStock) continue;
      if (!lite.title?.trim() || !lite.handle?.trim()) continue;
      const variantId = Number(lite.variantId);
      if (!Number.isFinite(variantId) || variantId <= 0) continue;
      hydrated.push(productLiteToHydratedRecommendation(lite, index.currency));
    }
    if (hydrated.length > 0) {
      recommendationsByCollection[collectionId] = hydrated;
    }
  }

  const defaultRecs = await getHydratedRecommendationsForShop(shop);
  recommendationsByCollection["default"] = defaultRecs;

  return {
    recommendationsByCollection,
    productToCollections,
  };
}

/**
 * Builds collection-aware recommendations with pre-fetched config and billing (single findMany).
 * Use from snapshot route when config and billing are already loaded to avoid duplicate DB work.
 * Same output shape as buildCollectionAwareRecommendations(shop).
 */
export async function buildCollectionAwareRecommendationsWithContext(
  shop: string,
  config: ShopConfig,
  billing: BillingContext
): Promise<CollectionAwareRecommendations> {
  const rows = await prisma.shopProduct.findMany({ where: { shopDomain: shop } });
  if (rows.length === 0) {
    return {
      recommendationsByCollection: { default: [] },
      productToCollections: {},
    };
  }

  const currency = getShopCurrency(config);
  const index = buildCatalogIndexFromDbRows(rows, currency);
  const { productsById, collectionMap } = index;

  const productToCollections: Record<string, string[]> = {};
  for (const [productId, lite] of Object.entries(productsById)) {
    productToCollections[productId] = Array.isArray(lite.collections) ? lite.collections : [];
  }

  const recommendationsByCollection: Record<string, HydratedRecommendation[]> = {};

  const collectionIdsByProductCount = Object.entries(collectionMap)
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, MAX_COLLECTIONS_IN_SNAPSHOT)
    .map(([cid]) => cid);

  for (const collectionId of collectionIdsByProductCount) {
    const productIds = collectionMap[collectionId] ?? [];
    const hydrated: HydratedRecommendation[] = [];
    for (const pid of productIds) {
      if (hydrated.length >= COLLECTION_RECOS_PER_BUCKET) break;
      const lite = productsById[pid];
      if (!lite || !lite.inStock) continue;
      if (!lite.title?.trim() || !lite.handle?.trim()) continue;
      const variantId = Number(lite.variantId);
      if (!Number.isFinite(variantId) || variantId <= 0) continue;
      hydrated.push(productLiteToHydratedRecommendation(lite, index.currency));
    }
    if (hydrated.length > 0) {
      recommendationsByCollection[collectionId] = hydrated;
    }
  }

  recommendationsByCollection["default"] = getDefaultBucketFromIndex(
    index,
    config,
    billing.capabilities
  );

  return {
    recommendationsByCollection,
    productToCollections,
  };
}
