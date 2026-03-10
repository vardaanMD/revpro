import {
  decideCartActions,
  type CartSnapshot,
  type CartItem,
  type Money,
  type StoreMetrics,
} from "@revpro/decision-engine";
import type { Product } from "@revpro/decision-engine";
import { getShopConfig } from "~/lib/shop-config.server";
import { logWarn } from "~/lib/logger.server";
import { getCatalogForShop } from "~/lib/catalog.server";
import { AdminApi401Error } from "~/lib/admin-api-errors.server";
import { applyRecommendationStrategy } from "~/lib/recommendation-strategy.server";
import { resolveCapabilities, type Plan } from "~/lib/capabilities.server";
import type { DecisionResponse } from "~/lib/decision-response.server";
import type { ShopConfig } from "@prisma/client";

/** UI config for admin preview only. Not part of DecisionResponse; UI comes from bootstrap on storefront. */
/** Includes V3 appearance: drawer bg, message banner, header messages. */
export type PreviewUI = {
  primaryColor: string | null;
  accentColor: string | null;
  borderRadius: number;
  showConfetti: boolean;
  countdownEnabled: boolean;
  emojiMode: boolean;
  /** V3: drawer background color */
  backgroundColor?: string | null;
  /** V3: message banner background (below "Your Cart") */
  bannerBackgroundColor?: string | null;
  /** V3: up to 3 rotating header messages */
  cartHeaderMessages?: string[];
};

/** Admin preview render state: UI and decision kept separate (no merging). */
export interface PreviewRenderState {
  ui: PreviewUI;
  decision: DecisionResponse;
}

type AdminGraphQL = {
  graphql(
    query: string,
    options?: { variables?: Record<string, unknown> }
  ): Promise<Response>;
};

function toMoney(amount: number, currency: string): Money {
  return { amount, currency };
}

/**
 * Builds a mock cart snapshot for preview. Uses first catalog product when available.
 * No DB writes. No rate limiting. No metrics. Pure simulation.
 */
function buildMockCartSnapshot(
  catalog: Product[],
  currency: string
): CartSnapshot {
  const firstProduct = catalog[0];
  const productId = firstProduct ? String(firstProduct.id) : "preview-product";
  const priceCents = 1999;

  const items: CartItem[] = [
    {
      id: "preview-line-1",
      productId,
      quantity: 1,
      unitPrice: toMoney(priceCents, currency),
    },
  ];

  return {
    id: "preview-cart",
    items,
  };
}

export type PreviewOverrides = {
  strategy?: string;
  emojiMode?: boolean;
  showConfetti?: boolean;
  freeShippingThresholdCents?: number;
};

/**
 * Generates a preview result (decision + ui) for the Live Cart Preview using current
 * ShopConfig and a simulated cart. Reuses recommendation strategy and engine.
 * UI is included only for admin preview; storefront gets UI from /bootstrap.
 * Does NOT call storefront /cart/decision; does NOT mutate DB.
 * Optional overrides apply only to this call and are not persisted.
 * Pass config to avoid redundant getShopConfig when caller already has it.
 */
