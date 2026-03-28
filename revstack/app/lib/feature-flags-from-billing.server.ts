/**
 * Maps billing capabilities to V3 feature flags. Used by snapshot v3 and admin
 * so storefront and Settings/Dashboard show the same plan-derived feature state.
 */
import type { Capabilities } from "~/lib/capabilities.server";
import type { CartProConfigV3FeatureFlags } from "~/lib/config-v3";

export function featureFlagsFromCapabilities(
  capabilities: Capabilities
): CartProConfigV3FeatureFlags {
  return {
    enableUpsell: capabilities.allowCrossSell ?? false,
    enableRewards: capabilities.allowMilestones ?? false,
    enableDiscounts: capabilities.allowDiscounts ?? capabilities.allowCouponTease ?? false,
    /**
     * Must be true when merchants use milestone gift tiers or freeGifts.rules — Engine.syncFreeGifts no-ops if there are no rules.
     * Previously hardcoded false and sync was never scheduled, so gifts never applied.
     */
    enableFreeGifts: Boolean(capabilities.allowMilestones ?? capabilities.allowUIConfig),
    enableCheckoutOverride: false,
    // Analytics (cart:evaluated, impressions, clicks) enabled for all plans so admin UI reflects storefront activity.
    enableAnalytics: true,
  };
}
