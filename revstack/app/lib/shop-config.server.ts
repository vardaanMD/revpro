import type { ShopConfig } from "@prisma/client";
import { prisma } from "~/lib/prisma.server";
import { DEFAULT_SHOP_CONFIG } from "./default-config.server";
import { normalizeShopDomain } from "./shop-domain.server";
import { logResilience } from "~/lib/logger.server";

type CacheEntry = {
  data: ShopConfig;
  ts: number;
  version: number;
};

const cache = new Map<string, CacheEntry>();
const TTL = 5 * 60 * 1000;

/** P2022 = column does not exist (e.g. configV3 not yet migrated). */
function isPrismaMissingColumnError(err: unknown): boolean {
  if (err && typeof err === "object" && "code" in err) {
    return (err as { code?: string }).code === "P2022";
  }
  return false;
}

export async function getShopConfig(shop: string): Promise<ShopConfig> {
  const domain = normalizeShopDomain(shop);
  const t0 = process.env.NODE_ENV === "development" ? Date.now() : 0;
  if (process.env.NODE_ENV === "development") {
    console.log(`[PERF] getShopConfig called domain=${domain}`);
  }
  const cached = cache.get(domain);
  // Version check removed on cache hit: if cached config exists and TTL not expired, return it immediately without any Prisma query. Invalidation is handled by invalidateShopConfigCache when config is updated.
  if (cached && Date.now() - cached.ts < TTL) {
    if (process.env.NODE_ENV === "development") {
      console.log(`[PERF] getShopConfig cache HIT ${Date.now() - t0}ms (no Prisma)`);
    }
    return cached.data;
  }

  if (process.env.NODE_ENV === "development") {
    console.log(`[PERF] getShopConfig cache MISS, fetching from Prisma...`);
  }
  try {
    let config = await prisma.shopConfig.findUnique({
      where: { shopDomain: domain },
    });

    if (!config) {
      config = await prisma.shopConfig.create({
        data: {
          shopDomain: domain,
          ...DEFAULT_SHOP_CONFIG,
        },
      });
    }

    cache.set(domain, {
      data: config,
      ts: Date.now(),
      version: config.version,
    });

    if (process.env.NODE_ENV === "development") {
      console.log(`[PERF] getShopConfig end ${Date.now() - t0}ms (Prisma)`);
    }
    return config;
  } catch (err) {
    if (isPrismaMissingColumnError(err)) {
      console.warn("configV3 column missing — fallback used");
      return getFallbackShopConfig(shop);
    }
    throw err;
  }
}

/**
 * NOTE:
 * Shop config invalidation does NOT clear decision cache.
 * Decision cache depends only on cart hash, not config.
 */
export function invalidateShopConfigCache(shop: string): void {
  const domain = normalizeShopDomain(shop);
  cache.delete(domain);
}

/**
 * Minimal config fallback when Prisma fails. Used by layout/loaders to avoid 500.
 * Result has shape sufficient for getBillingContext (billingStatus, plan) and layout (onboardingCompleted, etc.).
 */
export function getFallbackShopConfig(shop: string): ShopConfig {
  const domain = normalizeShopDomain(shop);
  return {
    id: "fallback",
    shopDomain: domain,
    version: 0,
    onboardingCompleted: false,
    onboardingStep: 0,
    onboardingVerifiedAt: null,
    onboardingStepProgress: 0,
    previewSeen: false,
    activatedAt: null,
    lastActiveAt: null,
    milestoneFlags: null,
    trialEndsAt: null,
    billingId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    freeShippingThresholdCents: DEFAULT_SHOP_CONFIG.freeShippingThresholdCents,
    baselineAovCents: DEFAULT_SHOP_CONFIG.baselineAovCents,
    milestonesJson: DEFAULT_SHOP_CONFIG.milestonesJson as unknown as object,
    enableCrossSell: DEFAULT_SHOP_CONFIG.enableCrossSell,
    enableMilestones: DEFAULT_SHOP_CONFIG.enableMilestones,
    enableCouponTease: DEFAULT_SHOP_CONFIG.enableCouponTease,
    plan: DEFAULT_SHOP_CONFIG.plan,
    billingStatus: DEFAULT_SHOP_CONFIG.billingStatus,
    recommendationStrategy: DEFAULT_SHOP_CONFIG.recommendationStrategy,
    manualCollectionIds: DEFAULT_SHOP_CONFIG.manualCollectionIds as unknown as object | null,
    recommendationLimit: DEFAULT_SHOP_CONFIG.recommendationLimit,
    primaryColor: DEFAULT_SHOP_CONFIG.primaryColor,
    accentColor: DEFAULT_SHOP_CONFIG.accentColor,
    borderRadius: DEFAULT_SHOP_CONFIG.borderRadius,
    showConfetti: DEFAULT_SHOP_CONFIG.showConfetti,
    enableHaptics: true,
    countdownEnabled: DEFAULT_SHOP_CONFIG.countdownEnabled,
    emojiMode: DEFAULT_SHOP_CONFIG.emojiMode,
    shippingBarPosition: "top",
    engineVersion: DEFAULT_SHOP_CONFIG.engineVersion,
    configV3: null,
    primaryCurrency: "USD",
  };
}
