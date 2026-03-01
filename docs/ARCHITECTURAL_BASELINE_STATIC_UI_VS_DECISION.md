# Architectural Baseline: Static Shop UI Config vs Dynamic Cart Intelligence

**Purpose:** Structured mapping of the current system before separating:
- **Static shop UI config** → `/apps/cart-pro/config`
- **Dynamic cart intelligence** → `/apps/cart-pro/decision`

**Constraints:** No code changes. Mapping only.

---

## PART 1 — Decision Endpoint Responsibilities

**Sources:** `revstack/app/routes/cart.decision.ts`, `revstack/app/lib/decision-response.server.ts`

### 1.1 Full Response Shape

| Key | Depends on Cart? | Depends on Billing? | Depends on ShopConfig? | Static per Shop? | Cached? |
|-----|------------------|---------------------|------------------------|------------------|---------|
| **crossSell** | Yes (engine output from cart + catalog) | Yes (allowCrossSell, maxCrossSell gate) | Yes (enableCrossSell, recommendationLimit, strategy, manualCollectionIds) | No | Yes |
| **freeShippingRemaining** | Yes (engine from cart + storeMetrics) | No (value itself) | Yes (freeShippingThresholdCents) | No | Yes |
| **suppressCheckout** | Yes (engine) | No | Indirect (storeMetrics) | No | Yes |
| **milestones** | No (list is config) | Yes (allowMilestones gates) | Yes (enableMilestones, milestonesJson) | Yes (per shop) | Yes |
| **enableCouponTease** | No | Yes (allowCouponTease) | Yes (config.enableCouponTease) | Yes (per shop) | Yes |
| **ui** | No | Yes (allowUIConfig gates *whether* custom UI is returned) | Yes (primaryColor, accentColor, borderRadius, showConfetti, countdownEnabled, emojiMode) | Yes (per shop) | Yes |
| **crossSellDebug** | Yes (when present) | No | No | No | Yes (if cached with response) |

- **Cached:** Full response (including `ui`) is stored in memory and Redis keyed by `(shop, cartHash)`. So every key above is cached as part of the same blob.
- **Static per shop:** `milestones`, `enableCouponTease`, and `ui` are derived only from shop config + capabilities; they do not vary by cart contents. The *inclusion* of custom `ui` is gated by billing (`allowUIConfig`).

### 1.2 UI-Coupled Fields (response.ui)

| Field | Prisma / Origin | Depends on Cart? | Gated by allowUIConfig? | Overridden by SAFE_UI_FALLBACK? |
|-------|-----------------|------------------|--------------------------|----------------------------------|
| **primaryColor** | ShopConfig.primaryColor (String?) | No | Yes — when false, SAFE_UI_FALLBACK.primaryColor (null) | Yes |
| **accentColor** | ShopConfig.accentColor (String?) | No | Yes | Yes |
| **borderRadius** | ShopConfig.borderRadius (Int, default 12) | No | Yes | Yes (12) |
| **showConfetti** | ShopConfig.showConfetti (Boolean) | No | Yes | Yes (false) |
| **countdownEnabled** | ShopConfig.countdownEnabled (Boolean) | No | Yes | Yes (false) |
| **emojiMode** | ShopConfig.emojiMode (Boolean) | No | Yes | Yes (true) |

- **Where value originates:** All from `getShopConfig(shop)` → Prisma `ShopConfig` (or in-memory config cache). In `cart.decision.ts` (lines 604–613), when `capabilities.allowUIConfig` is true, `response.ui` is built from `config.primaryColor`, `config.accentColor`, etc.; otherwise `response.ui = SAFE_UI_FALLBACK`.
- **SAFE_UI_FALLBACK** (frozen): `{ primaryColor: null, accentColor: null, borderRadius: 12, showConfetti: false, countdownEnabled: false, emojiMode: true }`.

### 1.3 Decision Cache Coupling

**Source:** `revstack/app/lib/decision-cache.server.ts`

