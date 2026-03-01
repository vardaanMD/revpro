-- CreateTable
CREATE TABLE "ProductSaleEvent" (
    "id" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "soldAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductSaleEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProductSaleEvent_shopDomain_soldAt_idx" ON "ProductSaleEvent"("shopDomain", "soldAt");

-- CreateIndex
CREATE INDEX "ProductSaleEvent_shopDomain_productId_idx" ON "ProductSaleEvent"("shopDomain", "productId");
