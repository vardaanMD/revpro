# Cart Pro — System Audit & Reverse-Engineering Report

**Scope:** Full repository topology, execution flow, v1 vs v2 comparison, performance risk audit.  
**No code changes.** Pure architectural reconstruction and state mapping.

---

## STEP 1 — System Topology

### 1.1 Entry Points

| Layer | Entry | Notes |
|-------|--------|------|
| **Storefront (theme)** | `revstack/extensions/cart-pro/blocks/cart_pro_embed.liquid` | Single app embed, target `body`. Only embed that injects Cart Pro. |
| **Storefront JS (current production)** | Inline script + `cart-pro-ui.js` (defer) + `cart-pro-v2.js` (defer) | Snapshot fetch inline; no `cart-pro.js` in embed. |
| **Backend (Remix/React Router)** | File-based routes under `app/routes/`. App proxy: `shopify.app.toml` `[app_proxy]` url=`/cart`, prefix=`apps`, subpath=`cart-pro` → store requests to `https://store.com/apps/cart-pro/*` hit app at `https://app.../cart/*`. |

**Backend route → URL mapping (app proxy in play):**

| Route file | App path (what storefront may call) | Handler role |
|------------|-------------------------------------|-------------|
| `cart.snapshot.v2.ts` | `/cart/snapshot/v2` (store: `/apps/cart-pro/snapshot/v2`) | V2 snapshot for Liquid embed |
| `apps.cart-pro.bootstrap.v2.ts` | `/apps/cart-pro/bootstrap/v2` | V2 bootstrap (same builder as snapshot) |
| `cart.bootstrap.ts` | `/cart/bootstrap` (store: `/apps/cart-pro/bootstrap`) | V1 bootstrap (UI + capabilities only) |
| `cart.decision.ts` | `/cart/decision` | V1 decision (POST cart → cross-sell, milestones, etc.) |
| `apps.cart-pro.decision.ts` | `/apps/cart-pro/decision` | Re-exports `cart.decision` |
| `cart.analytics.event.ts` | `/cart/analytics/event` | Analytics (impression/click) |
| `apps.cart-pro.analytics.event.ts` | `/apps/cart-pro/analytics/event` | Re-exports `cart.analytics.event` |
| `apps.cart-pro.ai.v2.ts` | `/apps/cart-pro/ai/v2` | V2 AI overlay (same-collection recs for last added product) |

### 1.2 Bootstrapping Flow

**Current production (V2 only — embed as shipped):**

1. **Liquid render:** Theme outputs embed block: `#cart-pro-root`, `cart-pro.css` link, inline script, then two deferred scripts.
2. **Inline script (runs as soon as parsed):**  
   `fetch("/apps/cart-pro/snapshot/v2", { credentials: "same-origin" })` → on success `window.__CART_PRO_V2_SNAPSHOT__ = snapshotJson`.  
   No `await`; script returns immediately; fetch runs in background.
3. **Defer order:** After HTML parse, `cart-pro-ui.js` runs, then `cart-pro-v2.js`.
4. **cart-pro-v2.js:**  
   - If `document.readyState === "loading"`, waits for `DOMContentLoaded`, then `waitForSnapshot(callback)`.  
   - `waitForSnapshot`: polls every 50ms for `window.__CART_PRO_V2_SNAPSHOT__`, max 40 attempts (2s).  
   - Then `initV2()`: reads `v2Config = window.__CART_PRO_V2_SNAPSHOT__`, `fetchCart()` (/cart.js).  
   - On cart response: sets `v2Cart`, `v2Ready = true`. If `v2OpenQueued`, opens drawer. Registers document click (cart icon), runs `processCartIconCandidates(document.body)`, `prewarmVariants()` (parallel fetches to `/variants/{id}.js` for each `v2Config.variantIds`).

**Legacy V1 (not loaded by current embed):**

