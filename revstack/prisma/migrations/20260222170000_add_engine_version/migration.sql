-- AlterTable: add engineVersion to ShopConfig (per-shop engine routing: v1 | v2)
ALTER TABLE "ShopConfig" ADD COLUMN IF NOT EXISTS "engineVersion" TEXT NOT NULL DEFAULT 'v1';
