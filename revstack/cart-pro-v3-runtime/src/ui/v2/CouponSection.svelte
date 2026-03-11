<script>
  /** @type { import('../../engine/Engine').default } */
  export let engine;
  /** @type { { code: string; amount: number; type: string }[] } */
  export let applied = [];
  /** @type { boolean } */
  export let validating = false;
  /** @type { string | null } */
  export let lastError = null;
  /** Optional: called when coupon input is focused (e.g. to scroll footer into view on mobile). */
  export let onCouponInputFocus = () => {};

  let discountInput = '';
  // V2 lever: tease from config only; no unrelated runtime flags.
  $: teaseMessage = engine?.getConfig?.()?.discounts?.teaseMessage;
  $: showTeaseMessage = engine?.getConfig?.()?.discounts?.showTeaseMessage !== false;

  function handleInputFocus() {
    onCouponInputFocus();
  }

  function onApply() {
    const code = discountInput.trim();
    if (!code || validating) return;
    engine.applyDiscount(code);
    discountInput = '';
  }

  function onRemove(code) {
    engine.removeDiscount(code);
  }
</script>

<div class="cp-coupon-section" id="cp-coupon-section" class:cp-loading={validating} class:cp-success={applied.length > 0 && !lastError} class:cp-error={!!lastError}>
  <input type="text" id="cp-coupon-input" placeholder="Discount code" bind:value={discountInput} on:focus={handleInputFocus} on:keydown={(e) => e.key === 'Enter' && onApply()} disabled={validating} />
  <button type="button" id="cp-coupon-apply" on:click={onApply} disabled={validating || !discountInput.trim()}>
    {validating ? 'Checking…' : 'Apply'}
  </button>
  <div id="cp-coupon-message" aria-live="polite" role="status">
    {#if lastError}
      {lastError}
    {:else if applied.length > 0}
      Applied
    {/if}
  </div>
  <div id="cp-coupon-remove-wrap" class="cp-coupon-remove-wrap" style="display: {applied.length > 0 ? 'block' : 'none'};">
    {#each applied as d (d.code)}
      <button type="button" class="cp-coupon-remove" on:click={() => onRemove(d.code)}>Remove {d.code}</button>
    {/each}
  </div>
</div>
<div id="cart-pro-coupon-banner" class="cp-coupon-banner" class:cp-coupon-banner-visible={!!(showTeaseMessage && teaseMessage && applied.length === 0)} aria-hidden="true">{showTeaseMessage && teaseMessage && applied.length === 0 ? teaseMessage : ''}</div>
