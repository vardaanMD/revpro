# PHASE 2 — STRATEGY-FIRST SCORING ENGINE — IMPLEMENTATION SUMMARY

## 1. Updated decideCrossSell Logic Description

The cross-sell path is now:

1. **Build cart context once**  
   From `cart` + `catalog`: `cartProductIds`, `cartCollections`, `cartTags`, `cartVendors`, `cartAveragePrice` (all deterministic, no I/O).

2. **Eligibility by strategy**  
   - **COLLECTION_MATCH** (and default): only products that share at least one collection with the cart; exclude if no cart collections.  
   - **TAG_MATCH**: only products that share at least one tag with the cart; exclude if cart has no tags.  
   - **MANUAL_COLLECTION**: all in-strategy catalog products that are in-stock and not in cart (no overlap required).  
   - **BEST_SELLING**: all in-stock products not in cart.  
   - **NEW_ARRIVALS**: all in-stock products not in cart.

3. **Score each candidate**  
   `scoreProduct(product, cartContext)` returns a numeric score (see formula below). Same inputs always yield the same score.

4. **Sort by strategy dominance, then score**  
   - COLLECTION_MATCH / TAG_MATCH: sort by `score` descending, then slice.  
   - MANUAL_COLLECTION: Tier 1 = shares a collection with cart, Tier 2 = no overlap; within each tier sort by `score` descending, then slice.  
   - BEST_SELLING: sort by `salesCount` descending, then by `score` descending for ties, then slice.  
   - NEW_ARRIVALS: sort by `createdAt` descending, then by `score` descending for ties, then slice.

5. **Slice and return**  
   Take the first `MAX_CROSS_SELL_ITEMS` (8) from the sorted list. The route applies `effectiveLimit` on top of this.

No randomness, no silent fallback ordering. Strategy fully determines eligibility and primary ordering; score only refines within that.

---

## 2. Final Scoring Formula

**Unified score (relevance refinement only):**

```
score = (3 × sharedCollectionCount) + (2 × sharedTagCount) + (1 × priceProximityScore) − (2 × sameVendorPenalty)
```

- **sharedCollectionCount**: number of product collections that appear in `cartContext.cartCollections`.  
- **sharedTagCount**: number of product tags that appear in `cartContext.cartTags`.  
- **priceProximityScore**:  
  - `priceDelta = product.price.amount - cartContext.cartAveragePrice` (cents).  
  - `priceProximityScore = max(0, 10000 - |priceDelta|) / 1000`.  
  - Clamped so smaller distance from cart average gives higher score.  
- **sameVendorPenalty**: 1 if `product.vendor` is in `cartContext.cartVendors`, else 0; multiplied by 2 in the formula.

Constants in code (no config):

- `WEIGHT_SHARED_COLLECTION = 3`  
- `WEIGHT_SHARED_TAG = 2`  
- `WEIGHT_PRICE_PROXIMITY = 1`  
- `PENALTY_SAME_VENDOR = 2`  
- `PRICE_PROXIMITY_SCALE = 10000`, `PRICE_PROXIMITY_DIVISOR = 1000`

---

## 3. Example Ranking Scenario (3 Products)

**Cart:** one item, price 50¢. So `cartAveragePrice = 50`, `cartCollections = {"c1"}`, `cartTags = {"t1"}`.

| Product | Price | Collections | Tags   | Vendor in cart? |
|--------|-------|-------------|--------|------------------|
| A      | 45¢   | [c1]        | [t1]   | No               |
| B      | 200¢  | [c1]        | []     | Yes              |
| C      | 55¢   | [c1, c2]    | [t1,t2]| No               |

- **A**: sharedCollections=1, sharedTags=1, priceDelta=-5 → priceProximity = (10000−5)/1000 = 9.995, vendorPenalty=0 → **score = 3+2+9.995−0 = 14.995**.  
- **B**: sharedCollections=1, sharedTags=0, priceDelta=150 → priceProximity = (10000−150)/1000 = 9.85, vendorPenalty=2 → **score = 3+0+9.85−2 = 10.85**.  
- **C**: sharedCollections=2, sharedTags=2, priceDelta=5 → priceProximity = (10000−5)/1000 = 9.995, vendorPenalty=0 → **score = 6+4+9.995−0 = 19.995**.

