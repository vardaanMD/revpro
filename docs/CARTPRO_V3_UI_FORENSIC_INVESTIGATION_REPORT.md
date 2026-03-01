# CartPro V3 Runtime Hydration & UI Rendering — Forensic Investigation Report

**Date:** 2025-02-27  
**Scope:** Full execution chain from theme extension → snapshot fetch → state store → UI rendering.  
**Constraint:** Investigation only; no fixes implemented.

---

## STEP 1 — Runtime Entry

### File
- **Runtime bundle:** `revstack/extensions/cart-pro/assets/cart-pro-v3.js` (minified)
- **Source entry:** `revstack/cart-pro-v3-runtime/src/main.ts` → builds to `cart-pro-v3.js` via Vite (`fileName: 'cart-pro-v3.js'` in `vite.config.ts`)

### Entry and mount chain (from source)
1. **main.ts** — Imports component CSS and invokes mount.
2. **mount.ts** — `mountCartProV3(componentCss)`:
   - `getEngine()` → creates `Engine`, calls `engine.init()`.
   - Sets `window.CartProV3Engine = engine` and `window.__applyCartProAppearance = function(config) { applyAppearanceVariables(host, config); }`.
   - `ensureBodyHost()` — gets or creates host with id `revstack-v3-root`, removes legacy `cart-pro-v3-root` if present.
   - Creates shadow root on host, injects CSS, creates `#cart-pro-v3-app`, bootstraps config from `sessionStorage.getItem('cart-pro-v3-config')` if present (then `engine.loadConfig(parsed)` and `applyAppearanceVariables(host, parsed)`).
   - `new App({ target: appContainer, props: { engine } })` — Svelte root.
3. **Engine** (`engine/Engine.ts`):
   - `constructor`: `this.stateStore = createStateStore()` (from `state.ts`), `createEventBus()`, `createEffectQueue()`, `createCountdown()`.
   - No snapshot fetch inside Engine; config is loaded via `loadConfig(rawConfig)` called from outside (block inline script after fetch).

### Where snapshot is fetched
- **Not in the runtime bundle.** Snapshot is fetched in the **theme extension block** inline script: `revstack/extensions/cart-pro/blocks/cart_pro_embed_v3.liquid`.

### Where snapshot response is stored
- **Not in the runtime.** The block’s inline script calls `applyAppearanceAndLoadConfig(config)` which:
  - Calls `window.__applyCartProAppearance(config)` (applies CSS vars to host).
  - Calls `window.CartProV3Engine.loadConfig(config)`.
  - Writes `config` to `sessionStorage.setItem('cart-pro-v3-config', JSON.stringify(config))`.

### State store implementation
- **File:** `revstack/cart-pro-v3-runtime/src/engine/state.ts`
- **Creation:** `createStateStore()` returns `writable(createInitialState())` (Svelte `writable`).
- **API:** `getState(store)`, `setState(store, partial)`, `updateState(store, updaterFn)`. The store is a Svelte store; it has `subscribe`, `set`, `update` — **no `.get()` method**. Reading current value uses `get(store)` from `svelte/store` or `$store` in Svelte.

### Hydration logic
- **Config hydration:** `loadConfig(rawConfig)` in Engine normalizes via `normalizeConfig(rawConfig)` and sets engine state slices (discount, freeGifts, upsell config, rewards, checkout, analytics). **It does not read or write `rawConfig.recommendations`.**
- **Cart/recommendations hydration:** Happens in `syncCart()` (effect queue): cart from Shopify Cart API, shipping from `config.freeShipping.thresholdCents`, standard recommendations from `computeStandardUpsell(cartRaw, standardConfig)` (rules only), AI recommendations from POST `/apps/cart-pro/ai/v2` or stub when AI disabled.

---

## STEP 2 — Snapshot Fetch and Usage

### Fetch location
- **File:** `revstack/extensions/cart-pro/blocks/cart_pro_embed_v3.liquid`
- **Code:**
```javascript
fetch('/apps/cart-pro/snapshot/v3', { credentials: 'same-origin' })
  .then(function(res) { ... return res.json(); })
  .then(function(config) {
    console.log('[CartPro V3] Snapshot loaded:', config);
    applyAppearanceAndLoadConfig(config);
  })
```

### Response variable
- Variable name: **`config`** (in the `.then` callback). The whole JSON response is passed to `applyAppearanceAndLoadConfig(config)`.