- **cart-pro.js** is never included by `cart_pro_embed.liquid`. If loaded elsewhere (e.g. another theme or manual snippet), its flow is:
  1. IIFE runs: `CartProLoaded` guard, get `#cart-pro-root`, attach shadow DOM, set `SAFE_UI`, call `applyUIConfig(SAFE_UI)`.
  2. `init()`: inject critical style, create drawer markup in shadow root, resolve refs, attach drawer listeners, then **`bootCartPro()`**.
  3. **bootCartPro:**  
     `Promise.all([ fetch("/apps/cart-pro/bootstrap"), fetch("/cart.js") ])` → then optional session hydration from `sessionStorage` (key `cartProDecision`) → if cart non-empty and no fresh hydration, **`guardedFetchDecision(cart)`** → POST `/apps/cart-pro/decision` with cart.  
     Then `startCartObserver()` (2s interval polling `/cart.js` + decision fetch on hash change).
  4. Document listeners: `click` (cart icon, add-to-cart), `submit` (add-to-cart form), `cart:updated` / `cart:refresh`, plus `startCartIconObserver()` (MutationObserver for new cart icons).

### 1.3 Global State Initializations

| Location | Globals / state |
|----------|------------------|
| **Embed inline** | `window.__CART_PRO_V2_SNAPSHOT__` (set when snapshot fetch resolves). |
| **cart-pro-ui.js** | `window.CartProUI` (ensureDrawerDOM, openDrawer, closeDrawer, renderInitial, renderItemsList, renderSubtotalBlock, renderShippingBar, renderMilestones). Module-level: `refs`, `rootEl`, `shadowRootEl`, `itemRefs`, `lastMilestoneConfigHash`, etc. |
| **cart-pro-v2.js** | `v2Config`, `v2Cart`, `v2Ready`, `v2OpenQueued`, `variantAvailabilityMap`, `currentUpsellProducts`, `drawerUIMounted`, `rendering`, `cartIconAttachedSet`. No global namespace export; relies on `CartProUI` from UI script. |
| **cart-pro.js (v1)** | `window.CartProLoaded`, `window.CartProUI` (overwrites if both loaded). Module state: `bootstrapState`, `decisionState`, `cachedCart`, `bootComplete`, `decisionAbortController`, `cartState`, `lastCart`, `lastCartHash`, `decisionPromise`, session `cartProDecision`, etc. |

### 1.4 Event Listeners & Lifecycle Hooks

**V2 (cart-pro-v2.js):**

- `DOMContentLoaded` → `waitForSnapshot` → `initV2`.
- In `initV2`: after `fetchCart()` resolves, `document.addEventListener("click", onCartIconClick, true)`, `processCartIconCandidates(document.body)`, and one-time attach on existing `CART_ICON_SELECTORS` nodes.
- Drawer: overlay click, close button, checkout button (in `openDrawer` when mounting drawer once).

**V1 (cart-pro.js):**

- `init()`: `document.addEventListener("click", onCartIconClick, true)`, `onAddToCartButtonClick`, `onAddToCartFormSubmit`, `startCartIconObserver()`, `cart:updated`, `cart:refresh`, then `bootCartPro()`.
- `startCartObserver()`: `setInterval(..., 2000)` → fetch cart, hash compare, optional `guardedFetchDecision`.
- `visibilitychange`: when tab hidden, clear interval; when visible, `startCartObserver()` again.

### 1.5 API Routes & Server Endpoints

- **GET /cart/snapshot/v2** (app proxy: `/apps/cart-pro/snapshot/v2`): `cart.snapshot.v2` loader → `authenticate.public.appProxy`, `buildBootstrapSnapshotV2(shop)` → JSON with `engineVersion: "v2"`, ui, capabilities, upsell products, variantIds, aiEnabled.
- **GET /apps/cart-pro/bootstrap/v2**: same as above (bootstrap.v2 route).
- **GET /apps/cart-pro/bootstrap** (v1): `cart.bootstrap` loader → shop config, billing, capabilities, UI; returns `engineVersion` (e.g. "v1") and safe fallbacks on auth/config failure.
- **POST /cart/decision** (and /apps/cart-pro/decision): `cart.decision` action → validate cart, rate limit, config, billing, catalog from Redis, decision engine, cache, DB writes (CrossSellEvent, DecisionMetric). 300ms timeout to SAFE_DECISION.
- **POST /cart/analytics/event** (and /apps/cart-pro/analytics/event): `cart.analytics.event` action → rate limit, validate body, write CrossSellEvent, optional CrossSellConversion and RevproClickSession.
- **POST /apps/cart-pro/ai/v2**: `apps.cart-pro.ai.v2` action → same-collection recommendations for `lastAddedProductId`, from ShopProduct only.