**Order (score descending):** C, A, B.

---

## 4. Validation Checklist

| # | Requirement | Status |
|---|-------------|--------|
| 1 | COLLECTION_MATCH never returns products without collection overlap | ✅ Eligible set is filtered by `product.collections ∩ cartCollections ≠ ∅`; only those are sorted and sliced. |
| 2 | TAG_MATCH never returns products without tag overlap | ✅ Eligible set is filtered by `product.tags ∩ cartTags ≠ ∅`. If cart has no tags, eligible is empty and cross-sell is []. |
| 3 | MANUAL_COLLECTION returns products even if no cart overlap | ✅ Eligibility is in-stock and not in cart only. Tiering (overlap vs no overlap) only affects order, not inclusion. |
| 4 | BEST_SELLING ordering differs from COLLECTION_MATCH when overlap exists | ✅ BEST_SELLING sorts by salesCount then score; COLLECTION_MATCH sorts by score only. Different primary key. |
| 5 | NEW_ARRIVALS ordering strictly respects createdAt | ✅ Sort is by createdAt DESC, then score DESC for ties. |
| 6 | Within same salesCount or createdAt group, ranking is score-based | ✅ Comparator uses score as tie-breaker in both BEST_SELLING and NEW_ARRIVALS. |
| 7 | No randomness across identical requests | ✅ No random or time-based input; same (cart, catalog, strategy) → same crossSell order. |
| 8 | Limits still enforced correctly | ✅ Slice(0, MAX_CROSS_SELL_ITEMS) in engine; route applies effectiveLimit on top. |
| 9 | Performance acceptable for ≤200 candidate products | ✅ Single pass for cart context, one score pass per candidate, one sort; no extra I/O. |

---

## 5. Performance Considerations

- **Cart context**: One O(cart.items × product lookup) pass; product lookup is O(1) via Map from catalog.  
- **Scoring**: O(eligible) with small constant (set lookups, arithmetic).  
- **Sort**: O(n log n) on eligible set (n ≤ 200).  
- No randomness, no async, no config reads inside the engine.  
- Debug: when `CART_PRO_DEBUG=1`, `crossSellDebug` is built from the same `eligible` array already in memory (slice of top N); no extra scoring pass.

---

## 6. Files Touched

- **revstack/packages/decision-engine/src/types.ts**  
  - Product: optional `tags`, `vendor`, `createdAt`, `salesCount`.  
  - New: `CartContext` interface.  
- **revstack/packages/decision-engine/src/decideCartActions.ts**  
  - `buildCartContext(cart, catalog)`.  
  - `scoreProduct(product, cartContext)` (exported).  
  - `priceProximityScore(priceDelta)`.  
  - `decideCrossSell` refactored: strategy-based eligibility, score attachment, strategy-dominant sort, then slice.  
  - Optional `debug` → `crossSellDebug` in return.  
  - Removed: price-only sort, `determineCartCollections` (replaced by cartContext).  
- **revstack/app/lib/catalog-index.server.ts**  
  - `productLiteToProduct`: pass through `createdAt` when present.  
- **revstack/app/routes/cart.decision.ts**  
  - BEST_SELLING: attach `salesCount` to each product instead of pre-sorting catalog.  
  - Pass `debug: process.env.CART_PRO_DEBUG === "1"` into `decideCartActions`.  
  - Include `crossSellDebug` in response when present.  
- **revstack/app/lib/decision-response.server.ts**  
  - `DecisionResponse`: optional `crossSellDebug`; added `CrossSellDebugEntry` type.  
- **revstack/packages/decision-engine/tests/decideCartActions.test.ts**  
  - New tests: COLLECTION_MATCH no non-overlap, TAG_MATCH empty when no cart tags, NEW_ARRIVALS order, deterministic order, debug returns crossSellDebug.

No UI changes. No new features beyond the scoring model and explainability. No hyperparameter tuning.
