-- CreateIndex
CREATE INDEX "DecisionMetric_shopDomain_createdAt_idx" ON "DecisionMetric"("shopDomain", "createdAt");

-- CreateIndex
CREATE INDEX "WebhookEvent_createdAt_idx" ON "WebhookEvent"("createdAt");
