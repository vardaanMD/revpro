<script>
  import CartItem from './CartItem.svelte';

  /** @type { import('../../engine/Engine').default } */
  export let engine;
  /** @type { any[] } */
  export let items = [];
  /** @type { string } */
  export let currency = 'USD';
  /** @type { () => void } */
  export let onClose = () => {};

  $: isEmpty = !items || items.length === 0;
</script>

<div id="cart-pro-items" class="cp-items-container" class:cp-items-empty={isEmpty}>
  <div id="cart-pro-items-inner" class="cp-items-inner">
    {#if isEmpty}
      <div class="cp-empty-state">
        <div class="cp-empty-state-icon" aria-hidden="true"></div>
        <p class="cp-empty-state-message">Your cart is empty.</p>
        <button type="button" class="cp-empty-state-cta" aria-label="Continue shopping" on:click={onClose}>Continue shopping</button>
      </div>
    {:else}
      {#each items as item, index (item.key)}
        <CartItem {engine} {item} {index} {currency} />
      {/each}
    {/if}
  </div>
</div>
