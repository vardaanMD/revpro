-- CreateTable
CREATE TABLE "ShopProduct" (
    "id" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "handle" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "featuredImageUrl" TEXT,
    "priceCents" INTEGER NOT NULL,
    "available" BOOLEAN NOT NULL,
    "collectionIds" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShopProduct_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ShopProduct_shopDomain_idx" ON "ShopProduct"("shopDomain");
