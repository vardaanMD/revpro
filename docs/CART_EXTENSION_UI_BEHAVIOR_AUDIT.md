# Full UI Behavior Audit — Cart Extension Runtime

**Scope:** Diagnosis only. No fixes, no refactor, no logic change. Pure trace analysis.

**Objective:** Trace why (1) confetti does not render visibly, (2) shipping progress bar position customization does not apply, (3) haptics do not trigger, (4) brand color option does not apply, (5) previous UI work did not reflect in storefront.

---

## 1. Brand color flow

### 1.1 Where brand color is stored

| Layer | Location | Fields |
|-------|----------|--------|
| **Prisma** | `revstack/prisma/schema.prisma` | `ShopConfig.primaryColor` (String?), `ShopConfig.accentColor` (String?) |
| **ShopConfig** | `getShopConfig(shop)` → Prisma + in-memory cache (5 min TTL) | `config.primaryColor`, `config.accentColor`; defaults from `DEFAULT_SHOP_CONFIG` in `default-config.server.ts` (`#111111`, `#16a34a`) |
| **Settings route** | `revstack/app/routes/app.settings.tsx` | Form fields `primaryColor`, `accentColor`; saved via settings action → `settings-validation.server.ts` → Prisma update; `invalidateShopConfigCache(shop)` on save |

### 1.2 Where brand color is injected into decision response

| Location | Logic |
|----------|--------|
| **cart.decision.ts** | After billing gate: `response.ui = capabilities.allowUIConfig ? { primaryColor: config.primaryColor ?? null, accentColor: config.accentColor ?? null, ... } : SAFE_UI_FALLBACK` (lines 606–617). |
| **SAFE_UI_FALLBACK** | `primaryColor: null`, `accentColor: null` (lines 119–128). Used when **not entitled** or on any error/timeout path. |
| **Capabilities** | `allowUIConfig` is **true** only for **advanced** and **growth** plans; **false** for **basic** (`capabilities.server.ts`). So for Basic plan, response.ui is always SAFE_UI_FALLBACK and never contains DB brand colors. |

### 1.3 What frontend uses for color

- **Mechanism:** CSS custom properties set on the host element `#cart-pro-root` (the shadow host). `cart-pro.js` calls `root.style.setProperty("--cp-primary", ...)` and `root.style.setProperty("--cp-accent", ...)`. Shadow DOM inherits these from the host.
- **CSS consumption:** `revstack/extensions/cart-pro/assets/cart-pro.css` uses `var(--cp-primary)`, `var(--cp-accent)` (e.g. buttons, progress bar, borders). Defaults in `:root` are `#111111` and `#555555`.
- **No inline styles** for brand color; no hardcoded default in JS beyond fallback string `"#111111"` / `"#555555"` inside `applyUIConfig`.

### 1.4 applyUIConfig and priority

- **cart-pro.js** `applyUIConfig(ui)` (lines 66–74):
  - `--cp-primary` = `sectionConfig.primaryColor || u.primaryColor || "#111111"`
  - `--cp-accent` = `sectionConfig.accentColor || u.accentColor || "#555555"`
- **sectionConfig** comes from **Liquid** `data-primary-color` / `data-accent-color` on `#cart-pro-root` (embed block settings in `cart_pro_embed.liquid`). So **Liquid (theme) wins over decision payload** when set.
- When decision returns `primaryColor: null` (e.g. SAFE_UI_FALLBACK), expression becomes `"" || null || "#111111"` → `"#111111"`. So fallback color is applied; DB brand color is **not** used when `allowUIConfig` is false.

### 1.5 Initial render path

- **Bootstrap (before decision):** Right after defining `sectionConfig`, `applyUIConfig({ primaryColor: sectionConfig.primaryColor || SAFE_UI.primaryColor, accentColor: sectionConfig.accentColor || SAFE_UI.accentColor, borderRadius: ... })` runs. So first paint uses Liquid if set, else SAFE_UI (`#111111`, `#555555`).
- **After decision:** `fetchDecisionSafe(cart)` → on response, `if (d && d.ui) applyUIConfig(d.ui)`. So when decision loads, UI config (including colors) is applied again. Cart is already rendered; color update is just CSS variable change on `root`.

### 1.6 Flow diagram: DB → decision → frontend

