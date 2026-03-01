# CartPro V2 vs V3 Runtime, UI, and Recommendation Pipeline — Forensic Audit Report

**Scope:** Investigation only. No code modifications. No fixes implemented.

---

## SECTION A — V2 Runtime Architecture

### A.1 V2 runtime source locations

| Asset | Exact path |
|-------|------------|
| V2 lifecycle script | `revstack/archived-extensions/cart-pro-v1-v2/assets/cart-pro-v2.js` |
| V2 UI module (drawer, recommendations, milestones, shipping, coupon) | `revstack/archived-extensions/cart-pro-v1-v2/assets/cart-pro-ui.js` |
| V2 snapshot route | `revstack/app/routes/cart.snapshot.v2.ts` |
| V2 snapshot builder | `revstack/app/lib/upsell-engine-v2/buildSnapshot.ts` (`buildBootstrapSnapshotV2`) |
| V2 embed block | `revstack/archived-extensions/cart-pro-v1-v2/blocks/cart_pro_embed.liquid` |
| V2 bootstrap route (optional) | `revstack/app/routes/cart.bootstrap.v2.ts` |
| V2 AI route | `revstack/app/routes/cart.ai.v2.ts` |
| V2 snapshot types | `revstack/app/lib/upsell-engine-v2/types.ts` |

**Note:** There is no separate Svelte component named `Recommendations.svelte` in the V2 codebase. V2 uses **imperative DOM** inside `cart-pro-ui.js` (e.g. `updateRecommendationUI`, `createRecCard`). The file `revstack/cart-pro-v3-runtime/src/ui/v2/Recommendations.svelte` is part of the **V3** runtime; the `v2` directory is the UI component folder used by the V3 app, not the archived V2 extension.

### A.2 V2 data flow (high level)

1. **Embed:** `cart_pro_embed.liquid` fetches `/apps/cart-pro/snapshot/v2`, assigns result to `window.__CART_PRO_V2_SNAPSHOT__`, then loads `cart-pro-ui.js` and `cart-pro-v2.js` (defer).
2. **cart-pro-v2.js:** Waits for `__CART_PRO_V2_SNAPSHOT__`, then `initV2()` → `fetchCart()` → `v2Config = __CART_PRO_V2_SNAPSHOT__`, `v2Cart = cart`. On open drawer: `currentUpsellProducts = matchProducts(v2Cart, v2Config.upsell.products)`, `syntheticDecision = { crossSell: snapshotToCrossSell(currentUpsellProducts), freeShippingRemaining, milestones, enableCouponTease }`, then `renderInitial(v2Cart, syntheticDecision, getUiConfig(), getCapabilities())`.
3. **cart-pro-ui.js:** `renderInitial(cart, syntheticDecision, uiConfig, capabilities)` → `applyUIConfig(refs.root, uiConfig)` (CSS vars on root), `updateRecommendationUI(syntheticDecision, options, false, capabilities.onRecAdd)` which reads `syntheticDecision.crossSell` and builds DOM cards via `createRecCard(rec, ...)` for each item.

---

## SECTION B — V3 Runtime Architecture

### B.1 V3 runtime source locations

| Asset | Exact path |
|-------|------------|
| V3 entry / mount | `revstack/cart-pro-v3-runtime/src/main.ts`, `revstack/cart-pro-v3-runtime/src/mount.ts` |
| V3 engine | `revstack/cart-pro-v3-runtime/src/engine/Engine.ts` |
| V3 state | `revstack/cart-pro-v3-runtime/src/engine/state.ts` |
| V3 snapshot route | `revstack/app/routes/cart.snapshot.v3.ts` |
| V3 config (canonical) | `revstack/app/lib/config-v3.ts` |
| V3 embed block | `revstack/extensions/cart-pro/blocks/cart_pro_embed_v3.liquid` |
| V3 UI (drawer, recommendations, etc.) | `revstack/cart-pro-v3-runtime/src/ui/App.svelte`, `ui/v2/DrawerV2.svelte`, `ui/v2/Recommendations.svelte`, `ui/v2/RecommendationCard.svelte` |
| V3 styles | `revstack/cart-pro-v3-runtime/src/styles/cart-pro-v2.css` (primary), `cart-pro-v3.css` |

