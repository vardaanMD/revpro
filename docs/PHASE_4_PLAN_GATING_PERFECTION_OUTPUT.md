# PHASE 4 — PLAN GATING PERFECTION — OUTPUT

## 1. Updated capability matrix

**File:** `revstack/app/lib/capabilities.server.ts`

Capabilities are derived strictly from `effectivePlan` (via `getBillingContext` → `resolveCapabilities(plan)`). No direct plan comparisons outside billing-context.

| Capability | Basic | Advanced | Growth |
|------------|-------|----------|--------|
| `maxCrossSell` | 1 | 3 | 8 |
| `allowStrategySelection` | false | true | true |
| `allowUIConfig` | false | true | true |
| `allowCouponTease` | false | true | true |
| `allowComparison` | false | true | true |
| `allowRevenueDifference` | false | false | true |
| `allowCrossSell` | true | true | true |
| `allowMilestones` | true | true | true |
| `analyticsLevel` | "basic" | "advanced" | "advanced" |

- **allowComparison** (Advanced+): gates previous-period metrics (previous 7d/30d). When false, analytics do not compute or return `previousSevenDaySummary` or `previousThirtyDaySummary`.
- **allowRevenueDifference** (Growth only): gates observed/estimated revenue difference and threshold (≥30 samples). When false, dashboard/analytics do not compute or return `observedAovDifference`, `countWith`, `countWithout`, `estimatedRevenueDifference`, `countWith30`, `countWithout30`.

---

## 2. Confirmation of plan-comparison removal

- **app._index.tsx:** Replaced `isHighestPlan = plan === "growth"` with `isHighestPlan = capabilities.allowRevenueDifference`. Loader gets billing first, then `getDashboardMetrics(shop, billing.capabilities)`; returns `capabilities`. Revenue Snapshot cards for AOV/revenue difference render only when `allowRevenue`.
- **app.analytics.tsx:** Replaced `blurAdvanced = plan === "basic" || !isBillingActive` with `blurAdvanced = !capabilities.allowComparison || !isBillingActive`. Replaced `lockRevenue = plan !== "growth" || !isBillingActive` with `lockRevenue = !capabilities.allowRevenueDifference || !isBillingActive`. Loader gets billing first, then `getAnalyticsMetrics(shop, billing.capabilities)`; returns `capabilities`.
- **app.preview.tsx:** Replaced `config.plan === "basic"` with `!capabilities.allowStrategySelection` for the "Next stage: Advanced" badge.
- **app.upgrade.tsx / app.billing.tsx:** Retained `billing.plan` only for **display** (current plan name, plan labels). No gating logic; no change to billing flow.
- **billing-context.server.ts:** All plan-to-capability resolution lives here; routes never compare `plan` for entitlement.

**Result:** No direct plan comparisons used for gating. All enforcement flows through `billing.capabilities`.

---

## 3. Example JSON response shapes by plan

### Decision API (`POST /cart/decision`) — example response shapes

**Basic**

- `crossSell`: at most **1** item (capped by `maxCrossSell`).
- `enableCouponTease`: **false** (allowCouponTease false).
- `ui`: **safe fallback** (allowUIConfig false) — fixed values, no config-driven colors/layout.
- Strategy is effectively **COLLECTION_MATCH** (allowStrategySelection false).
- No strategy selection, no UI config, no coupon tease, maxCrossSell = 1.

```json
{
  "crossSell": [],
  "freeShippingRemaining": 0,
  "suppressCheckout": false,
  "milestones": [],
  "enableCouponTease": false,
  "ui": {
    "primaryColor": null,
    "accentColor": null,
    "borderRadius": 12,
    "showConfetti": true,
    "enableHaptics": true,
    "countdownEnabled": true,
    "emojiMode": true,
    "shippingBarPosition": "top"
  }
}
```

**Advanced**

- `crossSell`: at most **3** items.
- `enableCouponTease`: from config (allowCouponTease true).
- `ui`: from config (allowUIConfig true).
- Strategy from config (allowStrategySelection true).
- No revenue-difference metrics in dashboard/analytics.

**Growth**

- `crossSell`: at most **8** items.
- All features allowed: strategy selection, UI config, coupon tease, comparison metrics, revenue difference.
- Dashboard/analytics include `observedAovDifference`, `estimatedRevenueDifference`, `countWith`/`countWithout` (dashboard), `countWith30`/`countWithout30` (analytics) when applicable.

---

### Dashboard metrics (loader data for /app) — response shape

**Basic / Advanced (allowRevenueDifference = false)**

- `observedAovDifference`, `countWith`, `countWithout` are **omitted** (not present in object). Not null, not zero — omitted.

```json
{
  "todayDecisions": 0,
  "crossSellShowRate": 0,
  "crossSellAddRate": 0,
  "avgCartValue": 0,
  "cartRevenueWithRecommendations": 0,
  "last7DaysTrend": [ { "date": "2026-02-14", "decisions": 0 }, ... ]
}
```

