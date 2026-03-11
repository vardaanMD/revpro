# Multi-Currency Implementation Plan

This document outlines the plan to implement multi-currency support across the revPRO/revstack codebase and remove hardcoded USD dependency. All monetary values remain in **cents**; only the currency code used for display and catalog/index alignment changes.

---

## 1. Goals

- **Remove hardcoded USD** wherever "shop currency" is implied (catalog, index, dashboard, settings, preview).
- **Use shop primary currency** for backend flows (catalog fetch, index, dashboard metrics, settings preview).
- **Keep decision path cart-driven**: storefront already sends `cart.currency`; decision engine and runtime already use it. No change to decision logic.
- **Backward compatible**: existing shops continue to work; USD remains the fallback when currency is unknown.

---

## 2. Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| **Source of shop currency** | Store `primaryCurrency` on `ShopConfig`, sync from Shopify Admin `shop.currencyCode` | Single source of truth; no extra Admin API call on every request; already load config in decision/settings/dashboard. |
| **When to sync currency** | On first config load that has Admin API (e.g. settings, dashboard), plus optional `shop/update` webhook | Avoids new install flow; works for existing shops when they open app. |
| **Fallback** | `primaryCurrency ?? "USD"` everywhere | Safe for existing rows (null) and for shops where sync hasn’t run yet. |
| **Cart vs shop currency** | Decision uses **cart** currency (unchanged). Catalog/index use **shop** primary currency. | For single-currency shops they match; multi-currency storefronts already send cart currency; no conversion in engine. |
| **Snapshot** | Add optional `currency` to V3 snapshot | Runtime can use it as fallback before cart is loaded. |

---

## 3. Current State Summary

- **Already multi-currency**: Decision route uses `validatedCart.currency` for `storeMetrics` and `toMoney()`. Storefront sends cart currency; runtime uses `cart?.raw?.currency ?? 'USD'`.
- **Hardcoded USD** appears in:
  - Catalog: `getCatalogForShop(..., "USD")`, `warmCatalogForShop` → `"USD"`, `buildCatalogIndexFromSnapshot(payload, "USD")`.
  - buildSnapshot: `const CURRENCY = "USD"` and `buildCatalogIndexFromDbRows` returning `currency: CURRENCY`.
  - Dashboard: `app._index.tsx` and `app.analytics.tsx` use `process.env.STORE_CURRENCY ?? "USD"`.
  - Settings/onboarding: `getCatalogForShop(..., "USD")`, label "Free shipping threshold (USD)".
  - Preview: `preview-simulator.server.ts` and `CartPreview.tsx` use `"USD"`.

---

## 4. Implementation Phases

### Phase 1: Data model and shop currency resolution

**1.1 Database**

- **File**: `revstack/prisma/schema.prisma`
  - Add to `ShopConfig`:
    - `primaryCurrency String?` (e.g. `"USD"`, `"EUR"`). Null = not yet synced; treat as USD for backward compat.
- **Migration**: New migration (e.g. `add_primary_currency_to_shop_config`) that adds the column. No backfill required; app logic uses `?? "USD"`.

**1.2 Default config**

- **File**: `revstack/app/lib/default-config.server.ts`
  - Add `primaryCurrency: null` (or omit; Prisma null by default) to `DEFAULT_SHOP_CONFIG` if you use it for create. If `DEFAULT_SHOP_CONFIG` is only for fallback, ensure fallback includes `primaryCurrency: "USD"` so type is consistent.

**1.3 Fallback config**

- **File**: `revstack/app/lib/shop-config.server.ts`
  - In `getFallbackShopConfig`, set `primaryCurrency: "USD"` (or leave undefined and handle in helpers) so fallback config always has a safe currency.

**1.4 Shopify Admin: fetch and persist shop currency**

