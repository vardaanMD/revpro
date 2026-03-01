# Full Repository Forensic Analysis — Cart System vs cart.txt

**Mode:** Observation and report only. No code modified. No fixes suggested.  
**Reference:** `cart.txt` (root), `cart_unminified.txt`, `docs/CART_TXT_ZERO_LATENCY_AUDIT.md`, `docs/CART_PRO_V3_FORENSIC_ARCHITECTURAL_AUDIT.md`.

---

## 1. Repo structure overview

### Directory tree (relevant paths)

```
revPRO/
├── cart.txt                          # Reference implementation (minified Svelte bundle)
├── cart_unminified.txt                # Same reference, unminified
├── apps/
│   └── api/                           # DEPRECATED backend (Express); not used by Shopify storefront
│       ├── routes/cart.ts             # POST /open — decision engine; ingestEvent/ingestDecision
│       └── routes/decision.ts
├── packages/
│   └── decision-engine/               # Shared: decideCartActions, types (CartSnapshot, Product, etc.)
├── revstack/                          # Canonical app (React Router + Svelte cart runtime)
│   ├── app/                           # React Router app (React/TSX)
│   │   ├── routes.ts                  # flatRoutes() — file-based routing
│   │   ├── routes/                    # API + pages
│   │   │   ├── cart.bootstrap.ts      # GET /cart/bootstrap — v1 bootstrap (UI + capabilities)
│   │   │   ├── cart.bootstrap.v2.ts   # GET /cart/bootstrap/v2 — V2 snapshot (buildBootstrapSnapshotV2)
│   │   │   ├── cart.snapshot.v2.ts    # GET /cart/snapshot/v2 — same as bootstrap v2
│   │   │   ├── cart.snapshot.v3.ts    # GET /cart/snapshot/v3 — V3 config (mergeWithDefaultV3 + featureFlags)
│   │   │   ├── cart.decision.ts       # GET/POST /cart/decision — decision route (SAFE, cache, catalog)
│   │   │   ├── cart.ai.v2.ts          # POST /cart/ai/v2 — AI recommendations (same-collection, lastAddedProductId)
│   │   │   ├── cart.analytics.v3.ts   # POST /cart/analytics/v3
│   │   │   └── cart.analytics.event.ts
│   │   ├── lib/                       # Server libs
│   │   │   ├── config-v3.ts           # CartProConfigV3, mergeWithDefaultV3, DEFAULT_CONFIG_V3
│   │   │   ├── shop-config.server.ts  # getShopConfig (Prisma ShopConfig, configV3 column)
│   │   │   ├── billing-context.server.ts
│   │   │   └── upsell-engine-v2/      # buildBootstrapSnapshotV2 (V2 snapshot builder)
│   │   └── components/                # React (admin/dashboard)
│   ├── cart-pro-v3-runtime/           # Svelte app (Vite) — storefront cart UI
│   │   ├── src/
│   │   │   ├── main.ts                # Entry: mountCartProV3(componentStyles), cart-pro-v2.css
│   │   │   ├── mount.ts               # Shadow DOM host, Engine, applyAppearanceVariables, cache read
│   │   │   ├── ui/App.svelte, v2/DrawerV2.svelte, v2/Recommendations.svelte, etc.
│   │   │   └── engine/                # Engine, state, configSchema, normalizeConfig, cartApi, recommendationsApi, etc.
│   │   ├── vite.config.ts
│   │   └── svelte.config.js
│   ├── extensions/cart-pro/           # Active theme extension (V3 only)
│   │   ├── blocks/cart_pro_embed_v3.liquid  # Embeds #cart-pro-v3-root, fetches /apps/cart-pro/snapshot/v3
│   │   └── assets/cart-pro-v3.js, cart-pro-v3.css
│   ├── archived-extensions/cart-pro-v1-v2/
│   │   ├── blocks/cart_pro_embed.liquid    # Fetches /apps/cart-pro/snapshot/v2, __CART_PRO_V2_SNAPSHOT__
│   │   └── assets/cart-pro.js, cart-pro-v2.js, cart-pro-ui.js
│   ├── prisma/schema.prisma           # ShopConfig (engineVersion, configV3 Json?)
│   └── shopify.app.toml                # app_proxy: url=/cart, prefix=apps, subpath=cart-pro
└── docs/                              # Audits, blueprints
```

