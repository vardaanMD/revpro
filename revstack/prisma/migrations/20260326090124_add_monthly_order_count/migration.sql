-- CreateTable
CREATE TABLE "MonthlyOrderCount" (
    "id" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "month" INTEGER NOT NULL,
    "orderCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MonthlyOrderCount_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MonthlyOrderCount_shopDomain_createdAt_idx" ON "MonthlyOrderCount"("shopDomain", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "MonthlyOrderCount_shopDomain_year_month_key" ON "MonthlyOrderCount"("shopDomain", "year", "month");