| Aspect | Detail |
|--------|--------|
| **Cache key format** | Memory: `cacheKey(shop, cartHash)` → `${shop}:${cartHash}`. Redis: `redisKey(shop, "decision", cartHash)`. |
| **Cart hash** | `hashCartPayload(cartJson)` = SHA-256 of stringified validated cart. |
| **TTL (memory)** | `TTL_MS = 30_000` (30 seconds). Entry has `expiresAt = Date.now() + TTL_MS`. |
| **TTL (Redis)** | `REDIS_DECISION_TTL_SECONDS = 60`. |
| **Is ui stored in cache?** | **Yes.** The entire `DecisionResponse` (including `ui`) is stored. `setMemoryCachedDecision` and `setCachedDecision` both store `response` as-is; `getCachedDecision` / `getCachedDecisionFromRedis` return the full object. |
| **Does cache invalidation consider config changes?** | **No.** There is no call to invalidate or trim decision cache when shop config (or UI config) changes. `invalidateShopConfigCache(shop)` only clears the **shop config** in-memory cache. |
| **Can config changes produce stale UI via decision cache?** | **Yes.** After a merchant saves new UI settings, `invalidateShopConfigCache(shop)` runs, but decision cache (memory + Redis) is keyed only by `(shop, cartHash)`. Until TTL expires (30s memory / 60s Redis) or cart hash changes, clients can receive a cached decision with the **old** `response.ui`. |

**Explicit answer:** **Yes — static UI is currently tied to cart-hash caching.** The whole decision response, including `ui`, is cached per (shop, cartHash). Changing only shop UI config does not invalidate decision cache, so UI can be stale for up to 30–60 seconds.

---

## PART 2 — ShopConfig Flow

**Sources:** `revstack/app/lib/shop-config.server.ts`, `revstack/app/lib/default-config.server.ts`, `revstack/app/lib/settings-validation.server.ts`, `revstack/app/routes/app.settings.tsx`, `revstack/prisma/schema.prisma`

### 2.1 Source of Truth

- **Where ShopConfig is created:**  
  - **Prisma:** `shop-config.server.ts` — if `prisma.shopConfig.findUnique({ where: { shopDomain } })` returns null, `prisma.shopConfig.create({ data: { shopDomain, ...DEFAULT_SHOP_CONFIG } })` is used.  
  - **Defaults:** `default-config.server.ts` exports `DEFAULT_SHOP_CONFIG` (baselineAovCents, freeShippingThresholdCents, milestonesJson, enableCrossSell, enableMilestones, enableCouponTease, plan, billingStatus, recommendationStrategy, manualCollectionIds, recommendationLimit, primaryColor, accentColor, borderRadius, showConfetti, countdownEnabled, emojiMode).
- **Fallback when Prisma fails:** `getFallbackShopConfig(shop)` returns a minimal object (id `"fallback"`, version 0, etc.) with same UI-related keys from `DEFAULT_SHOP_CONFIG`; used by layout/loaders to avoid 500.

**Field matrix**

