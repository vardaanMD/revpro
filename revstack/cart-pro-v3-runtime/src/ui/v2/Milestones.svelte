<script>
  import { writable } from 'svelte/store';
  import { getUIText } from '../../lib/uiText';

  /** Multi-tier rewards bar (free shipping + reward tiers). V2-style: one emoji per tier on the track. */
  /** @type { import('../../engine/Engine').default | undefined } */
  export let engine;
  /** @type { string } */
  export let currency = 'USD';

  const _defaultState = {
    shipping: { remaining: null, unlocked: false, loading: true },
    cart: { subtotal: 0, raw: null },
  };
  const defaultStore = writable(_defaultState);
  $: stateStore = engine?.stateStore && typeof engine.stateStore.subscribe === 'function' ? engine.stateStore : defaultStore;
  const config = engine?.getConfig?.();

  $: freeShippingThreshold = config?.freeShipping?.thresholdCents;
  $: rewardsTiers = config?.rewards?.tiers ?? [];
  $: shipping = $stateStore?.shipping ?? { remaining: null, unlocked: false, loading: true };
  $: subtotalCents = $stateStore?.cart?.subtotal ?? 0;
  $: displayCurrency = $stateStore?.cart?.raw?.currency ?? currency;
  $: appearance = config?.appearance ?? {};
  $: emojiConfig = { emojiMode: appearance.emojiMode !== false };

  /** Build combined milestones: free shipping (🚚) + reward tiers (🏷 🎁 ✨). Sorted by threshold. */
  /** Engine config.rewards.tiers have thresholdCents (normalized from snapshot amount or thresholdCents). */
  $: combinedMilestones = (() => {
    const list = [];
    if (typeof freeShippingThreshold === 'number' && freeShippingThreshold > 0) {
      list.push({ thresholdCents: freeShippingThreshold, label: 'Free Shipping', emoji: '🚚' });
    }
    const tiers = Array.isArray(rewardsTiers) ? rewardsTiers : [];
    tiers.forEach((t, i) => {
      const th = t && typeof t === 'object' ? (t.thresholdCents ?? t.amount) : null;
      if (typeof th === 'number' && th >= 0) {
        const emojis = ['🏷', '🎁', '✨'];
        list.push({
          thresholdCents: th,
          label: typeof t.label === 'string' ? t.label : `Reward ${i + 1}`,
          emoji: emojis[i] ?? '🎁',
        });
      }
    });
    list.sort((a, b) => a.thresholdCents - b.thresholdCents);
    return list;
  })();

  $: lastThreshold = combinedMilestones.length > 0 ? combinedMilestones[combinedMilestones.length - 1].thresholdCents : 0;
  /** Up to 3 milestone points shown; flexbox (space-between) spaces them so all emojis stay visible. */
  $: displayPoints = (() => {
    const n = Math.min(combinedMilestones.length, 3);
    return combinedMilestones.slice(0, n).map((m) => ({
      thresholdCents: m.thresholdCents,
      label: m.label,
      emoji: m.emoji,
    }));
  })();

  /** Single fill width (like cart.txt): bar grows with cart value; icons sit above the rail so no wash. */
  $: fillPct = lastThreshold > 0 ? Math.min(100, (subtotalCents / lastThreshold) * 100) : 0;
  $: hasMilestones = combinedMilestones.length > 0;

  $: messageText = (() => {
    if (combinedMilestones.length === 0) return '';
    const next = combinedMilestones.find((m) => subtotalCents < m.thresholdCents);
    if (!next) return getUIText('🎉 All rewards unlocked!', emojiConfig);
    const remaining = next.thresholdCents - subtotalCents;
    const formatted = formatCurrency(remaining);
    if (next.emoji === '🚚') {
      if (remaining <= 0) return getUIText('🎉 FREE Shipping Unlocked!', emojiConfig);
      const pct = (remaining / next.thresholdCents) * 100;
      if (pct > 50) return getUIText("You're close. Add a little more to unlock FREE shipping.", emojiConfig);
      if (pct >= 10) return getUIText(`Almost there! Just ${formatted} more 🚀`, emojiConfig);
      return getUIText(`So close 🔥 Only ${formatted} left!`, emojiConfig);
    }
    return getUIText(`Spend ${formatted} more to unlock ${next.label}`, emojiConfig);
  })();

  function formatCurrency(cents) {
    if (cents == null) return '0.00';
    try {
      return new Intl.NumberFormat(undefined, { style: 'currency', currency: displayCurrency }).format((Number(cents) / 100));
    } catch (_) {
      return (Number(cents) / 100).toFixed(2);
    }
  }
</script>

<div id="cart-pro-milestones" class="cp-milestones-container">
  <div class="cp-milestones-inner" class:cp-milestones-empty={!hasMilestones}>
    {#if hasMilestones}
      <div class="cp-milestone-wrapper">
        <div class="cp-milestone-header">{combinedMilestones.length > 1 ? 'Unlock Rewards' : 'Free Shipping'}</div>
        <!-- Rail + fill centered vertically; emoji icons sit on the bar in a separate overlay layer. -->
        <div class="cp-milestone-bar-container">
          <div class="cp-milestone-track-wrap">
            <div class="cp-milestone-rail" aria-hidden="true">
              <div
                class="cp-milestone-fill"
                style="width: {fillPct}%;"
                aria-hidden="true"
              ></div>
            </div>
          </div>
          <div class="cp-milestone-steps-overlay">
            {#each displayPoints as pt (pt.thresholdCents)}
              {@const unlocked = subtotalCents >= pt.thresholdCents || (pt.emoji === '🚚' && !!shipping?.unlocked)}
              <div class="cp-milestone-step">
                <div
                  class="cp-milestone-icon-wrap"
                  class:cp-milestone-unlocked={unlocked}
                >
                  <span class="cp-milestone-emoji" aria-hidden="true">{pt.emoji}</span>
                </div>
              </div>
            {/each}
          </div>
        </div>
        <div class="cp-milestone-message">{messageText}</div>
      </div>
    {/if}
  </div>
</div>
