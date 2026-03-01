# Cart Pro V3 — Full Forensic Architectural Audit (cart.txt parity)

**Scope:** Analysis only. No files modified. No speculative fixes.  
**Method:** Trace of actual execution paths and code references.

---

## CONFIG FLOW

### Step-by-step execution order

1. **main.ts**  
   - Imports `mountCartProV3` from `./mount`, imports `./styles/cart-pro-v2.css`, imports `virtual:cart-pro-v3-component-css`, then calls `mountCartProV3(componentStyles ?? '')`.  
   - **Config is not created or loaded in main.ts.**

2. **mount.ts — mountCartProV3(componentCss)**  
   - Calls `getEngine()` → `new Engine()` → `engine.init()` (no `loadConfig` in init).  
   - `ensureBodyHost()` creates/gets host `#revstack-v3-root` (and removes legacy `#cart-pro-v3-root`).  
   - `window.__applyCartProAppearance` and `window.CartProV3Engine` are set.  
   - Shadow root created; component CSS injected into shadow root.  
   - **Cache read (lines 168–177):** `sessionStorage.getItem(CONFIG_CACHE_KEY)` (`'cart-pro-v3-config'`). If present: `applyAppearanceVariables(host, parsed)` then `engine.loadConfig(parsed)`.  
   - Then `new App({ target: appContainer, props: { engine } })` mounts.  
   - So: **config is first applied from cache (if any) here, before App mount.** If no cache, engine has `this.config === null` until snapshot returns.

3. **cart_pro_embed_v3.liquid**  
   - Renders `<div id="cart-pro-v3-root">`, loads `cart-pro-v3.js` (defer).  
   - Inline script runs after script load: `fetch('/apps/cart-pro/snapshot/v3', { credentials: 'same-origin' })` → on success calls `applyAppearanceAndLoadConfig(config)` which:  
     - Calls `window.__applyCartProAppearance(config)` (applies CSS vars on host).  
     - Calls `window.CartProV3Engine.loadConfig(config)`.  
     - `sessionStorage.setItem('cart-pro-v3-config', JSON.stringify(config))`.  
   - If `__applyCartProAppearance` or `CartProV3Engine` are missing, retries with `setTimeout(..., 50)`.  
   - **Snapshot runs in parallel with / after mount;** it can complete before or after the first syncCart (see STATE FLOW). When it completes, it overwrites/corrects config and cache.

4. **Engine.loadConfig(rawConfig)** (Engine.ts 191–244)  
   - `normalized = normalizeConfig(rawConfig)`; `this.config = Object.freeze(normalized)`.  
   - `setState` for discount, freeGifts, upsell, rewards, checkout, analytics.  
   - **Does not set `shipping` in state;** shipping is only updated inside `syncCart()` from `this.config?.freeShipping?.thresholdCents`.

5. **normalizeConfig** (normalizeConfig.ts)  
   - Builds full `NormalizedEngineConfig` including `freeShipping: normalizeFreeShipping(raw)` (line 236).  
   - **normalizeFreeShipping** (lines 181–185): `raw.freeShipping?.thresholdCents`; if valid number ≥ 0 then `thresholdCents`, else `null`. **Does not remove freeShipping;** it maps it. If snapshot never sends `freeShipping`, `raw.freeShipping` is undefined → `thresholdCents: null`.  
   - **normalizeDiscounts** (lines 57–65): preserves `teaseMessage` from `raw.discounts?.teaseMessage`. If snapshot doesn’t send it, it stays undefined.

6. **configSchema.ts (runtime)**  
   - `CartProConfigV3` includes `freeShipping?: CartProConfigV3FreeShipping`; `ConfigDiscounts` includes `teaseMessage?: string`. Runtime is prepared for these fields.

7. **configCache.ts / defaultConfig.ts**  
   - **Do not exist in the repo.** Cache is implemented only via `sessionStorage` in mount.ts (read) and in the Liquid inline script (write). There is no separate config cache module or DEFAULT_CONFIG used at engine init.

