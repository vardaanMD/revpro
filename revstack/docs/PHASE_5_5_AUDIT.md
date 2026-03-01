# Phase 5.5 — Audit (pre-implementation)

## 1. DecisionMetric Prisma model

**Location:** `revstack/prisma/schema.prisma` (lines 69–75)

**Current schema:**
```prisma
model DecisionMetric {
  id           String   @id @default(cuid())
  shopDomain   String
  hasCrossSell Boolean
  cartValue    Int
  createdAt    DateTime @default(now())
}
```

- **Indexes:** None. `shopDomain` is NOT indexed.
- **Session identity:** None. Only shop + cart-level aggregate (hasCrossSell, cartValue).

## 2. Where DecisionMetric is written

**Location:** `revstack/app/routes/cart.decision.ts` (lines 414–422)

**When:** After building the decision response and setting the cache, before returning the response. One row per decision request.

**Logic:**
- `shopDomain` = `shop` (from request URL search param)
- `hasCrossSell` = `response.crossSell.length > 0`
- `cartValue` = `validatedCart.total_price` (cents)
- Wrapped in try/catch; errors swallowed so the response is not blocked.

## 3. cart-pro.js add-to-cart for recommendations

**Location:** `revstack/extensions/cart-pro/assets/cart-pro.js`

**Relevant block:** ~lines 612–632. On "Add to cart" click for a recommendation:
- Uses `adapter.addToCart(vid, 1)` with `vid` from `addBtn.getAttribute("data-variant-id")`.
- No analytics or tracking; no call to any analytics endpoint.

**Recommendation object shape:** From decision response `crossSell` (array of `Product`). Each has `id`, `variantId`, `handle`, `imageUrl`, `title`, `price`, etc. Product `id` is the product ID (string).

## 4. Existing analytics code

- **app.analytics route:** Does not exist.
- **Cross-sell event/conversion tables:** Do not exist.
- **Analytics aggregation:** None.
- **Other:** `app.upgrade.tsx` / `capabilities.server.ts` mention "analytics" in plan descriptions only; `attribution.ts` and `ingestion/decision.ts` in decision-engine are reserved for future pipeline, not wired.

## 5. Summary

| Item | Status |
|------|--------|
| DecisionMetric schema | Exists; no index on shopDomain |
| DecisionMetric write | Once per decision; non-blocking |
| Cross-sell impression tracking | Missing |
| Cross-sell click tracking | Missing |
| Cross-sell conversion tracking | Missing |
| Checkout influence tracking | Missing |
| Session identity | None |
| Analytics aggregation | Missing |
| /app/analytics route | Missing |

---

**Next:** Proceed with Phase 5.5 implementation (schema, event endpoint, impressions, clicks/conversions, aggregation, analytics route).

---

## Retention policy (Phase 5.5)

- **Rule:** Keep analytics rows (CrossSellEvent, CrossSellConversion) **90 days**.
- **Cleanup job:** To be added later. Documented in Prisma schema comments. Do NOT implement cron in this phase.
