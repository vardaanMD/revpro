# Cart Pro — High-Level Architectural Audit & Integration Blueprint

**Purpose:** Repo-wide audit and integration design to wire Admin UI, backend data layer, analytics ingestion, and theme cart hijack to the V3 runtime while preserving V3 as the clean core.

**Constraints (invariants):**
- Do NOT merge V1 runtime into V3
- Do NOT reintroduce global state
- Do NOT couple engine to DOM
- Do NOT break effect queue guarantees
- Maintain deterministic cart mutations
- Preserve shadow DOM isolation

---

## STEP 1 — Audit cart.txt

**Source:** `cart.txt` (production third-party cart bundle, ~37.7k lines, Vite + Svelte IIFE).

### 1.1 Architectural Map of cart.txt

| Layer | Responsibility | Key mechanisms |
|-------|----------------|----------------|
| **Theme integration** | Cart icon hijack, add-to-cart interception, drawer open trigger, hide other carts, cart page override | `cartIconQuerySelectors`, `atcButtonSelectors`, `addCartIconFunction`, `addItemtoCartFromForm`, `hideOtherCarts`, `runCartIconMO`, MutationObserver, PerformanceObserver |
| **Runtime logic** | State (50+ stores), cart sync, discounts, free gifts, upsell (standard + AI), rewards, checkout overlay | `store_cart`, `store_configurations`, `getCart`/`addToCart`/`changeCart`, `applyDiscount`, `checkAndAddFreebie`, `getStandardUpsellRecommendations`, `fetchAIProductRecommendations` |
| **Admin/data** | Config load, sessionStorage cache, dashboard preview postMessage | `fetchConfigurations` → GET `/v3/kwik-cart/request`, `loadConfigurations`, sessionStorage `kwik-cart-request-data`, `processCheckoutMessage` / dashboard `kwik-cart-preview` |
| **Analytics** | Event logging to backend + Shopify | `logEvent` → POST hits.gokwik.co, `fireCustomerEvent` → Shopify.analytics.publish, `fireGokwikTrigger` → postMessage |

**Coupling points:**
- **Boot:** App `onMount` → sessionStorage config → `loadConfigurations()` → `updateCart` → `getDiscounts` → `addInterceptors(atcBehaviour, stickyBar)` → `addSidecartEventListener` (hide other carts + cart icon attach).
- **Cart icon:** Config-driven selectors (`merchantCartIconSelector`, `globalCartIconSelector`) + default list; MutationObserver re-attaches when DOM changes; `localStorage` `gokwik-sidecart-cart-icon-element` for MO target.
- **Add-to-cart:** PerformanceObserver on `resource` entries for `/cart/add`, `/cart/change`, `/cart/clear`; on match: open drawer (OPENCART) or toast (POPUP), then `getCart` + optional free-gift flow; `store_pauseInterceptorExecution` prevents re-entry during own mutations.
- **Config → runtime:** Single `store_configurations`; appearance (atcBehaviour, stickyBar, emptyCart, checkoutButtons, themeColor, merchantCartIconSelector, etc.), freeGifts, upSell, discountDisplayConfig, oneClickOffer drive all behaviour.

### 1.2 Patterns to Copy

- **PerformanceObserver for /cart/ requests** — Detect external cart add/change/clear without patching every form; open drawer or show toast based on config (OPENCART vs POPUP).
- **Config hydrate from sessionStorage before network** — First paint from cache; then fresh config fetch; fallback to cache on fetch failure.
- **Cart loaded on init, not on first drawer open** — Drawer open is instant; no “first fetch” on open.
- **Variant availability batching** — e.g. 5 per batch to limit concurrency.
- **Single source of truth (stores) + reactive subscriptions** — UI and side effects react to cart/config changes.
- **Shadow DOM** — Isolate styles and avoid theme/third-party conflicts.
- **Cart icon selector list + MutationObserver** — Re-attach when theme injects dynamic cart icons.
- **hideOtherCarts(selectors)** — Hide theme/other app cart drawers via CSS (display/visibility/pointer-events).
- **Debounce revalidation** (e.g. 800ms) for discount reapply to avoid storm.
- **Dedup for analytics** — Time-window dedup by event name + payload.
- **Feature gating** — Config + capabilities drive what runs (e.g. oneClickOffer.autoApply, showInputOnly).

### 1.3 Patterns to Avoid