### B.2 V3 data flow (high level)

1. **Embed:** `cart_pro_embed_v3.liquid` fetches `/apps/cart-pro/snapshot/v3`, then calls `applyAppearanceAndLoadConfig(config)` which: `__applyCartProAppearance(config)`, `CartProV3Engine.loadConfig(config)`, and caches config in `sessionStorage` under `cart-pro-v3-config`.
2. **Mount:** `mountCartProV3(componentCss)` creates engine, ensures host `#revstack-v3-root`, attaches shadow root, injects styles, optionally restores config from cache and calls `engine.loadConfig(parsed)` and `applyAppearanceVariables(host, parsed)`, then mounts Svelte `App` with `engine`.
3. **Engine.loadConfig:** Normalizes config, sets state slices (discount, freeGifts, upsell.standardConfig, rewards, checkout, analytics). If `rawConfig.recommendations` is an array, sets `state.snapshotRecommendations` from it (variantId, title, imageUrl, price, handle).
4. **App / syncCart:** On init and cart events, `syncCart()` runs: fetches cart, updates cart/shipping/rewards state, runs `computeStandardUpsell(raw, standardConfig)` and sets `state.upsell.standard`, and either loads AI recommendations (debounced) or builds stub and sets `state.upsell.aiRecommendations`.
5. **UI:** `Recommendations.svelte` subscribes to `stateStore`; derives `recommendations = state.snapshotRecommendations?.length ? state.snapshotRecommendations : state.upsell.standard`, `aiRecommendations = state.upsell.aiRecommendations`; builds `recs = [...recommendations, ...aiRecommendations]` (with aiRecommendations mapped to `{ variantId, title: 'Variant #${r.variantId}' }`); renders `RecommendationCard` for each `rec`.

---

## SECTION C — State Schema Diff

### C.1 V2 (no single “EngineState” — in-memory + synthetic decision)

V2 does not have a centralized store type. Relevant data:

- **Config (from snapshot):** `window.__CART_PRO_V2_SNAPSHOT__` = shape of `BootstrapV2Response` (see `revstack/app/lib/upsell-engine-v2/types.ts`):
  - `ui`, `capabilities`, `upsell: { products: ProductSnapshot[], strategy }`, `variantIds`, `aiEnabled`
- **ProductSnapshot (V2):** `id`, `productId`, `variantId`, `title`, `imageUrl`, `price` (number), `currency`, `handle`, `collections`
- **Runtime:** `v2Config`, `v2Cart`, `currentUpsellProducts` (filtered from `v2Config.upsell.products`). Rendered data: `syntheticDecision.crossSell` = array of `{ id, title, handle, imageUrl, variantId, price: { amount, compare_at_amount } }` (from `snapshotToCrossSell`).

### C.2 V3 EngineState (excerpt — recommendation-related)

**File:** `revstack/cart-pro-v3-runtime/src/engine/state.ts`

```ts
// UpsellState
upsell: {
  standardConfig: StandardUpsellRule[];  // { variantId, conditionSubtotalCents }
  standard: StandardUpsellRule[];       // computed eligible list (same shape)
  oneTick: { variantId: number } | null;
  aiEnabled: boolean;
  aiRecommendations: Array<{ variantId: number }>;
  loading: boolean;
  cache: Record<number, boolean>;
}

// Top-level (recommendation UI)
snapshotRecommendations: SnapshotRecommendationItem[];

// SnapshotRecommendationItem
interface SnapshotRecommendationItem {
  variantId: number;
  title: string;
  imageUrl?: string | null;
  price?: { amount?: number; compare_at_amount?: number | null };
  handle?: string;
}
```

### C.3 Differences (recommendation-related)

