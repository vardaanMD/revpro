/**
 * Cart Pro V3 — canonical config schema (single source of truth).
 * Used for persisted configV3, snapshot response, and runtime input.
 * Do not mutate DEFAULT_CONFIG_V3; use mergeWithDefaultV3 for merging.
 */

export interface CartProConfigV3Appearance {
  primaryColor: string;
  accentColor: string;
  borderRadius: number;
  showConfetti: boolean;
  countdownEnabled: boolean;
  emojiMode: boolean;
  /** Urgency countdown duration in milliseconds. Source of truth for countdown length. */
  countdownDurationMs?: number;
  /** Up to 3 custom messages shown below "Your Cart" that rotate. */
  cartHeaderMessages?: [string?, string?, string?] | string[];
  /** Drawer background color (behind cart content). */
  backgroundColor?: string;
  /** Background color for the header message banner section (below "Your Cart"). */
  bannerBackgroundColor?: string;
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
  strategy: "manual" | "collection" | "aov" | "ai";
  limit: number;
  collections: string[];
  standardRules: unknown[];
  ai: CartProConfigV3UpsellAi;
}

export interface CartProConfigV3Rewards {
  tiers: unknown[];
}

export interface CartProConfigV3Discounts {
  allowStacking: boolean;
  whitelist: string[];
  teaseMessage?: string;
}

export interface CartProConfigV3FreeGifts {
  rules: unknown[];
}

export interface CartProConfigV3CheckoutOverlay {
  enabled: boolean;
  /** Optional URL for overlay iframe; set by block/snapshot for backward compat. */
  checkoutUrl?: string;
}

export interface CartProConfigV3Checkout {
  mode: "default" | "overlay";
  overlay: CartProConfigV3CheckoutOverlay;
}

export interface CartProConfigV3Analytics {
  enabled: boolean;
  batchSize: number;
  flushIntervalMs: number;
}

export type RuntimeVersion = "v3";

export interface CartProConfigV3 {
  version: string;
  /** Cart drawer runtime. Always V3. */
  runtimeVersion?: RuntimeVersion;
  appearance: CartProConfigV3Appearance;
  featureFlags: CartProConfigV3FeatureFlags;
  upsell: CartProConfigV3Upsell;
  rewards: CartProConfigV3Rewards;
  discounts: CartProConfigV3Discounts;
  freeGifts: CartProConfigV3FreeGifts;
  freeShipping?: {
    thresholdCents?: number | null;
  };
  checkout: CartProConfigV3Checkout;
  analytics: CartProConfigV3Analytics;
}

/** Safe defaults consistent with current V3 runtime behavior; do not mutate. */
export const DEFAULT_CONFIG_V3 = Object.freeze({
  version: "3.0.0",
  runtimeVersion: "v3" as RuntimeVersion,
  appearance: {
    primaryColor: "#111111",
    accentColor: "#16a34a",
    borderRadius: 12,
    showConfetti: true,
    countdownEnabled: true,
    emojiMode: true,
    countdownDurationMs: 600000,
    backgroundColor: "#ffffff",
    bannerBackgroundColor: "#16a34a",
  },
  featureFlags: {
    enableUpsell: false,
    enableRewards: false,
    enableDiscounts: false,
    enableFreeGifts: false,
    enableCheckoutOverride: false,
    enableAnalytics: false,
  },
  upsell: {
    strategy: "manual",
    limit: 1,
    collections: [],
    standardRules: [],
    ai: { enabled: false },
  },
  rewards: {
    tiers: [],
  },
  discounts: {
    allowStacking: false,
    whitelist: [],
    teaseMessage: "Apply coupon at checkout to unlock savings",
  },
  freeShipping: {
    thresholdCents: 5000,
  },
  freeGifts: {
    rules: [],
  },
  checkout: {
    mode: "default",
    overlay: { enabled: false },
  },
  analytics: {
    enabled: false,
    batchSize: 5,
    flushIntervalMs: 5000,
  },
}) as CartProConfigV3;

/**
 * Deep merge persisted config into defaults. Never mutates DEFAULT_CONFIG_V3.
 * Preserves nested defaults for missing keys; arrays/objects are merged recursively
 * where sensible (arrays from persisted replace defaults when present).
 */