### Frontends

| Location | Framework | Purpose |
|----------|-----------|--------|
| `revstack/app/` | React (React Router) | Admin UI, dashboard, settings, webhooks |
| `revstack/cart-pro-v3-runtime/` | Svelte (Vite) | Storefront cart drawer (shadow DOM) |

### Backends

| Location | Purpose |
|----------|--------|
| `revstack/` (React Router server) | Canonical backend: app proxy routes, auth, Prisma, ShopConfig, config-v3, upsell-engine-v2 |
| `apps/api/` | **Deprecated** — Express cart/decision; not used by Shopify storefront |

### API layers

- **revstack:** File-based routes under `app/routes/` → `/cart/bootstrap`, `/cart/bootstrap/v2`, `/cart/snapshot/v2`, `/cart/snapshot/v3`, `/cart/decision`, `/cart/ai/v2`, `/cart/analytics/v3`, `/cart/analytics/event`, plus webhooks and auth.
- **App proxy:** `shopify.app.toml` → `url=/cart`, `prefix=apps`, `subpath=cart-pro` → storefront path `/apps/cart-pro/...` (e.g. `/apps/cart-pro/snapshot/v3`).
- **apps/api:** Deprecated; POST `/open` and decision routes.

### Cart implementations

| Version | Location | Framework | Rendering | API it connects to |
|---------|----------|-----------|-----------|--------------------|
| **v1** | Legacy bootstrap + decision; `engineVersion: "v1"` in default config | — | — | `/cart/bootstrap`, `/cart/decision` |
| **v2** | `archived-extensions/cart-pro-v1-v2/`, `buildBootstrapSnapshotV2`, `cart.snapshot.v2`, `cart.bootstrap.v2` | JS (cart-pro.js, cart-pro-v2.js) | CSR, snapshot v2 | `/apps/cart-pro/snapshot/v2`, `/apps/cart-pro/ai/v2` |
| **v3** | `extensions/cart-pro/` (liquid + assets), `cart-pro-v3-runtime/` (Svelte) | Svelte | CSR, shadow DOM, snapshot v3 | `/apps/cart-pro/snapshot/v3`, `/cart/analytics/v3` |

### Build systems

- **revstack:** Vite (React Router app).
- **cart-pro-v3-runtime:** Vite (Svelte); output bundled into `extensions/cart-pro/assets/cart-pro-v3.js` (and CSS).

### Duplicate / overlapping implementations

- **Snapshot v2 vs bootstrap v2:** `cart.snapshot.v2` and `cart.bootstrap.v2` both call `buildBootstrapSnapshotV2(shop)` and return the same shape with `engineVersion: "v2"`. Duplicate route, same implementation.
- **Bootstrap v1 vs snapshot v3:** v1 bootstrap returns `BootstrapResponse` (UI + capabilities, engineVersion "v1"); v3 snapshot returns `CartProConfigV3` (config-v3 merge + featureFlags). Different shapes and consumers; v1 used by legacy path, v3 by active Liquid block.
- **Decision route:** Used by legacy (v1) flow and possibly v2; not used by V3 (V3 uses snapshot v3 only for config).

---

## 2. Cart version breakdown

### Cart v1 (legacy / partially active)

- **Location:** Backend: `cart.bootstrap.ts`, `cart.decision.ts`. Frontend: `archived-extensions/cart-pro-v1-v2` uses snapshot v2 and cart-pro.js, not v1 bootstrap per se; v1 is reflected in `engineVersion: "v1"` in bootstrap response and default config.
- **Framework:** Backend React Router loaders; frontend legacy JS (cart-pro.js uses `/apps/cart-pro/decision`, `/apps/cart-pro/bootstrap`).
- **Rendering:** CSR; bootstrap returns UI + capabilities; decision returns full decision payload.
- **API:** `/cart/bootstrap`, `/cart/decision` (app proxy `/apps/cart-pro/bootstrap`, `/apps/cart-pro/decision`).
- **State:** Legacy storefront scripts use `__CART_PRO_V2_SNAPSHOT__` when using v2 embed; v1 path uses bootstrap + decision.
- **Status:** **Partially active.** Bootstrap and decision routes exist and are used by legacy embed; default `engineVersion` in `DEFAULT_SHOP_CONFIG` is `"v1"`. Active storefront embed is V3 (cart_pro_embed_v3.liquid).

