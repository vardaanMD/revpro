<script>
  import { onMount } from 'svelte';
  import DrawerV2 from './v2/DrawerV2.svelte';

  export let engine;
  const stateStore = engine.stateStore;

  onMount(() => {
    engine.enqueueEffect(async () => {
      await engine.syncCart();
    });
  });

  function openDrawer() {
    engine.setState({ ui: { drawerOpen: true } });
    engine.onDrawerOpened?.();
  }

  function closeDrawer() {
    engine.setState({ ui: { drawerOpen: false } });
  }
</script>

<button type="button" on:click={openDrawer}>Open V3 Drawer</button>
<DrawerV2 {engine} on:close={closeDrawer} />
