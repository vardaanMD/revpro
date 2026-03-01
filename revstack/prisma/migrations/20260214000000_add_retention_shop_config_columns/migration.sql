-- AlterTable: add retention columns to ShopConfig (activatedAt, lastActiveAt, milestoneFlags)
ALTER TABLE "ShopConfig" ADD COLUMN IF NOT EXISTS "activatedAt" TIMESTAMP(3);
ALTER TABLE "ShopConfig" ADD COLUMN IF NOT EXISTS "lastActiveAt" TIMESTAMP(3);
ALTER TABLE "ShopConfig" ADD COLUMN IF NOT EXISTS "milestoneFlags" JSONB;