### 1.6 Middleware / Interceptors

- **Backend:** `authenticate.public.appProxy(request)` on app-proxy routes; `verifyProxySignature`, `checkReplayTimestamp` on decision and analytics; `withSafeHandler` wraps decision and analytics actions; `requestContext.run` for logging.
- **Frontend:** No shared HTTP interceptor; each script uses raw `fetch`. V1 has `fetchWithTimeout` and AbortController for decision and cart.

### 1.7 Tree-Style Map

```
revstack/
├── app/
│   ├── routes/
│   │   ├── cart.snapshot.v2.ts          # GET snapshot for V2 embed
│   │   ├── apps.cart-pro.bootstrap.v2.ts
│   │   ├── cart.bootstrap.ts            # V1 bootstrap
│   │   ├── cart.decision.ts             # V1 decision
│   │   ├── apps.cart-pro.decision.ts    # re-export
│   │   ├── cart.analytics.event.ts
│   │   ├── apps.cart-pro.analytics.event.ts
│   │   └── apps.cart-pro.ai.v2.ts       # V2 AI overlay
│   └── lib/
│       ├── upsell-engine-v2/
│       │   ├── buildSnapshot.ts        # buildBootstrapSnapshotV2, ensureCatalogReady
│       │   └── types.ts
│       ├── catalog-warm.server.ts
│       ├── shop-config.server.ts
│       ├── decision-cache.server.ts
│       └── ... (billing, rate-limit, proxy-auth, etc.)
├── extensions/
│   └── cart-pro/
│       ├── shopify.extension.toml       # type = theme, uid = d6a2a04c-...
│       ├── blocks/
│       │   ├── cart_pro_embed.liquid    # ONLY block that loads cart; V2 path only
│       │   └── star_rating.liquid       # unrelated
│       ├── assets/
│       │   ├── cart-pro.css             # shared styles
│       │   ├── cart-pro-ui.js           # shared UI module (drawer DOM, render)
│       │   ├── cart-pro-v2.js           # V2 lifecycle, snapshot + cart, no decision
│       │   └── cart-pro.js              # V1 monolith (bootstrap + decision + UI)
│       ├── snippets/
│       └── locales/
└── .shopify/dev-bundle/...              # built/copied extension assets
```

### 1.8 File Classification

| File / asset | In production (current embed) | Legacy but still imported | Dead / unused | Duplicated logic |
|--------------|------------------------------|----------------------------|---------------|------------------|
| `cart_pro_embed.liquid` | ✅ | | | |
| `cart-pro.css` | ✅ | | | |
| `cart-pro-ui.js` | ✅ | | | Shared with V1’s exposed CartProUI (see below) |
| `cart-pro-v2.js` | ✅ | | | |
| `cart-pro.js` | ❌ | Referenced in docs, CartPreview, CONFETTI audit | **Not loaded by embed** → effectively dead on current storefront path | Contains its own full UI + logic; also exposes `CartProUI` (overlap with cart-pro-ui.js) |
| `cart.snapshot.v2.ts` | ✅ | | | |
| `cart.bootstrap.ts` | Only if V1 used | V1 bootstrap | | |
| `cart.decision.ts` | Only if V1 used | V1 decision | | |
| `apps.cart-pro.ai.v2.ts` | ✅ (V2 add-to-cart) | | | |
| `buildSnapshot.ts` | ✅ (snapshot + bootstrap/v2) | | | |
| `cart.analytics.event.ts` | Only V1 fires | V1 analytics | V2 does not call analytics/event | |

**Conclusion:** The only script bundle loaded by the single Cart Pro embed is **V2** (inline snapshot + `cart-pro-ui.js` + `cart-pro-v2.js`). **cart-pro.js is not loaded** by the repo’s embed; it is legacy. Decision and analytics routes remain in use only if some other integration (or a reverted embed) loads V1.

---

## STEP 2 — Execution Flow (Cart Load Lifecycle)

### 2.1 Page Load

```
[Liquid]
  → #cart-pro-root, <link cart-pro.css>, inline script, <script defer cart-pro-ui.js>, <script defer cart-pro-v2.js>

[Inline script]
  → fetch("/apps/cart-pro/snapshot/v2") → window.__CART_PRO_V2_SNAPSHOT__ = body
  (no blocking; script ends)

[Parse / defer]
  → cart-pro-ui.js executes: defines CartProUI (ensureDrawerDOM, openDrawer, closeDrawer, renderInitial, …)
  → cart-pro-v2.js executes: expects CartProUI; if DOM not ready, DOMContentLoaded → waitForSnapshot → initV2
```

