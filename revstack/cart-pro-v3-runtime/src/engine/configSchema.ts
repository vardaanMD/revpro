/**
 * Cart Pro V3 — runtime config schema and types.
 * Canonical CartProConfigV3 matches backend config-v3.ts (snapshot response).
 * NormalizedEngineConfig is internal; engine runs off it after loadConfig().
 */

/* ----- Canonical schema (matches app/lib/config-v3.ts) ----- */

export interface CartProConfigV3Appearance {
  primaryColor: string;
  accentColor: string;
  borderRadius: number;
  showConfetti: boolean;
  countdownEnabled: boolean;
  emojiMode: boolean;
  /** Urgency countdown duration in ms. Primary source; fallback in engine if missing. */
  countdownDurationMs?: number;
  /** When true, show the rotating header message banner below "Your Cart". Default true. */
  showHeaderBanner?: boolean;
  backgroundColor?: string;
  /** Background color for the header message banner section. */
  bannerBackgroundColor?: string;
  surfaceColor?: string;
  textColor?: string;
  borderColor?: string;
  shadowColor?: string;
  /** CSS selector for the merchant theme's native cart drawer. When set, this selector
   *  is used exclusively (instead of the built-in default list) to hide other cart UIs. */
  merchantCartDrawerSelector?: string;
  /** Up to 3 custom messages shown below "Your Cart" that rotate. */
  cartHeaderMessages?: string[];
}

export interface CartProConfigV3FeatureFlags {
  enableUpsell: boolean;
  enableRewards: boolean;
  enableDiscounts: boolean;
  enableFreeGifts: boolean;
  enableCheckoutOverride: boolean;
  enableAnalytics: boolean;
}

export interface CartProConfigV3UpsellAi {
  enabled: boolean;
  endpoint?: string;
}

export interface CartProConfigV3Upsell {
  strategy: 'manual' | 'collection' | 'aov' | 'ai';
  limit: number;
  collections: string[];
  standardRules: unknown[];
  ai: CartProConfigV3UpsellAi;
  /** Section heading for recommendations (e.g. "You may also like"). */
  recommendationsHeading?: string;
}

export interface CartProConfigV3Rewards {
  tiers: unknown[];
}

export interface CartProConfigV3Discounts {
  allowStacking: boolean;
  whitelist: string[];
  teaseMessage?: string;
  /** When true, show the coupon tease message banner when no code is applied. Default true. */
  showTeaseMessage?: boolean;
}

export interface CartProConfigV3FreeGifts {
  rules: unknown[];
}

export interface CartProConfigV3CheckoutOverlay {
  enabled: boolean;
  checkoutUrl?: string;
}

export interface CartProConfigV3Checkout {
  mode: 'default' | 'overlay';
  overlay: CartProConfigV3CheckoutOverlay;
}

export interface CartProConfigV3Analytics {
  enabled: boolean;
  batchSize: number;
  flushIntervalMs: number;
}

export interface CartProConfigV3FreeShipping {
  thresholdCents?: number;
}

/** Snapshot recommendation item shape (variantId, title, imageUrl, price, handle). */
export interface SnapshotRecommendationItemRaw {
  variantId: number;
  title: string;
  imageUrl?: string | null;
  price?: { amount?: number; compare_at_amount?: number | null };
  handle?: string;
}

/** Canonical config (snapshot/API). Must match app/lib/config-v3.ts exactly. */
export interface CartProConfigV3 {
  version: string;
  appearance: CartProConfigV3Appearance;
  featureFlags: CartProConfigV3FeatureFlags;
  upsell: CartProConfigV3Upsell;
  rewards: CartProConfigV3Rewards;
  discounts: CartProConfigV3Discounts;
  freeGifts: CartProConfigV3FreeGifts;
  checkout: CartProConfigV3Checkout;
  analytics: CartProConfigV3Analytics;
  freeShipping?: CartProConfigV3FreeShipping;
  /** Collection-aware recommendations: collectionId -> list. Present when snapshot uses buildCollectionAwareRecommendations. */
  recommendationsByCollection?: Record<string, SnapshotRecommendationItemRaw[]>;
  /** Product ID (string) -> collection IDs. Used with recommendationsByCollection to derive primary collection from cart. */
  productToCollections?: Record<string, string[]>;
  /** Legacy flat list; set to recommendationsByCollection["default"] when keyed data is present. */
  recommendations?: SnapshotRecommendationItemRaw[];
}

