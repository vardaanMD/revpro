<script>
  import { getUIText } from '../../lib/uiText';

  /** Multi-tier rewards bar (free shipping + reward tiers). V2-style: one emoji per tier on the track. */
  /** @type { import('../../engine/Engine').default | undefined } */
  export let engine;
  /** @type { string } */
  export let currency = 'USD';

  const stateStore = engine?.stateStore;
  const config = engine?.getConfig?.();

  $: freeShippingThreshold = config?.freeShipping?.thresholdCents;
  $: rewardsTiers = config?.rewards?.tiers ?? [];
  $: shipping = $stateStore?.shipping ?? { remaining: null, unlocked: false, loading: true };
  $: subtotalCents = $stateStore?.cart?.subtotal ?? 0;
  $: displayCurrency = $stateStore?.cart?.raw?.currency ?? currency;
  $: appearance = config?.appearance ?? {};
  $: emojiConfig = { emojiMode: appearance.emojiMode !== false };

  /** Build combined milestones: free shipping (🚚) + reward tiers (🏷 🎁 ✨). Sorted by threshold. */
  $: combinedMilestones = (() => {
    const list = [];
    if (typeof freeShippingThreshold === 'number' && freeShippingThreshold > 0) {
      list.push({ thresholdCents: freeShippingThreshold, label: 'Free Shipping', emoji: '🚚' });
    }
    const tiers = Array.isArray(rewardsTiers) ? rewardsTiers : [];
    tiers.forEach((t, i) => {
      if (t && typeof t.thresholdCents === 'number' && t.thresholdCents >= 0) {
        const emojis = ['🏷', '🎁', '✨'];
        list.push({
          thresholdCents: t.thresholdCents,
          label: typeof t.label === 'string' ? t.label : `Reward ${i + 1}`,
          emoji: emojis[i] ?? '🎁',
        });
      }
    });
    list.sort((a, b) => a.thresholdCents - b.thresholdCents);
    return list;
  })();

  /** Fixed positions for up to 3 tiers so all emojis are visible: 33%, 66%, 100%. */
  const TIER_POSITIONS = [100 / 3, (2 * 100) / 3, 100];
  $: displayPoints = (() => {
    const points = [];
    const n = Math.min(combinedMilestones.length, 3);
    for (let i = 0; i < n; i++) {
      const m = combinedMilestones[i];
      points.push({
        leftPct: TIER_POSITIONS[i],
        thresholdCents: m.thresholdCents,
        label: m.label,
        emoji: m.emoji,
      });
    }
    return points;
  })();

  $: lastThreshold = combinedMilestones.length > 0 ? combinedMilestones[combinedMilestones.length - 1].thresholdCents : 0;
  /** Bar fill grows with cart value (smooth progress). Fill is a separate layer behind the points so it never washes the emojis. */
  $: fillPct = lastThreshold > 0 ? Math.min(100, (subtotalCents / lastThreshold) * 100) : 0;
  $: hasMilestones = combinedMilestones.length > 0 && !shipping?.loading;

  $: messageText = (() => {
    if (shipping?.loading || combinedMilestones.length === 0) return '';
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
      <div class="cp-milestone-wrapper cp-fade-in">
        <div class="cp-milestone-header">{combinedMilestones.length > 1 ? 'Unlock Rewards' : 'Free Shipping'}</div>
        <div class="cp-milestone-track" style="--cp-fill-pct: {fillPct}%;">
          <div class="cp-milestone-fill"></div>
          <div class="cp-milestone-points">
            {#each displayPoints as pt}
              {@const unlocked = subtotalCents >= pt.thresholdCents || (pt.emoji === '🚚' && !!shipping?.unlocked)}
              <div class="cp-milestone-point" class:cp-milestone-unlocked={unlocked} style="left: {pt.leftPct}%;">
                <span class="cp-milestone-emoji" aria-hidden="true">{pt.emoji}</span>
              </div>
            {/each}
          </div>
        </div>
        <div class="cp-milestone-message">{messageText}</div>
      </div>
    {/if}
  </div>
</div>
