/**
 * Cart Pro V3 — pure reward tier computation.
 * No side effects; used by Engine after syncCart.
 */

export interface RewardTier {
  thresholdCents: number;
  label: string;
  rewardType?: 'discount' | 'gift' | 'freeShipping';
  discountCode?: string;
  variantId?: string;
}

/**
 * Returns the highest unlocked tier index (0-based), or null if none.
 * A tier is unlocked when subtotalCents >= tier.thresholdCents.
 * Tiers are assumed to be ordered by thresholdCents ascending.
 */
export function computeUnlockedTier(
  subtotalCents: number,
  tiers: RewardTier[]
): number | null {
  if (!Array.isArray(tiers) || tiers.length === 0) return null;
  let highest: number | null = null;
  for (let i = 0; i < tiers.length; i++) {
    const t = tiers[i];
    if (t != null && typeof t.thresholdCents === 'number' && subtotalCents >= t.thresholdCents) {
      highest = i;
    }
  }
  return highest;
}
