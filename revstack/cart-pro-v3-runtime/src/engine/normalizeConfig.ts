/**
 * Cart Pro V3 — config normalization.
 * Maps canonical CartProConfigV3 (snapshot) -> NormalizedEngineConfig (engine internal).
 * Ensures defaults, sorted tiers, precomputed sets/maps, validated flags.
 */
import type {
  RawCartProConfig,
  NormalizedEngineConfig,
  ConfigAppearance,
  ConfigDiscounts,
  ConfigOneClickOffer,
  ConfigStacking,
  ConfigFreeGifts,
  ConfigFreeGiftRule,
  ConfigUpsell,
  ConfigUpsellRule,
  ConfigRewards,
  ConfigRewardsTier,
  ConfigCheckout,
  ConfigAnalytics,
  ConfigFreeShipping,
  ConfigFeatureFlags,
} from './configSchema';

const DEFAULT_VERSION = '3.0.0';

function sanitizeNonNegativeInt(value: unknown, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.floor(n);
}

function sanitizeNonNegativeNumber(value: unknown, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return n;
}

function normalizeOneClickOffer(): ConfigOneClickOffer {
  return {
    active: false,
    type: null,
    code: null,
    autoApply: false,
  };
}

function normalizeStacking(raw: RawCartProConfig): ConfigStacking {
  const d = raw.discounts;
  const allowStacking = typeof d?.allowStacking === 'boolean' ? d.allowStacking : false;
  const whitelist = Array.isArray(d?.whitelist) ? d.whitelist : [];
  return {
    allowStacking,
    whitelistAutomatic: whitelist.length > 0,
  };
}

function normalizeDiscounts(raw: RawCartProConfig): ConfigDiscounts {
  const d = raw.discounts;
  const teaseMessage = typeof d?.teaseMessage === 'string' ? d.teaseMessage.trim() || undefined : undefined;
  return {
    oneClickOffer: normalizeOneClickOffer(),
    stacking: normalizeStacking(raw),
    teaseMessage,
  };
}

function normalizeFreeGiftRule(r: unknown): ConfigFreeGiftRule | null {
  if (!r || typeof r !== 'object') return null;
  const o = r as Record<string, unknown>;
  const variantId = sanitizeNonNegativeInt(o.variantId, 0);
  if (variantId <= 0) return null;
  const minSubtotalCents = sanitizeNonNegativeNumber(o.minSubtotalCents, 0);
  const maxQuantity = sanitizeNonNegativeInt(o.maxQuantity, 1);
  if (maxQuantity <= 0) return null;
  return { variantId, minSubtotalCents, maxQuantity };
}

function normalizeFreeGifts(raw: RawCartProConfig): ConfigFreeGifts {
  const rulesRaw = raw.freeGifts?.rules;
  const rules: ConfigFreeGiftRule[] = [];
  if (Array.isArray(rulesRaw)) {
    for (const r of rulesRaw) {
      const rule = normalizeFreeGiftRule(r);
      if (rule) rules.push(rule);
    }
  }
  const giftVariantIds = new Set<number>();
  for (const rule of rules) {
    giftVariantIds.add(rule.variantId);
  }
  return { rules, giftVariantIds };
}

function normalizeUpsellRule(r: unknown): ConfigUpsellRule | null {
  if (!r || typeof r !== 'object') return null;
  const o = r as Record<string, unknown>;
  const variantId = sanitizeNonNegativeInt(o.variantId, 0);
  if (variantId <= 0) return null;
  const conditionSubtotalCents = sanitizeNonNegativeNumber(o.conditionSubtotalCents, 0);
  return { variantId, conditionSubtotalCents };
}

function normalizeUpsell(raw: RawCartProConfig): ConfigUpsell {
  const rulesRaw = raw.upsell?.standardRules;
  const standardRules: ConfigUpsellRule[] = [];
  if (Array.isArray(rulesRaw)) {
    for (const r of rulesRaw) {
      const rule = normalizeUpsellRule(r);
      if (rule) standardRules.push(rule);
    }
  }
  standardRules.sort((a, b) => a.conditionSubtotalCents - b.conditionSubtotalCents);
  const variantToThreshold = new Map<number, number>();
  for (const rule of standardRules) {
    variantToThreshold.set(rule.variantId, rule.conditionSubtotalCents);
  }
  const aiEnabled = Boolean(raw.upsell?.ai?.enabled);
  return {
    standardRules,
    variantToThreshold,
    aiEnabled,
    oneTick: null,
  };
}

/** Snapshot sends thresholdCents; persisted config from settings may send amount (cents). Accept both. */
function normalizeRewardsTier(t: unknown): ConfigRewardsTier | null {
  if (!t || typeof t !== 'object') return null;
  const o = t as Record<string, unknown>;
  const fromThreshold = typeof o.thresholdCents === 'number' && Number.isFinite(o.thresholdCents);
  const fromAmount = typeof o.amount === 'number' && Number.isFinite(o.amount);
  const thresholdCents = fromThreshold
    ? sanitizeNonNegativeNumber(o.thresholdCents, 0)
    : fromAmount
      ? sanitizeNonNegativeNumber(o.amount, 0)
      : 0;
  const label = typeof o.label === 'string' ? (o.label as string).trim() : '';
  return { thresholdCents, label: label || `Tier ${thresholdCents}` };
}

function normalizeRewards(raw: RawCartProConfig): ConfigRewards {
  const tiersRaw = raw.rewards?.tiers;
  const tiers: ConfigRewardsTier[] = [];
  if (Array.isArray(tiersRaw)) {
    for (const t of tiersRaw) {
      const tier = normalizeRewardsTier(t);
      if (tier) tiers.push(tier);
    }
  }
  tiers.sort((a, b) => a.thresholdCents - b.thresholdCents);
  return { tiers };
}

