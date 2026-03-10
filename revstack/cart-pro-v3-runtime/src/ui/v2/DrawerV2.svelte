<script>
  import { onMount, onDestroy } from 'svelte';
  import { createEventDispatcher } from 'svelte';
  import { releaseBodyScroll } from '../../overflowScroll';
  import CartItems from './CartItems.svelte';
  import Recommendations from './Recommendations.svelte';
  import Milestones from './Milestones.svelte';
  import CouponSection from './CouponSection.svelte';
  import ShippingSection from './ShippingSection.svelte';
  import CheckoutSection from './CheckoutSection.svelte';

  const HOST_ID = 'cart-pro-root';

  export let engine;
  export let contentReady = false;
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
  $: shipping = $stateStore?.shipping ?? { remaining: null, unlocked: false };

  $: items = cart?.raw?.items ?? [];
  $: currency = cart?.raw?.currency ?? 'USD';
  $: totalDiscountCents = cart?.raw?.total_discount ?? (cart?.subtotal && cart?.total != null ? Math.max(0, cart.subtotal - cart.total) : 0);
  $: showCheckoutIframe = checkout?.enabled && checkout?.overlayVisible && checkout?.checkoutUrl;

  $: shippingMsg = (shipping?.unlocked && items?.length)
    ? "You're eligible for free shipping!"
    : (shipping?.remaining != null && shipping.remaining > 0 && items?.length)
      ? `Add ${(shipping.remaining / 100).toFixed(2)} more for free shipping`
      : (cart?.raw && items?.length ? "You're eligible for free shipping on qualifying orders." : '');
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
  $: countdownVisible = engine?.getConfig?.()?.appearance?.countdownEnabled === true;
  // Feature flags — default true while config not yet loaded so sections don't flash-hide on init.
  $: enableUpsell = engine?.getConfig?.()?.featureFlags?.enableUpsell ?? true;
  $: enableDiscounts = engine?.getConfig?.()?.featureFlags?.enableDiscounts ?? true;
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
    const root = confettiLayerEl || document.getElementById('cart-pro-confetti-layer');
    if (root) root.querySelectorAll('.rewards-confetti-container').forEach((el) => el.remove());
    else document.querySelectorAll('.rewards-confetti-container').forEach((el) => el.remove());
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

  const CONFETTI_DURATION_MS = 2500;
  let confettiTimeoutId = null;
  let confettiLayerEl = null;

  /**
   * Run confetti from the drawer area (like cart drawer v2): origin at drawer center-top,
   * paced stream (staggered delays), contained horizontal spread so it stays over the drawer.
   * Container is appended to the confetti layer inside shadow DOM so it stacks above the cart.
   */
  function runConfetti(onDone) {
    const target = confettiLayerEl || document.getElementById('cart-pro-confetti-layer');
    if (!target) return;
    const container = document.createElement('div');
    container.setAttribute('aria-hidden', 'true');
    container.className = 'rewards-confetti-container';
    container.style.zIndex = '2147483650';
    const colors = ['#f59e0b', '#10b981', '#3b82f6', '#ec4899', '#8b5cf6'];
    // Paced stream: fewer pieces, spread over ~1.2s like v2 (4 particles/frame for 2.5s)
    const count = 40;
    for (let i = 0; i < count; i++) {
      const el = document.createElement('div');
      el.className = 'rewards-confetti-piece';
      // Stagger delays 0–1.2s so confetti falls in a stream, not all at once
      el.style.setProperty('--delay', `${Math.random() * 1.2}s`);
      // Origin near drawer: spread ±15vw from center so it stays over the drawer (right side)
      el.style.setProperty('--x', `${(Math.random() - 0.5) * 30}vw`);
      el.style.background = colors[i % colors.length];
      container.appendChild(el);
    }
    target.appendChild(container);
    confettiTimeoutId = setTimeout(() => {
      confettiTimeoutId = null;
      container.remove();
      if (typeof onDone === 'function') onDone();
    }, CONFETTI_DURATION_MS);
  }

  onMount(() => {
    console.log('[CartPro V3] DrawerV2 mounted');
  });
</script>

<div id="cart-pro" class:open={$stateStore?.ui?.drawerOpen} role="presentation">
  <div id="cart-pro-overlay" role="button" tabindex="-1" aria-label="Close cart overlay" on:click={handleClose} on:keydown={(e) => e.key === 'Escape' && handleClose()}></div>
  <div id="cart-pro-drawer" role="dialog" aria-modal="true" aria-labelledby="cart-pro-title" tabindex="-1">
    <div id="cart-pro-header">
      <span id="cart-pro-title">Your Cart</span>
      <button id="cart-pro-close" type="button" aria-label="Close drawer" on:click={handleClose}>×</button>
    </div>
    {#if contentReady}
      <Milestones {engine} {currency} />
      <CartItems {engine} items={items} {currency} onClose={handleClose} />
      {#if enableUpsell}
        <Recommendations {engine} />
      {/if}
      <div id="cart-pro-footer">
        {#if enableDiscounts}
          <CouponSection {engine} applied={discount.applied} validating={discount.validating} lastError={discount.lastError} />
        {/if}
        <CheckoutSection
          {engine}
          subtotalCents={cart.subtotal}
          totalDiscountCents={totalDiscountCents}
          {currency}
          checkoutEnabled={checkout.enabled}
          checkoutUrl={checkout.checkoutUrl}
          syncing={cart.syncing}
          countdownVisible={countdownVisible}
          shippingLoading={false}
          freeShippingMsg={shippingMsg}
          savingsMsg={savingsMsg}
        />
      </div>
    {/if}
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
<div id="cart-pro-confetti-layer" bind:this={confettiLayerEl} aria-hidden="true" class="cart-pro-confetti-layer"></div>

<style>
  .checkout-overlay {
    position: fixed;
    inset: 0;
    z-index: 10;
    background: #ffffff;
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
    color: var(--cp-primary);
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
  /* Confetti layer: fixed to viewport, on top of drawer and overlay. Isolation forces own stacking context above cart. */
  .cart-pro-confetti-layer {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    pointer-events: none;
    z-index: 2147483650;
    isolation: isolate;
  }
  :global(.rewards-confetti-container) {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    pointer-events: none;
    z-index: 2147483650;
    overflow: hidden;
    isolation: isolate;
  }
  /* Confetti pieces: originate at top of viewport, fall downward; spread horizontally over drawer area. */
  :global(.rewards-confetti-piece) {
    position: absolute;
    left: 85%;
    top: 0;
    width: 10px;
    height: 10px;
    margin-left: -5px;
    margin-top: 0;
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
