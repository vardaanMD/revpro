# Cross-Store Data Isolation Audit — Phase 1 Production Hardening

**Scope:** Strict shop-level isolation. Multiple dev stores, same Railway deployment, shared Redis, shared DB.  
**No code changes.** Diagnosis only.

---

## PART 1 — Prisma Isolation Audit

### 1.1 `prisma.decisionMetric` usage

| File path | Query type | Shop filter present | Normalization at call site | Risk level |
|-----------|------------|---------------------|----------------------------|------------|
| `revstack/app/routes/cart.decision.ts` | `create` | Yes (`shopDomain: shop`) | Yes — `shop = normalizeShopDomain(shopRaw)` at line 142 | **safe** |
| `revstack/app/lib/analytics.server.ts` | `count` (×2), `aggregate` (×3) in `getShopAnalyticsSummary` | Yes (`where: { shopDomain: shop, ... }`) | No — `shop` passed from caller; callers (e.g. app.analytics) do **not** normalize | **ambiguous** |
| `revstack/app/lib/analytics.server.ts` | `$queryRaw` (7d trend, 30d, OrderInfluence, prev 30d, prev 7d) | Yes (`WHERE "shopDomain" = ${shop}`) | Same as above | **ambiguous** |
| `revstack/app/lib/retention.server.ts` | `count` | Yes (`where: { shopDomain: shop }`) | No — `shop` from app layout/session (not normalized at boundary) | **ambiguous** |
| `revstack/app/lib/retention.server.ts` | `$queryRaw` (ThirtyDayRow, WeekCountRow) | Yes (`WHERE "shopDomain" = ${shop}`) | Same | **ambiguous** |
| `revstack/app/lib/cleanup.server.ts` | `deleteMany` | **No** — `where: { createdAt: { lt: ninetyDaysAgo } }` only | N/A (global cleanup) | **unsafe** |

### 1.2 `prisma.shopConfig` usage

| File path | Query type | Shop filter present | Normalization at call site | Risk level |
|-----------|------------|---------------------|----------------------------|------------|
| `revstack/app/lib/shop-config.server.ts` | `findUnique`, `create` | Yes (`where: { shopDomain: domain }`) | Yes — `domain = normalizeShopDomain(shop)` at entry | **safe** |
| `revstack/app/lib/onboarding-wizard.server.ts` | `update` (×3) | Yes (`where: { shopDomain: domain }`) | Yes — `domain = normalizeShopDomain(shop)` before each | **safe** |
| `revstack/app/routes/app.onboarding.tsx` | `update` | Yes (`where: { shopDomain: domain }`) | Yes — `domain = normalizeShopDomain(shop)` before update (step3_configure) | **safe** |
| `revstack/app/routes/app.settings.tsx` | `update` | Yes (`where: { shopDomain: shop }`) | **No** — `shop = session.shop` used raw | **unsafe** |
| `revstack/app/routes/webhooks.billing.update.tsx` | `findUnique`, `update`, `updateMany` | Yes (`where: { shopDomain: shop }`) | **No** — `shop` from `authenticate.webhook(request)` | **ambiguous** |
| `revstack/app/lib/billing.server.ts` | `update` | Yes (`where: { shopDomain: shop }`) | No — caller (e.g. upgrade route) passes `session.shop` | **ambiguous** |
| `revstack/app/lib/retention.server.ts` | `updateMany`, `findUnique`, `update` (×4) | Yes (`where: { shopDomain: shop }`) | No — shop from layout/session | **ambiguous** |

### 1.3 Analytics aggregation (count / groupBy / aggregate)

| File path | Query type | Shop filter | Normalization | Risk level |
|-----------|------------|-------------|---------------|------------|
| `revstack/app/lib/analytics.server.ts` | `decisionMetric.count`, `decisionMetric.aggregate`, `crossSellConversion.count` | Yes | Caller does not normalize | **ambiguous** |
| `revstack/app/lib/retention.server.ts` | `decisionMetric.count`, raw SQL aggregates | Yes | Caller does not normalize | **ambiguous** |
| `revstack/app/lib/product-metrics.server.ts` | `productSaleEvent.groupBy` | Yes (`where: { shopDomain, soldAt: ... }`) | Caller: cart.decision normalizes; webhooks.orders does **not** | **ambiguous** (orders webhook path) |

### 1.4 Queries missing strict shop filter (flagged)

| File path | Query | Issue |
|-----------|--------|--------|
| `revstack/app/lib/cleanup.server.ts` | `prisma.decisionMetric.deleteMany({ where: { createdAt: { lt: ninetyDaysAgo } } })` | No `shopDomain`; deletes across all shops. Same for `webhookEvent`, `crossSellEvent`, `crossSellConversion`. Intentional global retention cleanup but violates “no analytics/decision query without shop scoping.” |

---

## PART 2 — Redis Key Isolation Audit

### 2.1 All Redis key patterns

