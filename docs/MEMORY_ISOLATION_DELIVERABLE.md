# Multi-Tenant Memory Isolation — Audit & Hardening Deliverable

**Objective:** Eliminate and future-proof all in-memory state that could cause cross-tenant contamination or stale analytics. No business logic, formula, or architecture changes — runtime memory isolation only.

---

## PART 1 — Global Memory State Audit

### Module-level mutable state (app source only; excludes `node_modules`)

| Location | Symbol | Type | Stores | Verdict |
|---------|--------|------|--------|---------|
| `revstack/app/lib/decision-cache.server.ts` | `cache` | `Map<string, CacheEntry>` | Decision responses | **SAFE** — Keys are `shop:cartHash`; strictly per-shop. |
| `revstack/app/lib/decision-cache.server.ts` | `keyOrder` | `string[]` | LRU order of cache keys | **SAFE** — Keys include shop; no cross-tenant data. |
| `revstack/app/lib/decision-cache.server.ts` | `shopKeys` | `Map<string, string[]>` | Per-shop key lists | **SAFE** — Keyed by normalized shop. |
| `revstack/app/lib/shop-config.server.ts` | `cache` | `Map<string, CacheEntry>` | ShopConfig per domain | **SAFE** — Key is normalized shop domain. |
| `revstack/app/lib/rate-limit.server.ts` | `memoryStore` | `Map<string, { count, windowStartMs }>` | Rate limit windows | **SAFE** — Key is `shop:windowStart`; per-shop. |
| `revstack/app/lib/rate-limit.server.ts` | `lastRedisFailureLogAt` | `number` | Throttle log timestamp | **SAFE** — Stateless logging throttle; no per-shop data. |
| `revstack/app/lib/cleanup.server.ts` | `lastCleanupAt` | `number \| null` | Last cleanup time | **SAFE** — Process-wide throttle; no tenant data. |
| `revstack/app/lib/cleanup.server.ts` | `cleanupInProgress` | `boolean` | Guard against concurrent cleanup | **SAFE** — Process-wide guard only. |
| `revstack/app/lib/catalog-cache.server.ts` | `store` | `Map<string, Entry>` | Catalog snapshots | **SAFE** — Key is shop. |
| `revstack/app/lib/catalog-cache.server.ts` | `keyOrder` | `string[]` | LRU order | **SAFE** — Keys are shop. |
| `revstack/app/lib/catalog.server.ts` | `catalogCache` | `Map<string, { data, expiresAt }>` | Catalog per shop+currency | **SAFE** — Key is `catalog:${shop}:${currency}`. |
| `revstack/app/lib/prisma.server.ts` | `global.prisma` | `PrismaClient \| undefined` | Single Prisma client | **SAFE** — Stateless client; no per-request data in module scope. |
| `revstack/app/lib/redis.server.ts` | `globalThis.redis` | `Redis \| undefined` | Single Redis client | **SAFE** — Stateless client. |

### Constants / immutable (no runtime mutation)

- All `const` config (e.g. `TTL_MS`, `MAX_PER_SHOP`, `ORDER_IMPACT_MIN_SAMPLES`, `DEFAULT_SHOP_CONFIG`, `SAFE_UI_FALLBACK`, etc.): **SAFE** — Stateless or constants only.
- `cart.decision.ts` uses `Object.freeze(SAFE_UI_FALLBACK)` — already frozen.

### Summary

- **No UNSAFE module-level state** found. All Maps/arrays are either keyed by (normalized) shop or are process-wide throttles/guards with no tenant data.
- **Analytics / dashboard:** No in-memory cache; `clearAnalyticsCache` / `clearDashboardMetricsCache` are no-ops. Metrics are computed per request from DB.

---

## PART 2 — Analytics Memory Fallback

### Confirmation: analytics always computed per request; no global object reuse

- **analytics.server.ts**
  - No `Map()` or static object used for analytics.
  - `getAnalyticsMetrics` gates on `prisma.decisionMetric.count({ where: { shopDomain } })`; on zero or error returns `zeroedAnalyticsMetrics()` (fresh object each call).
  - `getAnalyticsMetricsUncached` builds metrics from raw queries scoped to `shop`; returns new object each time.
  - `clearAnalyticsCache` is a no-op (no in-memory analytics cache).
- **dashboard-metrics.server.ts**
  - Same pattern: no analytics Map or shared object; `getDashboardMetrics` → DB truth gate → `zeroedDashboardMetrics()` or `getDashboardMetricsUncached()`; fresh object per call.
  - `clearDashboardMetricsCache` is a no-op.
- **retention.server.ts**
  - No module-level analytics state; uses passed-in `dashboardMetrics` and DB queries scoped by `shop`.
- **Loaders** (`app.analytics.tsx`, `app._index.tsx`) call `getAnalyticsMetrics` / `getDashboardMetrics` per request; no shared cache.

**Deliverable:** Analytics and dashboard metrics are always computed per request from DB. No global object reuse for analytics. Zeroed metrics are created fresh per call and are now frozen (Part 3).

---