### Cart v2 (archived but still wired)

- **Location:** `archived-extensions/cart-pro-v1-v2/` (blocks + assets), `cart.snapshot.v2.ts`, `cart.bootstrap.v2.ts`, `cart.ai.v2.ts`, `revstack/app/lib/upsell-engine-v2/`.
- **Framework:** Backend: React Router, upsell-engine-v2 (buildBootstrapSnapshotV2). Frontend: cart-pro-v2.js, cart-pro-ui.js.
- **Rendering:** CSR; snapshot v2 JSON for Liquid embedding.
- **API:** `/cart/snapshot/v2`, `/cart/bootstrap/v2`, `/cart/ai/v2` (POST, body `lastAddedProductId`).
- **Status:** **Abandoned in favor of V3** but routes and extension still present. If a theme still used the old embed block, v2 would load.

### Cart v3 (intended active)

- **Location:** `extensions/cart-pro/` (cart_pro_embed_v3.liquid, cart-pro-v3.js/css), `cart-pro-v3-runtime/` (Svelte + Engine), `cart.snapshot.v3.ts`, `app/lib/config-v3.ts`.
- **Framework:** Svelte (Vite); shadow DOM mount; config from snapshot v3.
- **Rendering:** CSR; mount creates host `#revstack-v3-root`, shadow root, injects CSS and App.svelte; config from `/apps/cart-pro/snapshot/v3` and optional sessionStorage cache.
- **API:** Snapshot: GET `/apps/cart-pro/snapshot/v3`. Analytics: POST `/apps/cart-pro/analytics/v3`. Engine uses Shopify Cart API (cart.js, add-to-cart, etc.); recommendations API called at wrong URL (see below).
- **State:** Engine (state.ts) single store; loadConfig from snapshot/cache; syncCart from Shopify cart.
- **Routes that load it:** Any page with Cart Pro V3 app embed enabled (block `cart_pro_embed_v3.liquid`).

### Which version the app actually renders

- **Storefront:** With current extension, the **V3** block is the one that loads: `cart_pro_embed_v3.liquid` → `cart-pro-v3.js` → `mountCartProV3` → Svelte App + DrawerV2. So **V3 is the active storefront cart**.
- **Partially wired:** **V1** bootstrap and decision are still live and used by legacy embed or fallback (e.g. bootstrap returns `engineVersion: "v1"` when not entitled). **V2** snapshot/bootstrap/ai routes are still in the codebase and can be called if the old embed is used.
- **Orphaned:** **apps/api** is deprecated and not used by the Shopify storefront; revstack is the single backend for the app.

---

## 3. UI rendering pipeline analysis

### End-to-end pipeline

1. **Entry:** Store page loads with Cart Pro V3 embed → Liquid renders `<div id="cart-pro-v3-root">`, `<script src="cart-pro-v3.js" defer>`, then inline script that fetches `/apps/cart-pro/snapshot/v3`.
2. **Router:** N/A for storefront; React Router is for the admin app. Storefront is static Liquid + one JS bundle.
3. **Page:** Merchant theme page; no React Router. App embed block injects div + script.
4. **Component:** `cart-pro-v3.js` loads (defer) → `main.ts` runs → `mountCartProV3(componentCss)` in `mount.ts`.
5. **Mount:** `getEngine()` → `new Engine()`, `init()`; `ensureBodyHost()` gets or creates `#revstack-v3-root` (and removes legacy `#cart-pro-v3-root`); shadow root created; sessionStorage read for `cart-pro-v3-config`; if present, `applyAppearanceVariables(host, parsed)` and `engine.loadConfig(parsed)`; then `new App({ target: appContainer, props: { engine } })`.
6. **App.svelte:** Renders “Open V3 Drawer” button and `<DrawerV2 {engine} />`; onMount enqueues `engine.syncCart()`.
7. **DrawerV2:** Reads state (cart, discount, rewards, upsell, checkout, shipping); passes to CheckoutSection, CouponSection, Recommendations, etc.
8. **Data fetch:** Config: snapshot fetch (inline script) → `applyAppearanceAndLoadConfig(config)` → `__applyCartProAppearance`, `CartProV3Engine.loadConfig(config)`, sessionStorage write. Cart: `syncCart()` in Engine (effect queue) → cartApi fetch, then state updates (shipping, upsell, discount, etc.).
9. **State:** Single `stateStore` (writable); updates from loadConfig, syncCart, and async callbacks (e.g. recommendations).
10. **Render:** Svelte reactivity; DrawerV2, ShippingSection, Recommendations, etc. read from stateStore.

