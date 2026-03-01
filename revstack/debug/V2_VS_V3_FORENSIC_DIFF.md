# V2 vs V3 Cart Drawer — Forensic Diff Report

**Purpose:** Audit and clone preparation. Identifies ALL visual, structural, and rendering differences between the V2 cart drawer and the V3 cart drawer. No runtime modifications—forensic visibility only.

**Debug page:** `revstack/debug/v2-vs-v3.html` — side-by-side render with forensic logging. Serve from repo root (e.g. `npx serve revstack` or open from `revstack/debug/`) so relative paths to `../archived-extensions/` and `../extensions/cart-pro/assets/` resolve. V2 uses **cart-pro.css** only (no separate cart-pro-v2.css in archived).

---

## 1. DOM structure diff

### V2 (cart-pro-ui.js + cart-pro-v2.js)

- **Host:** `#cart-pro-root` (document) → `attachShadow({ mode: 'open' })`
- **Shadow children (order):**
  1. `<style>` (CRITICAL_CSS from cart-pro-ui.js)
  2. `<div id="cart-pro">` (overlay + drawer)
     - `#cart-pro-overlay`
     - `#cart-pro-drawer` → header, milestones, items, recommendations, footer (coupon, subtotal, shipping, checkout, countdown)
  3. `<div id="cart-pro-confetti-layer">` (sibling of `#cart-pro`, same shadow root)

**Notes:** V2 applies `cart-pro.css` in the document (link); critical CSS is also injected into the shadow root. CSS variables are set on `#cart-pro-root` via `applyUIConfig(root, uiConfig)` (e.g. `--cp-primary`, `--cp-accent`, `--cp-radius`).

### V3 (cart-pro-v3 runtime)

- **Host:** `#revstack-v3-root` (document) → shadow root
- **Shadow children (order):**
  1. `<style>` (global + component CSS inlined at build)
  2. `<div id="cart-pro-v3-app">` (Svelte app root)
     - DrawerV2 renders: `#cart-pro` → overlay, `#cart-pro-drawer`, then `#cart-pro-confetti-layer` as sibling inside the same component tree (inside shadow)

**Notes:** V3 uses `cart-pro-v2.css` (in `src/styles/`) and Svelte component CSS. Appearance variables are set on `#revstack-v3-root` via `applyAppearanceVariables(host, config)` in `mount.ts`. V3 also sets `--cp-gradient`, `--cp-primary-hover`, `--cp-primary-active`, `--cp-accent-hover` on the host; V2 does not.

### Structural differences

| Item | V2 | V3 |
|------|----|----|
| Root ID | `#cart-pro-root` | `#revstack-v3-root` |
| App container | None (direct shadow children) | `#cart-pro-v3-app` |
| Confetti layer | Sibling of `#cart-pro` in shadow | Sibling of drawer content in shadow (same component) |
| Host CSS vars | `--cp-primary`, `--cp-accent`, `--cp-radius` only | Same + `--cp-gradient`, `--cp-*-hover`, `--cp-*-active` |

---

## 2. CSS computed diff (key properties)

Run **Run forensic audit** on `v2-vs-v3.html` with both drawers open to get live values. Below are the **source-level** differences that drive computed style.

### 2.1 Drawer panel (`#cart-pro-drawer`)

| Property | V2 (cart-pro.css) | V3 (cart-pro-v2.css) |
|----------|-------------------|------------------------|
| background | `#ffffff` | `var(--cp-surface)` |
| box-shadow | `-12px 0 40px rgba(0,0,0,0.25)` | `-12px 0 40px var(--cp-shadow)` |
| border-left | `1px solid rgba(0,0,0,0.06)` | `1px solid var(--cp-border)` |
| backdrop-filter | `blur(12px)` | `blur(12px)` |

V2 uses hardcoded hex/rgba; V3 uses semantic variables (with fallbacks in `:host`/`:root` in cart-pro-v2.css).

### 2.2 Overlay (`#cart-pro-overlay`)

| Property | V2 | V3 |
|----------|----|----|
| background | `rgba(0,0,0,.5)` (cart-pro.css) | `var(--cp-overlay)` (default `rgba(0,0,0,0.5)`) |

