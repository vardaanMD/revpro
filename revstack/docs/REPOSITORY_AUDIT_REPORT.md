# Complete Repository Audit — Shopify Cart Overlay (revPRO / revstack)

**Date:** March 5, 2025  
**Scope:** Full codebase audit for launch preparation  
**Product:** Shopify cart overlay app with upsell, recommendations, free-shipping bar, milestones, and analytics.

---

## 1. ARCHITECTURE OVERVIEW

### 1.1 System Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         SHOPIFY MERCHANT STOREFRONT                          │
│  Theme → App Embed (Liquid) → /apps/cart-pro/snapshot/v3 → __CART_PRO_     │
│  SNAPSHOT__ → Cart Pro V3 Runtime (Svelte in Shadow DOM)                    │
└─────────────────────────────────────────────────────────────────────────────┘
                                        │
                    POST cart (Shopify cart.js shape) + shop, timestamp, signature
                                        ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                    SHOPIFY APP PROXY (prefix: apps, subpath: cart-pro)        │
│  URL: https://<store>.myshopify.com/apps/cart-pro/* → app backend           │
└─────────────────────────────────────────────────────────────────────────────┘
                                        │
                                        ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                         REVSTACK (Canonical Backend)                         │
│  Express + React Router v7 | server.ts                                       │
│  • GET /app/* → runAppAuth → React Router (admin UI)                         │
│  • POST /apps/cart-pro/decision → proxy auth → decision pipeline            │
│  • GET /apps/cart-pro/snapshot/v3 → config + recommendations                 │
│  • POST /apps/cart-pro/analytics/v3 → event ingestion                       │
│  • POST /apps/cart-pro/ai/v2 → AI/same-collection recommendations            │
└─────────────────────────────────────────────────────────────────────────────┘
         │                    │                              │
         ▼                    ▼                              ▼
┌──────────────┐    ┌─────────────────┐            ┌─────────────────────┐
│  PostgreSQL  │    │      Redis      │            │  @revpro/decision-   │
│  (Railway)   │    │  (catalog,      │            │  engine (pure TS)    │
│  Prisma      │    │   decision      │            │  decideCartActions() │
│  Session,    │    │   cache,        │            │  No I/O, no side     │
│  ShopConfig, │    │   catalog_index,│            │  effects              │
│  analytics   │    │   rate limit    │            └─────────────────────┘
└──────────────┘    └─────────────────┘
```

- **Frontend (storefront):** Svelte app (Cart Pro V3 Runtime) bundled as IIFE, loaded by theme extension block. Mounted in **open shadow DOM** on host `#cart-pro-root`. Config from `window.__CART_PRO_SNAPSHOT__` (set by Liquid after fetching `/apps/cart-pro/snapshot/v3`).
- **Backend:** Single Node app in `revstack/`: Express with React Router v7 for admin and API. All storefront traffic goes through **Shopify App Proxy** to revstack.
- **Database:** PostgreSQL (Railway) via Prisma.
- **Cache/Session:** Redis for decision cache, catalog snapshot, catalog index, rate limit, locks; Prisma for Shopify session storage.
- **Deprecated:** `apps/api/` is not used by the Shopify storefront; revstack is the only live decision backend.

### 1.2 Technologies & Frameworks

| Layer | Technology |
|-------|------------|
| Backend server | Node.js, Express 5, React Router v7 |
| Admin UI | React 18, React Router, Shopify App Bridge, Polaris-style (s-* components) |
| Storefront widget | Svelte, Vite (IIFE build) |
| DB | PostgreSQL, Prisma 6.x |
| Cache / coordination | Redis (ioredis) |
| Decision logic | Pure TypeScript package `@revpro/decision-engine` (no framework) |
| Theme integration | Shopify Theme App Extension (Liquid), App Proxy |
| Auth | `@shopify/shopify-app-react-router`, Prisma session storage |
| Validation | Zod |
| Tests | Vitest |
| Deployment | Railway (railway.toml), Docker (Dockerfile) |

### 1.3 Data Flow: Shopify → App → Widget

1. **Install / session:** Merchant installs app → OAuth → session stored in Prisma. `afterAuth` triggers `warmCatalogForShop(shop)`.
2. **Storefront load:** Theme renders Cart Pro embed block → Liquid fetches `GET /apps/cart-pro/snapshot/v3` (with proxy params) → response JSON stored in `window.__CART_PRO_SNAPSHOT__` and optionally sessionStorage → Liquid loads `cart-pro-v3.js` (or v2/v1 by `runtimeVersion`) → `mountCartProV3(componentCss)` runs → Engine singleton created, config loaded from snapshot → Svelte App mounted in shadow root.
3. **Cart open / update:** Theme or engine triggers cart sync → `Engine.syncCart()` fetches storefront Cart API → engine state updated; optionally `themeConnector` listens for theme cart events.
4. **Decision request:** When cart is available, widget can POST cart to `POST /apps/cart-pro/decision` (proxy URL with `shop`, `timestamp`, `signature`). Backend: proxy verification → rate limit → parse/validate cart → decision cache (memory → Redis) → on miss: load config, load catalog index from Redis, run `decideCartActions()` → response (crossSell, freeShippingRemaining, milestones, etc.) → cache and return. All amounts in **cents**.
5. **Analytics:** Widget batches events and POSTs to `POST /apps/cart-pro/analytics/v3`. Backend validates and writes to `CartProEventV3` and optionally DecisionMetric/CrossSellConversion.
6. **AI recommendations (overlay):** Widget POSTs `{ lastAddedProductId }` to `POST /apps/cart-pro/ai/v2`; backend returns same-collection products from `ShopProduct` (no Redis decision path).

---

## 2. CODEBASE INVENTORY

### 2.1 Directory Structure and Purposes

```
revPRO/
├── revstack/                          # Main Shopify app (only live backend for storefront)
│   ├── app/
│   │   ├── routes/                    # React Router routes (file-based)
│   │   │   ├── _index/                # Root redirect
│   │   │   ├── app.tsx                # Admin layout (embedded app)
│   │   │   ├── app._index.tsx         # Dashboard home
│   │   │   ├── app.settings.tsx       # App settings
│   │   │   ├── app.billing.tsx        # Billing status & plan
│   │   │   ├── app.upgrade.tsx        # Plan selection / subscription
│   │   │   ├── app.onboarding.tsx     # Onboarding wizard
│   │   │   ├── app.analytics.tsx      # Analytics dashboard
│   │   │   ├── app.preview-v3-frame.ts # V3 preview iframe
│   │   │   ├── app.dev.flush.ts       # Dev cache flush
│   │   │   ├── auth.$.tsx             # Auth catch-all
│   │   │   ├── auth.login/            # Login
│   │   │   ├── cart.decision.ts       # POST: decision endpoint (proxy)
│   │   │   ├── cart.bootstrap.ts      # Legacy bootstrap
│   │   │   ├── cart.bootstrap.v2.ts   # Legacy bootstrap v2
│   │   │   ├── cart.snapshot.v2.ts    # Snapshot v2
│   │   │   ├── cart.snapshot.v3.ts    # Snapshot v3 (config + recommendations)
│   │   │   ├── cart.analytics.event.ts # Legacy analytics
│   │   │   ├── cart.analytics.v3.ts   # V3 analytics ingestion
│   │   │   ├── cart.ai.v2.ts          # AI/same-collection recommendations
│   │   │   ├── health.ts              # Public health
│   │   │   ├── health.internal.ts     # Internal health
│   │   │   ├── ready.ts               # Readiness
│   │   │   ├── debug.warm.ts          # Debug catalog warm
│   │   │   └── webhooks.*.tsx         # Webhook handlers (see §3)
│   │   ├── lib/                       # Server-only utilities (.server.ts)
│   │   │   ├── prisma.server.ts
│   │   │   ├── redis.server.ts
│   │   │   ├── env.server.ts
│   │   │   ├── shopify.server.ts      # Shopify app config
│   │   │   ├── run-app-auth.server.ts # Pre-loader auth for /app/*
│   │   │   ├── request-context.server.ts
│   │   │   ├── shop-config.server.ts
│   │   │   ├── billing-context.server.ts
│   │   │   ├── capabilities.server.ts
│   │   │   ├── proxy-auth.server.ts   # App proxy signature + replay check
│   │   │   ├── decision-cache.server.ts
│   │   │   ├── catalog.server.ts      # Admin API catalog fetch
│   │   │   ├── catalog-warm.server.ts # Redis catalog + warm
│   │   │   ├── catalog-cache.server.ts
│   │   │   ├── catalog-index.server.ts # Prebuilt index for decision
│   │   │   ├── catalog-warm.server.ts
│   │   │   ├── decision-response.server.ts
│   │   │   ├── validation.server.ts   # Zod cart schema
│   │   │   ├── safe-handler.server.ts
│   │   │   ├── rate-limit.server.ts
│   │   │   ├── webhook-idempotency.server.ts
│   │   │   ├── analytics.server.ts
│   │   │   ├── cleanup.server.ts       # Retention cleanup
│   │   │   ├── retention.server.ts     # Health/milestones
│   │   │   ├── config-v3.ts           # V3 config types + merge
│   │   │   ├── feature-flags-from-billing.server.ts
│   │   │   ├── upsell-engine-v2/      # buildSnapshot, types
│   │   │   └── ... (logger, format, onboarding, etc.)
│   │   ├── components/                # React admin components
│   │   ├── entry.server.tsx
│   │   ├── root.tsx
│   │   └── routes.ts                  # flatRoutes()
│   ├── cart-pro-v3-runtime/           # Svelte storefront widget
│   │   ├── src/
│   │   │   ├── main.ts                # Entry; calls mountCartProV3
│   │   │   ├── mount.ts               # Host, shadow DOM, bootstrap, engine singleton
│   │   │   ├── engine/                # Engine.ts + state, cartApi, analytics, etc.
│   │   │   ├── ui/                    # App.svelte, Drawer.svelte, v2/*
│   │   │   ├── integration/           # themeConnector
│   │   │   └── styles/                # cart-pro-v2.css, cart-pro-v3.css
│   │   └── vite.config.ts             # IIFE build → extensions/cart-pro/assets
│   ├── extensions/cart-pro/           # Theme App Extension
│   │   └── blocks/cart_pro_embed_v3.liquid
│   ├── packages/decision-engine/      # Pure TS: decideCartActions()
│   ├── prisma/
│   │   ├── schema.prisma
│   │   └── migrations/
│   ├── server.ts                      # Express + React Router
│   ├── shopify.app.toml
│   ├── railway.toml
│   ├── Dockerfile
│   └── tests/
├── apps/api/                          # DEPRECATED (not used by storefront)
└── ARCHITECTURE.md
```

### 2.2 Main Application Entry Points

| Entry | Path | Purpose |
|-------|------|--------|
| Server | `revstack/server.ts` | Express app; RSC or createRequestHandler; runAppAuth for /app/*; health-direct, static assets, extensions-assets |
| Admin app | `revstack/app/root.tsx` | React root; layout from app.tsx |
| Storefront widget | `revstack/cart-pro-v3-runtime/src/main.ts` | Calls `mountCartProV3(componentCss)` from mount.ts |
| Theme embed | `revstack/extensions/cart-pro/blocks/cart_pro_embed_v3.liquid` | Injects #cart-pro-root, fetches snapshot, loads JS by runtimeVersion |

### 2.3 API Endpoints (Storefront-Facing via App Proxy)

Base path via proxy: `https://<store>.myshopify.com/apps/cart-pro/` (backend receives path under `/cart` as configured in shopify.app.toml; subpath `cart-pro`, prefix `apps`).

| Method | Path (logical) | Handler | Purpose |
|--------|----------------|---------|---------|
| GET | /apps/cart-pro/decision | cart.decision.ts loader | Returns 200 "ok" for reachability |
| POST | /apps/cart-pro/decision | cart.decision.ts action | Cart decision (cross-sell, free shipping, milestones); 300ms timeout; safe fallback |
| GET | /apps/cart-pro/snapshot/v3 | cart.snapshot.v3.ts | Config + recommendations for V3; sets __CART_PRO_SNAPSHOT__ |
| POST | /apps/cart-pro/analytics/v3 | cart.analytics.v3.ts | Batch analytics event ingestion |
| POST | /apps/cart-pro/ai/v2 | cart.ai.v2.ts | Same-collection recommendations for last added product |

Admin (no proxy): `/app/*` (e.g. `/app`, `/app/settings`, `/app/billing`, `/app/upgrade`, `/app/onboarding`, `/app/analytics`). Health: `/health-direct`, `/health`, `/health/internal`, `/ready`.

### 2.4 Database Schema (Prisma)

| Model | Purpose |
|-------|---------|
| Session | Shopify session storage (PrismaSessionStorage) |
| ShopConfig | Per-shop config: AOV, free-shipping threshold, milestones, flags, plan, billingStatus, configV3, etc. |
| WebhookEvent | Webhook idempotency (topic + webhookId) |
| DecisionMetric | Per-decision metrics (shop, hasCrossSell, cartValue) |
| CrossSellEvent | Impressions/clicks for cross-sell (90d retention) |
| CrossSellConversion | Add-to-cart from recommendation (90d) |
| CartProEventV3 | Raw V3 analytics events (append-only) |
| ProductSaleEvent | 30d product sales for BEST_SELLING strategy |
| RevproClickSession | Session-level click attribution |
| OrderInfluenceEvent | Order-level influenced flag (from revpro_session_id) |
| ShopProduct | V2 catalog per shop (product id, variantId, title, handle, priceCents, collectionIds, etc.) |

All monetary values in DB and engine are **cents**.

### 2.5 Configuration and Environment

**Required env (see `app/lib/env.server.ts`):**

- `DATABASE_URL` — PostgreSQL (required always)
- `SHOPIFY_API_KEY` — App client ID
- `SHOPIFY_API_SECRET` — App secret (proxy signature verification)
- `REDIS_URL` — Required in production (decision cache, catalog, rate limit)
- `SHOPIFY_APP_URL` — Set by Shopify CLI in dev or deployment URL in prod

**Optional:**

- `PAYWALL_WHITELIST` — Comma-separated shop domains for full access without billing
- `DEV_SKIP_PROXY=1` — Bypass proxy signature in development (e.g. load tests)
- `CART_PRO_DEBUG=1` — Include crossSellDebug in decision response
- `SCOPES` — Override scopes (normally from shopify.app.toml)
- `SHOP_CUSTOM_DOMAIN` — Custom shop domain

There is **no `.env.example`** in the repo; env.server.ts documents required vars in error messages.

---

## 3. SHOPIFY INTEGRATION STATUS

### 3.1 Connection Methods

- **App Proxy:** Configured in `shopify.app.toml`: `url` points to backend, `subpath = "cart-pro"`, `prefix = "apps"`. Storefront requests go to `https://<store>/apps/cart-pro/*` and are forwarded to the app with `shop`, `timestamp`, `signature`, etc.
- **Admin API:** Used for catalog fetch (GraphQL products) in `catalog.server.ts` and during `warmCatalogForShop` (and thus afterAuth). Session from Prisma.
- **Theme App Extension:** `extensions/cart-pro`, type `theme_app_extension`, single block `cart_pro_embed_v3.liquid` (target body).

### 3.2 Scopes

From `shopify.app.toml`: `scopes = "write_products write_app_proxy"`. No `read_orders` in toml; orders/paid webhook is registered (see below)—ensure Partner Dashboard / app setup allows webhook subscription.

### 3.3 Webhooks

| Topic | URI | Handler | Purpose |
|-------|-----|--------|---------|
| app/uninstalled | /webhooks/app/uninstalled | webhooks.app.uninstalled.tsx | Delete sessions for shop |
| compliance | /webhooks/compliance | webhooks.compliance.tsx | GDPR (customers/data_request, customers/redact, shop/redact) |
| app_subscriptions/update | /webhooks/billing/update | webhooks.billing.update.tsx | Billing status sync |
| app/scopes_update | /webhooks/app/scopes_update | webhooks.app.scopes_update.tsx | Scopes update |
| products/* (create/update/delete) | /webhooks/products | webhooks.products.tsx | Trigger catalog warm for shop |
| orders/paid | (in code) | webhooks.orders.tsx | Record product sales (BEST_SELLING), order influence attribution |

Webhook handlers use `authenticate.webhook(request)` and optional idempotency via `recordWebhook(webhookId, shop, topic)` (WebhookEvent table).

### 3.4 App Install / Uninstall

- **Install:** OAuth flow via `@shopify/shopify-app-react-router`. After auth, `afterAuth` in shopify.server.ts runs and calls `warmCatalogForShop(shop)`.
- **Uninstall:** `app/uninstalled` webhook deletes sessions for the shop. No explicit ShopConfig or catalog wipe in the handler (data remains unless cleanup or policy dictates otherwise).

---

## 4. RECOMMENDATION ENGINE ANALYSIS

### 4.1 Implementation vs Business Logic

- **Decision engine:** Pure function `decideCartActions({ cart, catalog, storeMetrics, strategy, debug })` in `packages/decision-engine/src/decideCartActions.ts`. Returns `{ crossSell, freeShippingRemaining, suppressCheckout, decisionLog [, crossSellDebug ] }`. No I/O; thresholds come from `storeMetrics` (baselineAOV, freeShippingThreshold).
- **Strategies implemented:** COLLECTION_MATCH, TAG_MATCH, MANUAL_COLLECTION, BEST_SELLING, NEW_ARRIVALS. Default COLLECTION_MATCH. Strategy chosen from config, gated by capability `allowStrategySelection` (else forced to COLLECTION_MATCH).
- **Scoring:** Weights (shared collection 3, tag 2, price proximity 1, same-vendor penalty 2); caps (collections 3, tags 5, price contribution 5). Tie-break: score desc then product id asc.
- **Snapshot vs strategy vs AI:**
  - **Snapshot (v3):** `cart.snapshot.v3.ts` returns config plus **precomputed recommendations** from `getHydratedRecommendationsForShop(shop)` (buildSnapshot + ShopProduct). Used for initial drawer state and for stores that don’t call decision on every cart change.
  - **Strategy-based:** Decision endpoint uses catalog index from Redis (built from Redis catalog); strategy selects catalog slice; `decideCartActions` runs on that catalog. Fully functional for all five strategies.
  - **AI (cart.ai.v2):** Same-collection recommendations for `lastAddedProductId` from ShopProduct table. No ML model; “AI” in name only. Used by widget for overlay recommendations.

### 4.2 Decision Pipeline (cart.decision.ts)

1. POST only; verify proxy signature and replay timestamp (or DEV_SKIP_PROXY in dev).
2. Parse/validate body (Zod cartSchema); max 100 items, 50KB payload.
3. Hash cart → memory cache → Redis cache; on hit return cached decision.
4. Rate limit (Redis or in-memory), 60/min per shop.
5. Load config (getShopConfig); billing gate (getBillingContext) — if not entitled return safe decision (no cross-sell, no metrics write).
6. Load catalog index from Redis; on miss return safe decision and trigger async catalog warm.
7. Concurrency lock (Redis) to avoid duplicate compute.
8. Build storeMetrics from config; effective strategy from capabilities + config; resolve catalog from index by strategy; for BEST_SELLING merge 30d sales from DB.
9. Call `decideCartActions()`; apply capability caps (maxCrossSell, allowMilestones, allowCouponTease); write CrossSellEvent (impressions) and DecisionMetric; cache response; return 200 with decision (or safe fallback on any error).
10. **300 ms hard timeout:** At several steps, if over time, return safe decision immediately.

### 4.3 Snapshot and Strategy and AI Summary

| Feature | Implemented | Notes |
|---------|-------------|--------|
| Snapshot (config + recommendations) | Yes | cart.snapshot.v3.ts; recommendations from buildSnapshot + ShopProduct |
| Strategy-based (engine) | Yes | All 5 strategies; catalog from Redis index |
| “AI” recommendations (overlay) | Yes | cart.ai.v2: same-collection from ShopProduct by lastAddedProductId |

---

## 5. FRONTEND / WIDGET STATUS

### 5.1 Cart Overlay UI Components

- **Entry:** `cart-pro-v3-runtime/src/ui/App.svelte` — subscribes to engine state; shows “Open V3 Drawer” when content ready; contains `DrawerV2`.
- **Drawer:** `DrawerV2.svelte` — cart items, recommendations, milestones, coupon section, shipping section, checkout section. Uses engine state (cart, discount, rewards, upsell, checkout, shipping).
- **Subcomponents:** CartItems, CartItem, Recommendations, RecommendationCard, Milestones, CouponSection, ShippingSection, CheckoutSection.
- **Styles:** `cart-pro-v2.css`, `cart-pro-v3.css`; injected into shadow root. Vite build inlines component CSS into JS and emits `cart-pro-v3.css` to `extensions/cart-pro/assets/`.

### 5.2 Mobile Responsiveness

- Host element is fixed full viewport (`position: fixed; inset: 0; width: 100vw; height: 100vh`). Drawer and layout are styled in CSS; no separate mobile entry point found. Responsiveness is via CSS (media queries in the provided CSS files).

### 5.3 User Interactions and Handlers

- **Engine** (Engine.ts): syncCart, addToCart, changeCart, removeItem, discount validation, free-gift computation, upsell (standard + “AI” from recommendationsApi), rewards tier, checkout overlay (open/close), analytics batching, countdown. Theme connector subscribes to theme cart events and can trigger sync.
- **Drawer:** Open/close drawer; confetti on milestone; apply discount; navigate to checkout (overlay or external); display free-shipping message and recommendation cards.

### 5.4 Styling and Customization

- **Snapshot config:** `appearance`: primaryColor, accentColor, borderRadius (and countdown, confetti, emoji). Passed to runtime via snapshot; `mount.ts` sets CSS variables `--cp-primary`, `--cp-accent`, `--cp-radius` on host. Shadow DOM receives these.
- **Runtime:** `engine.getConfig()` exposes normalized config; feature flags (enableUpsell, enableDiscounts, etc.) from snapshot control visibility.

---

## 6. BILLING & PLAN MANAGEMENT

### 6.1 Subscription / Billing Integration

- **Billing context:** `billing-context.server.ts` — `getBillingContext(shop, existingConfig)` returns plan, billingStatus, isEntitled, capabilities, accessLevel. Plan from ShopConfig.plan; entitlement from `billingStatus === "active"`. Whitelist: `PAYWALL_WHITELIST` forces growth + entitled.
- **Plans (capabilities.server.ts):** basic, advanced, growth. `resolveCapabilities(plan)` defines capabilities (see below). No direct Shopify Billing API calls in the audited code; `createSubscription` in billing.server.ts suggests subscription creation exists for upgrade flow.
- **Webhook:** `webhooks.billing.update` updates billing state (likely ShopConfig.billingStatus / billingId).

### 6.2 Plan Tiers and Feature Restrictions

| Plan | maxCrossSell | allowStrategySelection | allowUIConfig | allowCouponTease | allowMilestones | allowComparison | allowRevenueDifference | analyticsLevel |
|------|--------------|------------------------|--------------|-----------------|-----------------|----------------|------------------------|----------------|
| basic | 1 | false | false | false | true | false | false | basic |
| advanced | 3 | true | true | true | true | true | false | advanced |
| growth | 8 | true | true | true | true | true | true | advanced |

Decision route and snapshot use these capabilities only (no raw plan checks in decision path).

### 6.3 Usage Tracking and Limits

- **Rate limit:** 60 requests per minute per shop on decision endpoint (Redis or in-memory).
- **Cross-sell cap:** Enforced by `capabilities.maxCrossSell` and config.recommendationLimit (min/max clamped).
- No other usage-based limits (e.g. MAU) observed in code.

---

## 7. DATA MANAGEMENT

### 7.1 Product Catalog Storage and Updates

- **ShopProduct:** Persisted per shop; populated by catalog warm (GraphQL products → transform → upsert). Products webhook and afterAuth trigger `warmCatalogForShop(shop)`.
- **Redis catalog:** Key `catalog:{shop}`; TTL 1h; payload `{ updatedAt, products: MinimalProduct[] }`. Updated by catalog warm.
- **Catalog index:** Key `catalog_index:{shop}`; built from Redis catalog snapshot (productsById, crossSellCandidates, collectionMap, tagMap); used only by decision route. Rebuilt when catalog is warmed (catalog-warm writes both catalog and index).
- **Circuit breaker:** After 3 consecutive Shopify Admin failures for a shop, catalog fetch skipped for 60s (Redis key catalog:circuit:open:{shop}).

### 7.2 Caching and Invalidation

- **Decision cache:** Memory (per process) + Redis. Key by shop + cart hash. TTL 30s. Lock TTL 5s for concurrency. Eviction: max 100 per shop, 5000 global in memory.
- **Catalog:** 1h TTL; invalidation by re-warm (products webhook or afterAuth).
- **Config:** No HTTP cache on snapshot; Cache-Control: no-store on snapshot response.

### 7.3 Background Jobs

- **Catalog warm:** Triggered by products webhook and afterAuth; not a scheduled cron. Async trigger from decision route when catalog index miss (`triggerAsyncCatalogWarm`).
- **Retention cleanup:** `triggerCleanupIfNeeded()` in cleanup.server.ts — runs opportunistically after decision metric write; throttle 10 min. Deletes: DecisionMetric, WebhookEvent (30d), CrossSellEvent, CrossSellConversion (90d). **CartProEventV3 has no retention cleanup** (not deleted in cleanup.server.ts).
- No other cron or queue observed.

### 7.4 Performance Optimizations

- Decision: memory then Redis cache; 300ms timeout; safe fallback on any failure or timeout.
- Catalog: prebuilt index in Redis; decision route does no Admin API or per-request catalog transform.
- Rate limiting and lock to avoid thundering herd.
- Cold start: server pings Redis on boot; Prisma connection retry loop before listen.

---

## 8. DEPLOYMENT STATUS

### 8.1 Deployment Configuration

- **Railway:** `railway.toml` — build: `npm ci && npm run build`; deploy: `npx prisma migrate deploy` then `npm run start`. Root directory for service should be `revstack`.
- **Docker:** `revstack/Dockerfile` — Node 20 Alpine; npm ci, copy app, npm run build, npm run docker-start (migrate deploy + start). Exposes 8080 (app may use PORT env).
- **Shopify:** `shopify.app.toml` — application_url points to Railway URL; app_proxy url points to same; no auto-update URLs in dev.

### 8.2 Environment Requirements

- Node: package.json engines `>=20.19 <22 || >=22.12`.
- Production: DATABASE_URL, REDIS_URL, SHOPIFY_API_KEY, SHOPIFY_API_SECRET, SHOPIFY_APP_URL (or equivalent). No .env.example file.

### 8.3 CI/CD

- No `.github/workflows` or other CI config found in the repo. Lint/typecheck/test are in package.json scripts; not wired to a pipeline in the audit.

### 8.4 Production Considerations

- **Health:** `/health-direct`, `/health`, `/health/internal`, `/ready` exist for probes.
- **Secrets:** API secret and Redis URL must be in env; no hardcoding.
- **Proxy:** In production, proxy signature and replay check are mandatory (DEV_SKIP_PROXY only for dev).
- **App URL:** Must match Partner Dashboard and proxy URL (currently Railway staging URL in toml).

---

## 9. GAPS & MISSING PIECES

### 9.1 Features in Config / Docs vs Implemented

- **enableFreeGifts:** Feature flag in config-v3; `featureFlagsFromCapabilities` sets `enableFreeGifts: false` always. Engine has free-gift logic; backend may not expose it in snapshot.
- **allowRevenueDifference:** Growth capability; used for “estimated revenue difference” in plan copy; no revenue-difference computation found in decision or analytics routes.
- **CartProEventV3 retention:** Schema and ingestion exist; no cleanup job for old CartProEventV3 rows (unbounded growth).

### 9.2 Incomplete or Missing

- **.env.example:** Not present; onboarding for new devs is harder.
- **CI/CD:** No GitHub Actions (or other) for test/lint/deploy.
- **CartProEventV3 cleanup:** Add retention (e.g. 90d) and call from `cleanup.server.ts` or a scheduled job.
- **Uninstall data:** app/uninstalled only deletes sessions; ShopConfig and catalog data remain (may be intentional for reinstall or compliance).

### 9.3 Security and Validation

- **Proxy:** Signature and replay check implemented; replay window 5 min.
- **Cart validation:** Zod schema; max items and payload size enforced.
- **Billing:** Entitlement checked before decision compute and before metric writes; capabilities cap cross-sell count (request tampering cannot exceed plan).
- **Admin:** runAppAuth on all /app/*; unauthenticated requests redirect to login.

### 9.4 Error Handling and Edge Cases

- Decision route: try/catch at multiple levels; always returns 200 with safe decision on failure (no 500 to storefront).
- Config load failure in runAppAuth: fallback config used so admin still loads.
- Catalog/index miss: safe decision returned; async warm triggered.
- Rate limit: 429 with standard headers when exceeded.

---

## 10. LAUNCH READINESS ASSESSMENT

### 10.1 Completeness by Feature (0–100%)

| Feature | Completeness | Notes |
|---------|--------------|--------|
| Architecture & backend | 95% | Single backend, clear data flow; apps/api deprecated but present |
| Shopify integration | 90% | Proxy, webhooks, extension; ensure orders/paid and products webhooks registered |
| Decision engine | 95% | Pure, tested; all strategies; timeout and fallback |
| Snapshot + recommendations | 90% | V3 snapshot and hydrated recs; strategy and “AI” both used |
| Storefront widget | 85% | Drawer, cart, recommendations, milestones, checkout overlay; mobile via CSS |
| Billing & plans | 85% | Capabilities and entitlement enforced; upgrade flow and webhook in place |
| Catalog & cache | 90% | Redis catalog + index; warm on webhook/auth; circuit breaker |
| Analytics | 80% | V3 ingestion and DecisionMetric; CartProEventV3 no retention |
| Deployment | 75% | Railway + Docker; no CI/CD; env docs in code only |
| Security & resilience | 90% | Proxy auth, rate limit, safe fallbacks, no 500 to storefront |

### 10.2 Critical Blockers for Launch

1. **CartProEventV3 retention** — Define retention (e.g. 90d) and add cleanup to avoid unbounded table growth.
2. **App proxy URL** — Confirm production URL in shopify.app.toml and Partner Dashboard (and redirect_urls) for go-live.
3. **Webhook registration** — Ensure orders/paid and products webhooks are registered and reachable in production (HTTPS, correct app URL).

### 10.3 Nice-to-Have vs Must-Have

- **Must-have:** Decision and snapshot working; proxy and auth; billing gating; catalog warm; basic analytics and retention cleanup for events.
- **Nice-to-have:** .env.example; CI (lint + test + typecheck); optional CartProEventV3 aggregation for dashboard; enableFreeGifts wired to capabilities if product requires it.

### 10.4 Immediate Next Steps

1. Add retention cleanup for **CartProEventV3** (e.g. delete older than 90d) in `cleanup.server.ts` or equivalent, and run it periodically.
2. Add **.env.example** with DATABASE_URL, REDIS_URL, SHOPIFY_API_KEY, SHOPIFY_API_SECRET, SHOPIFY_APP_URL (and optional PAYWALL_WHITELIST, DEV_SKIP_PROXY, CART_PRO_DEBUG).
3. Verify **production URLs** (application_url, app_proxy, redirect_urls) and **webhook endpoints** for the production domain.
4. Run full regression: install app on a dev store, add products, trigger product and order webhooks, open cart, verify decision and snapshot responses and widget behavior.
5. Optionally add **CI** (e.g. GitHub Actions) to run `npm run lint`, `npm run typecheck`, `npm run test` on push/PR.

---

*End of audit. All references are to the revstack codebase and related packages as of the audit date.*
