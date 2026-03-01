/**
 * Deterministic onboarding wizard. State is only onboardingStep (0–4) and onboardingCompleted.
 * No auto-completion, no DecisionMetric-driven progress. All transitions via explicit POST.
 * Onboarding completion means: "System is correctly installed and capable of functioning"
 * (infrastructure verified via synthetic decision / healthcheck), not live traffic or metrics.
 */
import { prisma } from "~/lib/prisma.server";
import { getShopConfig, invalidateShopConfigCache } from "~/lib/shop-config.server";
import { normalizeShopDomain } from "~/lib/shop-domain.server";
import { generatePreviewDecision } from "~/lib/preview-simulator.server";
import type { ShopConfig } from "@prisma/client";

export const WIZARD_STEP_WELCOME = 0;
export const WIZARD_STEP_ACTIVATE_EXTENSION = 1;
export const WIZARD_STEP_VERIFY_CART = 2;
export const WIZARD_STEP_CONFIGURE_BASICS = 3;
export const WIZARD_STEP_LAUNCH = 4;
export const WIZARD_STEP_COUNT = 4;

/**
 * Verify cart infrastructure: decision engine responds and system wiring works.
 * Does NOT require live traffic or DecisionMetric rows. Used for onboarding step 1.
 * Optionally extend with theme app embed check via Admin API later.
 */
export async function verifyCartInfrastructure(
  shop: string,
  admin: { graphql: (query: string, opts?: { variables?: Record<string, unknown> }) => Promise<Response> },
  request?: Request
): Promise<{ success: boolean; error?: string }> {
  return verifyStep2TestCart(shop, admin, request);
}

/** Step 2: Simulate decision with sample cart; validate response shape and crossSell presence. */
export async function verifyStep2TestCart(
  shop: string,
  admin: { graphql: (query: string, opts?: { variables?: Record<string, unknown> }) => Promise<Response> },
  request?: Request
): Promise<{ success: boolean; error?: string }> {
  try {
    const renderState = await generatePreviewDecision(shop, admin, undefined, undefined, undefined, request);
    if (!renderState || typeof renderState !== "object") {
      return { success: false, error: "Invalid decision response." };
    }
    const crossSell = renderState.decision.crossSell;
    if (!Array.isArray(crossSell)) {
      return { success: false, error: "Decision response missing crossSell array." };
    }
    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, error: message };
  }
}

/** Advance to step (1–4). Does not set onboardingCompleted. */
export async function setOnboardingStep(shop: string, step: number): Promise<void> {
  const domain = normalizeShopDomain(shop);
  await prisma.shopConfig.update({
    where: { shopDomain: domain },
    data: { onboardingStep: Math.max(0, Math.min(step, WIZARD_STEP_LAUNCH)) },
  });
  invalidateShopConfigCache(domain);
}

/** Set onboardingVerifiedAt (after step 2 passes). */
export async function setOnboardingVerifiedAt(shop: string): Promise<void> {
  const domain = normalizeShopDomain(shop);
  await prisma.shopConfig.update({
    where: { shopDomain: domain },
    data: { onboardingVerifiedAt: new Date() },
  });
  invalidateShopConfigCache(domain);
}

/** Step 3: Require freeShippingThresholdCents > 0 OR at least one config change from current. */
export function step3RequiresMutation(
  current: ShopConfig,
  submitted: { freeShippingThresholdCents: number; [key: string]: unknown }
): boolean {
  if (submitted.freeShippingThresholdCents > 0) return true;
  if (submitted.freeShippingThresholdCents !== current.freeShippingThresholdCents) return true;
  const keys: (keyof ShopConfig)[] = [
    "recommendationStrategy",
    "recommendationLimit",
    "enableCrossSell",
    "enableMilestones",
    "enableCouponTease",
  ];
  for (const key of keys) {
    const sub = submitted[key];
    if (sub === undefined) continue;
    const cur = current[key];
    if (Array.isArray(sub) && Array.isArray(cur)) {
      if (JSON.stringify(sub) !== JSON.stringify(cur)) return true;
    } else if (sub !== cur) {
      return true;
    }
  }
  return false;
}

/** Mark onboarding complete (step 4 → done). */
export async function completeOnboardingWizard(shop: string): Promise<void> {
  const domain = normalizeShopDomain(shop);
  await prisma.shopConfig.update({
    where: { shopDomain: domain },
    data: { onboardingCompleted: true, onboardingStep: WIZARD_STEP_LAUNCH },
  });
  invalidateShopConfigCache(domain);
}