| Field | In Prisma | In Settings UI | In Liquid | In Decision | Used in Frontend |
|-------|-----------|----------------|-----------|-------------|------------------|
| baselineAovCents | Yes | Yes (Core Revenue) | No | Yes (storeMetrics) | No (backend only) |
| freeShippingThresholdCents | Yes | Yes | No | Yes (storeMetrics) | No (backend only) |
| enableCrossSell | Yes | Yes | No (sectionConfig from data-*) | Yes (crossSell slice) | Yes (sectionConfig.enableCrossSell) |
| enableMilestones | Yes | Yes | Yes (showMilestones) | Yes (milestones) | Yes |
| enableCouponTease | Yes | Yes | No | Yes (enableCouponTease) | Yes (decision) |
| milestonesJson | Yes | Yes (editor) | No | Yes (milestones) | Yes (decision) |
| recommendationStrategy | Yes | Yes (if allowStrategySelection) | No | Yes | No (backend only) |
| recommendationLimit | Yes | Yes (if allowStrategySelection) | No | Yes | No (backend only) |
| manualCollectionIds | Yes | Yes (if MANUAL_COLLECTION) | No | Yes | No (backend only) |
| primaryColor | Yes | Yes (if allowUIConfig) | Yes (block primary_color → data-primary-color) | Yes (response.ui) | Yes (sectionConfig + decision.ui) |
| accentColor | Yes | Yes (if allowUIConfig) | Yes (block accent_color → data-accent-color) | Yes (response.ui) | Yes (sectionConfig + decision.ui) |
| borderRadius | Yes | Yes (if allowUIConfig) | Yes (block border_radius → data-border-radius) | Yes (response.ui) | Yes (sectionConfig + decision.ui) |
| showConfetti | Yes | Yes (if allowUIConfig) | No | Yes (response.ui) | Yes (decision.ui) |
| countdownEnabled | Yes | Yes (if allowUIConfig) | No | Yes (response.ui) | Yes (decision.ui) |
| emojiMode | Yes | Yes (if allowUIConfig) | No | Yes (response.ui) | Yes (decision.ui, getUIText) |
| enableHaptics | Yes | No | No | No (not in DecisionResponse type) | No (docs only; not in current code) |
| shippingBarPosition | Yes | No | No | No (not in DecisionResponse type) | No (docs only; not in current code) |
| plan, billingStatus, onboarding*, etc. | Yes | No (or other routes) | No | No (billing uses config for context only) | No |

- **In Prisma but NOT exposed in Settings UI:** enableHaptics, shippingBarPosition (and various onboarding/activation fields not relevant to UI config).
- **In Settings UI but not in Liquid:** All of Core Revenue, Cross-Sell, Milestones, Coupon Tease, and (when allowUIConfig) Visual Customization except the three colors/radius that Liquid also exposes via block settings.
- **In Liquid (block settings) but not in Decision response schema:** Liquid exposes primary_color, accent_color, border_radius as theme customizer only; decision response still carries the same three plus showConfetti, countdownEnabled, emojiMode from config.

### 2.2 Config Cache Behavior

| Aspect | Detail |
|--------|--------|
| **getShopConfig TTL** | In-memory only: `TTL = 5 * 60 * 1000` (5 minutes). No Redis for config. On cache hit (cached.ts within TTL), returns `cached.data` without Prisma. |
| **invalidateShopConfigCache usage** | Called from: `app.settings.tsx` (after settings save), `app.onboarding.tsx`, `onboarding-wizard.server.ts` (step/complete), `billing.server.ts`, `webhooks.billing.update.tsx`. Only does `cache.delete(domain)` for that shop. |
| **Does config invalidation trigger decision cache invalidation?** | **No.** There is no code path that calls any decision-cache invalidation when `invalidateShopConfigCache` runs. |
| **Is config cache independent from decision cache?** | **Yes.** They are separate caches (different Maps/key schemes). Config cache is keyed by shop only; decision cache is keyed by (shop, cartHash). Independence means: changing config does not invalidate decision cache, so decision cache can serve stale `ui` until TTL or cart change. |

---

## PART 3 — Frontend Boot Lifecycle

**Source:** `revstack/extensions/cart-pro/assets/cart-pro.js`

Exact boot order:

