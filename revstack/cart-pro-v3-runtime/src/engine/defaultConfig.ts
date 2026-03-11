/**
 * Cart Pro V3 — bundle-embedded default config.
 * Passed through normalizeConfig() so all precomputed structures (Sets, Maps,
 * sorted tiers) are initialized at module load.
 * Engine initializes `this.config` to this so getConfig() never returns null
 * before snapshot/cache loads.
 */
import type { RawCartProConfig } from './configSchema';

export const defaultConfig: RawCartProConfig = {
  version: '3.0.0',
  appearance: {
    primaryColor: '#333',
    accentColor: '#16a34a',
    borderRadius: 12,
    showConfetti: true,
    countdownEnabled: true,
    emojiMode: true,
    countdownDurationMs: 600_000,
    cartHeaderMessages: [],
    bannerBackgroundColor: '#16a34a',
  },
  featureFlags: {
    enableUpsell: true,
    enableRewards: true,
    enableDiscounts: true,
    enableFreeGifts: true,
    enableCheckoutOverride: false,
    enableAnalytics: true,
  },
  upsell: {
    strategy: 'collection',
    limit: 4,
    collections: [],
    standardRules: [],
    ai: { enabled: false },
    recommendationsHeading: 'You may also like',
  },
  rewards: {
    tiers: [],
  },
  discounts: {
    allowStacking: false,
    whitelist: [],
    teaseMessage: 'Apply coupon at checkout to unlock savings',
  },
  freeGifts: {
    rules: [],
  },
  checkout: {
    mode: 'default',
    overlay: { enabled: false },
  },
  analytics: {
    enabled: true,
    batchSize: 10,
    flushIntervalMs: 5_000,
  },
  freeShipping: {
    thresholdCents: undefined,
  },
};
