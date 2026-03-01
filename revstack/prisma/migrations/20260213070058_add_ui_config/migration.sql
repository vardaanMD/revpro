-- AlterTable
ALTER TABLE "ShopConfig" ADD COLUMN     "accentColor" TEXT,
ADD COLUMN     "borderRadius" INTEGER NOT NULL DEFAULT 12,
ADD COLUMN     "countdownEnabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "emojiMode" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "enableHaptics" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "primaryColor" TEXT,
ADD COLUMN     "shippingBarPosition" TEXT NOT NULL DEFAULT 'top',
ADD COLUMN     "showConfetti" BOOLEAN NOT NULL DEFAULT true;
