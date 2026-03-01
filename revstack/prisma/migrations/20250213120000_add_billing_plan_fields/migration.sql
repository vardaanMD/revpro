-- AlterTable
ALTER TABLE "ShopConfig" ADD COLUMN "plan" TEXT NOT NULL DEFAULT 'free',
ADD COLUMN "billingStatus" TEXT NOT NULL DEFAULT 'inactive',
ADD COLUMN "trialEndsAt" TIMESTAMP(3),
ADD COLUMN "billingId" TEXT;
