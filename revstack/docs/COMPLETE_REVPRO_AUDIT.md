# Complete RevPRO Repository Audit — Features, Architecture & Business Logic

This audit documents **what actually exists and works** in the codebase, with code references and business impact. It focuses on the **revstack** app (canonical backend); `apps/api` is deprecated and not used by the storefront.

---

## 1. FEATURE INVENTORY

### 1.1 Cart Widget Features (What Actually Appears in the Overlay)

| Feature | Current State | Code Evidence | Business Impact |
|--------|----------------|---------------|-----------------|
| **Cart items** | Rendered from Shopify cart; line items with quantity, price, remove/update. | `ui/v2/CartItems.svelte`, `ui/v2/CartItem.svelte`; state from `engine.stateStore.cart.raw`. | Core cart UX. |
| **Recommendations (cross-sell)** | Shown as “You may also like”; primary source = snapshot then decision refinement; fallback = standard + AI. | `ui/v2/Recommendations.svelte`, `RecommendationCard.svelte`; `state.snapshotRecommendations` / `upsell.standard` / `upsell.aiRecommendations`. | Drives add-ons and AOV. |
| **Milestones (rewards)** | Progress tiers with thresholds; confetti on new tier unlock. | `ui/v2/Milestones.svelte`; `state.rewards.tiers`, `unlockedTierIndex`, `showConfetti`; `rewards.ts` (computeUnlockedTier). | Gamification and threshold messaging. |
| **Free shipping bar** | “Add $X more for free shipping” or “You’re eligible for free shipping!” | `ui/v2/ShippingSection.svelte` (via DrawerV2); `state.shipping.remaining`, `shipping.unlocked`; threshold from config. | Incentivizes cart size. |
| **Discount / coupon** | Apply/remove codes; stacking config; validation via backend. | `ui/v2/CouponSection.svelte`; `discountApi.ts` (validateDiscount, removeDiscountFromCart); `state.discount`. | Coupon tease (plan-gated). |
| **Checkout** | Overlay iframe to checkout URL or standard link. | `ui/v2/CheckoutSection.svelte`; `state.checkout.checkoutUrl`, `overlayVisible`; checkout overlay in DrawerV2. | Converts cart to order. |
| **Urgency countdown** | Optional countdown timer (config-driven). | `engine/countdown.ts`; `config.appearance.countdownEnabled`, `countdownDurationMs`. | Urgency without blocking. |
| **Open drawer trigger** | “Open V3 Drawer” button when content ready; theme cart icons open same drawer. | `App.svelte`; `themeConnector.ts` (cart icon click → open drawer). | Single entry point for cart. |

**Improvement areas:** No free-gift UI block in drawer (logic exists in engine); no explicit “free shipping progress bar” component (message only). Mobile is same drawer (no dedicated mobile layout).

---

### 1.2 Admin Dashboard Features (What Merchants Can Configure)

| Feature | Current State | Code Evidence | Business Impact |
|--------|----------------|---------------|-----------------|
| **Settings** | Appearance (primary/accent/radius, confetti, countdown, emoji), cross-sell/milestones/coupon toggles, strategy, recommendation limit, manual collections, milestones JSON, runtime version. | `app.settings.tsx`; `settings-validation.server.ts`; `config-v3.ts`; persisted in `ShopConfig.configV3` + flat fields. | Full control over look and behavior. |
| **Analytics** | 7-day trend (decisions, show rate, add rate, avg cart value), 30-day summary, cart revenue; optional previous-period comparison (Advanced+); Order Impact / lift (Growth). | `app.analytics.tsx`; `analytics.server.ts` (getAnalyticsMetrics, raw SQL on DecisionMetric/CrossSellConversion/OrderInfluenceEvent). | Proof of value and optimization. |
| **Billing / upgrade** | Billing and upgrade routes; plan from config + billing context. | `app.billing.tsx`, `app.upgrade.tsx`; `billing-context.server.ts`, `capabilities.server.ts`. | Monetization and plan limits. |
| **Onboarding** | Onboarding flow and verification. | `app.onboarding.tsx`; `onboarding.server.ts`, `onboarding-wizard.server.ts`. | Activation and setup. |
| **Preview** | Simulated cart and decision for preview. | `app.settings.tsx` (CartPreview); `preview-simulator.server.ts`; `app.preview-v3-frame.ts`. | Safe testing of config. |

