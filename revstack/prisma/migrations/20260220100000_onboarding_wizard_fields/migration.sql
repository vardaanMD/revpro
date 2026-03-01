-- Onboarding wizard: single source of truth is onboardingStep (0-4) and onboardingCompleted.
-- onboardingVerifiedAt set when step 2 (Verify Recommendations) passes.
ALTER TABLE "ShopConfig" ADD COLUMN IF NOT EXISTS "onboardingStep" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "ShopConfig" ADD COLUMN IF NOT EXISTS "onboardingVerifiedAt" TIMESTAMP(3);
