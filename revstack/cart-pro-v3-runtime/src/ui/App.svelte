<script>
  import { onMount } from 'svelte';
  import DrawerV2 from './v2/DrawerV2.svelte';

  export let engine;
  const stateStore = engine.stateStore;

  /** True once first syncCart completes and all state slices are populated (cart, shipping, rewards). */
  $: contentReady = !!$stateStore?.initialSyncDone;
  /** When false, hide the sticky cart button (e.g. when theme cart icon is the only trigger). */
  $: showStickyCartButton = engine?.getConfig?.()?.appearance?.showStickyCartButton !== false;
  $: itemCount = $stateStore?.cart?.itemCount ?? 0;

  onMount(() => {
    if ($stateStore?.cart?.raw != null) return;
    engine.enqueueEffect(async () => {
      await engine.syncCart();
    });
  });

  function openDrawer() {
    // Defer to next frame so click handler returns immediately; avoids main-thread hang from sync store update + full re-render.
    const run = () => {
      engine.setState({ ui: { drawerOpen: true } });
      engine.onDrawerOpened?.();
    };
    if (typeof requestAnimationFrame !== 'undefined') {
      requestAnimationFrame(run);
    } else {
      setTimeout(run, 0);
    }
  }

  function closeDrawer() {
    engine.setState({ ui: { drawerOpen: false } });
  }
</script>

{#if contentReady && showStickyCartButton}
  <div class="cart-pro-sticky-wrap">
    <button type="button" class="cart-pro-open-trigger cart-pro-sticky-btn" on:click={openDrawer} aria-label="Open cart">
      <span class="cart-pro-sticky-icon" aria-hidden="true">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path class="cart-basket" stroke-linecap="butt" stroke-linejoin="miter" d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/>
          <circle cx="9" cy="21" r="1"/>
          <circle cx="20" cy="21" r="1"/>
        </svg>
      </span>
      {#if itemCount > 0}
        <span class="cart-pro-sticky-badge">{itemCount > 99 ? '99+' : itemCount}</span>
      {/if}
    </button>
  </div>
{/if}
<DrawerV2 {engine} {contentReady} on:close={closeDrawer} />

<style>
  .cart-pro-sticky-wrap {
    position: fixed;
    bottom: max(1.25rem, env(safe-area-inset-bottom, 0px));
    right: max(1.25rem, env(safe-area-inset-right, 0px));
    z-index: 9999;
    pointer-events: none;
  }

  .cart-pro-sticky-btn {
    pointer-events: auto;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 4rem;
    height: 4rem;
    border-radius: 50%;
    border: none;
    background: var(--cp-primary, #333);
    color: #fff;
    cursor: pointer;
    box-shadow: 0 4px 14px rgba(0, 0, 0, 0.2);
    transition: transform 0.2s ease, box-shadow 0.2s ease;
  }

  .cart-pro-sticky-btn:hover {
    transform: scale(1.05);
    box-shadow: 0 6px 20px rgba(0, 0, 0, 0.25);
  }

  .cart-pro-sticky-btn:active {
    transform: scale(0.98);
  }

  .cart-pro-sticky-icon {
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .cart-pro-sticky-icon :global(svg) {
    width: 28px;
    height: 28px;
  }

  .cart-pro-sticky-badge {
    position: absolute;
    top: -4px;
    right: -4px;
    min-width: 1.25rem;
    height: 1.25rem;
    padding: 0 4px;
    font-size: 0.7rem;
    font-weight: 600;
    line-height: 1.25rem;
    text-align: center;
    color: var(--cp-primary, #333);
    background: var(--cp-accent, #16a34a);
    border-radius: 999px;
    list-style: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }

  .cart-pro-sticky-badge::before,
  .cart-pro-sticky-badge::after {
    display: none !important;
    content: none !important;
  }
</style>
