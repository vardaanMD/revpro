# Forensic Audit: V2 Cart UI vs V3 Cart UI — Complete Audit & Migration Plan

**Scope:** Authoritative V2 UI (cart-pro-ui.js + cart-pro-v2.js + cart-pro.css + embed) vs V3 UI (Svelte drawer). Explain why cart preview renders correctly but the cart drawer does not. Produce a precise migration plan so V3 drawer becomes an exact rendering clone of V2 (cart.txt equivalent).  
**Constraint:** Investigation and migration planning only. No code changes.

---

# PART 1 — Audit Authoritative V2 UI Implementation

## 1A — Exact V2 Drawer DOM Structure

**Sources:** `cart-pro-ui.js` (DRAWER_MARKUP lines 17–51, ensureDrawerDOM 447–459).

### Full hierarchy created in ensureDrawerDOM and DRAWER_MARKUP

```
#cart-pro-root                          ← SHADOW HOST (in document; from embed.liquid)
  .attachShadow({ mode: "open" })       ← shadowRoot
    <style> (CRITICAL_CSS injected)
    #cart-pro                           ← refs.container (open class toggled here)
      #cart-pro-overlay                 ← refs.overlay (opacity/pointer-events toggled in JS)
      #cart-pro-drawer                  ← refs.drawer (transform translateX)
        #cart-pro-header
          #cart-pro-title
          #cart-pro-close
        #cart-pro-milestones.cp-milestones-container
          .cp-milestones-inner
        #cart-pro-items.cp-items-container
          #cart-pro-items-inner.cp-items-inner
        #cart-pro-recommendations.cp-recommendations-container
          .cp-recommendations-inner
        #cart-pro-footer
          .cp-coupon-section#cp-coupon-section
            #cp-coupon-input
            #cp-coupon-apply
            #cp-coupon-message
            #cp-coupon-remove-wrap.cp-coupon-remove-wrap
          #cart-pro-coupon-banner.cp-coupon-banner   ← receives cp-coupon-banner-visible (in cart-pro.js only; not in cart-pro-ui.js)
          #cart-pro-subtotal
          .cp-shipping-container#cart-pro-shipping-container
            #cart-pro-shipping-skeleton.cp-shipping-skeleton  (aria-hidden toggled)
            .cp-shipping-content#cart-pro-shipping-content    (display:none when loading)
              #cart-pro-shipping-msg.cp-free-shipping-msg    ← receives cp-msg-visible
              #cart-pro-savings.cp-savings-msg
          .cp-checkout-container
            #cart-pro-checkout.cp-checkout-btn
            #cart-pro-countdown.cp-countdown
    #cart-pro-confetti-layer
```

### Which element is shadow host

- **Shadow host:** `#cart-pro-root` (the div from `cart_pro_embed.liquid`). `ensureDrawerDOM(root)` is called with `document.getElementById("cart-pro-root")`; that element gets the shadow root and inline style for position/z-index/pointer-events.

### Which elements are styled directly (inline in ensureDrawerDOM)

- **root (host):** `root.style.cssText = "position:fixed;...;pointer-events:none;"`
- **#cart-pro-header:** `headerEl.style.cssText = "padding:10px 12px;border-bottom:1px solid #eee;..."`
- **#cart-pro-items:** `refs.itemsEl.style.cssText = "flex:1;overflow:auto;padding:10px;"`
- **#cart-pro-recommendations:** `refs.recommendationsEl.style.cssText = "padding:0 10px 10px;..."`
- **#cart-pro-close:** `refs.closeBtn.style.cssText = "background:none;border:none;font-size:18px;cursor:pointer;"`

All other layout/visual styling comes from **cart-pro.css** (linked in embed) and **CRITICAL_CSS** (injected into shadow root in cart-pro-ui.js).

### Which elements receive cp-msg-visible and cp-coupon-banner-visible

- **cp-msg-visible:** Applied only to `#cart-pro-shipping-msg` (refs.freeShippingMsgEl). In `renderShippingBar` and `updateFreeShippingAndSavings`, after setting text, the code does `refs.freeShippingMsgEl.classList.add("cp-msg-visible")` (optionally inside requestAnimationFrame). This class is required for the message to be visible: CSS has `.cp-free-shipping-msg { opacity: 0 }` and `.cp-free-shipping-msg.cp-msg-visible { opacity: 1 }`.
- **cp-coupon-banner-visible:** Not applied in **cart-pro-ui.js** or **cart-pro-v2.js**. The element `#cart-pro-coupon-banner` exists and is ref’d as `refs.couponBannerEl`, but no code in the V2 UI module sets its text or adds this class. The class is used only in **cart-pro.js** (legacy V1) in `updateCouponBanner()`.