export function mergeWithDefaultV3(
  persisted: Partial<CartProConfigV3> | null | undefined
): CartProConfigV3 {
  if (persisted == null || typeof persisted !== "object" || Array.isArray(persisted)) {
    return { ...deepCloneConfig(DEFAULT_CONFIG_V3) };
  }

  const base = deepCloneConfig(DEFAULT_CONFIG_V3);

  if (typeof persisted.version === "string" && persisted.version.trim()) {
    base.version = persisted.version.trim();
  }

  // Runtime is always V3; ignore any persisted v1/v2.
  base.runtimeVersion = "v3";

  if (persisted.appearance && typeof persisted.appearance === "object" && !Array.isArray(persisted.appearance)) {
    const a = persisted.appearance as Partial<CartProConfigV3Appearance>;
    if (typeof a.primaryColor === "string") base.appearance.primaryColor = a.primaryColor;
    if (typeof a.accentColor === "string") base.appearance.accentColor = a.accentColor;
    if (typeof a.borderRadius === "number" && Number.isFinite(a.borderRadius)) base.appearance.borderRadius = Math.floor(a.borderRadius);
    if (typeof a.showConfetti === "boolean") base.appearance.showConfetti = a.showConfetti;
    if (typeof a.countdownEnabled === "boolean") base.appearance.countdownEnabled = a.countdownEnabled;
    if (typeof a.emojiMode === "boolean") base.appearance.emojiMode = a.emojiMode;
    if (typeof a.countdownDurationMs === "number" && Number.isFinite(a.countdownDurationMs) && a.countdownDurationMs > 0) {
      base.appearance.countdownDurationMs = Math.floor(a.countdownDurationMs);
    }
    if (Array.isArray(a.cartHeaderMessages)) {
      base.appearance.cartHeaderMessages = a.cartHeaderMessages
        .filter((m): m is string => typeof m === "string" && m.trim() !== "")
        .slice(0, 3)
        .map((m) => (m ?? "").trim());
    }
    if (typeof a.backgroundColor === "string" && a.backgroundColor.trim()) {
      base.appearance.backgroundColor = a.backgroundColor.trim();
    }
    if (typeof a.bannerBackgroundColor === "string" && a.bannerBackgroundColor.trim()) {
      base.appearance.bannerBackgroundColor = a.bannerBackgroundColor.trim();
    }
  }

  if (persisted.featureFlags && typeof persisted.featureFlags === "object" && !Array.isArray(persisted.featureFlags)) {
    const f = persisted.featureFlags as Partial<CartProConfigV3FeatureFlags>;
    if (typeof f.enableUpsell === "boolean") base.featureFlags.enableUpsell = f.enableUpsell;
    if (typeof f.enableRewards === "boolean") base.featureFlags.enableRewards = f.enableRewards;
    if (typeof f.enableDiscounts === "boolean") base.featureFlags.enableDiscounts = f.enableDiscounts;
    if (typeof f.enableFreeGifts === "boolean") base.featureFlags.enableFreeGifts = f.enableFreeGifts;
    if (typeof f.enableCheckoutOverride === "boolean") base.featureFlags.enableCheckoutOverride = f.enableCheckoutOverride;
    if (typeof f.enableAnalytics === "boolean") base.featureFlags.enableAnalytics = f.enableAnalytics;
  }

  if (persisted.upsell && typeof persisted.upsell === "object" && !Array.isArray(persisted.upsell)) {
    const u = persisted.upsell as Partial<CartProConfigV3Upsell>;
    base.upsell.strategy = ["manual", "collection", "aov", "ai"].includes(u.strategy as string) ? u.strategy as CartProConfigV3Upsell["strategy"] : base.upsell.strategy;
    if (typeof u.limit === "number" && Number.isFinite(u.limit) && u.limit >= 0) base.upsell.limit = Math.floor(u.limit);
    if (Array.isArray(u.collections)) base.upsell.collections = u.collections.filter((c): c is string => typeof c === "string");
    if (Array.isArray(u.standardRules)) base.upsell.standardRules = u.standardRules;
    if (u.ai && typeof u.ai === "object" && !Array.isArray(u.ai)) {
      base.upsell.ai = {
        enabled: Boolean(u.ai.enabled),
        endpoint: typeof u.ai.endpoint === "string" ? u.ai.endpoint : undefined,
      };
    }
  }

  if (persisted.rewards && typeof persisted.rewards === "object" && !Array.isArray(persisted.rewards)) {
    if (Array.isArray((persisted.rewards as CartProConfigV3Rewards).tiers)) {
      base.rewards.tiers = (persisted.rewards as CartProConfigV3Rewards).tiers;
    }
  }

  if (persisted.discounts && typeof persisted.discounts === "object" && !Array.isArray(persisted.discounts)) {
    const d = persisted.discounts as Partial<CartProConfigV3Discounts>;
    if (typeof d.allowStacking === "boolean") base.discounts.allowStacking = d.allowStacking;
    if (Array.isArray(d.whitelist)) base.discounts.whitelist = d.whitelist.filter((w): w is string => typeof w === "string");
    base.discounts.teaseMessage = d.teaseMessage ?? base.discounts.teaseMessage;
  }

  base.freeShipping = {
    thresholdCents: persisted?.freeShipping?.thresholdCents ?? base.freeShipping?.thresholdCents ?? null,
  };

  if (persisted.freeGifts && typeof persisted.freeGifts === "object" && !Array.isArray(persisted.freeGifts)) {
    if (Array.isArray((persisted.freeGifts as CartProConfigV3FreeGifts).rules)) {
      base.freeGifts.rules = (persisted.freeGifts as CartProConfigV3FreeGifts).rules;
    }
  }

  if (persisted.checkout && typeof persisted.checkout === "object" && !Array.isArray(persisted.checkout)) {
    const c = persisted.checkout as Partial<CartProConfigV3Checkout>;
    if (c.mode === "default" || c.mode === "overlay") base.checkout.mode = c.mode;
    if (c.overlay && typeof c.overlay === "object" && !Array.isArray(c.overlay)) {
      if (typeof c.overlay.enabled === "boolean") base.checkout.overlay.enabled = c.overlay.enabled;
      if (typeof c.overlay.checkoutUrl === "string") base.checkout.overlay.checkoutUrl = c.overlay.checkoutUrl;
    }
  }

  if (persisted.analytics && typeof persisted.analytics === "object" && !Array.isArray(persisted.analytics)) {
    const a = persisted.analytics as Partial<CartProConfigV3Analytics>;
    if (typeof a.enabled === "boolean") base.analytics.enabled = a.enabled;
    if (typeof a.batchSize === "number" && Number.isFinite(a.batchSize) && a.batchSize > 0) base.analytics.batchSize = Math.floor(a.batchSize);
    if (typeof a.flushIntervalMs === "number" && Number.isFinite(a.flushIntervalMs) && a.flushIntervalMs > 0) base.analytics.flushIntervalMs = Math.floor(a.flushIntervalMs);
  }

  return base;
}

function deepCloneConfig(config: CartProConfigV3): CartProConfigV3 {
  return JSON.parse(JSON.stringify(config)) as CartProConfigV3;
}