- **50+ writable stores in one flat namespace** — Hard to reason about; prefer a single state store with slices (as in V3).
- **Domain-specific branches in core logic** — e.g. `gk_cart_domain === "myblissclub.myshopify.com"`; keep core pure, push overrides to config or integration.
- **Globals never torn down** — `window.openGokwikSideCart` etc. not removed on destroy; integration layer must own globals and call engine.destroy() + cleanup.
- **Config and cart logic mixed with DOM scanning** — Keep engine free of `document.querySelector`; theme layer does DOM.
- **Bootstrap that blocks on “decision” or heavy APIs** — Prefer config-first snapshot; no blocking decision route for drawer open.

---

## STEP 2 — Audit V3

**Source:** `revstack/cart-pro-v3-runtime` (Engine, state, effect queue, mount, UI).

### 2.1 Runtime Core Strengths

- **Single state store** — `EngineState` with slices: app, ui, cart, discount, freeGifts, upsell, rewards, checkout, analytics. Immutable updates via `setState`/`updateState`.
- **Deterministic effect queue** — Serialized async effects; no parallel cart mutations; continue-on-failure; queue length warning in dev.
- **Config normalization** — `RawCartProConfig` → `normalizeConfig()` → frozen `CartProConfigV3`; engine runs off normalized config only; feature flags gate modules.
- **Clean engine boundary** — No DOM in engine; no admin logic; no backend URL assumptions beyond `cartApi`/`discountApi`/`variantApi`/`recommendationsApi` (Shopify and optional backend).
- **Cart sync** — `syncCart()` from Shopify; reconcile discount state from cart; reapply discounts and sync free gifts in queue; revalidation debounced.
- **Discounts** — validate → apply/remove; stacking; one-click offer (exact/min/max).
- **Free gifts** — `computeExpectedGifts` / `diffGifts`; add/remove via cartApi; `internalMutationInProgress` to avoid interceptor re-entry.
- **Upsell** — Standard (rule-based) + AI (debounced recommendations API); variant availability cache.
- **Rewards** — Tiers, unlocked index, confetti flag.
- **Checkout overlay** — State machine (IDLE → LOGIN → OTP → ADDRESS → PAYMENT → COMPLETE); postMessage handler with origin check.
- **Analytics** — Queue, batch (5 or 10), flush interval, dedup window; `sendAnalyticsBatch` to `Shopify.routes.root + '/analytics'` (expects backend at that path).
- **Interceptor** — PerformanceObserver for `/cart/add`, `/cart/change`, `/cart/clear`; emits `cart:external-update` only; engine subscribes and enqueues `syncCart()`; does not open drawer or touch DOM.

### 2.2 Missing Integration Layers

| Layer | Status | Notes |
|-------|--------|--------|
| **Admin config ingestion** | Missing | Engine has `loadConfig(raw)` but no source: block does not pass config; no snapshot or inline JSON from backend. |
| **Persistent config** | Missing | No DB read; V2 uses `buildBootstrapSnapshotV2` + snapshot route; V3 needs equivalent “V3 config” from ShopConfig/DB. |
| **Backend analytics endpoint** | Partial | Engine POSTs to `Shopify.routes.root + '/analytics'` with `{ events }`; existing `cart.analytics.event` expects different schema (productId, eventType, cartValue). Need V3 analytics ingestion (batch, dedup server-side, link shop + sessionId). |
| **Theme cart icon interception** | Missing | No DOM code in runtime; no list of selectors; no click handler to open drawer. |
| **Add-to-cart form hijacking** | Partial | Interceptor detects /cart/ requests and triggers sync; does not open drawer or show toast (that would be UI/integration). |
| **Cart page override** | Missing | No redirect to `/?openCart=true` or equivalent; no replace cart page. |
| **Drawer open trigger from theme** | Missing | No global `openCart()`; App has internal open/close; no exposure for “cart icon click” or “after ATC”. |

### 2.3 Engine Boundaries and Safe Extension Points

- **Engine does not:** Scan DOM, read document, assume admin, assume a specific analytics URL (beyond configurable fetch in analytics.ts), or own window globals.
- **Safe extension points:**
  - **Config:** `engine.loadConfig(raw)` — call from block or integration after fetching raw config (snapshot or inline JSON).
  - **UI open/close:** `engine.setState({ ui: { drawerOpen: true|false } })` — integration or UI can call this (e.g. when cart icon clicked or after ATC).
  - **Events:** `engine.on('cart:updated', ...)`, `engine.emit('...')` — integration can subscribe to open drawer on first add, etc.
  - **Analytics:** Engine already builds and flushes events; only the **endpoint** and **schema** need to be agreed with backend.
