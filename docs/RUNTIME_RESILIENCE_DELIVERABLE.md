# Runtime Resilience Deliverable

**Scope:** Runtime resilience only. No changes to analytics formulas, billing logic, tenant isolation, Redis key format, or business rules.

---

## PART 1 — Defensive Error Wrapping

### 1.1 Prisma Calls

| Location | Entrypoint | Wrapping | Safe fallback |
|----------|------------|----------|----------------|
| **analytics.server.ts** | `getAnalyticsMetrics` | try/catch at top level + around uncached computation | `zeroedAnalyticsMetrics()` |
| **analytics.server.ts** | `getShopAnalyticsSummary` | try/catch around Promise.all + Prisma | `zeroedAnalyticsSummary()` |
| **analytics.server.ts** | `getShopAnalyticsTimeseries` | try/catch around raw queries | `[]` |
| **dashboard-metrics.server.ts** | `getDashboardMetrics` | try/catch at top level + around uncached | `zeroedDashboardMetrics()` |
| **retention.server.ts** | `touchLastActive` | try/catch, log, no throw | void |
| **retention.server.ts** | `setActivatedAtIfNeeded` | try/catch, log, no throw | void |
| **retention.server.ts** | `ensureActivatedAt` | try/catch, log, no throw | void |
| **retention.server.ts** | `getRetentionContext` | try/catch around full flow | `zeroedRetentionContext()` |
| **retention.server.ts** | `acknowledgeMilestone` | try/catch, log, no throw | void |
| **billing-context.server.ts** | `getBillingContext` | try/catch around getShopConfig | Safe context: `isEntitled: false`, `capabilities: basic` |
| **cart.decision** (decision endpoint) | Config load + decision build | try/catch for config; inner try/catch for decision build | `safeDecisionResponse(SAFE_UI_FALLBACK)` |
| **shop-config.server.ts** | Layout/loaders when Prisma fails | Callers use `getFallbackShopConfig(shop)` in catch | Fallback config (billingStatus inactive, etc.) |

- **Structured error logging:** All Prisma catch blocks use `logResilience` (or equivalent) with `shop`, `route`, `errorType`, `fallbackUsed`; `stack` only in development.
- **No raw 500 to UI:** Prisma failures return zeroed metrics, safe fallback context, or fallback config; decision endpoint always returns 200 with SAFE_DECISION when dependencies fail.

### 1.2 Redis Calls

| Location | Function | Behavior on Redis throw |
|----------|----------|--------------------------|
| **decision-cache.server.ts** | `getCachedDecisionFromRedis` | Log via `logResilience`, return `null`; request continues without cache. |
| **decision-cache.server.ts** | `setCachedDecision` | Log via `logResilience`; memory cache still set; no throw. |
| **decision-cache.server.ts** | `tryLockDecision` | Log via `logResilience`, return `false`; request continues without lock. |
| **catalog-warm.server.ts** | `getCatalogFromRedis` | Log, return `null`. |
| **catalog-warm.server.ts** | `warmCatalogForShop` (Redis set path) | Log, return fetched catalog without writing to Redis. |
| **rate-limit.server.ts** | `checkRateLimitWithQuota` | Already falls back to in-memory; log with `errorType` and `fallbackUsed`. |

- **Redis never blocks correctness:** Cache/lock/catalog read-write are best-effort; rate limit uses in-memory fallback. No request returns 500 due to Redis.
- **Never block request:** All Redis usage is in try/catch; on error we log and continue (return null, false, or in-memory result).

### 1.3 Shopify Admin API Calls

| Location | Wrapping | On failure |
|----------|----------|------------|
| **catalog.server.ts** | `getCatalogForShop`: check `response.status === 401` and `!response.ok` | 401: log “Admin API 401”, throw `AdminApi401Error(shop)` so loaders can force re-auth. Non-OK: log, return `[]`. |
| **app.settings.tsx** (loader) | Catch `AdminApi401Error` from `getCatalogForShop` / preview | Throw 302 redirect to `/auth/login?${url.search}` (preserves shop/host). |
| **preview-simulator.server.ts** | `generatePreviewDecision`: catalog fetch already wrapped in try/catch with empty catalog fallback | Caller (app.settings) also catches and sets `initialPreviewDecision = null` on other errors. |

- Loader does not crash: Admin API failure yields safe fallback (empty catalog, null preview) or re-auth redirect; no raw 500.

---

## PART 2 — Cold Start & Connection Readiness

### 2.1 Prisma Singleton

- **Confirmed:** `prisma.server.ts` uses `global.prisma ?? new PrismaClient(...)` and assigns `global.prisma = prisma` in non-production. Single client per process; no per-request instantiation; no async race on first use.

### 2.2 Redis Readiness

