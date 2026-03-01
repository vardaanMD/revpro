<script>
  import ShippingSection from './ShippingSection.svelte';

  /** @type { import('../../engine/Engine').default } */
  export let engine;
  /** @type { number } */
  export let subtotalCents = 0;
  /** @type { number } */
  export let totalDiscountCents = 0;
  /** @type { string } */
  export let currency = 'USD';
  /** @type { boolean } */
  export let checkoutEnabled = false;
  /** @type { string } */
  export let checkoutUrl = '';
  /** @type { boolean } */
  export let syncing = false;
  /** @type { boolean } */
  export let countdownVisible = true;
  /** @type { boolean } */
  export let shippingLoading = false;
  /** @type { string } */
  export let freeShippingMsg = '';
  /** @type { string } */
  export let savingsMsg = '';

  $: countdownStore = engine?.countdown?.store;
  $: countdownState = countdownStore ? $countdownStore : { remainingMs: 0, running: false };
  // V2 lever: visibility from config only; no runtime flags (countdownVisible, running).
  $: countdownEnabled = engine?.getConfig?.()?.appearance?.countdownEnabled === true;
  $: showCountdown = countdownEnabled && countdownState.remainingMs > 0;

  function formatMoney(cents) {
    if (cents == null) return '0.00';
    try {
      return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format((Number(cents) / 100));
    } catch (_) {
      return (Number(cents) / 100).toFixed(2);
    }
  }

  /** Format remainingMs as MM:SS (V2-style). */
  function formatCountdown(remainingMs) {
    if (remainingMs == null || remainingMs <= 0) return '00:00';
    const totalSeconds = Math.floor(remainingMs / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }

  function onCheckout() {
    engine.openCheckout();
  }
</script>

<div id="cart-pro-subtotal" data-subtotal-cents={subtotalCents}>
  <div style="display:flex;justify-content:space-between;font-weight:600;margin-bottom:14px;">
    <span>Subtotal</span>
    <span class="cart-pro-subtotal-value">{formatMoney(subtotalCents)}</span>
  </div>
  {#if totalDiscountCents > 0}
    <div class="cp-discount-line">
      <span>Discount</span>
      <span class="cp-discount-amount">-{formatMoney(totalDiscountCents)}</span>
    </div>
  {/if}
</div>
<ShippingSection {engine} {currency} />
<div class="cp-checkout-container">
  <button id="cart-pro-checkout" class="cp-checkout-btn" type="button" disabled={!checkoutEnabled || syncing} on:click={onCheckout}>Checkout →</button>
  <div id="cart-pro-countdown" class="cp-countdown" class:cp-countdown-urgent={showCountdown && countdownState.remainingMs < 60000} style="display: {showCountdown ? '' : 'none'};">
    {#if showCountdown}
      {formatCountdown(countdownState.remainingMs)}
    {/if}
  </div>
</div>