**Improvement areas:** No in-admin A/B testing UI; no funnel (view → add → checkout) breakdown; Order Impact requires `revpro_session_id` and RevproClickSession (session linking must be implemented on storefront).

---

### 1.3 Recommendation Types (Active and Functional)

| Type | Source | When Used | Code Evidence |
|------|--------|-----------|---------------|
| **Snapshot (collection-aware)** | V3 snapshot: `buildCollectionAwareRecommendations` → buckets per collection + “default”; strategy/limit from config + capabilities. | On load and when snapshot is present; primary collection from cart items. | `cart.snapshot.v3.ts`; `buildSnapshot.ts` (buildCollectionAwareRecommendations, getHydratedRecommendationsForShop); Engine `loadConfig` + `applyCartRaw` (primary key + bucket). |
| **Decision engine (refinement)** | POST /apps/cart-pro/decision with cart; returns crossSell; 500 ms debounce after cart update. | After cart has items; replaces or refines snapshot list when decision returns. | `cart.decision.ts`; `decisionApi.ts` (fetchDecisionCrossSell); Engine `applyCartRaw` (debounced decision call). |
| **AI recommendations** | POST /apps/cart-pro/ai/v2 with lastAddedProductId; collection-based from catalog. | When `upsell.aiEnabled` and no snapshot recommendations; cached by cart signature. | `cart.ai.v2.ts`; `recommendationsApi.ts`; Engine upsell AI branch in `applyCartRaw`. |
| **Standard (rule-based)** | computeStandardUpsell from config (standardRules). | When no snapshot and no AI or as fallback. | `upsell.ts` (computeStandardUpsell); Engine when `!hasSnapshot`. |

**Improvement areas:** “AI” in UI is currently collection-based (no ML model). BEST_SELLING depends on ProductSaleEvent (orders/paid webhook); NEW_ARRIVALS on product createdAt in catalog.

---

### 1.4 Analytics & Tracking

| Event | Captured | Where Used | Code Evidence |
|-------|----------|------------|---------------|
| **cart:evaluated** | One per drawer open when analytics enabled; hasCrossSell, cartValue. | DecisionMetric-like metrics; admin 7d/30d. | Engine `emitEvent('cart:evaluated', …)`; `cart.analytics.v3.ts` maps to DecisionMetric. |
| **upsell:add** | When user adds from recommendation (isUpsell). | CrossSellConversion; add rate in analytics. | Engine addToCart path `emitEvent('upsell:add', …)`; cart.analytics.v3.ts → CrossSellConversion. |
| **cart:add, cart:change, cart:remove** | Cart mutations. | Raw event log (CartProEventV3). | Engine mutation paths. |
| **checkout:open, checkout:complete** | Checkout flow. | CartProEventV3. | Engine. |
| **discount:apply/remove, freegift:add/remove** | Discount and free-gift actions. | CartProEventV3. | Engine. |
| **Decision route** | Each decision request: impressions (CrossSellEvent), one DecisionMetric (hasCrossSell, cartValue). | Admin analytics; never sent to storefront on error. | `cart.decision.ts` (after response build); fire-and-forget creates. |

**Batching:** Engine queues events; batch size 10, flush 5s; dedup window 300 ms. Endpoint: POST `/apps/cart-pro/analytics/v3`.  
**Improvement areas:** No client-side view/impression for recommendations (only decision-side impressions); no funnel by step (drawer open → add → checkout).

---

### 1.4.1 Drawer ↔ Admin Connectivity Verification

