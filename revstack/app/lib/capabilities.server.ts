export type Plan = "basic" | "advanced" | "growth";

/**
 * Derives plan from stored config value. Use getBillingContext(shop) for
 * entitlement and capabilities; this is for legacy/internal use only.
 */
export function getEffectivePlan(configPlan: string | null | undefined): Plan {
  if (configPlan === "advanced" || configPlan === "growth") return configPlan;
  return "basic";
}

/** Single source of truth for max cross-sell recommendations per plan. */
export const MAX_CROSS_SELL_BY_PLAN: Record<Plan, number> = {
  basic: 1,
  advanced: 3,
  growth: 8,
};

export interface Capabilities {
  allowCrossSell: boolean;
  maxCrossSell: number;
  allowStrategySelection: boolean;
  allowUIConfig: boolean;
  allowCouponTease: boolean;
  allowMilestones: boolean;
  /** Advanced+: previous-period comparison metrics (e.g. previous 7d/30d). */
  allowComparison: boolean;
  /** Growth only: observed/estimated revenue difference and threshold enforcement. */
  allowRevenueDifference: boolean;
  analyticsLevel: "basic" | "advanced";
}

export function resolveCapabilities(plan: Plan): Capabilities {
  switch (plan) {
    case "basic":
      return {
        allowCrossSell: true,
        maxCrossSell: MAX_CROSS_SELL_BY_PLAN.basic,
        allowStrategySelection: false,
        allowUIConfig: false,
        allowCouponTease: false,
        allowMilestones: true,
        allowComparison: false,
        allowRevenueDifference: false,
        analyticsLevel: "basic",
      };
    case "advanced":
      return {
        allowCrossSell: true,
        maxCrossSell: MAX_CROSS_SELL_BY_PLAN.advanced,
        allowStrategySelection: true,
        allowUIConfig: true,
        allowCouponTease: true,
        allowMilestones: true,
        allowComparison: true,
        allowRevenueDifference: false,
        analyticsLevel: "advanced",
      };
    case "growth":
      return {
        allowCrossSell: true,
        maxCrossSell: MAX_CROSS_SELL_BY_PLAN.growth,
        allowStrategySelection: true,
        allowUIConfig: true,
        allowCouponTease: true,
        allowMilestones: true,
        allowComparison: true,
        allowRevenueDifference: true,
        analyticsLevel: "advanced",
      };
    default:
      return resolveCapabilities("basic");
  }
}
