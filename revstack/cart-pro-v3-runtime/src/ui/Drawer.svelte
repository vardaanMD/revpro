<script>
  import { onMount, onDestroy } from 'svelte';
  import { createEventDispatcher } from 'svelte';
  import { releaseBodyScroll } from '../overflowScroll';
  import CartItems from './v2/CartItems.svelte';
  import Recommendations from './v2/Recommendations.svelte';
  import Milestones from './v2/Milestones.svelte';
  import CouponSection from './v2/CouponSection.svelte';
  import ShippingSection from './v2/ShippingSection.svelte';
  import CheckoutSection from './v2/CheckoutSection.svelte';

  const HOST_ID = 'cart-pro-root';

  export let engine;
  const stateStore = engine.stateStore;
  const dispatch = createEventDispatcher();

  function setHostPointerEvents(value) {
    const host = typeof document !== 'undefined' ? document.getElementById(HOST_ID) : null;
    if (host) host.style.pointerEvents = value;
  }

  function removeThemeDrawerClass() {
    if (typeof document !== 'undefined' && document.body) document.body.classList.remove('js-drawer-open');
  }

  $: cart = $stateStore?.cart ?? { syncing: false, raw: null, itemCount: 0, subtotal: 0, total: 0 };
  $: discount = $stateStore?.discount ?? { applied: [], validating: false, lastError: null };
  $: rewards = $stateStore?.rewards ?? { tiers: [], unlockedTierIndex: null, showConfetti: false };
  $: upsell = $stateStore?.upsell ?? { standard: [], aiRecommendations: [], loading: false };
  $: checkout = $stateStore?.checkout ?? { enabled: false, overlayVisible: false, checkoutUrl: '' };

  $: items = cart?.raw?.items ?? [];
  $: snapshotCurrency = engine?.getConfig?.()?.currency;
  $: currency = cart?.raw?.currency ?? snapshotCurrency ?? 'USD';
  $: totalDiscountCents = cart?.raw?.total_discount ?? (cart?.subtotal && cart?.total != null ? Math.max(0, cart.subtotal - cart.total) : 0);
  $: showCheckoutIframe = checkout?.enabled && checkout?.overlayVisible && checkout?.checkoutUrl;

  $: shippingMsg = cart?.raw && items?.length ? "You're eligible for free shipping on qualifying orders." : '';
  $: savingsMsg = '';

  let confettiAlreadyTriggered = false;
  $: if (rewards.showConfetti && !confettiAlreadyTriggered) {
    confettiAlreadyTriggered = true;
    runConfetti(() => {
      engine?.clearConfetti?.();
    });
  }
  $: if (!rewards.showConfetti) confettiAlreadyTriggered = false;

  $: drawerOpen = $stateStore?.ui?.drawerOpen ?? false;
  $: if (drawerOpen) {
    if (typeof document !== 'undefined') {
      document.body.style.overflow = 'hidden';
      document.documentElement.style.overflow = 'hidden';
    }
    setHostPointerEvents('auto');
    removeThemeDrawerClass();
  } else {
    releaseBodyScroll();
    setHostPointerEvents('none');
    removeThemeDrawerClass();
  }

  onDestroy(() => {
    releaseBodyScroll();
    setHostPointerEvents('none');
    removeThemeDrawerClass();
    if (confettiTimeoutId != null) clearTimeout(confettiTimeoutId);
    document.querySelectorAll('.rewards-confetti-container').forEach((el) => el.remove());
  });

  function handleClose() {
    releaseBodyScroll();
    setHostPointerEvents('none');
    removeThemeDrawerClass();
    dispatch('close');
  }

  function onCloseCheckout() {
    engine?.closeCheckout?.();
  }

  const CONFETTI_DURATION_MS = 2200;
  let confettiTimeoutId = null;

  /** Disabled: confetti authority is DrawerV2 only. Never append to document.body. */
  function runConfetti(onDone) {
    const container = document.createElement('div');
    container.setAttribute('aria-hidden', 'true');
    container.className = 'rewards-confetti-container';
    const colors = ['#f59e0b', '#10b981', '#3b82f6', '#ec4899', '#8b5cf6'];
    const count = 50;
    for (let i = 0; i < count; i++) {
      const el = document.createElement('div');
      el.className = 'rewards-confetti-piece';
      el.style.setProperty('--delay', `${Math.random() * 0.3}s`);
      el.style.setProperty('--x', `${(Math.random() - 0.5) * 100}vw`);
      el.style.background = colors[i % colors.length];
      container.appendChild(el);
    }
    const detached = document.createElement('div');
    detached.appendChild(container);
    confettiTimeoutId = setTimeout(() => {
      confettiTimeoutId = null;
      container.remove();
      if (typeof onDone === 'function') onDone();
    }, CONFETTI_DURATION_MS);
  }

  onMount(() => {
    console.log('[CartPro V3] LEGACY Drawer.svelte mounted');
  });