/** Input from snapshot or partial override. */
export type RawCartProConfig = Partial<CartProConfigV3>;

/* ----- Normalized internal types (engine use) ----- */

export type OneClickOfferType = 'exact' | 'min' | 'max' | null;

export interface ConfigOneClickOffer {
  active: boolean;
  type: OneClickOfferType;
  code: string | null;
  autoApply: boolean;
  candidateCodes?: string[];
  maxSavingsCents?: number;
}

export interface ConfigStacking {
  allowStacking: boolean;
  whitelistAutomatic: boolean;
}

export interface ConfigDiscounts {
  oneClickOffer: ConfigOneClickOffer;
  stacking: ConfigStacking;
  teaseMessage?: string;
  /** When true, show the coupon tease message banner. Default true. */
  showTeaseMessage: boolean;
}

export interface ConfigFreeGiftRule {
  variantId: number;
  minSubtotalCents: number;
  maxQuantity: number;
}

export interface ConfigFreeGifts {
  rules: ConfigFreeGiftRule[];
  giftVariantIds: Set<number>;
}

export interface ConfigUpsellRule {
  variantId: number;
  conditionSubtotalCents: number;
}

export interface ConfigUpsell {
  standardRules: ConfigUpsellRule[];
  variantToThreshold: Map<number, number>;
  aiEnabled: boolean;
  oneTick: { variantId: number } | null;
  /** Section heading for recommendations (e.g. "You may also like"). */
  recommendationsHeading: string;
}

export interface ConfigRewardsTier {
  thresholdCents: number;
  label: string;
}

export interface ConfigRewards {
  tiers: ConfigRewardsTier[];
}

export interface ConfigCheckout {
  enabled: boolean;
  checkoutUrl: string;
}

export interface ConfigAnalytics {
  enabled: boolean;
}

export interface ConfigFreeShipping {
  thresholdCents: number | null;
}

export interface ConfigFeatureFlags {
  enableDiscounts: boolean;
  enableFreeGifts: boolean;
  enableUpsell: boolean;
  enableRewards: boolean;
  enableCheckout: boolean;
  enableAnalytics: boolean;
}

/**
 * Appearance slice of normalized config. Pass-through from canonical;
 * used only for UI (CSS variables). Engine does not use for behavior.
 */
export interface ConfigAppearance {
  primaryColor: string;
  accentColor: string;
  borderRadius: number;
  showConfetti: boolean;
  countdownEnabled: boolean;
  emojiMode: boolean;
  countdownDurationMs?: number;
  showHeaderBanner: boolean;
  backgroundColor?: string;
  bannerBackgroundColor?: string;
  surfaceColor?: string;
  textColor?: string;
  borderColor?: string;
  shadowColor?: string;
  merchantCartDrawerSelector?: string;
  cartHeaderMessages?: string[];
}

/**
 * Normalized runtime config. Immutable after loadConfig(); all defaults applied,
 * tiers sorted, gift set and upsell maps precomputed. Engine uses this only.
 */
export interface NormalizedEngineConfig {
  version: string;
  appearance: ConfigAppearance;
  discounts: ConfigDiscounts;
  freeGifts: ConfigFreeGifts;
  upsell: ConfigUpsell;
  rewards: ConfigRewards;
  checkout: ConfigCheckout;
  analytics: ConfigAnalytics;
  featureFlags: ConfigFeatureFlags;
  freeShipping: ConfigFreeShipping;
}