### 2.3 Checkout button (`.cp-checkout-btn` / `#cart-pro-checkout`)

| Property | V2 (cart-pro.css) | V3 (cart-pro-v2.css) |
|----------|-------------------|------------------------|
| background | `linear-gradient(270deg, var(--cp-primary), var(--cp-accent), var(--cp-primary))` + animation | Same gradient + animation |
| box-shadow | `0 10px 25px rgba(0, 0, 0, 0.2)` | `0 10px 25px var(--cp-shadow)` |
| hover box-shadow | `0 14px 32px rgba(0, 0, 0, 0.25)` | `0 14px 32px var(--cp-shadow)` |

V2 uses fixed rgba for shadows; V3 uses `--cp-shadow`.

### 2.4 Shipping / free-shipping message (`.cp-shipping-container`, `.cp-free-shipping-msg`)

- Same structural role. V2: `.cp-free-shipping-msg` has `opacity: 0` by default, `.cp-msg-visible` sets `opacity: 1`. V3: same pattern in cart-pro-v2.css.

### 2.5 Coupon banner (`.cp-coupon-banner`)

| Property | V2 (cart-pro.css) | V3 (cart-pro-v2.css) |
|----------|-------------------|------------------------|
| color | `#1a5f2a` | `var(--cp-accent)` |
| background | `linear-gradient(135deg, rgba(76, 175, 80, 0.12), rgba(76, 175, 80, 0.06))` | `linear-gradient(135deg, color-mix(in srgb, var(--cp-accent) 12%, transparent), color-mix(in srgb, var(--cp-accent) 6%, transparent))` |
| border | `1px solid rgba(76, 175, 80, 0.4)` | `1px solid color-mix(in srgb, var(--cp-accent) 40%, transparent)` |
| box-shadow | `0 0 12px rgba(76, 175, 80, 0.2)` | `0 0 12px color-mix(in srgb, var(--cp-accent) 20%, transparent)` |

**Root cause:** V2 uses fixed green palette; V3 uses theme-driven `--cp-accent` and `color-mix()`.

### 2.6 Countdown (`.cp-countdown`)

| Property | V2 | V3 |
|----------|----|----|
| color | `#666` | `var(--cp-text)` |
| .cp-countdown-urgent color | `#c62828` | `var(--cp-error)` |

---

## 3. Variable diff (CSS custom properties)

### V2

- **Set by:** `applyUIConfig(root, uiConfig)` in `cart-pro-ui.js` on `#cart-pro-root`.
- **Variables set:** `--cp-primary`, `--cp-accent`, `--cp-radius` only.
- **Default (cart-pro.css :root):** `--cp-primary: #111111`, `--cp-accent: #555555`, `--cp-radius: 12px`.

### V3

- **Set by:** `applyAppearanceVariables(host, config)` in `mount.ts` on `#revstack-v3-root`.
- **Variables set:** `--cp-primary`, `--cp-accent`, `--cp-radius`, `--cp-primary-hover`, `--cp-primary-active`, `--cp-accent-hover`, `--cp-gradient` (linear-gradient from primary to accent).
- **Fallbacks in cart-pro-v2.css:** `:host, :root` define `--cp-bg`, `--cp-surface`, `--cp-text`, `--cp-border`, `--cp-shadow`, `--cp-overlay`, `--cp-error` (defaults like `#111827`, `#16a34a`, etc.).

**Propagation:** In V2, `#cart-pro-root` is in the document; the shadow root inherits from it. In V3, `#revstack-v3-root` is the host; the shadow root inherits from the host. So both rely on host-level vars propagating into shadow.

---

## 4. Gradient diff

### .cp-checkout-btn

| Source | Rule |
|--------|------|
| V2 (cart-pro.css) | `background: linear-gradient(270deg, var(--cp-primary), var(--cp-accent), var(--cp-primary));` + `background-size: 400% 400%` + `animation: cpGradientShift 6s ease infinite` |
| V3 (cart-pro-v2.css) | Same (identical). |