- **Where integration must NOT attach:** Inside effect queue, inside discount/free-gift/upsell logic, or by mutating engine state from outside in a way that races with the queue (use engine API only).

---

## STEP 3 — Compare Architectures

| Layer | cart.txt | V1/V2 | V3 | Recommended Future |
|-------|----------|-------|-----|-------------------|
| **Runtime** | Single IIFE, 50+ stores, Svelte | Legacy cart-pro.js, decision bootstrap, V2 snapshot | Single Engine, one state store, effect queue, no DOM | Keep V3 as sole runtime |
| **Cart UI** | Svelte in Shadow DOM, sidecart + sticky bar | Legacy UI, cart-pro-ui.js | Svelte Drawer in Shadow DOM, single “Open V3 Drawer” for dev | Same; add theme-driven open/close |
| **DOM hijack** | Cart icon selectors, ATC form intercept, hide other carts, MutationObserver | Theme embed, possible bootstrap-driven | None in engine; interceptor only emits cart:external-update | New theme integration module (see Step 4) |
| **Admin UI** | External dashboard, postMessage preview | React admin, app settings, onboarding | None | Keep V1 admin; add “V3 config” output (RawCartProConfig) |
| **Data persistence** | sessionStorage config cache; backend owns config | Prisma ShopConfig, catalog (ShopProduct), snapshot from DB | None | Admin saves to DB; snapshot or inline JSON for storefront |
| **Analytics** | logEvent → backend; Shopify.analytics | CrossSellEvent, CrossSellConversion, cart.analytics.event | Batch to /analytics; no backend yet | New V3 analytics ingestion: batch, dedup, shop + sessionId |
| **Billing** | N/A (third-party) | getBillingContext, capabilities, plan | None | Reuse V1; feature flags align with billing tier in snapshot |
| **Config flow** | fetchConfigurations → store_configurations; sessionStorage hydrate | Bootstrap v2 → snapshot → Liquid or fetch | loadConfig(raw) only; no source | Admin → DB → snapshot or inline → loadConfig(raw) |
| **Performance safety** | store_pauseInterceptorExecution, debounce, batch size 5 | Decision cache, rate limit | Effect queue, internalMutationInProgress, queue cap warn | Keep V3 guarantees; integration must not block main thread |
| **Feature flags** | In config (oneClickOffer, showInputOnly, etc.) | capabilities from billing | ConfigFeatureFlags in normalized config | Billing → capabilities → snapshot featureFlags |

---

## STEP 4 — Integration Blueprint

### 4.1 Runtime Layer (Keep V3)

- **No admin logic** — Engine stays unaware of admin or DB.
- **No DOM scanning inside engine** — No document.querySelector in Engine or effect queue.
- **No backend assumptions** — Cart/discount/variant APIs stay Shopify + optional backend URLs from config; analytics URL already derived from Shopify.routes.root.
- **Single entry:** `mountCartProV3(styles)` → getEngine(), create shadow root, mount App with engine.

### 4.2 Theme Integration Layer (New Module)

**Location:** New module, e.g. `revstack/cart-pro-v3-runtime/src/integration/themeConnector.ts` (or same repo, separate entry that runs after mount).

**Responsibilities:**

1. **Cart icon detection** — Maintain a list of selectors (default + config-driven merchant/global overrides). Query all matching elements; add click listener: `preventDefault`, `stopPropagation`, call `engine.setState({ ui: { drawerOpen: true } })`, optionally emit analytics.
2. **Add-to-cart interception** — Either:
   - Rely on existing PerformanceObserver in engine (already emits `cart:external-update`); **theme connector** subscribes to `cart:external-update` and, based on config (OPENCART vs POPUP), calls `engine.setState({ ui: { drawerOpen: true } })` or shows toast; or
   - Optionally attach form submit listeners to `form[action*='/cart/add']` for instant open before request completes (cart.txt uses both PerformanceObserver and form handler).
