# Cart.txt vs Cart Pro V3 — Near-Zero Latency Architecture Audit

**Scope:** Analysis only. No files modified.  
**Goal:** Document exactly how cart.txt achieves near-zero latency for config, theme, shipping tease, coupon tease, and recommendations so Cart Pro V3 can replicate the same pipeline.

---

## SECTION 1 — Exact config bootstrap method in cart.txt

### Where configuration is first created

- **Lines 2168–2236:** `store_configurations` is created as a **Svelte writable** with a **bundle-embedded default object** (no fetch, no DOM read). This is the first and only creation of the configuration object at module load.
- **Exact declaration:** `var store_configurations = writable({ appearance: { ... }, freeGifts: null, upSell: { enable: false }, discountDisplayConfig: { ... }, orderNotes: { ... }, tieredRewards: { ... } });`

### Where configuration is read from (initialization sequence)

1. **Bundle-embedded defaults**  
   - At parse/load time the store is created with the object literal above. No async; UI can read from the store immediately.

2. **sessionStorage (primary cache for “instant” config)**  
   - **Lines 37156–37170:** Inside the root component’s `onMount`, the **first** thing done is:
     - `const configSavedInCookie = sessionStorage.getItem("kwik-cart-request-data");`
     - If present: `const config = JSON.parse(configSavedInCookie);` then `store_configurations.set(config)` (or merged with `window.customGKCartConfig`).
   - This runs **synchronously** at the start of onMount, **before** any `await`. So on repeat visits (or after first successful fetch), config is available from cache before the UI needs it.

3. **Fetch API (async, after cache check)**  
   - **Lines 37360–37444:** `loadConfigurations()` is defined and called with `await loadConfigurations()` (line 37175).
   - **Lines 7330–7339:** `fetchConfigurations()` does `GET(\`${baseUrl}/v3/kwik-cart/request\`)` with `"x-shop-domain": shopDomain`. On **catch** it returns `sessionStorage.getItem("kwik-cart-request-data") ?? error` (a string or error, not a structured `{ data }` object), so the fetch path does not use sessionStorage as a structured fallback for the same request; cache is for the **next** load.
   - After successful response: `store_configurations.set(newConfig)` or `store_configurations.update((oldObj) => ({ ...oldObj, ...response.data }))`, then **sessionStorage.setItem("kwik-cart-request-data", JSON.stringify(response.data))** (lines 37404–37407). So every successful fetch **writes** the cache for the next page load.

4. **window global**  
   - **Lines 37166–37170, 37390–37400:** If `window.customGKCartConfig` exists, config is merged via `updateConfigurationObject(window.customGKCartConfig, config)` before `store_configurations.set(...)`. So theme/merchant can override with a pre-injected global.

5. **postMessage (dashboard preview only)**  
   - **Lines 6045–6054:** `initDashboardConfigLoader()` listens for `message` from origin containing `"https://dashboard.kwikcart.gokwik.co"` and type `kwik-cart-preview`; then updates store with `JSON.parse(event.data).config`. This is for dashboard preview, not main bootstrap.

### What is NOT used for initial config

- **localStorage:** Used for other things (e.g. `KWIKSESSIONTOKEN` at 5573, cart icon parent at 6434), not for main cart config bootstrap.
- **Inline JSON in DOM / data attribute:** No evidence of config read from a `<script type="application/json">` or `data-config` on an element for the main store.
- **Cookie:** Config is not read from cookies for bootstrap; cookies are used for discount codes and session (e.g. `gk_landing_page`, `discount_code`, `coupon_applied`).

### Exact initialization sequence (code order)

1. **Module load:** Styles injected (lines 9–11), Svelte runtime helpers, then **store_configurations = writable({ ... })** (2168–2236), then all other stores (cart, offers, etc.).
2. **App component init:** `init()` / `create_fragment` run; component mounts to DOM (e.g. shadow root).
3. **onMount runs:**  
   - Read `sessionStorage.getItem("kwik-cart-request-data")`; if present, parse and `store_configurations.set(config)`.  
   - `store_shopDomain.set(window.gk_cart_domain)`.  
   - **await loadConfigurations()** (which awaits fetch, then updates store again and writes sessionStorage).  
   - `setInitialValues()`.  
   - Subscriptions (sideCart, cart, offers, etc.).  
   - Later: `$$invalidate(2, loadSidecart = true)` (line 37255) — drawer content visibility is gated **after** the above async block (including loadConfigurations).

