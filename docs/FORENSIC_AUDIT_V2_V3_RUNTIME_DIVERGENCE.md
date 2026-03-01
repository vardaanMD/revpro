# Forensic Audit: V3 Runtime vs V2 Runtime — Shipping Bar, Coupon Tease, Styling

**Scope:** Trace execution from snapshot → runtime → state → UI → DOM → CSS. Identify exact breakpoints where V3 diverges from V2. No code changes; facts only.

---

## SECTION A — V2 Shipping Implementation

### A.1 Snapshot / config

- **File:** `revstack/app/routes/cart.snapshot.v2.ts`
- **Builder:** `buildBootstrapSnapshotV2(shop)` from `revstack/app/lib/upsell-engine-v2/buildSnapshot.ts`
- **Return shape:** `{ ui, capabilities, upsell, variantIds, aiEnabled, engineVersion: "v2" }`
- **Fact:** V2 snapshot does **not** include `freeShipping.thresholdCents` or any shipping threshold. It does not include `discounts.teaseMessage`.

### A.2 Runtime decision and shipping data

- **File:** `revstack/archived-extensions/cart-pro-v1-v2/assets/cart-pro-v2.js`
- **Config source:** `window.__CART_PRO_V2_SNAPSHOT__` (same shape as above).
- **Free shipping computation:**
  - `computeFreeShippingRemaining(cart)` (lines 135–137) **always returns `0`**.
  - `syntheticDecision` is built as:
    - `freeShippingRemaining: computeFreeShippingRemaining(v2Cart)` → always `0`
    - `crossSell`, `milestones`, `enableCouponTease` from snapshot/capabilities.
- **Effect:** With `freeShippingRemaining === 0`, in the UI the branch “threshold exists and remaining > 0” is never used; the “safe” / minimal message is used when `isSafeDecision(data)` is true.

### A.3 Shipping bar: functions and DOM (V2)

- **File:** `revstack/archived-extensions/cart-pro-v1-v2/assets/cart-pro-ui.js`

**Entry:** `renderShippingBar(state, data, cart, uiConfig, options)` (lines 281–309).

- **Parameters:** `state` ("loading" | "ready"), `data` (syntheticDecision), `cart`, `uiConfig`, `options`.
- **Logic:**
  - If `state === "loading"`: show skeleton (`.cp-skeleton-bar`, `.cp-skeleton-text`) in `#cart-pro-shipping-skeleton`, hide `.cp-shipping-content`.
  - Else: hide skeleton, then either:
    - **If `isSafeDecision(data)`:** set `refs.freeShippingMsgEl.textContent` to `getUIText("You're eligible for free shipping on qualifying orders.", uiConfig)`, show it, add `cp-msg-visible`, hide savings.
    - **Else:** call `updateFreeShippingAndSavings(cart, data, uiConfig, options)`.
  - Then set `refs.shippingContentEl.style.display = ""` and add `cp-fade-in`.

**Helper:** `updateFreeShippingAndSavings(cart, syntheticDecision, uiConfig, options)` (lines 331–378).

- Uses `syntheticDecision.freeShippingRemaining` to derive `threshold` and `unlocked`.
- If `options.enableFreeShippingBar === false` or no cart items: hide message and return.
- If `threshold <= 0`: clear message, hide, return.
- Else: show message; text is one of:
  - Unlocked: `"🎉 FREE Shipping Unlocked!"` and savings `"You saved " + formatMoney(FREE_SHIPPING_SAVINGS_CENTS, currency)`.
  - Else: one of "You're close. Add a little more…", "Almost there! Just $X more 🚀", "So close 🔥 Only $X left!" based on `pct`.
