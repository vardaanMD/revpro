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
  /** Positions from thresholds; nudge duplicates so multiple emojis don't stack on top of each other. */
  $: displayPoints = (() => {
    const points = [];
    const n = Math.min(combinedMilestones.length, 3);
    for (let i = 0; i < n; i++) {
      const m = combinedMilestones[i];
      let leftPct = lastThreshold > 0 ? (m.thresholdCents / lastThreshold) * 100 : (100 / 3) * (i + 1);
      leftPct = Math.max(0, Math.min(100, leftPct));
      points.push({
        leftPct,
        thresholdCents: m.thresholdCents,
        label: m.label,
        emoji: m.emoji,
      });
    }
    // If two points are within 3% (overlapping), spread them so both emojis are visible.
    const MIN_SEP = 3;
    const NUDGE = 6;
    for (let i = 1; i < points.length; i++) {
      const prev = points[i - 1].leftPct;
      const curr = points[i].leftPct;
      if (curr - prev < MIN_SEP) {
        const mid = (prev + curr) / 2;
        points[i - 1].leftPct = Math.max(0, mid - NUDGE);
        points[i].leftPct = Math.min(100, mid + NUDGE);
      }
    }
    return points;
  })();

  /** Bar fill grows with cart value. Segmented so colour stops before each emoji and resumes after (no washing). */
  $: fillPct = lastThreshold > 0 ? Math.min(100, (subtotalCents / lastThreshold) * 100) : 0;

  /** Gap each side of an emoji (percent of bar) so the colour bar breaks and emoji sits on neutral track. */
  const EMOJI_GAP_PCT = 4;
  $: fillSegments = (() => {
    if (displayPoints.length === 0) return [];
    const segments = [];
    const positions = displayPoints.map((p) => p.leftPct);
    for (let i = 0; i < positions.length; i++) {
      const segmentStart = i === 0 ? 0 : positions[i - 1] + EMOJI_GAP_PCT;
      const segmentEnd = i === positions.length - 1 ? 100 : positions[i] - EMOJI_GAP_PCT;
      if (segmentEnd <= segmentStart) continue;
      const fillEnd = Math.min(segmentEnd, Math.max(segmentStart, fillPct));
      const widthPct = Math.max(0, fillEnd - segmentStart);
      if (widthPct > 0) {
        segments.push({ leftPct: segmentStart, widthPct });
      }
    }
    return segments;
  })();
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
        <div class="cp-milestone-track">
          <div class="cp-milestone-fills" aria-hidden="true">
            {#each fillSegments as seg}
              <div class="cp-milestone-fill-segment" style="left: {seg.leftPct}%; width: {seg.widthPct}%;"></div>
            {/each}
          </div>
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