### Answers (config pipeline)

- **Where config is first created:** In practice, first meaningful config is either (a) parsed from `sessionStorage` in `mountCartProV3` (if cache exists) and passed to `engine.loadConfig(parsed)`, or (b) the snapshot response passed to `loadConfig(config)` from the Liquid callback.  
- **DEFAULT_CONFIG:** No `defaultConfig.ts`; no bundle-embedded default config object used to initialize the engine. Engine starts with `this.config = null`.  
- **Cached config:** Yes. In mount.ts, cached config is loaded from `sessionStorage` (key `'cart-pro-v3-config'`) **before** App mount and applied with `applyAppearanceVariables(host, parsed)` and `engine.loadConfig(parsed)`.  
- **Snapshot overwriting cache:** Yes. When the snapshot fetch resolves, the Liquid script calls `loadConfig(config)` and `sessionStorage.setItem('cart-pro-v3-config', ...)`, so snapshot overwrites both engine config and cache.  
- **normalizeConfig and freeShipping:** normalizeConfig does **not** remove `freeShipping`; it maps it via `normalizeFreeShipping(raw)`. If `raw.freeShipping` or `raw.freeShipping.thresholdCents` is missing, result is `{ thresholdCents: null }`.  
- **config.freeShipping at runtime:** It exists on `NormalizedEngineConfig` after loadConfig. It is `undefined` at runtime only if the **snapshot/backend never sends** `freeShipping` (see SNAPSHOT FLOW). The backend `CartProConfigV3` type does not include `freeShipping`, so the snapshot response does not include it unless the DB/storage adds it outside the typed merge.

---

## STATE FLOW

### createStateStore / createInitialState (state.ts)

- **createInitialState()** (lines 171–249): Returns full `EngineState` including `shipping: { remaining: null, unlocked: false, loading: true }`.  
- **createStateStore()** (255–257): `writable(createInitialState())`.  
- **setState / updateState** (262–309): Both handle `partial.shipping` and merge into `next.shipping`.

### Engine constructor and init (Engine.ts)

- **constructor** (112–116): `this.stateStore = createStateStore()`, eventBus, effectQueue. No loadConfig.  
- **init()** (122–140): Sets `app.status`, `runtime.initializedAt`, `analytics.sessionId`, sets up interceptor, subscribes to `cart:external-update` → enqueueEffect(syncCart), setupCheckoutPostMessage, then `app.status: 'READY'`. **Does not call syncCart or loadConfig.**

### Engine.loadConfig (Engine.ts 191–244)

- Sets `this.config` and updates state for discount, freeGifts, upsell, rewards, checkout, analytics. **Does not set `shipping`.** So shipping slice stays at initial state until syncCart runs.

### Engine.syncCart (Engine.ts 600–538)

- After cart fetch and cart state update (lines 437–447), **shipping** is updated (lines 449–478):  
  - Sets `shipping.loading: true`, then reads `threshold = this.config?.freeShipping?.thresholdCents ?? null`.  
  - If `threshold != null`: sets `remaining`, `unlocked`, `loading: false`.  
  - Else: sets `remaining: null`, `unlocked: false`, `loading: false`.  
- So **shipping.remaining is set only when `this.config?.freeShipping?.thresholdCents` is a number.** If config is null or snapshot doesn’t send freeShipping, threshold is null → remaining stays null, loading is cleared to false.  
- **Upsell:** Lines 481–493 compute `standard = computeStandardUpsell(raw, standardConfig)` and set `upsell.standard`. Then if aiEnabled, AI path may set `aiRecommendations` and `loading`.  
- **Lines 523–533:** Unconditionally after that, `stubRecs = buildStubRecommendations(raw)` and **setState** `upsell: { ... standard: stubRecs, aiRecommendations: [], loading: false }`. So **stub overwrites `standard` and AI recommendations every sync.**

