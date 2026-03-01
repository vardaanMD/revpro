# PHASE 2 REVISION — ENGINE HARDENING — IMPLEMENTATION SUMMARY

## 1. Updated Scoring Formula (Final Version)

**Component caps (before computing score):**
- `sharedCollectionCount = min(rawSharedCollections, 3)`
- `sharedTagCount = min(rawSharedTags, 5)`

**Price proximity (bounded, max contribution 5):**
- `priceDelta = abs(product.price.amount - cartAveragePrice)` (cents)
- `rawProximity = max(0, 10000 - priceDelta) / 2000`
- `priceProximityScore = min(5, rawProximity)`

**Final score:**
```
score = (3 × sharedCollectionCount) + (2 × sharedTagCount) + (1 × priceProximityScore) − (2 × sameVendorPenalty)
```

- Overlap weights (collections, tags) dominate; price cannot exceed 5 points.
- No runaway inflation from highly tagged products (tag count capped at 5 for scoring).

---

## 2. Updated BEST_SELLING Flow Logic

1. **Eligible set:** All in-stock products not in cart (from strategy catalog).

2. **Enrich:** Map each to `{ product, score, sharedCollectionCount, sharedTagCount, priceDelta, salesCount, createdAt }` via single pass (no score or salesCount read inside sort).

3. **Density guard:**
   - `maxSales = max(salesCount over eligible)`
   - `minSales = min(salesCount over eligible)`
   - If `(maxSales - minSales) <= 1`:
     - Restrict eligibility to **COLLECTION_MATCH**: only products that share at least one collection with the cart.
     - If cart has no collections, use full eligible set (no further restriction).
     - Sort by: **score descending**, then **salesCount descending**, then **product.id ascending**.
   - Else:
     - Sort by: **salesCount descending**, then **score descending** (via `compareScoreThenId`), then **product.id ascending** inside tiebreaker.

4. **Slice** by `MAX_CROSS_SELL_ITEMS` (8).

5. **Decision log:** Message indicates either "BEST_SELLING density guard: collection overlap eligibility, score then salesCount tie-break." or "Selected cross-sell by sales count (BEST_SELLING), ties broken by score."

---

## 3. Example Scenario: Density Guard Activation

**Setup:**
- Cart: one item, product in collection `c1`.
- Catalog: A (c1, salesCount 1), B (c1, salesCount 1), C (c2, salesCount 1).
- Strategy: BEST_SELLING.

**Computation:**
- Eligible (in-stock, not in cart): A, B, C.
- `maxSales = 1`, `minSales = 1` → `maxSales - minSales = 0` → **density guard activates**.
- Cart has collections `{ c1 }` → restrict to collection overlap: A, B only (C excluded).
- Score and sort A, B; then slice.
- **Result:** C never appears; ordering is by score then salesCount then id. Stable and deterministic.

---

## 4. Validation Checklist

| # | Requirement | Status |
|---|-------------|--------|
| 1 | Price influence never exceeds 5 points | ✅ `priceProximityScore = min(5, rawProximity)`; rawProximity ≤ 5 when priceDelta ≥ 0. |
| 2 | Products with extreme tag counts do not dominate unfairly | ✅ `sharedTagCount = min(raw, 5)`; collection count capped at 3. |
| 3 | TAG_MATCH never returns empty solely due to no cart tags | ✅ When `cartTags.size === 0`, eligibility degrades to COLLECTION_MATCH (collection overlap); empty only if no cart collections or no overlap. |
| 4 | BEST_SELLING stable when salesCounts are uniform | ✅ When `maxSales - minSales <= 1`, density guard uses collection-overlap eligibility and score/salesCount/id sort. |
| 5 | Identical score and strategy tier sort by product.id | ✅ All strategy branches use `compareScoreThenId` or explicit `product.id.localeCompare` as final tiebreaker. |
| 6 | No performance regression for ≤200 candidates | ✅ Single enrich pass, single sort, no recomputation in comparator; caps are O(1). |
| 7 | crossSellDebug still reports correct score and components | ✅ Debug built from same enriched array (sharedCollectionCount, sharedTagCount, score, priceDelta, salesCount). |

---

## 5. No UI or External API Logic Altered

- **UI:** No changes. No new components, no response shape change for normal (non-debug) responses.
- **External API:** Decision response contract unchanged; `crossSell`, `freeShippingRemaining`, `suppressCheckout`, `milestones`, `enableCouponTease`, `ui` unchanged. Optional `crossSellDebug` still only when `CART_PRO_DEBUG=1`.
- **Route/catalog:** No changes in this revision; engine-only hardening.

---

## 6. Code Changes Summary

**revstack/packages/decision-engine/src/decideCartActions.ts**

- **Revision 1:** Replaced `priceProximityScore`: divisor 2000, cap 5; removed old 1000 divisor.
- **Revision 2:** In `scoreProduct`, cap `sharedCollectionCount` at 3 and `sharedTagCount` at 5 before computing score.
- **Revision 3:** TAG_MATCH when `cartTags.size === 0`: use COLLECTION_MATCH eligibility (collection overlap), same sort (score then id); empty only if no cart collections.
- **Revision 4:** BEST_SELLING: compute max/min salesCount on eligible; if spread ≤ 1, restrict to collection overlap then sort by score, salesCount, id; else sort by salesCount, score, id. All using stored values.
- **Revision 5:** Introduced `compareScoreThenId`; every strategy sort ends with product.id ascending tiebreaker.
- **Revision 6:** Enriched type `Scored` with `sharedCollectionCount`, `sharedTagCount`, `salesCount`, `createdAt`; `scoreCandidates()` sets all; comparators use only stored fields (no score or salesCount from product in sort).

**revstack/packages/decision-engine/tests/decideCartActions.test.ts**

- TAG_MATCH test renamed to "no product shares a tag"; added "TAG_MATCH degrades to collection overlap when cart has no tags"; added "BEST_SELLING density guard uses collection overlap when sales spread <= 1".

No additional improvements. No architectural expansion. No speculative tuning. Deterministic and finalized engine behavior only.
