/**
 * Cart Pro V3 — engine state.
 * Centralized, strongly typed, immutable updates.
 */
import { get, writable } from 'svelte/store';
import type { Writable } from 'svelte/store';

export type AppStatus = 'BOOTING' | 'READY' | 'ERROR';

export interface AppState {
  status: AppStatus;
  version: 'v3';
}

export interface UIState {
  drawerOpen: boolean;
  loaderCount: number;
}

export interface RuntimeState {
  initializedAt: number | null;
}

export interface CartState {
  raw: any | null;
  itemCount: number;
  subtotal: number;
  total: number;
  syncing: boolean;
  lastSyncedAt: number | null;
}

export type DiscountType = 'percentage' | 'fixed';

export interface AppliedDiscount {
  code: string;
  amount: number;
  type: DiscountType;
}

/** One-click offer config. For "min", use candidateCodes; for "max", use maxSavingsCents. */
export type OneClickOfferType = 'exact' | 'min' | 'max' | null;

export interface OneClickOfferState {
  active: boolean;
  type: OneClickOfferType;
  code: string | null;
  autoApply: boolean;
  /** For type "min": candidate codes to validate; apply the one with highest savings. */
  candidateCodes?: string[];
  /** For type "max": apply code only if savings <= this (cents). */
  maxSavingsCents?: number;
}

export interface StackingState {
  allowStacking: boolean;
  whitelistAutomatic: boolean;
}

/** Free gift rule: variant, subtotal threshold (cents), max quantity. */
export interface FreeGiftConfigItem {
  variantId: number;
  minSubtotalCents: number;
  maxQuantity: number;
}

export interface FreeGiftsState {
  config: FreeGiftConfigItem[];
  syncing: boolean;
  lastSyncAt: number | null;
}

/** Standard upsell rule: show variant when subtotal >= conditionSubtotalCents. */
export interface StandardUpsellRule {
  variantId: number;
  conditionSubtotalCents: number;
}

export interface UpsellState {
  /** Config for standard upsell rules (set by block/app). */
  standardConfig: StandardUpsellRule[];
  /** Computed list: eligible variants not in cart. */
  standard: StandardUpsellRule[];
  oneTick: { variantId: number } | null;
  aiEnabled: boolean;
  aiRecommendations: Array<{ variantId: number }>;
  loading: boolean;
  /** Variant ID -> available (from /variants/{id}.js). */
  cache: Record<number, boolean>;
}

/**
 * Discount state. Applied list is reconciled with cart.cart_level_discount_applications after sync.
 */
export interface DiscountState {
  applied: AppliedDiscount[];
  validating: boolean;
  lastError: string | null;
  oneClickOffer: OneClickOfferState;
  stacking: StackingState;
}

export interface RewardsTier {
  thresholdCents: number;
  label: string;
}

export interface RewardsState {
  tiers: RewardsTier[];
  unlockedTierIndex: number | null;
  lastUnlockedTierIndex: number | null;
  showConfetti: boolean;
}

/** Checkout overlay state machine: IDLE → LOGIN → OTP → ADDRESS → PAYMENT → COMPLETE. */
export type CheckoutStateValue = 'IDLE' | 'LOGIN' | 'OTP' | 'ADDRESS' | 'PAYMENT' | 'COMPLETE';

export interface CheckoutState {
  enabled: boolean;
  state: CheckoutStateValue;
  jwtToken: string | null;
  overlayVisible: boolean;
  loading: boolean;
  addressList: any[];
  selectedAddress: any | null;
  /** URL for checkout iframe (set by block/config). */
  checkoutUrl: string;
}

export interface AnalyticsState {
  enabled: boolean;
  queue: any[];
  sending: boolean;
  lastFlushAt: number | null;
  sessionId: string;
}

export interface ShippingState {
  remaining: number | null;
  unlocked: boolean;
  loading: boolean;
}

