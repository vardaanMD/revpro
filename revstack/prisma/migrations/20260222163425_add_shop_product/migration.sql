/*
  Warnings:

  - The primary key for the `ShopProduct` table will be changed. If it partially fails, the table could be left without primary key constraint.

*/
-- AlterTable
ALTER TABLE "ShopProduct" DROP CONSTRAINT "ShopProduct_pkey",
ADD CONSTRAINT "ShopProduct_pkey" PRIMARY KEY ("shopDomain", "id");
