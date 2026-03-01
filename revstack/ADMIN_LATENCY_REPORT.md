# Admin Performance Audit Report

## Latency Report (Before → After)

| Route | Change | Effect |
|-------|--------|--------|
| **Layout** (every page) | `ensureActivatedAt` uses passed config | −1 Prisma findUnique when onboarding done |
| **Layout** (every page) | `syncOnboardingProgress` reuses step2 | −1 Prisma decisionMetric.count |
| **/app/preview** | Parallel getShopConfig + getCatalogForShop | Config + Shopify API run in parallel instead of sequential |
| **/app/preview** | Pass config + catalog to generatePreviewDecision | −1 getShopConfig call (loader already has config) |
| **All** | Removed production console.log | Cleaner logs |

**Net per layout load (typical):** ~2 fewer DB queries when onboarding completed.
**Preview route:** Config and catalog fetched in parallel; no duplicate getShopConfig.

---

## STEP 1 — Latency Map Per Route

### Route hierarchy

Every admin route runs the **layout loader** (`app.tsx`) first, then the **child loader** (if any). Loaders run **sequentially** (parent → child). No parallel parent+child.

---

### `/app` (Layout — runs on every admin page)

| Step | Operation | Source | Type | Notes |
|------|-----------|--------|------|-------|
| 1 | authenticate.admin | shopify.server | Shopify session lookup | Required |
| 2 | syncOnboardingProgress | onboarding.server | | |
| 2a | getShopConfig | shop-config.server | Prisma findUnique / create | 5min cache; cache hit still does version check query |
| 2b | isStep2Complete | prisma.decisionMetric.count | Raw query | **Called twice** in syncOnboardingProgress |
| 2c | prisma.shopConfig.update | If progress changed | | |
| 2d | invalidateShopConfigCache | If updated | | |
| 3 | ensureActivatedAt | retention.server | Prisma findUnique + maybe update | **Redundant**: syncOnboardingProgress already has config |

**Sequential chain:** auth → sync (getShopConfig → isStep2×2 → maybe update) → ensureActivatedAt

---

### `/app` (Dashboard index)

| Step | Operation | Source | Type | Notes |
|------|-----------|--------|------|-------|
| 1 | authenticate.admin | (layout runs first) | | |
| 2 | [config, metrics] | Promise.all | Parallel | getShopConfig + getDashboardMetrics |
| 3 | getRetentionContext | retention.server | 4 parallel Prisma queries | Uses passed shopConfig (no extra fetch) |
| 4 | touchLastActive | retention.server | Prisma updateMany | Sequential after retention |

**Redundancy:** getShopConfig called in layout (syncOnboardingProgress) and again in child. Cache may serve, but version check = 1 query.

**Sequential:** [2] then [3] then [4]. Retention is heavy (count + 2 raw aggregations + config).

---

### `/app/settings`

| Step | Operation | Source | Type | Notes |
|------|-----------|--------|------|-------|
| 1 | authenticate.admin | layout | | |
| 2 | getShopConfig | shop-config.server | Prisma | Single call, light |

**Light route.** No analytics, no retention.

---

### `/app/analytics`

| Step | Operation | Source | Type | Notes |
|------|-----------|--------|------|-------|
| 1 | authenticate.admin | layout | | |
| 2 | [config, metrics] | Promise.all | Parallel | getShopConfig + getAnalyticsMetrics |
| 3 | generateSparkline | sparkline.server | Sync in-memory | Fast |

**getAnalyticsMetrics:** 4 raw SQL queries in Promise.all (7d trend, 30d, prev 30d, prev 7d). Cached 30s.

---

### `/app/upgrade`

| Step | Operation | Source | Type | Notes |
|------|-----------|--------|------|-------|
| 1 | authenticate.admin | layout | | |
| 2 | getShopConfig | shop-config.server | Prisma | Light |

---

### `/app/onboarding`

| Step | Operation | Source | Type | Notes |
|------|-----------|--------|------|-------|
| 1 | authenticate.admin | layout | | |
| 2 | getOnboardingProgress | onboarding.server | | |
| 2a | syncOnboardingProgress | | getShopConfig + isStep2Complete×2 | **isStep2Complete called twice** |
| 2b | prisma.shopConfig.update | If progress changed | | |

**Redundancy:** syncOnboardingProgress = getShopConfig + isStep2Complete (twice).

---

### `/app/preview`

| Step | Operation | Source | Type | Notes |
|------|-----------|--------|------|-------|
| 1 | authenticate.admin | layout | Returns admin + session | |
| 2 | getShopConfig | loader | Prisma | |
| 3 | generatePreviewDecision | preview-simulator.server | | |
| 3a | getShopConfig | **Again inside** | Prisma | **Redundant** |
| 3b | getCatalogForShop | catalog.server | Shopify Admin GraphQL | **Slow** — 50 products, collections |
| 3c | decideCartActions | decision-engine | In-memory | Fast |

**Heavy:** getCatalogForShop = Shopify API call (external). Catalog cached 5min.

