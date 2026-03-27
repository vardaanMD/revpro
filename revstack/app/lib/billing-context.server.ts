/**
 * Central billing state resolution. Single source of truth for entitlement,
 * plan, capabilities, and access level. Admin and storefront must use this
 * module only; no direct config.plan / config.billingStatus checks in routes.
 * On Prisma/config failure returns safe fallback (isEntitled: false) so loaders never throw 500.
 */
import type { ShopConfig } from "@prisma/client";
import { getShopConfig } from "~/lib/shop-config.server";
import { resolveCapabilities, ORDER_LIMITS_BY_PLAN, type Plan, type Capabilities } from "~/lib/capabilities.server";
import { normalizeShopDomain } from "~/lib/shop-domain.server";
import { logResilience } from "~/lib/logger.server";
import { getMonthlyOrderCount } from "~/lib/order-usage.server";

export type BillingStatus = "active" | "inactive" | "pending" | "cancelled" | "past_due";
export type AccessLevel = "full" | "restricted";

export interface BillingContext {
  plan: Plan;
  billingStatus: BillingStatus;
  isEntitled: boolean;
  effectivePlan: Plan;
  capabilities: Capabilities;
  accessLevel: AccessLevel;
  /** Current calendar-month order count (0 if webhook not yet active). */
  monthlyOrderCount: number;
  /** Included orders for this plan (Infinity for Growth). */
  orderLimit: number;
}

function parsePlanFromConfig(configPlan: string | null | undefined): Plan {
  if (configPlan === "advanced" || configPlan === "growth") return configPlan;
  return "basic";
}

const VALID_BILLING_STATUSES = new Set<string>(["active", "inactive", "pending", "cancelled", "past_due"]);

function parseBillingStatus(raw: string | null | undefined): BillingStatus {
  const val = raw ?? "inactive";
  return VALID_BILLING_STATUSES.has(val) ? (val as BillingStatus) : "inactive";
}

/**
 * Whitelist override: comma-separated shop domains from PAYWALL_WHITELIST.
 * Parsed once at module load; cached as a Set for O(1) lookups.
 */
let _whitelistSet: Set<string> | null = null;
let _whitelistRaw: string | undefined;

function getWhitelistSet(): Set<string> {
  const raw = process.env.PAYWALL_WHITELIST;
  if (raw !== _whitelistRaw || _whitelistSet === null) {
    _whitelistRaw = raw;
    _whitelistSet = new Set(
      (raw ?? "").split(",").map((s) => normalizeShopDomain(s.trim())).filter(Boolean)
    );
  }
  return _whitelistSet;
}

export function isWhitelisted(shop: string): boolean {
  const set = getWhitelistSet();
  if (set.size === 0) return false;
  return set.has(normalizeShopDomain(shop));
}

/**
 * Resolves central billing context for a shop. Use existingConfig when already
 * loaded (e.g. layout) to avoid duplicate getShopConfig.
 * On Prisma/getShopConfig failure returns safe fallback (isEntitled: false, capabilities basic).
 */
export async function getBillingContext(
  shop: string,
  existingConfig?: ShopConfig
): Promise<BillingContext> {
  let config: ShopConfig;
  try {
    config = existingConfig ?? (await getShopConfig(shop));
  } catch (err) {
    logResilience({
      shop: normalizeShopDomain(shop),
      route: "billing-context",
      message: "getShopConfig failed; returning safe fallback",
      meta: {
        errorType: err instanceof Error ? err.name : "Unknown",
        fallbackUsed: true,
        stack: process.env.NODE_ENV === "development" && err instanceof Error ? err.stack : undefined,
      },
    });
    return {
      plan: "basic",
      billingStatus: "inactive",
      isEntitled: false,
      effectivePlan: "basic",
      capabilities: resolveCapabilities("basic"),
      accessLevel: "restricted",
      monthlyOrderCount: 0,
      orderLimit: ORDER_LIMITS_BY_PLAN.basic,
    };
  }

  const monthlyOrderCount = await getMonthlyOrderCount(shop);

  if (isWhitelisted(shop)) {
    return {
      plan: "growth",
      billingStatus: "active",
      isEntitled: true,
      effectivePlan: "growth",
      capabilities: resolveCapabilities("growth"),
      accessLevel: "full",
      monthlyOrderCount,
      orderLimit: ORDER_LIMITS_BY_PLAN.growth,
    };
  }

  const billingStatus = parseBillingStatus(config.billingStatus);
  const plan = parsePlanFromConfig(config.plan);
  const isEntitled = billingStatus === "active";

  if (!isEntitled) {
    return {
      plan,
      billingStatus,
      isEntitled: false,
      effectivePlan: "basic",
      capabilities: resolveCapabilities("basic"),
      accessLevel: "restricted",
      monthlyOrderCount,
      orderLimit: ORDER_LIMITS_BY_PLAN[plan],
    };
  }

  return {
    plan,
    billingStatus,
    isEntitled: true,
    effectivePlan: plan,
    capabilities: resolveCapabilities(plan),
    accessLevel: "full",
    monthlyOrderCount,
    orderLimit: ORDER_LIMITS_BY_PLAN[plan],
  };
}