- **New file** (recommended): `revstack/app/lib/shop-currency.server.ts`
  - `getShopCurrencyFromAdmin(admin: AdminGraphQL): Promise<string>`  
    - Run GraphQL `query { shop { currencyCode } }`, return `data.shop.currencyCode` or `"USD"` on error.
  - `ensureShopCurrencySynced(shop: string, admin: AdminGraphQL): Promise<string>`  
    - Call `getShopCurrencyFromAdmin(admin)`. If result differs from `config.primaryCurrency` or `config.primaryCurrency` is null, `prisma.shopConfig.update({ where: { shopDomain: shop }, data: { primaryCurrency: currency } })`, then `invalidateShopConfigCache(shop)`. Return the currency code.
  - This keeps "sync" logic in one place; callers just call `ensureShopCurrencySynced` when they have admin (e.g. settings loader).

**1.5 Helper for "currency to use for this shop"**

- **File**: `revstack/app/lib/shop-currency.server.ts` (same file)
  - `getShopCurrency(config: ShopConfig): string`  
    - Return `(config as any).primaryCurrency ?? "USD"` (or use proper type after Prisma generate). Use this everywhere we currently hardcode `"USD"` for shop context.

---

### Phase 2: Catalog and index (backend)

**2.1 Catalog fetch**

- **File**: `revstack/app/lib/catalog.server.ts`
  - Keep signature `getCatalogForShop(admin, shop, currency, request?)`. Callers (below) will pass shop currency instead of `"USD"`.

**2.2 Catalog warm**

- **File**: `revstack/app/lib/catalog-warm.server.ts`
  - In `warmCatalogForShop(shop)`:
    - Load config: `const config = await getShopConfig(shop)` (or get only currency if you add a lighter helper).
    - `const currency = getShopCurrency(config)`.
    - Replace `getCatalogForShop(auth, shop, "USD")` with `getCatalogForShop(auth, shop, currency)`.
    - Replace `buildCatalogIndexFromSnapshot(payload, "USD")` with `buildCatalogIndexFromSnapshot(payload, currency)`.
  - Ensure `buildCatalogIndexFromSnapshot` is still called with the same currency used for the catalog (no logic change inside `catalog-index.server.ts`).

**2.3 buildSnapshot (V2 bootstrap / collection-aware)**

- **File**: `revstack/app/lib/upsell-engine-v2/buildSnapshot.ts`
  - Remove `const CURRENCY = "USD"`.
  - `buildCatalogIndexFromDbRows(rows, currency: string)`: add parameter `currency`, and in the returned object set `currency` to that parameter instead of `CURRENCY`.
  - All callers of `buildCatalogIndexFromDbRows` must pass shop currency:
    - In `buildBootstrapSnapshotV2(shop)`: get config (already loaded), then `const currency = getShopCurrency(config)`; pass `currency` into `buildCatalogIndexFromDbRows(rows, currency)`.
    - In `buildCollectionAwareRecommendations(shop)`: same — get config, `getShopCurrency(config)`, pass into `buildCatalogIndexFromDbRows(rows, currency)`.
  - Any other internal use of a single "USD" constant in this file should be replaced with the same `currency` variable derived from config.

**2.4 Catalog index (Redis) consumer**

- **File**: `revstack/app/lib/catalog-index.server.ts`
  - No signature change. Index already has `currency`; it will now be the shop’s primary currency once Phase 2.2 and 2.3 are done. Decision route already uses cart currency for storeMetrics and uses index for catalog; for single-currency shops they match.

---

### Phase 3: Decision route (verification only)

- **File**: `revstack/app/routes/cart.decision.ts`
  - No code change. It already uses `validatedCart.currency` for cart items and `storeMetrics`. Confirm tests still pass.

---

### Phase 4: Dashboard and analytics (admin UI)

**4.1 Dashboard**

- **File**: `revstack/app/routes/app._index.tsx`
  - Loader already gets `config` via `getShopConfig(shop)`. Replace:
    - `const currency = (process.env.STORE_CURRENCY ?? FALLBACK_CURRENCY).trim() || FALLBACK_CURRENCY`
    - with `const currency = getShopCurrency(config)` (and remove or keep `STORE_CURRENCY` as override only if desired).
  - Ensure `getShopCurrency` is imported from `~/lib/shop-currency.server`.

**4.2 Analytics**

