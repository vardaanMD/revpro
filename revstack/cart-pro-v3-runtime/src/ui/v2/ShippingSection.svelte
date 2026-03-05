<script>
  import { getUIText } from '../../lib/uiText';

  /** @type { import('../../engine/Engine').default } */
  export let engine;
  /** @type { string } */
  export let currency = 'USD';

  const stateStore = engine?.stateStore;

  /** V2: savings amount shown when free shipping unlocked (cents). */
  const FREE_SHIPPING_SAVINGS_CENTS = 499;

  /** V2: add cp-msg-visible in rAF after setting text so opacity fade-in matches. */
  let msgVisible = false;

  $: threshold = engine?.getConfig?.()?.freeShipping?.thresholdCents;
  $: shipping = $stateStore?.shipping ?? { remaining: null, unlocked: false, loading: true };
  $: subtotalCents = $stateStore?.cart?.subtotal ?? 0;
  $: displayCurrency = $stateStore?.cart?.raw?.currency ?? currency;
  $: itemCount = ($stateStore?.cart?.raw?.items?.length ?? 0) || ($stateStore?.cart?.itemCount ?? 0);
  $: appearance = engine?.getConfig?.()?.appearance ?? {};
  $: emojiConfig = { emojiMode: appearance.emojiMode !== false };

  $: subtotalAtOrAboveThreshold = threshold != null && subtotalCents >= threshold;
  $: remainingCents = shipping.remaining;
  $: showFallbackOnly = threshold == null && itemCount > 0;
  $: pct = threshold != null && threshold > 0 && remainingCents != null
    ? (remainingCents / threshold) * 100
    : 0;

  $: shippingMsg = (() => {
    if (shipping.loading) return '';
    if (showFallbackOnly) {
      return getUIText("You're eligible for free shipping on qualifying orders.", emojiConfig);
    }
    if (threshold == null) return '';
    if (subtotalAtOrAboveThreshold || shipping.unlocked) {
      return getUIText('🎉 FREE Shipping Unlocked!', emojiConfig);
    }
    if (remainingCents != null && remainingCents > 0) {
      const formatted = formatCurrency(remainingCents);
      if (pct > 50) {
        return getUIText("You're close. Add a little more to unlock FREE shipping.", emojiConfig);
      }
      if (pct >= 10) {
        return getUIText(`Almost there! Just ${formatted} more 🚀`, emojiConfig);
      }
      return getUIText(`So close 🔥 Only ${formatted} left!`, emojiConfig);
    }
    return '';
  })();

  $: savingsMsg = (subtotalAtOrAboveThreshold || shipping.unlocked) && !shipping.loading
    ? `You saved ${formatCurrency(FREE_SHIPPING_SAVINGS_CENTS)}`
    : '';
  $: showSavings = !!savingsMsg;

  /** V2: add cp-msg-visible after text is set. Only fade-in on first appearance; stay visible on updates. */
  $: if (shippingMsg && !shipping.loading) {
    if (!msgVisible) {
      const raf = typeof requestAnimationFrame !== 'undefined' ? requestAnimationFrame : (f) => setTimeout(f, 0);
      raf(() => { msgVisible = true; });
    }
  } else if (!shippingMsg) {
    msgVisible = false;
  }

  function formatCurrency(cents) {
    if (cents == null) return '0.00';
    try {
      return new Intl.NumberFormat(undefined, { style: 'currency', currency: displayCurrency }).format((Number(cents) / 100));
    } catch (_) {
      return (Number(cents) / 100).toFixed(2);
    }
  }
</script>

<!-- Footer only: message + savings (tiered bar is at top via Milestones.svelte). -->
<div class="cp-shipping-container" id="cart-pro-shipping-container">
  <div id="cart-pro-shipping-skeleton" class="cp-shipping-skeleton" aria-hidden={shipping.loading ? 'false' : 'true'}>
    <div class="cp-skeleton cp-skeleton-bar"></div>
    <div class="cp-skeleton cp-skeleton-text"></div>
  </div>
  <div class="cp-shipping-content" id="cart-pro-shipping-content" style="display: {shipping.loading ? 'none' : ''};" class:cp-fade-in={!shipping.loading}>
    <div id="cart-pro-shipping-msg" class="cp-free-shipping-msg" class:cp-msg-visible={msgVisible} style="display: {!shipping.loading && shippingMsg ? 'block' : 'none'};">
      {#if shippingMsg}
        {shippingMsg}
      {/if}
    </div>
    <div id="cart-pro-savings" class="cp-savings-msg" style="display: {showSavings ? 'block' : 'none'};">
      {#if showSavings}
        {savingsMsg}
      {/if}
    </div>
  </div>
</div>