### Where rendering breaks or misbehaves

- **Host ID mismatch:** Liquid creates `#cart-pro-v3-root`; mount uses `ROOT_ID = 'revstack-v3-root'` and creates that element if missing, then removes `#cart-pro-v3-root` as “legacy.” So the first paint div from Liquid is never the host; the real host is created by JS. No functional break but inconsistent IDs.
- **Config timing:** If snapshot is slow and cache is empty, engine starts with `config === null`; UI may render with defaults or missing data (e.g. shipping threshold, teaseMessage) until snapshot completes.
- **Shipping tease:** ShippingSection shows “Add X more for free shipping” only when `shipping.remaining != null` and not unlocked. `remaining` is set in syncCart from `this.config?.freeShipping?.thresholdCents`. Backend config-v3 and mergeWithDefaultV3 **do** include `freeShipping` and `teaseMessage` in the types and DEFAULT_CONFIG_V3; if snapshot or DB doesn’t send them, they stay null/empty and the tease doesn’t show.
- **Countdown:** CheckoutSection passes `countdownVisible={true}` (hardcoded); the countdown div has no child content or timer logic, so the urgency timer never shows meaningful content.
- **Recommendations:** See Section 6; stub and API mismatch cause wrong or empty recommendations.

### Hydration

- No SSR for the cart; it’s pure CSR. No hydration mismatch in the React sense. The only “hydration” is config: sessionStorage cache vs snapshot. If cache is stale or missing, config can be null until snapshot returns.

### Wrong components / state

- **Recommendations.svelte** reads `state?.upsell?.standard` and `state?.upsell?.aiRecommendations`. Standard is set from `computeStandardUpsell` in syncCart; aiRecommendations is then overwritten by `buildStubRecommendations(raw)` in the same sync (Engine.ts 803–808), so **aiRecommendations** is forced to stub (first two cart items) and real AI result is overwritten until/unless the debounced callback runs later. So wrong data (stub = cart items) is shown for the AI slot; and the real AI endpoint is not called correctly (see Section 6).

---

## 4. Framework migration analysis

### Old vs new

- **Admin app:** React (React Router) — current.
- **Storefront cart:** Previously JS (cart-pro.js, cart-pro-v2.js) in archived extension; **current** is Svelte in `cart-pro-v3-runtime/`. So migration is **JS → Svelte** for the cart UI.

### Hybrid areas

- **revstack:** React for admin routes and layout; Svelte only inside the storefront bundle (cart-pro-v3.js). No Svelte inside React or vice versa; the only “hybrid” is the repo containing both.
- **Config:** Backend is TypeScript (config-v3.ts); runtime has its own configSchema and normalizeConfig; types are kept in sync with comments but are separate modules.

### Incompatibilities

- **No broken imports** between React and Svelte; they are separate apps. The storefront bundle is built by Vite and dropped into the extension assets.
- **Broken bindings:** CheckoutSection’s `countdownVisible` is hardcoded `true` and not bound to `config.appearance.countdownEnabled` or `--cp-countdown-enabled`.
- **Lifecycle:** Engine is a singleton; mount runs once. If the embed were loaded twice (e.g. two blocks), behavior could be undefined; no guard in mount for double init.

### Where migration went wrong

- **Recommendations:** V2 AI endpoint (`/cart/ai/v2`) expects POST body `{ lastAddedProductId }` and returns same-collection products. V3 runtime’s `recommendationsApi.ts` calls `${getBaseUrl()}recommendations` (i.e. `/recommendations`) with body `{ variant_ids: variantIds }` (cart variant IDs). So **URL and body** are both wrong for the existing backend; no route exists at `/recommendations`, and the contract doesn’t match. Migration to V3 did not align the recommendation client with the existing AI v2 route or with a new V3 recommendation contract.
- **Stub overwriting AI:** After computing standard upsell and optionally firing AI fetch, syncCart unconditionally sets `aiRecommendations: stubAI` (stub = first two cart items). So even when AI is enabled, the synchronous stub overwrites the AI slot; the debounced callback can overwrite again later with API result (or [] when the request fails). So the “stub only” comment is not honored for the data flow: stub is written to aiRecommendations every sync.
- **Countdown:** No Svelte component or logic was added to drive the countdown UI; the div is present but empty.

