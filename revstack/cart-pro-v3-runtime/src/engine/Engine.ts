/**
 * Cart Pro V3 — engine core.
 * Centralized state, event bus, effect queue, lifecycle control.
 */
import type { Writable } from 'svelte/store';
import {
  createStateStore,
  getState as getStateFromStore,
  setState as setStateOnStore,
  updateState as updateStateOnStore,
  createSessionId,
  type EngineState,
  type PartialEngineState,
  type CheckoutStateValue,
} from './state';
import {
  buildAnalyticsEvent,
  sendAnalyticsBatch,
  getDedupKey,
  BATCH_SIZE,
  FLUSH_INTERVAL_MS,
  DEDUP_WINDOW_MS,
} from './analytics';
import { createEventBus, type EventBus } from './eventBus';
import { createEffectQueue, type EffectQueue } from './effectQueue';
import { createCartInterceptor } from './interceptor';
import { fetchCart as apiFetchCart, addToCart as apiAddToCart, changeCart as apiChangeCart, removeItem as apiRemoveItem, updateCartAttributes } from './cartApi';
import { validateDiscount, removeDiscountFromCart } from './discountApi';
import { computeExpectedGifts, diffGifts, getGiftVariantIds } from './freeGift';
import { computeStandardUpsell } from './upsell';
import { computeUnlockedTier } from './rewards';
import { fetchVariantAvailability } from './variantApi';
import {
  getCartSignature as getCartSignatureForAi,
  debouncedPostRecommendations,
  type AIRecommendationItem,
} from './recommendationsApi';
import { fetchDecisionCrossSell } from './decisionApi';
import { buildStubRecommendations } from './recommendationsStub';
import type { AppliedDiscount, OneClickOfferState, SnapshotRecommendationItem } from './state';
import { normalizeConfig } from './normalizeConfig';
import type { NormalizedEngineConfig, RawCartProConfig } from './configSchema';
import { defaultConfig } from './defaultConfig';
import { createCountdown, type CountdownApi } from './countdown';

const REVALIDATION_DEBOUNCE_MS = 800;
/** Debounce for background decision call when cart changes (Phase 5). */
const DECISION_DEBOUNCE_MS = 500;

const REVPRO_SESSION_STORAGE_KEY = 'revpro_session_id';