| Aspect | V2 | V3 |
|--------|----|----|
| Recommendation source in “state” | Single list: snapshot `upsell.products` → filtered → `crossSell` (full product shape). | Two paths: `snapshotRecommendations` (full shape) **or** `upsell.standard` (variant-only) + `upsell.aiRecommendations` (variant-only). |
| Stored shape for “main” list | Full: id, title, handle, imageUrl, variantId, price.{ amount, compare_at_amount }. | Snapshot path: full. Fallback path: `standard` = `StandardUpsellRule[]` (variantId, conditionSubtotalCents only). |
| AI list | Overwrites display: after AI fetch, `currentUpsellProducts = data.products` and re-render with full product shape from API. | `aiRecommendations: Array<{ variantId: number }>`; UI maps to `{ variantId, title: 'Variant #${id}' }` — no image/price from API in UI. |
| Dedicated snapshot list | No separate field; snapshot products are the only recommendation list (after filter). | Yes: `snapshotRecommendations` holds hydrated list from snapshot; `upsell.standard` is rule-based and variant-only. |

---

## SECTION D — UI Component Diff

### D.1 V2: no Svelte Recommendations/RecommendationCard

V2 uses **cart-pro-ui.js** only:

- **Recommendation entry:** `updateRecommendationUI(syntheticDecision, options, isPredicted, onRecAdd)` (in cart-pro-ui.js).
- **Card creation:** `createRecCard(rec, isPredicted, currency, onRecAdd)`.
- **Expected rec shape (V2):** `id`, `title`, `handle`, `imageUrl`, `variantId`, `price: { amount, compare_at_amount }`. All come from `snapshotToCrossSell(currentUpsellProducts)`.

### D.2 V3: Svelte components

**Recommendations.svelte**  
Path: `revstack/cart-pro-v3-runtime/src/ui/v2/Recommendations.svelte`

- **Props:** `engine` (has `stateStore`).
- **Reads:** `state.snapshotRecommendations`, `state.upsell.standard`, `state.upsell.aiRecommendations`, `state.upsell.loading`, `state.cart.raw.currency`.
- **Logic:**  
  `recommendations = state.snapshotRecommendations?.length ? state.snapshotRecommendations : state.upsell.standard`  
  `recs = [...recommendations.map(r => ({ ...r, variantId: r.variantId })), ...aiRecommendations.map(r => ({ variantId: r.variantId, title: 'Variant #'+r.variantId }))]`
- So: when using `snapshotRecommendations`, `rec` has full shape; when using `standard`, `rec` has only `variantId` and `conditionSubtotalCents` (no title/image/price); for AI, only `variantId` and stub title.

**RecommendationCard.svelte**  
Path: `revstack/cart-pro-v3-runtime/src/ui/v2/RecommendationCard.svelte`

- **Props:** `engine`, `rec`, `isPredicted`, `currency`.
- **Expects on rec:** `variantId`, `title`, `imageUrl`, `price` (with `amount`), `handle` (optional).
- **Rendering:** Image `src={rec.imageUrl}`, title `{rec.title}`, `formatCurrency(rec.price)`, Add button calls `engine.addToCart(rec.variantId, 1)`.

### D.3 Comparison summary

| Item | V2 (cart-pro-ui.js) | V3 (Svelte) |
|------|----------------------|-------------|
| Component model | Imperative DOM, single JS module. | Svelte: Recommendations.svelte + RecommendationCard.svelte. |
| Expected rec shape | Full: id, title, handle, imageUrl, variantId, price.{ amount, compare_at_amount }. | Same for snapshot path; for `standard`/AI: missing title/image/price (or stub title only). |
| Price rendering | `createRecCard`: formatMoney(price.amount), optional compare_at. | `formatCurrency(rec.price)`; if `rec.price` missing/undefined, shows 0.00. |
| Image rendering | `img.src = safeImageUrl(imageUrl) \|\| ''`; if no imageUrl, `img.style.display = 'none'`. | `src={rec.imageUrl}`; missing imageUrl can yield broken img. |
| variantId | From rec; add uses `onRecAdd(rec)` → `handleAddToCart(rec.variantId, rec.id, ...)`. | From rec; Add calls `engine.addToCart(rec.variantId, 1)`. |
| Identical? | N/A (different codebases). | When data source is snapshot recommendations, behavior aligns. When source is `standard` or `aiRecommendations`, V3 cards are incomplete (no real title/image/price). |

---

## SECTION E — Styling Diff

### E.1 V2 (cart-pro-ui.js)