1. **IIFE runs:** Guard `if (window.CartProLoaded) return;` then `window.CartProLoaded = true`.
2. **Root lookup:** `root = document.getElementById("cart-pro-root")`; exit if !root.
3. **Root styling and shadow:** `root.style.cssText = ...` (fixed overlay); `shadowRoot = root.attachShadow({ mode: "open" })`.
4. **sectionConfig read:** From `root.dataset`: enableCrossSell, enableFreeShippingBar, accentColor, primaryColor, borderRadius, showMilestones, mode, suppressThemeDrawer. (Liquid sets data-primary-color, data-accent-color, data-border-radius when block settings are set.)
5. **SAFE_UI / SAFE_DECISION defined:** Local constants for fallback when no decision yet.
6. **applyUIConfig first run (PART 1):** `applyUIConfig({ primaryColor: sectionConfig.primaryColor || SAFE_UI.primaryColor, accentColor: sectionConfig.accentColor || SAFE_UI.accentColor, borderRadius: sectionConfig.borderRadius != null ? sectionConfig.borderRadius : SAFE_UI.borderRadius })` — bootstrap theme from section config so first paint avoids green flash.
7. **define applyUIConfig(ui):** Sets `--cp-primary`, `--cp-accent`, `--cp-radius` on root; sectionConfig wins over `u` for primary/accent/radius when present.
8. **define fetchDecisionSafe(cart):** POST to `/apps/cart-pro/decision` with `{ cart }`; on success, `if (d && d.ui) applyUIConfig(d.ui)` then return d. So decision fetch **overrides** UI when response contains `ui`.
9. **init():** Append critical style, drawer markup, refs, attach drawer listeners, document click listeners (cart icon, add-to-cart), wrapFetch, startCartIconObserver, cart:updated/cart:refresh, **prewarmDecision()** (after 1s idle, fetch cart then fetch decision to warm client cache). No cart/decision fetch in init itself; first fetch happens when drawer opens or prewarm runs.
10. **User opens drawer (or prewarm):** `loadCart()` → `loadCartReal()`: fetch `/cart.js` → then `renderInitial(cart, decisionForRender)` with optimistic or SAFE_DECISION, then `fetchDecisionSafe(cart)` → on resolve, `applyDecisionDelta(decisionState || ..., decision)` which calls `applyUIConfig(ui)` again with `newDecision.ui`.

**When sectionConfig is read:** Step 4 (before any network, synchronously from DOM).

**When applyUIConfig first runs:** Step 6 (immediately after sectionConfig, before any fetch).

**When decision fetch runs:** When drawer is opened (loadCartReal → fetchDecisionSafe) or during prewarmDecision (after 1s idle). Not during initial script load.

**When decision overrides UI:** (1) Inside `fetchDecisionSafe` after `r.json()`: `if (d && d.ui) applyUIConfig(d.ui)`. (2) Inside `applyDecision(decision)`: `applyUIConfig(decision.ui || SAFE_UI)`. (3) Inside `applyDecisionDelta(prevDecision, newDecision)`: `applyUIConfig(newDecision.ui || SAFE_UI)`.

**Where flicker can occur:** When decision response arrives with different `ui` than sectionConfig (e.g. backend has different primary/accent than Liquid), `applyUIConfig(d.ui)` overwrites CSS variables and colors/radius can change — **flicker**. Also, cached decision with old `ui` can show stale theme until cache TTL or cart change.

**Explicit answer:** **Yes — UI config depends on decision response to reach final styling.** First paint uses sectionConfig (and SAFE_UI for missing keys); final styling is set when the decision response is applied via `applyUIConfig(d.ui)` in fetchDecisionSafe and again in applyDecisionDelta. So for stores that do not set Liquid block colors, the “final” UI is whatever the decision endpoint returns (or SAFE_UI on error/timeout).

---

## PART 4 — Billing Gating Surface

**Sources:** `revstack/app/lib/billing-context.server.ts`, `revstack/app/lib/capabilities.server.ts`, `revstack/app/routes/cart.decision.ts`

- **allowUIConfig:** In `capabilities.server.ts`, `resolveCapabilities(plan)`: `true` only for `advanced` and `growth`; `false` for `basic`.
- **Where allowUIConfig is enforced:** In `cart.decision.ts` only (and in preview-simulator and settings UI visibility):
  - **cart.decision.ts:** After billing gate (`getBillingContext(shop, config)` → if `!billing.isEntitled` return `safeDecisionResponse(SAFE_UI_FALLBACK)`). When building response: `ui: capabilities.allowUIConfig ? { primaryColor: config.primaryColor ?? null, ... } : SAFE_UI_FALLBACK`. So entitlement is required first; then allowUIConfig gates whether custom UI is returned.
  - **app.settings.tsx:** Visual Customization section is rendered only when `capabilities.allowUIConfig`; otherwise locked block with hidden inputs.
  - **preview-simulator.server.ts:** `ui: capabilities.allowUIConfig ? { ... } : safeUiFallback` (same pattern).