---

## 5. API layer analysis

### Cart-related routes (revstack)

| Route file | Path | Method | Purpose |
|------------|------|--------|---------|
| cart.bootstrap.ts | /cart/bootstrap | GET | V1 bootstrap: UI + capabilities, safe fallback, engineVersion "v1" |
| cart.bootstrap.v2.ts | /cart/bootstrap/v2 | GET | V2 snapshot via buildBootstrapSnapshotV2 |
| cart.snapshot.v2.ts | /cart/snapshot/v2 | GET | Same as bootstrap v2 |
| cart.snapshot.v3.ts | /cart/snapshot/v3 | GET | V3 config: mergeWithDefaultV3(shopConfig.configV3) + featureFlags |
| cart.decision.ts | /cart/decision | GET/POST | Decision engine, SAFE, cache, catalog |
| cart.ai.v2.ts | /cart/ai/v2 | POST | AI recommendations: same-collection by lastAddedProductId |
| cart.analytics.v3.ts | /cart/analytics/v3 | POST | Analytics events |
| cart.analytics.event.ts | /cart/analytics/event | POST | Analytics event |

App proxy: storefront path `/apps/cart-pro/...` maps to app’s `/cart/...` (exact mapping depends on server/proxy config; comments in routes refer to `/apps/cart-pro/...`).

### Which frontend calls which API

- **V3 Liquid + runtime:** Fetches `/apps/cart-pro/snapshot/v3` (inline script); Engine uses Shopify Cart API; analytics to `/apps/cart-pro/analytics/v3`; recommendations to `${getBaseUrl()}recommendations` (wrong).
- **V2 (archived):** Fetches `/apps/cart-pro/snapshot/v2`; cart-pro-v2.js has `AI_V2_URL = "/apps/cart-pro/ai/v2"` and uses it with the correct contract.
- **V1/legacy:** Bootstrap and decision are called by legacy cart-pro.js.

### Duplicate / conflicting / dead endpoints

- **Duplicate:** `/cart/snapshot/v2` and `/cart/bootstrap/v2` return the same shape (buildBootstrapSnapshotV2 + engineVersion "v2").
- **Conflicting:** None; v1 bootstrap, v2 snapshot, v3 snapshot return different shapes for different consumers.
- **Broken from frontend:** Runtime’s recommendations API calls `/recommendations` with `variant_ids`; no such route exists; backend has `/cart/ai/v2` with `lastAddedProductId`. So the V3 recommendation client is effectively **dead** (404 or wrong endpoint) and **wrong contract**.
- **Unused:** `apps/api` is deprecated; its routes are not used by the Shopify storefront.

### Current API architecture summary

- **Single backend:** revstack (React Router) for admin and app proxy.
- **Config:** V3 uses snapshot v3 only (config-v3 + billing featureFlags). V2 uses snapshot v2 (upsell-engine-v2). V1 uses bootstrap + decision.
- **Recommendations:** Backend has one AI endpoint (cart.ai.v2); V3 runtime does not call it correctly; it uses a non-existent `/recommendations` and a different body shape.

---

## 6. Recommendation system analysis

### Flow (source → render)

1. **Source:** Backend: `cart.ai.v2.ts` — reads ShopProduct table, same-collection for `lastAddedProductId`; returns `{ products }`. Runtime: `recommendationsApi.ts` builds cart signature from cart items, POSTs to `getBaseUrl() + 'recommendations'` with `{ variant_ids: variantIds }`.
2. **Fetch:** Runtime: `debouncedPostRecommendations(raw, callback)` in Engine; URL = `/recommendations` (relative to Shopify.routes.root), not `/apps/cart-pro/ai/v2`. So the request goes to the store’s `/recommendations`, which is not a revstack route → 404 or theme route.
3. **Transform:** Backend expects `lastAddedProductId` (string); returns `ProductSnapshot[]`. Runtime sends `variant_ids` (number[]); expects `recommendations` or `variants` or array in response.
4. **Store:** Engine state `upsell.aiRecommendations`; also `upsell.standard` from computeStandardUpsell.
5. **Hydrate:** In syncCart, after computing standard and optionally firing the debounced AI fetch, Engine sets `aiRecommendations: stubAI` where `stubAI = buildStubRecommendations(raw)` (first two cart items). So the state is **overwritten** with stub every sync.
6. **Render:** Recommendations.svelte uses `recommendations = state?.upsell?.standard ?? []` and `aiRecommendations = state?.upsell?.aiRecommendations ?? []`, then `recs = [...recommendations, ...aiRecommendations]`. So UI shows standard + aiRecommendations; aiRecommendations is the stub (cart items) until/unless the debounced callback overwrites with API result (which is [] when the request fails).