### Full object shape returned by backend (snapshot route)
- **File:** `revstack/app/routes/cart.snapshot.v3.ts`
- **Payload:**
```ts
const snapshotPayload = {
  ...configV3,   // mergeWithDefaultV3(shopConfig.configV3) + featureFlagsFromCapabilities(billing.capabilities)
  recommendations,  // from getHydratedRecommendationsForShop(shop)
};
return Response.json(snapshotPayload, ...);
```
- So the response has all **CartProConfigV3** fields (version, appearance, featureFlags, upsell, rewards, discounts, freeGifts, checkout, analytics, **freeShipping**) **plus** a top-level **`recommendations`** array.

### Where recommendations are read in the runtime
- **They are not.** The runtime never reads `config.recommendations` (or `snapshot.recommendations`).  
- `loadConfig(rawConfig)` only passes `rawConfig` to `normalizeConfig(rawConfig)`.  
- **normalizeConfig** (`normalizeConfig.ts`) only maps fields that exist on **RawCartProConfig** (i.e. **Partial<CartProConfigV3>**). The type **CartProConfigV3** in `configSchema.ts` does **not** include `recommendations`. So `recommendations` is not part of the canonical config type and is never read or written to the state store.

### Answer: What does the runtime read for recommendations?
- **Runtime does NOT read:** `snapshot.recommendations`, `snapshot.upsell.products`, or `snapshot.products`.
- **Runtime uses:**
  - **stateStore.upsell.standard** — populated in **syncCart()** by `computeStandardUpsell(cartRaw, standardConfig)`, where `standardConfig` comes from **config.upsell.standardRules** (rules: `variantId` + `conditionSubtotalCents`). So the runtime uses **rules**, not a pre-built product list.
  - **stateStore.upsell.aiRecommendations** — from AI API callback or, when AI is disabled, from **buildStubRecommendations(cart)** (stub built from current cart items).

**Exact code (Engine.ts loadConfig, lines 210–260):** Only sets state from normalized config; no reference to `recommendations`:
```ts
loadConfig(rawConfig: RawCartProConfig): void {
  const normalized = normalizeConfig(rawConfig);
  this.config = Object.freeze(normalized);
  const c = this.config;
  this.setState({
    discount: { ... },
    freeGifts: { ... },
    upsell: { standardConfig: c.upsell.standardRules.map(...), aiEnabled: c.upsell.aiEnabled, oneTick: ... },
    rewards: { ... },
    checkout: { ... },
    analytics: { ... },
  });
}
```

---

## STEP 3 — Recommendation Rendering Path

### Component responsible for recommendation cards
- **File:** `revstack/cart-pro-v3-runtime/src/ui/v2/Recommendations.svelte`
- **Child:** `RecommendationCard.svelte` (`revstack/cart-pro-v3-runtime/src/ui/v2/RecommendationCard.svelte`)

### Data source for the component
- **Recommendations.svelte:**
  - `state = $stateStore`
  - `recommendations = state?.upsell?.standard ?? []`  → **stateStore.upsell.standard**
  - `aiRecommendations = state?.upsell?.aiRecommendations ?? []`  → **stateStore.upsell.aiRecommendations**
  - Combined list:  
    `recs = [...recommendations.map((r) => ({ ...r, variantId: r.variantId })), ...aiRecommendations.map((r) => ({ variantId: r.variantId, title: `Variant #${r.variantId}` }))]`
  - So **standard** items are passed through with only **variantId** (and **conditionSubtotalCents** from `StandardUpsellRule`). **AI** items get **variantId** and a hardcoded title **`Variant #${r.variantId}`**.

### Trace: snapshot → state store → UI → DOM
1. **Snapshot** returns `recommendations` (hydrated products: id, title, image, price, handle; see buildSnapshot). **This array is never written to the state store.**
2. **State store.upsell.standard** is set only in **syncCart()** to the result of **computeStandardUpsell(cartRaw, standardConfig)**. That returns **StandardUpsellRule[]**: `{ variantId, conditionSubtotalCents }` — no title, image, price, or handle.
3. **Recommendations.svelte** reads `state.upsell.standard` and `state.upsell.aiRecommendations` and builds `recs`.
4. **RecommendationCard.svelte** receives `rec` and uses:
   - `rec.imageUrl` (img src)
   - `rec.title` (link text and alt)
   - `rec.price` (passed to `formatCurrency(rec.price)` which expects `price.amount`)

### Expected vs actual structure
- **RecommendationCard expects (from JSDoc and usage):**  
  `{ variantId, title?, imageUrl?, handle?, price?: { amount?: number; compare_at_amount?: number } }`
