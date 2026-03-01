# Phase 1 Multi-Tenant Hardening — Deliverable

## Summary

Canonical shop normalization is enforced at every boundary before any use of Prisma, Redis, or in-memory cache. No architecture refactor, no business-logic/analytics/billing/onboarding changes. Only boundary hardening.

---

## 1. Files Modified

| File | Purpose |
|------|---------|
| `revstack/app/lib/shop-domain.server.ts` | Added `warnIfShopNotCanonical()` (dev-only assertion) |
| `revstack/app/routes/app.tsx` | Normalize after `authenticate.admin()`; store normalized shop in context |
| `revstack/app/run-app-auth.server.ts` | Normalize after `authenticate.admin()`; pass normalized shop to `setAppLayoutInContext` |
| `revstack/app/shopify.server.ts` | In `afterAuth`: normalize `session.shop` before `warmCatalogForShop` and logWarn |
| `revstack/app/routes/webhooks.orders.tsx` | Normalize shop at entry; use for Prisma, recordWebhook, recordOrderSales |
| `revstack/app/routes/webhooks.billing.update.tsx` | Normalize shop at entry; use for Prisma, invalidateShopConfigCache |
| `revstack/app/routes/webhooks.products.tsx` | Normalize shop at entry; use for recordWebhook, warmCatalogForShop |
| `revstack/app/routes/webhooks.app.scopes_update.tsx` | Normalize shop at entry; use for recordWebhook |
| `revstack/app/routes/webhooks.app.uninstalled.tsx` | Normalize shop at entry; use for recordWebhook, Prisma session delete |
| `revstack/app/routes/webhooks.compliance.tsx` | Normalize shop at entry; use for recordWebhook |
| `revstack/app/routes/app._index.tsx` | Normalize in fallback path when using `session.shop` |
| `revstack/app/routes/app.analytics.tsx` | Normalize in fallback path when using `session.shop` |
| `revstack/app/routes/app.settings.tsx` | Normalize in loader fallback and in action when using `session.shop` |
| `revstack/app/routes/app.upgrade.tsx` | Normalize in loader fallback and in action when using `session.shop` |
| `revstack/app/routes/app.billing.tsx` | Normalize in fallback path when using `session.shop` |
| `revstack/app/routes/app.onboarding.tsx` | Normalize in loader fallback and in action when using `session.shop` |
| `revstack/app/routes/cart.analytics.event.ts` | Normalize shop from URL searchParams before Prisma/rate limit |
| `revstack/app/routes/cart.decision.ts` | Added dev-only `warnIfShopNotCanonical` (already had normalization) |

**Not modified:** `webhooks.shop.redact.tsx`, `webhooks.customers.redact.tsx`, `webhooks.customers.data_request.tsx` — they only call `authenticate.webhook` and return 200; no shop passed to Prisma/Redis. `auth.$.tsx` does not use shop for any storage. `safe-handler.server.ts` only logs shop in catch block (not a Prisma/Redis boundary).

---

## 2. Exact Lines Where Normalization Was Added

