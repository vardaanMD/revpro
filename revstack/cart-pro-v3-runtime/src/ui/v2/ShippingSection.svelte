<script>
  /** @type { import('../../engine/Engine').default } */
  export let engine;
  /** @type { string } */
  export let currency = 'USD';

  const stateStore = engine?.stateStore;

  // V2 lever: visibility from config only; no runtime loading state to hide bar.
  $: threshold = engine?.getConfig?.()?.freeShipping?.thresholdCents;
  $: shipping = $stateStore?.shipping ?? { remaining: null, unlocked: false, loading: true };
  $: subtotalCents = $stateStore?.cart?.subtotal ?? 0;
  $: displayCurrency = $stateStore?.cart?.raw?.currency ?? currency;

  // When threshold exists: show remaining or unlocked from config + cart (state provides computed values).
  $: showBar = threshold != null;
  $: subtotalAtOrAboveThreshold = threshold != null && subtotalCents >= threshold;
  $: remainingCents = shipping.remaining;

  function formatCurrency(cents) {
    if (cents == null) return '0.00';
    try {
      return new Intl.NumberFormat(undefined, { style: 'currency', currency: displayCurrency }).format((Number(cents) / 100));
    } catch (_) {
      return (Number(cents) / 100).toFixed(2);
    }
  }
</script>

<!-- Shipping container DOM always exists when drawer mounts; visibility only. -->
<div class="cp-shipping-container" id="cart-pro-shipping-container" style="display: {showBar ? '' : 'none'};">
  <div class="cp-shipping-content" id="cart-pro-shipping-content">
    {#if shipping.loading}
      <div id="cart-pro-shipping-skeleton" class="cp-shipping-skeleton">
        <div class="cp-skeleton cp-skeleton-bar"></div>
        <div class="cp-skeleton cp-skeleton-text"></div>
      </div>
    {/if}
    <div id="cart-pro-shipping-msg" class="cp-free-shipping-msg cp-msg-visible" style="display: {shipping.loading ? 'none' : ''};">
      {#if subtotalAtOrAboveThreshold || shipping.unlocked}
        Free shipping unlocked
      {:else if remainingCents != null && remainingCents > 0}
        Add {formatCurrency(remainingCents)} more for free shipping
      {/if}
    </div>
    <div id="cart-pro-savings" class="cp-savings-msg"></div>
  </div>
</div>
