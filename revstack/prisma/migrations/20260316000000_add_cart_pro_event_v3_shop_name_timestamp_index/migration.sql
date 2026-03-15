-- CreateIndex: composite index for analytics queries filtering by shop + name + timestamp
CREATE INDEX "CartProEventV3_shop_name_timestamp_idx" ON "CartProEventV3"("shop", "name", "timestamp");