- **Application:** `applyUIConfig(root, uiConfig)` on the **root** element (e.g. `#cart-pro-root`): sets `--cp-primary`, `--cp-accent`, `--cp-radius` from `uiConfig` (primaryColor, accentColor, borderRadius).
- **Structure:** Root has attached **shadow root**; drawer markup is inside shadow DOM. No separate “host” div for theme; root is the shadow host.
- **Variables:** `--cp-primary`, `--cp-accent`, `--cp-radius` (from snapshot `ui`). No `--cp-bg`, `--cp-surface`, etc. in V2 UI code path.
- **CSS:** V2 embed loads `cart-pro.css` (link in liquid); cart-pro-ui.js injects `CRITICAL_CSS` into shadow root (layout, overlay, drawer transform). Theme/block may load additional CSS.

### E.2 V3 (mount.ts + cart-pro-v2.css)

- **Application:** `applyAppearanceVariables(host, config)` in `revstack/cart-pro-v3-runtime/src/mount.ts`. Host = `#revstack-v3-root` (or from cache, same host). Called when snapshot returns and when restoring from sessionStorage.
- **Variables set on host:**  
  `--cp-primary`, `--cp-accent`, `--cp-radius`, `--cp-confetti-enabled`, `--cp-countdown-enabled`, `--cp-emoji-enabled`,  
  `--cp-bg`, `--cp-surface`, `--cp-text`, `--cp-border`, `--cp-shadow`,  
  then again `--cp-primary`, `--cp-primary-hover`, `--cp-primary-active`, `--cp-accent`, `--cp-accent-hover`, `--cp-gradient`.
- **Structure:** Host has shadow root; Svelte app mounts inside shadow root. CSS is injected into shadow root (component + global cart-pro-v2.css).
- **cart-pro-v2.css:** Defines fallbacks and uses `var(--cp-primary)`, `var(--cp-surface)`, `var(--cp-radius)`, etc. Large set of variables (e.g. `--cp-bg`, `--cp-surface`, `--cp-text`, `--cp-border`, `--cp-shadow`).

### E.3 Comparison

| Aspect | V2 | V3 |
|--------|----|----|
| Variable names (core) | `--cp-primary`, `--cp-accent`, `--cp-radius` | Same plus many more (bg, surface, text, border, shadow, gradient, hover, etc.). |
| Host element | Root = `#cart-pro-root` (shadow host). | Host = `#revstack-v3-root` (shadow host). |
| Shadow root | Yes (drawer inside shadow). | Yes (app inside shadow). |
| Where vars applied | On shadow host (root). | On shadow host (revstack-v3-root). |
| Identity | Same core three vars; V3 extends with more vars and fallbacks in CSS. |

---

## SECTION F — Recommendation Pipeline Diff

### F.1 V2 pipeline (exact chain)

1. **Snapshot fetch:** `cart_pro_embed.liquid` → `fetch("/apps/cart-pro/snapshot/v2")` → `window.__CART_PRO_V2_SNAPSHOT__ = snapshotJson`.
2. **Snapshot content:** `cart.snapshot.v2.ts` → `buildBootstrapSnapshotV2(shop)` → returns `BootstrapV2Response`: `upsell.products` = `ProductSnapshot[]` (id, productId, variantId, title, imageUrl, price number, currency, handle, collections).
3. **Hydration to “state”:** No separate store. On open/render: `currentUpsellProducts = matchProducts(v2Cart, v2Config.upsell.products)` (filter out in-cart), then `syntheticDecision.crossSell = snapshotToCrossSell(currentUpsellProducts)`.
4. **snapshotToCrossSell** (cart-pro-v2.js): Maps each product to `{ id, title, handle, imageUrl, variantId, price: { amount, compare_at_amount } }`.
5. **UI read:** `renderInitial(cart, syntheticDecision, ...)` → `updateRecommendationUI(syntheticDecision, ...)` reads `syntheticDecision.crossSell`.
6. **Render:** For each item in crossSell, `createRecCard(rec, ...)` builds DOM (image, title, price, compare-at, Add button). All data from snapshot; no second “standard” or “AI” list overwriting the main list except when AI returns and replaces `currentUpsellProducts` and re-renders.

**Authority:** Snapshot `upsell.products` is the single source for the main list. AI (optional) replaces the entire displayed list when `/apps/cart-pro/ai/v2` returns (handleAIFetch → currentUpsellProducts = data.products → reopenWithFreshData).