- **File**: `revstack/app/routes/app.analytics.tsx`
  - Load config for the shop (if not already), then use `getShopCurrency(config)` instead of `const CURRENCY = process.env.STORE_CURRENCY ?? "USD"`.

---

### Phase 5: Settings and onboarding (admin UI)

**5.1 Settings loader**

- **File**: `revstack/app/routes/app.settings.tsx`
  - Loader has `admin` and `config`. Call `ensureShopCurrencySynced(shop, admin)` early (so `config` in cache may get updated for next read, or re-read config after sync). Then get currency with `getShopCurrency(config)` (or from return value of `ensureShopCurrencySynced`).
  - Replace `getCatalogForShop(admin, shop, "USD", request)` with `getCatalogForShop(admin, shop, currency, request)`.

**5.2 Onboarding**

- **File**: `revstack/app/routes/app.onboarding.tsx`
  - Replace label "Free shipping threshold (USD)" with "Free shipping threshold" and helper text like "Amount in your store currency" or "({{ currency }})". Use shop currency from config (or ensure sync runs on onboarding and use `getShopCurrency(config)`).

---

### Phase 6: Preview and mock UI

**6.1 Preview simulator**

- **File**: `revstack/app/lib/preview-simulator.server.ts`
  - Accept optional `currency` argument where you build the mock (or load config by shop and use `getShopCurrency(config)`). Replace `const currency = "USD"` and any `getCatalogForShop(..., "USD")` with that currency.

**6.2 CartPreview component**

- **File**: `revstack/app/components/CartPreview.tsx`
  - Remove `const CURRENCY = "USD"`. Receive `currency` as a prop (from parent that gets it from loader using `getShopCurrency(config)`). Use it in `formatMoney` and in mock recommendation objects (`currency: currency`).

**6.3 Settings page preview**

- **File**: `revstack/app/routes/app.settings.tsx`
  - When rendering `CartPreview` (or equivalent), pass `currency={getShopCurrency(config)}` (or the variable set in loader from `ensureShopCurrencySynced` / `getShopCurrency`).

---

### Phase 7: Snapshot and runtime (storefront)

**7.1 Snapshot V3**

- **File**: `revstack/app/routes/cart.snapshot.v3.ts`
  - When building `snapshotPayload`, add top-level `currency: getShopCurrency(shopConfig)` (or from merged config). Ensure `buildV3SnapshotPayload` or the snapshot shape allows an optional `currency` field so the runtime can read it.

**7.2 Runtime config schema / default**

- **File**: `revstack/cart-pro-v3-runtime/src/engine/configSchema.ts` (or equivalent)
  - Add optional `currency?: string` to the snapshot/config type if not already present.

- **File**: `revstack/cart-pro-v3-runtime/src/engine/normalizeConfig.ts` (or defaultConfig)
  - Ensure default/fallback for `currency` is `"USD"` so existing snapshots without the field still work.

**7.3 Runtime UI components**

- **Files**: e.g. `DrawerV2.svelte`, `Recommendations.svelte`, `Milestones.svelte`, `CartItem.svelte`, `RecommendationCard.svelte`, `ShippingSection.svelte`, `CheckoutSection.svelte`, `CartItems.svelte`
  - Current pattern: `currency = cart?.raw?.currency ?? 'USD'`. Change to: `currency = cart?.raw?.currency ?? snapshotCurrency ?? 'USD'` where `snapshotCurrency` is read from normalized config/snapshot (e.g. `state?.snapshot?.currency` or engine config). This gives a correct fallback before cart is loaded.

---

### Phase 8: Validation and defaults

- **File**: `revstack/app/lib/validation.server.ts`
  - Keep `currency` optional with `.default("USD")` for backward compatibility. No change required.

- **File**: `revstack/cart-pro-v3-runtime/src/engine/decisionApi.ts`
  - Keep fallback `cartRaw?.currency ?? 'USD'` when building decision body. No change required.

---

## 5. File Checklist (quick reference)

