# PHASE 4 REVISION — HARDENED GATING & RESPONSE INTEGRITY — OUTPUT

## 1. Updated SAFE_UI_FALLBACK definition

**File:** `revstack/app/routes/cart.decision.ts`

```ts
/** Deterministic, config-independent safe UI. Frozen; when allowUIConfig = false response.ui must equal this exactly. */
const SAFE_UI_FALLBACK = Object.freeze({
  primaryColor: null,
  accentColor: null,
  borderRadius: 12,
  showConfetti: false,
  enableHaptics: false,
  countdownEnabled: false,
  emojiMode: true,
  shippingBarPosition: "top",
} as const) as DecisionResponse["ui"];
```

- **Deterministic and config-independent:** No merge with config; when `allowUIConfig = false`, `response.ui` is set to `SAFE_UI_FALLBACK` exactly.
- **Immutable:** `Object.freeze()` prevents mutation.
- **Safe defaults:** `showConfetti`, `enableHaptics`, `countdownEnabled` are `false` (not config-derived).

All timeout/error paths and the non-UIConfig response path use `safeDecisionResponse(SAFE_UI_FALLBACK)`.

---

## 2. Example response object per plan

### BASIC

**Dashboard metrics** (no revenue-difference fields):

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

**Analytics metrics** (no comparison, no revenue-difference fields):

```json
{
  "sevenDayTrend": [ ... ],
  "thirtyDaySummary": { "totalDecisions": 0, "showRate": 0, "addRate": 0, "avgCartValue": 0 },
  "cartRevenueWithRecommendations": 0
}
```

**Decision response.ui** when `allowUIConfig = false`: exactly `SAFE_UI_FALLBACK` (frozen object; no config keys).

---

### ADVANCED

**Dashboard:** Same shape as BASIC (no revenue-difference fields).

**Analytics:** Base + comparison only (no revenue-difference):

```json
{
  "sevenDayTrend": [ ... ],
  "thirtyDaySummary": { ... },
  "cartRevenueWithRecommendations": 0,
  "previousSevenDaySummary": { "totalDecisions": 0, "addRate": 0 },
  "previousThirtyDaySummary": { "totalDecisions": 0, "showRate": 0, "addRate": 0, "avgCartValue": 0 }
}
```

**Decision:** `allowUIConfig = true` → `response.ui` from config; `allowStrategySelection = true` → strategy from config.

---

### GROWTH

**Dashboard:** Base + revenue-difference fields present.

**Analytics:** Base + comparison + revenue-difference fields present.

**Decision:** Full features; `response.ui` from config when `allowUIConfig = true`.

---

## 3. Confirmation: early-return logic fully excludes gated computation

### dashboard-metrics.server.ts

- When `allowRevenueDifference = false`:
  - A single aggregation query runs **without** `avg_with`, `count_with`, `avg_without`, `count_without`.
  - No variables for those columns are declared.
  - Return is the base object only; no revenue-difference keys are attached.
- When `allowRevenueDifference = true`: full query runs and base + revenue-difference fields are returned.

**No** `Promise.resolve([])`, no placeholder arrays, no dummy objects; hard branch exclusion.

### analytics.server.ts

- When `allowComparison = false`:
  - **No** previous-period queries are constructed or executed.
  - **No** variables for previous period (e.g. `p30`, `p7`, `totalPrev30`, `prevSevenDaySummary`) are defined.
  - Return is either base only (Basic) or base + revenue-only (Growth revenue path).
- When `allowRevenueDifference = false`:
  - The 30-day query does **not** select `avg_with`, `count_with`, `avg_without`, `count_without`.
  - Those variables are not declared; no revenue-difference fields are attached.
- Structure:
  - Single `Promise.all([sevenDay, thirtyDay])`; no previous-period queries in that call.
  - Early return when `!allowComparison && !allowRevenueDifference`.
  - Separate branches for: revenue-only; comparison-only; comparison + revenue. Previous-period queries run **only** inside the comparison branches (two distinct blocks).

**No** `Promise.resolve([])`, no empty arrays for previous period, no dummy comparison objects; gated metrics are not computed when not allowed.

---

## 4. Test file summary

**File:** `revstack/tests/analytics.gating.test.ts`

| Plan     | Dashboard test                                                                 | Analytics test                                                                 |
|----------|---------------------------------------------------------------------------------|---------------------------------------------------------------------------------|
| **BASIC**   | Response does NOT contain `observedAovDifference`, `countWith`, `countWithout` (asserted via `Object.hasOwnProperty`) | Response does NOT contain `previousSevenDaySummary`, `previousThirtyDaySummary`, `observedAovDifference`, `estimatedRevenueDifference`, `countWith30`, `countWithout30` |
| **ADVANCED** | Response does NOT contain revenue-difference fields                             | Response contains comparison fields; does NOT contain revenue-difference fields |
| **GROWTH**  | Response contains revenue-difference fields                                    | Response contains both comparison and revenue-difference fields                  |

- All assertions use `Object.hasOwnProperty.call(data, "fieldName")` to assert **omission** (or presence), not null.
- Prisma `$queryRaw` is mocked; minimal row shapes are returned so server logic runs without a real DB.
- **6 tests total;** all pass.

---

## 5. Confirmation: no plan comparisons reintroduced

- **cart.decision.ts:** Uses only `capabilities` (from `getBillingContext`). No `plan ===` or `billing.plan` for behavior. Dev-only warnings reference `config.recommendationStrategy` and config UI fields, not plan.
- **app._index.tsx:** Uses `capabilities.allowRevenueDifference`, `Object.hasOwnProperty.call(metrics, ...)` and `typeof` checks for gated fields. No plan comparison.
- **app.analytics.tsx:** Uses `capabilities.allowComparison`, `capabilities.allowRevenueDifference`, and explicit `Object.hasOwnProperty.call(metrics, ...)` before using gated fields. No plan comparison.
- **retention.server.ts:** Uses `capabilities.allowRevenueDifference` and `Object.hasOwnProperty.call(dashboardMetrics, "observedAovDifference")` before reading `observedAovDifference`. No plan comparison.
- **dashboard-metrics.server.ts / analytics.server.ts:** Take `capabilities` and branch on `allowRevenueDifference` and `allowComparison` only. No plan references.

All gating is capability-driven; no direct plan comparisons were added.

---

## Validation checklist (confirmed)

| # | Item | Status |
|---|------|--------|
| 1 | Analytics layer does not compute gated metrics at all when not allowed | Yes — strict branches; previous-period and revenue-difference queries/vars only in allowed paths. |
| 2 | Response objects omit gated fields entirely for BASIC/ADVANCED where applicable | Yes — no keys attached; tests assert via `Object.hasOwnProperty`. |
| 3 | SAFE_UI_FALLBACK cannot be mutated | Yes — `Object.freeze()`. |
| 4 | Unit tests cover response shape by plan | Yes — `tests/analytics.gating.test.ts` (6 cases, BASIC/ADVANCED/GROWTH). |
| 5 | No derived code references omitted fields without guard | Yes — retention, app._index, app.analytics use capability + `Object.hasOwnProperty`/`typeof` before access. |
| 6 | No performance regression | Yes — same or fewer queries when comparison/revenue not allowed; no extra work. |
| 7 | Billing logic unchanged | Yes — no changes to billing-context or billing.server. |

---

**No new features. No refactors outside gating. No analytics redesign. Strict structural hardening only.**
