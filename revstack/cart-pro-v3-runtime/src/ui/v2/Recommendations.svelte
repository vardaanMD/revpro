<script>
  import { fade } from 'svelte/transition';
  import RecommendationCard from './RecommendationCard.svelte';

  /** @type { import('../../engine/Engine').default } */
  export let engine;

  const stateStore = engine.stateStore;
  $: state = $stateStore;
  // Phase 4: single source of truth — always derive from snapshot; no hasSnapshot flip to standard/AI
  $: recs = state?.snapshotRecommendations ?? [];
  $: hasRecs = recs.length > 0;
  $: loading = state?.upsell?.loading ?? false;
  $: snapshotCurrency = engine?.getConfig?.()?.currency;
  $: currency = state?.cart?.raw?.currency ?? snapshotCurrency ?? 'USD';
  // Phase 7: list version drives key block so list transition runs when engine replaces the list
  $: listVersion = state?.recommendationListVersion ?? 0;
  // Phase 8: when cart has items and we're waiting for first decision, show skeleton instead of default bucket
  $: decisionPending = state?.recommendationsDecisionPending ?? false;
  $: cartHasItems = (state?.cart?.itemCount ?? 0) > 0;
  $: showDecisionSkeleton = cartHasItems && decisionPending;

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
  $: recommendationsHeading = engine?.getConfig?.()?.upsell?.recommendationsHeading ?? 'You may also like';
</script>

<div id="cart-pro-recommendations" class="cp-recommendations-container">
  <div class="cp-recommendations-inner" class:cp-recommendations-loading={loading}>
    {#if (loading && !hasRecs) || showDecisionSkeleton}
      <div class="cp-recommendations-content cp-rec-container-shimmer"></div>
    {:else if hasRecs}
      {#key listVersion}
        <div class="cp-recommendations-content" class:cp-rec-container-shimmer={showShimmer} in:fade={{ duration: 150 }} out:fade={{ duration: 150 }}>
          <h4 class="cp-recommendations-heading">{recommendationsHeading}</h4>
          <div class="cp-rec-list cp-carousel">
            {#each recs as rec (rec.variantId)}
              <RecommendationCard {engine} rec={rec} isPredicted={false} {currency} />
            {/each}
          </div>
        </div>
      {/key}
    {:else}
      <div class="cp-recommendations-content"></div>
    {/if}
  </div>
</div>