- **stateStore.upsell.standard (StandardUpsellRule):**  
  `{ variantId, conditionSubtotalCents }` only → **no title, imageUrl, or price.** So cards show blank/broken image and no real title/price.
- **stateStore.upsell.aiRecommendations:**  
  In state they are `Array<{ variantId: number }>`. In Recommendations.svelte they are mapped to `{ variantId, title: 'Variant #${r.variantId}' }` → so the UI shows **“Variant #&lt;id&gt;”** and still no image or price.

### Mismatch summary
- **Backend** sends a **pre-built `recommendations`** array with full product data (id, title, image, price, handle) from **getHydratedRecommendationsForShop**.
- **Runtime** never reads that array; it only uses **upsell.standard** (from rule-based computation) and **upsell.aiRecommendations** (from AI or stub), both of which lack the fields the card component expects.
- So the UI is fed **rules/variant IDs** instead of **hydrated product data**, leading to variant IDs or blank/muted cards.

---

## STEP 4 — State Store (CartProV3Engine.stateStore)

### Implementation file
- **File:** `revstack/cart-pro-v3-runtime/src/engine/state.ts`

### Methods / API
- **createStateStore():** returns `writable(createInitialState())` (Svelte `Writable<EngineState>`).
- **getState(store):** returns current value via `get(store)` from `svelte/store`.
- **setState(store, partial):** `store.update(s => merge(s, partial))`.
- **updateState(store, updaterFn):** `store.update(s => merge(s, updaterFn(s)))`.
- The store object itself has **subscribe**, **set**, **update** only — **no `.get()` method**.

### How snapshot data enters the state store
- Snapshot is passed to **loadConfig(rawConfig)**. Only the **normalized config** (no `recommendations`) is used to set state slices: discount, freeGifts, upsell (standardConfig, aiEnabled, oneTick), rewards, checkout, analytics. **Recommendations array from snapshot is never written to the store.**
- Cart/shipping/upsell **result** state is updated later in **syncCart()** (cart from API, shipping from config threshold, standard from computeStandardUpsell, aiRecommendations from AI or stub).

### Are recommendations stored correctly?
- **Snapshot recommendations:** Not stored at all; the runtime does not persist them.
- **Standard recommendations:** Stored as **StandardUpsellRule[]** (variantId + conditionSubtotalCents) in **stateStore.upsell.standard** — correct for the current design but insufficient for the card UI which expects full product data.
- **AI recommendations:** Stored as **{ variantId }[]** in **stateStore.upsell.aiRecommendations** — again no title/image/price, so the UI falls back to “Variant #ID”.

### State store schema vs snapshot schema
- **State store schema (EngineState):** Includes `upsell: { standardConfig, standard, oneTick, aiEnabled, aiRecommendations, loading, cache }`. No top-level “recommendations” array.
- **Snapshot schema:** CartProConfigV3 plus **recommendations** (array of hydrated products). The runtime’s config schema (RawCartProConfig / NormalizedEngineConfig) does **not** include `recommendations`, so that part of the snapshot is ignored.

### Why CartProV3Engine.stateStore.get() was not a function
- **stateStore** is a Svelte **writable** store. Its API is **subscribe**, **set**, **update**. Svelte stores do not have a **.get()** method. To read the value you must use **get(store)** from `svelte/store` or the **$store** reactive syntax in Svelte. So calling **stateStore.get()** correctly throws “get is not a function”.

---

## STEP 5 — Theme Extension Block

### File
- **File:** `revstack/extensions/cart-pro/blocks/cart_pro_embed_v3.liquid`

### Script tag and JS file
- `<script src="{{ 'cart-pro-v3.js' | asset_url }}" defer></script>`  
- Loads **cart-pro-v3.js** from the extension’s **assets** (Shopify theme app extension asset: `extensions/cart-pro/assets/cart-pro-v3.js`).

### Initialization parameters
- No props passed to the script. The script:
  1. Fetches `/apps/cart-pro/snapshot/v3` (app proxy; no query params in the snippet; shop may be inferred by Shopify from the storefront request).
  2. On success, calls `applyAppearanceAndLoadConfig(config)` which calls `window.__applyCartProAppearance(config)` and `window.CartProV3Engine.loadConfig(config)`.
- The block does **not** pass shop domain explicitly; the app proxy request is same-origin so the backend obtains shop from the request (e.g. `request.url` or Shopify’s app proxy headers).