### F.2 V3 pipeline (exact chain)

1. **Snapshot fetch:** `cart_pro_embed_v3.liquid` → `fetch('/apps/cart-pro/snapshot/v3')` → `applyAppearanceAndLoadConfig(config)` → `window.__applyCartProAppearance(config)` and `window.CartProV3Engine.loadConfig(config)`.
2. **Snapshot content:** `cart.snapshot.v3.ts` builds `configV3` (mergeWithDefaultV3 + featureFlags), then `recommendations = await getHydratedRecommendationsForShop(shop)` (same DB/strategy as V2, shape: id, variantId, title, imageUrl, price.{ amount, compare_at_amount }, handle). Payload: `{ ...configV3, recommendations }`.
3. **Hydration to state:** `Engine.loadConfig(rawConfig)` in `Engine.ts`:  
   - Normalizes config and sets discount, freeGifts, upsell.standardConfig, rewards, checkout, analytics.  
   - If `Array.isArray((rawConfig as any).recommendations)`: `setState({ snapshotRecommendations: rawConfig.recommendations.map(r => ({ variantId, title, imageUrl, price: r.price ?? { amount: 0 }, handle })) })`.  
   - **Writes:** `state.snapshotRecommendations` (and other slices). Does **not** write `state.upsell.standard` from snapshot recommendations.
4. **syncCart (later):** Fetches cart, then `standard = computeStandardUpsell(raw, standardConfig)` and `setState({ upsell: { ...upsell, standard } })`. Also sets `upsell.aiRecommendations` (from API or stub). **Does not** overwrite `snapshotRecommendations`.
5. **UI read:** `Recommendations.svelte`:  
   `recommendations = state.snapshotRecommendations?.length ? state.snapshotRecommendations : state.upsell.standard`  
   `aiRecommendations = state.upsell.aiRecommendations ?? []`  
   `recs = [...recommendations.map(r => ({ ...r, variantId: r.variantId })), ...aiRecommendations.map(r => ({ variantId: r.variantId, title: 'Variant #'+r.variantId }))]`.
6. **Render:** Each `rec` in `recs` passed to `RecommendationCard`; card uses `rec.title`, `rec.imageUrl`, `rec.price`, `rec.variantId`.

**Authority / arbitration:**

- **Primary:** If `state.snapshotRecommendations.length > 0`, UI uses **only** `snapshotRecommendations` for the “main” list (standard is not shown for that list).
- **Fallback:** If `snapshotRecommendations` is empty or missing, main list = `state.upsell.standard` (which is `StandardUpsellRule[]` ⇒ only variantId and conditionSubtotalCents).
- **AI:** Always appended as second segment; in state they are `{ variantId }`; in UI they get stub title only (`Variant #${r.variantId}`), no image/price from backend.

### F.3 Where each V3 state property is written

| Property | Written in | File: function/line (approx) |
|----------|------------|------------------------------|
| snapshotRecommendations | loadConfig when rawConfig.recommendations is array | Engine.ts: loadConfig(), setState({ snapshotRecommendations: ... }) |
| upsell.standard | syncCart after computeStandardUpsell | Engine.ts: syncCart(), setState({ upsell: { ...upsell, standard } }) |
| upsell.aiRecommendations | syncCart: from cache, or debounced API callback, or buildStubRecommendations (when AI disabled) | Engine.ts: syncCart() (multiple setState calls for upsell) |

---

## SECTION G — Lever Pipeline Diff

### G.1 Free shipping bar

- **V2:** `syntheticDecision.freeShippingRemaining = computeFreeShippingRemaining(v2Cart)` (currently returns 0 in cart-pro-v2.js). Passed to `renderInitial` → `renderShippingBar("ready", syntheticDecision, cart, uiConfig, options)` → `updateFreeShippingAndSavings` or safe message. Config: capabilities only; no threshold in snapshot.
- **V3:** `state.shipping` (remaining, unlocked, loading). Set in `Engine.syncCart()` from `config.freeShipping.thresholdCents` and cart subtotal. Read by `ShippingSection.svelte` and by `DrawerV2.svelte` for `shippingMsg`. Config: `config.freeShipping.thresholdCents` (from snapshot/config-v3).

