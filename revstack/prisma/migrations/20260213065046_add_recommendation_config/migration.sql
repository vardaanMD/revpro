-- AlterTable
ALTER TABLE "ShopConfig" ADD COLUMN     "manualCollectionIds" JSONB,
ADD COLUMN     "recommendationLimit" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "recommendationStrategy" TEXT NOT NULL DEFAULT 'COLLECTION_MATCH';