- **Where SAFE_UI_FALLBACK is applied:** In `cart.decision.ts`: on all error/timeout/not-entitled paths (config load failure, !billing.isEntitled, no catalog, lock contention, decision build failure, outer catch). So any path that does not reach the successful response build returns `safeDecisionResponse(SAFE_UI_FALLBACK)`.
- **Other routes depending on ui fields:** No other **storefront** route returns `ui`. Admin/settings uses config and `mergePreviewDecision` to build a full DecisionResponse for CartPreview; that object includes `ui` for preview rendering. Analytics/milestones/coupon do not read `response.ui`; they use crossSell, milestones, enableCouponTease.
- **Removing ui from decision would affect:**
  - **Analytics:** No. Analytics use DecisionMetric, CrossSellEvent, etc.; not `ui`.
  - **Milestones:** No. Milestones are `response.milestones` and config; confetti uses `decisionState.ui.showConfetti` in frontend — so if ui were removed from decision, frontend would need another source for showConfetti (e.g. config endpoint or Liquid).
  - **Coupon tease:** No. Coupon visibility uses `decision.enableCouponTease`, not `ui`.
  - **Retention logic:** No. Retention is metric/event writes; not `ui`.

**Summary:** Billing gating for UI is only in the decision route (and settings/preview). If `ui` were removed from the decision payload, `allowUIConfig` would need to be enforced elsewhere for any new “config” or “UI” endpoint that serves static UI (e.g. who can get custom colors).

---

## PART 5 — Risk Surface Mapping

Areas that could break if `ui` is removed from the decision response:

| Area | Risk |
|------|------|
| **Type definitions** | `DecisionResponse` and `DecisionResponseUI` in `decision-response.server.ts` define `ui`. All consumers (cart.decision, preview-simulator, tests, CartPreview props) expect `decision.ui`. Removing it would require a new type (e.g. DecisionResponseWithoutUI) or a separate ConfigResponse type and updates everywhere that reference `decision.ui`. |
| **Frontend assumptions** | cart-pro.js: `fetchDecisionSafe` does `if (d && d.ui) applyUIConfig(d.ui)`; `applyDecision`, `applyDecisionDelta`, `renderInitial` use `decision.ui` or `SAFE_UI`; `getUIText` uses `decisionState.ui.emojiMode`; `shouldShowConfetti` uses `decisionOrUi.ui.showConfetti`. So frontend assumes decision always contains `ui` (or falls back to SAFE_UI/SAFE_DECISION). Removing `ui` would require either a separate config fetch and apply order, or DOM/Liquid-only UI with no decision-driven override. |
| **Cache layer** | Decision cache stores full response including `ui`. If `ui` is removed from the cached payload, no change to cache key/TTL logic. If a new “config” endpoint is cached separately, invalidation and TTL design would be new. |
| **Billing enforcement** | Today allowUIConfig is enforced only when building decision response. If UI is served from a config endpoint, that endpoint (or a middleware) must enforce allowUIConfig (or equivalent) so basic plan does not receive custom UI. |
| **Tests** | `decision.toggles.test.ts`: expects `json.ui` to equal SAFE_UI_EXPECTED when allowUIConfig false. `cart.decision.integration.test.ts`: `expect(json.ui).toMatchObject({...})`. These assert on `response.ui`. Removing `ui` would require updating or removing these expectations and possibly adding tests for a new config endpoint. |
| **Preview simulator** | `preview-simulator.server.ts` returns a full `DecisionResponse` including `ui` for CartPreview. Settings page builds `previewDecision` with `mergePreviewDecision(..., ui from state)`. CartPreview component receives `decision: DecisionResponse`; if the type or shape changes, CartPreview and mergePreviewDecision need to be updated. |
| **Shared helpers** | `safeDecisionResponse(ui)` and `SAFE_UI_FALLBACK` in cart.decision.ts are used on all fallback paths. If decision no longer returns `ui`, these could be removed or repurposed for a different response shape; call sites (many return statements) would need to be updated. |
| **Liquid / section config** | Liquid already provides primary/accent/borderRadius via block settings; frontend already prefers sectionConfig for those in `applyUIConfig`. So for those three, moving to “config only” (or Liquid only) is less disruptive. showConfetti, countdownEnabled, emojiMode have **no** Liquid exposure; they are only from decision today. Any separation must provide these elsewhere (e.g. config endpoint or Liquid) if we keep the same behavior. |

