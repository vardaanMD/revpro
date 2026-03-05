# Analytics Migration: Revenue → Cart-Engagement

Safe, phased migration to remove revenue liability and focus on cart-engagement metrics.

---

## Phase 1 — Implemented

- [x] **Stop writing OrderInfluenceEvent**  
  Webhook only creates `OrderInfluenceEvent` when `ENABLE_ORDER_INFLUENCE_EVENT=1` (rollback). Default: do not write.

- [x] **Copy and labels**  
  - "Total cart value processed" → "Total cart value at evaluation" (analytics + dashboard).  
  - "Core Revenue Controls" → "Thresholds" (settings).  
  - Growth plan: "Estimated revenue difference" → "Order outcome comparison (observational)" (upgrade page).

- [x] **Retention / milestones**  
  - `10k_revenue` milestone label: "Cart value at evaluation with recommendations" in UI.  
  - `revenueInfluenced30d` renamed to `cartValueMilestone30d` in `RetentionContext`.

- [x] **Types**  
  - `cartRevenue` → `cartValueAtEvaluation` in analytics and dashboard.

---

## Phase 2 — Implemented

- [x] **Recommendation clicks → CrossSellEvent**  
  `recommendation:click` events (cart.analytics.v3) now write to `CrossSellEvent` with `eventType: "click"` so CTR can be computed. Impressions already written by decision route.

- [x] **Engagement metrics (impressions, clicks, CTR)**  
  - **Analytics** (`getAnalyticsMetrics`): `engagement` with `impressions30d`, `clicks30d`, `ctr30d` from `CrossSellEvent` (30-day window).  
  - **Dashboard** (`getDashboardMetrics`): `engagement` with `impressions7d`, `clicks7d`, `ctr7d` (7-day window).  
  - CTR = clicks ÷ impressions (0 when no impressions).

- [ ] **CartProEventV3 retention**  
  Optional: add 90d cleanup in `cleanup.server.ts` to avoid unbounded growth.

---

## Phase 3 — Implemented

- [x] **Order View removed (backend)**  
  - `OrderImpact` type and all `OrderInfluenceEvent` queries removed from `analytics.server.ts` and `dashboard-metrics.server.ts`.  
  - No more order-impact or AOV-with/without metrics.

- [x] **Order View removed (frontend)**  
  - **Analytics page**: Order View tab removed. Single view with Cart Metrics + "Recommendation engagement (30 days)" (impressions, clicks, CTR).  
  - **Dashboard**: "Order Outcomes" section removed. Replaced with "Recommendation engagement" (7d impressions, clicks, CTR) at top; Cart Metrics and Momentum kept (without order-impact cards).

- [x] **Retention**  
  - `upliftThisWeek` and `observedAovForHealth` no longer use order impact; set to 0. Health status based on billing and decision volume only.

- [ ] **Deprecate OrderInfluenceEvent table**  
  Optional: stop reading everywhere (done). Table can be dropped after a retention period if desired.

- [ ] **Capability**  
  Optional: rename `allowRevenueDifference` → e.g. `allowOrderOutcomeComparison` or remove if unused.

---

## New metric definitions (cart-engagement)

| Metric | Definition | Source |
|--------|------------|--------|
| **Impressions** | Count of recommendation product exposures (decision returns product; written as `CrossSellEvent` with `eventType: "impression"`). | `CrossSellEvent` (decision route + legacy event route). |
| **Clicks** | Count of recommendation clicks (storefront sends `recommendation:click`; written as `CrossSellEvent` with `eventType: "click"`). | `CrossSellEvent` (cart.analytics.v3 for V3; cart.analytics.event for V2). |
| **CTR** | clicks ÷ impressions (0 when impressions = 0). | Derived from above. |
| **Cart metrics** | Decisions, show rate, add rate, cart value at evaluation (unchanged). | `DecisionMetric`, `CrossSellConversion`. |

---

## Rollback

- Set `ENABLE_ORDER_INFLUENCE_EVENT=1` to resume writing OrderInfluenceEvent (Phase 1 rollback only; UI no longer shows order impact).
- To restore Order View in UI would require reverting Phase 3 frontend and backend changes.

---

## Env

| Variable | Effect |
|----------|--------|
| `ENABLE_ORDER_INFLUENCE_EVENT=1` | When set, orders/paid webhook still creates OrderInfluenceEvent. Omit or unset to stop writing. |