So: **config is first created as bundle defaults; then synchronously hydrated from sessionStorage at start of onMount (if cache exists); then refreshed and theme applied after async fetch in loadConfigurations.**

---

## SECTION 2 — Exact theme application timing

### Where theme is applied

- **Lines 6005–6020:** `setThemeStyles(configs)`:
  - Reads `configs.appearance.themeColor` (fallback `TextConstants.cssConstants.primaryColor` — line 1939: `"#0365d6"`).
  - Reads `configs.appearance.textStyle` and optionally body computed font.
  - Calls:
    - `document.documentElement.style.setProperty("--gokwik-primary-color", themeColor);`
    - `document.documentElement.style.setProperty("--gokwik-font-style", themeFont);`
  - Also sets `--gokwik-text-color` to `"black"` when body color is very light (lines 6010–6014).

### When it is called

- **Line 37442:** `setThemeStyles(response.data)` is called **only** inside `loadConfigurations()`, **after**:
  - `const response = await fetchConfigurations();`
  - Various response.data handling (checkoutFromCart, sideCart, platform, store_configurations update, sessionStorage write, etc.).
- So theme is applied **after** the async config fetch completes, not before UI mount and not from the synchronous sessionStorage hydration path (that path does **not** call setThemeStyles).

### Relative to UI mount

- **Theme is applied after UI mount.**  
  - Mount happens when the Svelte app is attached (e.g. to shadow root).  
  - onMount runs next; sessionStorage may update the config store immediately, but **setThemeStyles** is only invoked later when `loadConfigurations()` resolves.  
- **Synchronous:** The call itself is synchronous (no await after it in that function).  
- **Source of config for theme:** Always **response.data** from the fetch in loadConfigurations (or in practice, the same object that was just written to the store and sessionStorage). Cached config from sessionStorage is **not** passed to setThemeStyles on that same page load.

**Summary:** Theme variables are applied synchronously, but **only after** the async config fetch. First paint can still use previous session’s CSS vars if the document is reused (e.g. SPA); otherwise theme applies after network.

---

## SECTION 3 — Exact store initialization timing

### Stores and defaults

- **store_configurations:** writable with full default object (2168–2236) — **immediate**, no async.
- **store_cart:** writable({}) (2144).
- **store_offerPopup,** **store_offers,** **store_appliedManualDiscount,** **store_appliedAutomaticDiscounts,** **store_sidecartLoader,** etc.: all created with default values in the same block (2143–2294).
- **store_aiProductRecommendations:** writable([]) (2262).
- **store_shopDomain:** writable("") (2237); set in onMount from `window.gk_cart_domain` (37172).

### Hydration from cached config

- **Synchronous:** At the very start of onMount, if `sessionStorage.getItem("kwik-cart-request-data")` is set, `store_configurations.set(config)` runs immediately. So the **config** store is hydrated from cache **synchronously** before any await. Other stores (cart, offers, etc.) are not hydrated from sessionStorage; they get cart/offers from later async calls (getCart, getDiscounts).

### Fetch: blocking vs non-blocking

- **Blocking for “drawer content” visibility:** `loadSidecart = true` (and loadStickyCart) are set only **after** `await loadConfigurations()` (and the rest of the try block, including setInitialValues, subscriptions, addInterceptors, await updateCart, await getDiscounts). So the **visible** sidecart content is intentionally gated on config (and initial cart/discount) being ready.
- **Non-blocking for store defaults:** The app and all stores exist and are readable before fetch; only the **visibility** of the main drawer content waits on the async sequence.

### UI mount vs config

- **UI (component tree) mounts** when the Svelte app is attached (e.g. after window load, target = shadow root).  
- **Config availability:**  
  - From **bundle:** always (defaults).  
  - From **sessionStorage:** at start of onMount, before await.  
  - From **fetch:** after await loadConfigurations().  
- So: **UI mounts before config fetch completes**, but the **drawer content** is not shown until after the async block (including config). Theme is applied after fetch.

---

## SECTION 4 — Exact recommendation loading method

### Where recommendations come from

- **Config (standard upsell):**  
  - **Lines 6474–6502:** Standard upsell variant IDs come from `configResponse.upSell.standard` (e.g. `suggestedUpsellProducts`). That config is from **store_configurations** (either sessionStorage-hydrated or fetch). So standard recommendations are **from config**, available as soon as the config store is set (sync from cache or after fetch).
