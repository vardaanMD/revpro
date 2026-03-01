# Phase 1 — Integrity Hardening: Implementation Summary

## 1. Code-level summary of changes

### TASK 1 — Coupon tease wiring

- **`revstack/extensions/cart-pro/assets/cart-pro.js`**
  - **`updateCouponBanner()`**: Uses `decisionState.enableCouponTease` instead of `sectionConfig.enableCouponTease`. Visibility is `true` only when `decisionState && decisionState.enableCouponTease === true`.
  - **`sectionConfig`**: Removed `enableCouponTease`; added comment that coupon tease is driven only by the decision API.
  - **`applyDecisionDelta()`**: Calls `updateCouponBanner()` after applying a new decision so the banner updates when the decision response arrives.

- **Backend**: Unchanged. `cart.decision.ts` already sets `enableCouponTease: capabilities.allowCouponTease && config.enableCouponTease` (Basic → false via capabilities, Advanced+ → config toggle).

### TASK 2 — Real BEST_SELLING strategy

- **`revstack/prisma/schema.prisma`**
  - New model **`ProductSaleEvent`**: `id`, `shopDomain`, `productId`, `quantity`, `soldAt`. Indexes: `(shopDomain, soldAt)`, `(shopDomain, productId)`.

- **`revstack/prisma/migrations/20260220000000_add_product_sale_event/migration.sql`**
  - Creates `ProductSaleEvent` table and indexes.

- **`revstack/app/lib/product-metrics.server.ts`** (new)
  - **`recordOrderSales(shopDomain, lineItems)`**: Appends rows to `ProductSaleEvent` for each line item (productId, quantity).
  - **`getProductSalesCounts30d(shopDomain)`**: Returns `Record<productId, number>` of total quantity sold in the last 30 days (via `groupBy` + `_sum.quantity`).

- **`revstack/app/routes/webhooks.orders.tsx`** (new)
  - Handles `orders/paid` webhook; parses `line_items` for `product_id` and `quantity`; calls `recordOrderSales(shop, items)`.

- **`revstack/shopify.app.toml`**
  - New webhook subscription: `topics = ["orders/paid"]`, `uri = "/webhooks/orders"`.

- **`revstack/app/routes/cart.decision.ts`**
  - Imports `getProductSalesCounts30d`.
  - After `resolveStrategyCatalogFromIndex(..., "BEST_SELLING", ...)`: fetches `getProductSalesCounts30d(shop)`; if no sales data (`!hasAnySales`), falls back to `resolveStrategyCatalogFromIndex(..., "COLLECTION_MATCH", ...)` and logs; otherwise sorts catalog by `(salesCounts[b.id] ?? 0) - (salesCounts[a.id] ?? 0)` (DESC).

- **`revstack/packages/decision-engine/src/decideCartActions.ts`**
  - **`decideCartActions`**: Optional `strategy` parameter.
  - **`decideCrossSell(cart, catalog, strategy)`**: When `strategy === "BEST_SELLING"` (or `"NEW_ARRIVALS"`): eligible = in stock + not in cart only (no collection filter); preserves catalog order; slices to `MAX_CROSS_SELL_ITEMS`.

- **`revstack/app/routes/cart.decision.ts`**
  - Passes `strategy: effectiveStrategy` into `decideCartActions(...)`.

### TASK 3 — Real NEW_ARRIVALS strategy

- **`revstack/app/lib/catalog.server.ts`**
  - GraphQL query: added `createdAt` to product node.
  - **ProductNode**: added `createdAt?: string | null`.
  - When building `Product[]`: sets `createdAt` on each product when present.

- **`revstack/app/lib/catalog-warm.server.ts`**
  - **MinimalProduct**: optional `createdAt?: string`.
  - **productToMinimal**: copies `createdAt` from product when present.

- **`revstack/app/lib/catalog-index.server.ts`**
  - **ProductLite**: optional `createdAt?: string`.
  - **minimalToProductLite**: copies `createdAt` from MinimalProduct.
  - **resolveStrategyCatalogFromIndex** for **`NEW_ARRIVALS`**: sorts `crossSellCandidates` by `createdAt` DESC (`cb.localeCompare(ca)`), then maps to `Product[]`.

- **Decision engine**: For `strategy === "NEW_ARRIVALS"`, `decideCrossSell` treats catalog as pre-sorted (in-stock, not in cart only; order preserved).

### TASK 4 — Manual collection behavior

- **`revstack/packages/decision-engine/src/decideCartActions.ts`**
  - New branch for `strategy === "MANUAL_COLLECTION"` in `decideCrossSell`:
    - Eligible = all catalog products that are in stock and not in cart (no requirement for cart–collection overlap).
    - Sorts by: overlapping (product in a cart collection) first, then by price DESC.
    - Never returns empty solely due to “no overlap”; if catalog has in-stock, not-in-cart products from manual collections, at least those are returned.