| Data / Feature | Storefront (Drawer) | Backend ingestion | Admin display | Status |
|----------------|---------------------|--------------------|----------------|--------|
| **Cart performance (decisions, show rate, add rate, cart revenue)** | Engine emits `cart:evaluated` on drawer open (`onDrawerOpened`), `upsell:add` on add-from-recommendation. Batched to POST `/apps/cart-pro/analytics/v3`. | `cart.analytics.v3.ts` writes to `CartProEventV3`, maps `cart:evaluated` → `DecisionMetric`, `upsell:add` → `CrossSellConversion`. | `getAnalyticsMetrics()` / `getDashboardMetrics()` read `DecisionMetric` + `CrossSellConversion`; Dashboard and Analytics pages use these. | **Connected** |
| **App proxy** | Storefront uses `/apps/cart-pro/snapshot/v3`, `/apps/cart-pro/decision`, `/apps/cart-pro/analytics/v3`. | `shopify.app.toml` app_proxy: `url` + subpath `cart-pro`, prefix `apps`. Routes: `cart.snapshot.v3`, `cart.decision`, `cart.analytics.v3` (auth: `authenticate.public.appProxy`). | N/A | **Connected** |
| **Cart preview (Settings)** | N/A (admin-only). | Settings loader: `generatePreviewDecision` (V2-style) + CartPreview component; optional V3 iframe `app.preview-v3-frame` with `__CART_PRO_V3_SNAPSHOT__`. | Settings page shows simulated cart/decision from current config (React CartPreview or V3 iframe). Not live storefront cart. | **Connected** (preview = config-driven simulation) |
| **Order revenue / Order Impact** | V3 sets `revpro_session_id` on cart via `updateCartAttributes` after sync; uses same id as analytics `sessionId` (from localStorage). Emits `recommendation:click` when adding from recommendation; `cart.analytics.v3.ts` upserts `RevproClickSession`. | `webhooks.orders.tsx` (orders/paid) creates `OrderInfluenceEvent` using `revpro_session_id` from order `note_attributes` + `RevproClickSession` lookup. | Analytics/Dashboard show Order Impact (avg with/without, influenced orders, lift %) from `OrderInfluenceEvent`. | **Connected** (cart attribute + recommendation:click → RevproClickSession). |

**Notes:**  
- **Decision double-count (resolved):** V3 storefront sends `X-Cart-Pro-Runtime: v3` on the decision request; `cart.decision.ts` skips creating `DecisionMetric` when that header is present, so only analytics v3's `cart:evaluated` writes the metric for V3.  

---

### 1.5 Billing & Plan Restrictions (Enforced in Code)

| Plan | Cross-sell | Strategy | UI config | Coupon tease | Milestones | Comparison | Revenue/lift |
|------|------------|----------|-----------|--------------|------------|------------|----------------|
| **basic** | 1 rec | COLLECTION_MATCH only | No | No | Yes | No | No |
| **advanced** | 3 recs | Any | Yes | Yes | Yes | Yes | No |
| **growth** | 8 recs | Any | Yes | Yes | Yes | Yes | Yes (Order Impact) |

**Enforcement:** `capabilities.server.ts` (resolveCapabilities); `billing-context.server.ts` (getBillingContext, isWhitelisted); decision route uses `capabilities.*` only (no raw plan checks). Snapshot and settings use same capabilities/feature flags.  
**Code:** `cart.decision.ts` (effectiveLimit = min(config.recommendationLimit, capabilities.maxCrossSell); milestones/coupon/strategy gated by capabilities); `feature-flags-from-billing.server.ts` (enableUpsell, enableRewards, enableDiscounts, etc.).  
**Improvement areas:** Plan stored in ShopConfig; no in-code subscription tier names from Shopify billing API (billingStatus active/inactive used for entitlement).

---

## 2. BACKEND ARCHITECTURE ANALYSIS

### 2.1 Data Flow: Storefront → Backend → Response