/** Hydrated recommendations from snapshot (title, imageUrl, price, handle). Used by UI for full product cards. */
export interface SnapshotRecommendationItem {
  variantId: number;
  /** Shopify product ID for Order Impact attribution (recommendation:click). Optional if backend does not provide it. */
  productId?: string;
  title: string;
  imageUrl?: string | null;
  price?: {
    amount?: number;
    compare_at_amount?: number | null;
  };
  handle?: string;
}

/** Collection-aware snapshot data: keyed recommendation buckets and product→collections map. */
export interface SnapshotRecommendationsByCollection {
  recommendationsByCollection: Record<string, SnapshotRecommendationItem[]>;
  productToCollections: Record<string, string[]>;
}

export interface EngineState {
  app: AppState;
  ui: UIState;
  runtime: RuntimeState;
  cart: CartState;
  discount: DiscountState;
  freeGifts: FreeGiftsState;
  upsell: UpsellState;
  rewards: RewardsState;
  checkout: CheckoutState;
  analytics: AnalyticsState;
  shipping: ShippingState;
  /** Hydrated recommendations from backend snapshot; primary source for recommendations UI. */
  snapshotRecommendations: SnapshotRecommendationItem[];
  /** Incremented when snapshotRecommendations is replaced (bucket swap or decision refinement); used for list fade transition. */
  recommendationListVersion: number;
  /** Keyed buckets per collection + product→collections map; used to derive which bucket to show from cart. */
  recommendationsByCollection: Record<string, SnapshotRecommendationItem[]>;
  productToCollections: Record<string, string[]>;
}

/** Deep partial for state updates: each top-level key is optional and can be a partial of that slice. */
export type PartialEngineState = {
  app?: Partial<AppState>;
  ui?: Partial<UIState>;
  runtime?: Partial<RuntimeState>;
  cart?: Partial<CartState>;
  discount?: Partial<DiscountState>;
  freeGifts?: Partial<FreeGiftsState>;
  upsell?: Partial<UpsellState>;
  rewards?: Partial<RewardsState>;
  checkout?: Partial<CheckoutState>;
  analytics?: Partial<AnalyticsState>;
  shipping?: Partial<ShippingState>;
  snapshotRecommendations?: SnapshotRecommendationItem[];
  recommendationListVersion?: number;
  recommendationsByCollection?: Record<string, SnapshotRecommendationItem[]>;
  productToCollections?: Record<string, string[]>;
};

export function createInitialState(): EngineState {
  return {
    app: {
      status: 'BOOTING',
      version: 'v3',
    },
    ui: {
      drawerOpen: false,
      loaderCount: 0,
    },
    runtime: {
      initializedAt: null,
    },
    cart: {
      raw: null,
      itemCount: 0,
      subtotal: 0,
      total: 0,
      syncing: false,
      lastSyncedAt: null,
    },
    discount: {
      applied: [],
      validating: false,
      lastError: null,
      oneClickOffer: {
        active: false,
        type: null,
        code: null,
        autoApply: false,
      },
      stacking: {
        allowStacking: false,
        whitelistAutomatic: false,
      },
    },
    freeGifts: {
      config: [],
      syncing: false,
      lastSyncAt: null,
    },
    upsell: {
      standardConfig: [],
      standard: [],
      oneTick: null,
      aiEnabled: false,
      aiRecommendations: [],
      loading: false,
      cache: {},
    },
    rewards: {
      tiers: [],
      unlockedTierIndex: null,
      lastUnlockedTierIndex: null,
      showConfetti: false,
    },
    checkout: {
      enabled: false,
      state: 'IDLE',
      jwtToken: null,
      overlayVisible: false,
      loading: false,
      addressList: [],
      selectedAddress: null,
      checkoutUrl: '',
    },
    analytics: {
      enabled: true,
      queue: [],
      sending: false,
      lastFlushAt: null,
      sessionId: '',
    },
    shipping: {
      remaining: null,
      unlocked: false,
      loading: true,
    },
    snapshotRecommendations: [],
    recommendationListVersion: 0,
    recommendationsByCollection: {},
    productToCollections: {},
  };
}

