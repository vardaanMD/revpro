-- AlterTable
ALTER TABLE "ShopConfig" ADD COLUMN     "onboardingCompleted" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "onboardingStepProgress" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "previewSeen" BOOLEAN NOT NULL DEFAULT false;