1. **Page load:** Theme extension injects `#cart-pro-root`, fetches GET `/apps/cart-pro/snapshot/v3` (app proxy), sets `window.__CART_PRO_SNAPSHOT__`, loads runtime (v1/v2/v3 from config).
2. **Runtime init:** `mount.ts` → bootstrap from snapshot or sessionStorage → applyAppearanceVariables → mount App → Engine.init(), loadConfig(snapshot).
3. **Cart open:** Theme connector or “Open V3 Drawer” → engine opens drawer; Engine syncCart() → GET cart (Shopify Cart API) → applyCartRaw.
4. **applyCartRaw:** Reconcile cart state; set shipping from config threshold; rewards (unlocked tier); snapshot recommendations from collection bucket or legacy list; debounced 500 ms → POST `/apps/cart-pro/decision` with cart → on response, set snapshotRecommendations if cart signature matches.
5. **Analytics:** Engine emits events → batched POST `/apps/cart-pro/analytics/v3` (batch 10, 5s).

**Code:** `extensions/cart-pro/blocks/cart_pro_embed_v3.liquid`; `mount.ts`; `Engine.ts` (syncCart, applyCartRaw, decisionDebounceTimer); `cart.decision.ts`; `cart.analytics.v3.ts`.

---

### 2.2 Caching Strategy

| What | Where | TTL / Limits | Code Evidence |
|------|--------|--------------|---------------|
| **Decision response** | In-memory (per process) + Redis | 30 s; 100/shop, 5000 global (memory). | `decision-cache.server.ts` (getCachedDecision, getCachedDecisionFromRedis, setCachedDecision); cart hash = SHA256(cart JSON). |
| **Catalog (decision path)** | Redis | 1 hour (catalog warm). | `catalog-warm.server.ts` (REDIS_TTL_SECONDS 3600); key `catalog:${shop}`. |
| **Catalog index (decision)** | Redis | Built from catalog snapshot; no separate TTL. | `catalog-index.server.ts` (getCatalogIndexFromRedis); key `catalog_index:${shop}`. |
| **Snapshot** | No cache | Response `Cache-Control: no-store`. | `cart.snapshot.v3.ts`. |
| **Config (admin)** | Request context (layout) | Per request in app layout. | `run-app-auth.server.ts`; getShopConfig in layout. |

**Concurrency:** Decision route uses Redis lock (tryLockDecision) 5 s TTL to avoid duplicate compute for same shop+cartHash; on lock fail, short sleep then re-check Redis cache.

---

### 2.3 Performance Optimizations

- **Decision:** 300 ms hard timeout; on over-time or failure return safeDecisionResponse() (empty crossSell, no suppression); cart UX over perfect logic.
- **Catalog:** No per-request Admin API; decision uses prebuilt Redis catalog index; index built from Redis catalog snapshot (buildCatalogIndexFromSnapshot); resolveStrategyCatalogFromIndex is pure select/slice.
- **Pipeline:** In-memory → Redis decision cache; rate limit (60/min/shop) after cache miss; config/catalog/engine only on miss.
- **Metrics writes:** Fire-and-forget (DecisionMetric, CrossSellEvent); never block response.
- **Widget:** Snapshot first (instant recommendations from collection buckets); decision refines in background; debounce 500 ms.

**Code:** `cart.decision.ts` (DECISION_TIMEOUT_MS 300, overTime() checks, safeDecisionResponse); `catalog-index.server.ts`; `decision-cache.server.ts`.

---

### 2.4 Error Handling

- **Decision route:** All failures (validation, config load, catalog miss, billing not entitled, lock contention, decision build, top-level catch) return **200** with safeDecisionResponse() so storefront never sees 5xx.
- **Billing/config:** getBillingContext and getShopConfig on failure return safe fallback (isEntitled: false, basic capabilities); loaders avoid throwing.
- **Analytics:** Event create failures logged; batch send failure handled by Engine (retry/backoff).
- **Redis/catalog:** On Redis/catalog errors, decision uses safe fallback; catalog warm triggers async on index miss.