**Resolved value:** Depends on `--cp-primary` and `--cp-accent` on host. Use `getComputedStyle(btn).backgroundImage` in forensic log to compare.

### .cart-pro-rec-add (recommendation add button)

| Source | Rule |
|--------|------|
| V2 (cart-pro.css) | `background: var(--cp-primary);` (no gradient) |
| V3 (cart-pro-v2.css) | Same (solid `--cp-primary`). |

### .cp-milestone-progress (milestone track)

| Source | Rule |
|--------|------|
| V2 (cart-pro.css) | `.cp-milestone-track`: `background: linear-gradient(to right, var(--cp-accent, #555555) 0%, var(--cp-accent, #555555) var(--cp-fill-pct), #eee var(--cp-fill-pct));` |
| V3 (cart-pro-v2.css) | `background: linear-gradient(to right, var(--cp-accent) 0%, var(--cp-accent) var(--cp-fill-pct), var(--cp-border) var(--cp-fill-pct));` |

**Diff:** V2 fallback fill is `#eee`; V3 uses `var(--cp-border)`.

### .cp-countdown

- No gradient in either; text color only (see Variable diff).

### .cp-coupon-banner

- See §2.5: V2 fixed green gradient; V3 `color-mix(in srgb, var(--cp-accent) ...)`.

### .cp-milestone-track.cp-shimmer::after

| V2 (cart-pro.css) | V3 (cart-pro-v2.css) |
|-------------------|------------------------|
| `linear-gradient(90deg, rgba(255,255,255,0) 0%, rgba(255,255,255,0.5) 50%, rgba(255,255,255,0) 100%)` | `linear-gradient(90deg, color-mix(in srgb, var(--cp-surface) 0%, transparent) 0%, color-mix(in srgb, var(--cp-surface) 40%, transparent) 50%, ...)` |

V3 uses `--cp-surface` and `color-mix`; V2 uses fixed white rgba.

---

## 5. Opacity diff

- **Overlay:** Both use opacity 0 → 1 when open (same).
- **.cp-free-shipping-msg:** Both use opacity 0 → 1 with `.cp-msg-visible` (same).
- **.cp-coupon-banner:** Both use max-height/opacity transition when visible (same).
- **Disabled buttons:** Both use `opacity: 0.65` (same).

No material opacity divergence beyond what’s driven by variable/color differences.

---

## 6. Filter / backdrop-filter diff

- **#cart-pro-drawer:** Both use `backdrop-filter: blur(12px)`.
- **.cp-milestone-unlocked .cp-milestone-emoji:** Both use `filter: brightness(0) invert(1)`.

No filter diff between V2 and V3 for these elements.

---

## 7. z-index and stacking context diff

| Element | V2 | V3 |
|---------|----|----|
| #cart-pro / host | z-index: 2147483647 | Host #revstack-v3-root: 10000000 (mount.ts) |
| #cart-pro-overlay | 2147483647 | 2147483647 (inside shadow) |
| #cart-pro-drawer | 2147483648 | 2147483648 |
| #cart-pro-confetti-layer | 2147483649 | 2147483649 |

**V3 host:** `ensureBodyHost()` sets `zIndex: '10000000'` on `#revstack-v3-root`. The shadow content uses the same high z-index as V2 for overlay/drawer/confetti layer. Stacking is consistent within each version; the host z-index is lower in V3 (10000000 vs 2147483647).

---

## 8. Confetti diff (full pipeline)

### V2 (cart-pro-ui.js + cart-pro-v2.js)

- **DOM:** `#cart-pro-confetti-layer` is created in the shadow root (cart-pro-ui.js: markup + `ensureDrawerDOM`). Inline style: `position:fixed;inset:0;pointer-events:none;z-index:2147483649`.
- **Trigger:** In the **cart-pro-v2.js** stack there is **no confetti trigger**. The confetti **firing** logic lives in **cart-pro.js** (V1): `firePremiumConfetti()`, `shouldShowConfetti()`, session state for add-to-cart and milestone. So in the **UI + V2-only** embed (no cart-pro.js), the confetti layer exists but is never used.
- **If we consider cart-pro.js (V1):** Confetti uses `canvas-confetti` (CDN), `getConfettiInstance()` creates a canvas inside the confetti layer; `firePremiumConfetti()` runs on add-to-cart or milestone. Container: same `#cart-pro-confetti-layer` in shadow; z-index 2147483649; pointer-events: none.