3. **Cart page override** — If config says “replace cart page”, on load when path is `/cart`, redirect to `/?openCart=true`; block or integration reads query and opens drawer.
4. **Drawer open trigger** — Expose a single function, e.g. `openCartProDrawer()`, that integration and block can call (wraps `engine.setState({ ui: { drawerOpen: true } })`).
5. **MutationObserver (optional)** — Re-run “cart icon attach” when DOM subtree changes so dynamic theme cart icons get the listener.
6. **Safe unmount** — `destroy()` must: remove all listeners, disconnect observers, remove global `openCartProDrawer` (if attached), call `engine.destroy()`.

**Must NOT:**

- Touch discount logic, analytics logic, or cart sync (engine only).
- Touch cart sync directly (only engine.syncCart via effect queue).
- Break engine isolation (theme connector gets engine reference from mount or getEngine()).

**API shape (example):**

```ts
// themeConnector.ts
export function createThemeConnector(engine: Engine, options: ThemeConnectorOptions): ThemeConnector {
  // options: cartIconSelectors, otherCartSelectors, atcBehaviour: 'OPENCART'|'POPUP', disableCartPage, etc.
  // - query cart icons, attach click → openDrawer
  // - subscribe engine.on('cart:external-update') → openDrawer or toast
  // - hide other carts (inject style or set display:none)
  // - optional MutationObserver for cart icons
  // - return { destroy() }
}
```

Config for theme connector (selectors, atcBehaviour, etc.) should come from the same raw config that engine receives (appearance slice).

### 4.3 Admin → Runtime Bridge

**Flow:**

1. **Admin (React)** — Reads ShopConfig + billing + catalog (or V3-specific config table) and builds a **RawCartProConfig** (or equivalent) that matches V3’s schema (discounts, freeGifts, upsell, rewards, checkout, analytics, featureFlags).
2. **Fetch DB config** — Server-side: get shop, get config, apply billing capabilities to feature flags, optionally merge UI (primaryColor, etc.) into a single JSON object.
3. **Deliver to storefront:**
   - **Option A — Snapshot endpoint:** New route e.g. `GET /apps/cart-pro/snapshot/v3` (app proxy). Returns JSON: `RawCartProConfig` (+ engineVersion: "v3"). Block or script fetches this once on load and calls `engine.loadConfig(snapshot)`.
   - **Option B — Inline JSON in Liquid embed:** Server-render the config into a `<script type="application/json" id="cart-pro-v3-config">...</script>`; block script reads it and calls `engine.loadConfig(JSON.parse(...))`.
4. **engine.loadConfig(rawConfig)** — Already implemented; normalizes and sets state slices; no blocking.

**Recommendation:**

- **Prefer snapshot endpoint** for flexibility (same endpoint for preview, different shop param) and to avoid huge inline payloads in Liquid. Ensure snapshot is **non-blocking**: build from DB/cache; no decision engine call; no SAFE lock.
- **Avoid V2 bootstrap mess:** Do not call decision route or decision cache for V3; config is “what to show” (rules, feature flags, appearance), not “what the decision engine decided this second”.

**Implementation outline:**

- Add `buildSnapshotV3(shop)` in app (or extend buildSnapshot) that returns a shape compatible with `RawCartProConfig`: map ShopConfig + billing capabilities to featureFlags, map UI/cross-sell config to upsell.freeGifts.rewards.discounts.checkout.analytics.
- New route: `cart.snapshot.v3.ts` (or same file with engineVersion: "v3" and different builder). Block: fetch snapshot, then `getEngine().loadConfig(snapshot)` before or right after mount.

### 4.4 Backend Data Layer

**Analytics ingestion:**

- **Endpoint:** e.g. `POST /apps/cart-pro/analytics/v3` or reuse path that storefront already uses (`/analytics` with body `{ events }`). V3 engine sends `{ events: AnalyticsEvent[] }` (id, name, payload, timestamp, cartSnapshot, sessionId).
- **Server:** Validate schema (array of events, each with name, payload, sessionId, etc.); batch insert into a new table or existing event store; **dedup by (sessionId, id)** or (shop, sessionId, name, payload hash) server-side; link to shop (from app proxy or header) and sessionId.
- **Tables:** Either extend existing analytics or add `CartProEvent` (shopDomain, sessionId, eventId, name, payload, cartSnapshot, timestamp). Retention and indexing per product needs.

**Config storage:**

- **Option A — JSON config column:** Add `configV3 Json?` to ShopConfig (or new table keyed by shop). Admin saves entire RawCartProConfig; snapshot builder reads it and merges billing/capabilities into featureFlags.
- **Option B — Structured tables:** Tables for rewards tiers, free-gift rules, upsell rules, etc.; snapshot builder assembles RawCartProConfig from DB. More normalized, more migration.
- **Recommendation:** Start with **JSON config column** for speed; version key in config for future migrations. Optionally versioned (configVersion, updatedAt) for rollback.