- **AI recommendations (async):**  
  - **Lines 7341–7369:** `fetchAIProductRecommendations(id, intent, productCount)` does a **POST** to `/v3/kwik-cart/get-product-recommendations` with productId, intent, productCount. On success it sets `store_aiProductRecommendations.set(response.data.recommendedProducts)` and updates variant availability.  
  - **Lines 37214–37216:** This is invoked when cart has items and `$store_configurations.upSell.type === recommendationTypes.AI_POWERED` and there is a last added item: `fetchAIProductRecommendations(lastAddedItem.product_id, ...)`. So AI recommendations are **always async** and triggered after cart + config are available.

### Embedded in config vs fetched

- **Embedded in config:** Standard upsell product/variant lists are part of config (upSell.standard with suggestedUpsellProducts).  
- **Fetched asynchronously:** AI recommendations only; no pre-embedding of AI list in config.  
- **Cached values:** Config (including standard upsell) can be cached in sessionStorage; AI list is not cached in sessionStorage, only in store after fetch.

### Render timing

- **Standard upsell:** Renders as soon as config is in the store (first paint if sessionStorage had cache; otherwise after loadConfigurations).  
- **AI recommendations:** Render after the async fetch returns and `store_aiProductRecommendations` is set.

---

## SECTION 5 — Exact shipping tease loading method

### What was found in cart.txt

- **Line 1868:** Static copy only: `freeShipping: "Yay! Free shipping applied on your order"` in `addressTexts` (used for address/shipping UI text).
- No separate “shipping bar” or “free shipping threshold” component was found in the searched symbols (e.g. shippingBar, freeShippingBar, shippingRemaining, threshold, shippingMessage). So in the audited bundle, **shipping tease** is either:
  - Driven by the same config that contains shipping/address settings (threshold in config, message from addressTexts), or
  - Implemented under different names not captured by the search.

### Conclusion for shipping tease

- **Threshold:** If present, it would be part of the same **config** object (e.g. appearance or a shipping section) returned by the same fetch/sessionStorage path.  
- **Message:** At least the “free shipping applied” string is static in the bundle; any “X more for free shipping” logic would depend on config (threshold) + cart subtotal.  
- **Latency:** No separate async fetch for “shipping tease” was found; any tease would use config (and cart) already loaded via the same bootstrap (sessionStorage or fetch). So it can appear **without an extra network round-trip** once config and cart are available.

---

## SECTION 6 — Exact coupon tease loading method

### Where coupon/discount tease comes from

- **Config:**  
  - **discountDisplayConfig** (2221–2225): `showInputOnly`, `showOfferList`, `enabled`. These control whether the discount/coupon UI and offer list are shown.  
  - **oneClickOffer** (referenced in 37229–37231, 6792–6795): type, code, autoApply, isActive — drives one-click offer and related UI.  
- **Lines 34746–34805, 29295–29358:** UI shows discount/offer list when `$store_configurations.discountDisplayConfig.enabled` and (showInputOnly or showOfferList). So **visibility and structure** of coupon/tease are from **config** (store), not from a separate tease API.

### Tease message

- No literal `teaseMessage` or `discountTease` key was found in the cart.txt search. The “tease” is effectively: show input and/or offer list when config says so; offer **content** comes from **getDiscounts** / **fetchAvailableOffers** (async).  
- **Lines 7001–7027:** `fetchAvailableOffers` is called when `configurations.discountDisplayConfig.showOfferList` is true; it POSTs to `/v3/kwik-cart/valid-offers` and populates offers. So the **list of offers** is async; the **decision to show** the coupon/offer block is from config.

### Immediate vs after async

- **Immediate (from config):** Whether to show coupon section, show input only vs offer list, one-click offer config — all from store_configurations (bundle defaults or sessionStorage or fetch). So tease **visibility** can be immediate if config is already in the store.  
- **After async:** Actual list of available offers comes from fetchAvailableOffers / getDiscounts; one-click application may trigger applyDiscount (async).

---

## SECTION 7 — Exact mount sequence

### Order of operations (cart.txt)