**Redundancy:** getShopConfig called in loader and again in generatePreviewDecision.

---

### `/app/additional`

| Step | Operation | Source | Type | Notes |
|------|-----------|--------|------|-------|
| 1 | Layout loader only | app.tsx | | No child loader |

---

## STEP 2 — Root Causes

### Backend

1. **Duplicate getShopConfig**
   - Layout: syncOnboardingProgress → getShopConfig
   - Child: getShopConfig (dashboard, analytics, settings, upgrade, preview)
   - preview: generatePreviewDecision also calls getShopConfig again
   - Cache helps but version check on hit = 1 Prisma query per call

2. **syncOnboardingProgress: isStep2Complete called twice**
   - Once for completions, once for stepCompletionsAfter
   - Same prisma.decisionMetric.count query

3. **ensureActivatedAt redundant**
   - Layout already has config from syncOnboardingProgress
   - ensureActivatedAt does its own findUnique; could use passed config

4. **Preview: sequential getShopConfig + getCatalogForShop**
   - Loader has config but generatePreviewDecision fetches again
   - getCatalogForShop (Shopify API) is the main latency source for preview

5. **getShopConfig cache: version check on every hit**
   - Cache hit still runs findUnique(select version) for validation
   - Adds 1 query per getShopConfig call even when cached

6. **console.log in production**
   - shop-config.server line 33
   - shopify.server afterAuth

### Frontend

1. **No navigation loading indicator**
   - No useNavigation().state === "loading"
   - No global progress bar or pending state

2. **No page-level skeletons**
   - Blank screen until loaders resolve
   - Content flash when data arrives

3. **Limited loading states**
   - Settings: isSubmitting on button ✓
   - Onboarding: fetcher loading on buttons ✓
   - Preview: "Refreshing…" on fetcher ✓
   - No route-level loading UI

4. **Layout blocks until child loads**
   - Parent + child loaders must complete before render
   - User sees nothing during transition

---

## Index Check

- DecisionMetric: `@@index([shopDomain, createdAt])` ✓
- CrossSellConversion: `@@index([shopDomain, createdAt])` ✓
- No N+1 patterns identified in aggregation queries.

---

## STEP 4 — Improvements Implemented

### Backend

1. **syncOnboardingProgress**: Reuse `step2` result instead of calling `isStep2Complete` twice (removes 1 Prisma count query per layout load).

2. **ensureActivatedAt**: Accept optional `config` to avoid extra `findUnique` when layout already has it (removes 1 Prisma query when onboarding completed).

3. **preview route**:
   - Loader runs `getShopConfig` and `getCatalogForShop` in parallel via `Promise.all`.
   - `generatePreviewDecision` accepts optional `config` and `catalog` to avoid redundant fetches.

4. **Removed `console.log`** from `shop-config.server.ts` (production noise).

5. **afterAuth log**: Restricted to `NODE_ENV === "development"` in `shopify.server.ts`.

### Frontend

1. **Global navigation loading bar**: Thin progress bar at top when `navigation.state === "loading"` or `"submitting"` (route transitions and form submissions).

2. **useNavigation**: Added to app layout for pending navigation feedback.

3. **Loading bar styles**: `loadingBar.module.css` with subtle shimmer animation.

### Files Changed

- `app/lib/onboarding.server.ts` — Reuse step2 result.
- `app/lib/retention.server.ts` — ensureActivatedAt accepts optional config.
- `app/lib/preview-simulator.server.ts` — generatePreviewDecision accepts optional config + catalog.
- `app/lib/shop-config.server.ts` — Removed console.log.
- `app/shopify.server.ts` — afterAuth log only in dev.
- `app/routes/app.tsx` — Pass config to ensureActivatedAt; add loading bar + useNavigation.
- `app/routes/app.preview.tsx` — Parallel getShopConfig + getCatalogForShop; pass both to generatePreviewDecision.
- `app/styles/loadingBar.module.css` — New loading bar styles.
- `app/styles/pageSkeleton.module.css` — New skeleton styles (available for future use).

---

## STEP 5 — Architectural Recommendations

1. **getShopConfig redundancy (layout + child)**: Layout’s `syncOnboardingProgress` loads config; child loaders load it again. Both can hit cache, but version checks add queries. Consider passing layout config to children via React Router’s route context or a shared request-scoped cache.

2. **getShopConfig cache version check**: On cache hit, a version check query still runs. For single-instance deploys, invalidation on write may be enough; consider skipping the version check to cut 1 query per getShopConfig call.

3. **Preview route**: `getCatalogForShop` (Shopify Admin API) is the main latency source. Catalog is cached 5 min. If preview feels slow, consider:
   - Lazy-loading catalog only when the cart preview section is visible.
   - Shortening catalog size for preview (e.g. 20 products instead of 50).

4. **HydrateFallback / defer**: For faster time-to-interactive, consider `defer` for heavy routes (e.g. dashboard) and render a skeleton while loading. Requires loader changes and Suspense boundaries.
