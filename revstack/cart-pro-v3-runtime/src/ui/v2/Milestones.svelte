<script>
  /** @type { { thresholdCents: number; label: string }[] } */
  export let tiers = [];
  /** @type { number | null } */
  export let unlockedTierIndex = null;
  /** @type { number } */
  export let subtotalCents = 0;
  /** @type { string } */
  export let currency = 'USD';

  function formatMoney(cents) {
    if (cents == null) return '0.00';
    try {
      return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format((Number(cents) / 100));
    } catch (_) {
      return (Number(cents) / 100).toFixed(2);
    }
  }

  $: milestones = tiers ?? [];
  $: hasMilestones = milestones.length > 0;
  $: lastAmount = hasMilestones ? milestones[milestones.length - 1].thresholdCents : 1;
  $: progressPercent = lastAmount > 0 ? Math.min(100, (subtotalCents / lastAmount) * 100) : 0;
  $: fillPct = Math.max(0, progressPercent);

  $: nextIndex = (() => {
    for (let i = 0; i < milestones.length; i++) {
      if (subtotalCents < milestones[i].thresholdCents) return i;
    }
    return milestones.length;
  })();
  $: nextMilestone = milestones[nextIndex];
  $: needMore = nextMilestone ? nextMilestone.thresholdCents - subtotalCents : 0;
  $: allUnlocked = hasMilestones && subtotalCents >= lastAmount;
  $: messageText = allUnlocked ? '🎉 Reward unlocked!' : (nextMilestone ? `🚚 Spend ${formatMoney(needMore)} more to unlock ${nextMilestone.label}` : '🎉 Reward unlocked!');

  const milestoneEmojis = ['🏷', '🎁', '✨'];
</script>

<div id="cart-pro-milestones" class="cp-milestones-container">
  <div class="cp-milestones-inner" class:cp-milestones-empty={!hasMilestones}>
    {#if hasMilestones}
      <div class="cp-milestone-wrapper cp-fade-in">
        <div class="cp-milestone-header">Unlock Rewards</div>
        <div class="cp-milestone-track" style="--cp-fill-pct: {fillPct}%;">
          <div class="cp-milestone-fill"></div>
          <div class="cp-milestone-points">
            {#each milestones as m, i}
              <div class="cp-milestone-point" data-index={i} style="left: {(m.thresholdCents / lastAmount) * 100}%;">
                <span class="cp-milestone-emoji" aria-hidden="true">{milestoneEmojis[i] ?? '🎁'}</span>
              </div>
            {/each}
          </div>
        </div>
        <div class="cp-milestone-message">{messageText}</div>
      </div>
    {/if}
  </div>
</div>
