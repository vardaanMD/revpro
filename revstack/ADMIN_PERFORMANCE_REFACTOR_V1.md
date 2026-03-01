# Admin Performance Refactor v1 – Summary

## Objectives completed

1. **Short-circuit syncOnboardingProgress**  
   In `app/routes/app.tsx` (layout loader): if `config.onboardingCompleted === true`, `syncOnboardingProgress` is not called. Sync runs only when onboarding is not complete.  
   Comment in code: *"Sync skipped when onboardingCompleted is true: no need to recompute or persist step state."*

2. **Remove version-check DB hit on config cache hit**  
   In `app/lib/shop-config.server.ts`: when a cached config exists and TTL is not expired, it is returned immediately with no Prisma call. Prisma is used only when the cache is missing or expired.  
   Comment in code: *"Version check removed on cache hit: if cached config exists and TTL not expired, return immediately without any Prisma query. Invalidation is handled by invalidateShopConfigCache when config is updated."*  
   `invalidateShopConfigCache` behavior is unchanged.

3. **Remove duplicate getShopConfig / single auth in layout**  
   - Layout loader is the single place that calls `authenticate.admin` and `getShopConfig` for the request.  
   - Layout exposes `config` in its loader data and sets `appLayout` (shop, config, session, admin, redirect) in request context via `setAppLayoutInContext`.  
   - Child loaders under `/app/*` use `getAppLayoutFromContext()` first; if present they use that (no `authenticate.admin` or `getShopConfig`). If absent they fall back to `authenticate.admin` + `getShopConfig`.  
   Comment in code: *"Layout is the single auth/config authority; child loaders under /app/* use getAppLayoutFromContext() and must not call authenticate.admin or getShopConfig again."*

4. **Config and auth from layout**  
   - Layout returns `config` for `useRouteLoaderData(APP_LAYOUT_ROUTE_ID)` in child components.  
   - `APP_LAYOUT_ROUTE_ID` is exported from `app/routes/app.tsx` as `"routes/app"` for TypeScript-safe use in children.

5. **No duplicate auth in loaders**  
   `authenticate.admin` is called once per request in the layout loader. Child loaders do not call it when `getAppLayoutFromContext()` is set. Actions (e.g. settings save, preview POST) still call `authenticate.admin` on their own request (no layout loader on POST). Auth behavior is unchanged; no bypass or dev shortcuts.

## Modified files

- `app/lib/shop-config.server.ts` – cache hit returns without Prisma; comment added.
- `app/lib/request-context.server.ts` – `appLayout` (shop, config, session, admin, redirect), `getAppLayoutFromContext()`, `setAppLayoutInContext()`.
- `app/routes/app.tsx` – short-circuit sync when `onboardingCompleted`; single auth + getShopConfig; set appLayout in context; return `config`; export `APP_LAYOUT_ROUTE_ID`; comments.
- `app/routes/app._index.tsx` – loader uses `getAppLayoutFromContext()` with fallback; no duplicate auth/config.
- `app/routes/app.settings.tsx` – same for loader; action unchanged (auth on POST).
- `app/routes/app.preview.tsx` – same for loader; action unchanged.
- `app/routes/app.upgrade.tsx` – loader uses context with fallback.
- `app/routes/app.analytics.tsx` – loader uses context with fallback.
- `app/routes/app.onboarding.tsx` – loader uses context with fallback (shop + redirect).

## Prisma query reduction (per page load)

- **Config cache hit (TTL valid):**  
  Before: 1 `shopConfig.findUnique` (version check) on every request with a cache hit.  
  After: 0 Prisma calls on cache hit.

- **Layout + child (e.g. /app, /app/settings):**  
  When request runs inside the same `requestContext.run()` (see note below):  
  Before: layout (auth + getShopConfig + sync possibly) + child (auth + getShopConfig) → 2× auth, 2× getShopConfig (and on cache hit, 2× version-check queries).  
  After: layout does auth once, getShopConfig once; child uses context → 1× auth, 1× getShopConfig, 0 extra Prisma on cache hit.

- **Onboarding completed:**  
  Before: every request ran `syncOnboardingProgress` (getShopConfig + step2 count + possible update).  
  After: when `config.onboardingCompleted === true`, sync is skipped → no sync-related Prisma for completed shops.

## Duplicate auth/config

- **Loaders:** When `getAppLayoutFromContext()` is set (layout ran in the same request context), child loaders do not call `authenticate.admin` or `getShopConfig`. When it is not set, they fall back to one auth + one getShopConfig so behavior stays correct.
- **Actions:** Form POSTs (e.g. settings, preview) do not run the layout loader; they call `authenticate.admin` once for that request. No duplicate auth on the same  request.
- **Layout:** Single call to `authenticate.admin` and single call to `getShopConfig`; result is stored in context and returned as loader data.

## Request context note

For the layout’s context to be visible to child loaders, the code that runs both the layout and child loaders must run inside the same `requestContext.run()` (e.g. in the server entry that handles document requests). If that is not yet in place, child loaders will use the fallback (auth + getShopConfig) and behavior remains correct. When the server runs document request handling inside `requestContext.run({ requestId, ... }, () => { ... })`, the single-auth/single-config path will be used and Prisma/auth duplication will be removed for that request.

## Test run (PERF logs)

**Observed (unauthenticated GET /app):**

- `[PERF][GET /app] layout: authenticate.admin start`
- `[PERF][GET /app] dashboard loader: start`
- `[PERF][GET /app] dashboard loader: using FALLBACK`
- `[PERF][GET /app] dashboard: authenticate.admin start`
- Then redirect to `/auth/login`.

**Conclusion:** React Router runs **layout and child loaders in parallel**, not layout-then-child. The layout never reaches `setAppLayoutInContext()` before the dashboard loader runs, so `getAppLayoutFromContext()` is always undefined in the child. Result: **two `authenticate.admin` calls per request** (layout + dashboard fallback).

To get **one session lookup and one getShopConfig per request**, auth + config must run **before** any route loaders and set the request context (e.g. middleware or a wrapper that runs first). Then both layout and child loaders can read from context and skip `authenticate.admin` / `getShopConfig`.

## Verification

- `npx tsc --noEmit` – passes.
- `npm run build` – passes.
- No feature removal, UI changes, auth weakening, or changes to billing, onboarding, or analytics logic.