1. **Script load:** Bundle runs; styles injected; Svelte runtime and helpers; **all stores created with default values** (including store_configurations with embedded default object).
2. **App component init:** Root component’s `init()` runs; `create_fragment` creates the fragment.
3. **Mount:** Fragment is mounted to target (e.g. shadow root) — `mount_component(component, options.target, options.anchor)` (1102); **onMount** callbacks are queued/run after mount.
4. **onMount (root):**  
   - **Sync:** Read sessionStorage `"kwik-cart-request-data"`; if present, parse and `store_configurations.set(config)`.  
   - **Sync:** `store_shopDomain.set(window.gk_cart_domain)`.  
   - **Async:** `await loadConfigurations()` → fetch → then store update, sessionStorage write, **setThemeStyles(response.data)**.  
   - **Sync:** `setInitialValues()`.  
   - Subscriptions (sideCartOpen, cart, offers, appliedManualDiscount, etc.).  
   - addInterceptors(...).  
   - **Async:** `await updateCart(...)`, `await getDiscounts()`.  
   - **Sync:** `$$invalidate(2, loadSidecart = true)`, `$$invalidate(3, loadStickyCart = true)`.  
   - Later: loadGoogleFonts(), popstate listener, etc.
5. **User opens cart:** openGokwikSideCart() etc. use the already-loaded config and cart.

So the **exact** order is: **config store created with defaults → (optional) sync hydration from sessionStorage → UI mount → onMount → (optional) sync config from sessionStorage again → await loadConfig → theme applied → setInitialValues and subscriptions → await updateCart / getDiscounts → loadSidecart/loadStickyCart = true.**

---

## SECTION 8 — Exact mechanisms used to achieve near-zero latency

From the code, cart.txt uses:

1. **Bundle-embedded config (defaults)**  
   - store_configurations is initialized with a full default object so no code path reads “config is null”; UI can render immediately with safe defaults.

2. **sessionStorage cache hydration**  
   - At the very start of onMount, config is read from `"kwik-cart-request-data"` and written to the store. So on repeat visits (or after first successful fetch), **config is available synchronously** before any async work, avoiding a loading state for config-driven UI.

3. **Synchronous store initialization**  
   - All stores (config, cart, offers, etc.) are created with default values at module load; no store creation is gated on fetch.

4. **Config hydration before “content” visibility**  
   - The **store** is hydrated from sessionStorage at the start of onMount (sync). The **drawer content** (loadSidecart) is shown only after the full async block (loadConfigurations, updateCart, getDiscounts). So from a “first meaningful paint” perspective, content is delayed until config (and cart/discount) are ready, but the **config store** itself is populated from cache immediately when cache exists.

5. **No pre-injected config JSON in DOM**  
   - No evidence of config read from inline `<script type="application/json">` or data attributes for the main bootstrap.

6. **Theme applied after fetch only**  
   - setThemeStyles is called only in loadConfigurations with response.data; theme is not applied from sessionStorage on the same load. So “zero latency” for theme applies after the first successful fetch (and persists via document.documentElement for the session) or on subsequent loads if the document is reused.

7. **postMessage for dashboard preview**  
   - Optional; used to push config from dashboard, not for main bootstrap.

8. **window global override**  
   - `window.customGKCartConfig` can override/merge config when set; allows host page to inject overrides.

**Summary:** The main “near-zero latency” mechanisms are **bundle-embedded defaults** + **sessionStorage cache hydration at start of onMount** + **synchronous store initialization**. Theme and full “fresh” config still come from the async fetch; the cache makes repeat visits and config-driven UI fast.

---

## SECTION 9 — Direct comparison vs Cart Pro V3