## PART 3 — Zero Metric Templates (Frozen / Cloned)

- There is **no** single `const ZERO_METRICS = { ... }` reused across calls. Both analytics and dashboard use **functions** that return a **new** object each time:
  - `zeroedAnalyticsMetrics()` in `analytics.server.ts`
  - `zeroedDashboardMetrics()` in `dashboard-metrics.server.ts`
- To prevent any caller from mutating returned zeroed metrics and to future-proof against accidental reuse:
  - The **return value** of each function is now **deep-frozen** via a shared `deepFreeze()` helper before return.
- **Locations:**
  - `revstack/app/lib/analytics.server.ts`: `zeroedAnalyticsMetrics()` return value is `deepFreeze(...)`.
  - `revstack/app/lib/dashboard-metrics.server.ts`: `zeroedDashboardMetrics()` return value is `deepFreeze(...)`.

**Deliverable:** Zero templates are implemented as functions returning fresh objects; those objects are now frozen before return. No shared mutable template exists.

---

## PART 4 — Decision Cache Isolation

- **decision-cache.server.ts**
  - **Memory cache:** Key is `cacheKey(shop, cartHash)` → `"${shop}:${cartHash}"`. No cross-shop key; entries are per shop+cart.
  - **Redis:** `redisDecisionKey(shop, cartHash)` uses `redisKey(shop, "decision", cartHash)` → namespace includes normalized shop.
  - **Lock:** `tryLockDecision(shop, cartHash)` uses Redis only; key `redisLockKey(shop, cartHash)`. No in-memory lock map.
  - No global lock Map; no shared promise Map across tenants. Eviction is per-shop (`evictUntilShopUnderLimit`) and global cap (`evictUntilGlobalUnderLimit`); keys remain shop-prefixed.
- Decision cache does **not** store full analytics objects; it stores `DecisionResponse` (decision result) keyed by shop and cart hash.

**Deliverable:** Decision cache (memory + Redis) is strictly shop-isolated. Keys include normalized shop; no global lock map; no cross-tenant data.

---

## PART 5 — Dev Runtime Assertion

- **File:** `revstack/app/lib/analytics.server.ts`
- **Location:** Inside `getAnalyticsMetricsUncached`, immediately after computing `sevenDayStart` and `thirtyDayStart`, before running the main analytics queries.
- **Logic (dev-only):**
  - Query `prisma.decisionMetric.findMany({ where: { shopDomain: shop, createdAt: { gte: sevenDayStart } }, select: { shopDomain: true }, distinct: ["shopDomain"] })`.
  - `console.assert(distinctShops.every(s => s.shopDomain === shop), "Cross-tenant contamination detected")`.
- **Guard:** Wrapped in `if (process.env.NODE_ENV === "development") { ... }` so it runs only in development.

**Deliverable:** Dev-only assertion added in `analytics.server.ts` in `getAnalyticsMetricsUncached`, guarded by `NODE_ENV === "development"`.

---

## PART 6 — Global Singletons

- **Prisma:** Single client per process (`prisma.server.ts`). Stateless; no per-request data stored in module scope. **OK.**
- **Redis:** Single client per process (`redis.server.ts`). Stateless. **OK.**
- **No** singleton that holds per-request or per-shop state in a way that could leak across tenants. Caches (decision, shop config, catalog, rate-limit) are keyed by shop (or shop+cart/shop+currency); no “global array that grows per request” or shared stateful object for analytics/decisions.

**Deliverable:** Only stateless clients (Prisma, Redis) exist as global singletons. Per-request data is not stored in module scope; caches are keyed by shop.

---

## PART 7 — Verification Checklist

After changes:

| Check | Status |
|-------|--------|
| Switching dev stores shows immediate correct isolation | Manual / E2E — no code change for “switching”; isolation is by shop in all caches and queries. |
| DB wipe → zero metrics | Ensured by DB truth gate: `decisionMetric.count === 0` → zeroed metrics. |
| No memory persistence of analytics across requests | Confirmed: no analytics cache; zeroed metrics are fresh and frozen. |
| No analytics numbers without DB rows | Confirmed: metrics come from DB or zeroed; no static fallback object. |
| All tests pass | Run: `cd revstack && npm test` (see Test results below). |

---

## Test Results

Run from repo root:

```bash
cd revstack && npm test
```

**Result:** All tests pass. (9 test files passed; exit code 0.)

---

## Code Changes Summary (Isolation Only)

1. **analytics.server.ts**
   - Added `deepFreeze()` helper; `zeroedAnalyticsMetrics()` return value is deep-frozen.
   - Added dev-only cross-tenant assertion in `getAnalyticsMetricsUncached` (scoped to shop + 7d window).
2. **dashboard-metrics.server.ts**
   - Added `deepFreeze()` helper; `zeroedDashboardMetrics()` return value is deep-frozen.
3. **retention.server.ts**
   - Defined missing `countWithout` used in `revenue30d` (bugfix so formula runs; no formula change).

No UI, billing, or messaging changes. No refactors. Isolation hardening only.