### When syncCart runs

- **App.svelte onMount** (lines 8–12): `engine.enqueueEffect(async () => { await engine.syncCart(); })`. So first sync runs asynchronously after mount (effect queue).  
- **cart:external-update:** Engine subscribes in init; handler enqueues syncCart. So sync also runs when interceptor detects external cart change.

### Exact lines where stateStore is modified (shipping / upsell)

- **state.ts 246–248:** Initial `shipping: { remaining: null, unlocked: false, loading: true }`.  
- **Engine.ts 451–454:** `setState({ shipping: { ...getStateFromStore(this.stateStore).shipping, loading: true } })`.  
- **Engine.ts 458–465 or 468–477:** `setState({ shipping: { remaining, unlocked, loading: false } })` or `{ remaining: null, unlocked: false, loading: false }`.  
- **Engine.ts 491–496:** `setState({ upsell: { ...stateAfterSync.upsell, standard } })`.  
- **Engine.ts 523–533:** `setState({ upsell: { ... standard: stubRecs, aiRecommendations: [], loading: false } })`.

### recommendationsStub

- **buildStubRecommendations** (recommendationsStub.ts 15–27): Takes `cart.items`, does `cart.items.slice(0, 2).map(...)` and returns those items as “recommendations.” **It does not filter out items already in cart;** it **is** the first two cart items. So the stub is fundamentally “show first 2 cart items as recs,” which is why the same product already in cart appears as a recommendation.

### Answers (state)

- **Shipping slice:** Exists in stateStore; initial `remaining: null`, `unlocked: false`, `loading: true`.  
- **shipping.remaining:** Set only in syncCart when `this.config?.freeShipping?.thresholdCents` is a number; otherwise set to null and loading set to false.  
- **shipping.loading:** Set true at start of shipping block in syncCart; then set false in same sync (either with remaining/unlocked or with null/false). So it is cleared in the same sync. If syncCart never runs, it stays true.  
- **upsell.standard:** Computed from `computeStandardUpsell` then **overwritten** by `buildStubRecommendations(raw)` in the same sync (Engine.ts 523–533). So standard rules and AI are always replaced by stub (first 2 cart items).  
- **recommendationsStub:** Runs on every sync and replaces upsell.standard with cart items; it does not filter out in-cart variants.

---

## UI RENDER FLOW

### App.svelte

- Binds `stateStore = engine.stateStore`.  
- onMount enqueues `engine.syncCart()`.  
- Renders Open button and `<DrawerV2 {engine} on:close={closeDrawer} />`.

### DrawerV2.svelte

- **Reactive state (lines 15–25):**  
  - `cart`, `discount`, `rewards`, `upsell`, `checkout`, `shipping` from `$stateStore` with fallbacks.  
  - `shipping` fallback: `{ remaining: null, unlocked: false }` — **does not include `loading`**, so if store has `loading: true`, it’s still read from store.  
- **shippingMsg (27–31):** Derived from `shipping?.unlocked`, `shipping?.remaining`, `items?.length`. Used as `freeShippingMsg` for CheckoutSection.  
- **CheckoutSection** (102–114): Receives `countdownVisible={true}` (hardcoded), `shippingLoading={false}` (hardcoded), `freeShippingMsg={shippingMsg}`, `savingsMsg={savingsMsg}`.  
- **CouponSection** (101): Receives `applied`, `validating`, `lastError` from discount state.  
- **Recommendations** (99): Only receives `engine`.  
- **ShippingSection** is not directly in DrawerV2; it is inside CheckoutSection.

### ShippingSection.svelte

- **State (line 9):** `shipping = $stateStore?.shipping ?? { remaining: null, unlocked: false, loading: true }`.  
- **Render:**  
  - If `shipping.loading`: skeleton.  
  - Else if `shipping.unlocked`: “Free shipping unlocked”.  
  - Else if `shipping.remaining != null && shipping.remaining > 0`: “Add {formatCurrency(shipping.remaining)} more for free shipping”.  
  - Otherwise: no branch matches → **nothing rendered.** So when `loading: false`, `unlocked: false`, `remaining: null` (no threshold from config), the section is effectively empty (no tease message).