| Area | File | Change |
|------|------|--------|
| Schema | `prisma/schema.prisma` | Add `primaryCurrency String?` to `ShopConfig` |
| Config | `app/lib/default-config.server.ts` | Add primaryCurrency to default/fallback if needed |
| Config | `app/lib/shop-config.server.ts` | Fallback config includes primaryCurrency |
| New | `app/lib/shop-currency.server.ts` | `getShopCurrency`, `getShopCurrencyFromAdmin`, `ensureShopCurrencySynced` |
| Catalog | `app/lib/catalog-warm.server.ts` | Use getShopCurrency(config), pass to getCatalogForShop and buildCatalogIndexFromSnapshot |
| Snapshot | `app/lib/upsell-engine-v2/buildSnapshot.ts` | Remove CURRENCY constant; buildCatalogIndexFromDbRows(rows, currency); callers pass getShopCurrency(config) |
| Dashboard | `app/routes/app._index.tsx` | currency = getShopCurrency(config) |
| Analytics | `app/routes/app.analytics.tsx` | currency from getShopCurrency(config) |
| Settings | `app/routes/app.settings.tsx` | ensureShopCurrencySynced + getShopCurrency; pass currency to getCatalogForShop and preview |
| Onboarding | `app/routes/app.onboarding.tsx` | Dynamic label/helper for threshold; use getShopCurrency where needed |
| Preview | `app/lib/preview-simulator.server.ts` | Use shop currency (from config) instead of "USD" |
| Preview | `app/components/CartPreview.tsx` | currency prop; use in formatMoney and mock data |
| Snapshot | `app/routes/cart.snapshot.v3.ts` | Add currency to payload from getShopCurrency(shopConfig) |
| Runtime | `cart-pro-v3-runtime` config/schema | Optional currency in snapshot; default "USD" |
| Runtime | `cart-pro-v3-runtime` UI (DrawerV2, etc.) | Fallback: snapshotCurrency ?? 'USD' when cart not yet loaded |

---

## 6. Testing

- **Unit**: Decision engine tests already use USD in fixtures; no change. Add a test that storeMetrics and cart use the same currency (e.g. EUR) and decision still runs.
- **Integration**: `cart.decision` integration test: optionally add a case with `currency: "EUR"` and assert response shape unchanged.
- **Manual**: Create a shop with non-USD primary currency (or temporarily set `primaryCurrency` in DB), open dashboard/settings, run catalog warm, trigger decision and snapshot; confirm amounts display in that currency and no USD assumptions in network payloads.
- **Backward compat**: Shops with `primaryCurrency = null` should behave as today (USD). New column nullable; no backfill required.

---

## 7. Rollout and Backward Compatibility

- Deploy migration first; then deploy app code. Existing rows have `primaryCurrency = null`; all helpers use `?? "USD"`.
- Optional: Background job or one-time script to call `ensureShopCurrencySynced` for all shops (with admin session or unauthenticated admin) to backfill `primaryCurrency`. Not required for correctness.
- Optional: Keep `STORE_CURRENCY` env in dashboard/analytics as override for support/debug (e.g. `process.env.STORE_CURRENCY ?? getShopCurrency(config)`).

---

## 8. Out of Scope (for later)

- **Currency conversion**: No conversion between currencies; engine and catalog assume one currency per evaluation (cart currency or shop primary).
- **Multi-currency presentment**: If Shopify sends multiple presentment currencies per shop, we still use cart currency in the decision and shop primary for catalog/index; no change to that contract.
- **Billing**: App billing in USD (or platform currency) is unchanged; this plan only affects storefront and merchant-facing display and catalog.

---

## 9. Order of Implementation

1. Phase 1 (schema, migration, shop-currency.server, getShopCurrency, ensureShopCurrencySynced).
2. Phase 2 (catalog warm, buildSnapshot).
3. Phase 4 (dashboard, analytics).
4. Phase 5 (settings, onboarding).
5. Phase 6 (preview, CartPreview).
6. Phase 7 (snapshot payload, runtime fallback).
7. Phase 3 (verify decision route).
8. Phase 8 (validation/defaults — already correct).

This order ensures the "source of truth" for shop currency exists before any consumer uses it, and backend (catalog/index) is updated before admin UI and storefront.
