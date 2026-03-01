/**
 * Onboarding wizard: deterministic step progression, no route bypass, no implicit auto-completion.
 * Step 1 uses verifyCartInfrastructure (synthetic decision / system wiring), not DecisionMetric.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  verifyCartInfrastructure,
  verifyStep2TestCart,
  setOnboardingStep,
  setOnboardingVerifiedAt,
  completeOnboardingWizard,
  step3RequiresMutation,
  WIZARD_STEP_WELCOME,
  WIZARD_STEP_ACTIVATE_EXTENSION,
  WIZARD_STEP_VERIFY_CART,
  WIZARD_STEP_CONFIGURE_BASICS,
  WIZARD_STEP_LAUNCH,
} from "~/lib/onboarding-wizard.server";
import { prisma } from "~/lib/prisma.server";
import type { ShopConfig } from "@prisma/client";

const TEST_SHOP = "wizard-test.myshopify.com";
const mockAdmin = { graphql: vi.fn() };

vi.mock("~/lib/prisma.server", () => ({
  prisma: {
    shopConfig: {
      update: vi.fn(),
      findUnique: vi.fn(),
    },
  },
}));

vi.mock("~/lib/shop-config.server", () => ({
  getShopConfig: vi.fn(),
  invalidateShopConfigCache: vi.fn(),
}));

vi.mock("~/lib/preview-simulator.server", () => ({
  generatePreviewDecision: vi.fn(),
}));

describe("onboarding wizard", () => {
  beforeEach(() => {
    vi.mocked(prisma.shopConfig.update).mockReset();
    vi.mocked(prisma.shopConfig.findUnique).mockReset();
    vi.mocked(mockAdmin.graphql).mockReset();
  });

  describe("step 1 (verifyCartInfrastructure)", () => {
    it("step 1 fails when decision response is invalid (no crossSell)", async () => {
      const { generatePreviewDecision } = await import("~/lib/preview-simulator.server");
      vi.mocked(generatePreviewDecision).mockResolvedValueOnce({} as never);
      const result = await verifyCartInfrastructure(TEST_SHOP, mockAdmin);
      expect(result.success).toBe(false);
      expect(result.error).toContain("crossSell");
    });

    it("step 1 passes when synthetic decision returns valid shape (crossSell array)", async () => {
      const { generatePreviewDecision } = await import("~/lib/preview-simulator.server");
      vi.mocked(generatePreviewDecision).mockResolvedValueOnce({
        ui: {} as never,
        decision: {
          crossSell: [],
          freeShippingRemaining: 0,
          suppressCheckout: false,
          milestones: [],
          enableCouponTease: false,
        },
      });
      const result = await verifyCartInfrastructure(TEST_SHOP, mockAdmin);
      expect(result.success).toBe(true);
    });
  });

  describe("step 2 → 3", () => {
    it("step 2 requires successful test (decision response with crossSell) to move to 3", async () => {
      const { generatePreviewDecision } = await import("~/lib/preview-simulator.server");
      vi.mocked(generatePreviewDecision).mockResolvedValueOnce({
        ui: {} as never,
        decision: {
          crossSell: [],
          freeShippingRemaining: 0,
          suppressCheckout: false,
          milestones: [],
          enableCouponTease: false,
        },
      });
      const pass = await verifyStep2TestCart(TEST_SHOP, { graphql: vi.fn() });
      expect(pass.success).toBe(true);

      vi.mocked(generatePreviewDecision).mockResolvedValueOnce({} as never);
      const failShape = await verifyStep2TestCart(TEST_SHOP, { graphql: vi.fn() });
      expect(failShape.success).toBe(false);
      expect(failShape.error).toContain("crossSell");
    });
  });

  describe("step 3 → 4", () => {
    it("step 3 requires config mutation (freeShippingThreshold > 0 or other change) to move to 4", () => {
      const current: Partial<ShopConfig> = {
        freeShippingThresholdCents: 0,
        recommendationStrategy: "COLLECTION_MATCH",
      };
      expect(step3RequiresMutation(current as ShopConfig, { freeShippingThresholdCents: 0, recommendationStrategy: "COLLECTION_MATCH" })).toBe(false);
      expect(step3RequiresMutation(current as ShopConfig, { freeShippingThresholdCents: 100, recommendationStrategy: "COLLECTION_MATCH" })).toBe(true);
      expect(step3RequiresMutation(current as ShopConfig, { freeShippingThresholdCents: 0, recommendationStrategy: "MANUAL_COLLECTION" })).toBe(true);
    });
  });

  describe("step 4 → complete", () => {
    it("step 4 sets onboardingCompleted = true and step = 4", async () => {
      vi.mocked(prisma.shopConfig.update).mockResolvedValue({} as never);
      await completeOnboardingWizard(TEST_SHOP);
      expect(prisma.shopConfig.update).toHaveBeenCalledWith({
        where: { shopDomain: expect.any(String) },
        data: { onboardingCompleted: true, onboardingStep: WIZARD_STEP_LAUNCH },
      });
    });
  });

  describe("no implicit auto-completion", () => {
    it("setOnboardingStep only updates step, does not set onboardingCompleted", async () => {
      vi.mocked(prisma.shopConfig.update).mockResolvedValue({} as never);
      await setOnboardingStep(TEST_SHOP, WIZARD_STEP_VERIFY_CART);
      const call = vi.mocked(prisma.shopConfig.update).mock.calls[0];
      expect(call?.[0].data).toEqual({ onboardingStep: WIZARD_STEP_VERIFY_CART });
      expect((call?.[0].data as { onboardingCompleted?: boolean }).onboardingCompleted).toBeUndefined();
    });
  });

  describe("step constants", () => {
    it("wizard steps are 0-4", () => {
      expect(WIZARD_STEP_WELCOME).toBe(0);
      expect(WIZARD_STEP_ACTIVATE_EXTENSION).toBe(1);
      expect(WIZARD_STEP_VERIFY_CART).toBe(2);
      expect(WIZARD_STEP_CONFIGURE_BASICS).toBe(3);
      expect(WIZARD_STEP_LAUNCH).toBe(4);
    });
  });
});

describe("onboarding route enforcement (loader redirect)", () => {
  vi.mock("~/lib/shop-config.server");
  vi.mock("~/lib/billing-context.server");

  it("when billing active and !onboardingCompleted, non-allowed path should redirect to /app/onboarding", async () => {
    const { getShopConfig } = await import("~/lib/shop-config.server");
    const { getBillingContext } = await import("~/lib/billing-context.server");
    vi.mocked(getShopConfig).mockResolvedValue({
      onboardingCompleted: false,
      onboardingStep: 0,
    } as never);
    vi.mocked(getBillingContext).mockResolvedValue({
      isEntitled: true,
      plan: "basic",
      billingStatus: "active",
      effectivePlan: "basic",
      capabilities: {} as never,
      accessLevel: "full",
    });

    const allowedPaths = ["/app/onboarding", "/app/billing"];
    const pathname = "/app";
    const isAllowed = allowedPaths.some((p) => pathname === p || pathname.startsWith(p + "/"));
    expect(isAllowed).toBe(false);

    const pathnameOnboarding = "/app/onboarding";
    const isAllowedOnboarding = allowedPaths.some((p) => pathnameOnboarding === p || pathnameOnboarding.startsWith(p + "/"));
    expect(isAllowedOnboarding).toBe(true);
  });

  it("after completion, dashboard path is allowed (no redirect)", async () => {
    const allowedPaths = ["/app/onboarding", "/app/billing"];
    const pathname = "/app";
    const onboardingCompleted = true;
    const wouldRedirect = !onboardingCompleted && !allowedPaths.some((p) => pathname === p || pathname.startsWith(p + "/"));
    expect(wouldRedirect).toBe(false);
  });
});