### Does the runtime receive shop domain?
- The runtime does **not** receive the shop domain as an explicit parameter. The snapshot is fetched by the **page** (same-origin to the storefront); the backend resolves shop from the app proxy request. The runtime only receives the **config** object (and optional cached config from sessionStorage). So for **config and recommendations**, the runtime does not need the shop; it only needs the snapshot payload. If the app proxy or backend did not receive the correct shop, that would be a backend/proxy issue, not the block script.

---

## STEP 6 — Correct Runtime Version Loaded

### Confirmation
- The block loads **only** `cart-pro-v3.js`:  
  `{{ 'cart-pro-v3.js' | asset_url }}`  
  There are no script tags for `cart-pro.js`, `cart-v2.js`, or archived runtimes in **cart_pro_embed_v3.liquid**.

### How the extension resolves the asset path
- **Shopify theme app extension:** Files under `extensions/cart-pro/assets/` are available as assets. The Liquid filter **asset_url** with filename `'cart-pro-v3.js'` resolves to the URL of that asset in the extension (e.g. CDN path for the app’s extension assets). So the browser loads **cart-pro-v3.js** from the Cart Pro extension assets. The built file is produced by the cart-pro-v3-runtime Vite build and should be placed (or linked) at `extensions/cart-pro/assets/cart-pro-v3.js`. If the project copies the build output there, the correct runtime is served.

### Cache
- If an older bundle is cached (browser or CDN), the storefront could run an outdated build. The report assumes the deployed asset is the current V3 bundle; caching is not inspected here.

---

## STEP 7 — Runtime Expected Schema vs Actual Snapshot Schema

| Aspect | Runtime expects (from config + state) | Actual snapshot provides |
|--------|--------------------------------------|---------------------------|
| **Config** | RawCartProConfig (Partial<CartProConfigV3>): version, appearance, featureFlags, upsell (standardRules, ai), rewards, discounts, freeGifts, checkout, analytics, **freeShipping** | configV3 spread + **recommendations** array. freeShipping, appearance, discounts (e.g. teaseMessage), etc. present. |
| **Recommendations** | Runtime does **not** read any “recommendations” key. It fills **upsell.standard** from **computeStandardUpsell(cart, config.upsell.standardRules)** and **upsell.aiRecommendations** from AI/stub. | **recommendations**: array of `{ id, title, image, price, compareAtPrice, handle }` (from getHydratedRecommendationsForShop). **Not** in CartProConfigV3 type; **never read** by runtime. |
| **freeShipping** | normalizeConfig: **freeShipping.thresholdCents**. Used in syncCart for shipping tease. | mergeWithDefaultV3: **freeShipping.thresholdCents**. Present in payload. |
| **discounts.teaseMessage** | normalizeConfig: **discounts.teaseMessage**. CouponSection uses engine.getConfig().discounts.teaseMessage. | mergeWithDefaultV3: **discounts.teaseMessage**. Present if set in shop config. |
| **appearance** | normalizeConfig: **appearance** (primaryColor, accentColor, borderRadius, countdownEnabled, countdownDurationMs, etc.). Applied via __applyCartProAppearance. | configV3.appearance. Present. |

**Mismatches:**
1. **recommendations** is provided by the snapshot but **not** in the runtime config type and **never** read or written to state; the runtime uses rule-based and AI/stub data only.
2. **Backend HydratedRecommendation** shape: `id, title, image, price, compareAtPrice, handle` — and **no variantId**. So even if the runtime were to use this array, add-to-cart would need variantId (RecommendationCard calls `engine.addToCart(rec.variantId, 1)`). So the snapshot recommendation shape is also missing **variantId** for the current card design.

---

## STEP 8 — Appearance Config Usage

### Where consumed
- **mount.ts:** `applyAppearanceVariables(host, config)` reads `config?.appearance` and sets on the **host** (id `revstack-v3-root`) CSS custom properties: `--cp-primary`, `--cp-accent`, `--cp-radius`, `--cp-confetti-enabled`, `--cp-countdown-enabled`, `--cp-emoji-enabled`, `--cp-bg`, `--cp-surface`, `--cp-text`, `--cp-border`, `--cp-shadow`, `--cp-primary-hover`, `--cp-primary-active`, `--cp-accent-hover`, `--cp-gradient`.
- **Liquid:** After snapshot load, `window.__applyCartProAppearance(config)` is called, which in the built bundle calls the same logic (host = `document.getElementById('revstack-v3-root')`).
- **Engine:** `getConfig()` returns normalized config; **CheckoutSection**, **CouponSection**, **DrawerV2** use `engine.getConfig()?.appearance` (e.g. countdownEnabled) and `engine.getConfig()?.discounts?.teaseMessage`.

