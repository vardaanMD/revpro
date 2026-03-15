-- Deduplicate OrderInfluenceEvent by (shopDomain, orderId), keeping the row with the latest createdAt.
DELETE FROM "OrderInfluenceEvent" a
USING "OrderInfluenceEvent" b
WHERE a.id <> b.id
  AND a."shopDomain" = b."shopDomain"
  AND a."orderId" = b."orderId"
  AND a."createdAt" < b."createdAt";

-- Add unique constraint so upsert by (shopDomain, orderId) works and we avoid double-counting.
CREATE UNIQUE INDEX "OrderInfluenceEvent_shopDomain_orderId_key" ON "OrderInfluenceEvent"("shopDomain", "orderId");
