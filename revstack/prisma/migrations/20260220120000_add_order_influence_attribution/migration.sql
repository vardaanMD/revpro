-- CreateTable
CREATE TABLE "RevproClickSession" (
    "id" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "revproSessionId" TEXT NOT NULL,
    "clickedProductIds" JSONB NOT NULL,
    "recommendedProductIds" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RevproClickSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderInfluenceEvent" (
    "id" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "orderValue" INTEGER NOT NULL,
    "influenced" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderInfluenceEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RevproClickSession_shopDomain_revproSessionId_key" ON "RevproClickSession"("shopDomain", "revproSessionId");

-- CreateIndex
CREATE INDEX "RevproClickSession_shopDomain_revproSessionId_idx" ON "RevproClickSession"("shopDomain", "revproSessionId");

-- CreateIndex
CREATE INDEX "OrderInfluenceEvent_shopDomain_createdAt_idx" ON "OrderInfluenceEvent"("shopDomain", "createdAt");

-- CreateIndex
CREATE INDEX "OrderInfluenceEvent_shopDomain_orderId_idx" ON "OrderInfluenceEvent"("shopDomain", "orderId");