```
DB (ShopConfig.primaryColor / accentColor)
  → getShopConfig(shop) [cache 5 min]
  → billing.isEntitled && capabilities.allowUIConfig ?
       → response.ui = { primaryColor: config.primaryColor ?? null, accentColor: config.accentColor ?? null, ... }
       → else response.ui = SAFE_UI_FALLBACK (primaryColor: null, accentColor: null)
  → Decision cache (memory + Redis, key by shop + cart hash) may return cached response with older ui
  → Frontend: fetchDecisionSafe → d.ui → applyUIConfig(d.ui)
  → applyUIConfig: root.style.setProperty("--cp-primary", sectionConfig.primaryColor || u.primaryColor || "#111111")
  → Shadow DOM CSS uses var(--cp-primary) / var(--cp-accent)
```

### 1.7 Where color is lost (findings)

| # | Break point | Explanation |
|---|-------------|-------------|
| 1 | **Plan = Basic** | `allowUIConfig: false` → response.ui is SAFE_UI_FALLBACK → primaryColor/accentColor always null → frontend uses fallback "#111111"/"#555555". **Brand color from DB never sent for Basic plan.** |
| 2 | **DB null** | If merchant never saved brand color, config.primaryColor/accentColor are null; decision still sends null; applyUIConfig yields fallback. |
| 3 | **Decision cache** | Cached decision (memory or Redis, up to 60s) returns previous response; if config was updated in admin, storefront can show old ui until cache TTL or cart change. |
| 4 | **Liquid override** | If theme embed sets data-primary-color/data-accent-color, sectionConfig wins in applyUIConfig; decision payload is ignored for those properties. |
| 5 | **Frontend reads correct property** | Frontend does read `d.ui.primaryColor` and `d.ui.accentColor` and passes them to applyUIConfig; no bug in property name. |

**Conclusion (brand color):** Backend sends correct `primaryColor`/`accentColor` only when `capabilities.allowUIConfig` is true (Advanced/Growth). For Basic, backend intentionally sends null (SAFE_UI_FALLBACK). Frontend applies whatever it receives; priority is Liquid > decision > hardcoded fallback. Main break point: **entitlement (allowUIConfig)** and/or **cached decision** and/or **Liquid overrides**.

---

## 2. Confetti flow

### 2.1 Where confetti component lives

| Item | Location |
|------|----------|
| **File** | `revstack/extensions/cart-pro/assets/cart-pro.js` |
| **Layer markup** | In `drawerMarkup` string: `<div id="cart-pro-confetti-layer" aria-hidden="true" style="position:fixed;inset:0;pointer-events:none;z-index:2147483649;"></div>` (line 1077). |
| **Mount** | In `init()`: `confettiLayerEl = wrap.children[1]`; `shadowRoot.appendChild(confettiLayerEl)`. So confetti layer is a **sibling** of `#cart-pro` (the overlay + drawer wrapper), both direct children of the shadow root. |
| **Render condition** | Confetti is **not** always rendered. It is created and appended only when `fireConfettiFromElement(el)` is called. |

### 2.2 Trigger logic

- **Function:** `fireConfettiFromElement(el)` (lines 785–836). It creates a `.cp-confetti-container` with particles and a sparkle, appends to `shadowRoot.getElementById("cart-pro-confetti-layer") || shadowRoot`, and runs a short animation.
- **Where it’s called:** Only in **one** place: inside `updateMilestones()` (line 990), when a **milestone is newly unlocked**:
  - `if (unlocked && !wasUnlocked) { newlyUnlockedMarkers.push(el); if (decisionState && decisionState.ui && decisionState.ui.showConfetti) fireConfettiFromElement(el); }`
- So confetti fires **only when the user crosses a milestone threshold** (spend-based reward), not on add-to-cart, not on free-shipping unlock, and not on any other event.
- **Condition:** `decisionState.ui.showConfetti` must be true. When backend returns **SAFE_UI_FALLBACK** (e.g. not entitled), `showConfetti: false`. So for **Basic plan**, confetti never runs. For Advanced/Growth, it depends on `config.showConfetti` from DB.

### 2.3 Render context and stacking

- **DOM hierarchy (shadow root):**
  1. `<style>` (critical CSS)
  2. `<div id="cart-pro">` (overlay + drawer; drawer z-index 2147483648)
  3. `<div id="cart-pro-confetti-layer">` (z-index 2147483649)
- Confetti layer is **after** the drawer in DOM and has **higher z-index** (2147483649 > 2147483648). So it should paint above the drawer. No transform on `#cart-pro` itself; transform is on `#cart-pro-drawer` inside it, so stacking context is as expected.
- **fireConfettiFromElement** appends the `.cp-confetti-container` to the confetti layer; container has `position:fixed; left:0; top:0; width:100%; height:100%; pointer-events:none; z-index:1` (relative to the layer). So confetti is inside the high-z-index layer and should be visible.

