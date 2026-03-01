-- AlterTable: add configV3 JSON column to ShopConfig (V3 runtime config spine)
ALTER TABLE "ShopConfig" ADD COLUMN IF NOT EXISTS "configV3" JSONB;