**initV2:**

1. `v2Config = window.__CART_PRO_V2_SNAPSHOT__` (may still be undefined if snapshot slow).
2. `fetchCart()` → GET `/cart.js`.
3. On success: `v2Cart = cart`, `v2Ready = true`. If `v2OpenQueued`, call `openDrawer()`. Then `prewarmVariants()` (N GETs to `/variants/{id}.js`), `document.addEventListener("click", onCartIconClick, true)`, `processCartIconCandidates(document.body)`, and attach to existing cart icon nodes.

**Async boundaries:** Inline fetch is fire-and-forget. Snapshot may complete before or after defer scripts run. `waitForSnapshot` is the sync boundary in v2 (poll up to 2s). Then `fetchCart()` is the next network boundary before “ready”.

### 2.2 Cart Drawer Opens (V2)

1. User clicks element matching `CART_ICON_SELECTORS` → `onCartIconClick` or per-element `attachCartIconOnce` handler.
2. If `!v2Ready`: set `v2OpenQueued = true`; return (drawer opens when `fetchCart()` later resolves).
3. If `v2Ready`: `openDrawer()`.
4. **openDrawer():**  
   - If drawer not yet mounted: `ensureDrawerDOM(root)` (attach shadow, inject CRITICAL_CSS, drawer markup, refs), then overlay/close/checkout listeners, `drawerUIMounted = true`.  
   - `currentUpsellProducts = matchProducts(v2Cart, v2Config.upsell.products)`, build `syntheticDecision` (crossSell from snapshot, freeShippingRemaining 0, milestones [], enableCouponTease from capabilities).  
   - `openDrawerUI()`, then `safeRender(v2Cart, syntheticDecision, getUiConfig(), getCapabilities())` → `renderInitial(cart, syntheticDecision, uiConfig, capabilities)` (CartProUI).

**Function chain:** click → openDrawer → ensureDrawerDOM (if first time) → openDrawerUI → safeRender → CartProUI.renderInitial. No extra network call on open; data is already `v2Cart` + `v2Config`.

### 2.3 Item Added (V2)

1. Recommendation “Add to cart” uses `capabilities.onRecAdd(rec)` → `handleAddToCart(rec.variantId, rec.id, null, null)`.
2. **handleAddToCart:** POST `/cart/add.js` with variant id and quantity 1.
3. On success: `fetchCart()` → then `reopenWithFreshData()` (match products again, `safeRender`), re-enable button, optionally `handleAIFetch(productId)`.
4. **handleAIFetch:** POST `/apps/cart-pro/ai/v2` with `lastAddedProductId` → replace `currentUpsellProducts` with response, `reopenWithFreshData()` again.

**Chains:** add → /cart/add.js → fetchCart → reopenWithFreshData → safeRender; then optionally AI v2 → reopenWithFreshData → safeRender. So two possible full re-renders after one add.

### 2.4 Coupon Applied

- **V1 (cart-pro.js):** `handleApplyDiscount` / `handleRemoveDiscount` → `adapter.applyDiscount(code)` (POST `/discount/{code}`) or `adapter.removeDiscount()` (POST `/discount/`) → then refresh cart and decision path, update coupon UI.
- **V2 + cart-pro-ui.js:** Coupon section exists in drawer markup (input, apply button, message, remove wrap), and refs are set in `ensureDrawerDOM`, but **no coupon apply/remove handler is attached** in cart-pro-ui.js. Capabilities passed from v2 are `onQtyChange`, `onRemove`, `onRecAdd`, `onClose` — no `onCouponApply`. So in the current V2 path, **coupon UI is present but non-functional**.

### 2.5 Analytics Fires

- **V1:** After recommendations render, impression beacon: POST `/apps/cart-pro/analytics/event` with productId, eventType `"impression"`, cartValue, optional revproSessionId and recommendedProductIds. Click: same endpoint with eventType `"click"`; backend writes CrossSellEvent and CrossSellConversion.
- **V2:** **Does not call** `/apps/cart-pro/analytics/event`. No impression or click analytics in cart-pro-v2.js.