export async function generatePreviewDecision(
  shop: string,
  admin: AdminGraphQL,
  overrides?: PreviewOverrides,
  configFromLoader?: ShopConfig | null,
  catalogFromLoader?: Product[] | null,
  request?: Request
): Promise<PreviewRenderState> {
  const config = configFromLoader ?? (await getShopConfig(shop));
  let catalog: Product[] =
    catalogFromLoader ??
    (await (async () => {
      try {
        return await getCatalogForShop(admin, shop, "USD", request);
      } catch (err) {
        if (err instanceof Response && err.status === 302) throw err;
        if (err instanceof AdminApi401Error) throw err;
        logWarn({
          shop,
          message: "Preview: getCatalogForShop failed; using empty catalog",
          meta: { error: err instanceof Error ? err.message : String(err) },
        });
        return [];
      }
    })());
  const currency = "USD";
  const cart = buildMockCartSnapshot(catalog, currency);

  const planRaw = config.plan ?? "basic";
  const plan: Plan =
    planRaw === "advanced" || planRaw === "growth" ? planRaw : "basic";
  const capabilities = resolveCapabilities(plan);

  const thresholdCents =
    overrides?.freeShippingThresholdCents != null
      ? overrides.freeShippingThresholdCents
      : config.freeShippingThresholdCents;
  const storeMetrics: StoreMetrics = {
    currency,
    baselineAOV: {
      amount: config.baselineAovCents,
      currency,
    },
    freeShippingThreshold: {
      amount: thresholdCents,
      currency,
    },
  };

  const manualCollectionIds = Array.isArray(config.manualCollectionIds)
    ? (config.manualCollectionIds as string[])
    : [];
  const effectiveStrategy = (overrides?.strategy ?? config.recommendationStrategy) as string;
  const useStrategyOverride = capabilities.allowStrategySelection && overrides?.strategy != null;
  const strategyToUse = useStrategyOverride ? effectiveStrategy : (capabilities.allowStrategySelection ? config.recommendationStrategy : "COLLECTION_MATCH");
  const strategyFilteredCatalog = applyRecommendationStrategy({
    strategy: strategyToUse,
    catalog,
    cart,
    manualCollectionIds,
  });

  const decision = decideCartActions({
    cart,
    catalog: strategyFilteredCatalog,
    storeMetrics,
  });

  const milestonesRaw =
    capabilities.allowMilestones &&
    config.enableMilestones &&
    Array.isArray(config.milestonesJson)
      ? (config.milestonesJson as unknown[])
      : [];
  const filteredMilestones = capabilities.allowMilestones ? milestonesRaw : [];

  const crossSellEnabled = capabilities.allowCrossSell && config.enableCrossSell;
  const recommendationLimit =
    typeof config.recommendationLimit === "number" &&
    Number.isInteger(config.recommendationLimit)
      ? config.recommendationLimit
      : 4;
  const effectiveLimit = Math.min(
    Math.max(1, recommendationLimit),
    capabilities.maxCrossSell
  );
  const crossSellRaw = Array.isArray(decision.crossSell) ? decision.crossSell : [];
  const crossSell = crossSellEnabled
    ? crossSellRaw.slice(0, effectiveLimit)
    : [];

  const safeUiFallback: PreviewUI = {
    primaryColor: null,
    accentColor: null,
    borderRadius: 12,
    showConfetti: true,
    countdownEnabled: true,
    emojiMode: true,
  };

  const configV3 = config.configV3 as { appearance?: { backgroundColor?: string; bannerBackgroundColor?: string; cartHeaderMessages?: string[] } } | null | undefined;
  const appearanceV3 = configV3?.appearance;

  const computedPreviewUI: PreviewUI = capabilities.allowUIConfig
    ? {
        primaryColor: config.primaryColor ?? null,
        accentColor: config.accentColor ?? null,
        borderRadius: config.borderRadius ?? 12,
        showConfetti: overrides?.showConfetti ?? config.showConfetti ?? true,
        countdownEnabled: config.countdownEnabled ?? true,
        emojiMode: overrides?.emojiMode ?? config.emojiMode ?? true,
        backgroundColor: appearanceV3?.backgroundColor ?? "#ffffff",
        bannerBackgroundColor: appearanceV3?.bannerBackgroundColor ?? "#16a34a",
        cartHeaderMessages: Array.isArray(appearanceV3?.cartHeaderMessages)
          ? appearanceV3.cartHeaderMessages.filter((m): m is string => typeof m === "string" && m.trim() !== "").slice(0, 3)
          : [],
      }
    : safeUiFallback;

  const computedDecision: DecisionResponse = {
    crossSell,
    freeShippingRemaining: decision.freeShippingRemaining ?? 0,
    suppressCheckout: decision.suppressCheckout,
    milestones: capabilities.allowMilestones ? filteredMilestones : [],
    enableCouponTease:
      capabilities.allowCouponTease && config.enableCouponTease,
  };

  return {
    ui: computedPreviewUI,
    decision: computedDecision,
  };
}