function normalizeCheckout(raw: RawCartProConfig): ConfigCheckout {
  const mode = raw.checkout?.mode;
  const overlay = raw.checkout?.overlay;
  const enabled =
    mode === 'overlay' &&
    overlay != null &&
    typeof overlay === 'object' &&
    Boolean(overlay.enabled);
  const checkoutUrl =
    typeof overlay?.checkoutUrl === 'string' ? (overlay.checkoutUrl as string).trim() : '';
  return {
    enabled,
    checkoutUrl,
  };
}

function normalizeAnalytics(raw: RawCartProConfig): ConfigAnalytics {
  return {
    enabled: raw.analytics?.enabled !== false,
  };
}

function normalizeFeatureFlags(raw: RawCartProConfig): ConfigFeatureFlags {
  const f = raw.featureFlags;
  return {
    enableDiscounts: f?.enableDiscounts !== false,
    enableFreeGifts: f?.enableFreeGifts !== false,
    enableUpsell: f?.enableUpsell !== false,
    enableRewards: f?.enableRewards !== false,
    enableCheckout: f?.enableCheckoutOverride === true,
    enableAnalytics: f?.enableAnalytics !== false,
  };
}

function normalizeFreeShipping(raw: RawCartProConfig): ConfigFreeShipping {
  const th = raw.freeShipping?.thresholdCents;
  const thresholdCents = typeof th === 'number' && Number.isFinite(th) && th >= 0 ? th : null;
  return { thresholdCents };
}

const DEFAULT_PRIMARY = '#333';
const DEFAULT_ACCENT = '#16a34a';
const DEFAULT_BORDER_RADIUS = 12;
const DEFAULT_BACKGROUND = '#ffffff';

function normalizeAppearance(raw: RawCartProConfig): ConfigAppearance {
  const a = raw.appearance;
  const defaultCountdownDurationMs = 600000;
  if (!a || typeof a !== 'object' || Array.isArray(a)) {
    return {
      primaryColor: DEFAULT_PRIMARY,
      accentColor: DEFAULT_ACCENT,
      borderRadius: DEFAULT_BORDER_RADIUS,
      showConfetti: true,
      countdownEnabled: true,
      emojiMode: true,
      countdownDurationMs: defaultCountdownDurationMs,
      backgroundColor: DEFAULT_BACKGROUND,
    };
  }
  const primaryColor = typeof a.primaryColor === 'string' && a.primaryColor.trim() ? a.primaryColor.trim() : DEFAULT_PRIMARY;
  const accentColor = typeof a.accentColor === 'string' && a.accentColor.trim() ? a.accentColor.trim() : DEFAULT_ACCENT;
  const borderRadius = typeof a.borderRadius === 'number' && Number.isFinite(a.borderRadius) && a.borderRadius >= 0
    ? Math.floor(a.borderRadius)
    : DEFAULT_BORDER_RADIUS;
  const countdownDurationMs =
    typeof a.countdownDurationMs === 'number' && Number.isFinite(a.countdownDurationMs) && a.countdownDurationMs > 0
      ? Math.floor(a.countdownDurationMs)
      : defaultCountdownDurationMs;
  const merchantCartDrawerSelector =
    typeof a.merchantCartDrawerSelector === 'string' && a.merchantCartDrawerSelector.trim()
      ? a.merchantCartDrawerSelector.trim()
      : undefined;
  const backgroundColor =
    typeof a.backgroundColor === 'string' && a.backgroundColor.trim()
      ? a.backgroundColor.trim()
      : DEFAULT_BACKGROUND;
  const cartHeaderMessages = Array.isArray(a.cartHeaderMessages)
    ? a.cartHeaderMessages.filter((m): m is string => typeof m === 'string' && m.trim() !== '').slice(0, 3).map((m) => m.trim())
    : undefined;
  return {
    primaryColor,
    accentColor,
    borderRadius,
    showConfetti: typeof a.showConfetti === 'boolean' ? a.showConfetti : true,
    countdownEnabled: typeof a.countdownEnabled === 'boolean' ? a.countdownEnabled : true,
    emojiMode: typeof a.emojiMode === 'boolean' ? a.emojiMode : true,
    countdownDurationMs,
    merchantCartDrawerSelector,
    cartHeaderMessages: (cartHeaderMessages?.length ?? 0) > 0 ? cartHeaderMessages : undefined,
    backgroundColor,
  };
}

/**
 * Normalize canonical (or partial) config into NormalizedEngineConfig.
 * Snapshot returns full CartProConfigV3; this maps to engine-internal shape.
 */
export function normalizeConfig(
  rawConfig: RawCartProConfig | null | undefined
): NormalizedEngineConfig {
  const raw = rawConfig && typeof rawConfig === 'object' ? rawConfig : {};
  return {
    version: typeof raw.version === 'string' ? raw.version.trim() || DEFAULT_VERSION : DEFAULT_VERSION,
    appearance: normalizeAppearance(raw),
    discounts: normalizeDiscounts(raw),
    freeGifts: normalizeFreeGifts(raw),
    upsell: normalizeUpsell(raw),
    rewards: normalizeRewards(raw),
    checkout: normalizeCheckout(raw),
    analytics: normalizeAnalytics(raw),
    featureFlags: normalizeFeatureFlags(raw),
    freeShipping: normalizeFreeShipping(raw),
  };
}