### 2.4 Does confetti mount? Does condition fire?

| Question | Answer |
|----------|--------|
| Does confetti layer exist in DOM? | Yes; it is created in init() and appended to shadow root. |
| Does confetti **particles** mount? | Only when `fireConfettiFromElement(el)` runs, i.e. when a milestone is newly unlocked **and** `decisionState.ui.showConfetti` is true. |
| Is condition ever true? | For Basic: `decisionState.ui` is SAFE_UI_FALLBACK → `showConfetti: false` → condition false. For Advanced/Growth: only if milestones are enabled, config has milestones, and `showConfetti` is true; and user must cross a milestone. |
| Possible stacking/visibility issue? | Unlikely from z-index; confetti layer is on top. Possible theme/parent overflow or isolation; not visible in this codebase. |

**Conclusion (confetti):** Confetti **only** runs on **milestone unlock** and only when **decisionState.ui.showConfetti** is true. For Basic plan, showConfetti is always false from the backend. So either the condition never fires (plan/feature/milestone config) or it fires but confetti is only triggered in the milestone path, not on add-to-cart or free-shipping.

---

## 3. Shipping progress bar position customization

### 3.1 Where position setting is stored

| Layer | Location |
|-------|----------|
| **DB** | `ShopConfig.shippingBarPosition` (String, default `"top"`) in `schema.prisma`. |
| **Settings** | `app.settings.tsx`: form field `shippingBarPosition` ("top" \| "bottom"); saved via settings action; validated in `settings-validation.server.ts` (enum "top" \| "bottom"). |
| **Decision** | `cart.decision.ts`: `ui.shippingBarPosition = (config.shippingBarPosition === "bottom" ? "bottom" : "top")` when `allowUIConfig` is true; else SAFE_UI_FALLBACK has `shippingBarPosition: "top"`. |

### 3.2 Where position is read in frontend

- **cart-pro.js** `moveMilestoneContainerOnce(position)` (lines 393–404):
  - Reads `ui.shippingBarPosition` from the **decision** object passed in (from `renderInitial`, `applyDecision`, or `applyDecisionDelta`).
  - If `position === "bottom"` and `footer` exists: `footer.insertBefore(milestonesEl, footer.firstChild)` (moves milestones into footer).
  - Else if milestones are in drawer: `drawer.insertBefore(milestonesEl, itemsElRef)` (moves above items).
- **Critical:** The function **runs only once per page load**: `if (milestonePositionApplied || !shadowRoot || !drawer) return;` then `milestonePositionApplied = true`. So the **first** call sets the position permanently; later calls no-op.

### 3.3 When is moveMilestoneContainerOnce first called?

- **First call:** In `renderInitial(cart, decision)` (line 1623), which runs from `loadCartReal()` with `decisionForRender = optimisticDecisionState ?? SAFE_DECISION`. So the first decision is often **SAFE_DECISION** (ui.shippingBarPosition: `"top"`) or a **cached** decision. So the first call typically gets `"top"`.
- **Second call:** When `fetchDecisionSafe(cart)` resolves, `applyDecisionDelta(prev, newDecision)` runs and calls `moveMilestoneContainerOnce(ui.shippingBarPosition)` again with the **real** decision (possibly `"bottom"`). But **milestonePositionApplied** is already true, so the function returns without moving anything.

### 3.4 Setting flow from admin to DOM

```
Admin: Settings form shippingBarPosition → save → Prisma ShopConfig.shippingBarPosition
  → getShopConfig(shop) (cache 5 min)
  → cart.decision: response.ui.shippingBarPosition = config.shippingBarPosition (when allowUIConfig)
  → Frontend: fetchDecisionSafe → applyDecisionDelta → moveMilestoneContainerOnce(ui.shippingBarPosition)
  → moveMilestoneContainerOnce: no-op because milestonePositionApplied === true (set on first render)
```

### 3.5 Break point

- **Position is applied only on the first call to moveMilestoneContainerOnce.** The first call happens during **renderInitial** with the **optimistic or SAFE_DECISION** (almost always `"top"`). When the real decision with `shippingBarPosition: "bottom"` arrives, the function is called again but exits early. So **customization to "bottom" never takes effect** unless the first decision already has "bottom" (e.g. cache hit with that value). No bug in backend or in reading the payload; the frontend **one-time** application of position is the break point.

---

## 4. Haptics flow