---

## PART 6 — Deliverable Summary

### Static UI config responsibilities (current)

- **Stored in:** Prisma `ShopConfig` (primaryColor, accentColor, borderRadius, showConfetti, countdownEnabled, emojiMode).
- **Served today:** Via decision response `response.ui` when `allowUIConfig` is true; otherwise `SAFE_UI_FALLBACK`.
- **First paint:** Liquid block settings → `data-*` → sectionConfig (primary, accent, borderRadius only). No Liquid for showConfetti, countdownEnabled, emojiMode.
- **Final styling:** Set when decision response is applied (`applyUIConfig(d.ui)`). So static UI is currently delivered **through** the decision endpoint and cached with it.

### Dynamic cart intelligence responsibilities (current)

- **crossSell, freeShippingRemaining, suppressCheckout:** From decision engine (cart + catalog + storeMetrics).
- **milestones, enableCouponTease:** From config but gated by capabilities; sent in same response as engine output.
- **Caching:** By (shop, cartHash). Entire response (including `ui`) is one blob.

### Explicit confirmations

1. **UI config is currently coupled to cart hash cache:** Yes. The full decision response, including `ui`, is cached per (shop, cartHash). Config invalidation does not invalidate decision cache, so UI can be stale for 30–60s after settings save.
2. **Billing gating would need to move:** If we remove `ui` from decision and serve it from a separate config endpoint, that endpoint (or its middleware) must enforce who can receive custom UI (e.g. allowUIConfig or equivalent); today that gate lives only in the decision route.
3. **Frontend assumes decision always contains ui:** Yes. cart-pro.js uses `d.ui` in fetchDecisionSafe, applyDecision, applyDecisionDelta, renderInitial; getUIText and shouldShowConfetti use `decisionState.ui`. There is no code path that expects a decision without `ui`; fallback is always SAFE_UI/SAFE_DECISION when something is missing or on error.

### Final summary

- **“System currently mixes responsibilities because…”**  
  The decision endpoint returns a single payload that includes both cart-dependent data (crossSell, freeShippingRemaining, suppressCheckout, milestones, enableCouponTease) and per-shop static UI config (primaryColor, accentColor, borderRadius, showConfetti, countdownEnabled, emojiMode). That UI config is loaded from the same `getShopConfig()` used elsewhere, copied into `response.ui`, and cached as part of the decision response. The frontend applies it by calling `applyUIConfig(d.ui)` when the decision returns, which ties static look-and-feel to the decision request and decision cache TTL and allows stale UI after config changes until cache expires or cart changes.

- **“Separation appears safe / risky because…”**  
  **Risky in the sense that** removal of `ui` from the decision response touches type definitions, frontend (multiple call sites assuming `d.ui`), billing gating location, tests, and preview/settings merge logic; and three UI fields (showConfetti, countdownEnabled, emojiMode) have no Liquid fallback, so a new source (e.g. config endpoint or Liquid) is required. **Safe in the sense that** the six UI fields are already independent of cart contents and depend only on shop config and allowUIConfig; analytics, milestones, and coupon tease do not depend on `ui`; and Liquid already provides first-paint for primary/accent/borderRadius, so a well-defined config endpoint plus frontend boot order (config fetch then apply before or alongside decision) could replicate current behavior and eliminate UI staleness from decision cache.