</script>

<div id="cart-pro" class:open={$stateStore.ui.drawerOpen} role="presentation">
  <div id="cart-pro-overlay" role="button" tabindex="-1" aria-label="Close cart overlay" on:click={handleClose} on:keydown={(e) => e.key === 'Escape' && handleClose()}></div>
  <div id="cart-pro-drawer" role="dialog" aria-modal="true" aria-labelledby="cart-pro-title" tabindex="-1">
    <div id="cart-pro-header">
      <span id="cart-pro-title">Your Cart</span>
      <button id="cart-pro-close" type="button" aria-label="Close drawer" on:click={handleClose}>×</button>
    </div>
    <Milestones {engine} {currency} />
    <CartItems {engine} items={items} {currency} onClose={handleClose} />
    <Recommendations {engine} standard={upsell.standard} aiRecommendations={upsell.aiRecommendations} loading={upsell.loading} {currency} />
    <div id="cart-pro-footer">
      <CouponSection {engine} applied={discount.applied} validating={discount.validating} lastError={discount.lastError} />
      <CheckoutSection
        {engine}
        subtotalCents={cart.subtotal}
        totalDiscountCents={totalDiscountCents}
        {currency}
        checkoutEnabled={checkout.enabled}
        checkoutUrl={checkout.checkoutUrl}
        syncing={cart.syncing}
        countdownVisible={true}
        shippingLoading={false}
        freeShippingMsg={shippingMsg}
        savingsMsg={savingsMsg}
      />
    </div>
  </div>
</div>
{#if showCheckoutIframe}
  <div class="checkout-overlay" role="dialog" aria-modal="true" aria-label="Checkout">
    <button type="button" class="checkout-overlay-close" on:click={onCloseCheckout} aria-label="Close checkout">×</button>
    <div class="checkout-iframe-container">
      <iframe title="Checkout" src={checkout.checkoutUrl} class="checkout-iframe"></iframe>
    </div>
  </div>
{/if}
<div id="cart-pro-confetti-layer" aria-hidden="true" style="position:fixed;inset:0;pointer-events:none;z-index:2147483649;"></div>

<style>
  .checkout-overlay {
    position: fixed;
    inset: 0;
    z-index: 10;
    background: #fff;
    display: flex;
    flex-direction: column;
  }
  .checkout-overlay-close {
    position: absolute;
    top: 0.5rem;
    right: 0.5rem;
    z-index: 11;
    width: 2rem;
    height: 2rem;
    padding: 0;
    font-size: 1.5rem;
    line-height: 1;
    background: transparent;
    border: none;
    cursor: pointer;
    color: var(--cp-primary, #333);
  }
  .checkout-iframe-container {
    flex: 1;
    min-height: 0;
    position: relative;
  }
  .checkout-iframe {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    border: none;
  }
  :global(.rewards-confetti-container) {
    position: fixed;
    inset: 0;
    pointer-events: none;
    z-index: 9999;
    overflow: hidden;
  }
  :global(.rewards-confetti-piece) {
    position: absolute;
    left: 50%;
    top: 50%;
    width: 10px;
    height: 10px;
    margin-left: -5px;
    margin-top: -5px;
    border-radius: var(--cp-radius, 12px);
    animation: rewards-confetti-fall 2s ease-out var(--delay, 0s) forwards;
    transform: translate(var(--x, 0), 0) rotate(0deg);
    opacity: 1;
  }
  @keyframes rewards-confetti-fall {
    to {
      transform: translate(var(--x, 0), 100vh) rotate(720deg);
      opacity: 0;
    }
  }
</style>
