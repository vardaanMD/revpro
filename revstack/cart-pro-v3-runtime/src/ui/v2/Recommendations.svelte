<script>
  import { fade } from 'svelte/transition';
  import RecommendationCard from './RecommendationCard.svelte';

  /** @type { import('../../engine/Engine').default } */
  export let engine;

  const stateStore = engine.stateStore;
  $: state = $stateStore;
  $: hasSnapshot =
    Array.isArray(state?.snapshotRecommendations) &&
    state.snapshotRecommendations.length > 0;

  $: primaryRecommendations = hasSnapshot
    ? state.snapshotRecommendations
    : (state?.upsell?.standard ?? []);

  $: aiRecommendations = state?.upsell?.aiRecommendations ?? [];
  $: loading = state?.upsell?.loading ?? false;
  $: currency = state?.cart?.raw?.currency ?? 'USD';

  $: recs = hasSnapshot
    ? primaryRecommendations
    : [
        ...primaryRecommendations,
        ...aiRecommendations.map((r) => ({
          variantId: r.variantId,
          title: r.title ?? `Variant #${r.variantId}`,
          imageUrl: r.imageUrl ?? null,
          handle: r.handle ?? '',
          price: r.price ?? { amount: 0 },
        })),
      ];
  $: hasRecs = recs.length > 0;

  /** When list changes (bucket swap or decision refinement), key block triggers fade. 150ms matches .cp-fade-in. */
  $: listVersion = state?.recommendationListVersion ?? 0;

  $: console.log('[CartPro] Recommendations state:', hasSnapshot ? 'snapshot' : state?.upsell?.standard);
</script>

<div id="cart-pro-recommendations" class="cp-recommendations-container">
  <div class="cp-recommendations-inner" class:cp-recommendations-loading={loading}>
    {#if loading && !hasRecs}
      <div class="cp-recommendations-content cp-fade-in cp-rec-container-shimmer"></div>
    {:else if hasRecs}
      {#key listVersion}
        <div class="cp-recommendations-content cp-rec-container-shimmer" in:fade={{ duration: 150 }} out:fade={{ duration: 120 }}>
          <h4 style="margin-bottom:10px;">You may also like</h4>
          <div class="cp-rec-list cp-carousel">
            {#each recs as rec (rec.variantId)}
              <RecommendationCard {engine} rec={rec} isPredicted={false} {currency} />
            {/each}
          </div>
        </div>
      {/key}
    {:else}
      <div class="cp-recommendations-content cp-fade-in"></div>
    {/if}
  </div>
</div>