**Billing:**

- Reuse V1 logic: `getBillingContext(shop, config)` → capabilities. In snapshot V3, set `featureFlags.enableDiscounts`, `enableFreeGifts`, `enableUpsell`, `enableRewards`, `enableCheckout`, `enableAnalytics` from capabilities so engine and UI respect plan.

### 4.5 Migration Strategy

**Phase A — Replace runtime only**

- Keep V1 admin + DB + Prisma + billing.
- Storefront: use V3 block only (cart_pro_embed_v3.liquid + cart-pro-v3.js).
- Add **V3 snapshot route** that returns config derived from current ShopConfig + billing (and optional configV3 JSON). Block fetches snapshot and calls `engine.loadConfig(snapshot)`.
- Add **theme integration** (themeConnector): cart icon, ATC open drawer, hide other carts; optional cart page redirect. No removal of V1 assets yet.
- **Do not** load legacy cart-pro.js or cart-pro-v2.js on the same page when V3 is enabled (avoid dual chaos).

**Phase B — Deprecate decision engine for cart**

- Stop calling decision route / decision cache for storefront cart config. Snapshot V3 is the only config source for V3 runtime.
- Remove or gate legacy bootstrap/snapshot v2 usage where V3 is active (e.g. by engineVersion in ShopConfig or embed list).
- Remove legacy cart-pro.js from extension assets (or keep but not embedded when V3 selected).

**Phase C — Snapshot consolidation**

- Remove V2 snapshot routes (or return 410) when all shops use V3.
- Keep single snapshot route for V3; admin writes config to DB; snapshot reads and returns RawCartProConfig.

---

## STEP 5 — Output Summary

### 5.1 Full System Diagram (Text Tree)

```
Host page (theme)
├── Theme integration layer (NEW)
│   ├── Cart icon detection → openCartProDrawer()
│   ├── Add-to-cart: subscribe cart:external-update → open drawer / toast
│   ├── Hide other carts (CSS)
│   ├── Cart page override (?openCart=true)
│   └── MutationObserver (cart icons) → destroy() cleans up
│
├── Cart Pro block (cart_pro_embed_v3.liquid)
│   ├── <div id="cart-pro-v3-root">
│   ├── <script src="cart-pro-v3.js" defer>
│   └── Optional: fetch snapshot → getEngine().loadConfig(snapshot)
│
└── Runtime (V3 only)
    ├── mount.ts → getEngine(), shadow root, App
    ├── Engine
    │   ├── stateStore (single EngineState)
    │   ├── effectQueue (serialized effects)
    │   ├── loadConfig(raw) ← snapshot or inline JSON
    │   ├── syncCart, addToCart, changeCart, removeItem
    │   ├── applyDiscount, removeDiscount, reapplyDiscounts
    │   ├── syncFreeGifts, setOneClickOffer
    │   ├── emitEvent (analytics queue → flush to backend)
    │   └── PerformanceObserver → cart:external-update
    ├── UI (Svelte Drawer)
    │   └── Reads stateStore; open/close via setState(ui.drawerOpen)
    └── destroy() → observers, timers, message listener

Backend (existing app)
├── Admin (React)
│   ├── ShopConfig, billing, catalog
│   └── Saves config (e.g. configV3 JSON or structured) for storefront
├── Snapshot V3 route
│   └── GET /apps/cart-pro/snapshot/v3?shop=... → RawCartProConfig
├── Analytics ingestion V3
│   └── POST /apps/cart-pro/analytics/v3 (or /analytics) → batch insert, dedup, shop + sessionId
└── Billing (existing)
    └── getBillingContext → capabilities → snapshot featureFlags
```

### 5.2 What to Reuse from V1/V2

- **Admin UI** — React app, app settings, onboarding; add “V3 config” output (form or JSON editor that maps to RawCartProConfig).
- **Prisma** — ShopConfig, Session, billing-related fields; add configV3 (Json) or equivalent; keep CrossSellEvent/CrossSellConversion if needed for existing analytics; add or reuse table for V3 event batch.
- **Billing** — getBillingContext, resolveCapabilities, plan; use to set featureFlags in snapshot.
- **Catalog** — ShopProduct, catalog-index, warm; use for upsell product pool in snapshot (variantIds, rules) if V3 config is built from DB.
- **Proxy auth** — verifyProxySignature, checkReplayTimestamp for snapshot and analytics routes.
- **Rate limiting** — For analytics ingestion.