### G.2 Coupon tease

- **V2:** `syntheticDecision.enableCouponTease = (v2Config.capabilities.allowCouponTease) === true`. Rendered in cart-pro-ui.js (coupon section / banner). No `teaseMessage` in V2 snapshot.
- **V3:** `engine.getConfig().discounts.teaseMessage` in `CouponSection.svelte`; shown when `applied.length === 0 && teaseMessage`. Config: `config.discounts.teaseMessage` (normalizeConfig → ConfigDiscounts.teaseMessage).

### G.3 Countdown timer

- **V2:** `refs.countdownEl.style.display = (uiConfig.countdownEnabled !== false) ? '' : 'none'`. No running countdown logic in provided V2 code; display only.
- **V3:** `engine.countdown` (CountdownApi); started in `onDrawerOpened()` and in `syncCart()` when cart signature changes (duration from `config.appearance.countdownDurationMs`). `CheckoutSection.svelte` reads `engine.countdown.store` and `engine.getConfig().appearance.countdownEnabled`; shows countdown when visible and running.

### G.4 Upsell triggers

- **V2:** Open drawer and add-to-cart both trigger `reopenWithFreshData()` → recompute `currentUpsellProducts` from snapshot (and after AI fetch, from AI response) → `renderInitial` with new syntheticDecision.
- **V3:** Open drawer and cart updates trigger `syncCart()` (via effect queue / theme connector). Upsell.standard and aiRecommendations updated in syncCart; UI reacts via store. No separate “trigger” for snapshot recommendations — they are set once in loadConfig and not cleared by syncCart.

---

## SECTION H — Snapshot Schema Diff

### H.1 V2 snapshot (cart.snapshot.v2.ts + buildBootstrapSnapshotV2)

**Response shape (BootstrapV2Response):**

- `ui`: primaryColor, accentColor, borderRadius, showConfetti, countdownEnabled, emojiMode  
- `capabilities`: allowUIConfig, allowCrossSell, allowMilestones, allowCouponTease  
- `upsell`: `{ products: ProductSnapshot[], strategy }`  
- `variantIds`, `aiEnabled`  
- `engineVersion: "v2"` (added in route)

**ProductSnapshot:** id, productId, variantId, title, imageUrl, price (number), currency, handle, collections.

**No** top-level `recommendations`, **no** `appearance` (UI under `ui`), **no** `freeShipping`, **no** `discounts.teaseMessage` in response.

### H.2 V3 snapshot (cart.snapshot.v3.ts + config-v3)

**Response shape:** Merged `CartProConfigV3` plus top-level `recommendations` array.

- `version`, `appearance` (primaryColor, accentColor, borderRadius, showConfetti, countdownEnabled, emojiMode, countdownDurationMs, etc.)  
- `featureFlags`  
- `upsell` (strategy, limit, collections, standardRules, ai)  
- `rewards`, `discounts` (allowStacking, whitelist, teaseMessage), `freeGifts`, `freeShipping` (thresholdCents), `checkout`, `analytics`  
- **recommendations:** array from `getHydratedRecommendationsForShop(shop)`: `{ id, variantId, title, imageUrl, price: { amount, compare_at_amount }, handle }`

### H.3 Side-by-side (recommendations, appearance, upsell, freeShipping, discounts)

| Field | V2 | V3 |
|-------|----|----|
| recommendations | No. Recommendations are inside `upsell.products` (ProductSnapshot[]). | Yes. Top-level `recommendations` array (hydrated full shape). |
| appearance | Under `ui` (flat: primaryColor, etc.). | Under `appearance` (includes countdownDurationMs, optional bg/surface/text/border/shadow). |
| upsell | `upsell.products` (full product list), `upsell.strategy`. | `upsell.strategy`, `upsell.limit`, `upsell.collections`, `upsell.standardRules`, `upsell.ai`. No `upsell.products` in config. |
| freeShipping | Not in snapshot. | `freeShipping.thresholdCents`. |
| discounts | Not in snapshot. | `discounts.allowStacking`, `discounts.whitelist`, `discounts.teaseMessage`. |

---

## SECTION I — Exact Root Causes (Breakpoints)

### I.1 Which exact function prevents snapshot recommendations from fully controlling UI