### Why colors might be muted or missing
1. **Host not found:** If `__applyCartProAppearance` runs before the mount has created the host, or if the host id is wrong, `document.getElementById('revstack-v3-root')` can be null and no variables are set. The block creates `cart-pro-v3-root`; the mount replaces it and creates `revstack-v3-root`. If the snapshot response arrives **before** the deferred script runs, the order is: (1) fetch completes, (2) applyAppearanceAndLoadConfig(config) runs, (3) `__applyCartProAppearance` may run before `CartProV3Engine` and mount exist — then it retries with setTimeout(50). So there is a race: appearance is applied when both `__applyCartProAppearance` and `CartProV3Engine` exist; if the host does not exist yet, appearance would not be applied until a later call (e.g. from cache on next open).  
2. **Defaults:** If snapshot or cache has no/missing appearance, normalizeConfig uses defaults (e.g. primaryColor `#333`, accentColor `#16a34a`). So “muted” could be default colors.  
3. **Shadow DOM:** Variables are set on the **host**; they cascade into the shadow root. If the host is not the one that actually wraps the shadow tree (e.g. wrong element or duplicate roots), colors would not apply to the drawer.

---

## STEP 9 — Timer, Coupon Tease, Shipping Bar

### Timer (countdown)
- **Component:** `CheckoutSection.svelte` — div `#cart-pro-countdown`, visibility: `style="display: {showCountdown && countdownVisible ? '' : 'none'};"`.
- **Data:** `showCountdown = countdownEnabled && countdownState.running && countdownState.remainingMs > 0`, where `countdownEnabled = engine.getConfig()?.appearance?.countdownEnabled`, and `countdownState` from `engine.countdown.store` (Svelte store).
- **Start:** `engine.onDrawerOpened()` (from themeConnector when opening drawer, and from App.svelte openDrawer) → Engine starts countdown if `config.appearance.countdownEnabled` and sets duration from `config.appearance.countdownDurationMs` or default. Countdown is also started/updated in **syncCart()** when cart signature changes.
- **Why it might not render:** (1) `countdownEnabled` false in config (e.g. not set or default false in snapshot). (2) Countdown not started because `onDrawerOpened` is not called when opening (e.g. drawer opened by other means). (3) `countdownVisible` is false — DrawerV2 sets `countdownVisible = engine?.getConfig?.()?.appearance?.countdownEnabled === true`, so if config is default or missing, it can be false.

### Coupon tease
- **Component:** `CouponSection.svelte` — `teaseMessage = engine?.getConfig?.()?.discounts?.teaseMessage ?? ''`. Rendered when `applied.length === 0 && teaseMessage`.
- **Data:** From normalized config **discounts.teaseMessage** (normalizeConfig from raw.discounts.teaseMessage).
- **Why it might not render:** If the snapshot’s config has no or empty **discounts.teaseMessage** (e.g. merchant never set it, or mergeWithDefaultV3 keeps default ""), teaseMessage stays empty and the tease block is not shown.

### Shipping bar
- **Component:** `ShippingSection.svelte` — reads `$stateStore?.shipping` (remaining, unlocked, loading). **DrawerV2** builds `shippingMsg` from `shipping` and passes it to CheckoutSection as `freeShippingMsg`.
- **Data:** **stateStore.shipping** is set in **syncCart()** from **config.freeShipping.thresholdCents**: if threshold is set, remaining/unlocked are computed from cart subtotal; otherwise remaining is null.
- **Why it might not render:** (1) **config.freeShipping.thresholdCents** is null or missing in snapshot (e.g. not set in shop config), so shipping bar has nothing to show. (2) Cart not synced yet (loading state). (3) CSS/visibility: the section might be hidden or not visible in the layout.

---

## STEP 10 — Final Root Cause Report

### SECTION A — Snapshot data correctness
- **Backend** returns a valid payload: configV3 (with appearance, freeShipping, discounts, featureFlags, etc.) plus **recommendations** from **getHydratedRecommendationsForShop**.
- **Recommendations shape** from backend: `{ id, title, image, price, compareAtPrice, handle }` — **no variantId**, so add-to-cart would be broken even if the runtime used this array.
- **freeShipping**, **discounts.teaseMessage**, **appearance** are present when set in shop config and after mergeWithDefaultV3.