### CouponSection.svelte

- **teaseMessage (line 12):** `engine?.getConfig?.()?.discounts?.teaseMessage ?? ''`.  
- **Render (lines 26–28):** `{#if applied.length === 0 && teaseMessage}` show tease div. So coupon tease only shows when no codes applied and config has `discounts.teaseMessage`. If snapshot doesn’t send `teaseMessage` (backend type doesn’t include it), getConfig() has no teaseMessage → tease never shows.

### Recommendations.svelte

- **State:** `recommendations = state?.upsell?.standard ?? []`, `aiRecommendations = state?.upsell?.aiRecommendations ?? []`, `recs` = concatenation of both.  
- Because Engine always overwrites `upsell.standard` with stub (and clears aiRecommendations), UI shows exactly the stub list (first 2 cart items). No filtering by “not in cart” in the component; the data itself is wrong (stub returns in-cart items).

### RecommendationCard.svelte

- Receives `rec` (variantId, title, imageUrl, price, etc.). Renders and calls `engine.addToCart(rec.variantId, 1)`. No filtering here; it displays whatever is in `recs`.

### CheckoutSection.svelte

- Imports and renders `<ShippingSection {engine} {currency} />` (line 53).  
- **countdownVisible** is a prop (default true); **DrawerV2 passes countdownVisible={true}** (line 111). There is no binding to `config.appearance.countdownEnabled` or `--cp-countdown-enabled`.  
- **Urgency timer:** The countdown div is `#cart-pro-countdown.cp-countdown` with `style="display: {countdownVisible ? '' : 'none'};"` and **no child content** — no timer logic, no expiry, no text. So the urgency timer never “renders” meaningful content; the div can be visible but empty.

### Answers (UI)

- **State read:** DrawerV2 reads cart, discount, rewards, upsell, checkout, shipping from stateStore; ShippingSection reads shipping; CouponSection reads applied/validating/lastError from props and teaseMessage from engine.getConfig(); Recommendations read upsell.standard and upsell.aiRecommendations.  
- **stateStore.shipping:** Used in DrawerV2 for shippingMsg and in ShippingSection. When threshold is null, shipping.remaining is null and no “add X more” message is shown; when loading is true, ShippingSection shows skeleton.  
- **teaseMessage:** Read in CouponSection from `engine.getConfig()?.discounts?.teaseMessage`; if snapshot/backend doesn’t provide it, it’s empty.  
- **countdownEnabled:** Set as CSS variable `--cp-countdown-enabled` in mount.ts applyAppearanceVariables; **not** used to set CheckoutSection’s countdownVisible. Countdown div is shown by hardcoded `countdownVisible={true}` and has no content.  
- **upsell.standard:** Not filtered in UI; it is overwritten by stub in Engine, so UI shows stub (same products as in cart).

---

## RECOMMENDATION FLOW

### recommendationsStub.ts

- **buildStubRecommendations(cart):** If `!cart?.items?.length` return `[]`. Otherwise `cart.items.slice(0, 2).map(...)` → same items as in cart, with variantId, title, handle, imageUrl, price. **No filter by “variant not in cart.”** So same variantId as in cart can and will be recommended.

### Engine.syncCart (recommendation part)

- **Standard upsell:** `standard = computeStandardUpsell(raw, standardConfig)` (upsell.ts) — correctly excludes variants already in cart and applies subtotal rules.  
- **AI path:** If aiEnabled, may set aiRecommendations and loading.  
- **Then (523–533):** `stubRecs = buildStubRecommendations(raw)`; `setState({ upsell: { ... standard: stubRecs, aiRecommendations: [], loading: false } })`. So **stub always overwrites** standard and AI. standardRules from config are never shown; only stub (first 2 cart items) is shown.

