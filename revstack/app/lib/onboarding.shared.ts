/**
 * Shared onboarding constants and types. Pure data only—no DB, env, or server logic.
 * Safe to import from route components (client bundle).
 */

/** Block reason keys for UI. Maps to first incomplete step. */
export type OnboardingBlockReason =
  | "activate_extension"
  | "confirm_live"
  | "set_threshold"
  | "choose_strategy"
  | "preview_cross_sell"
  | null;

/** Human-readable labels for block reasons. */
export const ONBOARDING_BLOCK_LABELS: Record<NonNullable<OnboardingBlockReason>, string> = {
  activate_extension: "Enable the Cart Pro V3 app embed in Theme Editor (App embeds)",
  confirm_live: "Verify cart is live with at least one request",
  set_threshold: "Set your free shipping threshold in Settings",
  choose_strategy: "Choose a recommendation strategy in Settings",
  preview_cross_sell: "Preview the cross-sell experience",
};