- **shop-domain.server.ts**: After `normalizeShopDomain` (end of file): new helper `warnIfShopNotCanonical(raw, normalized)`.
- **app.tsx**: After `const auth = await authenticate.admin(request)`: `rawShop = auth.session.shop`, `shop = normalizeShopDomain(rawShop)`, `warnIfShopNotCanonical(rawShop, shop)`; then `getShopConfig(shop)` and `setAppLayoutInContext(shop, ...)`.
- **run-app-auth.server.ts**: After `session.shop`: `rawShop = session.shop`, `shop = normalizeShopDomain(rawShop)`, `warnIfShopNotCanonical(rawShop, shop)`; then `getShopConfig(shop)`, `setAppLayoutInContext(shop, ...)`.
- **shopify.server.ts**: Start of `afterAuth`: `rawShop = session.shop`, `shop = normalizeShopDomain(rawShop)`, `warnIfShopNotCanonical(rawShop, shop)`; then `warmCatalogForShop(shop)` and `logWarn({ shop, ... })`.
- **webhooks.orders.tsx**: Right after `authenticate.webhook`: `rawShop` from destructured `shop`, `shop = normalizeShopDomain(rawShop)`, `warnIfShopNotCanonical(rawShop, shop)`.
- **webhooks.billing.update.tsx**: Same pattern at action entry.
- **webhooks.products.tsx**: Same pattern at action entry.
- **webhooks.app.scopes_update.tsx**: Same pattern; destructure `shop: rawShop`, then normalize.
- **webhooks.app.uninstalled.tsx**: Same pattern.
- **webhooks.compliance.tsx**: After resolving `rawShop` from auth or headers: `shop = normalizeShopDomain(rawShop)`, `warnIfShopNotCanonical(rawShop, shop)`.
- **app._index.tsx**: In else branch (fallback): `rawShop = session.shop`, `shop = normalizeShopDomain(rawShop)`, `warnIfShopNotCanonical(rawShop, shop)`.
- **app.analytics.tsx**: Same in else branch.
- **app.settings.tsx**: Loader else branch: `rawShop = auth.session.shop`, then normalize + warn; action: `rawShop = session.shop`, then normalize + warn.
- **app.upgrade.tsx**: Loader else branch and action: same pattern.
- **app.billing.tsx**: Loader else branch: same pattern.
- **app.onboarding.tsx**: Loader else branch: `rawShop = session.shop`, normalize + warn; action: `rawShop = auth.session.shop`, normalize + warn.
- **cart.analytics.event.ts**: After getting shop from URL: `rawShop = url.searchParams.get("shop")?.trim() ?? null`, `shop = rawShop !== null ? normalizeShopDomain(rawShop) : null`, `if (rawShop !== null) warnIfShopNotCanonical(rawShop, shop!)`.
- **cart.decision.ts**: After existing `shop = normalizeShopDomain(shopRaw)`: added `warnIfShopNotCanonical(shopRaw, shop)`.

---

## 3. Confirmation Checklist

- **All boundary entry points normalize shop:** Yes. Admin (app layout, run-app-auth, all child loaders/actions that use session), webhooks (orders, billing.update, products, app.scopes_update, app.uninstalled, compliance), afterAuth, cart.decision (already did), cart.analytics.event.
- **No raw `session.shop` flows into Prisma or Redis:** Yes. Every path that feeds Prisma/Redis/cache now uses the normalized `shop` variable. Context is set only with normalized shop (app.tsx, run-app-auth.server.ts). afterAuth and webhooks use normalized shop for warmCatalogForShop, recordWebhook, and all Prisma calls.
- **Tests:** All tests pass (`npm run test` in revstack, exit code 0). No test changes were required; tests already use canonical shop domains (e.g. `test.myshopify.com`).

---

## 4. What Was Not Done

- No refactoring of architecture.
- No changes to business logic, analytics formulas, billing logic, or onboarding logic.
- No renaming of unrelated variables; only minimal boundary changes.
- No formatting or cleanup outside these edits.
- Redis key format unchanged except that the shop segment of keys is now always canonical (normalized shop).
- Prisma query logic unchanged; only the value passed for `shopDomain` / `shop` is now always normalized.

---

## 5. Phase 1 Addendum — Cache, Redis Namespace, DB Truth, Dev Flush (System Integrity)

### 5.1 Caches Removed / Hardened

| Location | Change |
|----------|--------|
| `revstack/app/lib/analytics.server.ts` | **Removed** in-memory `analyticsMetricsCache` (Map). No analytics served from stale memory. `clearAnalyticsCache(shop)` exported as no-op for dev flush. |
| `revstack/app/lib/dashboard-metrics.server.ts` | **Removed** in-memory `dashboardMetricsCache` (Map). `clearDashboardMetricsCache(shop)` exported as no-op for dev flush. |

**Confirmation:** No analytics or dashboard metrics are served from in-memory cache. Every request uses DB truth gate and, when count > 0, uncached computation.

### 5.2 Redis Namespace Lock — Centralized Helper

**Added in `revstack/app/lib/redis.server.ts`:**

```ts
export function redisKey(shop: string, ...parts: string[]): string {
  const normalized = normalizeShopDomain(shop);
  return ["revstack", normalized, ...parts].join(":");
}
```