**Code:** `cart.decision.ts` (try/catch, safeDecisionResponse); `billing-context.server.ts`; `safe-handler.server.ts` (withSafeHandler for action 500 catch).

---

### 2.5 Rate Limiting & Security

- **Decision:** 60 requests per 60 s per shop (Redis or in-memory fallback); 429 when exceeded; headers X-RateLimit-*.
- **Proxy:** verifyProxySignature (HMAC of query + body) and checkReplayTimestamp; DEV_SKIP_PROXY=1 in dev.
- **Payload:** MAX_PAYLOAD_BYTES 50_000, MAX_CART_ITEMS 100; cartSchema validation.

**Code:** `rate-limit.server.ts`; `proxy-auth.server.ts`; `cart.decision.ts` (validation, body size, item count).

---

## 3. BUSINESS LOGIC DEEP DIVE

### 3.1 Recommendation Algorithm (Strategies)

| Strategy | Behavior | Code Evidence |
|----------|----------|---------------|
| **COLLECTION_MATCH** | Eligible = in-stock, not in cart, share ≥1 collection with cart. Score: shared collections (cap 3)×3 + shared tags (cap 5)×2 + price proximity (cap 5) − same vendor 2. Sort by score desc, then product id. | `decideCartActions.ts` (COLLECTION_MATCH); `scoreProduct`; WEIGHT_* / CAP_* constants. |
| **TAG_MATCH** | If cart has tags: eligible = share tag with cart. Else: fallback to collection overlap. Same scoring. | `decideCartActions.ts` (TAG_MATCH). |
| **MANUAL_COLLECTION** | Catalog = products in manualCollectionIds only. Tier: collection overlap with cart then score. | `decideCartActions.ts` (MANUAL_COLLECTION); catalog from resolveStrategyCatalogFromIndex (MANUAL_COLLECTION). |
| **BEST_SELLING** | Sort by salesCount (30-day ProductSaleEvent). If density weak (max−min ≤ 1) and cart has collections: use collection overlap then score + salesCount tie-break. | `decideCartActions.ts` (BEST_SELLING); `product-metrics.server.ts` (getProductSalesCounts30d); orders/paid webhook records sales. |
| **NEW_ARRIVALS** | Sort by createdAt desc; tie-break score. | `decideCartActions.ts` (NEW_ARRIVALS); catalog index has createdAt. |

**Pricing & scoring:** All amounts in cents. Price proximity: max(0, 10000 − |priceDelta|)/2000, cap 5. No configurable weights; fixed weights in engine.

---

### 3.2 Capability Gating in Practice

- **Decision:** effectiveStrategy = allowStrategySelection ? config.recommendationStrategy : "COLLECTION_MATCH". effectiveLimit = min(max(1, config.recommendationLimit), capabilities.maxCrossSell). Milestones/coupon only if capabilities.allowMilestones / allowCouponTease and config enabled.
- **Snapshot:** featureFlags from capabilities (enableUpsell, enableRewards, enableDiscounts, etc.); buildCollectionAwareRecommendations uses same effectiveStrategy/effectiveLimit as elsewhere.
- **Admin:** Analytics Order Impact and previous-period comparison only when capabilities.allowRevenueDifference / allowComparison.

---

### 3.3 Revenue Attribution

- **Cart revenue:** 30-day sum of cartValue where hasCrossSell (DecisionMetric); shown in analytics.
- **Order Impact (Growth):** OrderInfluenceEvent (orders/paid webhook): orderValue, influenced (true if order contains a product from RevproClickSession clicked list). 7-day avg order value with vs without influence; lift % when both sides have ≥30 samples.
- **Session linking:** Requires storefront to set `revpro_session_id` (e.g. note_attributes) and to record clicks in RevproClickSession (recommended + clicked product IDs). Orders webhook reads note_attributes and looks up RevproClickSession.

**Code:** `analytics.server.ts` (cartRevenue, orderImpact, ORDER_IMPACT_MIN_SAMPLES); `webhooks.orders.tsx` (OrderInfluenceEvent, RevproClickSession lookup).