### 5.3 What to Delete (Eventually)

- **Legacy cart-pro.js, cart-pro-v2.js** (and cart-pro-ui.js) from extension once V3 is sole runtime.
- **Decision route** for storefront cart (cart.decision, apps.cart-pro.decision) when config comes only from snapshot V3.
- **V2 snapshot / bootstrap routes** for cart (cart.snapshot.v2, apps.cart-pro.bootstrap.v2) after Phase C.
- **Decision cache / SAFE** usage for cart config (already not used in bootstrap v2; ensure no reintroduction).

### 5.4 What to Rewrite

- **Snapshot builder** — New `buildSnapshotV3(shop)` returning RawCartProConfig (from ShopConfig + configV3 + billing capabilities). No decision engine.
- **Analytics ingestion** — New or extended endpoint accepting V3 batch `{ events }`; schema: id, name, payload, timestamp, cartSnapshot, sessionId; store with shop, sessionId; dedup server-side.
- **Block** — Optional: fetch snapshot in block and call `getEngine().loadConfig(snapshot)` after script load (or inline JSON).
- **Theme connector** — New module; cart icon, ATC open drawer, hide other carts, optional MO, destroy().

### 5.5 Order of Execution (Phased)

1. **Phase A1** — Add V3 snapshot route + buildSnapshotV3 (config from DB + billing → RawCartProConfig). Block: fetch snapshot, loadConfig(snapshot).
2. **Phase A2** — Add theme integration module: cart icon, openCartProDrawer(), subscribe cart:external-update → setState(drawerOpen); hide other carts; destroy().
3. **Phase A3** — Add V3 analytics ingestion endpoint; ensure engine’s sendAnalyticsBatch URL points to it; dedup + store by shop + sessionId.
4. **Phase A4** — Admin: persist V3 config (configV3 JSON or form) and include in snapshot.
5. **Phase B** — Disable/remove decision route for cart; stop loading legacy cart-pro.js when V3 embed is present.
6. **Phase C** — Remove V2 snapshot/bootstrap for cart; single V3 snapshot.

### 5.6 Risk Analysis

| Risk | Mitigation |
|------|------------|
| Config shape mismatch | Define RawCartProConfig and normalizeConfig as single source of truth; snapshot builder must output compatible shape; add tests. |
| Theme connector breaks themes | Use conservative selectors; make list configurable; no aggressive hideOtherCarts without config. |
| Analytics loss | Backend must accept batch and dedup; idempotent insert by event id or (shop, sessionId, key). |
| Billing/feature flag drift | Snapshot always applies getBillingContext and maps capabilities to featureFlags; no client override of feature flags. |
| Double cart (V1 + V3) | Do not embed both; use single embed (V3) when migrating; hide other carts only for known selectors. |

### 5.7 Performance Considerations

- **Snapshot** — Non-blocking; no decision call; cache snapshot per shop (e.g. short TTL) if needed.
- **Theme connector** — MutationObserver only on subtree containing cart area if possible; debounce re-attach of cart icons.
- **Engine** — Already bounded: effect queue, analytics queue cap warning, internalMutationInProgress. Keep integration from doing heavy work on main thread before openDrawer.
- **First paint** — Optional: inline minimal config in Liquid (e.g. featureFlags only) so engine can show drawer immediately; full snapshot can follow.

### 5.8 Success Criteria

After following the blueprint:

- **V3 is the only runtime** on storefront when Cart Pro is enabled.
- **Admin config drives V3** via snapshot (or inline JSON) and loadConfig(raw).
- **Theme hijack is modular** (theme connector only; engine stays DOM-free).
- **Analytics stored server-side** (batch, dedup, shop + sessionId).
- **Billing gates features** via featureFlags in snapshot.
- **Cart behaves like cart.txt or better** (instant drawer open, ATC opens drawer or toast, cart icon opens drawer, other carts hidden, optional cart page redirect).
- **No architectural regression** (no global state, no engine–DOM coupling, effect queue and shadow DOM preserved).

---

**End of blueprint.** Implement in the order above; keep engine boundary strict and integration layer responsible for all DOM and global exposure.