### 4.1 Where haptic logic exists

| Item | Location |
|------|----------|
| **File** | `revstack/extensions/cart-pro/assets/cart-pro.js` |
| **Function** | `triggerHaptic()` (lines 382–389): checks `decisionState.ui.enableHaptics === false` and returns early; else `if (navigator.vibrate) navigator.vibrate(8)`. |
| **Trigger** | `triggerHaptic()` is called from `pressBounce(el)` (line 677), which is used for button press feedback. `pressBounce(btn)` is attached to at least one button (line 2057). So haptics run on **pointerdown** on elements that use pressBounce (e.g. quantity/checkout/close). |

### 4.2 Backend vs frontend default

- **SAFE_UI_FALLBACK** (backend): `enableHaptics: false`. So when the shop is **not entitled** (Basic or error path), the decision response has `ui.enableHaptics: false`.
- **Frontend SAFE_UI**: `enableHaptics: true`. So before any decision, or when using SAFE_DECISION locally, the frontend would have enableHaptics true; but once the real decision is applied, `decisionState.ui` comes from the API, so for Basic plan `decisionState.ui.enableHaptics` is false and **triggerHaptic() returns without vibrating**.

### 4.3 Browser / environment

- **navigator.vibrate** is not supported in many desktop browsers and is often **blocked or ignored in embedded webviews** (e.g. Shopify storefront in-app browser). So even when the code path runs, vibration may not occur.
- The call is inside a **pointerdown** handler (user gesture), which is required by some implementations for vibrate to work.

### 4.4 Code path summary

| Step | Result |
|------|--------|
| User taps a button with pressBounce | pointerdown → triggerHaptic() |
| decisionState.ui.enableHaptics === false (e.g. Basic plan, SAFE_UI_FALLBACK) | triggerHaptic returns immediately; no vibrate. |
| decisionState.ui.enableHaptics !== false | navigator.vibrate(8) is called (if API exists). |
| Environment (desktop / Shopify webview) | vibrate may be unsupported or blocked; no error thrown. |

**Conclusion (haptics):** For **Basic plan**, the backend sends `enableHaptics: false`, so the frontend correctly skips vibration. For Advanced/Growth, the code path is reached when the user taps a pressBounce button; whether vibration actually occurs depends on **navigator.vibrate** support and policy in the host environment (e.g. Shopify webview).

---

## 5. Extension build / runtime check (previous UI work not reflecting)

### 5.1 How the extension is loaded

- **Type:** Shopify **theme** extension (`shopify.extension.toml`: type = "theme"). Assets are **not** built by Vite/Remix; they are **static** files under `revstack/extensions/cart-pro/assets/` (e.g. `cart-pro.js`, `cart-pro.css`).
- **Storefront load:** In `cart_pro_embed.liquid`: `<script src="{{ 'cart-pro.js' | asset_url }}" defer></script>` and `<link rel="stylesheet" href="{{ 'cart-pro.css' | asset_url }}">`. So the storefront loads extension assets via **Shopify’s asset pipeline** (asset_url). There is no separate CDN or app-hosted JS URL in this repo.
- **Theme extension publish:** For changes to appear on the storefront, the extension must be **published** (or dev theme with the extension running). If merchants use a **development theme** with `shopify theme dev`, they get the current extension assets; production themes get the last **published** version.

### 5.2 Which JS/CSS is used

- The **same** `cart-pro.js` and `cart-pro.css` in the repo are what the theme extension serves when the Cart Pro embed is enabled. There is no separate “bundled” build; the repo files are the source.
- **Caching:** Browser and Shopify may cache assets by URL. Changing the file content without changing the asset key can still show old content until cache invalidates (e.g. new deployment/version).

### 5.3 Decision endpoint and UI config

- **Endpoint:** Frontend calls `window.location.origin + "/apps/cart-pro/decision"` (POST with cart body). That is served by `apps.cart-pro.decision.ts` which re-exports `cart.decision.ts`. So the **same** decision route and logic run.
- **Decision response** includes `ui` with primaryColor, accentColor, shippingBarPosition, showConfetti, enableHaptics, etc., when `allowUIConfig` is true; otherwise SAFE_UI_FALLBACK.
- **Caching:** `decision-cache.server.ts`: in-memory + Redis by `decision:${shop}:${cartHash}` with TTL (e.g. 60s). So **stale decision** (including stale ui) can be returned until TTL expires or cart content changes (new hash).

### 5.4 Is storefront running latest build?