### 2.6 Call Chains, Async, Network, State (Summary)

| Event | Functions | Async boundaries | Network | State mutations |
|-------|-----------|------------------|---------|------------------|
| Page load | inline fetch → (later) waitForSnapshot → initV2 → fetchCart | Snapshot fetch, fetchCart | GET snapshot, GET /cart.js | __CART_PRO_V2_SNAPSHOT__, v2Cart, v2Ready, v2OpenQueued |
| Drawer open | openDrawer → ensureDrawerDOM (once) → openDrawerUI → safeRender → renderInitial | None | None | drawerUIMounted, refs filled |
| Item added | handleAddToCart → /cart/add.js → fetchCart → reopenWithFreshData → [handleAIFetch → /ai/v2 → reopenWithFreshData] | add, fetchCart, optional AI | POST add, GET cart, optional POST ai/v2 | v2Cart, currentUpsellProducts |
| Coupon (v2) | — | — | — | Non-functional |
| Analytics | V1 only: after render, fetch /analytics/event | — | POST analytics/event | Backend DB |

### 2.7 Blocking, Redundant Fetches, Double Render, Races, Circular Imports

- **Blocking:** Inline snapshot script does not block parsing (no document write, no synchronous XHR). Defer scripts run after parse. Main risk is snapshot endpoint blocking on server (e.g. `ensureCatalogReady` + catalog warm on first hit).
- **Redundant fetches:**  
  - V2: Snapshot once on page; cart once in initV2. If user clicks cart before snapshot ready, they wait; no duplicate snapshot. After add-to-cart, one fetchCart and optionally one AI call.  
  - prewarmVariants: one GET per variant in snapshot; all in parallel (could be many).
- **Double rendering:** Every `reopenWithFreshData()` and every `openDrawer()` calls `safeRender` → `renderInitial`. So one add can trigger two full renders (after fetchCart, then after AI). Guard `rendering` only prevents re-entrancy within same tick.
- **Race conditions:** Snapshot and cart are independent. If v2 runs before snapshot, `waitForSnapshot` polls. If user clicks cart before `v2Ready`, open is queued. Multiple rapid cart icon clicks could call `openDrawer` multiple times; `drawerUIMounted` and refs prevent duplicate DOM creation but multiple `safeRender` calls can still run.
- **Circular imports:** Not applicable; storefront is classic scripts and Liquid. Backend: no circular dependency observed between cart routes and upsell-engine-v2.

---

## STEP 3 — Compare V1 vs V2

### 3.1 File Ownership

| File | V1 | V2 | Hybrid |
|------|----|----|--------|
| `cart-pro.js` | ✅ Full (bootstrap, decision, UI, observer, confetti, coupon, analytics) | Exposes `CartProUI` at end for “V2 engine” but not used by current embed | Yes (comment: “Expose V1 UI renderer for V2 engine”) |
| `cart-pro-v2.js` | | ✅ Entry and lifecycle only; uses CartProUI | |
| `cart-pro-ui.js` | Used if V2 stack loads | ✅ Provides CartProUI for v2 | Shared |
| `cart-pro.css` | ✅ Used by V1 | ✅ Same file for V2 | Shared |
| `cart_pro_embed.liquid` | Loads only V2 stack (no cart-pro.js) | ✅ | Embed is V2-only |
| `cart.bootstrap.ts` | ✅ | | |
| `apps.cart-pro.bootstrap.v2.ts` / `cart.snapshot.v2.ts` | | ✅ | |
| `cart.decision.ts` | ✅ | | |
| `cart.analytics.event.ts` | ✅ | | |
| `apps.cart-pro.ai.v2.ts` | | ✅ | |
| `buildSnapshot.ts` | | ✅ | |

### 3.2 Overlapping Responsibilities

- **Drawer DOM and render:**  
  - V1: cart-pro.js builds its own shadow root and full drawer markup, and implements `renderInitial`, `renderItemsList`, etc.  
  - V2: cart-pro-ui.js builds drawer (ensureDrawerDOM, same structure) and implements `renderInitial`, etc.  
  - cart-pro.js at the end exposes the same names (`CartProUI.renderInitial`, …) as cart-pro-ui.js. If both were loaded, the last one would win. Current embed only loads cart-pro-ui.js for UI.