### Why recommendations are wrong

- **URL:** Runtime calls `/recommendations`; backend is at `/apps/cart-pro/ai/v2`. So the V3 client never hits the correct endpoint.
- **Body:** Runtime sends `{ variant_ids: [...] }`; backend expects `{ lastAddedProductId: string }`. Contract mismatch.
- **Stub:** `buildStubRecommendations(raw)` returns the first two **cart** items (no “not in cart” filter). That stub is written to `aiRecommendations` every sync, so “same product already in cart” appears as a recommendation.
- **Overwrite:** The comment says “Stub ONLY AI recommendations; rule-based standard must not be overwritten.” Code does not overwrite `standard`, but it does overwrite `aiRecommendations` with stub; so the AI slot is always filled with stub (cart items) synchronously, and the real AI result (if the callback ran with the right endpoint) would overwrite later. Because the endpoint is wrong, the callback typically gets [] or fails, so the UI either shows stub (wrong) or empty.

---

## 7. State management analysis

### State systems

- **Cart runtime (Svelte):** Single `stateStore` (writable) in `state.ts`; `createStateStore()` → `createInitialState()`. All cart UI reads from this store. Engine holds `this.stateStore` and updates it via `setState` / `updateState`.
- **Config:** Engine holds `this.config` (NormalizedEngineConfig | null); set only by `loadConfig()`. Not in the state store; UI reads config via `engine.getConfig()` where needed (e.g. CouponSection teaseMessage).
- **Cache:** sessionStorage key `cart-pro-v3-config`; read in mount before App mount; written by Liquid inline script after snapshot. Not a reactive store.
- **Admin app:** React Router loaders and context (e.g. appLayout from layout); no shared store with the storefront.

### Cart state flow

- **Initial:** createInitialState() sets cart, discount, rewards, upsell, shipping, checkout, etc. with defaults (e.g. shipping.loading: true, upsell.standard: [], aiRecommendations: []).
- **loadConfig:** Sets `this.config` and updates state slices for discount, freeGifts, upsell (standardConfig, aiEnabled, oneTick), rewards, checkout, analytics. Does not set shipping.
- **syncCart:** Fetches cart; updates cart slice; from config.freeShipping.thresholdCents updates shipping; from config.upsell.standardConfig computes standard and sets upsell.standard; if aiEnabled, triggers debouncedPostRecommendations and later sets aiRecommendations; then unconditionally sets aiRecommendations to stub and loading to false.
- **Event bus:** Engine has `eventBus` for internal events (e.g. cart:external-update → enqueue syncCart). No cross-tab or shared worker.

### Where state diverges

- **Config vs store:** Config is in Engine; appearance is applied to the host via `applyAppearanceVariables`; some UI (e.g. countdownVisible) does not read config and is hardcoded.
- **Upsell:** standardConfig and standard are in state; aiRecommendations is overwritten by stub every sync, so the “source of truth” for display is temporarily stub until the async callback runs (and then fails or returns []).

### Multiple sources of truth

- **Config:** Snapshot (server) and sessionStorage (client cache). Cache is overwritten by snapshot when it completes; engine config is overwritten by snapshot or cache. Single logical source per load, but two channels (cache vs snapshot).
- **Recommendations:** standard from config + computeStandardUpsell (correct); aiRecommendations from stub (wrong) or from broken API call (empty). So two sources: standard rules (correct) and stub/API (wrong or empty).

---

## 8. Routing analysis

### Cart routes (revstack app)

- From `+routes.ts`: `/cart/bootstrap`, `/cart/bootstrap/v2`, `/cart/snapshot/v2`, `/cart/snapshot/v3`, `/cart/decision`, `/cart/ai/v2`, `/cart/analytics/v3`, `/cart/analytics/event`. All are React Router file-based routes.
- Storefront does not use React Router; it loads a single bundle and the Liquid block. No client-side router in the cart.

