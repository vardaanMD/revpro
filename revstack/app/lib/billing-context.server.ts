/**
 * Central billing state resolution. Single source of truth for entitlement,
 * plan, capabilities, and access level. Admin and storefront must use this
 * module only; no direct config.plan / config.billingStatus checks in routes.
 * On Prisma/config failure returns safe fallback (isEntitled: false) so loaders never throw 500.
 */
import type { ShopConfig } from "@prisma/client";
import { getShopConfig } from "~/lib/shop-config.server";
import { resolveCapabilities, type Plan, type Capabilities } from "~/lib/capabilities.server";
import { normalizeShopDomain } from "~/lib/shop-domain.server";
import { logResilience } from "~/lib/logger.server";

export type BillingStatus = "active" | "inactive" | "pending" | "cancelled" | "past_due";
export type AccessLevel = "full" | "restricted";

export interface BillingContext {
  plan: Plan;
  billingStatus: BillingStatus;
  isEntitled: boolean;
  effectivePlan: Plan;
  capabilities: Capabilities;
  accessLevel: AccessLevel;
}

function parsePlanFromConfig(configPlan: string | null | undefined): Plan {
  if (configPlan === "advanced" || configPlan === "growth") return configPlan;
  return "basic";
}

/**
 * Whitelist override: comma-separated shop domains from PAYWALL_WHITELIST.
 * If undefined or empty, no whitelist. Normalized domain match.
 */
export function isWhitelisted(shop: string): boolean {
  const raw = process.env.PAYWALL_WHITELIST;
  if (raw === undefined || raw === "") return false;
  const domain = normalizeShopDomain(shop);
  const list = raw.split(",").map((s) => normalizeShopDomain(s.trim())).filter(Boolean);
  return list.includes(domain);
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
    };
  }

  if (isWhitelisted(shop)) {
    return {
      plan: "growth",
      billingStatus: "active",
      isEntitled: true,
      effectivePlan: "growth",
      capabilities: resolveCapabilities("growth"),
      accessLevel: "full",
    };
  }

  const billingStatus = (config.billingStatus ?? "inactive") as BillingStatus;
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
    };
  }

  return {
    plan,
    billingStatus,
    isEntitled: true,
    effectivePlan: plan,
    capabilities: resolveCapabilities(plan),
    accessLevel: "full",
  };
}
