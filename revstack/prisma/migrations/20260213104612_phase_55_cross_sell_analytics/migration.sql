-- CreateTable
CREATE TABLE "CrossSellEvent" (
    "id" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "cartValue" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CrossSellEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CrossSellConversion" (
    "id" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "cartValue" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CrossSellConversion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CrossSellEvent_shopDomain_createdAt_idx" ON "CrossSellEvent"("shopDomain", "createdAt");

-- CreateIndex
CREATE INDEX "CrossSellEvent_shopDomain_eventType_idx" ON "CrossSellEvent"("shopDomain", "eventType");

-- CreateIndex
CREATE INDEX "CrossSellConversion_shopDomain_createdAt_idx" ON "CrossSellConversion"("shopDomain", "createdAt");
