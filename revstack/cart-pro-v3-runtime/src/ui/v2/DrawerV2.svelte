<script>
  import { onMount, onDestroy, tick } from 'svelte';
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
  $: snapshotCurrency = engine?.getConfig?.()?.currency;
  $: currency = cart?.raw?.currency ?? snapshotCurrency ?? 'USD';
  $: totalDiscountCents = cart?.raw?.total_discount ?? (cart?.subtotal && cart?.total != null ? Math.max(0, cart.subtotal - cart.total) : 0);

  /** Only allow checkout iframe for *.myshopify.com or *.shopify.com domains. */
  function isAllowedCheckoutUrl(url) {
    if (typeof url !== 'string' || !url.trim()) return false;
    try {
      const parsed = new URL(url);
      const host = parsed.hostname.toLowerCase();
      return host.endsWith('.myshopify.com') || host.endsWith('.shopify.com');
    } catch {
      return false;
    }
  }

  $: validCheckoutUrl = isAllowedCheckoutUrl(checkout?.checkoutUrl);
  $: {
    if (checkout?.enabled && checkout?.overlayVisible && checkout?.checkoutUrl && !validCheckoutUrl) {
      console.warn('[Cart Pro] Blocked checkout iframe: URL not on allowlist (*.myshopify.com, *.shopify.com):', checkout.checkoutUrl);
    }
  }
  $: showCheckoutIframe = checkout?.enabled && checkout?.overlayVisible && checkout?.checkoutUrl && validCheckoutUrl;

  $: shippingMsg = (shipping?.unlocked && items?.length)
    ? "You're eligible for free shipping!"
    : (shipping?.remaining != null && shipping.remaining > 0 && items?.length)
      ? `Add ${(shipping.remaining / 100).toFixed(2)} more for free shipping`
      : (cart?.raw && items?.length ? "You're eligible for free shipping on qualifying orders." : '');
  $: savingsMsg = '';

  $: drawerOpen = $stateStore?.ui?.drawerOpen ?? false;

  let confettiAlreadyTriggered = false;
  /* Only fire confetti when the cart drawer is open; don't show when milestone is reached with cart closed. */
  $: if (rewards.showConfetti && !confettiAlreadyTriggered && drawerOpen) {
    confettiAlreadyTriggered = true;
    runConfetti(() => {
      engine?.clearConfetti?.();
    });
  }
  $: if (!rewards.showConfetti) confettiAlreadyTriggered = false;
  $: countdownVisible = engine?.getConfig?.()?.appearance?.countdownEnabled === true;
  // Feature flags — default true while config not yet loaded so sections don't flash-hide on init.
  $: enableUpsell = engine?.getConfig?.()?.featureFlags?.enableUpsell ?? true;
  $: enableDiscounts = engine?.getConfig?.()?.featureFlags?.enableDiscounts ?? true;
  $: enableRewards = engine?.getConfig?.()?.featureFlags?.enableRewards ?? true;
  /** Up to 3 custom header messages that rotate (from config.appearance.cartHeaderMessages). */
  $: cartHeaderMessages = engine?.getConfig?.()?.appearance?.cartHeaderMessages ?? [];
  $: showHeaderBanner = engine?.getConfig?.()?.appearance?.showHeaderBanner !== false;
  $: hasHeaderMessages = showHeaderBanner && Array.isArray(cartHeaderMessages) && cartHeaderMessages.length > 0;

  const ROTATE_INTERVAL_MS = 4000;
  let headerMessageState = { index: 0 };
  let rotateIntervalId = null;
  $: currentHeaderMessage = hasHeaderMessages ? cartHeaderMessages[headerMessageState.index % cartHeaderMessages.length] : '';

  /** When drawer is open, app container must have pointer-events: auto so buttons (e.g. Add on recommendations) receive clicks. */
  function setAppContainerPointerEvents(value) {
    if (typeof document === 'undefined') return;
    const root = cartProEl?.getRootNode?.();
    if (root && root instanceof ShadowRoot) {
      const appContainer = root.getElementById('cart-pro-v3-app');
      if (appContainer) appContainer.style.pointerEvents = value;
    }
  }

  /** Set drawer transition via helper so reactive block never touches drawerEl (avoids $$invalidate loop). */
  function setDrawerTransition(value) {
    if (typeof document === 'undefined') return;
    const host = document.getElementById(HOST_ID);
    const root = host?.shadowRoot;
    const el = root?.getElementById('cart-pro-drawer');
    if (el) el.style.transition = value;
  }

  /** Set drawer transform via helper so reactive block never touches drawerEl (avoids $$invalidate loop). */
  function setDrawerTransform(value) {
    if (typeof document === 'undefined') return;
    const host = document.getElementById(HOST_ID);
    const root = host?.shadowRoot;
    const el = root?.getElementById('cart-pro-drawer');
    if (el) el.style.transform = value;
  }

  let cartProEl;
  // Use tick() when opening so bind:this={cartProEl} is set before we set app container pointer-events (fixes Add button not receiving clicks).
  // Only call helpers — never reference drawerEl in this block (kills $$invalidate loop).
  $: if (drawerOpen) {
    tick().then(() => {
      if (typeof document !== 'undefined') {
        document.body.style.overflow = 'hidden';
        document.documentElement.style.overflow = 'hidden';
      }
      setHostPointerEvents('auto');
      setAppContainerPointerEvents('auto');
      removeThemeDrawerClass();
      setDrawerTransition('');
      setDrawerTransform('');
    });
  } else {
    releaseBodyScroll();
    setHostPointerEvents('none');
    setAppContainerPointerEvents('none');
    removeThemeDrawerClass();
  }

  onDestroy(() => {
    if (rotateIntervalId != null) {
      clearInterval(rotateIntervalId);
      rotateIntervalId = null;
    }
    releaseBodyScroll();
    setHostPointerEvents('none');
    setAppContainerPointerEvents('none');
    removeThemeDrawerClass();
    if (confettiTimeoutId != null) clearTimeout(confettiTimeoutId);
    const layerEl = confettiLayerEl || document.getElementById('cart-pro-confetti-layer');
    const root = layerEl ? layerEl.getRootNode() : document;
    if (root && 'querySelectorAll' in root) root.querySelectorAll('.rewards-confetti-container').forEach((el) => el.remove());
  });

  function handleClose() {
    releaseBodyScroll();
    setHostPointerEvents('none');
    removeThemeDrawerClass();
    // Ensure drawer state closes even if parent listener fails.
    try {
      engine?.setState?.({ ui: { drawerOpen: false } });
    } catch (_) {
      // ignore; parent close handler will still run if wired
    }
    dispatch('close');
  }

  /** Scroll footer into view when coupon input is focused (keeps checkout button visible above keyboard on mobile). */
  let footerEl;
  function scrollFooterIntoView() {
    requestAnimationFrame(() => {
      const el = footerEl || (typeof document !== 'undefined' && document.getElementById('cart-pro-footer'));
      if (el && typeof el.scrollIntoView === 'function') {
        el.scrollIntoView({ behavior: 'smooth', block: 'end' });
      }
    });
  }

  /** Swipe-to-close: track drag from header only so it doesn't conflict with recommendation carousel. */
  const SWIPE_CLOSE_THRESHOLD_PX = 50;
  let drawerEl;
  let dragStartX = 0;
  let lastDragOffset = 0;
  let isDragging = false;

  /** Treat taps on buttons/links as normal clicks, not swipe gestures. */
  function isInteractiveTarget(node) {
    if (!node || typeof node.closest !== 'function') return false;
    return !!node.closest('button, a, input, textarea, select, [role="button"]');
  }

  function getClientX(e) {
    if (e.type.startsWith('touch')) return e.touches?.[0]?.clientX ?? e.changedTouches?.[0]?.clientX ?? 0;
    return e.clientX ?? 0;
  }

  function onSwipeStart(e) {
    if (!drawerEl || !$stateStore?.ui?.drawerOpen) return;
    const target = e.target;
    if (target && isInteractiveTarget(target)) return;
    isDragging = true;
    dragStartX = getClientX(e);
    lastDragOffset = 0;
    setDrawerTransition('none');
    if (e.type === 'mousedown') {
      const up = (e2) => { onSwipeEnd(); window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
      const move = (e2) => onSwipeMove(e2);
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    }
  }

  function onSwipeMove(e) {
    if (!isDragging || !drawerEl) return;
    const x = getClientX(e);
    const deltaX = x - dragStartX;
    const offset = Math.max(0, deltaX);
    // Small jitter should still allow a tap to register; only treat as swipe after a few px.
    if (offset <= 5) {
      lastDragOffset = 0;
      setDrawerTransform('');
      return;
    }
    lastDragOffset = offset;
    setDrawerTransform(`translateX(${offset}px)`);
    if (offset > 5 && e.cancelable) e.preventDefault();
  }

  function onSwipeEnd() {
    if (!isDragging || !drawerEl) return;
    isDragging = false;
    setDrawerTransition('');
    if (lastDragOffset >= SWIPE_CLOSE_THRESHOLD_PX) {
      setDrawerTransform('');
      handleClose();
    } else {
      setDrawerTransform('translateX(0)');
    }
    lastDragOffset = 0;
  }

  function onCloseCheckout() {
    engine?.closeCheckout?.();
  }

  const CONFETTI_DURATION_MS = 2500;
  let confettiTimeoutId = null;
  let confettiLayerEl = null;

  /**
   * Run confetti from the top of the viewport. Append container to the shadow root (when in
   * shadow DOM) so it is a direct sibling of the app container and always paints in front of the cart.
   */
  function runConfetti(onDone) {
    const layerEl = confettiLayerEl || document.getElementById('cart-pro-confetti-layer');
    if (!layerEl) return;
    const root = layerEl.getRootNode();
    const appendTarget = root instanceof ShadowRoot ? root : layerEl;
    const container = document.createElement('div');
    container.setAttribute('aria-hidden', 'true');
    container.className = 'rewards-confetti-container';
    container.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483650;overflow:hidden;';
    const colors = ['#f59e0b', '#10b981', '#3b82f6', '#ec4899', '#8b5cf6'];
    const count = 40;
    for (let i = 0; i < count; i++) {
      const el = document.createElement('div');
      el.className = 'rewards-confetti-piece';
      // Very small random delay (0–0.3s) so confetti starts almost instantly on milestone unlock.
      el.style.setProperty('--delay', `${Math.random() * 0.3}s`);
      /**
       * Position each piece horizontally within the actual drawer bounds so it fills the cart,
       * not just a narrow band on the far right of the viewport.
       */
      const viewportWidth = typeof window !== 'undefined' ? window.innerWidth || 0 : 0;
      const rect = drawerEl && typeof drawerEl.getBoundingClientRect === 'function' ? drawerEl.getBoundingClientRect() : null;
      let leftPx = 0;
      if (rect && viewportWidth > 0) {
        const clampedLeft = Math.max(0, rect.left);
        const clampedRight = Math.min(viewportWidth, rect.right);
        const width = Math.max(0, clampedRight - clampedLeft);
        leftPx = width > 0 ? clampedLeft + Math.random() * width : viewportWidth * Math.random();
      } else if (viewportWidth > 0) {
        // Fallback: right half of the viewport.
        leftPx = viewportWidth * (0.5 + Math.random() * 0.5);
      }
      el.style.setProperty('--left', `${leftPx}px`);
      /* Slight horizontal drift as it falls (within the drawer width). */
      el.style.setProperty('--x', `${(Math.random() - 0.5) * 24}px`);
      el.style.background = colors[i % colors.length];
      container.appendChild(el);
    }
    appendTarget.appendChild(container);
    confettiTimeoutId = setTimeout(() => {
      confettiTimeoutId = null;
      container.remove();
      if (typeof onDone === 'function') onDone();
    }, CONFETTI_DURATION_MS);
  }

  onMount(() => {
    const messages = engine?.getConfig?.()?.appearance?.cartHeaderMessages ?? [];
    if (Array.isArray(messages) && messages.length > 1) {
      const len = messages.length;
      rotateIntervalId = setInterval(() => {
        headerMessageState = { index: (headerMessageState.index + 1) % len };
      }, ROTATE_INTERVAL_MS);
    }
  });
</script>

<div id="cart-pro" class:open={$stateStore?.ui?.drawerOpen} role="presentation" bind:this={cartProEl}>
  <div id="cart-pro-overlay" role="button" tabindex="-1" aria-label="Close cart overlay" on:click={handleClose} on:keydown={(e) => e.key === 'Escape' && handleClose()}></div>
  <div id="cart-pro-drawer" role="dialog" aria-modal="true" aria-labelledby="cart-pro-title" tabindex="-1" bind:this={drawerEl}>
    <div
      id="cart-pro-header"
      class="cp-drawer-header-with-swipe"
      role="presentation"
      on:touchstart={onSwipeStart}
      on:touchmove={onSwipeMove}
      on:touchend={onSwipeEnd}
      on:touchcancel={onSwipeEnd}
      on:mousedown={onSwipeStart}
    >
      <span class="cp-drawer-handle" aria-hidden="true"></span>
      <div class="cp-header-row">
        <button
          type="button"
          class="cp-header-back"
          aria-label="Close drawer"
          on:click={handleClose}
        >
          &lt;
        </button>
        <span id="cart-pro-title">Your Cart</span>
        <button
          id="cart-pro-close"
          type="button"
          aria-label="Close drawer"
          on:click={handleClose}
        >
          ×
        </button>
      </div>
    </div>
    {#if hasHeaderMessages && currentHeaderMessage}
      <div class="cp-cart-header-messages" aria-live="polite">
        <p class="cp-cart-header-message">{currentHeaderMessage}</p>
      </div>
    {/if}
    {#if contentReady}
      {#if enableRewards}
        <Milestones {engine} {currency} />
      {/if}
      <div id="cart-pro-scroll" class="cp-drawer-scroll">
        <CartItems {engine} items={items} {currency} onClose={handleClose} />
        {#if enableUpsell}
          <Recommendations {engine} />
        {/if}
      </div>
      <div id="cart-pro-footer" bind:this={footerEl}>
        {#if enableDiscounts}
          <CouponSection {engine} applied={discount.applied} validating={discount.validating} lastError={discount.lastError} onCouponInputFocus={scrollFooterIntoView} />
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
  .cp-drawer-header-with-swipe {
    display: flex;
    flex-direction: column;
    align-items: stretch;
  }
  .cp-header-back {
    display: none;
  }
  .cp-drawer-handle {
    width: 36px;
    height: 4px;
    background: rgba(0, 0, 0, 0.2);
    border-radius: 2px;
    margin: 0 auto 8px;
    flex-shrink: 0;
  }
  .cp-header-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    width: 100%;
    min-height: 0;
  }
  @media (max-width: 768px) {
    .cp-header-row {
      justify-content: space-between;
    }
  }
  @media (min-width: 769px) {
    .cp-drawer-handle {
      display: none;
    }
  }
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
  /* Confetti: start above viewport so we only see falling; left from JS (--left) is positioned across the drawer width. */
  :global(.rewards-confetti-piece) {
    position: absolute;
    left: var(--left, 85%);
    top: 0;
    width: 10px;
    height: 10px;
    margin-left: -5px;
    margin-top: 0;
    border-radius: var(--cp-radius, 12px);
    /* Slightly faster fall so the effect feels snappy. */
    animation: rewards-confetti-fall 1.5s ease-out var(--delay, 0s) forwards;
    transform: translate(var(--x, 0), -20vh) rotate(0deg);
    opacity: 1;
  }
  @keyframes rewards-confetti-fall {
    to {
      transform: translate(var(--x, 0), 100vh) rotate(720deg);
      opacity: 0;
    }
  }
</style>