- **Config / UI:**  
  - V1: Bootstrap from `/apps/cart-pro/bootstrap` (UI + capabilities); decision from `/apps/cart-pro/decision` (cross-sell, milestones, coupon tease, etc.).  
  - V2: Single snapshot from `/apps/cart-pro/snapshot/v2` (UI + capabilities + fixed upsell product set); no decision route; AI overlay from `/apps/cart-pro/ai/v2` on add.

- **Cart data:** Both use `/cart.js` and `/cart/change.js`; V1 also uses `/cart/update.js` for attributes (e.g. revpro_session_id).

### 3.3 Conflicting Flags or Config

- **engineVersion:** V1 bootstrap returns `engineVersion: "v1"` (or from config); snapshot/v2 returns `engineVersion: "v2"`. No shared flag that toggles both; they are separate endpoints.
- **Bootstrap vs snapshot:** V1 has no snapshot; V2 has no bootstrap call (only snapshot). So no runtime conflict; they are alternate paths.

### 3.4 Duplicate State Managers

- **V1:** `bootstrapState`, `decisionState`, `cachedCart`, `lastCart`, `lastCartHash`, `decisionRequestId`, `optimisticDecisionState`, session storage for decision cache.
- **V2:** `v2Config` (snapshot), `v2Cart`, `currentUpsellProducts`, `variantAvailabilityMap`, `drawerUIMounted`, `rendering`, `v2OpenQueued`. No decision state; no session cache for decision.
- **CartProUI (cart-pro-ui.js):** Stateless per call; holds refs and module-level DOM state. Used only by V2 in production. So effectively one state manager for the active path (V2).

### 3.5 Multiple Analytics Emitters

- **V1:** Emits to `/apps/cart-pro/analytics/event` (impression and click).
- **V2:** Does not emit. So only one emitter in codebase (V1), but it is not on the current storefront path.

### 3.6 Multiple Coupon Engines

- **V1:** Full coupon flow in cart-pro.js (apply/remove via adapter, updateCouponUI, coupon tease banner from decision).
- **V2:** Coupon section and refs in cart-pro-ui.js but **no handlers attached**; v2 capabilities do not include coupon. So only one “engine” (V1); V2 has UI shell only.

---

## STEP 4 — Performance Risk Audit (Load Delay)

### 4.1 Synchronous Heavy Work on Load

- **Storefront:** No large sync work in the inline script (only starting a fetch). Defer scripts run after parse; waitForSnapshot is a 50ms poll loop (bounded 2s). No heavy sync computation in v2 init.
- **Backend (snapshot):** `buildBootstrapSnapshotV2(shop)` → `ensureCatalogReady(shop)`. If `ShopProduct` count is 0, **synchronous** call to `warmCatalogForShop(shop)` (Admin API product fetch, transform, DB writes), then re-check. This can be **very slow** on first request for a shop and blocks the snapshot response.

### 4.2 Large Bundle Imports

- **cart-pro.js:** ~2554 lines; not loaded by current embed.  
- **cart-pro-ui.js:** ~761 lines; **cart-pro-v2.js:** ~360 lines. Both loaded. No bundler; static assets. No dynamic imports on storefront.

### 4.3 Unnecessary Re-renders

- Every `reopenWithFreshData()` and every `openDrawer()` does a full `renderInitial`. After add-to-cart, v2 does reopenWithFreshData (render) and, if AI enabled, handleAIFetch then another reopenWithFreshData (second full render). No diff/patch; full replaceChildren on items and recommendations.

### 4.4 Blocking DOM Queries

- **V2:** On init, `document.getElementById("cart-pro-root")`; after fetchCart, `processCartIconCandidates(document.body)` and `document.querySelectorAll(CART_ICON_SELECTORS)` (broad query). In openDrawer, same getElementById and optional querySelectorAll for existing icons. Not inherently heavy but runs in main thread.

### 4.5 Sequential vs Parallel API Calls