| Aspect | cart.txt | Cart Pro V3 |
|--------|----------|-------------|
| **Config load timing** | (1) Bundle defaults at load. (2) Sync read from sessionStorage at start of onMount. (3) Async fetch in loadConfigurations(); store + sessionStorage updated after. | Config only when host calls `loadConfig(raw)` after **fetch('/apps/cart-pro/snapshot/v3')** in Liquid (cart_pro_embed_v3.liquid). No sessionStorage; no bundle-embedded config object. |
| **Theme application timing** | After async fetch in loadConfigurations (setThemeStyles(response.data)). Not applied from sessionStorage on same load. | After fetch: Liquid script calls `__applyCartProAppearance(config)` then `loadConfig(config)`. Theme and config always after network. |
| **Store initialization timing** | All stores created with defaults at module load; store_configurations has full default object. Optional sync hydration from sessionStorage in onMount. | createStateStore() with createInitialState() (state.ts); no config in state until loadConfig() is called. No sessionStorage for config. |
| **UI mount timing** | App mounts (e.g. to shadow root); drawer **content** gated by loadSidecart = true, which is set only after await loadConfigurations() + updateCart + getDiscounts. | mountCartProV3() runs when script loads; App mounts immediately with engine; no gate on “content” by config — but config is null until fetch completes, so components that depend on getConfig() see null until then. |
| **Recommendations** | Standard: from config (store). AI: async fetch when cart + config available. Config (and thus standard recommendations) can be instant from sessionStorage. | Config (including upsell/recommendations config) only after fetch; no sessionStorage. |
| **Shipping tease** | No separate fetch; threshold/message from same config + cart. Can be instant when config is from cache. | shipping state (remaining, unlocked) in engine state; threshold likely from config — so only available after loadConfig(). |
| **Coupon tease** | Visibility from config (discountDisplayConfig, oneClickOffer); offer list from async getDiscounts/fetchAvailableOffers. Tease visibility can be instant from cached config. | teaseMessage from engine.getConfig()?.discounts?.teaseMessage; empty until loadConfig() runs. No cache. |

**Summary:** Cart Pro V3 currently has **no** sessionStorage config cache, **no** bundle-embedded config, and **no** sync config path. Config and theme always wait on the snapshot fetch. cart.txt gains “near-zero” perceived latency from **defaults + sessionStorage hydration** so that config (and thus theme on next run, recommendations config, coupon/shipping visibility) is often already there when the UI runs.

---

## SECTION 10 — Exact architectural changes required to match cart.txt

To replicate cart.txt’s pipeline in Cart Pro V3:

1. **Bundle-embedded default config**  
   - Define a single **default config object** (appearance, discounts, upsell, shipping, etc.) and initialize the engine (or a config store) with it at module load so that `getConfig()` never returns null for “structure” — only overridden by real config later. UI can rely on safe defaults on first paint.

2. **sessionStorage cache for snapshot**  
   - After a successful snapshot fetch (or equivalent), write the config to sessionStorage under a fixed key (e.g. `cart-pro-v3-snapshot` or similar).  
   - On bootstrap (e.g. in the same place where mount or engine init runs), **before** any async call, read that key; if present, parse and call `loadConfig(parsed)` and `applyAppearanceVariables(host, parsed)` **synchronously**. Then optionally still run the snapshot fetch in the background and merge/update store and sessionStorage on response.

3. **Theme from cached config**  
   - When hydrating from sessionStorage, call the same `applyAppearanceVariables(host, parsed)` (or equivalent) so that theme is correct on first paint when cache exists, not only after fetch.

4. **Config before mount (or before “content” gate)**  
   - Either: (a) run the sessionStorage read and loadConfig/applyAppearance **before** calling mountCartProV3 (e.g. in the Liquid/embed script), or (b) keep mounting the app but have the engine initialized with defaults and then sync-hydrated from sessionStorage at the very start of the root component’s onMount (or equivalent) so that the first reactive cycle already has config. Option (b) mirrors cart.txt’s “onMount first line = sessionStorage read + set store”.

5. **Single snapshot fetch, same cache key**  
   - Use one endpoint (e.g. `/apps/cart-pro/snapshot/v3`) and one sessionStorage key for both “cache read” and “cache write after success”. Ensure the fetch is non-blocking for initial paint when cache exists (i.e. do not block mount or first paint on fetch when cache was already applied).

6. **Shipping and coupon tease from config**  
   - Ensure shipping threshold and tease copy (e.g. teaseMessage) are part of the snapshot config and are applied in loadConfig so that, when config is from cache, shipping tease and coupon tease visibility/copy appear without waiting for fetch.

7. **Recommendations**  
   - Standard/recommendation **config** (which products/variants to show) should be part of the same snapshot and cache so that standard recommendations can render from cached config; AI recommendations can remain async after config/cart are available.

8. **No change to “content” gate if desired**  
   - cart.txt still gates drawer content visibility (loadSidecart) on the full async block (loadConfigurations + updateCart + getDiscounts). If V3 wants the same behavior, keep a similar gate so that the drawer content only shows after config (and optionally cart) are ready; the difference will be that “config ready” can be immediate from sessionStorage.

Implementing the above would align Cart Pro V3 with cart.txt’s config bootstrap, theme timing, store initialization, and first-paint behavior while keeping a single source of truth (snapshot API) and a clear cache-invalidate path (next fetch overwrites sessionStorage).