### Why same product is recommended

- **Direct cause:** `buildStubRecommendations` returns the first two **cart** items. The UI displays `upsell.standard` (and aiRecommendations), which after every sync are set to stub and `[]`. So the list is literally “first 2 items in cart,” hence the same product already in cart is recommended.  
- standardRules / AI are computed but then replaced; there is no logic that merges stub with “exclude in-cart” or that uses standardRules when stub is present.

---

## CSS / APPEARANCE FLOW

### main.ts

- Imports `./styles/cart-pro-v2.css` (global) and `virtual:cart-pro-v3-component-css`; passes component CSS into `mountCartProV3(componentStyles)`.

### mount.ts

- **applyAppearanceVariables(host, config):** Reads config?.appearance (primaryColor, accentColor, borderRadius, showConfetti, countdownEnabled, emojiMode, backgroundColor, surfaceColor, textColor, borderColor, shadowColor). Sets on **host** (e.g. `#revstack-v3-root`): `--cp-primary`, `--cp-accent`, `--cp-radius`, `--cp-confetti-enabled`, `--cp-countdown-enabled`, `--cp-emoji-enabled`, `--cp-bg`, `--cp-surface`, `--cp-text`, `--cp-border`, `--cp-shadow`, then again primary/accent and `--cp-primary-hover`, `--cp-primary-active`, `--cp-accent-hover`, `--cp-gradient`. So **--cp-primary is set on the host** from config or fallbacks.  
- Shadow root inherits from host; styles in shadow DOM can use `var(--cp-primary)` etc.

### cart-pro-v2.css

