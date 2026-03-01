# Admin Layout & Route Loaders — Audit & Refactor

## Step 1 — Current Layout Behavior (Pre-Refactor)

### Layout loader: `app/routes/app.tsx`

**Responsibilities:**

- Authenticate admin (`authenticate.admin(request)`).
- Sync onboarding progress and derive blocking state: `syncOnboardingProgress(session.shop)`.
- Ensure `activatedAt` is set when onboarding is complete: `ensureActivatedAt(session.shop, { ... config })`.
- Return minimal global data for nav and soft paywall: `apiKey`, `onboardingCompleted`, `onboardingBlockReason`, `onboardingStepProgress`, `previewSeen`, `billingStatus`, `plan`.

**Queries executed (every layout load):**

| Step | Call | Source | Queries |
|------|------|--------|---------|
| 1 | `authenticate.admin(request)` | shopify.server | Session/auth |
| 2 | `syncOnboardingProgress(shop)` | onboarding.server | See below |
| 2a | `getShopConfig(domain)` (inside sync) | shop-config.server | Prisma findUnique (or create); cache hit still does version check (1 query) |
| 2b | `isStep2Complete(domain)` | onboarding.server | `prisma.decisionMetric.count` (1 query) |
| 2c | Optional | syncOnboardingProgress | `prisma.shopConfig.update` + cache invalidate if progress changed |
| 3 | `ensureActivatedAt(shop, config)` | retention.server | No extra query when config is passed (already optimized) |

**Sequential vs parallel:** Sequential: auth → sync (getShopConfig → isStep2Complete → maybe update) → ensureActivatedAt. No parallelization at layout level.

**What is required globally for layout:**

- `apiKey` — AppProvider (embedded app).
- `onboardingCompleted`, `onboardingBlockReason`, `onboardingStepProgress` — block banner and “Resume onboarding” link.
- `previewSeen` — can be used for nav/UX (currently returned; not used in layout UI).
- `billingStatus`, `plan` — nav (upgrade link) and soft paywall.

**What is not needed in layout (must stay in routes only):**

- Dashboard metrics (`getDashboardMetrics`, `getRetentionContext`).
- Analytics aggregates (`getAnalyticsMetrics`).
- Catalog or preview decision simulation.
- Raw SQL aggregations or heavy counts beyond the single `decisionMetric.count` inside `syncOnboardingProgress` (needed for step 2 completion).

---

### Shared loader utilities

- **`getShopConfig(shop)`** — shop-config.server.ts  
  Used by: layout (via sync), dashboard, analytics, preview, settings, upgrade, onboarding (via getOnboardingProgress). Cache 5 min; on cache hit still runs version check query.

- **`syncOnboardingProgress(shop)`** — onboarding.server.ts  
  Used by: layout, onboarding route (via `getOnboardingProgress`). Does: getShopConfig, isStep2Complete, derive completions, optional shopConfig.update + invalidate cache.

- **`ensureActivatedAt(shop, config?)`** — retention.server.ts  
  Used by: layout only. Accepts optional config to avoid extra findUnique.

- **`getDashboardMetrics(shop)`** — dashboard-metrics.server.ts  
  Used by: app._index only. Raw SQL + cache 30s.

- **`getAnalyticsMetrics(shop)`** — analytics.server.ts  
  Used by: app.analytics only. Raw SQL + cache 30s.

- **`getRetentionContext(shop, options)`** — retention.server.ts  
  Used by: app._index only. Uses passed shopConfig when provided (no extra config fetch).

---

### Redundant work (pre-refactor)

1. **Duplicate getShopConfig**  
   Layout runs it inside `syncOnboardingProgress`; every child loader that needs config runs it again (dashboard, analytics, settings, upgrade, preview). Cache reduces cost but version check still runs per request.

2. **Double sync on onboarding**  
   When user visits `/app/onboarding`: layout runs `syncOnboardingProgress`; onboarding loader runs `getOnboardingProgress` which calls `syncOnboardingProgress` again. Same getShopConfig + isStep2Complete + possible update run twice in one request.

3. **Preview action**  
   Loader correctly passes `config` and `catalog` to `generatePreviewDecision` (no extra getShopConfig there). Action calls `generatePreviewDecision(shop, admin, overrides)` without config/catalog, so it fetches again inside the simulator. Acceptable for actions; no change in this refactor.

