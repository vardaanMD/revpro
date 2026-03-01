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
import { fetchCart as apiFetchCart, addToCart as apiAddToCart, changeCart as apiChangeCart, removeItem as apiRemoveItem } from './cartApi';
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
import { buildStubRecommendations } from './recommendationsStub';
import type { AppliedDiscount, OneClickOfferState } from './state';
import { normalizeConfig } from './normalizeConfig';
import type { NormalizedEngineConfig, RawCartProConfig } from './configSchema';
import { createCountdown, type CountdownApi } from './countdown';

const REVALIDATION_DEBOUNCE_MS = 800;

/** Bundle-level default so getConfig() never returns null before snapshot loads. */
const DEFAULT_RUNTIME_CONFIG = Object.freeze(normalizeConfig({})) as NormalizedEngineConfig;

/** Fallback countdown duration when config.appearance.countdownDurationMs is missing. */
const DEFAULT_COUNTDOWN_MS = 10 * 60 * 1000;

/** Dev-only warnings for stress guards. */
const isDev =
  typeof (import.meta as unknown as { env?: { DEV?: boolean } })?.env !== 'undefined' &&
  (import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV === true;
const EFFECT_QUEUE_CAP_WARN = 50;
const ANALYTICS_QUEUE_SOFT_CAP_WARN = 100;

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

export class Engine {
  readonly stateStore: Writable<EngineState>;
  private readonly eventBus: EventBus;
  private readonly effectQueue: EffectQueue;
  private internalMutationInProgress = false;
  private revalidationTimer: ReturnType<typeof setTimeout> | null = null;
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
    return this.internalMutationInProgress;
  }

  init(): void {
    const bootStart = typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
    this.setState({
      app: { status: 'BOOTING' },
      runtime: { initializedAt: Date.now() },
      analytics: { sessionId: createSessionId() },
    });
    this.interceptorTeardown = createCartInterceptor(this);
    this.on('cart:external-update', () => {
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

      if (Array.isArray((rawConfig as any).recommendations)) {
        this.setState({
          snapshotRecommendations: (rawConfig as any).recommendations.map((r: any) => ({
            variantId: Number(r.variantId),
            title: r.title ?? '',
            imageUrl: r.imageUrl ?? null,
            price: r.price ?? { amount: 0 },
            handle: r.handle ?? '',
          })),
        });
      }
      console.log('[CartPro V3] Hydrated snapshot recommendations:', this.stateStore);
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
   */
  onDrawerOpened(): void {
    if (!this.config.appearance.countdownEnabled) return;
    const duration = this.config.appearance.countdownDurationMs ?? DEFAULT_COUNTDOWN_MS;
    if (duration <= 0) return;
    const raw = getStateFromStore(this.stateStore).cart.raw;
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
    const qLen = getStateFromStore(this.stateStore).analytics.queue.length;
    if (isDev && qLen >= ANALYTICS_QUEUE_SOFT_CAP_WARN) {
      console.warn(
        `[Cart Pro V3] Analytics queue size (${qLen}) at or above soft cap (${ANALYTICS_QUEUE_SOFT_CAP_WARN}). Flush may be delayed.`
      );
    }
    this.scheduleAnalyticsFlush();
  }

  private scheduleAnalyticsFlush(): void {
    const state = getStateFromStore(this.stateStore);
    if (state.analytics.sending || !state.analytics.enabled || state.analytics.queue.length === 0) {
      return;
    }
    const now = Date.now();
    const shouldFlushByCount = state.analytics.queue.length >= 5;
    const shouldFlushByTime =
      state.analytics.lastFlushAt != null && now - state.analytics.lastFlushAt >= FLUSH_INTERVAL_MS;
    if (this.analyticsFlushTimer) clearTimeout(this.analyticsFlushTimer);
    if (shouldFlushByCount || shouldFlushByTime) {
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
    const len = this.effectQueue.getQueueLength();
    if (isDev && len >= EFFECT_QUEUE_CAP_WARN) {
      console.warn(
        `[Cart Pro V3] Effect queue length (${len}) at or above cap warning (${EFFECT_QUEUE_CAP_WARN}). Consider reducing cart mutation frequency.`
      );
    }
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
    await this.syncCart({ fromReapply: true });
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

  /**
   * Sync cart from Shopify. Must be called inside enqueueEffect() to avoid race conditions.
   * When fromReapply is true, does not enqueue reapplyDiscounts to avoid loop.
   *
   * PRESSURE POINT (reapply): If not fromReapply and we have applied discounts, we enqueue
   * reapplyDiscounts(), which then calls syncCart({ fromReapply: true }). That can mean 2 syncs
   * per cart mutation. Acceptable for Phase 4; optimize in Phase 5 (e.g. coalesce or skip reapply
   * when backend already applies during validation). See DISCOUNT_DESIGN_NOTES.md.
   */
  async syncCart(options?: { fromReapply?: boolean }): Promise<void> {
    if (this.destroyed) return;
    const state = getStateFromStore(this.stateStore);
    if (state.cart.syncing) return;
    const syncStart = typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
    this.setState({
      cart: { syncing: true },
    });
    try {
      const raw = await apiFetchCart();
      const itemCount = raw.item_count ?? 0;
      const subtotal =
        raw.items_subtotal_price ??
        (Array.isArray(raw.items)
          ? raw.items.reduce((sum: number, item: any) => sum + (item.line_price ?? 0), 0)
          : 0);
      const total = raw.total_price ?? 0;
      this.setState({
        cart: {
          raw,
          itemCount,
          subtotal,
          total,
          syncing: false,
          lastSyncedAt: Date.now(),
        },
      });
      this.reconcileCartDiscountState(raw);
      this.perf.cartSyncDuration =
        typeof performance !== 'undefined' && performance.now
          ? performance.now() - syncStart
          : 0;
      this.emit('cart:updated', { raw });

      // V2 lever: trace config-derived lever state (do not clear these in syncCart).
      console.log('[CartPro V3] Lever state:', {
        countdownEnabled: this.config?.appearance?.countdownEnabled === true,
        shippingThreshold: this.config?.freeShipping?.thresholdCents,
        teaseMessage: this.config?.discounts?.teaseMessage,
      });

      // Urgency countdown: config as primary; restart only when disabled or cart signature changed.
      const enabled = this.config?.appearance?.countdownEnabled === true;
      if (!enabled) {
        this.countdown.stop();
      } else {
        const signature = this.getCartSignature(raw);
        if (!this.countdown.isRunning() || signature !== this.lastCountdownSignature) {
          const duration =
            this.config.appearance.countdownDurationMs ?? DEFAULT_COUNTDOWN_MS;
          this.countdown.start(duration);
          this.lastCountdownSignature = signature;
        }
      }

      // Shipping: update remaining/unlocked from config threshold + cart only; do not clear or reset lever.
      const threshold = this.config.freeShipping.thresholdCents ?? null;
      if (threshold != null) {
        const itemsSubtotal = raw.items_subtotal_price ?? subtotal;
        const remaining = threshold - itemsSubtotal;
        this.setState({
          shipping: {
            remaining: Math.max(remaining, 0),
            unlocked: remaining <= 0,
            loading: false,
          },
        });
      } else {
        this.setState({
          shipping: {
            remaining: null,
            unlocked: false,
            loading: false,
          },
        });
      }

      // Rewards: compute unlocked tier (only when feature enabled).
      const stateAfterCart = getStateFromStore(this.stateStore);
      const { rewards } = stateAfterCart;
      const runRewards = !this.config || this.config.featureFlags.enableRewards;
      if (runRewards) {
        const subtotalCents = stateAfterCart.cart.subtotal ?? 0;
        const newUnlockedIndex = computeUnlockedTier(subtotalCents, rewards.tiers);
        const lastUnlocked = rewards.lastUnlockedTierIndex;
        const isNewTierUnlock =
          newUnlockedIndex !== null &&
          (lastUnlocked === null || newUnlockedIndex > lastUnlocked);
        this.setState({
          rewards: {
            ...rewards,
            unlockedTierIndex: newUnlockedIndex,
            lastUnlockedTierIndex: isNewTierUnlock ? newUnlockedIndex : rewards.lastUnlockedTierIndex,
            showConfetti: isNewTierUnlock,
          },
        });
      }

      // Upsell: compute standard list and optionally fetch AI (only when feature enabled).
      const stateAfterSync = getStateFromStore(this.stateStore);
      const runUpsell = !this.config || this.config.featureFlags.enableUpsell;
      const standardConfig = stateAfterSync.upsell.standardConfig;
      let standard = stateAfterSync.upsell.standard;
      const currentStateForUpsell = getStateFromStore(this.stateStore);
      const hasSnapshot =
        Array.isArray(currentStateForUpsell.snapshotRecommendations) &&
        currentStateForUpsell.snapshotRecommendations.length > 0;
      if (runUpsell) {
        standard = computeStandardUpsell(raw, standardConfig);
        if (!hasSnapshot) {
          this.setState({
            upsell: {
              ...stateAfterSync.upsell,
              standard,
            },
          });
        }
        console.log('[CartPro] Rule-based recommendations:', standard);

        if (stateAfterSync.upsell.aiEnabled) {
          const signature = getCartSignatureForAi(raw);
          const cached = this.aiRecommendationsCache.get(signature);
            if (cached !== undefined) {
            const stateBeforeAi = getStateFromStore(this.stateStore);
            const hasSnapshotBeforeAi =
              Array.isArray(stateBeforeAi.snapshotRecommendations) &&
              stateBeforeAi.snapshotRecommendations.length > 0;
            if (!hasSnapshotBeforeAi) {
              this.setState({
                upsell: {
                  ...getStateFromStore(this.stateStore).upsell,
                  aiRecommendations: cached,
                  loading: false,
                },
              });
            } else {
              this.setState({
                upsell: { ...getStateFromStore(this.stateStore).upsell, loading: false },
              });
            }
          } else {
            this.aiFetchStartedAt = Date.now();
            this.setState({
              upsell: {
                ...getStateFromStore(this.stateStore).upsell,
                loading: true,
              },
            });
            debouncedPostRecommendations(raw, (result) => {
              if (this.destroyed) return;
              if (this.aiFetchStartedAt > 0) {
                this.perf.aiFetchDuration = Date.now() - this.aiFetchStartedAt;
                this.aiFetchStartedAt = 0;
              }
              const currentRaw = getStateFromStore(this.stateStore).cart.raw;
              const currentSignature = currentRaw ? getCartSignatureForAi(currentRaw) : '';
              if (currentSignature !== signature) return;
              const cartVariantIds = new Set(
                (currentRaw?.items ?? []).map((i: any) => Number(i?.variant_id ?? i?.id)).filter((n: number) => Number.isInteger(n) && n > 0)
              );
              const filtered = result.filter((r) => !cartVariantIds.has(r.variantId));
              this.aiRecommendationsCache.set(signature, filtered);
              const s = getStateFromStore(this.stateStore);
              const hasSnapshotInCallback =
                Array.isArray(s.snapshotRecommendations) &&
                s.snapshotRecommendations.length > 0;
              if (!hasSnapshotInCallback) {
                this.setState({
                  upsell: {
                    ...s.upsell,
                    aiRecommendations: filtered,
                    loading: false,
                  },
                });
              } else {
                this.setState({
                  upsell: { ...s.upsell, loading: false },
                });
              }
              const ids = result.map((r) => r.variantId);
              if (ids.length > 0) {
                fetchVariantAvailability(ids, s.upsell.cache).then((next) => {
                  if (Object.keys(next).length === 0) return;
                  const s2 = getStateFromStore(this.stateStore);
                  this.setState({
                    upsell: { ...s2.upsell, cache: { ...s2.upsell.cache, ...next } },
                  });
                });
              }
            });
          }
        }

        // Variant availability: only fetch IDs not already in cache to avoid duplicate fetches.
        const stateForVariant = getStateFromStore(this.stateStore);
        const variantIdsToCheck = [
          ...standard.map((r) => r.variantId),
          ...stateForVariant.upsell.aiRecommendations.map((r) => r.variantId),
        ]
          .filter((id, i, arr) => arr.indexOf(id) === i)
          .filter((id) => stateForVariant.upsell.cache[id] === undefined);
        if (variantIdsToCheck.length > 0) {
          const currentCache = getStateFromStore(this.stateStore).upsell.cache;
          fetchVariantAvailability(variantIdsToCheck, currentCache).then((next) => {
            if (Object.keys(next).length === 0) return;
            const s = getStateFromStore(this.stateStore);
            this.setState({
              upsell: {
                ...s.upsell,
                cache: { ...s.upsell.cache, ...next },
              },
            });
          });
        }
      }

      // Stub ONLY when AI disabled; never overwrite aiRecommendations when AI enabled (cache/callback own it).
      if (!stateAfterSync.upsell.aiEnabled) {
        const stubAI = buildStubRecommendations(raw);
        const stateBeforeStub = getStateFromStore(this.stateStore);
        const hasSnapshotBeforeStub =
          Array.isArray(stateBeforeStub.snapshotRecommendations) &&
          stateBeforeStub.snapshotRecommendations.length > 0;
        if (!hasSnapshotBeforeStub) {
          this.setState({
            upsell: {
              ...getStateFromStore(this.stateStore).upsell,
              aiRecommendations: stubAI,
              loading: false,
            },
          });
        } else {
          this.setState({
            upsell: { ...getStateFromStore(this.stateStore).upsell, loading: false },
          });
        }
      } else {
        const stateNow = getStateFromStore(this.stateStore);
        if (!stateNow.upsell.loading) {
          this.setState({ upsell: { ...stateNow.upsell, loading: false } });
        }
      }

      if (!options?.fromReapply) {
        const state = getStateFromStore(this.stateStore);
        const runDiscounts = !this.config || this.config.featureFlags.enableDiscounts;
        const runFreeGifts = !this.config || this.config.featureFlags.enableFreeGifts;
        if (runDiscounts && state.discount.applied.length > 0) {
          setTimeout(() => this.enqueueEffect(() => this.reapplyDiscounts()), 0);
        }
        if (runFreeGifts && state.freeGifts.config.length > 0) {
          setTimeout(() => this.enqueueEffect(() => this.syncFreeGifts()), 0);
        }
      }
      this.triggerRevalidation();
    } catch (err) {
      this.setState({
        cart: { syncing: false },
      });
      throw err;
    }
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
    if (config.length === 0) return;

    const freeGiftStart =
      typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
    this.setState({ freeGifts: { syncing: true } });
    try {
      const cartRaw = state.cart.raw;
      const expectedMap = computeExpectedGifts(cartRaw, config);
      const giftVariantIds =
        this.config?.freeGifts.giftVariantIds ?? getGiftVariantIds(config);
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
    const operation = 'addToCart';
    console.log('[CartPro V3] Mutation start:', operation);
    this.internalMutationInProgress = true;
    try {
      await apiAddToCart(variantId, quantity);
      await this.syncCart();
      this.emitEvent('cart:add', { variantId, quantity });
      const s = getStateFromStore(this.stateStore);
      const isUpsell =
        s.upsell.standard.some((r) => r.variantId === variantId) ||
        s.upsell.aiRecommendations.some((r) => r.variantId === variantId);
      if (isUpsell) this.emitEvent('upsell:add', { variantId, quantity });
    } finally {
      this.internalMutationInProgress = false;
      console.log('[CartPro V3] Mutation end:', operation);
    }
  }

  async changeCart(lineKey: string, quantity: number): Promise<void> {
    const operation = 'changeCart';
    console.log('[CartPro V3] Mutation start:', operation);
    this.internalMutationInProgress = true;
    try {
      await apiChangeCart(lineKey, quantity);
      await this.syncCart();
      this.emitEvent('cart:change', { lineKey, quantity });
    } finally {
      this.internalMutationInProgress = false;
      console.log('[CartPro V3] Mutation end:', operation);
    }
  }

  async removeItem(lineKey: string): Promise<void> {
    const operation = 'removeItem';
    console.log('[CartPro V3] Mutation start:', operation);
    this.internalMutationInProgress = true;
    try {
      await apiRemoveItem(lineKey);
      await this.syncCart();
      this.emitEvent('cart:remove', { lineKey });
    } finally {
      this.internalMutationInProgress = false;
      console.log('[CartPro V3] Mutation end:', operation);
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