---

## 1B — Exact V2 UI Rendering Pipeline

**Sources:** `cart_pro_embed.liquid`, `cart.snapshot.v2.ts`, `buildSnapshot.ts`, `cart-pro-v2.js`, `cart-pro-ui.js`.

### Execution chain

1. **embed.liquid**
   - Renders `<link rel="stylesheet" href="{{ 'cart-pro.css' | asset_url }}">`.
   - Renders `<div id="cart-pro-root" ...></div>`.
   - Inline script: `fetch("/apps/cart-pro/snapshot/v2", { credentials: "same-origin" })` → `.then(res => res.json())` → `window.__CART_PRO_V2_SNAPSHOT__ = snapshotJson`.
   - Loads `<script src="{{ 'cart-pro-ui.js' | asset_url }}" defer></script>`.
   - Loads `<script src="{{ 'cart-pro-v2.js' | asset_url }}" defer></script>`.

2. **Snapshot fetch**
   - Route: `cart.snapshot.v2.ts` → `buildBootstrapSnapshotV2(shop)` from `buildSnapshot.ts`.
   - Returns `{ ui, capabilities, upsell, variantIds, aiEnabled, engineVersion: "v2" }`. No `freeShipping.thresholdCents`, no `discounts.teaseMessage`.

3. **cart-pro-v2.js**
   - On load: if `document.readyState === "loading"` → `DOMContentLoaded` → `waitForSnapshot(callback)`; else `waitForSnapshot(callback)`.
   - `waitForSnapshot` polls for `window.__CART_PRO_V2_SNAPSHOT__` (up to 40 × 50ms), then calls `initV2()`.

4. **initV2()**
   - `v2Config = window.__CART_PRO_V2_SNAPSHOT__`.
   - `root = document.getElementById("cart-pro-root")`; if !root return.
   - `fetchCart()` → then: `v2Cart = cart`, `v2Ready = true`, if `v2OpenQueued` then `openDrawer()`, `prewarmVariants()`, document click listener, `processCartIconCandidates(document.body)`.

5. **When drawer is opened (openDrawer in cart-pro-v2.js)**
   - If !drawerUIMounted: `ensureDrawerDOM(root)` (CartProUI.ensureDrawerDOM), attach overlay/close/checkout listeners, drawerUIMounted = true.
   - Build `currentUpsellProducts`, `syntheticDecision` (crossSell, freeShippingRemaining: computeFreeShippingRemaining(v2Cart) → 0, milestones: [], enableCouponTease from config).
   - `openDrawerUI()` (CartProUI.openDrawer).
   - `safeRender(v2Cart, syntheticDecision, getUiConfig(), getCapabilities())` → `renderInitial(cart, syntheticDecision, uiConfig, capabilities)`.

6. **renderInitial (cart-pro-ui.js)**
   - If refs.root && uiConfig: **applyUIConfig(refs.root, uiConfig)**.
   - options = { showMilestones, enableCrossSell, enableFreeShippingBar } from uiConfig.
   - **renderMilestones(syntheticDecision, options)**.
   - Countdown display from uiConfig.countdownEnabled.
   - If no cart items: renderEmptyCart, clear subtotal, clear rec inner, **renderShippingBar("ready", syntheticDecision, cart, uiConfig, options)**, **updateRecommendationUI(...)**, updateMilestoneProgress; return.
   - Else: build item elements, append to items-inner, **renderSubtotalBlock**, **renderShippingBar("ready", syntheticDecision, cart, uiConfig, options)**, **updateRecommendationUI(...)**, updateMilestoneProgress, **attachCartListeners**.

### Exact function call order (first paint when drawer opens)

1. ensureDrawerDOM(root)  
2. openDrawerUI()  
3. safeRender → renderInitial  
   - applyUIConfig(refs.root, uiConfig)  
   - renderMilestones(syntheticDecision, options)  
   - (if items) renderSubtotalBlock  
   - renderShippingBar("ready", syntheticDecision, cart, uiConfig, options)  
   - updateRecommendationUI(syntheticDecision, options, false, capabilities.onRecAdd)  
   - updateMilestoneProgress(cart, syntheticDecision, uiConfig)  
   - (if items) attachCartListeners(cart, capabilities)

---

## 1C — Exact V2 Shipping Bar Logic

**Sources:** `cart-pro-ui.js`: renderShippingBar (281–309), updateFreeShippingAndSavings (331–378), isSafeDecision (135–141). V2 does not use computeFreeShippingRemaining for threshold (it returns 0); threshold logic is inside the UI.

### renderShippingBar(state, data, cart, uiConfig, options)

