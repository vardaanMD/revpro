-- AlterTable: add primaryCurrency to ShopConfig (multi-currency: shop primary currency from Shopify)
ALTER TABLE "ShopConfig" ADD COLUMN IF NOT EXISTS "primaryCurrency" TEXT;