### V3 (DrawerV2.svelte)

- **DOM:** `#cart-pro-confetti-layer` is rendered in the shadow DOM (DrawerV2.svelte) with the same inline style (z-index 2147483649, pointer-events: none).
- **Trigger:** `rewards.showConfetti` from engine state; when true, `runConfetti(onDone)` is called.
- **Implementation:** `runConfetti()` creates a div with class `rewards-confetti-container`, fills it with `.rewards-confetti-piece` divs (animated with CSS), and appends it to **`document.body`** (light DOM), not to `#cart-pro-confetti-layer`. Container is removed after 2200 ms.
- **z-index:** `.rewards-confetti-container` has `z-index: 9999` (in DrawerV2.svelte style block). The host `#revstack-v3-root` has `z-index: 10000000`. So the confetti container (on body) has **lower** z-index than the host and can render **behind** the cart overlay/drawer.
- **Parent stacking:** Confetti is in document body; cart is in shadow under a host with z-index 10000000. So confetti can appear behind the drawer unless the host or body stacking is adjusted.

**Exact root causes (confetti):**

1. **V2 (UI+v2 only):** Confetti layer exists; no trigger in cart-pro-v2.js (trigger is in cart-pro.js).
2. **V3:** Confetti pieces are appended to `document.body` with z-index 9999; host is 10000000 → confetti can be behind the drawer.
3. **V3:** Confetti layer `#cart-pro-confetti-layer` in shadow is present but not used as the parent for the confetti container; the container is in body.

---

## 9. Summary: exact root causes

| Category | Root cause |
|----------|------------|
| **DOM** | V3 wraps drawer in `#cart-pro-v3-app`; V2 has no app wrapper. Confetti layer is sibling of `#cart-pro` in both. |
| **Variables** | V2 sets only `--cp-primary`, `--cp-accent`, `--cp-radius` on host; V3 also sets `--cp-gradient`, hover/active variants and uses more semantic vars in CSS (`--cp-surface`, `--cp-shadow`, `--cp-border`, `--cp-text`, `--cp-error`, `--cp-overlay`). |
| **Gradients** | Checkout button same; coupon banner and milestone shimmer use fixed green/white in V2 vs `var(--cp-accent)`/`var(--cp-surface)` + `color-mix` in V3. |
| **Brightness/colors** | Coupon/countdown/milestone use hardcoded colors in V2 vs semantic vars in V3 → different look for non-primary/accent themes. |
| **Confetti** | V2 (UI+v2): layer exists, no trigger. V3: trigger exists; confetti DOM is on body with z-index 9999 < host 10000000 → stacking risk; `#cart-pro-confetti-layer` in shadow is unused for confetti content. |
| **Box-shadow** | V2 uses rgba(); V3 uses `var(--cp-shadow)` (and other vars) → same when vars match; different when theme differs. |

---

## 10. How to use the forensic page

1. Serve or open `revstack/debug/v2-vs-v3.html` (same-origin for V2 script/CSS if needed).
2. Click **Open V2 Drawer** then **Open V3 Drawer** (mock cart is used for V2).
3. Click **Run forensic audit**.
4. Review the log for:
   - `getComputedStyle` for `#cart-pro-drawer`, `#cart-pro-checkout`, `.cp-checkout-btn`, `.cp-shipping-container`, `.cp-free-shipping-msg`, `.cp-coupon-banner`, `#cart-pro-confetti-layer`
   - Properties: `background`, `backgroundImage`, `filter`, `opacity`, `mixBlendMode`, `transform`, `zIndex`, `boxShadow`, `backdropFilter`
   - CSS variable resolution: `--cp-primary`, `--cp-accent` (and others) on host and on elements
   - Confetti layer existence and computed z-index/pointer-events/opacity

This gives a full forensic snapshot for clone preparation without modifying the V3 runtime.