- **state === "loading":**
  - Clear shipping skeleton children; append `.cp-skeleton.cp-skeleton-bar` and `.cp-skeleton.cp-skeleton-text` to skeleton; set skeleton `aria-hidden="false"`; set shipping content `display: none`; return.
- **Else (ready):**
  - Set skeleton `aria-hidden="true"`.
  - Remove `cp-msg-visible` from refs.freeShippingMsgEl.
  - If **isSafeDecision(data)** (no crossSell or no freeShippingRemaining): set freeShippingMsgEl text to `getUIText("You're eligible for free shipping on qualifying orders.", uiConfig)`, display block, add `cp-msg-visible`, hide savings; else call **updateFreeShippingAndSavings(cart, data, uiConfig, options)**.
  - Set shipping content `style.display = ""`, add class `cp-fade-in` to content.

### updateFreeShippingAndSavings(cart, syntheticDecision, uiConfig, options)

- If options.enableFreeShippingBar === false or no cart items: hide message and savings, return.
- remainingCents = syntheticDecision.freeShippingRemaining (number); threshold = remainingCents > 0 ? cart.total_price + remainingCents : 0; unlocked = threshold > 0 && remainingCents <= 0.
- If threshold <= 0: clear message, hide message and savings, return.
- Else: freeShippingMsgEl display block. remaining = max(0, threshold - cart.total_price); pct = (remaining / threshold) * 100.
  - **Unlocked:** message = "🎉 FREE Shipping Unlocked!"; savings visible, text = "You saved " + formatMoney(FREE_SHIPPING_SAVINGS_CENTS, currency).
  - **Else:** savings hidden; message by pct: >50% "You're close. Add a little more to unlock FREE shipping."; ≥10% "Almost there! Just $X more 🚀"; else "So close 🔥 Only $X left!" (getUIText for emoji strip).
- Then add `cp-msg-visible` to freeShippingMsgEl (via requestAnimationFrame or sync).

### computeFreeShippingRemaining(cart) — in cart-pro-v2.js

- Always returns **0**. So in the V2 storefront, syntheticDecision.freeShippingRemaining is always 0; threshold becomes 0 and the “unlocked”/remaining branches in updateFreeShippingAndSavings are never used; isSafeDecision is true, so the bar always shows the single line: "You're eligible for free shipping on qualifying orders." (with cp-msg-visible).

### DOM mutations and class toggles

- Skeleton: children replaced; aria-hidden true/false.
- Shipping content: display none vs ""; class `cp-fade-in` added.
- freeShippingMsgEl: textContent set; display block/none; class `cp-msg-visible` added (required for opacity 1).
- savingsMsgEl: textContent set; display block/none.

### Skeleton logic

- Shown only when state === "loading". Contains one bar and one text div with `.cp-skeleton`, `.cp-skeleton-bar`, `.cp-skeleton-text`. CSS in cart-pro.css: `.cp-shipping-skeleton[aria-hidden="false"]` display flex; `[aria-hidden="true"]` display none.

---

## 1D — Exact V2 Coupon Tease Logic

**In cart-pro-ui.js + cart-pro-v2.js (authoritative V2):**

- The DOM contains `#cart-pro-coupon-banner.cp-coupon-banner` and refs.couponBannerEl is set. **No function in cart-pro-ui.js or cart-pro-v2.js sets this element’s text or adds `cp-coupon-banner-visible`.** So in the authoritative V2 stack, the coupon tease banner is never shown or populated.

**In cart-pro.js (legacy V1) — for reference:**

- **updateCouponBanner():** If !couponBannerEl return. If !decisionState.enableCouponTease: clear text, remove `cp-coupon-banner-visible`, set aria-hidden="true", return. Else: use milestones, secondThreshold = milestones[1].amount; show banner only when total >= secondThreshold with hardcoded text `getUIText("🎁 EXTRA10 auto-applied — You saved " + saved)`; add `cp-coupon-banner-visible` and `cp-fade-in`, set aria-hidden="false". So in V1, the **element that receives text** is `#cart-pro-coupon-banner`; **visibility** is toggled by class **cp-coupon-banner-visible**; **config flag** is enableCouponTease; **message source** is hardcoded, not from snapshot.

---

## 1E — Exact V2 Styling System