- **V2 page load:** Inline snapshot fetch and (later) fetchCart are independent; snapshot is not awaited by v2 before starting waitForSnapshot (poll). So effectively: snapshot and (after DOM + snapshot) fetchCart. No parallelization of snapshot + cart in v2 (cart starts only after snapshot is present).  
- **V1:** bootCartPro does `Promise.all([ bootstrap, cart ])` then decision. So bootstrap and cart are parallel; decision is after.  
- **Snapshot endpoint:** Internally getShopConfig, getBillingContext, ensureCatalogReady, findMany ShopProduct, buildCatalogIndexFromDbRows, resolveStrategyCatalogFromIndex, then build response. ensureCatalogReady can run a full catalog warm (sequential with rest of handler).

### 4.6 Top 10 Likely Causes of Cart Delay (Ranked)

1. **Snapshot endpoint blocking on first request:** `ensureCatalogReady` → `warmCatalogForShop` on empty catalog (Admin API + DB). Can add seconds to first load for a shop.
2. **Snapshot not ready when v2 runs:** Inline fetch not awaited; if snapshot is slow, waitForSnapshot polls up to 2s. User sees delay before cart is “ready” or drawer can show.
3. **fetchCart after snapshot:** V2 serializes “snapshot then cart” by design. Cart is fetched only after snapshot is available and initV2 runs, so total time ≥ snapshot latency + cart latency.
4. **prewarmVariants:** Many parallel GETs to `/variants/{id}.js` after first cart load. Can cause burst of requests and main-thread work when processing responses.
5. **Double full render after add-to-cart:** reopenWithFreshData twice (after cart, then after AI) → two full renderInitials.
6. **No optimistic UI for drawer open:** If user clicks cart before v2Ready, drawer opens only when fetchCart resolves; no skeleton or immediate open.
7. **Broad DOM scan:** processCartIconCandidates(document.body) and querySelectorAll over body can be costly on large DOMs.
8. **Single large CSS file:** cart-pro.css loaded for all pages; no code-split or critical-only path.
9. **Sync work in snapshot builder:** buildCatalogIndexFromDbRows and resolveStrategyCatalogFromIndex are sync; large catalogs could add tens of ms.
10. **Defer order:** cart-pro-ui.js then cart-pro-v2.js; v2 cannot run before UI. Not a delay per se but fixes a strict order dependency.

---

## STEP 5 — Clean Summary

### 5.1 One-Paragraph Description

The system is a **Shopify theme app extension (Cart Pro)** that provides a cart drawer with cross-sell, milestones, coupon section, and free-shipping messaging. The **current production path is V2 only**: a single Liquid embed loads an inline snapshot fetch to `/apps/cart-pro/snapshot/v2`, then two deferred scripts—a shared UI module (`cart-pro-ui.js`) and the V2 lifecycle script (`cart-pro-v2.js`). V2 uses the snapshot as the only server config (no decision endpoint); recommendations are a fixed list from the snapshot plus an optional same-collection overlay from `/apps/cart-pro/ai/v2` when the user adds a product. A larger **V1 implementation** (`cart-pro.js`) still exists in the repo: it uses a bootstrap endpoint and a POST decision endpoint for dynamic cross-sell and milestones, with its own shadow-DOM drawer and coupon/analytics logic, but **it is not loaded by the current embed**, so it is legacy for the default storefront path. The backend serves both styles: v1 bootstrap and decision routes, and v2 snapshot and AI overlay routes, with shared UI/capability concepts but different data flows and no shared “version” switch.

### 5.2 Diagram-Level Architecture

```
[Storefront]
  Theme
    → cart_pro_embed.liquid
        → #cart-pro-root
        → <link cart-pro.css>
        → inline: fetch(/apps/cart-pro/snapshot/v2) → window.__CART_PRO_V2_SNAPSHOT__
        → <script defer cart-pro-ui.js>  →  window.CartProUI
        → <script defer cart-pro-v2.js>  →  waitForSnapshot → initV2 → fetchCart, attach cart icon

  App proxy (store URL /apps/cart-pro/* → app /cart/*)
    → GET /cart/snapshot/v2     → buildBootstrapSnapshotV2 (ensureCatalogReady, ShopProduct, index, slice)
    → POST /apps/cart-pro/ai/v2 → same-collection recs from ShopProduct

[Backend – shared with V1 if ever loaded]
  GET /apps/cart-pro/bootstrap     → cart.bootstrap (config, billing, UI, capabilities)
  POST /cart/decision              → cart.decision (validate, rate limit, Redis catalog, decision engine, cache, DB)
  POST /cart/analytics/event       → CrossSellEvent / CrossSellConversion

[V2 data flow]
  Snapshot (once per page) → v2Config
  /cart.js (once in init, then after add/change) → v2Cart
  openDrawer → syntheticDecision from v2Config.upsell + matchProducts(v2Cart)
  add rec → /cart/add.js → fetchCart → reopenWithFreshData; optional /apps/cart-pro/ai/v2 → reopenWithFreshData
```