- **Not blocked:** When `rawConfig.recommendations` is a non-empty array, `Engine.loadConfig()` does set `snapshotRecommendations` and does not clear it in `syncCart()`. So snapshot recommendations **do** control the main list when present.
- **Partial control:** If the snapshot payload omits `recommendations` or sends an empty array, `loadConfig` never sets (or overwrites) `snapshotRecommendations`. Then the UI falls back to `state.upsell.standard`, which is variant-only. So the **authoritative** place that can “prevent” snapshot from controlling the UI is the **snapshot response** (and any code that clears or omits `recommendations` before calling `loadConfig`). In the current code, no function clears `snapshotRecommendations` after loadConfig; the only gap is when snapshot does not provide `recommendations`.

### I.2 Which exact function injects variant-only recommendations

- **upsell.standard:** `Engine.syncCart()` calls `computeStandardUpsell(raw, standardConfig)` and sets `state.upsell.standard`. That list is `StandardUpsellRule[]` = `{ variantId, conditionSubtotalCents }`. So **Engine.ts `syncCart()`** (the block that does `standard = computeStandardUpsell(...)` and `setState({ upsell: { ...upsell, standard } })`) injects variant-only “standard” recommendations.
- **upsell.aiRecommendations:** Same `syncCart()` sets `state.upsell.aiRecommendations` to either cached/API result or `buildStubRecommendations(raw)`; both are `Array<{ variantId: number }>`. So **Engine.ts `syncCart()`** (and **recommendationsStub.ts `buildStubRecommendations()`** for the stub path) inject variant-only AI recommendations.

### I.3 Which exact function causes UI to render incomplete cards

- **Recommendations.svelte** builds `recs` and passes each `rec` to `RecommendationCard`. When the main list comes from `state.upsell.standard`, each item has only `variantId` and `conditionSubtotalCents` (no title, imageUrl, price). When the list includes `aiRecommendations`, they are mapped to `{ variantId, title: 'Variant #'+r.variantId }` only. So **Recommendations.svelte** (the reactive block that sets `recs` and the template that does `{#each recs as rec}` → `RecommendationCard { rec }`) causes incomplete cards whenever the data source is `standard` or `aiRecommendations`, because it does not hydrate those items with title/image/price (and RecommendationCard has no fallback for missing fields beyond displaying what it gets).

### I.4 Which exact function causes styling differences

- **applyAppearanceVariables** in **mount.ts** applies a broader set of CSS variables (e.g. `--cp-bg`, `--cp-surface`, `--cp-text`, `--cp-border`, `--cp-shadow`, `--cp-gradient`, hover/active) than V2’s **applyUIConfig** in **cart-pro-ui.js** (which only sets `--cp-primary`, `--cp-accent`, `--cp-radius`). So **mount.ts `applyAppearanceVariables()`** is the function that introduces the extended V3 styling. Differences in visual appearance also come from the different host IDs (`#revstack-v3-root` vs `#cart-pro-root`) and the fact that V3 uses **cart-pro-v2.css** (and optional cart-pro-v3.css) with more variable usage.

### I.5 Which exact function causes lever differences

- **Free shipping:** V2 uses `computeFreeShippingRemaining(v2Cart)` (returns 0) and no threshold in config. V3 uses **Engine.syncCart()** where `config.freeShipping.thresholdCents` and cart subtotal compute `state.shipping.remaining` and `state.shipping.unlocked`. So **Engine.ts `syncCart()`** (shipping block) causes the free-shipping lever difference.
- **Coupon tease:** V3 **CouponSection.svelte** reads `engine.getConfig().discounts.teaseMessage`; V2 has no teaseMessage. So **config normalization** (discounts.teaseMessage) and **CouponSection.svelte** cause the coupon-tease lever difference.
- **Countdown:** V3 **Engine.ts** `onDrawerOpened()` and the countdown block inside **syncCart()** start the countdown from `config.appearance.countdownDurationMs`; **CheckoutSection.svelte** subscribes to `engine.countdown.store`. V2 only toggles countdown element visibility. So **Engine.ts** (countdown start) and **CheckoutSection.svelte** (display) cause the countdown lever difference.

---

**End of forensic report. No fixes or recommendations; investigation only.**