/** Generate a stable session ID for analytics (set once at init). */
export function createSessionId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 11)}`;
}

export function createStateStore(): Writable<EngineState> {
  return writable(createInitialState());
}

export function getState(store: Writable<EngineState>): EngineState {
  return get(store);
}

export function setState(
  store: Writable<EngineState>,
  partial: PartialEngineState
): void {
  store.update((s) => {
    const next = { ...s };
    if (partial.app != null) next.app = { ...s.app, ...partial.app };
    if (partial.ui != null) next.ui = { ...s.ui, ...partial.ui };
    if (partial.runtime != null) next.runtime = { ...s.runtime, ...partial.runtime };
    if (partial.cart != null) next.cart = { ...s.cart, ...partial.cart };
    if (partial.discount != null) {
      next.discount = { ...s.discount, ...partial.discount };
      if (partial.discount.oneClickOffer != null)
        next.discount.oneClickOffer = { ...s.discount.oneClickOffer, ...partial.discount.oneClickOffer };
      if (partial.discount.stacking != null)
        next.discount.stacking = { ...s.discount.stacking, ...partial.discount.stacking };
    }
    if (partial.freeGifts != null) next.freeGifts = { ...s.freeGifts, ...partial.freeGifts };
    if (partial.upsell != null) next.upsell = { ...s.upsell, ...partial.upsell };
    if (partial.rewards != null) next.rewards = { ...s.rewards, ...partial.rewards };
    if (partial.checkout != null) next.checkout = { ...s.checkout, ...partial.checkout };
    if (partial.analytics != null) next.analytics = { ...s.analytics, ...partial.analytics };
    if (partial.shipping != null) next.shipping = { ...s.shipping, ...partial.shipping };
    if (partial.snapshotRecommendations != null) next.snapshotRecommendations = partial.snapshotRecommendations;
    if (partial.recommendationListVersion != null) next.recommendationListVersion = partial.recommendationListVersion;
    if (partial.recommendationsByCollection != null) next.recommendationsByCollection = partial.recommendationsByCollection;
    if (partial.productToCollections != null) next.productToCollections = partial.productToCollections;
    return next;
  });
}

export function updateState(
  store: Writable<EngineState>,
  updaterFn: (state: EngineState) => PartialEngineState
): void {
  store.update((s) => {
    const partial = updaterFn(s);
    const next = { ...s };
    if (partial.app != null) next.app = { ...s.app, ...partial.app };
    if (partial.ui != null) next.ui = { ...s.ui, ...partial.ui };
    if (partial.runtime != null) next.runtime = { ...s.runtime, ...partial.runtime };
    if (partial.cart != null) next.cart = { ...s.cart, ...partial.cart };
    if (partial.discount != null) {
      next.discount = { ...s.discount, ...partial.discount };
      if (partial.discount.oneClickOffer != null)
        next.discount.oneClickOffer = { ...s.discount.oneClickOffer, ...partial.discount.oneClickOffer };
      if (partial.discount.stacking != null)
        next.discount.stacking = { ...s.discount.stacking, ...partial.discount.stacking };
    }
    if (partial.freeGifts != null) next.freeGifts = { ...s.freeGifts, ...partial.freeGifts };
    if (partial.upsell != null) next.upsell = { ...s.upsell, ...partial.upsell };
    if (partial.rewards != null) next.rewards = { ...s.rewards, ...partial.rewards };
    if (partial.checkout != null) next.checkout = { ...s.checkout, ...partial.checkout };
    if (partial.analytics != null) next.analytics = { ...s.analytics, ...partial.analytics };
    if (partial.shipping != null) next.shipping = { ...s.shipping, ...partial.shipping };
    if (partial.snapshotRecommendations != null) next.snapshotRecommendations = partial.snapshotRecommendations;
    if (partial.recommendationListVersion != null) next.recommendationListVersion = partial.recommendationListVersion;
    if (partial.recommendationsByCollection != null) next.recommendationsByCollection = partial.recommendationsByCollection;
    if (partial.productToCollections != null) next.productToCollections = partial.productToCollections;
    return next;
  });
}