### 5.3 Architectural Inconsistencies

- **Two UIs for one product:** Full drawer implementation in cart-pro.js (V1) and a separate, shared drawer in cart-pro-ui.js (V2 path). cart-pro.js also exposes `CartProUI`, overlapping with cart-pro-ui.js.
- **Embed loads only one path:** Embed is V2-only; V1 exists but is never loaded by the repo’s single embed, so decision and analytics routes are unused on the default storefront path.
- **Coupon:** Implemented and wired in V1; present as DOM in shared UI but not wired in V2 (no capability, no handlers).
- **Analytics:** Emitted only in V1; V2 has no impression/click tracking.
- **Bootstrap vs snapshot:** V1 uses bootstrap + decision; V2 uses a single snapshot. Different shapes and lifecycles (e.g. decision has cache, session hydration; snapshot does not).
- **Route naming:** Mix of `cart.*` and `apps.cart-pro.*` for app-proxy routes; re-exports keep both URL shapes working.

### 5.4 Sources of Chaos

- **cart-pro.js not in embed:** Confusion about which script runs; docs and audits refer to cart-pro.js behavior while production is V2-only.
- **Two possible CartProUI providers:** cart-pro-ui.js and the tail of cart-pro.js; load order would decide which wins if both were present.
- **Snapshot URL vs route path:** Storefront calls `/apps/cart-pro/snapshot/v2`; app serves it via `/cart/snapshot/v2` (proxy rewrite). Documented but easy to miss.
- **First snapshot request can block:** ensureCatalogReady + catalog warm on cold shop makes the first snapshot slow and undefined from a UX perspective.
- **V2 “ready” depends on snapshot and cart:** No single explicit “ready” event; v2Ready is set after fetchCart, and snapshot is assumed present after waitForSnapshot (or timeout).
- **Full re-renders on every update:** No granular updates; every data change triggers full renderInitial.
- **prewarmVariants:** Unbounded parallel variant fetches; scale depends on snapshot product count.

### 5.5 Refactor Boundaries (Natural Cut Lines)

1. **Storefront: V1 vs V2**  
   - Remove or clearly gate cart-pro.js (e.g. load only when a theme setting or embed variant requests V1).  
   - Keep a single CartProUI surface: either always cart-pro-ui.js and delete the CartProUI export from cart-pro.js, or define a single “cart drawer contract” and have one implementation.

2. **Backend: bootstrap vs snapshot**  
   - If V1 is retired: remove or deprecate `cart.bootstrap` and decision/analytics routes, or move them behind a feature flag.  
   - If both stay: document which storefront path uses which endpoint and keep response shapes and capabilities aligned where they share concepts (e.g. UI, allowCouponTease).

3. **Coupon**  
   - Either add capabilities.onCouponApply / onCouponRemove in v2 and wire them in cart-pro-ui.js (calling Shopify discount APIs from v2), or remove coupon DOM from the shared UI and keep it V1-only.

4. **Analytics**  
   - Either add analytics calls in cart-pro-v2.js (impression/click to existing route) with same contract as V1, or formally document that V2 does not send analytics and accept the gap.

5. **Snapshot performance**  
   - Move ensureCatalogReady off the critical path (e.g. run catalog warm on webhook or background job; snapshot returns minimal or cached data when catalog is empty and trigger async warm).  
   - Or return a fast “config only” response and let the client request “full snapshot” when opening the cart.

6. **UI module**  
   - cart-pro-ui.js is the single drawer implementation for V2; treat it as the canonical UI and remove duplicate drawer and CartProUI from cart-pro.js if V1 is removed or refactored to use the same module.

7. **Route surface**  
   - Consolidate or clearly name routes (e.g. one “config” or “snapshot” contract for storefront and one set of action routes) so that app proxy and storefront URLs have a single mental model.

---

*End of audit. No code was modified; this document is a reconstruction and map only.*