---

## 2. Updated strategy logic flow

1. **Config + billing**: Load config; get billing context; `effectiveStrategy = capabilities.allowStrategySelection ? config.recommendationStrategy : "COLLECTION_MATCH"`.
2. **Catalog from index**: `strategyCatalog = resolveStrategyCatalogFromIndex(index, effectiveStrategy, cart, manualCollectionIds)`.
   - **COLLECTION_MATCH**: All cross-sell candidates (order unchanged).
   - **MANUAL_COLLECTION**: Products from `manualCollectionIds` collections only.
   - **TAG_MATCH**: Products matching cart item tags (or fallback to all candidates).
   - **BEST_SELLING**: Same candidate set as COLLECTION_MATCH; then (below) sorted by 30d sales.
   - **NEW_ARRIVALS**: Same candidates sorted by `createdAt` DESC in index layer.
3. **BEST_SELLING post-step**: If `effectiveStrategy === "BEST_SELLING"`: fetch `getProductSalesCounts30d(shop)`; if no sales data, replace `strategyCatalog` with COLLECTION_MATCH catalog and log; else sort `strategyCatalog` by sales count DESC.
4. **Engine**: `decideCartActions({ cart, catalog: strategyCatalog, storeMetrics, strategy: effectiveStrategy })`.
   - **COLLECTION_MATCH / default**: Cross-sell = in stock, not in cart, share a collection with cart; sort by price DESC; slice.
   - **BEST_SELLING / NEW_ARRIVALS**: Cross-sell = in stock, not in cart; preserve catalog order; slice.
   - **MANUAL_COLLECTION**: Cross-sell = in stock, not in cart; sort by overlap then price DESC; slice.
5. **Response**: Apply recommendation limit and capabilities; set `enableCouponTease: capabilities.allowCouponTease && config.enableCouponTease`.

---

## 3. Schema additions (sales metrics)

- **ProductSaleEvent** (new table)
  - `id` (TEXT, PK)
  - `shopDomain` (TEXT)
  - `productId` (TEXT)
  - `quantity` (INT)
  - `soldAt` (TIMESTAMP, default now)
  - Indexes: `(shopDomain, soldAt)`, `(shopDomain, productId)`

---

## 4. Migration needed

- **Yes.** Run:
  - `npx prisma migrate deploy` (or `prisma migrate dev` for dev) to apply `20260220000000_add_product_sale_event/migration.sql`.

---

## 5. Validation checklist

| # | Item | Status |
|---|------|--------|
| 1 | Coupon tease toggle affects storefront deterministically | **Done**: Storefront uses `decisionState.enableCouponTease` only; no Liquid/section fallback. Toggle OFF → no banner; ON + Advanced+ → banner when milestone condition met. Basic → always false via capabilities. |
| 2 | BEST_SELLING produces different output ordering than COLLECTION_MATCH | **Done**: BEST_SELLING sorts by 30d sales DESC; COLLECTION_MATCH uses collection overlap + price. When no sales data, fallback to COLLECTION_MATCH is logged. |
| 3 | NEW_ARRIVALS produces newest-first ordering | **Done**: Catalog index sorts by `createdAt` DESC for NEW_ARRIVALS; engine preserves order. |
| 4 | Manual collection never returns empty solely due to overlap absence | **Done**: MANUAL_COLLECTION branch treats all in-stock, not-in-cart catalog products as eligible; overlap only affects ranking. |
| 5 | Basic plan gating still enforced | **Done**: `enableCouponTease` and strategy selection remain gated by `getBillingContext` capabilities (`allowCouponTease`, `allowStrategySelection`). |
| 6 | No regression in cross-sell filtering, limits, milestones, free shipping logic | **Done**: Limits and milestones applied after engine; free shipping and other decision fields unchanged; COLLECTION_MATCH and TAG_MATCH behavior unchanged. |

---

## Files touched (concise)

- **Storefront**: `revstack/extensions/cart-pro/assets/cart-pro.js`
- **Decision route**: `revstack/app/routes/cart.decision.ts`
- **Catalog**: `revstack/app/lib/catalog.server.ts`, `revstack/app/lib/catalog-warm.server.ts`, `revstack/app/lib/catalog-index.server.ts`
- **Product metrics**: `revstack/app/lib/product-metrics.server.ts` (new)
- **Webhook**: `revstack/app/routes/webhooks.orders.tsx` (new), `revstack/shopify.app.toml`
- **Engine**: `revstack/packages/decision-engine/src/decideCartActions.ts`
- **Schema**: `revstack/prisma/schema.prisma`, `revstack/prisma/migrations/20260220000000_add_product_sale_event/migration.sql`
- **Tests**: `revstack/tests/cart.decision.integration.test.ts` (Prisma + product-metrics mocks)