- Uses **refs:** `refs.freeShippingMsgEl` (#cart-pro-shipping-msg), `refs.savingsMsgEl` (#cart-pro-savings).

**DOM structure (V2):**

- Host: `#cart-pro-root` (document); shadow root attached to it.
- Inside drawer markup (DRAWER_MARKUP, lines 17–51):
  - `.cp-shipping-container` (#cart-pro-shipping-container)
    - `.cp-shipping-skeleton` (#cart-pro-shipping-skeleton) — loading
    - `.cp-shipping-content` (#cart-pro-shipping-content) — ready
      - `#cart-pro-shipping-msg` (class `cp-free-shipping-msg`) — main message
      - `#cart-pro-savings` (class `cp-savings-msg`) — “You saved $X”

**Variables:** `remainingCents` from `syntheticDecision.freeShippingRemaining`; `threshold = cart.total_price + remainingCents` when remaining > 0; `unlocked = remainingCents <= 0`.

### A.4 applyUIConfig (V2)

- **File:** `revstack/archived-extensions/cart-pro-v1-v2/assets/cart-pro-ui.js` (lines 109–115)
- **Signature:** `applyUIConfig(root, uiConfig)`
- **Behavior:** Sets on `root` (the host element):
  - `--cp-primary`: `uiConfig.primaryColor || "#111111"`
  - `--cp-accent`: `uiConfig.accentColor || "#555555"`
  - `--cp-radius`: `(typeof uiConfig.borderRadius === "number" ? uiConfig.borderRadius : 12) + "px"`
- **Call site:** `renderInitial()` (line 451): `if (refs.root && uiConfig) applyUIConfig(refs.root, uiConfig);`
- **Host:** `refs.root` is the element passed to `ensureDrawerDOM(root)` — in V2, `document.getElementById("cart-pro-root")`.

---

## SECTION B — V3 Shipping Implementation

### B.1 Snapshot / config

- **File:** `revstack/app/routes/cart.snapshot.v3.ts`
- **Config:** `mergeWithDefaultV3(shopConfig.configV3)` then `{ ...configV3, recommendations }`.
- **Payload includes:** `freeShipping: { thresholdCents: number | null }`, `discounts: { teaseMessage?: string, ... }`, `appearance`, `featureFlags`, etc.
- **Default (config-v3):** `freeShipping.thresholdCents: 5000`, `discounts.teaseMessage: "Apply coupon at checkout to unlock savings"`.

### B.2 Engine state and sync

- **File:** `revstack/cart-pro-v3-runtime/src/engine/Engine.ts`
- **Shipping state:** `state.shipping` = `{ remaining: number | null, unlocked: boolean, loading: boolean }`.
- **Updated only in `syncCart()`** (lines 698–719):
  - `threshold = this.config.freeShipping.thresholdCents ?? null`
  - If `threshold != null`: `remaining = max(0, threshold - itemsSubtotal)`, `unlocked = remaining <= 0`, `loading: false`.
  - If `threshold == null`: `remaining: null`, `unlocked: false`, `loading: false`.
- **Config source:** `this.config` is set by `loadConfig(rawConfig)`, which is called when the snapshot response is applied (block’s `applyAppearanceAndLoadConfig(config)`). No shipping-related data in V3 snapshot is applied outside `loadConfig` + `syncCart`.

### B.3 Execution order and race

- **Block:** `cart_pro_embed_v3.liquid` fetches `/apps/cart-pro/snapshot/v3` then calls `applyAppearanceAndLoadConfig(config)` (which calls `__applyCartProAppearance(config)` and `engine.loadConfig(config)`).
- **Mount:** `mount.ts` runs when the bundled script runs; it may run **before** the snapshot fetch completes. If so:
  - First, `this.config` is still `DEFAULT_RUNTIME_CONFIG` (from `normalizeConfig({})`), so `freeShipping.thresholdCents` is **null**.
  - `App.svelte` `onMount` enqueues `syncCart()`.
  - When that effect runs, `syncCart()` uses `this.config.freeShipping.thresholdCents ?? null` → **null**, so it sets `shipping: { remaining: null, unlocked: false, loading: false }`.
  - Later, the snapshot completes and `loadConfig(config)` runs: `this.config` now has `thresholdCents: 5000` (or merged value), but **syncCart is not called again** until the next `cart:external-update` (e.g. add/change/clear). So `state.shipping` can remain with `remaining: null` and `unlocked: false` even though config has a threshold.
- **Result:** Shipping bar visibility and message depend on whether the first `syncCart` ran before or after `loadConfig`; when it runs before, the bar can show empty or wrong content.

### B.4 ShippingSection.svelte (V3)

- **File:** `revstack/cart-pro-v3-runtime/src/ui/v2/ShippingSection.svelte`
- **Reactive values:**
  - `threshold = engine?.getConfig?.()?.freeShipping?.thresholdCents`
  - `shipping = $stateStore?.shipping ?? { remaining: null, unlocked: false, loading: true }`
  - `showBar = threshold != null`
  - `subtotalAtOrAboveThreshold = threshold != null && subtotalCents >= threshold`
  - `remainingCents = shipping.remaining`
- **Template:**
  - If `!showBar`: nothing rendered.
  - If `showBar`: one `.cp-shipping-container` (#cart-pro-shipping-container).
    - If `shipping.loading`: skeleton (`.cp-shipping-skeleton` with `.cp-skeleton-bar`, `.cp-skeleton-text`).
    - Else if `subtotalAtOrAboveThreshold || shipping.unlocked`: one `#cart-pro-shipping-msg` with text "Free shipping unlocked".
    - Else if `remainingCents != null && remainingCents > 0`: one `#cart-pro-shipping-msg` with "Add {formatCurrency(remainingCents)} more for free shipping".
    - Else: no inner content (no “eligible for free shipping on qualifying orders” fallback).
- **Differences from V2:**
  - No `.cp-shipping-content` wrapper; no `#cart-pro-savings`; no `cp-msg-visible` toggling; no “You're eligible for free shipping on qualifying orders.” when there is a threshold but state not yet synced; message copy is shorter (“Free shipping unlocked” vs “🎉 FREE Shipping Unlocked!”).

---

## SECTION C — Exact Divergence Point: Shipping

1. **Config vs state timing:** In V3, `state.shipping` is populated only in `syncCart()`. If the first `syncCart()` runs before `loadConfig(snapshot)` (e.g. snapshot still loading), `state.shipping` is set with `thresholdCents === null` and never updated until the next cart mutation. So **divergence starts at:** “syncCart runs with default config (no threshold) and never re-runs when snapshot loads.”
2. **Visibility:** V3 shows the shipping block only when `threshold != null`. Before snapshot is applied, threshold is null → entire block hidden. V2 always mounts the shipping container and shows at least the “You're eligible for free shipping on qualifying orders.” when `isSafeDecision(data)` (e.g. no threshold from decision). So **divergence:** V3 hides the whole bar until config has a threshold, and then content can still be wrong due to (1).
3. **DOM:** V3 omits the `.cp-shipping-content` wrapper and `#cart-pro-savings`; V2 has both. **Divergence:** `CheckoutSection.svelte` receives `freeShippingMsg`/`savingsMsg` from DrawerV2 but **ShippingSection** does not use those props — it derives everything from `engine.getConfig()` and `state.shipping`; the Drawer’s computed `shippingMsg`/`savingsMsg` are passed only to CheckoutSection and are not used for the shipping bar in V3.
4. **Exact function where behavior diverges:**  
   - **V2:** `renderShippingBar("ready", syntheticDecision, cart, uiConfig, options)` → always shows container; when `isSafeDecision(data)` sets a single generic message; otherwise `updateFreeShippingAndSavings` sets message + optional savings.  
   - **V3:** `ShippingSection.svelte` → only renders when `threshold != null`; inner content only when `shipping.loading`, or `subtotalAtOrAboveThreshold || shipping.unlocked`, or `remainingCents != null && remainingCents > 0`. No fallback when `threshold != null` but `remaining === null` (e.g. after loadConfig but before second syncCart). So the **exact divergence** is: **V3 has no branch for “threshold exists but state.shipping not yet synced,” and state can stay stale because syncCart is not re-invoked after loadConfig.**

---

## SECTION D — V2 Coupon Tease Implementation

### D.1 In cart-pro-ui.js + cart-pro-v2.js (authoritative V2 stack)

- **File:** `revstack/archived-extensions/cart-pro-v1-v2/assets/cart-pro-ui.js`
- **DOM:** In DRAWER_MARKUP there is `<div id="cart-pro-coupon-banner" class="cp-coupon-banner" aria-hidden="true"></div>` (line 36). Refs: `refs.couponBannerEl = shadow.getElementById("cart-pro-coupon-banner")` (line 443).
- **Fact:** In this file there is **no** code that sets `couponBannerEl.textContent` or toggles `cp-coupon-banner-visible` or `aria-hidden`. So in the **cart-pro-ui.js + cart-pro-v2.js** stack, the coupon tease **banner is never shown or populated**.
- **cart-pro-v2.js** builds `syntheticDecision` with `enableCouponTease: (v2Config.capabilities && v2Config.capabilities.allowCouponTease) === true` but never passes a `teaseMessage` string and the UI module does not read `enableCouponTease` or any tease message.

### D.2 In cart-pro.js (V1 / legacy)

- **File:** `revstack/archived-extensions/cart-pro-v1-v2/assets/cart-pro.js`
- **Function:** `updateCouponBanner()` (lines 1016–1040).
- **Logic:** If `!decisionState.enableCouponTease`: clear banner, remove `cp-coupon-banner-visible`, set `aria-hidden="true"`, return. Else: use milestones, `secondThreshold = milestones[1].amount`, show banner only when `total >= secondThreshold` with **hardcoded** text: `getUIText("🎁 EXTRA10 auto-applied — You saved " + saved)` (COUPON_TEASE_SAVINGS_CENTS = 500). So in this legacy path, tease text is **not** from snapshot; it is a fixed string and conditional on a second milestone threshold.

### D.3 V2 snapshot

- **buildBootstrapSnapshotV2** returns `capabilities.allowCouponTease` but **no** `discounts.teaseMessage` or equivalent. So for the authoritative V2 (ui + v2), there is no “tease message” in the snapshot at all.

---

## SECTION E — V3 Coupon Tease Implementation

### E.1 Snapshot and config

- **Snapshot:** `cart.snapshot.v3.ts` returns `configV3` which includes `discounts.teaseMessage` (from `mergeWithDefaultV3`; default in `config-v3.ts`: `"Apply coupon at checkout to unlock savings"`).
- **Engine:** `normalizeConfig` → `normalizeDiscounts(raw)` (normalizeConfig.ts lines 58–66): `teaseMessage = typeof d?.teaseMessage === 'string' ? d.teaseMessage.trim() || undefined : undefined`. So `config.discounts.teaseMessage` is the only source for tease text in the engine.

### E.2 CouponSection.svelte (V3)

- **File:** `revstack/cart-pro-v3-runtime/src/ui/v2/CouponSection.svelte`
- **Reactive:** `teaseMessage = engine?.getConfig?.()?.discounts?.teaseMessage`
- **Template:**
  - If `teaseMessage && applied.length === 0`: `<div class="cp-coupon-tease" id="cp-coupon-tease">{teaseMessage}</div>`
  - Then: `.cp-coupon-section` (input, apply button, message, remove wrap).
  - Then: `<div id="cart-pro-coupon-banner" class="cp-coupon-banner" aria-hidden="true"></div>` (always empty, no content set).
- So in V3, the **tease text** is rendered in a **different** element: **`.cp-coupon-tease`** (#cp-coupon-tease), not in `#cart-pro-coupon-banner`. The banner element exists but is never populated in V3.

### E.3 Feature flag

- **Snapshot V3:** `featureFlagsFromCapabilities`: `enableDiscounts: capabilities.allowCouponTease ?? false`. So if the shop does not have `allowCouponTease`, `enableDiscounts` is false. The **tease message** itself is still in `config.discounts.teaseMessage` and is shown by CouponSection when present; there is no additional check in CouponSection for `enableDiscounts` for the tease line. So visibility of the tease is driven by “teaseMessage exists” and “no discount applied,” not by a separate “show coupon tease” flag in the UI.

---

## SECTION F — Exact Divergence Point: Coupon Tease

1. **V2 (ui + v2):** Coupon tease banner element exists in the DOM but is **never** updated; no function in cart-pro-ui.js or cart-pro-v2.js sets its content or visibility. So the “authoritative” V2 has **no** coupon tease rendering.
2. **V2 (cart-pro.js):** Tease is shown in `#cart-pro-coupon-banner` with class `cp-coupon-banner`, toggled via `cp-coupon-banner-visible`; text is hardcoded (“EXTRA10 auto-applied …”) and gated by a second milestone threshold and `enableCouponTease`.
3. **V3:** Tease is shown in **`.cp-coupon-tease`** (#cp-coupon-tease) with config-driven `teaseMessage`; `#cart-pro-coupon-banner` is always empty. So:
   - **DOM divergence:** V2 (when implemented in cart-pro.js) uses one element (#cart-pro-coupon-banner.cp-coupon-banner) with visibility class; V3 uses a different element (.cp-coupon-tease) for the text and leaves the banner empty.
   - **Styling divergence:** V2 CSS targets `.cp-coupon-banner` and `.cp-coupon-banner.cp-coupon-banner-visible` (prominent green-style block). V3 has `.cp-coupon-tease` (smaller, plain text style in cart-pro-v2.css lines 861–865). So even if the same text were shown, the **visual** treatment differs: banner vs small tease line.
   - **Exact divergence:** The **function** that in V1 sets the coupon tease is `updateCouponBanner()` in cart-pro.js (same element, visibility class, hardcoded copy). In V3 there is no equivalent “update coupon banner” function; instead, Svelte renders `teaseMessage` in a different node (`.cp-coupon-tease`). So the **exact divergence** is: **different DOM node and CSS class for tease content (cp-coupon-tease vs cp-coupon-banner), and V3 never uses the cp-coupon-banner element for content.**

---

## SECTION G — V2 Styling Implementation

### G.1 Host and CSS variables

- **Host:** `#cart-pro-root` (document body or theme; V2 gets it via `document.getElementById("cart-pro-root")` in cart-pro-v2.js).
- **Shadow root:** Attached to that host in `ensureDrawerDOM(root)` (cart-pro-ui.js). All drawer markup and injected styles live in the shadow root.
- **applyUIConfig(root, uiConfig):** Applied to `root` (#cart-pro-root): `--cp-primary`, `--cp-accent`, `--cp-radius`. So the **host** that receives the theme variables is the same element that has the shadow root.

### G.2 CSS files and injection

- **cart-pro.css** (archived): Defines `:root { --cp-primary, --cp-accent, --cp-radius }` and `#cart-pro-root { position: fixed; … }`. Used as the stylesheet for the cart (injected or linked per theme).
- **cart-pro-ui.js:** Injects `CRITICAL_CSS` (drawer/overlay layout) into the shadow root. Theme variables are on the host (#cart-pro-root); the shadow root’s styles can use `var(--cp-primary)` etc. because they inherit from the host when the CSS is in the shadow tree (selectors inside shadow scope use the host’s inherited custom properties).
- **Shipping bar / coupon in cart-pro.css:** `.cp-free-shipping-msg`, `.cp-free-shipping-msg.cp-msg-visible`, `.cp-savings-msg`, `.cp-shipping-container`, `.cp-coupon-banner`, `.cp-coupon-banner.cp-coupon-banner-visible`, `.cp-coupon-section`, etc. No extra variables for shipping/coupon beyond `--cp-primary`, `--cp-accent`, `--cp-radius` and generic color usage.

---

## SECTION H — V3 Styling Implementation

### H.1 Host and CSS variables

- **Host ID:** Runtime uses `ROOT_ID = 'revstack-v3-root'` (mount.ts). `ensureBodyHost()` gets or creates `document.getElementById('revstack-v3-root')` and appends it to `document.body` if not found. The **block** renders `<div id="cart-pro-v3-root"></div>`; the runtime does **not** use that ID and creates its own host with id `revstack-v3-root`. So the host element that receives CSS variables is **always** the one created by the script, with id **revstack-v3-root**.
- **applyAppearanceVariables(host, config):** (mount.ts lines 25–53) Applied to that host. Sets: `--cp-primary`, `--cp-accent`, `--cp-radius`, plus `--cp-primary-hover`, `--cp-primary-active`, `--cp-accent-hover`, `--cp-gradient`. Config is read from `config?.appearance` (primaryColor, accentColor, borderRadius). So the **injection point** for theme variables is the host `#revstack-v3-root`.

### H.2 Shadow DOM and CSS

- **Shadow root:** Attached to the same host (`#revstack-v3-root`) in `mountCartProV3`. All component CSS (e.g. from cart-pro-v2.css) is injected into the shadow root as one style block. Variables set on the host inherit into the shadow tree.
- **cart-pro-v2.css:** Uses `:host, :root` fallbacks for `--cp-primary`, `--cp-accent`, `--cp-radius`, and adds `--cp-bg`, `--cp-surface`, `--cp-text`, `--cp-border`, `--cp-shadow`, `--cp-overlay`, `--cp-error`. Comment states core variables are set by `mount.applyAppearanceVariables on #revstack-v3-root`. So styling is correct **if** the host is the one with that ID and variables are applied before or when the UI renders.
- **cart-pro-v3.css:** Defines `#revstack-v3-root { all: initial; … }` and other scoped rules. Intended for the same host.

### H.3 When variables are applied

- **Block:** After snapshot fetch, `applyAppearanceAndLoadConfig(config)` calls `__applyCartProAppearance(config)`, which does `document.getElementById('revstack-v3-root')` and then `applyAppearanceVariables(hostEl, config)`. So variables are applied **after** snapshot loads. If the drawer or UI is visible before the fetch completes, the host may briefly have no theme (or only fallbacks from CSS). So **timing:** Variables are applied when the snapshot response is processed, not at mount.

---

## SECTION I — Exact Divergence Point: Styling

1. **Host ID:** V2 uses **#cart-pro-root**; V3 uses **#revstack-v3-root** (and the block’s `#cart-pro-v3-root` is unused). So any theme or global CSS that targets `#cart-pro-root` will not affect V3.
2. **Variable set:** V2 sets only `--cp-primary`, `--cp-accent`, `--cp-radius` on the host. V3 sets those plus `--cp-primary-hover`, `--cp-primary-active`, `--cp-accent-hover`, `--cp-gradient`. So variable names match for the core three; V3 adds more. No mismatch on the core three names.
3. **Variable application target:** In V2, variables are applied to the same element that is the shadow host (#cart-pro-root). In V3, they are applied to #revstack-v3-root, which is also the shadow host. So propagation into the shadow root is the same in both, **provided** the host exists and `__applyCartProAppearance(config)` has been called. If the block or app expects the host to be `#cart-pro-v3-root`, that element never receives variables because the runtime never uses it.
4. **CSS scope:** V2’s cart-pro.css is written for a host named `#cart-pro-root` and for classes like `.cp-free-shipping-msg`, `.cp-coupon-banner`. V3’s cart-pro-v2.css uses the same class names but declares fallbacks on `:host, :root` and expects the host to be the one with variables set. Inside the shadow root, `:root` refers to the shadow root; the host is the parent. So variables must inherit from the host; that works when the host is the same element that has `applyAppearanceVariables` run on it.
5. **Missing or different rules:** V3’s `.cp-free-shipping-msg` does not use a `.cp-msg-visible` toggle for opacity in the same way as V2 (V2 adds it in JS after updating text). V3 ShippingSection does not add `cp-msg-visible`, so if V3 CSS still has `.cp-free-shipping-msg { opacity: 0 }` and `.cp-free-shipping-msg.cp-msg-visible { opacity: 1 }`, the message can stay invisible. (In cart-pro-v2.css lines 721–730 both rules exist; without the class, the message stays opacity: 0.)
6. **Exact divergence:** (a) **Host ID mismatch:** block renders `cart-pro-v3-root`, runtime uses `revstack-v3-root` — theme or external CSS targeting the block’s div has no effect. (b) **Opacity:** V3 does not add `cp-msg-visible` to the shipping message element, so the rule `.cp-free-shipping-msg.cp-msg-visible` never applies and the message can remain at `opacity: 0`. (c) **Coupon:** V3 uses `.cp-coupon-tease` for the tease text instead of `.cp-coupon-banner`; styling is the small tease block, not the full banner style.

---

## SECTION J — Root Cause Summary

| Area | Root cause (concise) |
|------|----------------------|
| **Shipping bar** | (1) V3 only shows the bar when `config.freeShipping.thresholdCents != null`. (2) `state.shipping` is updated only in `syncCart()`. If the first `syncCart()` runs before `loadConfig(snapshot)`, state keeps `remaining: null` and no re-sync runs when config loads, so the bar can be empty or wrong. (3) V3 omits the “You're eligible for free shipping on qualifying orders.” fallback and the `.cp-shipping-content` / `#cart-pro-savings` structure. (4) V3 does not add `cp-msg-visible` to the shipping message, so CSS can keep it at opacity 0. |
| **Coupon tease** | (1) V2 (ui + v2) never renders tease into the banner. (2) V3 renders tease in a different element (`.cp-coupon-tease`) with config `teaseMessage`; `#cart-pro-coupon-banner` is never used for content. (3) Styling differs: V2 banner uses `.cp-coupon-banner`/`.cp-coupon-banner-visible`; V3 uses `.cp-coupon-tease` (plain text style). |
| **Styling / layout** | (1) Host ID: block uses `#cart-pro-v3-root`, runtime uses `#revstack-v3-root`, so the block’s div never gets variables. (2) Shipping message in V3 never gets class `cp-msg-visible`, so it can stay invisible. (3) Variables are applied only after snapshot fetch; if UI renders first, there is a brief period without theme. (4) Same variable names for primary/accent/radius; V3 adds extra variables; no evidence of wrong host for the runtime-created element. |

---

## Exact Code References (snippets)

### V2 — shipping bar render function (cart-pro-ui.js)

```javascript
function renderShippingBar(state, data, cart, uiConfig, options) {
  if (!refs.shippingContainerEl || !refs.shippingSkeletonEl || !refs.shippingContentEl) return;
  if (state === "loading") {
    refs.shippingSkeletonEl.replaceChildren();
    var bar = document.createElement("div");
    bar.className = "cp-skeleton cp-skeleton-bar";
    var text = document.createElement("div");
    text.className = "cp-skeleton cp-skeleton-text";
    refs.shippingSkeletonEl.appendChild(bar);
    refs.shippingSkeletonEl.appendChild(text);
    refs.shippingSkeletonEl.setAttribute("aria-hidden", "false");
    refs.shippingContentEl.style.display = "none";
    return;
  }
  refs.shippingSkeletonEl.setAttribute("aria-hidden", "true");
  if (!refs.freeShippingMsgEl) return;
  refs.freeShippingMsgEl.classList.remove("cp-msg-visible");
  if (isSafeDecision(data)) {
    refs.freeShippingMsgEl.textContent = getUIText("You're eligible for free shipping on qualifying orders.", uiConfig);
    refs.freeShippingMsgEl.style.display = "block";
    if (refs.savingsMsgEl) refs.savingsMsgEl.style.display = "none";
    var raf = typeof requestAnimationFrame !== "undefined" ? requestAnimationFrame : null;
    if (raf) raf(function () { refs.freeShippingMsgEl.classList.add("cp-msg-visible"); });
    else refs.freeShippingMsgEl.classList.add("cp-msg-visible");
  } else {
    updateFreeShippingAndSavings(cart, data, uiConfig, options);
  }
  refs.shippingContentEl.style.display = "";
  refs.shippingContentEl.classList.add("cp-fade-in");
}
```

### V2 — coupon tease (cart-pro.js; not in cart-pro-ui.js)

```javascript
function updateCouponBanner() {
  if (!couponBannerEl) return;
  var couponTeaseEnabled = decisionState && decisionState.enableCouponTease === true;
  if (!couponTeaseEnabled) {
    couponBannerEl.textContent = "";
    couponBannerEl.classList.remove("cp-coupon-banner-visible");
    couponBannerEl.setAttribute("aria-hidden", "true");
    return;
  }
  // ... second milestone check ...
  if (show) {
    couponBannerEl.textContent = getUIText("🎁 EXTRA10 auto-applied — You saved " + saved);
    couponBannerEl.classList.add("cp-coupon-banner-visible", "cp-fade-in");
    couponBannerEl.setAttribute("aria-hidden", "false");
  } else {
    couponBannerEl.textContent = "";
    couponBannerEl.classList.remove("cp-coupon-banner-visible", "cp-fade-in");
    couponBannerEl.setAttribute("aria-hidden", "true");
  }
}
```

### V2 — applyUIConfig (cart-pro-ui.js)

```javascript
function applyUIConfig(root, uiConfig) {
  if (!root || !uiConfig) return;
  root.style.setProperty("--cp-primary", uiConfig.primaryColor || "#111111");
  root.style.setProperty("--cp-accent", uiConfig.accentColor || "#555555");
  var radius = typeof uiConfig.borderRadius === "number" ? uiConfig.borderRadius : 12;
  root.style.setProperty("--cp-radius", radius + "px");
}
```

### V3 — ShippingSection (relevant branch)

- Renders when `showBar` (= `threshold != null`). No `cp-msg-visible`; no `.cp-shipping-content`; no `#cart-pro-savings`; no fallback message when `remaining === null`.

### V3 — CouponSection (tease)

- Renders `{#if teaseMessage && applied.length === 0}` → `<div class="cp-coupon-tease" id="cp-coupon-tease">{teaseMessage}</div>`. `#cart-pro-coupon-banner` is always empty.

### V3 — applyAppearanceVariables (mount.ts)

- Applied to `document.getElementById('revstack-v3-root')`; sets `--cp-primary`, `--cp-accent`, `--cp-radius` from `config?.appearance` plus hover/active/gradient vars.

---

**End of forensic report. No code was modified.**