| Key pattern | File(s) | Includes shop? | Normalization before key creation |
|-------------|---------|----------------|-----------------------------------|
| `decision:${shop}:${cartHash}` | `decision-cache.server.ts` | Yes | **Yes** — only used from cart.decision, which normalizes `shop` at entry | Safe |
| `decision_lock:${shop}:${cartHash}` | `decision-cache.server.ts` | Yes | Same | Safe |
| `catalog:${shop}` | `catalog-warm.server.ts` | Yes | **No** — `shop` from `warmCatalogForShop(shop)`; callers: cart.decision (normalized) and **shopify.server afterAuth** (`session.shop` raw) | **Unsafe** (key duplication risk) |
| `catalog_index:${shop}` | `catalog-index.server.ts`, `catalog-warm.server.ts` | Yes | Same as catalog — cart reads with normalized shop; afterAuth writes with raw session.shop | **Unsafe** (key duplication risk) |
| `catalog:circuit:open:${shop}` | `catalog-warm.server.ts` | Yes | No normalization at caller | **Unsafe** |
| `catalog:circuit:failures:${shop}` | `catalog-warm.server.ts` | Yes | No normalization at caller | **Unsafe** |
| `ratelimit:${shop}:${window}` | `rate-limit.server.ts` | Yes | **Yes** — only used from cart.decision with normalized `shop` | Safe |

### 2.2 Generic keys (no shop namespacing)

- No keys of the form `analytics:summary`, `decision:cache`, or `cart:config` without a shop component were found. All decision, catalog, and rate-limit keys include a shop (or shop-derived) segment.

### 2.3 Unsafe keys summary

- **Unsafe (normalization not guaranteed):**
  - `catalog:${shop}` — written in afterAuth with `session.shop`; read in cart.decision with normalized shop → same shop can have two key namespaces; cache miss / inconsistency.
  - `catalog_index:${shop}` — same as above.
  - `catalog:circuit:open:${shop}` and `catalog:circuit:failures:${shop}` — `shop` from `warmCatalogForShop` callers (afterAuth raw, cart normalized).

- **Full shop-level namespacing:** All keys are per-shop in structure. Guarantee is **weakened** by inconsistent normalization: same logical shop can map to two Redis key namespaces (e.g. `revdev-4.myshopify.com` vs `RevDev-4.myshopify.com`), not by cross-tenant key collision.

---

## PART 3 — Normalization Consistency Audit

### 3.1 Definition of `normalizeShopDomain()`

- **Location:** `revstack/app/lib/shop-domain.server.ts`
- **Behavior:** Lowercase, trim, strip `https?://` and trailing slashes; if not `unknown` and no space, ensure `.myshopify.com` suffix (bare handle → `handle.myshopify.com`).

### 3.2 Used before every Prisma query?

- **No.** Used in: shop-config.server (at entry), onboarding-wizard.server (before each update), app.onboarding (step3 before update), cart.decision (at entry).  
- **Not used** before Prisma in: app.settings (action uses raw `session.shop`), webhooks.billing.update (raw webhook `shop`), billing.server (caller’s shop), retention.server (caller’s shop), app.analytics / app._index (shop from context/session), cleanup.server (global deletes).

### 3.3 Used before every Redis key creation?

- **No.** Decision cache and rate limit: shop comes from cart.decision only (normalized). Catalog and circuit keys: also used from afterAuth and catalog warm with `session.shop` / passed-through shop — not normalized at boundary.

### 3.4 Locations where shop domain enters the system

| Entry point | Source | Normalization at boundary? |
|-------------|--------|----------------------------|
| Cart decision route | `URL searchParams.get("shop")` | **Yes** — `normalizeShopDomain(shopRaw)` |
| Admin layout (app.tsx) | `auth.session.shop` or `ctx.shop` | **No** |
| run-app-auth.server | `session.shop` | **No** |
| App layout context (setAppLayoutInContext) | Same `shop` from above | **No** |
| app.analytics loader | `appLayout.shop` or `session.shop` | **No** |
| app._index loader | Same | **No** |
| app.settings loader/action | Same / `session.shop` | **No** |
| app.onboarding loader/action | Same / `session.shop` | **No** (only step3_configure normalizes before Prisma) |
| Billing webhook | `authenticate.webhook(request)` → `shop` | **No** |
| Orders webhook | Same | **No** |
| afterAuth hook (shopify.server) | `session.shop` | **No** |
| getShopConfig / invalidateShopConfigCache | Any caller | **Yes** (internal) |

### 3.5 Inconsistent usage paths

- **Admin/context path:** Shop flows from session → layout context → child loaders. Never normalized. Used in getAnalyticsMetrics, getRetentionContext, touchLastActive, getDashboardMetrics, prisma.shopConfig.update (app.settings), ensureActivatedAt, retention Prisma, billing context.
- **Storefront decision path:** Shop normalized once at cart.decision entry; all Prisma/Redis in that path use normalized value.
- **Webhook path:** Shop from Shopify webhook auth; not normalized before Prisma or (where applicable) Redis.
- **afterAuth:** Writes catalog/catalog_index with raw session.shop; cart reads with normalized shop → same shop can have two key namespaces.

---

## PART 4 — Cross-Store Leakage Simulation Risk