- **Connection errors caught:** All Redis usage is in try/catch in decision-cache, catalog-warm, rate-limit, and health route. First-request cold start does not crash: health and other routes catch and degrade.
- **Dev-only:** `redis.server.ts` already runs an optional connectivity test on first client use in development and logs result.

### 2.3 Health & Readiness Endpoint

- **GET /health** (`routes/health.ts`):
  - Returns JSON: `status` ("ok" | "degraded"), `prisma` ("connected" | "error"), `redis` ("connected" | "degraded"), `uptime`, `timestamp`.
  - No secrets exposed. Uses `prisma.$queryRaw\`SELECT 1\`` and `getRedis().ping()`; failures set prisma/redis to error/degraded and do not throw (response always 200).

---

## PART 3 — Session Lifecycle Audit

### 3.1 Shopify 401

- **Handling:** In `catalog.server.ts`, when Admin API returns 401 we log with `logResilience` and throw `AdminApi401Error(shop)`.
- **Re-auth:** In `app.settings.tsx` loader we catch `AdminApi401Error` and throw `Response` 302 to `/auth/login${search}` so shop/host (and embedded params) are preserved. Not silent; user is sent to re-auth.

### 3.2 Offline Token Refresh

- **Confirmed:** App uses `future: { expiringOfflineAccessTokens: true }` in `shopify.server.ts`. No assumption of long-lived validity.
- **Graceful reauth:** 401 from Admin API triggers redirect to `/auth/login` with query params preserved.

### 3.3 Embedded Auth Loop Prevention

- **Confirmed:** Server-side redirects in `app.tsx` use `url.search`: `/app/billing${url.search}` and `/app/onboarding${url.search}`. No bare path redirect that drops shop, host, or embedded params.

---

## PART 4 — Fail-Soft Loader Strategy

- **App layout** (`app.tsx`): `getShopConfig` wrapped in try/catch; on failure we log and use `getFallbackShopConfig(shop)` so layout always returns data (billing gate still applies with fallback config).
- **app._index.tsx, app.analytics.tsx, app.settings.tsx:** Same pattern when not using layout context: try `getShopConfig(shop)`, on failure log and use `getFallbackShopConfig(shop)`.
- **Billing context:** `getBillingContext` always returns a valid context (safe fallback when getShopConfig fails).
- **Dashboard/analytics/retention:** All return zeroed or minimal data on dependency failure; no loader throws 500 for a single DB/Redis hiccup. User does not see raw Railway error page.

---

## PART 5 — Structured Logging Layer

- **logResilience** in `logger.server.ts`: Lightweight structured logs with `shop`, `route`, `message`, and optional `meta`: `errorType`, `fallbackUsed`, `redisHitMiss`, `billingState`, `decisionOutcome`, `stack` (dev only). No sensitive tokens logged.
- **Usage:** All new/resilience catch paths use `logResilience` (or existing `logWarn` with structured meta) so that logs show what failed, which route/shop, and whether a fallback was used.

---

## PART 6 — Deliverable Checklist

| Item | Status |
|------|--------|
| List of wrapped dependency calls | See tables in §1.1, §1.2, §1.3. |
| Redis never blocks correctness | Yes; cache/lock/rate-limit are best-effort with fallbacks. |
| Prisma failures degrade gracefully | Yes; zeroed metrics, safe billing context, fallback config, SAFE_DECISION. |
| No raw 500s from dependency failures | Yes; all Prisma/Redis/Admin API failures caught and return safe response or redirect. |
| Health endpoint implemented | GET /health returns status, prisma, redis (no secrets). |
| Tests pass | Yes (npm test). |
| No refactors / no UI changes / no business logic changes | Only runtime resilience: error handling, logging, fallbacks, health, unhandledRejection. |

---

## Additional: Unhandled Promise Rejections

- **server.ts:** `process.on("unhandledRejection", ...)` logs via `logResilience` with route `"runtime"` and meta `errorType: "UnhandledRejection"`, `reason`, and optional `stack`. Prevents unhandled rejections from being silent.

---

## Files Touched (summary)

- **Lib:** `logger.server.ts`, `billing-context.server.ts`, `analytics.server.ts`, `dashboard-metrics.server.ts`, `retention.server.ts`, `shop-config.server.ts`, `decision-cache.server.ts`, `catalog-warm.server.ts`, `rate-limit.server.ts`, `catalog.server.ts`, `admin-api-errors.server.ts` (new).
- **Routes:** `health.ts`, `app.tsx`, `app._index.tsx`, `app.analytics.tsx`, `app.settings.tsx`, `cart.decision.ts`.
- **Server:** `server.ts` (unhandledRejection handler).

No changes to analytics formulas, billing logic, tenant isolation, Redis key format, or business rules.