### Cart page entry points

- **Storefront:** Theme includes the app embed block → Liquid renders div + inline script + script src to cart-pro-v3.js. No “page” in the React sense; the script runs in the merchant theme’s context.
- **Admin:** Dashboard, settings, etc. are under `/app`, `/app/settings`, etc.; they do not render the cart. Cart is only embedded on the storefront.

### Recommendation routes

- **Backend:** POST `/cart/ai/v2` (cart.ai.v2.ts).
- **Runtime:** Calls `getBaseUrl() + 'recommendations'` → `/recommendations` (wrong path).

### Code path that actually executes (storefront)

1. Theme loads → Liquid block runs → fetch `/apps/cart-pro/snapshot/v3` (inline), load cart-pro-v3.js (defer).
2. main.ts → mountCartProV3(componentCss).
3. mount.ts → getEngine(), ensureBodyHost(), shadow root, sessionStorage read, loadConfig if cached, new App({ target, props: { engine } }).
4. Inline script: when snapshot resolves → applyAppearanceAndLoadConfig(config) → loadConfig + sessionStorage write.
5. App.svelte onMount → enqueue syncCart.
6. syncCart → cart fetch, state updates, shipping from config, standard upsell, AI fetch to wrong URL, then stub written to aiRecommendations.
7. User opens drawer → DrawerV2 shows; Recommendations shows standard + aiRecommendations (stub or []).

---

## 9. cart.txt comparison report

### Reference

- **cart.txt:** Minified Svelte bundle (reference implementation). Behavior described in `docs/CART_TXT_ZERO_LATENCY_AUDIT.md` and `docs/CART_PRO_V3_FORENSIC_ARCHITECTURAL_AUDIT.md`.

### What matches

- **Shadow DOM:** V3 uses a shadow root for the cart UI; cart.txt uses a shadow-style container.
- **Config cache:** sessionStorage used; read before/at mount; write after fetch. Key in V3 is `cart-pro-v3-config`; cart.txt uses `kwik-cart-request-data`.
- **Single snapshot endpoint:** V3 has one config endpoint for the storefront (snapshot v3); cart.txt has one config fetch.
- **Appearance on host:** V3 applies CSS variables on the host; cart.txt applies theme on document root after fetch.
- **Engine + state store:** Centralized state and config in Engine; single store for cart/discount/upsell/shipping/etc.
- **Backend schema:** config-v3 includes freeShipping and teaseMessage in types and DEFAULT_CONFIG_V3; mergeWithDefaultV3 merges them (config-v3.ts lines 79–80, 118, 195–196).

### What differs

- **Bundle default config:** cart.txt has a writable store initialized with a full default config at load. V3 has no bundle-embedded default; engine starts with `this.config = null` until loadConfig(cache or snapshot).
- **Content gate:** cart.txt sets `loadSidecart = true` only after `await loadConfigurations()` and related async; V3 mounts the drawer immediately and enqueues syncCart; no gate that waits for config + cart before showing content.
- **Theme timing:** cart.txt applies theme only after fetch; V3 applies from cache (if present) before mount and again from snapshot.
- **Recommendations:** cart.txt uses standard from config and AI async; V3 has standard from config but overwrites aiRecommendations with stub every sync and calls the wrong recommendation URL/body.

### What is missing in V3

- Bundle-embedded default config so UI has something before any fetch.
- Drawer content visibility gated on config (and optionally cart) ready.
- Correct recommendation client: URL `/apps/cart-pro/ai/v2` (or equivalent) and body matching backend (`lastAddedProductId` or a defined V3 contract).
- Countdown content: actual timer or urgency UI in the countdown div.
- Binding of countdown visibility to config (e.g. countdownEnabled).

### What was partially copied

- Config cache key and “read before mount” idea; implemented but without bundle defaults.
- Single snapshot fetch; implemented for v3 with config-v3 shape.
- SessionStorage write after fetch; implemented in Liquid inline script.

### What was broken during migration

- Recommendation client: new Svelte runtime did not adopt the existing AI v2 URL or body; introduced a non-existent `/recommendations` and `variant_ids` body.
- Stub: intended to fill only when AI is disabled or as fallback; instead it overwrites aiRecommendations every sync, so the AI slot always shows stub (cart items) until the callback runs.
- Countdown: div and prop exist but no logic or content was migrated.