- **CSS variables:** Applied in **applyUIConfig(root, uiConfig)** to **root** (#cart-pro-root): `--cp-primary`, `--cp-accent`, `--cp-radius`. Root is the shadow host; variables inherit into the shadow tree.
- **Layout/visibility:** **cart-pro.css** (linked in document in embed) defines layout and component styles. It is not injected into the shadow root; the shadow root only gets CRITICAL_CSS from cart-pro-ui.js. So cart-pro.css must apply to the document (e.g. :root) and/or to the host; in practice the host is in the document and the shadow DOM inherits from it. Key classes:
  - **Visibility:** `.cp-free-shipping-msg { opacity: 0 }`, `.cp-free-shipping-msg.cp-msg-visible { opacity: 1 }`; `.cp-coupon-banner { display: none; max-height: 0; opacity: 0; ... }`, `.cp-coupon-banner.cp-coupon-banner-visible { display: block; max-height: 60px; opacity: 1 }`.
  - **Layout:** #cart-pro-root, #cart-pro, #cart-pro-overlay, #cart-pro-drawer, #cart-pro-footer, .cp-shipping-container, .cp-shipping-skeleton, .cp-shipping-content, .cp-coupon-section, .cp-checkout-container, etc.
- **CRITICAL_CSS** (in cart-pro-ui.js): Injected into shadow root; defines #cart-pro, .open, #cart-pro-overlay, #cart-pro-drawer open state (position, transform, pointer-events, opacity). So the shadow host is styled by the host’s inline style; the inner structure is styled by CRITICAL_CSS inside shadow and by cart-pro.css (which applies via document; inheritance into shadow works for custom properties and possibly for some selectors depending on how the stylesheet is loaded).

---

# PART 2 — Audit V3 UI Implementation

## 2A — Exact V3 Drawer DOM Structure

**Sources:** DrawerV2.svelte, ShippingSection.svelte, CouponSection.svelte, CheckoutSection.svelte, Recommendations.svelte, Milestones.svelte, CartItems.svelte.

### Full hierarchy (Svelte output)

- **Host:** Created in mount.ts: `#revstack-v3-root` (not the block’s `#cart-pro-v3-root`). Shadow root attached to this host; inside it: one `<style>`, then `#cart-pro-v3-app`, and the App component tree.

App.svelte renders (when drawer open):

```
#cart-pro.open (class bound to drawerOpen)
  #cart-pro-overlay
  #cart-pro-drawer
    #cart-pro-header
      #cart-pro-title
      #cart-pro-close
    <Milestones />
    <CartItems />
    #cart-pro-recommendations (from Recommendations.svelte)
    #cart-pro-footer
      <CouponSection />   → cp-coupon-tease (if teaseMessage && !applied.length), cp-coupon-section, #cart-pro-coupon-banner (empty)
      <CheckoutSection /> → #cart-pro-subtotal, <ShippingSection />, .cp-checkout-container (#cart-pro-checkout, #cart-pro-countdown)
#cart-pro-confetti-layer
```

ShippingSection (inside CheckoutSection) when showBar:

```
.cp-shipping-container#cart-pro-shipping-container
  [if loading] #cart-pro-shipping-skeleton + .cp-skeleton-bar, .cp-skeleton-text
  [else] #cart-pro-shipping-msg.cp-free-shipping-msg (no .cp-shipping-content wrapper; no #cart-pro-savings)
```

### Differences vs V2 structure

| V2 | V3 |
|----|-----|
| #cart-pro-root = host | #revstack-v3-root = host (block’s #cart-pro-v3-root unused) |
| .cp-shipping-content wraps #cart-pro-shipping-msg and #cart-pro-savings | No .cp-shipping-content; no #cart-pro-savings |
| #cart-pro-shipping-msg gets cp-msg-visible | #cart-pro-shipping-msg never gets cp-msg-visible |
| #cart-pro-coupon-banner (never filled in V2 ui; in V1 filled + cp-coupon-banner-visible) | #cart-pro-coupon-banner always empty; tease in .cp-coupon-tease |
| Footer: coupon section → coupon banner → subtotal → shipping container → checkout | Same order but ShippingSection is conditional (showBar = threshold != null); coupon tease is separate element |

---

## 2B — Exact V3 Rendering Pipeline

1. **embed_v3.liquid**
   - Renders `<div id="cart-pro-v3-root"></div>`.
   - Loads `<script src="{{ 'cart-pro-v3.js' | asset_url }}" defer></script>`.
   - Inline: `fetch('/apps/cart-pro/snapshot/v3', { credentials: 'same-origin' })` → `.then(res => res.json())` → `applyAppearanceAndLoadConfig(config)`.

2. **applyAppearanceAndLoadConfig(config)** (inline)
   - If `window.__applyCartProAppearance` and `window.CartProV3Engine`: call both with config, sessionStorage.setItem('cart-pro-v3-config', JSON.stringify(config)).
   - Else setTimeout 50ms retry.

3. **cart-pro-v3.js (mount)**
   - mountCartProV3(componentCss): getEngine(), ensureBodyHost() → host id `revstack-v3-root`, shadow root, inject style (componentCss), create #cart-pro-v3-app, optional sessionStorage bootstrap (loadConfig + applyAppearanceVariables), **new App({ target: appContainer, props: { engine } })**, injectHideOtherCartsStyle().

4. **App.svelte**
   - onMount: engine.enqueueEffect(async () => await engine.syncCart()).
   - Renders DrawerV2 with state from engine.stateStore (cart, discount, rewards, upsell, checkout, shipping, ui.drawerOpen). DrawerV2 contains CartItems, Recommendations, Milestones, CouponSection, CheckoutSection. CheckoutSection receives freeShippingMsg/savingsMsg computed in App (shippingMsg/savingsMsg) and includes ShippingSection.

5. **Engine**
   - loadConfig(rawConfig) only when applyAppearanceAndLoadConfig runs (after snapshot). syncCart() runs from App onMount effect; it reads this.config (freeShipping.thresholdCents, etc.) and updates state.shipping. If syncCart runs before loadConfig, state.shipping stays with remaining: null, unlocked: false.

6. **State → Svelte**
   - stateStore updates (cart, shipping, discount, upsell, etc.) drive reactive statements in DrawerV2, ShippingSection, CouponSection, Recommendations. No equivalent to V2’s renderShippingBar/updateFreeShippingAndSavings/updateCouponBanner call sequence; everything is reactive from state.

### Exact order (simplified)

- Script load → mountCartProV3 (engine, host, shadow, style, cache read, App mount).
- App onMount → enqueue syncCart (may run with config still default/null).
- Snapshot fetch completes → applyAppearanceAndLoadConfig → __applyCartProAppearance(config), engine.loadConfig(config), sessionStorage write. No automatic re-run of syncCart.
- User opens drawer → DrawerV2 renders from current state; ShippingSection shows only if threshold != null; no cp-msg-visible; coupon tease from config in .cp-coupon-tease.

---

## 2C — Exact V3 Shipping Bar Logic (ShippingSection.svelte)

- **DOM:** One wrapper `.cp-shipping-container#cart-pro-shipping-container` when showBar. Inside: either skeleton (when shipping.loading) or a single `#cart-pro-shipping-msg.cp-free-shipping-msg` in two cases: (subtotalAtOrAboveThreshold || shipping.unlocked) → "Free shipping unlocked"; (remainingCents != null && remainingCents > 0) → "Add {formatCurrency(remainingCents)} more for free shipping". No `.cp-shipping-content` wrapper, no `#cart-pro-savings`, no fallback "You're eligible for free shipping on qualifying orders.", no `cp-msg-visible` class.
- **Message logic:** Derived from engine.getConfig().freeShipping.thresholdCents and stateStore.shipping (remaining, unlocked, loading). No getUIText/emoji; copy is shorter.
- **Class toggles:** None for visibility; CSS still has .cp-free-shipping-msg opacity 0 and .cp-msg-visible opacity 1, but V3 never adds cp-msg-visible, so message can stay invisible.
- **Missing vs V2:** .cp-shipping-content, #cart-pro-savings, cp-msg-visible, "You're eligible for free shipping on qualifying orders.", "🎉 FREE Shipping Unlocked!", "You saved $X", and the three tiered messages ("You're close...", "Almost there! Just $X more 🚀", "So close 🔥 Only $X left!").

---

## 2D — Exact V3 Coupon Tease Logic (CouponSection.svelte)

- **Element that shows tease:** `.cp-coupon-tease#cp-coupon-tease` when `teaseMessage && applied.length === 0`; content is `{teaseMessage}` from `engine.getConfig()?.discounts?.teaseMessage`.
- **Class used:** `cp-coupon-tease` (not cp-coupon-banner). `#cart-pro-coupon-banner.cp-coupon-banner` is rendered empty after the coupon section; no content or `cp-coupon-banner-visible` is ever set.
- **Missing vs V2 (V1-style):** V2 authoritative stack never fills the banner; if targeting V1 parity, the banner would use cp-coupon-banner-visible and show text in #cart-pro-coupon-banner. V3 uses a different node and different class, so styling and DOM diverge.

---

## 2E — Exact V3 Styling System

- **Host:** #revstack-v3-root (created in mount.ts). Variables applied in applyAppearanceVariables(host, config) from config?.appearance (primaryColor, accentColor, borderRadius) plus --cp-primary-hover, --cp-primary-active, --cp-accent-hover, --cp-gradient.
- **Variable injection:** Only when __applyCartProAppearance(config) is called (after snapshot or from cache). Block’s div is #cart-pro-v3-root; runtime does not use it.
- **CSS scope:** cart-pro-v2.css (and any other component CSS) is concatenated and injected into the shadow root as one style block. Variables set on the host inherit. :host/:root in that CSS refer to shadow context; fallbacks use --cp-*.
- **Differences vs V2:** Host ID different (#revstack-v3-root vs #cart-pro-root); extra variables; same core --cp-primary, --cp-accent, --cp-radius. Shipping message never gets cp-msg-visible. Coupon uses .cp-coupon-tease (different style) instead of .cp-coupon-banner/.cp-coupon-banner-visible.

---

# PART 3 — Why Cart Preview Renders Correctly But the Drawer Does Not

## Which UI path preview uses

- **Cart preview** (admin): Rendered by **CartPreview** (React) in `app/routes/app.settings.tsx`. Data comes from **generatePreviewDecision(shop, admin, undefined, config, catalog)** in `preview-simulator.server.ts`, which returns a V2-style **decision** (crossSell, milestones, freeShippingRemaining, ui, etc.). CartPreview is a React component that replicates the intended cart layout (360px drawer, sections for items, recommendations, shipping, coupon, checkout) and uses the same **section structure and copy** as the intended V2 design. It does **not** use cart-pro-ui.js; it is a separate implementation that was built to **match** the V2 look and behavior for the settings preview.

## Which UI path drawer uses

- **Storefront drawer (V2 embed):** Uses **cart-pro-ui.js** + **cart-pro-v2.js**. DOM is built by ensureDrawerDOM + DRAWER_MARKUP; content by renderInitial → renderShippingBar, updateRecommendationUI, etc. Snapshot from `/apps/cart-pro/snapshot/v2`.
- **Storefront drawer (V3 embed):** Uses **DrawerV2.svelte** and its children (ShippingSection, CouponSection, Recommendations, CheckoutSection, etc.) — the Svelte bundle (cart-pro-v3.js). Snapshot from `/apps/cart-pro/snapshot/v3`. This is a **different code path** from cart-pro-ui.js.

## Divergence point

- **Preview** looks correct because it is a dedicated React component that was designed to mirror the V2 drawer’s layout and copy (and is fed decision-shaped data). It is not the same code as the storefront.
- **Drawer** when using the **V3** embed is rendered entirely by **Svelte** (DrawerV2.svelte and children). That Svelte tree does **not** replicate the exact DOM, class toggles, or message logic of **cart-pro-ui.js**. So:
  - **Preview (correct):** CartPreview (React) + generatePreviewDecision → same structure/copy as intended V2.
  - **Drawer (incorrect when V3):** DrawerV2.svelte (Svelte) → different structure, missing cp-msg-visible, different coupon element, different messages, config/timing issues (syncCart before loadConfig).

So: **preview** uses a V2-equivalent (React) implementation and data shape; **drawer** on V3 uses a different implementation (Svelte) that was never brought to parity with V2. The exact divergence is: **storefront V3 drawer is not an exact clone of the V2 UI (cart-pro-ui.js) DOM, classes, or logic.**

---

# PART 4 — Exact Root Causes of Visual Mismatch

**ROOT CAUSE 1 — Shipping bar: container/content and visibility class**  
**File:** `cart-pro-v3-runtime/src/ui/v2/ShippingSection.svelte`  
**Function:** Template (reactive block)  
**Reason:** V3 does not render `.cp-shipping-content` or `#cart-pro-savings`; and it never adds `cp-msg-visible` to `#cart-pro-shipping-msg`. CSS keeps `.cp-free-shipping-msg { opacity: 0 }` until `.cp-msg-visible` is present, so the message can stay invisible.

**ROOT CAUSE 2 — Shipping bar: fallback message and copy**  
**File:** `cart-pro-v3-runtime/src/ui/v2/ShippingSection.svelte`  
**Reason:** V3 only shows the bar when `threshold != null` and has no branch for “no threshold / safe decision” with the fallback "You're eligible for free shipping on qualifying orders." Copy is shortened ("Free shipping unlocked", "Add $X more for free shipping") and does not match V2’s emoji/tiered messages or savings line.

**ROOT CAUSE 3 — Shipping bar: config/state timing**  
**File:** `cart-pro-v3-runtime/src/engine/Engine.ts` (syncCart), mount/embed order  
**Reason:** state.shipping is set only in syncCart(). If the first syncCart runs before loadConfig(snapshot), threshold is null and the bar is hidden; loadConfig does not re-trigger syncCart, so state can remain wrong until the next cart event.

**ROOT CAUSE 4 — Coupon tease: wrong element and class**  
**File:** `cart-pro-v3-runtime/src/ui/v2/CouponSection.svelte`  
**Reason:** V3 renders tease text in `.cp-coupon-tease` and leaves `#cart-pro-coupon-banner` empty. V2 (and V1 updateCouponBanner) use `#cart-pro-coupon-banner` with `cp-coupon-banner-visible`. Different DOM node and class cause different styling and behavior.

**ROOT CAUSE 5 — Styling: host ID**  
**File:** `revstack/cart-pro-v3-runtime/src/mount.ts`, `cart_pro_embed_v3.liquid`  
**Reason:** Block renders `#cart-pro-v3-root`; runtime uses `#revstack-v3-root`. Any theme or external CSS targeting the block’s div never applies to the actual host.

**ROOT CAUSE 6 — DOM structure: footer/shipping**  
**File:** `cart-pro-v3-runtime/src/ui/v2/CheckoutSection.svelte`, `ShippingSection.svelte`  
**Reason:** V2 footer has fixed order and always includes .cp-shipping-content wrapping message + savings. V3 conditionally renders ShippingSection and omits the wrapper and savings element, so DOM and layout differ.

**ROOT CAUSE 7 — Recommendations: data source**  
**File:** Engine syncCart / loadConfig; Recommendations.svelte  
**Reason:** Snapshot v3 returns `recommendations` (full product data); runtime does not write it to state. Recommendations.svelte uses state.upsell.standard (rule-based) and state.upsell.aiRecommendations, which lack title/image/price, so cards can appear blank or wrong (separate from shipping/coupon but part of overall drawer mismatch).

---

# PART 5 — Exact Migration Plan to Clone V2 UI in V3

## Step 1 — DOM migration plan

| Replace (V3) | With structure from (V2) |
|--------------|--------------------------|
| ShippingSection.svelte output | cart-pro-ui.js: .cp-shipping-container → .cp-shipping-skeleton (when loading) + .cp-shipping-content (always when not loading) containing #cart-pro-shipping-msg and #cart-pro-savings. Same IDs and classes. |
| CouponSection.svelte tease output | Use #cart-pro-coupon-banner.cp-coupon-banner for tease text when enabled; add/remove cp-coupon-banner-visible. Optionally keep .cp-coupon-tease only if design explicitly wants a second style; for V2 clone, single banner element. |
| DrawerV2.svelte footer order | Match V2: coupon section → #cart-pro-coupon-banner → #cart-pro-subtotal → .cp-shipping-container (skeleton + content) → .cp-checkout-container. |
| Host ID (optional for theme CSS) | Either have runtime use the block’s div (#cart-pro-v3-root) as host, or document that theme must target #revstack-v3-root. Prefer one canonical host ID and align block with it. |

## Step 2 — Logic migration plan

- **renderShippingBar equivalent:** Port logic from cart-pro-ui.js renderShippingBar and updateFreeShippingAndSavings into V3. Options: (a) a small “V2 shipping” module called from a Svelte action or from Engine after syncCart/loadConfig, which mutates the same DOM nodes (by ID); or (b) Svelte components that output the exact same DOM and classes and take “state” and “options” (enableFreeShippingBar, etc.) from engine/config, and a single place that sets cp-msg-visible (e.g. after setting text, in next tick or requestAnimationFrame). Ensure “loading” shows skeleton; “ready” shows content; isSafeDecision equivalent shows "You're eligible for free shipping on qualifying orders." and adds cp-msg-visible; else compute remaining/unlocked and set message + savings + cp-msg-visible.
- **updateCouponBanner equivalent:** If targeting V1-style coupon tease: when config has tease enabled and (optional) conditions, set #cart-pro-coupon-banner text and add cp-coupon-banner-visible; otherwise clear and remove class. Drive from engine.getConfig() and state (e.g. discount.applied). If targeting only V2 authoritative (no banner): leave banner empty; else port from cart-pro.js updateCouponBanner (element + class + message source).
- **applyUIConfig equivalent:** Already partially done in mount applyAppearanceVariables. Ensure it runs on the same host that shadows the drawer and sets only --cp-primary, --cp-accent, --cp-radius for strict V2 parity (optionally keep extra vars for backward compat).
- **updateRecommendationUI equivalent:** Keep or port V2’s “You may also like” + rec list structure and card markup so that when state has recommendation data (including from snapshot.recommendations if wired), the same DOM/cards render. Ensure Engine or snapshot writes recommendations into state so that Recommendations.svelte receives full product data.

**Integration with stateStore:** Keep Engine as data provider. After syncCart (and after loadConfig when config was just applied), call the ported “render” helpers with (cart, syntheticDecision, uiConfig, options) or pass the same data via state so that Svelte (or the ported DOM updaters) produce V2-identical output. Option: add a “drawer content ready” flag set after first loadConfig + syncCart so that the first paint never shows with null threshold.

## Step 3 — CSS migration plan

- **Copy or replace:** Use V2’s **cart-pro.css** as the styling authority for the drawer. Either (1) replace the current drawer CSS in the V3 bundle with the contents of cart-pro.css (and CRITICAL_CSS if not already inlined), or (2) diff cart-pro.css with cart-pro-v2.css and add any missing rules (e.g. .cp-free-shipping-msg, .cp-msg-visible, .cp-savings-msg, .cp-coupon-banner, .cp-coupon-banner-visible, .cp-shipping-skeleton, .cp-shipping-content) so that the same selectors and class names yield identical layout and visibility.
- **Scope:** Ensure the CSS is injected into the same shadow root that contains the drawer markup and that the host has the chosen ID and variables (--cp-primary, --cp-accent, --cp-radius). No duplicate or conflicting rules for .cp-free-shipping-msg (opacity 0 by default, 1 with .cp-msg-visible).

## Step 4 — Rendering integration plan

- **Engine as data provider:** Engine continues to own config (loadConfig), cart (syncCart), and state (stateStore). Add or preserve a “synthetic decision” or equivalent (crossSell, freeShippingRemaining, enableCouponTease, etc.) either in config or derived in syncCart so that the UI has the same inputs as V2’s renderInitial.
- **When to “render”:** On every state update that affects the drawer (cart, config, shipping, discount), run the ported V2-style updaters (or Svelte reactivity that mirrors them): applyUIConfig on host; renderShippingBar(ready, data, cart, uiConfig, options); updateCouponBanner equivalent; updateRecommendationUI equivalent. Ensure first run happens after loadConfig (and ideally after first syncCart) so that threshold and messages are correct.
- **Re-sync after config load:** When applyAppearanceAndLoadConfig runs, after loadConfig(config), trigger a syncCart (or set a flag that the next effect run will use the new config) so that state.shipping and bar visibility are updated immediately.

---

# PART 6 — Clipboard Migration Blueprint (Exact Mapping)

| V2 file / symbol | V3 file / replacement |
|------------------|------------------------|
| cart-pro-ui.js (drawer DOM + refs) | DrawerV2.svelte + children: ensure same IDs/classes as DRAWER_MARKUP (header, milestones, items, recommendations, footer, coupon section, coupon banner, subtotal, shipping container, skeleton, content, msg, savings, checkout, countdown). |
| cart-pro-ui.js ensureDrawerDOM | mount.ts already creates host + shadow; ensure one canonical host ID and that Svelte output matches DRAWER_MARKUP structure. |
| cart-pro-ui.js renderShippingBar | ShippingSection.svelte (or a dedicated V2ShippingBar module): output .cp-shipping-container, .cp-shipping-skeleton, .cp-shipping-content, #cart-pro-shipping-msg, #cart-pro-savings; add cp-msg-visible when showing message; implement loading vs ready and isSafeDecision + updateFreeShippingAndSavings logic. |
| cart-pro-ui.js updateFreeShippingAndSavings | Inline in ShippingSection or shared helper: same message/savings text and display/class toggles; call from “render” path when state/config available. |
| cart-pro-ui.js applyUIConfig | mount.ts applyAppearanceVariables: restrict to --cp-primary, --cp-accent, --cp-radius on host for parity. |
| cart-pro.js updateCouponBanner (if cloning V1 tease) | CouponSection.svelte or shared helper: set #cart-pro-coupon-banner text and cp-coupon-banner-visible; clear/hide when disabled. |
| cart-pro-ui.js updateRecommendationUI | Recommendations.svelte + RecommendationCard.svelte: same heading “You may also like”, .cp-recommendations-content, .cp-rec-list, card structure; feed from state that includes snapshot recommendations (wire snapshot.recommendations into state). |
| cart-pro.css | cart-pro-v2.css (or replace with cart-pro.css): same rules for .cp-free-shipping-msg, .cp-msg-visible, .cp-savings-msg, .cp-shipping-container, .cp-shipping-skeleton, .cp-shipping-content, .cp-coupon-banner, .cp-coupon-banner-visible, .cp-coupon-section, .cp-checkout-container, and all drawer layout. |
| cart_pro_embed.liquid (#cart-pro-root) | cart_pro_embed_v3.liquid: use same host ID as runtime (e.g. #revstack-v3-root) or have runtime use block’s div so one ID is canonical. |
| cart-pro-v2.js getUiConfig / syntheticDecision | Engine: expose or derive uiConfig and syntheticDecision (crossSell, freeShippingRemaining, enableCouponTease, etc.) from config + cart so the ported render functions get the same inputs. |

---

**End of document. No code was modified.**