/** Persistent session ID for order attribution (cart attribute + RevproClickSession). Survives page reloads. */
function getOrCreateRevproSessionId(): string {
  if (typeof window === 'undefined' || !window.localStorage) return '';
  try {
    let id = window.localStorage.getItem(REVPRO_SESSION_STORAGE_KEY);
    if (id && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) return id;
    id = typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 11)}`;
    window.localStorage.setItem(REVPRO_SESSION_STORAGE_KEY, id);
    return id;
  } catch {
    return '';
  }
}

/** Bundle-level default so getConfig() never returns null before snapshot loads. */
const DEFAULT_RUNTIME_CONFIG = Object.freeze(normalizeConfig(defaultConfig)) as NormalizedEngineConfig;

/** Fallback countdown duration when config.appearance.countdownDurationMs is missing. */
const DEFAULT_COUNTDOWN_MS = 10 * 60 * 1000;

/** Dev-only warnings for stress guards. */
const isDev =
  typeof (import.meta as unknown as { env?: { DEV?: boolean } })?.env !== 'undefined' &&
  (import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV === true;
const EFFECT_QUEUE_CAP_WARN = 50;
const ANALYTICS_QUEUE_SOFT_CAP_WARN = 100;

/** Preload images for the first N recommendation items (non-blocking). Phase 6: reduces layout shift and improves perceived performance. */
const RECOMMENDATION_PRELOAD_LIMIT = 12;

function preloadRecommendationImages(items: SnapshotRecommendationItem[]): void {
  if (!Array.isArray(items) || items.length === 0) return;
  const toPreload = items.slice(0, RECOMMENDATION_PRELOAD_LIMIT);
  setTimeout(() => {
    for (const item of toPreload) {
      const url = item?.imageUrl;
      if (typeof url === 'string' && url.trim()) {
        const img = new Image();
        img.src = url;
      }
    }
  }, 0);
}

/** Valid checkout state transitions: fromState -> Set of allowed toStates. */
const CHECKOUT_TRANSITIONS: Record<CheckoutStateValue, Set<CheckoutStateValue>> = {
  IDLE: new Set(['LOGIN']),
  LOGIN: new Set(['OTP', 'IDLE']),
  OTP: new Set(['LOGIN', 'ADDRESS', 'IDLE']),
  ADDRESS: new Set(['PAYMENT', 'IDLE']),
  PAYMENT: new Set(['COMPLETE', 'IDLE']),
  COMPLETE: new Set(['IDLE']),
};

/** Extract discount codes present on cart (Shopify cart.js shape). */
function getCodesFromCartRaw(raw: any): string[] {
  const codes: string[] = [];
  const discountCodes = raw?.discount_codes ?? raw?.discount_codes_applied ?? [];
  if (Array.isArray(discountCodes)) {
    for (const d of discountCodes) {
      const c = d?.code ?? d?.title;
      if (typeof c === 'string' && c.trim()) codes.push(c.trim().toLowerCase());
    }
  }
  const cartLevel = raw?.cart_level_discount_applications ?? raw?.cartLevelDiscountApplications ?? [];
  if (Array.isArray(cartLevel)) {
    for (const a of cartLevel) {
      const c = a?.code ?? a?.title;
      if (typeof c === 'string' && c.trim()) codes.push(c.trim().toLowerCase());
    }
  }
  return [...new Set(codes)];
}

/**
 * Normalize product ID from cart (may be number, string, or Shopify GID) to a string key
 * that matches productToCollections keys from the snapshot (catalog uses string IDs).
 */
function normalizeProductId(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'string' && value.trim()) {
    const s = value.trim();
    // Shopify GID: gid://shopify/Product/123456 -> use "123456" for lookup
    if (s.startsWith('gid://')) {
      const last = s.split('/').pop();
      return last ?? null;
    }
    return s;
  }
  return null;
}

/**
 * Derive primary collection key from cart items: collect product IDs, look up in productToCollections,
 * then pick the most frequent collection that has a bucket in recommendationsByCollection; else "default".
 * Fallback: if productToCollections is missing or empty, returns "default" so legacy snapshots still work.
 */
function getPrimaryCollectionKey(
  cartRaw: any,
  recommendationsByCollection: Record<string, { variantId: number }[]>,
  productToCollections: Record<string, string[]>
): string {
  if (!productToCollections || typeof productToCollections !== 'object' || Object.keys(productToCollections).length === 0) {
    return 'default';
  }
  const items = Array.isArray(cartRaw?.items) ? cartRaw.items : [];
  const collectionCount: Record<string, number> = {};
  for (const item of items) {
    const pid = normalizeProductId(item?.product_id);
    if (!pid) continue;
    const collections = productToCollections[pid];
    if (!Array.isArray(collections)) continue;
    for (const cid of collections) {
      if (typeof cid === 'string' && cid && recommendationsByCollection[cid]) {
        collectionCount[cid] = (collectionCount[cid] ?? 0) + 1;
      }
    }
  }
  let bestKey = 'default';
  let bestCount = 0;
  for (const [key, count] of Object.entries(collectionCount)) {
    if (count > bestCount) {
      bestCount = count;
      bestKey = key;
    }
  }
  return bestKey;
}

export class Engine {
  readonly stateStore: Writable<EngineState>;
  private readonly eventBus: EventBus;
  private readonly effectQueue: EffectQueue;
  private internalMutationInProgress = false;
  private revalidationTimer: ReturnType<typeof setTimeout> | null = null;
  /** Debounced background decision call: cleared on cart change, set to 500ms (Phase 5). */
  private decisionDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  /** AI recommendations cache by cart signature. */
  private aiRecommendationsCache = new Map<string, AIRecommendationItem[]>();
  /** Analytics: flush timer and retry backoff. */
  private analyticsFlushTimer: ReturnType<typeof setTimeout> | null = null;
  private analyticsRetryCount = 0;
  /** Dedup: key -> timestamp; prune entries older than DEDUP_WINDOW_MS. */
  private analyticsDedupMap = new Map<string, number>();
  /** Normalized runtime config (read-only). Initialized to default; loadConfig() overwrites when snapshot/cache loads. */
  private config: NormalizedEngineConfig = DEFAULT_RUNTIME_CONFIG;
  /** Destroyed: no more state updates, listeners removed, timers cleared. */
  private destroyed = false;
  /** Teardown: remove message listener. */
  private checkoutMessageHandler: ((e: MessageEvent) => void) | null = null;
  /** Teardown: disconnect PerformanceObserver. */
  private interceptorTeardown: (() => void) | null = null;
  /** Lightweight performance markers (internal, not logged). */
  private readonly perf: {
    bootTime?: number;
    cartSyncDuration?: number;
    discountValidationDuration?: number;
    freeGiftSyncDuration?: number;
    aiFetchDuration?: number;
  } = {};
  /** When AI fetch was triggered (for aiFetchDuration). */
  private aiFetchStartedAt = 0;
  /** Urgency countdown: separate from stateStore; start on cart sync when cart signature changes. */
  readonly countdown: CountdownApi;
  /** Cart signature when countdown was last started; restart only when signature changes. */
  private lastCountdownSignature: string | null = null;
  /** When we last applied cart from our own mutation (add/change/remove). Skip external-update sync for a short window to avoid overwriting with stale fetch (v1-style: UI stays stable). */
  private lastMutationAppliedAt = 0;
  /** True once we have set revpro_session_id on the cart this session (Order Impact attribution). */
  private revproSessionIdSet = false;
  /** Skip showConfetti on first rewards apply (initial sync / page load); only show on real new tier unlock after that. */
  private rewardsInitialized = false;

  /** Grace period (ms) after applying our own mutation during which we skip any sync and ignore cart:external-update (v1-style: mutation response is source of truth). */
  private static readonly MUTATION_GRACE_MS = 600;

  /** Expected quantity per line for changeCart; only apply mutation response if server qty matches (prevents snap-back from out-of-order responses). */
  private expectedQtyByLine = new Map<string, number>();
  /** Line keys we expect to be removed; only apply removeItem response if line is gone and we still expect it (prevents stale remove overwriting). */
  private expectedRemovedLineKeys = new Set<string>();
  /** Per-line in-flight guard: don't send a second changeCart for the same line until the first completes; merge by updating expected qty. */
  private changeCartInFlightByLine = new Set<string>();

  /** Sync changeInFlightLineKeys to state so UI can disable +/- per line. */
  private syncChangeInFlightLineKeysToState(): void {
    const lineKeys = Array.from(this.changeCartInFlightByLine);
    this.updateState((s) => ({
      cart: { ...s.cart, changeInFlightLineKeys: lineKeys },
    }));
  }

  /** Whether a changeCart request is in flight for this line (for disabling +/- in CartItem). */
  isChangeInFlightForLine(lineKey: string): boolean {
    return this.changeCartInFlightByLine.has(lineKey);
  }

  constructor() {
    this.stateStore = createStateStore();
    this.eventBus = createEventBus();
    this.effectQueue = createEffectQueue();
    this.countdown = createCountdown();
  }

  /** Cart signature for countdown restart: only restart when items/quantities change. */
  private getCartSignature(cartRaw: any): string {
    return cartRaw?.items?.map((i: any) => `${i.variant_id}:${i.quantity}`).join('|') ?? '';
  }

  getInternalMutationInProgress(): boolean {
    return (
      this.internalMutationInProgress ||
      Date.now() - this.lastMutationAppliedAt < Engine.MUTATION_GRACE_MS
    );
  }

  init(): void {
    const bootStart = typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
    const sessionId = getOrCreateRevproSessionId() || createSessionId();
    this.setState({
      app: { status: 'BOOTING' },
      runtime: { initializedAt: Date.now() },
      analytics: { sessionId },
    });
    this.interceptorTeardown = createCartInterceptor(this);
    this.on('cart:external-update', () => {
      if (Date.now() - this.lastMutationAppliedAt < Engine.MUTATION_GRACE_MS) return;
      this.enqueueEffect(async () => {
        await this.syncCart();
      });
    });
    this.setupCheckoutPostMessage();
    this.perf.bootTime =
      typeof performance !== 'undefined' && performance.now ? performance.now() - bootStart : 0;
    // Setup complete; transition to READY
    this.setState({ app: { status: 'READY' } });
    setTimeout(() => this.emit('engine:ready', { status: 'READY' }), 0);
  }

  /**
   * Clean up all listeners, timers, and observers. Call when unmounting or tearing down.
   * After destroy(), state updates and effects are no-ops where checked.
   */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.revalidationTimer) {
      clearTimeout(this.revalidationTimer);
      this.revalidationTimer = null;
    }
    if (this.decisionDebounceTimer) {
      clearTimeout(this.decisionDebounceTimer);
      this.decisionDebounceTimer = null;
    }
    if (this.analyticsFlushTimer) {
      clearTimeout(this.analyticsFlushTimer);
      this.analyticsFlushTimer = null;
    }
    if (typeof window !== 'undefined' && this.checkoutMessageHandler) {
      window.removeEventListener('message', this.checkoutMessageHandler);
      this.checkoutMessageHandler = null;
    }
    if (this.interceptorTeardown) {
      this.interceptorTeardown();
      this.interceptorTeardown = null;
    }
    this.countdown.destroy();
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }

  getVersion(): string {
    return 'v3';
  }

  /**
   * Return the internal normalized config (read-only). Used by mount layer to apply
   * appearance CSS variables. Does not mutate; never null (default until loadConfig overwrites).
   */
  getConfig(): NormalizedEngineConfig {
    return this.config;
  }

  /**
   * Load and normalize runtime config; set engine state slices; freeze config reference.
   * Call after init() (e.g. from block or host). Backward compatible: state slices match
   * current shape; feature flags gate module execution.
   * Fail-safe: on normalize/setState error, falls back to default config (empty features).
   */
  loadConfig(rawConfig: RawCartProConfig): void {
    try {
      const normalized = normalizeConfig(rawConfig);
      this.config = Object.freeze(normalized) as NormalizedEngineConfig;

      const c = this.config;
      this.setState({
        discount: {
          oneClickOffer: { ...c.discounts.oneClickOffer },
          stacking: { ...c.discounts.stacking },
        },
        freeGifts: { config: c.freeGifts.rules.map((r) => ({ ...r })) },
        upsell: {
          standardConfig: c.upsell.standardRules.map((r) => ({ ...r })),
          aiEnabled: c.upsell.aiEnabled,
          oneTick: c.upsell.oneTick ? { ...c.upsell.oneTick } : null,
        },
        rewards: { tiers: c.rewards.tiers.map((t) => ({ ...t })) },
        checkout: {
          enabled: c.checkout.enabled && c.featureFlags.enableCheckout,
          checkoutUrl: c.checkout.checkoutUrl,
        },
        analytics: {
          enabled: c.analytics.enabled && c.featureFlags.enableAnalytics,
        },
      });
      this.syncCart();

      // Collection-aware snapshot: store keyed buckets + productToCollections; set initial list from "default" or legacy recommendations.
      // Fallback: if recommendationsByCollection (or productToCollections) is missing, use rawConfig.recommendations and do not run primary-collection logic.
      const keyed = rawConfig.recommendationsByCollection;
      const productToCollections = rawConfig.productToCollections;
      if (keyed && typeof keyed === 'object' && productToCollections && typeof productToCollections === 'object') {
        const byCollection: Record<string, Array<{ variantId: number; productId?: string; title: string; imageUrl?: string | null; price?: { amount?: number }; handle?: string }>> = {};
        for (const [k, list] of Object.entries(keyed)) {
          if (Array.isArray(list)) {
            byCollection[k] = list.map((r: any) => ({
              variantId: Number(r.variantId),
              productId: r.id != null ? String(r.id) : (r.productId != null ? String(r.productId) : undefined),
              title: r.title ?? '',
              imageUrl: r.imageUrl ?? null,
              price: r.price ?? { amount: 0 },
              handle: r.handle ?? '',
            }));
          }
        }
        const defaultList = byCollection['default'] ?? [];
        this.setState({
          recommendationsByCollection: byCollection,
          productToCollections: { ...productToCollections },
          snapshotRecommendations: defaultList,
          recommendationListVersion: Date.now(),
        });
        preloadRecommendationImages(defaultList);
      } else if (Array.isArray(rawConfig.recommendations)) {
        // Legacy/fallback: no keyed data; set snapshotRecommendations from flat recommendations array.
        const legacyList = rawConfig.recommendations.map((r: any) => ({
          variantId: Number(r.variantId),
          productId: r.id != null ? String(r.id) : (r.productId != null ? String(r.productId) : undefined),
          title: r.title ?? '',
          imageUrl: r.imageUrl ?? null,
          price: r.price ?? { amount: 0 },
          handle: r.handle ?? '',
        }));
        this.setState({
          snapshotRecommendations: legacyList,
          recommendationListVersion: Date.now(),
        });
        preloadRecommendationImages(legacyList);
      }
    } catch (err) {
      const fallback = normalizeConfig({});
      this.config = Object.freeze(fallback) as NormalizedEngineConfig;
      const c = this.config;
      this.setState({
        discount: {
          oneClickOffer: { ...c.discounts.oneClickOffer },
          stacking: { ...c.discounts.stacking },
        },
        freeGifts: { config: c.freeGifts.rules.map((r) => ({ ...r })) },
        upsell: {
          standardConfig: c.upsell.standardRules.map((r) => ({ ...r })),
          aiEnabled: c.upsell.aiEnabled,
          oneTick: c.upsell.oneTick ? { ...c.upsell.oneTick } : null,
        },
        rewards: { tiers: c.rewards.tiers.map((t) => ({ ...t })) },
        checkout: {
          enabled: c.checkout.enabled && c.featureFlags.enableCheckout,
          checkoutUrl: c.checkout.checkoutUrl,
        },
        analytics: {
          enabled: c.analytics.enabled && c.featureFlags.enableAnalytics,
        },
      });
      this.syncCart();
    }
  }

  /**
   * Checkout state machine: only valid transitions allowed. Invalid transitions are ignored.
   */
  transitionCheckoutState(newState: CheckoutStateValue): void {
    const current = getStateFromStore(this.stateStore).checkout.state;
    const allowed = CHECKOUT_TRANSITIONS[current];
    if (!allowed?.has(newState)) return;
    this.setState({ checkout: { state: newState } });
    if (newState === 'COMPLETE') this.emitEvent('checkout:complete', {});
  }

  openCheckout(): void {
    if (this.config && !this.config.featureFlags.enableCheckout) return;
    const state = getStateFromStore(this.stateStore);
    if (!state.checkout.enabled) return;
    this.setState({
      checkout: {
        overlayVisible: true,
        state: 'LOGIN',
      },
    });
    this.emitEvent('checkout:open', {});
  }

  closeCheckout(): void {
    this.setState({
      checkout: {
        overlayVisible: false,
        state: 'IDLE',
      },
    });
  }

  /**
   * Start countdown when drawer opens (if enabled). Call from mount/connector when setting drawerOpen true.
   * Also emits cart:evaluated for analytics when enableAnalytics: one decision per drawer open for admin metrics.
   */
  onDrawerOpened(): void {
    const state = getStateFromStore(this.stateStore);
    if (this.config?.featureFlags?.enableAnalytics) {
      const hasCrossSell =
        (state.snapshotRecommendations?.length ?? 0) > 0 ||
        (state.upsell?.aiRecommendations?.length ?? 0) > 0;
      const cartValue = Math.round(Number(state.cart?.subtotal ?? 0));
      this.emitEvent('cart:evaluated', { hasCrossSell, cartValue });
      // Emit impression per shown recommendation so admin engagement metrics (impressions, CTR) update.
      if (hasCrossSell) {
        const ids = [
          ...(state.snapshotRecommendations ?? []).map((r) => String(r.variantId)),
          ...(state.upsell?.aiRecommendations ?? []).map((r) => String(r.variantId)),
        ];
        const productIds = [...new Set(ids)];
        if (productIds.length > 0) {
          this.emitEvent('recommendation:impression', { productIds });
        }
      }
    }
    if (!this.config.appearance.countdownEnabled) return;
    const duration = this.config.appearance.countdownDurationMs ?? DEFAULT_COUNTDOWN_MS;
    if (duration <= 0) return;
    const raw = state.cart.raw;
    this.lastCountdownSignature = raw ? this.getCartSignature(raw) : null;
    this.countdown.start(duration);
  }

  /**
   * PostMessage handler for checkout iframe. Updates checkout state via transitionCheckoutState.
   * Expects messages: { type: string, ...payload }. Origin validated for production safety.
   */
  private setupCheckoutPostMessage(): void {
    if (typeof window === 'undefined') return;
    const handleMessage = (event: MessageEvent): void => {
      if (this.destroyed) return;
      const data = event?.data;
      if (!data || typeof data !== 'object' || typeof data.type !== 'string') return;
      const state = getStateFromStore(this.stateStore);
      if (!state.checkout.enabled) return;
      // Origin validation: allow same-origin or checkout iframe origin only.
      try {
        const origin = typeof event.origin === 'string' ? event.origin : '';
        if (origin !== '' && origin !== window.location.origin) {
          const checkoutUrl = state.checkout.checkoutUrl;
          if (!checkoutUrl || new URL(checkoutUrl).origin !== origin) return;
        }
      } catch {
        return;
      }

      switch (data.type) {
        case 'jwt-token': {
          const token = data.token != null ? String(data.token) : null;
          this.setState({ checkout: { jwtToken: token } });
          break;
        }
        case 'send-otp-response': {
          if (data.success) this.transitionCheckoutState('OTP');
          this.setState({ checkout: { loading: false } });
          break;
        }
        case 'validate-otp-response': {
          if (data.success) this.transitionCheckoutState('ADDRESS');
          else this.transitionCheckoutState('LOGIN');
          this.setState({ checkout: { loading: false } });
          break;
        }
        case 'get-address-response': {
          const list = Array.isArray(data.addresses) ? data.addresses : [];
          this.setState({ checkout: { addressList: list, loading: false } });
          break;
        }
        case 'update-checkout-response': {
          this.setState({ checkout: { loading: false } });
          if (data.state) this.transitionCheckoutState(data.state as CheckoutStateValue);
          break;
        }
        default:
          break;
      }
    };
    this.checkoutMessageHandler = handleMessage;
    window.addEventListener('message', handleMessage);
  }

  emit(eventName: string, payload?: unknown): void {
    this.eventBus.emit(eventName, payload);
  }

  on(eventName: string, handler: (payload?: unknown) => void): void {
    this.eventBus.on(eventName, handler);
  }

  off(eventName: string, handler: (payload?: unknown) => void): void {
    this.eventBus.off(eventName, handler);
  }

  /**
   * Emit an analytics event (queued, batched, deduped). Does not block cart logic.
   */
  emitEvent(name: string, payload: object): void {
    if (this.config && !this.config.featureFlags.enableAnalytics) return;
    const state = getStateFromStore(this.stateStore);
    if (!state.analytics.enabled) return;
    const key = getDedupKey(name, payload);
    const now = Date.now();
    const lastAt = this.analyticsDedupMap.get(key);
    if (lastAt != null && now - lastAt < DEDUP_WINDOW_MS) return;
    this.analyticsDedupMap.set(key, now);
    const toPrune: string[] = [];
    for (const [k, t] of this.analyticsDedupMap.entries()) {
      if (now - t > DEDUP_WINDOW_MS) toPrune.push(k);
    }
    for (const k of toPrune) this.analyticsDedupMap.delete(k);
    const event = buildAnalyticsEvent(
      name,
      payload,
      { itemCount: state.cart.itemCount, subtotal: state.cart.subtotal },
      state.analytics.sessionId
    );
    this.updateState((s) => ({
      analytics: { ...s.analytics, queue: [...s.analytics.queue, event] },
    }));
    this.scheduleAnalyticsFlush();
  }

  private scheduleAnalyticsFlush(): void {
    const state = getStateFromStore(this.stateStore);
    if (state.analytics.sending || !state.analytics.enabled || state.analytics.queue.length === 0) {
      return;
    }
    const now = Date.now();
    const hasClickEvent = state.analytics.queue.some((ev) => ev.name === 'recommendation:click');
    const shouldFlushByCount = state.analytics.queue.length >= 5;
    const shouldFlushByTime =
      state.analytics.lastFlushAt != null && now - state.analytics.lastFlushAt >= FLUSH_INTERVAL_MS;
    if (this.analyticsFlushTimer) clearTimeout(this.analyticsFlushTimer);
    if (shouldFlushByCount || shouldFlushByTime || hasClickEvent) {
      this.analyticsFlushTimer = setTimeout(() => {
        this.analyticsFlushTimer = null;
        this.flushAnalyticsEvents();
      }, 0);
    } else {
      const nextFlushIn = state.analytics.lastFlushAt != null
        ? Math.max(0, FLUSH_INTERVAL_MS - (now - state.analytics.lastFlushAt))
        : FLUSH_INTERVAL_MS;
      this.analyticsFlushTimer = setTimeout(() => {
        this.analyticsFlushTimer = null;
        this.scheduleAnalyticsFlush();
      }, nextFlushIn);
    }
  }

  private flushAnalyticsEvents(): void {
    const state = getStateFromStore(this.stateStore);
    if (!state.analytics.enabled || state.analytics.sending || state.analytics.queue.length === 0) {
      return;
    }
    const batch = state.analytics.queue.slice(0, BATCH_SIZE);
    this.setState({
      analytics: {
        ...state.analytics,
        sending: true,
        queue: state.analytics.queue.slice(batch.length),
      },
    });
    const hadClicks = batch.some((ev) => ev.name === 'recommendation:click');
    sendAnalyticsBatch(batch).then((ok) => {
      if (this.destroyed) return;
      const s = getStateFromStore(this.stateStore);
      if (ok) {
        this.analyticsRetryCount = 0;
        this.setState({
          analytics: {
            ...s.analytics,
            sending: false,
            lastFlushAt: Date.now(),
          },
        });
        if (s.analytics.queue.length >= 5) this.scheduleAnalyticsFlush();
      } else {
        this.setState({
          analytics: {
            ...s.analytics,
            sending: false,
            queue: [...batch, ...s.analytics.queue],
          },
        });
        const delay = Math.min(1000 * Math.pow(2, this.analyticsRetryCount), 30000);
        this.analyticsRetryCount += 1;
        this.analyticsFlushTimer = setTimeout(() => {
          this.analyticsFlushTimer = null;
          this.flushAnalyticsEvents();
        }, delay);
      }
    });
  }

  enqueueEffect(asyncFn: () => Promise<void>): void {
    this.effectQueue.enqueue(asyncFn);
  }

  getState(): EngineState {
    return getStateFromStore(this.stateStore);
  }

  setState(partial: PartialEngineState): void {
    if (this.destroyed) return;
    setStateOnStore(this.stateStore, partial);
  }

  updateState(updaterFn: (state: EngineState) => PartialEngineState): void {
    if (this.destroyed) return;
    updateStateOnStore(this.stateStore, updaterFn);
  }

  /**
   * After every sync: if Shopify removed a code (not in cart_level_discount_applications / discount_codes),
   * remove it from engine.discount.applied. Prevents engine/cart drift.
   */
  reconcileCartDiscountState(cartRaw: any): void {
    const codesOnCart = getCodesFromCartRaw(cartRaw);
    this.updateState((s) => {
      const applied = s.discount.applied.filter((d) =>
        codesOnCart.includes(d.code.toLowerCase())
      );
      if (applied.length === s.discount.applied.length) return {};
      return {
        discount: { ...s.discount, applied },
      };
    });
  }

  /**
   * Debounced revalidation (800ms). Called after cart sync. Revalidates all applied discounts,
   * removes codes that are no longer valid. Does not create loops (single run, then sync with fromReapply).
   */
  triggerRevalidation(): void {
    if (this.revalidationTimer) clearTimeout(this.revalidationTimer);
    this.revalidationTimer = setTimeout(() => {
      this.revalidationTimer = null;
      this.enqueueEffect(() => this.runRevalidation());
    }, REVALIDATION_DEBOUNCE_MS);
  }

  /**
   * Internal: validate each applied code; remove from state and cart if invalid. Then sync once.
   * Contract: only removes invalid codes; never calls applyDiscount or re-adds discounts.
   */
  async runRevalidation(): Promise<void> {
    const state = getStateFromStore(this.stateStore);
    const applied = state.discount.applied;
    if (applied.length === 0) return;

    const cartRaw = state.cart.raw;
    const toRemove: string[] = [];
    for (const d of applied) {
      const result = await validateDiscount(d.code, cartRaw);
      if (!result.valid) toRemove.push(d.code);
    }
    if (toRemove.length === 0) return;

    for (const code of toRemove) {
      this.updateState((s) => ({
        discount: {
          ...s.discount,
          applied: s.discount.applied.filter((x) => x.code.toLowerCase() !== code.toLowerCase()),
          lastError: null,
        },
      }));
      await removeDiscountFromCart(code);
    }
    await this.syncCart({ fromReapply: true, fromRevalidation: true });
  }

  /**
   * Set one-click offer config. If autoApply is true, applies the offer (exact code, or min/max logic).
   */
  setOneClickOffer(offerConfig: Partial<OneClickOfferState>): void {
    this.updateState((s) => ({
      discount: {
        ...s.discount,
        oneClickOffer: { ...s.discount.oneClickOffer, ...offerConfig },
      },
    }));
    const state = getStateFromStore(this.stateStore);
    const offer = state.discount.oneClickOffer;
    if (!offer.active || !offer.autoApply) return;
    if (this.config && !this.config.featureFlags.enableDiscounts) return;

    this.enqueueEffect(async () => this.runOneClickApply());
  }

  /**
   * Internal: run one-click apply (exact / min / max). Called when autoApply is true.
   */
  async runOneClickApply(): Promise<void> {
    if (this.config && !this.config.featureFlags.enableDiscounts) return;
    const state = getStateFromStore(this.stateStore);
    const offer = state.discount.oneClickOffer;
    const cartRaw = state.cart.raw;

    if (offer.type === 'exact' && offer.code) {
      this.applyDiscount(offer.code);
      return;
    }

    if (offer.type === 'min' && Array.isArray(offer.candidateCodes) && offer.candidateCodes.length > 0) {
      // Sequential validation; no state mutation until we call applyDiscount(best.code) once.
      let best: { code: string; amount: number; type: 'percentage' | 'fixed' } | null = null;
      for (const code of offer.candidateCodes) {
        const c = (code || '').trim();
        if (!c) continue;
        const result = await validateDiscount(c, cartRaw);
        if (result.valid && (best == null || result.amount > best.amount)) {
          best = { code: result.code, amount: result.amount, type: result.type };
        }
      }
      if (best) this.applyDiscount(best.code);
      return;
    }

    if (offer.type === 'max' && offer.code != null && typeof offer.maxSavingsCents === 'number') {
      const result = await validateDiscount(offer.code.trim(), cartRaw);
      if (result.valid && result.amount <= offer.maxSavingsCents) {
        this.applyDiscount(offer.code);
      }
    }
  }

  /** Key prefix for optimistic placeholder lines (add-to-cart). Change/remove of these is local-only. */
  private static readonly OPTIMISTIC_KEY_PREFIX = 'opt-';

  /** Compute itemCount, subtotal, total from cart.js-style raw object. */
  private static cartMetricsFromRaw(raw: any): { itemCount: number; subtotal: number; total: number } {
    const itemCount = raw?.item_count ?? (Array.isArray(raw?.items) ? raw.items.length : 0);
    const subtotal =
      raw?.items_subtotal_price ??
      (Array.isArray(raw?.items)
        ? raw.items.reduce((sum: number, item: any) => sum + ((item.line_price ?? (item.price ?? 0) * (item.quantity ?? 0)) || 0), 0)
        : 0);
    const total = raw?.total_price ?? subtotal;
    return { itemCount, subtotal, total };
  }

  /**
   * Apply only cart slice from raw (no reconcile/shipping/rewards). For optimistic UI only.
   */
  private applyOptimisticCart(raw: any): void {
    if (this.destroyed) return;
    const { itemCount, subtotal, total } = Engine.cartMetricsFromRaw(raw);
    const prev = getStateFromStore(this.stateStore).cart;
    this.setState({
      cart: {
        raw,
        itemCount,
        subtotal,
        total,
        syncing: false,
        lastSyncedAt: prev.lastSyncedAt,
      },
    });
  }

  /**
   * Silent cart apply for changeCart confirmations: updates cart.raw + shipping + rewards
   * without triggering recommendations, decision calls, or revalidation. Prevents flash
   * when server response simply confirms the optimistic update.
   */
  private applyCartRawSilent(raw: any): void {
    if (this.destroyed) return;
    const { itemCount, subtotal, total } = Engine.cartMetricsFromRaw(raw);
    const itemsSubtotalFromRaw = raw.items_subtotal_price ?? subtotal;

    const partial: any = {
      cart: { raw, itemCount, subtotal, total, syncing: false, lastSyncedAt: Date.now() },
    };

    // Shipping
    const threshold = this.config?.freeShipping?.thresholdCents ?? null;
    if (threshold != null) {
      const remaining = threshold - itemsSubtotalFromRaw;
      partial.shipping = { remaining: Math.max(remaining, 0), unlocked: remaining <= 0, loading: false };
    } else {
      partial.shipping = { remaining: null, unlocked: false, loading: false };
    }

    // Rewards
    const state = getStateFromStore(this.stateStore);
    const { rewards } = state;
    const runRewards = !this.config || this.config.featureFlags.enableRewards;
    if (runRewards) {
      const newUnlockedIndex = computeUnlockedTier(subtotal, rewards.tiers);
      const lastUnlocked = rewards.lastUnlockedTierIndex;
      const isNewTierUnlock = newUnlockedIndex !== null && (lastUnlocked === null || newUnlockedIndex > lastUnlocked);
      partial.rewards = {
        ...rewards,
        unlockedTierIndex: newUnlockedIndex,
        lastUnlockedTierIndex: isNewTierUnlock ? newUnlockedIndex : rewards.lastUnlockedTierIndex,
        showConfetti: isNewTierUnlock,
      };
      if (isNewTierUnlock && newUnlockedIndex !== null) {
        const tier = rewards.tiers[newUnlockedIndex];
        if (tier?.rewardType === 'discount' && tier.discountCode) {
          this.applyDiscount(tier.discountCode);
        }
      }
    }

    // Discount reconciliation
    const codesOnCart = getCodesFromCartRaw(raw);
    const applied = state.discount.applied.filter((d: any) => codesOnCart.includes(d.code.toLowerCase()));
    if (applied.length !== state.discount.applied.length) {
      partial.discount = { ...state.discount, applied };
    }

    this.setState(partial);
  }

  /**
   * Schedule a single debounced decision call; when it returns, set snapshotRecommendations once.
   * Phase 3: reused after addToCart (silent apply) so list can update once after user stops adding.
   */
  private scheduleDecisionUpdate(raw: any): void {
    if (this.destroyed || (raw?.items?.length ?? 0) === 0) return;
    if (this.decisionDebounceTimer) {
      clearTimeout(this.decisionDebounceTimer);
      this.decisionDebounceTimer = null;
    }
    this.decisionDebounceTimer = setTimeout(() => {
      this.decisionDebounceTimer = null;
      if (this.destroyed) return;
      const cs = getStateFromStore(this.stateStore);
      const currentRaw = cs.cart.raw;
      if ((currentRaw?.items?.length ?? 0) === 0) return;
      const sig = this.getCartSignature(currentRaw);
      fetchDecisionCrossSell(currentRaw).then((result) => {
        if (this.destroyed || !result.ok) return;
        const cur = getStateFromStore(this.stateStore).cart.raw;
        if (!cur || this.getCartSignature(cur) !== sig) return;
        if (result.items.length > 0) {
          const curState = getStateFromStore(this.stateStore);
          const prev = curState.snapshotRecommendations ?? [];
          const nextIds = new Set(result.items.map((r: any) => r.variantId));
          const prevIds = new Set(prev.map((r: any) => r.variantId));
          const setsEqual = nextIds.size === prevIds.size && [...nextIds].every((id) => prevIds.has(id));
          if (!setsEqual) {
            this.setState({ snapshotRecommendations: result.items, recommendationListVersion: Date.now(), recommendationsDecisionPending: false });
            preloadRecommendationImages(result.items);
          } else {
            this.setState({ recommendationsDecisionPending: false });
          }
        } else {
          this.setState({ recommendationsDecisionPending: false });
        }
      }).catch(() => {
        if (!this.destroyed) this.setState({ recommendationsDecisionPending: false });
      });
    }, DECISION_DEBOUNCE_MS);
  }

  /**
   * Lightweight batched cart apply for mutation happy paths (changeCart, removeItem).
   * Applies cart + shipping + rewards in ONE setState to avoid multi-render flash,
   * then defers heavier work (recommendations, upsell, decision) to a microtask.
   * @param markInitialSyncDone - when true, set initialSyncDone in the same batch (single re-render on first load)
   */
  private applyCartRawBatched(raw: any, markInitialSyncDone?: boolean, options?: { fromRevalidation?: boolean }): void {
    if (this.destroyed) return;
    const { itemCount, subtotal, total } = Engine.cartMetricsFromRaw(raw);
    const itemsSubtotalFromRaw = raw.items_subtotal_price ?? subtotal;

    // Build a single partial state update: cart + shipping + rewards
    const partial: any = {
      cart: {
        raw,
        itemCount,
        subtotal,
        total,
        syncing: false,
        lastSyncedAt: Date.now(),
      },
    };

    // Shipping
    const threshold = this.config?.freeShipping?.thresholdCents ?? null;
    if (threshold != null) {
      const remaining = threshold - itemsSubtotalFromRaw;
      partial.shipping = { remaining: Math.max(remaining, 0), unlocked: remaining <= 0, loading: false };
    } else {
      partial.shipping = { remaining: null, unlocked: false, loading: false };
    }

    // Rewards
    const state = getStateFromStore(this.stateStore);
    const { rewards } = state;
    const runRewards = !this.config || this.config.featureFlags.enableRewards;
    if (runRewards) {
      const newUnlockedIndex = computeUnlockedTier(subtotal, rewards.tiers);
      const lastUnlocked = rewards.lastUnlockedTierIndex;
      const isNewTierUnlock = newUnlockedIndex !== null && (lastUnlocked === null || newUnlockedIndex > lastUnlocked);
      partial.rewards = {
        ...rewards,
        unlockedTierIndex: newUnlockedIndex,
        lastUnlockedTierIndex: isNewTierUnlock ? newUnlockedIndex : rewards.lastUnlockedTierIndex,
        showConfetti: isNewTierUnlock,
      };
      if (isNewTierUnlock && newUnlockedIndex !== null) {
        const tier = rewards.tiers[newUnlockedIndex];
        if (tier?.rewardType === 'discount' && tier.discountCode) {
          this.applyDiscount(tier.discountCode);
        }
      }
    }

    // Discount reconciliation (inline to avoid extra setState)
    const codesOnCart = getCodesFromCartRaw(raw);
    const applied = state.discount.applied.filter((d: any) => codesOnCart.includes(d.code.toLowerCase()));
    if (applied.length !== state.discount.applied.length) {
      partial.discount = { ...state.discount, applied };
    }

    if (markInitialSyncDone) {
      partial.initialSyncDone = true;
    }

    // Phase 10: empty cart — include bucket-derived recs in this batch so one render instead of two
    const hasItems = (raw?.items?.length ?? 0) > 0;
    if (!hasItems) {
      const byCollection = state.recommendationsByCollection;
      const productToCollections = state.productToCollections;
      if (byCollection && Object.keys(byCollection).length > 0 && productToCollections && Object.keys(productToCollections).length > 0) {
        const primaryKey = getPrimaryCollectionKey(raw, byCollection, productToCollections);
        const bucket = Array.isArray(byCollection[primaryKey]) ? byCollection[primaryKey] : byCollection['default'];
        let list = Array.isArray(bucket) ? bucket : [];
        if (list.length === 0) {
          list = byCollection['default'] ?? state.snapshotRecommendations ?? [];
        }
        if (list.length > 0) {
          const prevIds = (state.snapshotRecommendations ?? []).map((r: any) => r.variantId).join(',');
          const nextIds = list.map((r: any) => r.variantId).join(',');
          if (prevIds !== nextIds) {
            partial.snapshotRecommendations = list;
            partial.recommendationListVersion = Date.now();
          }
        }
      }
    }

    // Single setState — one Svelte re-render
    this.setState(partial);
    this.emit('cart:updated', { raw });

    // Defer heavier work (recommendations, upsell, decision, countdown) to next microtask
    Promise.resolve().then(() => {
      if (this.destroyed) return;

      // Phase 5: skip recommendation update when this apply came from revalidation (discount removal only)
      if (!options?.fromRevalidation) {
        // Phase 2 (Option A): only set from bucket when cart is empty; when cart has items, decision callback is the single update
        // Phase 10: empty-cart recs already set in partial above; skip duplicate setState here
        const hasItemsForRecs = (raw?.items?.length ?? 0) > 0;
        if (!hasItemsForRecs) {
          // Already applied in main batch for single render; only preload if we have list
          const s = getStateFromStore(this.stateStore);
          if ((s.snapshotRecommendations ?? []).length > 0) {
            preloadRecommendationImages(s.snapshotRecommendations!);
          }
        } else {
          // Phase 8: when cart has items, if current list is still the default bucket show skeleton until decision returns
          const s = getStateFromStore(this.stateStore);
          const byCollection = s.recommendationsByCollection;
          const defaultBucket = (byCollection && byCollection['default']) ? byCollection['default'] : [];
          const defaultIds = (defaultBucket as any[]).map((r: any) => r.variantId).sort().join(',');
          const snapIds = (s.snapshotRecommendations ?? []).map((r: any) => r.variantId).sort().join(',');
          if (defaultIds && defaultIds === snapIds) {
            this.setState({ recommendationsDecisionPending: true });
          }
        }

        this.scheduleDecisionUpdate(raw);
      }

      // Countdown
      const countdownEnabled = this.config?.appearance?.countdownEnabled === true;
      if (!countdownEnabled) { this.countdown.stop(); }
      else {
        const sig = this.getCartSignature(raw);
        if (!this.countdown.isRunning() || sig !== this.lastCountdownSignature) {
          this.countdown.start(this.config.appearance.countdownDurationMs ?? DEFAULT_COUNTDOWN_MS);
          this.lastCountdownSignature = sig;
        }
      }

      this.triggerRevalidation();
    });
  }

  /**
   * Sync cart from Shopify. Fetches cart then applies via applyCartRawBatched.
   * When fromReapply is true, does not enqueue reapplyDiscounts to avoid loop.
   * V1-style guards to prevent snap-back / stuck:
   * - Skip entirely when within MUTATION_GRACE_MS of our own add/change/remove (don't start fetch).
   * - After fetch returns, skip apply if we're now in grace (fetch was in flight when user mutated; don't overwrite with stale result).
   */
  async syncCart(options?: { fromReapply?: boolean; fromRevalidation?: boolean }): Promise<void> {
    if (this.destroyed) return;
    if (this.internalMutationInProgress) return;
    if (Date.now() - this.lastMutationAppliedAt < Engine.MUTATION_GRACE_MS) return;
    const state = getStateFromStore(this.stateStore);
    if (state.cart.syncing) return;
    const syncStart = typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
    this.setState({
      cart: { syncing: true },
    });
    try {
      const raw = await apiFetchCart();
      if (Date.now() - this.lastMutationAppliedAt < Engine.MUTATION_GRACE_MS) {
        return;
      }
      this.perf.cartSyncDuration =
        typeof performance !== 'undefined' && performance.now
          ? performance.now() - syncStart
          : 0;
      const st = getStateFromStore(this.stateStore);
      this.applyCartRawBatched(raw, !st.initialSyncDone, options);
      this.ensureCartHasRevproSessionId(raw);
    } catch (err) {
      throw err;
    } finally {
      this.setState({ cart: { syncing: false } });
    }
  }

  /**
   * Set cart attribute revpro_session_id once per session so orders carry it in note_attributes (Order Impact).
   * Non-blocking; runs after syncCart applies cart.
   */
  private ensureCartHasRevproSessionId(raw: any): void {
    if (this.revproSessionIdSet || this.destroyed) return;
    const attrs = raw?.attributes ?? raw?.attributes_typed;
    if (attrs && typeof attrs === 'object' && attrs['revpro_session_id']) {
      this.revproSessionIdSet = true;
      return;
    }
    const id = getOrCreateRevproSessionId();
    if (!id) return;
    this.revproSessionIdSet = true;
    updateCartAttributes({ revpro_session_id: id }).catch(() => {
      this.revproSessionIdSet = false;
    });
  }

  /**
   * Apply a discount code. Runs in effect queue. Respects stacking: if allowStacking is false,
   * removes all existing codes before applying. Duplicate code is skipped.
   */
  applyDiscount(code: string): void {
    this.enqueueEffect(async () => {
      if (this.config && !this.config.featureFlags.enableDiscounts) return;
      const trimmed = (code || '').trim();
      if (!trimmed) return;

      const state = getStateFromStore(this.stateStore);
      const { stacking, applied } = state.discount;

      if (applied.some((d) => d.code.toLowerCase() === trimmed.toLowerCase())) {
        this.setState({ discount: { lastError: null } });
        return;
      }

      // Stacking OFF: remove all existing (await each), clear state, sync — then apply new below.
      // Order guaranteed: this whole block is one serialized effect; removeDiscountFromCart does not enqueue.
      if (!stacking.allowStacking && applied.length > 0) {
        for (const d of applied) {
          await removeDiscountFromCart(d.code);
        }
        this.updateState((s) => ({
          discount: { ...s.discount, applied: [], lastError: null },
        }));
        await this.syncCart({ fromReapply: true });
      }

      const stateForValidate = getStateFromStore(this.stateStore);
      this.setState({
        discount: { validating: true, lastError: null },
      });
      try {
        const cartRaw = stateForValidate.cart.raw;
        const validateStart =
          typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
        const result = await validateDiscount(trimmed, cartRaw);
        this.perf.discountValidationDuration =
          typeof performance !== 'undefined' && performance.now
            ? performance.now() - validateStart
            : 0;
        if (result.valid) {
          const entry: AppliedDiscount = {
            code: result.code,
            amount: result.amount,
            type: result.type,
          };
          this.updateState((s) => ({
            discount: {
              ...s.discount,
              applied: [...s.discount.applied, entry],
              lastError: null,
            },
          }));
          await this.syncCart();
          this.emitEvent('discount:apply', { code: result.code });
        } else {
          this.setState({
            discount: { lastError: 'Invalid or expired code' },
          });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Discount failed';
        this.setState({
          discount: { lastError: message },
        });
      } finally {
        this.setState({ discount: { validating: false } });
      }
    });
  }

  /**
   * Remove a discount code. Runs in effect queue; removes from state and syncs cart.
   */
  removeDiscount(code: string): void {
    this.enqueueEffect(async () => {
      if (this.config && !this.config.featureFlags.enableDiscounts) return;
      const trimmed = (code || '').trim();
      if (!trimmed) return;

      this.updateState((s) => {
        const applied = s.discount.applied.filter(
          (d) => d.code.toLowerCase() !== trimmed.toLowerCase()
        );
        return {
          discount: {
            ...s.discount,
            applied,
            lastError: null,
          },
        };
      });
      await removeDiscountFromCart(trimmed);
      await this.syncCart();
      this.emitEvent('discount:remove', { code: trimmed });
    });
  }

  /**
   * Sync free gifts to match config and cart subtotal. Runs in effect queue only.
   * Uses direct cartApi (not engine.addToCart) to avoid re-enqueueing. Sets internalMutationInProgress
   * during mutations; ends with syncCart({ fromReapply: true }) to avoid discount storm and re-trigger.
   */
  async syncFreeGifts(): Promise<void> {
    if (this.config && !this.config.featureFlags.enableFreeGifts) return;
    const state = getStateFromStore(this.stateStore);
    const { config } = state.freeGifts;

    // Merge milestone gift rules (variantId + thresholdCents) into the free gift pipeline
    const milestoneGiftRules = (state.rewards.tiers ?? [])
      .filter((t) => t.rewardType === 'gift' && t.variantId)
      .map((t) => ({
        variantId: Number(t.variantId),
        minSubtotalCents: t.thresholdCents,
        maxQuantity: 1,
      }));
    const combinedConfig = [...config, ...milestoneGiftRules];

    if (combinedConfig.length === 0) return;

    const freeGiftStart =
      typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
    this.setState({ freeGifts: { syncing: true } });
    try {
      const cartRaw = state.cart.raw;
      const expectedMap = computeExpectedGifts(cartRaw, combinedConfig);
      const giftVariantIds =
        this.config?.freeGifts.giftVariantIds ?? getGiftVariantIds(combinedConfig);
      const { toAdd, toRemove } = diffGifts(cartRaw, expectedMap, giftVariantIds);

      if (toAdd.length === 0 && toRemove.length === 0) {
        this.perf.freeGiftSyncDuration =
          typeof performance !== 'undefined' && performance.now
            ? performance.now() - freeGiftStart
            : 0;
        this.setState({
          freeGifts: { syncing: false, lastSyncAt: Date.now() },
        });
        return;
      }

      this.internalMutationInProgress = true;
      try {
        for (const { lineKey } of toRemove) {
          await apiChangeCart(lineKey, 0);
        }
        for (const { variantId, quantity } of toAdd) {
          if (quantity > 0) await apiAddToCart(variantId, quantity);
        }
      } finally {
        this.internalMutationInProgress = false;
      }

      await this.syncCart({ fromReapply: true });
      for (const { lineKey } of toRemove) {
        this.emitEvent('freegift:remove', { lineKey });
      }
      for (const { variantId, quantity } of toAdd) {
        if (quantity > 0) this.emitEvent('freegift:add', { variantId, quantity });
      }
    } finally {
      this.perf.freeGiftSyncDuration =
        typeof performance !== 'undefined' && performance.now
          ? performance.now() - freeGiftStart
          : 0;
      this.setState({
        freeGifts: {
          syncing: false,
          lastSyncAt: Date.now(),
        },
      });
    }
  }

  /**
   * Reapply all stored discount codes (e.g. after cart change). Idempotent; runs in effect queue.
   * PRESSURE POINT: Revalidate + syncCart(fromReapply) can be redundant if backend already
   * applies during validation. Optimize when stacking + auto-apply + freebies land.
   */
  async reapplyDiscounts(): Promise<void> {
    if (this.config && !this.config.featureFlags.enableDiscounts) return;
    const state = getStateFromStore(this.stateStore);
    const applied = state.discount.applied;
    if (applied.length === 0) return;

    const cartRaw = state.cart.raw;
    for (const d of applied) {
      await validateDiscount(d.code, cartRaw);
    }
    await this.syncCart({ fromReapply: true });
  }

  /**
   * Set upsell config (standardConfig, aiEnabled, oneTick). Does not enqueue effects.
   */
  setUpsellConfig(partial: {
    standardConfig?: Array<{ variantId: number; conditionSubtotalCents: number }>;
    aiEnabled?: boolean;
    oneTick?: { variantId: number } | null;
  }): void {
    this.updateState((s) => ({
      upsell: { ...s.upsell, ...partial },
    }));
  }

  async addToCart(variantId: number, quantity: number): Promise<void> {
    this.internalMutationInProgress = true;
    this.lastMutationAppliedAt = Date.now();
    const cartSnapshot = { ...getStateFromStore(this.stateStore).cart };
    const current = cartSnapshot.raw;
    const placeholderKey = `${Engine.OPTIMISTIC_KEY_PREFIX}${variantId}-${Date.now()}`;
    const placeholderLine: any = {
      key: placeholderKey,
      variant_id: variantId,
      quantity,
      title: 'Adding…',
      product_title: 'Adding…',
      line_price: 0,
      price: 0,
    };
    const optimisticItems = [...(current?.items ?? []), placeholderLine];
    const optimisticRaw = {
      ...(current ?? {}),
      items: optimisticItems,
      item_count: optimisticItems.length,
      items_subtotal_price: current?.items_subtotal_price ?? 0,
      total_price: current?.total_price ?? 0,
    };
    this.applyOptimisticCart(optimisticRaw);
    try {
      const response = await apiAddToCart(variantId, quantity);
      const addedItems = response?.items != null ? (Array.isArray(response.items) ? response.items : [response.items]) : [];
      if (addedItems.length > 0) {
        const stateRaw = getStateFromStore(this.stateStore).cart.raw;
        const withoutPlaceholder = (stateRaw?.items ?? []).filter((i: any) => !String(i?.key ?? '').startsWith(Engine.OPTIMISTIC_KEY_PREFIX));
        const items = [...withoutPlaceholder, ...addedItems];
        const itemsSubtotal = items.reduce(
          (sum: number, item: any) => sum + (Number(item.line_price) || Number(item.price) * Number(item.quantity) || 0),
          0
        );
        const prevTotal = stateRaw?.total_price != null ? Number(stateRaw.total_price) : 0;
        const newLinesTotal = addedItems.reduce((s: number, i: any) => s + (Number(i.line_price) ?? 0), 0);
        const mergedRaw = {
          ...(stateRaw ?? {}),
          items,
          item_count: items.length,
          items_subtotal_price: itemsSubtotal,
          total_price: prevTotal + newLinesTotal,
        };
        this.lastMutationAppliedAt = Date.now();
        // Phase 3: minimal apply (cart + shipping + rewards), no rec list update; one debounced decision update later
        this.applyCartRawSilent(mergedRaw);
        this.scheduleDecisionUpdate(mergedRaw);
      } else {
        await this.syncCart();
      }
      this.emitEvent('cart:add', { variantId, quantity });
      const s = getStateFromStore(this.stateStore);
      const isUpsell =
        s.upsell.standard.some((r) => r.variantId === variantId) ||
        s.upsell.aiRecommendations.some((r) => r.variantId === variantId) ||
        (s.snapshotRecommendations?.some((r) => r.variantId === variantId) ?? false);
      if (isUpsell) {
        this.emitEvent('upsell:add', { variantId, quantity });
        // Always emit recommendation:click for CTR (server records one CrossSellEvent click per add).
        const item = s.snapshotRecommendations?.find((r) => r.variantId === variantId) ?? s.upsell?.aiRecommendations?.find((r) => r.variantId === variantId);
        const productId = (item as { productId?: string } | undefined)?.productId ?? String(variantId);
        const fromSnapshot = (s.snapshotRecommendations ?? []).map((r) => r.productId ?? String(r.variantId));
        const fromAi = (s.upsell?.aiRecommendations ?? []).map((r) => (r as { productId?: string; variantId: number }).productId ?? String(r.variantId));
        const recommendedProductIds = [...new Set([...fromSnapshot, ...fromAi])].filter((id) => typeof id === 'string' && id.length > 0);
        this.emitEvent('recommendation:click', {
          productId,
          recommendedProductIds: recommendedProductIds.length > 0 ? recommendedProductIds : [productId],
        });
      }
    } catch (err) {
      this.setState({ cart: cartSnapshot });
      throw err;
    } finally {
      this.lastMutationAppliedAt = Date.now();
      this.internalMutationInProgress = false;
    }
  }

  async changeCart(lineKey: string, quantity: number): Promise<void> {
    if (String(lineKey).startsWith(Engine.OPTIMISTIC_KEY_PREFIX)) {
      const raw = getStateFromStore(this.stateStore).cart.raw;
      if (!raw?.items) return;
      if (quantity <= 0) {
        const items = raw.items.filter((i: any) => (i?.key ?? '') !== lineKey);
        const itemsSubtotal = items.reduce((s: number, i: any) => s + (Number(i.line_price) ?? 0), 0);
        this.applyOptimisticCart({ ...raw, items, item_count: items.length, items_subtotal_price: itemsSubtotal, total_price: raw.total_price ?? itemsSubtotal });
      } else {
        const optimisticItems = raw.items.map((i: any) => {
          if ((i?.key ?? '') !== lineKey) return i;
          const p = Number(i.price) || 0;
          const lineTotal = p * quantity;
          return { ...i, quantity, line_price: lineTotal, final_line_price: lineTotal };
        });
        const itemsSubtotal = optimisticItems.reduce((s: number, i: any) => s + (Number(i.line_price) ?? 0), 0);
        this.applyOptimisticCart({ ...raw, items: optimisticItems, item_count: optimisticItems.length, items_subtotal_price: itemsSubtotal, total_price: raw.total_price ?? itemsSubtotal });
      }
      return;
    }
    // Per-line in-flight: merge rapid clicks by updating expected qty + optimistic UI; don't start a second request
    if (this.changeCartInFlightByLine.has(lineKey)) {
      this.expectedQtyByLine.set(lineKey, quantity);
      // Apply optimistic update immediately so UI reflects the new qty and amounts (line total, subtotal)
      const currentRaw = getStateFromStore(this.stateStore).cart.raw;
      if (currentRaw?.items) {
        const optimisticItems = currentRaw.items.map((i: any) => {
          if ((i?.key ?? '') !== lineKey) return i;
          const p = Number(i.price) || 0;
          const lineTotal = p * quantity;
          return { ...i, quantity, line_price: lineTotal, final_line_price: lineTotal };
        });
        const itemsSubtotal = optimisticItems.reduce((s: number, i: any) => s + (Number(i.line_price) ?? 0), 0);
        this.applyOptimisticCart({ ...currentRaw, items: optimisticItems, item_count: optimisticItems.length, items_subtotal_price: itemsSubtotal, total_price: currentRaw.total_price ?? itemsSubtotal });
      }
      return;
    }
    this.changeCartInFlightByLine.add(lineKey);
    this.syncChangeInFlightLineKeysToState();
    this.expectedQtyByLine.set(lineKey, quantity);
    this.expectedRemovedLineKeys.delete(lineKey);
    this.internalMutationInProgress = true;
    this.lastMutationAppliedAt = Date.now();
    const cartSnapshot = { ...getStateFromStore(this.stateStore).cart };
    const current = cartSnapshot.raw;
    if (current?.items) {
      const optimisticItems = current.items.map((i: any) => {
        if ((i?.key ?? '') !== lineKey) return i;
        const q = quantity;
        const p = Number(i.price) || 0;
        const lineTotal = p * q;
        return { ...i, quantity: q, line_price: lineTotal, final_line_price: lineTotal };
      });
      const itemsSubtotal = optimisticItems.reduce((s: number, i: any) => s + (Number(i.line_price) ?? 0), 0);
      const optimisticRaw = { ...current, items: optimisticItems, item_count: optimisticItems.length, items_subtotal_price: itemsSubtotal, total_price: current.total_price ?? itemsSubtotal };
      this.applyOptimisticCart(optimisticRaw);
    }
    try {
      let sentQty = quantity;
      // Loop: keep sending API calls until server matches the latest expected qty
      for (;;) {
        const raw = await apiChangeCart(lineKey, sentQty);
        this.lastMutationAppliedAt = Date.now();
        const expectedQty = this.expectedQtyByLine.get(lineKey);
        if (expectedQty !== undefined && expectedQty !== sentQty) {
          // User clicked more while API was in-flight; fire follow-up instead of syncCart
          sentQty = expectedQty;
          continue;
        }
        if (raw?.items != null && typeof raw.item_count === 'number') {
          const serverLine = raw.items.find((i: any) => (i?.key ?? '') === lineKey);
          if (serverLine && expectedQty !== undefined && Number(serverLine.quantity) === expectedQty) {
            // Server confirmed optimistic qty — do a silent update (no cascading re-renders).
            // Only update cart.raw and server-authoritative totals; skip recs/decision/revalidation.
            this.applyCartRawSilent(raw);
          } else {
            await this.syncCart();
          }
        } else {
          await this.syncCart();
        }
        break;
      }
      this.expectedQtyByLine.delete(lineKey);
      setTimeout(() => this.emitEvent('cart:change', { lineKey, quantity: this.expectedQtyByLine.get(lineKey) ?? quantity }), 0);
    } catch (_err) {
      this.expectedQtyByLine.delete(lineKey);
      this.setState({ cart: cartSnapshot });
      throw _err;
    } finally {
      this.lastMutationAppliedAt = Date.now();
      this.internalMutationInProgress = false;
      this.changeCartInFlightByLine.delete(lineKey);
      this.syncChangeInFlightLineKeysToState();
    }
  }

  async removeItem(lineKey: string): Promise<void> {
    if (String(lineKey).startsWith(Engine.OPTIMISTIC_KEY_PREFIX)) {
      const raw = getStateFromStore(this.stateStore).cart.raw;
      if (!raw?.items) return;
      const items = raw.items.filter((i: any) => (i?.key ?? '') !== lineKey);
      const itemsSubtotal = items.reduce((s: number, i: any) => s + (Number(i.line_price) ?? 0), 0);
      this.applyOptimisticCart({ ...raw, items, item_count: items.length, items_subtotal_price: itemsSubtotal, total_price: raw.total_price ?? itemsSubtotal });
      return;
    }
    this.expectedRemovedLineKeys.add(lineKey);
    this.expectedQtyByLine.delete(lineKey);
    this.internalMutationInProgress = true;
    this.lastMutationAppliedAt = Date.now();
    const cartSnapshot = { ...getStateFromStore(this.stateStore).cart };
    const current = cartSnapshot.raw;
    if (current?.items) {
      const items = current.items.filter((i: any) => (i?.key ?? '') !== lineKey);
      const itemsSubtotal = items.reduce((s: number, i: any) => s + (Number(i.line_price) ?? 0), 0);
      this.applyOptimisticCart({ ...current, items, item_count: items.length, items_subtotal_price: itemsSubtotal, total_price: current.total_price ?? itemsSubtotal });
    }
    try {
      const raw = await apiRemoveItem(lineKey);
      this.lastMutationAppliedAt = Date.now();
      const stillExpectRemoved = this.expectedRemovedLineKeys.has(lineKey);
      if (raw?.items != null && typeof raw.item_count === 'number') {
        const lineStillPresent = raw.items.some((i: any) => (i?.key ?? '') === lineKey);
        if (stillExpectRemoved && !lineStillPresent) {
          this.applyCartRawBatched(raw);
        } else {
          await this.syncCart();
        }
      } else {
        await this.syncCart();
      }
      this.expectedRemovedLineKeys.delete(lineKey);
      setTimeout(() => this.emitEvent('cart:remove', { lineKey }), 0);
    } catch (_err) {
      this.expectedRemovedLineKeys.delete(lineKey);
      this.setState({ cart: cartSnapshot });
      throw _err;
    } finally {
      this.lastMutationAppliedAt = Date.now();
      this.internalMutationInProgress = false;
    }
  }

  /**
   * Set rewards tier config (e.g. from block). Does not enqueue effects.
   */
  setRewardsConfig(tiers: Array<{ thresholdCents: number; label: string }>): void {
    this.updateState((s) => ({
      rewards: { ...s.rewards, tiers: tiers ?? [] },
    }));
  }

  /**
   * Clear confetti flag after UI animation ends. Call from Drawer when confetti finishes.
   */
  clearConfetti(): void {
    this.setState({ rewards: { showConfetti: false } });
  }
}
