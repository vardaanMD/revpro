# Analytics Migration: Revenue → Cart-Engagement

Safe, phased migration to remove revenue liability while keeping cart and engagement metrics.

## Phase 1 — Implemented

- [x] **Stop writing OrderInfluenceEvent**  
  Webhook only creates `OrderInfluenceEvent` when `ENABLE_ORDER_INFLUENCE_EVENT=1` (rollback). Default: do not write.

- [x] **Copy and labels**  
  - "Total cart value processed (at evaluation)" → "Total cart value at evaluation" (analytics + dashboard).  
  - "Core Revenue Controls" → "Thresholds" (settings).  
  - Growth plan: "Estimated revenue difference" → "Order outcome comparison (observational)" (upgrade page).  
  - Order Impact / AOV copy: "Observational, not a revenue guarantee" where shown.

- [x] **Retention / milestones**  
  - `10k_revenue` milestone label: "Cart value at evaluation with recommendations" in UI (no revenue wording).  
  - `revenueInfluenced30d` renamed to `cartValueMilestone30d` in `RetentionContext`; milestone logic unchanged, naming engagement-focused.

- [x] **Types**  
  - `cartRevenue` → `cartValueAtEvaluation` in analytics and dashboard types and responses (backward-compatible key in API if needed; UI uses new label).

## Phase 2 — Next

- [ ] Add CartProEventV3 retention (e.g. 90d) in `cleanup.server.ts`.
- [ ] Optional: CartEngagementSummary table or aggregations (impressions, clicks, CTR, funnel).
- [ ] Ensure recommendation:click writes to CrossSellEvent for CTR.

## Phase 3 — Later

- [ ] Remove or replace Order View tab with Engagement (clicks, CTR, funnel).
- [ ] Stop reading OrderInfluenceEvent in analytics/retention; deprecate table after retention period.
- [ ] Capability: rename `allowRevenueDifference` → `allowOrderOutcomeComparison`.

## Rollback

- Set `ENABLE_ORDER_INFLUENCE_EVENT=1` to resume writing OrderInfluenceEvent.
- Revert copy/label and retention text changes if needed.

## Env

| Variable | Effect |
|----------|--------|
| `ENABLE_ORDER_INFLUENCE_EVENT=1` | When set, orders/paid webhook still creates OrderInfluenceEvent (rollback). Omit or unset to stop writing (default after migration). |
