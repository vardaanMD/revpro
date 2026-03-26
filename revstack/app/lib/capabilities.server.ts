export type Plan = "basic" | "advanced" | "growth";

/**
 * Derives plan from stored config value. Use getBillingContext(shop) for
 * entitlement and capabilities; this is for legacy/internal use only.
 */
export function getEffectivePlan(configPlan: string | null | undefined): Plan {
  if (configPlan === "advanced" || configPlan === "growth") return configPlan;
  return "basic";
}

/** Monthly order limits per plan. Growth is uncapped. */
export const ORDER_LIMITS_BY_PLAN: Record<Plan, number> = {
  basic: 500,
  advanced: 1000,
  growth: Infinity,
};

/** Max cross-sell recommendations (same for all plans in usage-based model). */
export const MAX_CROSS_SELL_BY_PLAN: Record<Plan, number> = {
  basic: 8,
  advanced: 8,
  growth: 8,
};

export interface Capabilities {
  allowCrossSell: boolean;
  maxCrossSell: number;
  allowStrategySelection: boolean;
  allowUIConfig: boolean;
  allowCouponTease: boolean;
  allowMilestones: boolean;
  /** Previous-period comparison metrics (e.g. previous 7d/30d). */
  allowComparison: boolean;
  /** Observed/estimated revenue difference and threshold enforcement. */
  allowRevenueDifference: boolean;
  analyticsLevel: "basic" | "advanced";
}

/** All plans get full capabilities in the usage-based model. */
const FULL_CAPABILITIES: Capabilities = {
  allowCrossSell: true,
  maxCrossSell: 8,
  allowStrategySelection: true,
  allowUIConfig: true,
  allowCouponTease: true,
  allowMilestones: true,
  allowComparison: true,
  allowRevenueDifference: true,
  analyticsLevel: "advanced",
};

export function resolveCapabilities(_plan: Plan): Capabilities {
  return { ...FULL_CAPABILITIES };
}
