# Cart UX Phase 3 — Green Flash, Confetti, Smooth Load, Performance

## PART 1 — Remove Default Green Flash (Cart Theme Hydration)

### Trace (where default color / theme / decision update UI)

| Location | Role |
|----------|------|
| **Default color** | `cart-pro.css` `:root { --cp-accent: #16a34a }` (was green; now `#555555`). `cart-pro.js` `SAFE_UI.accentColor` (was `#16a34a`; now `#555555`). |
| **Theme config** | Section Liquid sets `data-accent-color`, `data-primary-color`, `data-border-radius` on `#cart-pro-root`. JS reads `sectionConfig` from `root.dataset.*`. |
| **Decision response** | `/apps/cart-pro/decision` returns `ui: { accentColor, primaryColor, borderRadius, ... }`. On response, `applyUIConfig(d.ui)` is called (in `fetchDecisionSafe` and `applyDecisionDelta`). |
| **Inline script** | None. Theme is from Liquid `data-*` and/or decision API. |

### Confirmed

- **Theme color source:** Decision response (from Redis/ShopConfig) and/or **Liquid** (Theme customizer → `data-accent-color` etc. on `#cart-pro-root`). No inline script.
- **Cart render vs theme:** Cart DOM is built in `init()`; CSS is applied from stylesheet. Theme was applied only after decision fetch, so first paint used CSS default (green) → **green flash**. Now theme is bootstrapped before first paint (see below).

### Fix implemented (Option B + C)

1. **Pre-inject theme (Option B)**  
   - **Liquid:** Cart Pro embed block now has optional settings: `accent_color`, `primary_color`, `border_radius`. They are output as `data-accent-color`, `data-primary-color`, `data-border-radius` on `#cart-pro-root`. Default accent in schema is neutral `#555555`.  
   - **JS:** Right after defining `sectionConfig`, we call `applyUIConfig({ primaryColor, accentColor, borderRadius })` using `sectionConfig` (with `SAFE_UI` fallbacks). So the **first paint** uses theme from Liquid when set.

2. **CSS variable bootstrap (Option C)**  
   - **Neutral default:** `:root` and `SAFE_UI.accentColor` use `#555555` instead of `#16a34a`. So when neither Liquid nor decision has provided accent yet, the UI shows neutral, not green.  
   - **No repaint from default green:** When decision returns, `applyUIConfig(d.ui)` updates `--cp-accent` etc. on `#cart-pro-root`; no flash from green.

### Before/after render flow

- **Before:** HTML → load CSS (`--cp-accent: #16a34a`) → JS runs → build shadow DOM → open drawer → skeleton → fetch cart + decision → decision resolves → `applyUIConfig(d.ui)` → green → possible switch to brand color = **green flash**.  
- **After:** HTML with optional `data-accent-color` (or none) → load CSS (`--cp-accent: #555555`) → JS runs → **immediate `applyUIConfig(sectionConfig + SAFE_UI)`** → build shadow DOM (already correct or neutral) → open drawer → skeleton → fetch cart + decision → decision resolves → `applyUIConfig(d.ui)` (only changes if different). No visible default green; optional theme from Liquid avoids any neutral flash for stores that set it.

### Acceptance

- No visible default green before correct color (neutral or Liquid/decision theme).  
- No added render delay; theme is applied synchronously at script init.

---

## PART 2 — Confetti Layering Fix

### Trace

- **Confetti:** `fireConfettiFromElement(el)` created a container and appended it to **shadowRoot** with `z-index: 1000000`.  
- **Cart:** `#cart-pro` contains `#cart-pro-overlay` (z-index 2147483647) and `#cart-pro-drawer` (z-index 2147483648). Both create stacking context; overlay covers the viewport.  
- **Result:** Confetti (1e6) was **below** overlay (2147483647), so it appeared behind the cart.

### Fix (dedicated top-level layer — Option B)

- **Layer:** A dedicated `#cart-pro-confetti-layer` div was added in the **same shadow root**, **after** the `#cart-pro` wrapper, with `position: fixed; inset: 0; pointer-events: none; z-index: 2147483649`.  
- **Rendering:** Confetti is appended to `shadowRoot.getElementById("cart-pro-confetti-layer")` (fallback: `shadowRoot`).  
- **Z-index scale:** Overlay 2147483647, drawer 2147483648, confetti layer 2147483649. Confetti is always above overlay and drawer.

### DOM hierarchy