### SECTION B — Runtime fetch and hydration
- Snapshot is **fetched** in the **Liquid block** (not in the JS bundle). Response is passed to **applyAppearanceAndLoadConfig(config)** which calls **loadConfig(config)** on the engine.
- **loadConfig** only uses **normalizeConfig(rawConfig)** and never reads **config.recommendations**. So the **recommendations** array is **never** hydrated into the runtime.

### SECTION C — State store correctness
- State store is a Svelte writable; no `.get()` (use `get(store)` or `$store`). Snapshot data that is read (config) is correctly merged into state slices via **loadConfig**. The **recommendations** array is not part of the config type and is never written to the store.

### SECTION D — Recommendation hydration mismatch
- **Root cause:** The runtime does **not** use the snapshot’s **recommendations** array. It only populates **upsell.standard** from **computeStandardUpsell** (rules: variantId + conditionSubtotalCents) and **upsell.aiRecommendations** (variantId only or stub). The UI (RecommendationCard) expects **variantId, title, imageUrl, price** (and optionally handle). So cards receive only variantId (and for AI a fallback title “Variant #ID”), leading to **variant IDs or blank/muted cards**.

### SECTION E — UI rendering mismatches
- **Recommendation cards:** Fed with **StandardUpsellRule** or **{ variantId }**; missing title, imageUrl, price → broken/empty appearance and “Variant #ID” for AI.
- **Colors:** Possible race (appearance applied before host exists) or default palette; host must be `revstack-v3-root` and variables must cascade into shadow DOM.
- **Timer:** Depends on **countdownEnabled** and countdown store; if config defaults or onDrawerOpened/countdown start logic is not triggered, timer stays hidden.
- **Coupon tease:** Depends on **discounts.teaseMessage**; empty in config → no tease.
- **Shipping bar:** Depends on **freeShipping.thresholdCents** and **syncCart**; null threshold or no sync → no “add X more” message.

### SECTION F — Exact root cause(s)
1. **Recommendations:** Snapshot **recommendations** are never read or written to state. The UI is driven by **stateStore.upsell.standard** (rule-based) and **stateStore.upsell.aiRecommendations** (AI/stub), which do not carry the product fields the card expects. **Primary root cause:** runtime ignores snapshot.recommendations and uses only rule/AI data that lacks title, image, price.
2. **Backend recommendation shape:** **HydratedRecommendation** omits **variantId**, which RecommendationCard needs for add-to-cart.
3. **Timer/coupon/shipping:** Depend on config (countdownEnabled, teaseMessage, freeShipping.thresholdCents) and correct load order; missing or default config or race conditions can leave them not rendering.

### SECTION G — Exact minimal fixes required (DO NOT IMPLEMENT)
1. **Use snapshot recommendations in the runtime:** In **loadConfig** (or a dedicated hydration step), if `rawConfig.recommendations` is an array, map it to a shape the UI expects (variantId, title, imageUrl, price, handle) and set it into state — e.g. a new state slice such as **upsell.snapshotRecommendations** or replace/augment **upsell.standard** when snapshot recommendations exist. Ensure backend includes **variantId** in each recommendation (getHydratedRecommendationsForShop should return variantId; Product has it).
2. **Backend:** Add **variantId** to the return of **getHydratedRecommendationsForShop** (and to **HydratedRecommendation** type). Optionally align key names with the card (e.g. **image** → **imageUrl**, **price** (number) → **price.amount**) or map in the runtime when hydrating.
3. **Recommendations.svelte:** When snapshot recommendations are available, use them (with the above shape) for the main list instead of or in addition to rule-based standard; pass objects that include **title**, **imageUrl**, **price** (e.g. `{ amount }`) so RecommendationCard can render and add-to-cart can use **variantId**.
4. **Appearance:** Ensure **__applyCartProAppearance** runs after the host element exists (e.g. call it from mount after ensureBodyHost, and/or have the block retry until host is present). Optionally re-apply appearance when snapshot loads if it was previously applied with defaults.
5. **Timer/coupon/shipping:** Ensure snapshot and mergeWithDefaultV3 provide **countdownEnabled**/countdownDurationMs, **discounts.teaseMessage**, and **freeShipping.thresholdCents** for the merchant’s chosen experience; no code change needed if config is correct. If defaults are too conservative, adjust DEFAULT_CONFIG_V3 or merge logic so these features are visible when intended.

---

**End of report.** No code was modified; evidence is from the listed files and call chains above.