**Updated Redis call sites (all use `redisKey()`, no raw `${shop}`):**

| File | Keys Replaced |
|------|----------------|
| `revstack/app/lib/decision-cache.server.ts` | `decision:{shop}:{cartHash}` → `redisKey(shop, "decision", cartHash)`; `decision_lock:{shop}:{cartHash}` → `redisKey(shop, "decision_lock", cartHash)` |
| `revstack/app/lib/catalog-warm.server.ts` | `catalog:{shop}` → `redisKey(shop, "catalog")`; `catalog:circuit:open:{shop}` → `redisKey(shop, "catalog", "circuit", "open")`; `catalog:circuit:failures:{shop}` → `redisKey(shop, "catalog", "circuit", "failures")`; `catalog_index:{shop}` → `redisKey(shop, "catalog_index")` |
| `revstack/app/lib/catalog-index.server.ts` | `catalog_index:{shop}` → `redisKey(shop, "catalog_index")` |
| `revstack/app/lib/rate-limit.server.ts` | `ratelimit:{shop}:{window}` → `redisKey(shop, "ratelimit", window)` |

**Confirmation:** No template-string Redis key construction remains; all keys go through `redisKey()`.

### 5.3 DB Truth Gate in Analytics

- **analytics.server.ts:** Before returning metrics, `prisma.decisionMetric.count({ where: { shopDomain: normalized } })`. If `total === 0`, return `zeroedAnalyticsMetrics()`; do not compute aggregates or use cache.
- **dashboard-metrics.server.ts:** Same gate: if count === 0, return `zeroedDashboardMetrics()`.

**File locations:** `getAnalyticsMetrics()` and `getDashboardMetrics()` in `revstack/app/lib/analytics.server.ts` and `revstack/app/lib/dashboard-metrics.server.ts`.

### 5.4 Dev-Only Cache Flush Endpoint

- **File:** `revstack/app/routes/app.dev.flush.ts`
- **Route:** GET `/app/dev/flush`
- **Behavior:** Returns 404 when `NODE_ENV !== "development"`. Requires admin auth. Clears in-memory analytics caches (no-op), deletes Redis keys matching `revstack:{shop}:*`, logs and returns JSON: `DecisionMetric` count, `OrderInfluenceEvent` count, `CrossSellConversion` count, `redisKeysDeleted`.
- **Confirmation:** Dev-only (env check + 404 in non-dev). Exempt from billing/onboarding gates in `app.tsx` so it is reachable in dev.

### 5.5 Session + Shop Verification Logging (Dev Only)

- **Layout loader** (`revstack/app/routes/app.tsx`): `console.log("[SHOP CONTEXT]", shop)` when `NODE_ENV === "development"`.
- **Cart decision route** (`revstack/app/routes/cart.decision.ts`): `console.log("[DECISION SHOP]", shop)` when `NODE_ENV === "development"`.
- **Purpose:** Detect session bleed; confirm correct shop context per request.

### 5.6 Fail-Safe Analytics Handling

- **analytics.server.ts:** `getAnalyticsMetrics()` wraps DB truth check and `getAnalyticsMetricsUncached()` in try/catch. On any Prisma/error: log and return `zeroedAnalyticsMetrics()`; loader does not throw.
- **dashboard-metrics.server.ts:** Same pattern for `getDashboardMetrics()`.
- Prevents Railway transient errors from corrupting UI state.

### 5.7 Verification Checklist (Post-Implementation)

- DB wipe → analytics show zero (DB truth gate returns zeroed metrics).
- Redis flush → no change in cross-store isolation (keys are namespaced by normalized shop).
- Switching dev stores shows correct metrics immediately (no stale in-memory cache).
- Restarting Railway not required to clear ghost analytics (no in-memory analytics cache).
- **Tests:** All tests pass (`npm test -- --run` in revstack). Analytics tests updated to mock `prisma.decisionMetric.count` so DB truth gate receives count and uncached path runs.

### 5.8 What Was Not Done (This Phase)

- No business logic changes. No analytics formula changes. No architecture refactor.
- No UI, messaging, or billing changes. System integrity only.