```
#cart-pro-root (host)
  └── #shadow-root
        ├── <style> (critical)
        ├── #cart-pro
        │     ├── #cart-pro-overlay (z: 2147483647)
        │     └── #cart-pro-drawer (z: 2147483648)
        └── #cart-pro-confetti-layer (z: 2147483649)
              └── .cp-confetti-container (when active)
```

### Acceptance

- Confetti is visible above the cart overlay and drawer.  
- Overlay/drawer behavior unchanged.

---

## PART 3 — Smooth Decision Load

### Trace (decision flow in frontend)

1. **Open drawer** → `openDrawer()` → `renderSkeleton()` → `loadCart()`.  
2. **loadCart** (debounced) → `loadCartReal()` → fetch `/cart.js` → `renderInitial(cart, decisionForRender)` with optimistic/cached or `SAFE_DECISION` → then `fetchDecisionSafe(cart)` in background.  
3. **Decision returns** → `applyDecisionDelta(...)` → updates milestones, cross-sell, shipping, coupon, and calls `applyUIConfig(ui)`.  
4. **Rerenders:** Delta updates (milestones, recs, shipping bar, coupon) without full DOM replace; `renderInitial` only on full cart load.

### Change (no abrupt content shift)

- **150 ms fade on content mount:** When the drawer is open and we replace the skeleton with real content (first time after open), we add the existing `cp-fade-in` class (150 ms opacity ease-out) to the content areas: items list, recommendations inner, and shipping content. The class is removed after 160 ms so it doesn’t affect later updates.  
- **Reserved layout:** Existing `min-height` on shipping and recommendations containers is unchanged, so no layout snap when decision fills them.  
- **Skeleton:** Skeleton remains in place until cart + (optimistic or safe) decision is available, then we swap to real content with the short fade.

### Flow (high level)

```
Open drawer → Skeleton (shimmer) → Fetch cart → renderInitial(cart, optimistic|SAFE)
  → Content areas get cp-fade-in (150 ms) → Decision fetch in background
  → applyDecisionDelta → Only specific sections update (no full redraw)
```

### Acceptance

- No layout snap when decision resolves.  
- No abrupt content shift; 150 ms fade on first content paint.

---

## PART 4 — Perceived Performance

### Audits and changes

| Area | Change |
|------|--------|
| **Decision fetch** | Unchanged (prewarm, cache, single in-flight). |
| **Rapid cart updates** | **Debounce:** Public `loadCart()` is debounced (120 ms). First call runs immediately; further calls within the window coalesce into one `loadCartReal()`. Reduces duplicate work when multiple events fire (e.g. cart:updated, icon clicks). |
| **Full rerender** | Already avoided: `applyDecisionDelta` updates only milestones, cross-sell, shipping, coupon UI; full `renderInitial` only on full cart load. |
| **Static sections** | Drawer structure is built once in `init()`; only inner content (items, recs, shipping) is updated. No new memoization added. |

### Acceptance

- Optimized: debounced `loadCart`, no extra full rerenders.  
- No regression: same behavior for overlay, focus trap, and decision logic.

---

## PART 5 — Final Acceptance Criteria

After Phase 3:

| Criterion | Status |
|----------|--------|
| No default green flash | Done: neutral default + theme bootstrap from Liquid/SAFE_UI at init; decision updates when available. |
| Confetti always visible above cart | Done: confetti rendered in dedicated layer with z-index above overlay/drawer. |
| Cart load feels instant | Done: skeleton + optimistic/cached decision + 150 ms content fade; debounce avoids duplicate loads. |
| No visual jump when decision resolves | Done: delta updates only; reserved min-heights; no full content replace. |
| No flicker on open/close | Unchanged; no new flicker introduced. |
| Performance equal or better | Done: debounce reduces redundant work; no added blocking. |
| Tests pass | No backend or business-logic change; client-only and theme extension changes. |
| No business logic changed | Confirmed: only theme bootstrap, confetti mount point, fade-on-mount, and loadCart debounce. |

---

## Files Touched

- **revstack/extensions/cart-pro/blocks/cart_pro_embed.liquid** — Theme settings (accent, primary, radius); data attributes on `#cart-pro-root`.  
- **revstack/extensions/cart-pro/assets/cart-pro.css** — Neutral default `--cp-accent`; fallbacks; `cp-fade-in` (existing) used for content.  
- **revstack/extensions/cart-pro/assets/cart-pro.js** — Theme bootstrap at init; `sectionConfig.primaryColor`; `SAFE_UI` neutral accent; confetti layer markup and mount; `loadCart` debounce and `loadCartReal`; first-content-paint fade.  
- **docs/CART_UX_PHASE3_DELIVERABLE.md** — This deliverable.
