<script>
  import RecommendationCard from './RecommendationCard.svelte';

  /** @type { import('../../engine/Engine').default } */
  export let engine;

  const stateStore = engine.stateStore;
  $: state = $stateStore;
  // Phase 4: single source of truth — always derive from snapshot; no hasSnapshot flip to standard/AI
  $: recs = state?.snapshotRecommendations ?? [];
  $: hasRecs = recs.length > 0;
  $: loading = state?.upsell?.loading ?? false;
  $: currency = state?.cart?.raw?.currency ?? 'USD';

  // Phase 6: shimmer only when transitioning from no recs to has recs (not on every list change)
  let justLoaded = false;
  let prevRecsLength = 0;
  $: {
    if (recs.length > 0 && prevRecsLength === 0) {
      justLoaded = true;
      setTimeout(() => {
        justLoaded = false;
      }, 200);
    }
    prevRecsLength = recs.length;
  }
  $: showShimmer = (loading && !hasRecs) || justLoaded;
</script>

<div id="cart-pro-recommendations" class="cp-recommendations-container">
  <div class="cp-recommendations-inner" class:cp-recommendations-loading={loading}>
    {#if loading && !hasRecs}
      <div class="cp-recommendations-content cp-rec-container-shimmer"></div>
    {:else if hasRecs}
      <div class="cp-recommendations-content" class:cp-rec-container-shimmer={showShimmer}>
        <h4 style="margin-bottom:10px;">You may also like</h4>
        <div class="cp-rec-list cp-carousel">
          {#each recs as rec (rec.variantId)}
            <RecommendationCard {engine} rec={rec} isPredicted={false} {currency} />
          {/each}
        </div>
      </div>
    {:else}
      <div class="cp-recommendations-content"></div>
    {/if}
  </div>
</div>