4. **No duplicate heavy work in layout**  
   Layout does not call getDashboardMetrics, getAnalyticsMetrics, getRetentionContext, or catalog/preview simulation. Those live only in route loaders.

---

### Route-level responsibility (pre-refactor)

| Route | Loader does | Heavy work in layout? |
|-------|-------------|------------------------|
| /app (app._index) | getShopConfig + getDashboardMetrics (parallel), getRetentionContext(shopConfig), touchLastActive | No |
| /app/analytics | getShopConfig + getAnalyticsMetrics (parallel) | No |
| /app/preview | getShopConfig + getCatalogForShop (parallel), generatePreviewDecision(..., config, catalog) | No |
| /app/settings | getShopConfig | No |
| /app/onboarding | getOnboardingProgress → syncOnboardingProgress (duplicate of layout) | No (but double sync) |
| /app/upgrade | getShopConfig | No |

---

## Step 2–4 — Refactor Summary

### Layout loader (app.tsx)

- **Unchanged in scope:** Layout continues to do auth, `syncOnboardingProgress`, `ensureActivatedAt`, and return only: `apiKey`, `onboardingCompleted`, `onboardingBlockReason`, `onboardingStepProgress`, `previewSeen`, `billingStatus`, `plan`.
- **No** dashboard metrics, analytics, catalog, or preview simulation in layout (already the case).
- **Result:** Layout remains minimal; only structural and onboarding-double-sync fixes applied elsewhere.

### Changes made

1. **Onboarding route: avoid double sync**  
   - Added `getOnboardingProgressReadOnly(shop)` in `onboarding.server.ts`: same return shape as `getOnboardingProgress`, but only reads (getShopConfig + isStep2Complete + compute steps). No DB write.
   - `app.onboarding.tsx` loader now uses `getOnboardingProgressReadOnly` instead of `getOnboardingProgress`.
   - Effect: When visiting `/app/onboarding`, layout is the only place that runs `syncOnboardingProgress` (single write path). Onboarding loader no longer triggers a second sync or second potential shopConfig.update.

2. **Route loaders (already correct)**  
   - Dashboard: already uses `Promise.all([getShopConfig, getDashboardMetrics])`, passes shopConfig to `getRetentionContext`, single getShopConfig per loader.
   - Analytics: already uses `Promise.all([getShopConfig, getAnalyticsMetrics])`.
   - Preview: already uses `Promise.all([getShopConfig, getCatalogForShop])` and passes config + catalog to `generatePreviewDecision` (no extra getShopConfig in loader).
   - Settings / upgrade: single getShopConfig; no duplicate calls in same loader.

3. **No new dependencies, no caching changes, no UI or feature removal**  
   - Only loader responsibility separation and removal of redundant sync on the onboarding route.

---

## Expected performance improvement

- **Navigation between /app/* routes:** Layout still runs on each navigation (React Router behavior). It only runs auth + sync + ensureActivatedAt (no dashboard/analytics/retention). Child loaders run only for the active route; no heavy layout-only queries added.
- **Visit to /app/onboarding:** One fewer full sync (no second `syncOnboardingProgress` and no second potential shopConfig.update). Fewer DB writes and cache invalidations on that page load.
- **Overall:** Slightly faster onboarding page load; navigation latency unchanged for other routes because layout was already not doing dashboard/analytics; redundancy reduced for onboarding and clearer separation of responsibilities for future changes.

---

## What was redundant / what was moved

| Item | Was redundant / issue | Change |
|------|------------------------|--------|
| syncOnboardingProgress on onboarding page | Run in both layout and getOnboardingProgress | Onboarding loader uses getOnboardingProgressReadOnly; only layout syncs and writes |
| getShopConfig in layout vs child | Called in layout (sync) and again in each child loader | No structural change (RR does not pass layout data into child loaders); cache still shared |
| Dashboard/analytics in layout | Not present | Confirmed; no addition |

---

## Validation

- `npx tsc --noEmit` — pass.
- `npm run build` — pass.
- Authentication, onboarding blocking, billing, and embedded app behavior preserved; no feature removal.