- **Extension:** Yes, if the theme using the extension is the one that was just deployed/published. No separate “build” step; what’s in the repo is what’s in the extension.
- **Decision:** Possibly not “latest” if (1) decision cache returns a cached response with old ui, or (2) shop config cache (getShopConfig, 5 min) returns old config so the newly computed decision still uses old primaryColor/shippingBarPosition/etc. So “previous UI work” can fail to show because of **cached decision** or **cached config**, not because of wrong JS/CSS.

### 5.5 Summary

| Check | Result |
|-------|--------|
| Extension using bundled vs repo assets | Repo assets; no separate bundle. |
| Theme extension published / dev | Must be published or dev theme running for storefront to see changes. |
| Decision endpoint returns expected ui | Yes, when allowUIConfig and config are correct; can be stale due to decision or config cache. |
| Redis/config cache | Can serve stale ui or stale config; no invalidation on admin save for decision cache (only cart hash change or TTL). |

---

## 6. Decision payload verification

### 6.1 Expected shape (from code)

From `decision-response.server.ts` and `cart.decision.ts`, the decision response has:

- **ui:**  
  `primaryColor`, `accentColor` (string | null), `borderRadius` (number), `showConfetti`, `enableHaptics`, `countdownEnabled`, `emojiMode` (boolean), `shippingBarPosition` ("top" | "bottom").

When **allowUIConfig** is true (Advanced/Growth), these come from DB/config. When false or on error, **ui** equals **SAFE_UI_FALLBACK**:

- primaryColor: null, accentColor: null, borderRadius: 12, showConfetti: false, enableHaptics: false, countdownEnabled: false, emojiMode: true, shippingBarPosition: "top".

### 6.2 How to verify live

- **Log actual response:** In `cart.decision.ts`, before returning the response (or in a dev-only branch), log `response` (or at least `response.ui`) for a given POST to `/apps/cart-pro/decision` (or `/cart.decision` with correct proxy). Alternatively, in the frontend, inside `fetchDecisionSafe` after `r.json()`, log `d` and `d.ui`.
- **Check presence:** Confirm that the payload includes `brandColor` only if you treat “brand color” as **primaryColor** (and optionally accentColor); the API does **not** use a key named `brandColor`. So check `primaryColor`, `accentColor`, `shippingBarPosition`, `showConfetti`, `hapticsEnabled` (API field name is **enableHaptics**).

### 6.3 Frontend consumption

- **cart-pro.js** uses `d.ui` and passes it to `applyUIConfig(d.ui)` and to `decisionState = d` (so `decisionState.ui.showConfetti`, `decisionState.ui.enableHaptics`, `decisionState.ui.shippingBarPosition`). So frontend expects **primaryColor**, **accentColor**, **enableHaptics** (not hapticsEnabled), **showConfetti**, **shippingBarPosition**. No mismatch in property names.

### 6.4 Interpretation

- If the **live decision JSON** does **not** contain the expected ui fields or contains SAFE_UI_FALLBACK when the merchant is on Advanced/Growth and has set colors → problem is **backend** (config load, cache, or allowUIConfig).
- If the payload **does** contain the correct values and the storefront still shows wrong behavior → problem is **frontend** (e.g. applyUIConfig not run, overridden by Liquid, or one-time application like shipping bar position).

---

## Summary table: where each behavior breaks

| Issue | Config origin | Transformed in | Consumed in | Where it breaks |
|-------|----------------|----------------|-------------|------------------|
| **Brand color** | DB (ShopConfig) + Liquid | cart.decision (when allowUIConfig) | applyUIConfig → --cp-primary/--cp-accent on root | Basic plan (allowUIConfig false); or Liquid override; or decision/config cache |
| **Confetti** | DB showConfetti | cart.decision ui | updateMilestones → fireConfettiFromElement when milestone unlock + showConfetti | Basic (showConfetti false); or confetti only on milestone unlock, not ATC/shipping |
| **Shipping bar position** | DB shippingBarPosition | cart.decision ui | moveMilestoneContainerOnce(ui.shippingBarPosition) | Frontend: position applied only once; first decision usually "top"; later "bottom" never applied |
| **Haptics** | DB enableHaptics | cart.decision ui (SAFE_UI_FALLBACK has false) | triggerHaptic() from pressBounce | Basic (enableHaptics false); or navigator.vibrate unsupported/blocked in environment |
| **Previous UI not reflecting** | Admin + extension assets | Decision + cache | Frontend | Stale decision cache; stale config cache; or extension/theme not published or cached |

---

**End of audit. No fixes or code changes made.**