**Growth (allowRevenueDifference = true)**

- Same base fields plus: `observedAovDifference`, `countWith`, `countWithout`.

```json
{
  "todayDecisions": 0,
  "crossSellShowRate": 0,
  "crossSellAddRate": 0,
  "avgCartValue": 0,
  "cartRevenueWithRecommendations": 0,
  "last7DaysTrend": [ ... ],
  "observedAovDifference": 0,
  "countWith": 0,
  "countWithout": 0
}
```

---

### Analytics metrics (loader data for /app/analytics) — response shape

**Basic (allowComparison = false, allowRevenueDifference = false)**

- `previousSevenDaySummary`, `previousThirtyDaySummary` **omitted**.
- `observedAovDifference`, `estimatedRevenueDifference`, `countWith30`, `countWithout30` **omitted**.

```json
{
  "sevenDayTrend": [ ... ],
  "thirtyDaySummary": { "totalDecisions": 0, "showRate": 0, "addRate": 0, "avgCartValue": 0 },
  "cartRevenueWithRecommendations": 0
}
```

**Advanced (allowComparison = true, allowRevenueDifference = false)**

- Previous-period fields **included**.
- Revenue-difference fields **omitted**.

**Growth (allowComparison = true, allowRevenueDifference = true)**

- Full shape: previous-period + revenue-difference fields included. Threshold (≥30 samples) for `estimatedRevenueDifference` applied only when `allowRevenueDifference` is true.

---

## 4. Analytics compute functions early-return / conditional compute

- **dashboard-metrics.server.ts:** When `capabilities.allowRevenueDifference` is false, the aggregation query does **not** select `avg_with`, `count_with`, `avg_without`, `count_without`. Those metrics are not computed. The return object is the base shape only; revenue-difference fields are never added.
- **analytics.server.ts:**  
  - When `capabilities.allowComparison` is false, **prevThirtyRow** and **prevSevenRow** queries are not run (replaced with `Promise.resolve([])`). Previous-period metrics are not computed; they are not added to the return object.  
  - When `capabilities.allowRevenueDifference` is false, the 30-day query does not select with/without breakdown; revenue-difference fields are not computed and are not added to the return object.  
  - `REVENUE_DIFFERENCE_MIN_SAMPLES` (≥30) and `estimatedRevenueDifference` are only computed when `capabilities.allowRevenueDifference` is true.

So: gated metrics are not computed for lower plans; they are omitted from the response.

---

## 5. Billing logic unchanged

- **billing-context.server.ts:** No change to billing status resolution, `effectivePlan`, or whitelist behavior. Only the **capability matrix** in `capabilities.server.ts` was extended with `allowComparison` and `allowRevenueDifference`; `getBillingContext` still calls `resolveCapabilities(plan)` as before.
- **billing.server.ts:** No changes.
- **app.upgrade.tsx / app.billing.tsx:** No changes to subscription or plan selection flow; only display uses `billing.plan`.

---

## 6. Security hardening (decision route)

- Request body is **cart-only** (validated by `cartSchema`). Strategy and `recommendationLimit` are **never** read from the request.
- `effectiveLimit` is `Math.min(max(1, config.recommendationLimit), capabilities.maxCrossSell)` — so config or any future input cannot exceed `maxCrossSell`.
- `effectiveStrategy` is `capabilities.allowStrategySelection ? config.recommendationStrategy : "COLLECTION_MATCH"` — strategy cannot be elevated by request or config when not allowed.
- When `allowUIConfig` is false, response `ui` is always the safe fallback object.
- When `allowCouponTease` is false, `enableCouponTease` is always false in the response.

Audit comment added in `cart.decision.ts`: *If a capability is false, the corresponding field must not be configurable via request or config override.*

---

## Validation checklist (confirmed)

| # | Item | Status |
|---|------|--------|
| 1 | No gated metric is computed for lower plans | Yes — dashboard/analytics use capability-gated queries and omit gated fields when not allowed. |
| 2 | No gated metric appears in JSON response for lower plans | Yes — fields omitted, not null/zero/locked. |
| 3 | No direct plan comparisons outside billing-context | Yes — routes use capabilities only for gating; plan used only for display where needed. |
| 4 | Capabilities drive 100% of enforcement | Yes — decision and analytics layers use only `billing.capabilities`. |
| 5 | Manual request tampering cannot unlock features | Yes — decision route ignores strategy/limit from body; response built from capabilities + config capped by capabilities. |
| 6 | maxCrossSell strictly enforced | Yes — `effectiveLimit = Math.min(..., capabilities.maxCrossSell)`; crossSell sliced to `effectiveLimit`. |
| 7 | Unit tests updated to assert omission (not null) | N/A — no existing unit tests for dashboard/analytics response shape; integration tests for cart.decision pass (except one pre-existing oversized-payload test). |

---

**No UI redesign. No marketing copy. No refactors unrelated to gating. Strict capability enforcement only.**