### Quantified

- **Approximate replication:** ~45–55%. Structure (engine, store, mount, shadow DOM, cache key, snapshot) is aligned; config defaults, content gate, recommendation client, and countdown behavior are not.
- **Divergence:** High on recommendations (wrong endpoint + stub overwrite); medium on config bootstrap (no bundle defaults, no content gate); medium on countdown (no content); low on appearance (variables applied correctly when config exists).

---

## 10. Failure map

### Root causes

| # | Root cause | Manifestation |
|---|------------|--------------|
| 1 | Recommendation client calls wrong URL and body | Runtime POSTs to `/recommendations` with `variant_ids`; backend has `/cart/ai/v2` with `lastAddedProductId`. AI recommendations never load correctly; callback returns [] or fails. |
| 2 | Stub overwrites aiRecommendations every sync | buildStubRecommendations (first two cart items) is written to aiRecommendations in syncCart. Same products in cart appear as “recommendations”; real AI result is overwritten until callback (which is wrong anyway). |
| 3 | No countdown content | CheckoutSection countdown div has no child content or timer; countdownVisible is hardcoded true. Urgency timer never shows. |
| 4 | countdownVisible not bound to config | Not tied to config.appearance.countdownEnabled or CSS variable; cannot be turned off by config. |
| 5 | No bundle default config | Engine starts with config null; first paint and any logic before snapshot/cache have no config. No “content gate” that waits for config before showing drawer content. |
| 6 | Snapshot/DB may omit freeShipping or teaseMessage | If DB or merge doesn’t send them, shipping tease and coupon tease stay empty; backend types do include them, so this is data/env-dependent. |
| 7 | Duplicate snapshot v2 and bootstrap v2 | Same implementation in two routes; maintenance burden and confusion. |
| 8 | Deprecated apps/api still in repo | Dead code; can confuse which backend is canonical. |

### Mapping to symptoms

- **Broken UI:** Countdown empty (3, 4); shipping/coupon tease missing when config doesn’t send freeShipping/teaseMessage (6).
- **Broken recommendations:** Wrong URL/body (1); stub overwriting AI slot (2).
- **Duplicate carts:** v1 bootstrap, v2 snapshot/bootstrap, v3 snapshot all exist; v3 is the only one used by the active embed; v1/v2 still available for legacy/archived paths.
- **Duplicate APIs:** Snapshot v2 and bootstrap v2 (7); decision and bootstrap v1 for legacy (intentional).
- **Migration failures:** Recommendations (1, 2); countdown (3, 4); config bootstrap (5).

---

## 11. Recommended source of truth candidate

### Criteria

- **Completeness:** Implements config, cart, shipping, rewards, discounts, recommendations, and analytics.
- **Correctness:** Aligns with cart.txt behavior (cache, config shape, recommendations, content gate, countdown) and with backend contracts.
- **Alignment with cart.txt:** Single config source, cache, theme application, recommendation flow, content gate.

### Recommendation

- **Source of truth for storefront cart:** **cart-pro-v3-runtime** plus **extensions/cart-pro** (cart_pro_embed_v3.liquid and assets), with **cart.snapshot.v3** and **app/lib/config-v3** as the config backend.
- **Rationale:** V3 is the only active embed; it has the intended structure (Engine, stateStore, shadow DOM, snapshot v3, config-v3). It should be fixed in place: (1) point recommendations to the correct endpoint and body (or define a V3 recommendation API and implement it); (2) stop overwriting aiRecommendations with stub, or use stub only when AI is disabled and no result yet; (3) add countdown content and bind countdownVisible to config; (4) optionally add bundle default config and a content gate. v1 and v2 can remain for legacy/archived use but should be documented as such; duplicate snapshot v2 vs bootstrap v2 can be consolidated to one route.

### What to treat as reference

- **cart.txt** (and CART_TXT_ZERO_LATENCY_AUDIT.md) for behavior: config bootstrap, cache, theme timing, content gate, recommendations.
- **config-v3.ts** and **cart.snapshot.v3.ts** for the canonical V3 config shape and merge.
- **state.ts** and **Engine.ts** for the single state and effect flow; fix only the stub overwrite and the recommendation client.

---

*End of forensic analysis. No files were modified.*
