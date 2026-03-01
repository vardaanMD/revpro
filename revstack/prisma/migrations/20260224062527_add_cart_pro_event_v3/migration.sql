-- CreateTable
CREATE TABLE "CartProEventV3" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "itemCount" INTEGER NOT NULL,
    "subtotal" INTEGER NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CartProEventV3_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CartProEventV3_shop_idx" ON "CartProEventV3"("shop");

-- CreateIndex
CREATE INDEX "CartProEventV3_sessionId_idx" ON "CartProEventV3"("sessionId");

-- CreateIndex
CREATE INDEX "CartProEventV3_name_idx" ON "CartProEventV3"("name");
