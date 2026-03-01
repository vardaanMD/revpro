# PHASE 3 — ANALYTICS TRUTH ALIGNMENT — OUTPUT

## 1. Updated metric definitions

| Metric | Definition |
|--------|------------|
| **AOV with recommendations** | `average(cartValue where hasCrossSell = true)` |
| **AOV without recommendations** | `average(cartValue where hasCrossSell = false)` |
| **Observed AOV Difference** | `AOV_with - AOV_without` (signed cents) |
| **Cart Revenue (with recommendations shown)** | `sum(cartValue where hasCrossSell = true)` over the reporting window (7d dashboard, 30d analytics) |
| **Estimated Revenue Difference (Observed)** | `(AOV_with - AOV_without) × count_with` only when `count_with >= 30` AND `count_without >= 30`; otherwise not computed. |
| **Adds per Recommendation Session** | `conversions / sessions_with_recommendations`. Display: decimal (e.g. 1.35) when value > 1.0; otherwise percentage. |
| **Show Rate** | `sessions_with_recommendations / total_sessions` (remains percentage). |

---

## 2. Dashboard label mapping (unified across Dashboard & Analytics)

| Previous term | New term |
|---------------|----------|
| Revenue Influenced | Cart Revenue (with recommendations shown) |
| Revenue Impact | Estimated Revenue Difference (Observed) |
| Estimated Uplift | Observed AOV Difference |
| Estimated Monthly Uplift | **Removed** (no display) |
| Add Rate (as %) | Adds per Recommendation Session (decimal when > 1, else %) |
| Estimated Revenue Impact | Estimated Revenue Difference (Observed) |

**Section heading:** “Revenue Impact” (Analytics) → **“Revenue Snapshot”** (aligned with Dashboard).

---

## 3. Confirmation of projection removal

- **Removed:** Any use of `7-day uplift × (30/7)` or equivalent linear extrapolation.
- **Removed:** “Estimated monthly uplift” card and “Projected from weekly performance” subtext.
- **Removed:** Narrative copy that stated “Your growth engine influenced $X in revenue this month” (monthly projection).
- **Result:** No extrapolated monthly projections. Only actual 7-day (dashboard) or 30-day (analytics) windows are used for displayed metrics.

---

## 4. Example display when insufficient data

- **Estimated Revenue Difference (Observed):**
  - **Value:** `"Not enough data"`
  - **Subtext:** `"Need ≥30 sessions with and without recommendations"`
- Revenue difference is only computed when both `count_with >= 30` and `count_without >= 30` (dashboard: 7-day counts; analytics: 30-day counts). Otherwise the UI shows the above; no numeric value is shown.

---

## 5. Confirmation that billing logic is untouched

- **Billing:** No changes to `createSubscription`, plan IDs, pricing, or entitlement checks in `billing.server.ts`, `billing-context.server.ts`, or upgrade flow.
- **Only change in revenue-related logic:** Revenue difference is computed only when sample-size threshold is met (count_with ≥ 30 and count_without ≥ 30). Retention milestone “10k_revenue” uses the same threshold for consistency. No changes to how plans or billing are determined or displayed beyond copy (e.g. “Activate plan” instead of “Activate Growth Engine” and neutral upgrade/ROI copy).

---

## Files changed (summary)

- **Backend:** `dashboard-metrics.server.ts` (new fields: `observedAovDifference`, `cartRevenueWithRecommendations`, `countWith`, `countWithout`; removed `estimatedUplift`), `analytics.server.ts` (new: `observedAovDifference`, `estimatedRevenueDifference`, `cartRevenueWithRecommendations`, `countWith30`, `countWithout30`; threshold 30), `retention.server.ts` (use `observedAovDifference`, revenue 30d only when samples ≥ 30).
- **UI:** `app._index.tsx`, `app.analytics.tsx` (terminology, labels, disclaimer, “Not enough data”, Add Rate as Adds per Recommendation Session), `app.upgrade.tsx` (neutral copy; removed “8–15% AOV lift”, “Pays for itself in ~3 orders”).
- **Styles:** `dashboardIndex.module.css`, `analyticsPage.module.css` (disclaimer styling).

---

## Validation checklist (as specified)

1. **No revenue metric implies causation.** Labels and disclaimer state observational comparison only.
2. **No monthly projection remains.** Removed 7× (30/7) and “Estimated monthly uplift”.
3. **Add Rate cannot exceed 100% as percentage.** Renamed to “Adds per Recommendation Session”; when value > 1, shown as decimal (e.g. 1.35).
4. **Revenue Difference only with sufficient sample size.** Shown only when count_with ≥ 30 and count_without ≥ 30; otherwise “Not enough data”.
5. **Terminology consistent** across Dashboard, Analytics, and Upgrade (Revenue Snapshot, same metric names).
6. **No marketing language** in metric descriptions (no “generated”, “made you”, “engine earned”).
7. **Backend logic** changed only for metric definitions and the data threshold check; billing and subscription logic unchanged.