---

## 4. SNAPSHOT VS DECISION ENGINE

| Aspect | Snapshot (V3) | Decision |
|--------|----------------|----------|
| **Endpoint** | GET `/apps/cart-pro/snapshot/v3` | POST `/apps/cart-pro/decision` |
| **When** | Page load (Liquid fetches); runtime loadConfig. | After cart update; debounced 500 ms in Engine. |
| **Data source** | ShopProduct (DB) + buildCollectionAwareRecommendations; per-collection buckets + “default”. | Redis catalog index → resolveStrategyCatalogFromIndex → decideCartActions (cart + catalog + storeMetrics). |
| **Output** | recommendationsByCollection, productToCollections, recommendations (default bucket), config, featureFlags. | crossSell, freeShippingRemaining, suppressCheckout, milestones, enableCouponTease. |
| **Latency** | Snapshot: DB + build; no cache (no-store). Decision: cache hit ~0; miss: config + Redis index + engine; 300 ms timeout. | |
| **UX** | User sees snapshot recommendations immediately (from bucket for primary collection or default). Decision refines list when response returns (same cart signature). | |

**Current implementation:** Snapshot gives instant, collection-aware list; decision refines with full cart and strategy/scoring. Engine prefers snapshot when present; decision overwrites snapshotRecommendations only when result has items and signature matches.

**Code:** `cart.snapshot.v3.ts`; `buildSnapshot.ts` (buildCollectionAwareRecommendations); `cart.decision.ts`; Engine `applyCartRaw` (bucket vs decision path).

---

## 5. WIDGET BEHAVIOR ANALYSIS

### 5.1 Load Sequence