- **:host, :root (17–26):** Defaults for `--cp-primary`, `--cp-accent`, `--cp-radius`, `--cp-bg`, `--cp-surface`, `--cp-text`, `--cp-border`, `--cp-shadow`.  
- Many rules use `var(--cp-primary)`, `var(--cp-accent)`, `var(--cp-surface)`, etc., with fallbacks (e.g. `var(--cp-primary, #333)`).  
- **No hardcoded overrides** that would ignore the variable; colours come from variables. If host has not received applyAppearanceVariables (no config yet or wrong host), only CSS defaults apply.  
- **Muted colours:** If config is null at first paint, host never gets applyAppearanceVariables from snapshot yet; cache might have applied once. If cache was empty and snapshot is slow, first paint uses only CSS `:host, :root` defaults (#111827, #16a34a, etc.). If snapshot/cache sends different primary/accent and they are applied on host, they should win. So “muted” can be (1) defaults in CSS, or (2) snapshot sending conservative colours, or (3) applyAppearanceVariables not run on the same element that wraps the shadow root (e.g. wrong host id). Liquid sets host to `getElementById('revstack-v3-root')` in __applyCartProAppearance; mount uses the same ROOT_ID. So if script runs after mount, host is correct. Duplicate setting in applyAppearanceVariables (primary/accent set twice, lines 34–39 and 52–62) is redundant but does not mute; the second block uses config?.appearance with fallbacks to #111827/#16a34a.

### Answers (CSS)

- **--cp-primary:** Set on the host in applyAppearanceVariables when config is available (cache or snapshot).  
- **CSS usage:** Uses `var(--cp-primary)` etc. with fallbacks; no hardcoded colours that override variables for primary/accent.  
- **Overrides:** CSS does not override appearance variables; it uses them.  
- **Muted:** Likely from (1) default fallbacks in CSS when config not yet applied, or (2) backend/snapshot appearance values being muted.

---

## CACHE FLOW

- **configCache.ts:** Does not exist.  
- **mount.ts (168–177):** Before mounting App, reads `sessionStorage.getItem('cart-pro-v3-config')`. If present, parses, calls `applyAppearanceVariables(host, parsed)` and `engine.loadConfig(parsed)`. So cached config **loads before UI mount** when cache exists.  
- **Liquid (after snapshot):** On success, `applyAppearanceAndLoadConfig(config)` calls `loadConfig(config)` and `sessionStorage.setItem('cart-pro-v3-config', JSON.stringify(config))`. So snapshot **overwrites** cache when it completes.  
- **freeShipping in cache:** Cache stores the raw snapshot JSON. If the snapshot response (from mergeWithDefaultV3) does not include `freeShipping` (because backend type and merge don’t have it), cached config also has no freeShipping → after loadConfig, normalizeConfig yields `freeShipping: { thresholdCents: null }` → thresholdCents is null at runtime even from cache.

### Answers (cache)

- Cached config **does** load before UI mount when sessionStorage has a value.  
- engine.loadConfig runs with that parsed object when cache exists.  
- Snapshot overwrites cache (and config) when fetch completes.  
- freeShipping.thresholdCents can be missing from cache because the **snapshot response** from the backend does not include freeShipping (see SNAPSHOT FLOW).

---

## SNAPSHOT FLOW

### cart.snapshot.v3.ts

- Loader: authenticate, get shop, `getShopConfig(shop)`, `getBillingContext(shop, shopConfig)`.  
- `config = mergeWithDefaultV3(shopConfig.configV3 as Partial<CartProConfigV3> | null)`.  
- Response: `{ ...config, featureFlags: featureFlagsFromCapabilities(billing.capabilities) }`.  
- So response is **mergeWithDefaultV3** output plus featureFlags.

### app/lib/config-v3.ts

- **CartProConfigV3** (67–77): Has version, appearance, featureFlags, upsell, rewards, discounts, freeGifts, checkout, analytics. **No `freeShipping` property.**  
- **CartProConfigV3Discounts** (41–44): allowStacking, whitelist. **No `teaseMessage`.**  
- **mergeWithDefaultV3:** Only merges fields that exist on the interface. So **freeShipping and discounts.teaseMessage are never in the snapshot response** unless added elsewhere (they are not in the type or in DEFAULT_CONFIG_V3 or in the merge branches).  
- **DEFAULT_CONFIG_V3** (80–124): No freeShipping, no teaseMessage.  
- **upsell.standardRules:** In CartProConfigV3Upsell; mergeWithDefaultV3 does merge `persisted.upsell.standardRules` into base (line 167). So standardRules **can** exist in snapshot if stored in configV3.  
- **appearance:** Merged (primaryColor, accentColor, borderRadius, showConfetti, countdownEnabled, emojiMode). So appearance fields exist in snapshot.

### shop-config.server.ts

- getShopConfig returns Prisma shopConfig (includes configV3 from DB). configV3 is passed to mergeWithDefaultV3. So whatever is in DB under configV3 is merged; if DB has freeShipping or teaseMessage and the type were extended, they could be returned, but the current **TypeScript type and merge logic do not include freeShipping or discounts.teaseMessage**.

### Answers (snapshot)

- **freeShipping.thresholdCents in snapshot:** No. Backend CartProConfigV3 and mergeWithDefaultV3 do not include freeShipping.  
- **teaseMessage in snapshot:** No. CartProConfigV3Discounts and merge do not include teaseMessage.  
- **upsell.standardRules:** Yes; present in type and merged.  
- **appearance fields:** Yes; present and merged.

---

## BUG LIST (exact runtime failures)

| # | File | Line(s) | Cause | Runtime consequence |
|---|------|---------|--------|----------------------|
| 1 | revstack/app/lib/config-v3.ts | 67–77, 41–44, merge branches | CartProConfigV3 has no `freeShipping`; CartProConfigV3Discounts has no `teaseMessage`; merge never sets them | Snapshot never sends freeShipping or teaseMessage → thresholdCents undefined at runtime; coupon tease message empty |
| 2 | revstack/cart-pro-v3-runtime/src/engine/Engine.ts | 523–533 | After computing standard upsell and optionally AI, stub runs and setState overwrites upsell.standard with buildStubRecommendations(raw), aiRecommendations with [] | Standard rules and AI recs are never shown; only first 2 cart items shown as “recommendations” |
| 3 | revstack/cart-pro-v3-runtime/src/engine/recommendationsStub.ts | 15–27 | buildStubRecommendations returns cart.items.slice(0,2) with no filter for “not in cart” | Same products already in cart are recommended |
| 4 | revstack/cart-pro-v3-runtime/src/ui/v2/DrawerV2.svelte | 111 | countdownVisible={true} hardcoded; no binding to config or --cp-countdown-enabled | Urgency/countdown div visibility not gated by config; div is shown but has no content |
| 5 | revstack/cart-pro-v3-runtime/src/ui/v2/CheckoutSection.svelte | 56 | #cart-pro-countdown has no child content or timer logic | Urgency timer never renders any text or countdown |
| 6 | revstack/cart-pro-v3-runtime/src/engine/state.ts | 246 | shipping.loading initial true | If syncCart never runs (e.g. no cart:external-update and user doesn’t open drawer before effect runs), shipping can stay loading; also when threshold is null, section renders nothing (no tease) |
| 7 | Snapshot + Engine | — | freeShipping not in snapshot → config.freeShipping.thresholdCents effectively null after normalize | syncCart sets shipping.remaining = null → ShippingSection shows no “add X more” message (shipping tease not rendering useful content) |
| 8 | CouponSection + config | 12 | teaseMessage from getConfig()?.discounts?.teaseMessage; snapshot doesn’t send teaseMessage | Coupon tease block never shows (teaseMessage empty) |

---

## PARITY ANALYSIS (vs cart.txt)

Reference: docs/CART_TXT_ZERO_LATENCY_AUDIT.md, docs/CART_ARCHITECTURAL_AUDIT_BLUEPRINT.md.

| Dimension | cart.txt | Cart Pro V3 (current) | Deviation |
|----------|----------|------------------------|-----------|
| Config bootstrap | Bundle defaults + sync sessionStorage at start of onMount + async fetch | No bundle defaults; cache read in mount before App mount; snapshot async later | No defaults; cache exists but only for “next” load; first load no config until fetch |
| Cache usage | sessionStorage read first line of onMount; write after fetch | sessionStorage read in mount before App; write in Liquid after snapshot | Cache used; snapshot overwrites; cache does not contain freeShipping/teaseMessage because snapshot doesn’t |
| Appearance timing | setThemeStyles after fetch only (not from cache on same load) | applyAppearanceVariables from cache (if present) and again from snapshot | V3 can apply theme from cache; snapshot reapplies |
| Store init | All stores with defaults at load; config store has full default object | createInitialState() with defaults; no config in state until loadConfig | Engine has no default config object; config null until loadConfig |
| Recommendation loading | Standard from config (cache/fetch); AI async | standardRules in config but overwritten by stub every sync; AI overwritten by stub | Recommendations broken by stub overwrite and stub content (in-cart items) |
| Shipping tease | From same config + cart; no separate fetch | threshold from config.freeShipping.thresholdCents; config doesn’t have it from snapshot | Shipping tease missing because snapshot doesn’t send freeShipping |
| Coupon tease | Visibility from config; offer list async | teaseMessage from config.discounts.teaseMessage; snapshot doesn’t send it | Coupon tease missing because snapshot doesn’t send teaseMessage |
| Content gate | loadSidecart = true only after await loadConfigurations + updateCart + getDiscounts | No gate; App mounts immediately; syncCart enqueued in onMount | V3 does not gate drawer content on config/cart ready |

**Percentage parity (estimate):** ~40–50%. Structure (engine, stateStore, mount, shadow root, cache key, snapshot endpoint) is aligned, but: (1) no bundle-embedded default config, (2) snapshot schema missing freeShipping and teaseMessage, (3) stub overwriting recommendations and recommending in-cart items, (4) no countdown/timer content, (5) shipping/coupon teases not populated due to missing config fields.

---

## FINAL VERDICT

### Is config loading correctly?

- **Mechanically yes:** When cache exists, loadConfig(parsed) runs before App mount. When snapshot returns, loadConfig(config) runs. normalizeConfig runs and does not strip freeShipping or teaseMessage; it normalizes them (to null/undefined if absent).  
- **Schema gap:** The **snapshot response** (backend config-v3 and mergeWithDefaultV3) does not include freeShipping or discounts.teaseMessage, so at runtime those values are missing/empty even when config “loads.”

### Is stateStore correct?

- **Shape and merging:** Yes; shipping and upsell slices exist and are merged correctly in setState/updateState.  
- **Content:** shipping.remaining stays null because config has no threshold. upsell.standard is forced to stub (first 2 cart items) every sync, so state is “correct” but wrong for product recommendations.

### Is UI correct?

- **Binding:** UI reads the right state and config where available.  
- **Shipping:** Renders skeleton when loading; when loading false and remaining null/unlocked false, no message is shown — so “shipping tease not rendering” is due to missing data (threshold), not wrong binding.  
- **Coupon tease:** Conditional on teaseMessage; because config doesn’t get teaseMessage from snapshot, it doesn’t show.  
- **Countdown:** Div is visible (countdownVisible hardcoded true) but has no content or timer logic.

### Is cache working?

- **Yes:** Read before mount; write after snapshot. Snapshot overwrites cache.  
- **freeShipping in cache:** Missing because the snapshot API never returns freeShipping.

### Why shipping tease missing?

- **Root cause:** Backend CartProConfigV3 and mergeWithDefaultV3 do not include `freeShipping`. Snapshot never sends `freeShipping.thresholdCents`. normalizeConfig returns `freeShipping: { thresholdCents: null }`. In syncCart, `threshold` is null, so shipping is set to remaining: null, unlocked: false, loading: false. ShippingSection then has no branch to show “Add X more for free shipping.”

### Why coupon tease missing?

- **Root cause:** Backend CartProConfigV3Discounts and merge do not include `teaseMessage`. Snapshot never sends it. CouponSection uses `engine.getConfig()?.discounts?.teaseMessage` which is undefined/empty, so the tease block never renders.

### Why urgency timer missing?

- **Root cause:** CheckoutSection renders an empty `#cart-pro-countdown` div. There is no component or logic that fills it with a countdown or urgency message. countdownVisible is hardcoded true and not tied to config.appearance.countdownEnabled.

### Why recommendations flawed?

- **Root cause:** In syncCart, after computing standard upsell (and optionally AI), the code unconditionally sets `upsell.standard = buildStubRecommendations(raw)` and `aiRecommendations = []`. The stub returns the first two **cart** items. So standardRules and AI are never shown, and the same products already in cart are recommended.

### Why colours muted?

- **Likely:** (1) Config not applied yet on first paint (no cache), so only CSS defaults apply; or (2) snapshot/appearance sending conservative colours; or (3) applyAppearanceVariables runs on correct host but after first paint. CSS itself uses var(--cp-*) correctly and does not override appearance variables.

### Exact distance from cart.txt architecture

- **Gaps:** No bundle-embedded default config; snapshot schema missing freeShipping and teaseMessage; recommendations overwritten by stub and stub recommends in-cart items; no countdown content; drawer content not gated on config/cart.  
- **Alignment:** sessionStorage cache key and read-before-mount; single snapshot endpoint; engine + stateStore + mount + shadow DOM; appearance applied from cache and snapshot.  
- **Percentage alignment:** ~40–50% (structure and cache flow partially aligned; schema, recommendations, shipping/coupon tease, and countdown behavior diverge).

---

*End of forensic audit. No files were modified.*
