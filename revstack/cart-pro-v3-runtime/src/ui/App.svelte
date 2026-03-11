<script>
  import { onMount } from 'svelte';
  import DrawerV2 from './v2/DrawerV2.svelte';

  export let engine;
  const stateStore = engine.stateStore;

  /** True once first syncCart completes and all state slices are populated (cart, shipping, rewards). */
  $: contentReady = !!$stateStore?.initialSyncDone;

  onMount(() => {
    if ($stateStore?.cart?.raw != null) return;
    engine.enqueueEffect(async () => {
      await engine.syncCart();
    });
  });

  function openDrawer() {
    // Defer open so click handler returns immediately; avoids main-thread hang from sync store update + full re-render.
    setTimeout(() => {
      engine.setState({ ui: { drawerOpen: true } });
      engine.onDrawerOpened?.();
    }, 0);
  }

  function closeDrawer() {
    engine.setState({ ui: { drawerOpen: false } });
  }
</script>

{#if contentReady}
  <button type="button" class="cart-pro-open-trigger" on:click={openDrawer}>Open V3 Drawer</button>
{/if}
<DrawerV2 {engine} {contentReady} on:close={closeDrawer} />

<style>
  /* When host has pointer-events: none, only this trigger is clickable so drawer can open */
  .cart-pro-open-trigger {
    pointer-events: auto;
  }
</style>
