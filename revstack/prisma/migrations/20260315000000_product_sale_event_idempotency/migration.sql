-- Add orderId and lineItemId for idempotent orders/paid webhook (no double-count on retry).
ALTER TABLE "ProductSaleEvent" ADD COLUMN "orderId" TEXT;
ALTER TABLE "ProductSaleEvent" ADD COLUMN "lineItemId" TEXT;

-- Backfill existing rows so unique constraint can apply (each gets unique legacy key).
UPDATE "ProductSaleEvent" SET "orderId" = 'legacy', "lineItemId" = "id" WHERE "orderId" IS NULL;

ALTER TABLE "ProductSaleEvent" ALTER COLUMN "orderId" SET NOT NULL;
ALTER TABLE "ProductSaleEvent" ALTER COLUMN "lineItemId" SET NOT NULL;

CREATE UNIQUE INDEX "ProductSaleEvent_shopDomain_orderId_lineItemId_key" ON "ProductSaleEvent"("shopDomain", "orderId", "lineItemId");
