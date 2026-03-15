-- Add refundedCents so net revenue = orderValue - refundedCents (updated by refunds/create webhook).
ALTER TABLE "OrderInfluenceEvent" ADD COLUMN IF NOT EXISTS "refundedCents" INTEGER NOT NULL DEFAULT 0;