### 4.1 Can Redis key collision cause store A to see store B’s analytics?

- **Direct analytics keys:** There are no Redis keys that store analytics aggregates (e.g. no `analytics:summary`). Analytics are computed from Prisma (DecisionMetric, CrossSellConversion, OrderInfluenceEvent) and cached in **process memory** in `analytics.server.ts` (`analyticsMetricsCache` keyed by `shop`). So Redis key collision is **not** a vector for analytics leakage.
- **Indirect:** Decision cache keys are `decision:${shop}:${cartHash}`. If `shop` were not normalized and two shops normalized to the same string (e.g. case fold), they could share cache. Current normalization lowercases and normalizes; two different myshopify.com domains do not collide. **Confidence: low risk** for cross-store analytics via Redis.

### 4.2 Can a missing Prisma shop filter expose cross-store data?

- **Yes, in one place:** `cleanup.server.ts` runs `decisionMetric.deleteMany` (and other deleteManys) with **no** `shopDomain` filter. This does not “expose” data to another store; it deletes old rows globally. So no read cross-store leak from this.
- **Read exposure:** All **read** queries (analytics, retention, dashboard, config) use a `shop` or `shopDomain` in the where clause. Risk is **wrong shop** if `shop` is inconsistent (e.g. un-normalized session value that doesn’t match DB). If DB stores normalized and session sometimes is not, the query can miss the row (e.g. update 0 rows) or, in theory, match a different tenant only if there were a bug producing the same string. **Confidence: medium** — no missing shop filter on reads; exposure would be from normalization inconsistency leading to wrong/missed row, not from a filter-free query.

### 4.3 Are there any endpoints that return analytics without shop scoping?

- **No.** Analytics are returned only from admin routes (e.g. app.analytics, app._index) that use `shop` from session/layout (the logged-in shop). There is no endpoint that returns analytics keyed by a request parameter without that parameter being tied to the authenticated session. So no **unscoped** analytics endpoint. The only risk is that the **same** shop’s data could be inconsistent or missed if `shop` is not normalized (e.g. cache key vs DB key mismatch). **Confidence: high** — no cross-store return of analytics; shop is always session-derived.

### 4.4 Leakage vectors ranked by severity

| # | Vector | Severity | Confidence | Supporting references |
|---|--------|----------|------------|------------------------|
| 1 | **Prisma writes/updates with un-normalized shop** (e.g. app.settings, webhooks) → wrong or zero rows, or duplicate config keys if casing differed | Medium | High | app.settings.tsx (action), webhooks.billing.update.tsx, retention.server callers |
| 2 | **Redis catalog keys written with raw shop (afterAuth), read with normalized shop (cart)** → same shop has two namespaces; cache inconsistency, no cross-store leak | Medium | High | shopify.server (afterAuth), catalog-warm.server.ts, catalog-index.server.ts, cart.decision.ts |
| 3 | **Analytics/retention in-memory and DB keyed by un-normalized shop** → duplicate cache entries or DB mismatch for same shop | Low–Medium | Medium | analytics.server.ts (cache by `shop`), app.analytics.tsx, app._index.tsx, retention.server.ts |
| 4 | **Global cleanup deleteMany without shop** → deletes all tenants’ old data; no read leak, isolation violation by design | Low (for read leak) | High | cleanup.server.ts |
| 5 | **Orders webhook recordOrderSales(shop)** with raw shop → productSaleEvent rows under possibly un-normalized domain; could fragment data for same shop | Low | Medium | webhooks.orders.tsx, product-metrics.server.ts |

---

## Summary Tables

### Prisma: Shop filter and normalization

- **Strict shop filter on all reads:** Yes, except cleanup (intentional global delete).
- **Normalization at boundary:** No. Only cart.decision and shop-config/onboarding-wizard (and one app.onboarding action) normalize; admin and webhook paths do not.

### Redis: Shop namespacing

- **All keys include shop (or cartHash derived from request):** Yes.
- **Normalization before key use:** Only guaranteed on the cart.decision path (decision cache, rate limit). Catalog/circuit keys can be written with raw `session.shop` (afterAuth).

### Root cause hypothesis

- **Root cause:** Shop is normalized only on the storefront decision path and inside getShopConfig/invalidateShopConfigCache and onboarding-wizard. Admin routes, layout context, webhooks, and afterAuth use `session.shop` (or context derived from it) without normalizing. So Prisma and Redis see multiple representations of the same shop, leading to update misses, duplicate cache namespaces, and potential data fragmentation — rather than classic “store A sees store B’s data” leakage. The main isolation guarantee to enforce is: **normalize at every boundary where shop enters** (session, webhook, query params) before any Prisma or Redis use.

### Confidence level

- **Prisma isolation:** Medium — all read paths are shop-scoped; confidence reduced by lack of normalization at boundaries.
- **Redis isolation:** Medium — keys are shop-namespaced; confidence reduced by catalog/circuit keys using un-normalized shop from afterAuth.
- **Cross-store read leakage:** Low — no identified path where store A can read store B’s analytics; vectors are inconsistency and wrong-row risk for the same shop.