1. Theme loads; Liquid runs block → creates `#cart-pro-root`, script runs.
2. Fetch GET `/apps/cart-pro/snapshot/v3` (or use sessionStorage cache then re-fetch in background).
3. Set `window.__CART_PRO_SNAPSHOT__`; optionally sessionStorage; load runtime script (v1/v2/v3 by config.runtimeVersion).
4. Runtime: mount.ts → ensureBodyHost (#cart-pro-root), bootstrapConfig(engine, host), applyAppearanceVariables, attach shadow DOM, inject CSS, mount App.
5. App.svelte: onMount enqueue syncCart(); when cart.raw set, contentReady = true → “Open V3 Drawer” and DrawerV2 content show.
6. Theme connector: bind cart icon clicks → open drawer; optionally open on external cart update.

**Code:** `cart_pro_embed_v3.liquid`; `mount.ts`; `App.svelte`.

---

### 5.2 User Interactions

- Open/close drawer (overlay click, close button).
- Change quantity, remove line (Engine → cart API → syncCart).
- Add from recommendations (addToCart; isUpsell → upsell:add).
- Apply/remove discount (validateDiscount, removeDiscountFromCart, syncCart).
- Checkout (navigate or overlay iframe).
- No in-drawer search or promo code input beyond coupon field.

---

### 5.3 Mobile

- Same drawer and components; host is full viewport (fixed, 100vw/100vh). No separate mobile layout or bottom sheet component.

---

### 5.4 Theme Integration

- **Embed:** Theme app extension block “Cart Pro V3” (body target); merchant enables in Theme customizer.
- **Cart icon:** themeConnector binds DEFAULT_CART_SELECTORS (e.g. a[href="/cart"], .cart-icon); optional openOnExternalCartUpdate.
- **Other carts:** injectHideOtherCartsStyle hides cart-drawer, #CartDrawer, .js-drawer-open::after; themeConnector can hide additional selectors (merchantCartDrawerSelector or defaults).

**Code:** `themeConnector.ts`; `mount.ts` (injectHideOtherCartsStyle); `extensions/cart-pro/blocks/cart_pro_embed_v3.liquid`.

---

### 5.5 Configuration Options (Merchant)

From settings and configV3: primaryColor, accentColor, borderRadius, showConfetti, countdownEnabled, emojiMode, countdownDurationMs; enableCrossSell, enableMilestones, enableCouponTease; recommendationStrategy, recommendationLimit, manualCollectionIds; milestonesJson; runtimeVersion (v1/v2/v3); freeShipping threshold. Feature flags derived from capabilities (plan).

---

## 6. REVENUE & CONVERSION TRACKING

- **Metrics:** 7d trend (decisions, show rate, add rate, avg cart value); 30d summary; cart revenue (sum cartValue where hasCrossSell); optional previous 7d/30d (Advanced+); Order Impact 7d with/without influence and lift % (Growth, ≥30 samples).
- **Attribution:** DecisionMetric + CrossSellConversion; OrderInfluenceEvent for order-level influence when RevproClickSession + note_attributes present.
- **A/B testing:** None in code.
- **ROI:** Shown via add rate, cart revenue, and (Growth) order lift; no automated ROI calculator.

**Code:** `analytics.server.ts`; `app.analytics.tsx`; `dashboard-metrics.server.ts` if used elsewhere.

---

## 7. SHOPIFY ECOSYSTEM INTEGRATION

### 7.1 App Proxy

- **Config:** subpath `cart-pro`, prefix `apps`; URL = app backend `/cart`. So storefront requests: `https://store.myshopify.com/apps/cart-pro/*` → backend `/cart/*`.
- **Routes:** cart.decision → POST /cart/decision; cart.snapshot.v3 → GET /cart/snapshot/v3; cart.analytics.v3 → POST /cart/analytics/v3; cart.ai.v2 → POST /cart/ai/v2; cart.bootstrap, cart.bootstrap.v2.
- **Auth:** authenticate.public.appProxy(request); proxy signature and replay check on decision (and analytics.event where used).

**Code:** `shopify.app.toml` ([app_proxy]); route filenames map to paths under /cart.

---

### 7.2 Webhooks

- **orders/paid:** recordOrderSales (ProductSaleEvent for BEST_SELLING); OrderInfluenceEvent (orderValue, influenced via RevproClickSession + note_attributes).
- **products:** Product catalog sync (e.g. ShopProduct / catalog warm).
- **app/uninstalled, billing, compliance, app/scopes_update:** As configured in toml.

**Code:** `webhooks.orders.tsx`; `product-metrics.server.ts`; `catalog-warm.server.ts`; webhooks.*.tsx.

---

### 7.3 Product Catalog Sync

- **Decision path:** Catalog from Redis (catalog warm); warm uses getCatalogForShop (Admin API) or ShopProduct; circuit breaker after 3 failures. Index built from Redis catalog and stored at catalog_index:${shop}.
- **Snapshot V3:** ShopProduct (DB); if count 0, warmCatalogForShop then read; buildCollectionAwareRecommendations from ShopProduct rows.
- **ShopProduct:** Populated by products webhook or catalog sync; id, shopDomain, title, handle, variantId, priceCents, collectionIds, etc.

**Code:** `catalog-warm.server.ts`; `catalog-index.server.ts`; `cart.snapshot.v3.ts`; prisma ShopProduct.

---

### 7.4 Theme App Extension

- One block: Cart Pro V3 (body); no settings in schema. Injects div + script; script fetches snapshot, sets global, loads v1/v2/v3 JS; runtime mounts into #cart-pro-root.

**Code:** `extensions/cart-pro/blocks/cart_pro_embed_v3.liquid`; `shopify.extension.toml`.

---

## 8. SCALABILITY & PRODUCTION READINESS

- **Database:** Decision path avoids per-request catalog fetch; uses Redis index; DecisionMetric/CrossSellEvent/CrossSellConversion indexed (shopDomain, createdAt). Analytics uses raw SQL with date filters.
- **Redis:** Decision cache (30 s); catalog (1 h); catalog index; rate limit; decision lock. On Redis failure, in-memory fallbacks for rate limit and decision cache; catalog miss triggers safe fallback and async warm.
- **Concurrency:** Redis lock for same shop+cartHash; one DecisionMetric + N CrossSellEvent per decision (fire-and-forget).
- **Background:** triggerAsyncCatalogWarm (no job queue); triggerCleanupIfNeeded (e.g. cache trim). No generic job processor.
- **Monitoring:** Logging (logInfo, logWarn, logResilience); dev-metrics (recordTiming, recordTotal); no built-in APM or alerting.

**Code:** `decision-cache.server.ts`; `catalog-warm.server.ts`; `cleanup.server.ts`; `dev-metrics.server.ts`.

---

## 9. COMPETITIVE ANALYSIS (Summary)

- **Feature set:** Cart drawer, cross-sell (multiple strategies), free shipping bar, milestones, coupon, checkout overlay; analytics (decisions, add rate, cart revenue, optional order lift). Matches common upsell/cart apps on core features.
- **Differentiators:** Single decision pipeline (snapshot + decision refinement); collection-aware buckets for fast first paint; capability-based gating; 300 ms decision timeout and safe fallback; no per-request Admin API for decision.
- **Market position:** Mid-tier Shopify cart/upsell app with strategy choice and analytics; Order Impact (Growth) needs session linking to be fully effective.
- **Pricing justification:** Plan tiers (1/3/8 recs, strategy, UI, coupon, comparison, revenue lift) support value-based tiers; whitelist for trials/internal.

---

## 10. GAPS & IMPROVEMENT OPPORTUNITIES

| Area | Gap | Recommendation |
|------|-----|----------------|
| **Features** | No in-drawer free-gift block; no funnel (view→add→checkout); AI is collection-based. | Add free-gift UI block; add funnel metrics; clarify “AI” or add real ML. |
| **Performance** | Snapshot uncached; warm on first request can be slow. | Consider short-lived snapshot cache or edge cache. |
| **UX** | Mobile uses same drawer; “Open V3 Drawer” is generic. | Consider bottom sheet on mobile; configurable CTA. |
| **Technical debt** | Two recommendation paths (snapshot vs decision); some duplicate strategy logic. | Unify where possible; single “recommendation source” contract. |
| **Business logic** | suppressCheckout always false; no threshold tuning in engine. | Document as intentional; add tuning later if needed. |
| **Observability** | No APM/alerting; dev-metrics only. | Add health/readiness and optional APM. |
| **Order attribution** | Order Impact depends on revpro_session_id and RevproClickSession. | Document storefront requirements; add session/click recording if missing. |

---

## Code Reference Index

| Topic | Primary Files |
|-------|----------------|
| Decision endpoint | `app/routes/cart.decision.ts` |
| Decision engine | `packages/decision-engine/src/decideCartActions.ts` |
| Capabilities / billing | `app/lib/capabilities.server.ts`, `app/lib/billing-context.server.ts` |
| Decision cache | `app/lib/decision-cache.server.ts` |
| Catalog index / warm | `app/lib/catalog-index.server.ts`, `app/lib/catalog-warm.server.ts` |
| Snapshot V3 | `app/routes/cart.snapshot.v3.ts`, `app/lib/upsell-engine-v2/buildSnapshot.ts` |
| Config V3 | `app/lib/config-v3.ts`, `app/lib/feature-flags-from-billing.server.ts` |
| Widget mount & engine | `cart-pro-v3-runtime/src/mount.ts`, `cart-pro-v3-runtime/src/engine/Engine.ts` |
| Drawer UI | `cart-pro-v3-runtime/src/ui/App.svelte`, `ui/v2/DrawerV2.svelte` |
| Analytics | `app/routes/cart.analytics.v3.ts`, `app/lib/analytics.server.ts`, `cart-pro-v3-runtime/src/engine/analytics.ts` |
| Theme extension | `extensions/cart-pro/blocks/cart_pro_embed_v3.liquid` |
| Webhooks | `app/routes/webhooks.orders.tsx` |
| Rate limit / proxy auth | `app/lib/rate-limit.server.ts`, `app/lib/proxy-auth.server.ts` |
