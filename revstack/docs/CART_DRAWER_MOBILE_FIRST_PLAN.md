# Cart Drawer — Mobile-First Implementation Plan

This document outlines the plan to optimize the Cart Pro V3 drawer for mobile with a **mobile-first** approach: styles and behavior are designed for small viewports first, then enhanced for desktop. All changes live in the storefront widget (`cart-pro-v3-runtime`) and its shared styles.

---

## 1. Goals

- **Mobile-first**: Default layout and touch targets suit phones; larger viewports get enhancements (e.g. fixed drawer width, hover states).
- **Full usability on small screens**: Drawer uses full width on mobile; no horizontal overflow; content and CTAs are easy to tap and read.
- **Respect system UI**: Safe-area insets for notches and home indicator; stable height when mobile browser chrome shows/hides.
- **Touch-native feel**: Swipe-to-close, appropriate tap target sizes, smooth scrolling.
- **Performance**: Avoid heavy effects on low-end devices where possible.

---

## 2. Design Decisions

| Decision | Choice | Rationale |
|----------|--------|------------|
| **Breakpoint** | `768px` for "mobile" vs "desktop" | Common convention; aligns with many theme breakpoints. |
| **Drawer width (mobile)** | `100%` (full-screen) | Maximizes content area and feels native; no 360px overflow. |
| **Drawer width (desktop)** | `360px` with `max-width: 100%` | Keeps current desktop width; max-width prevents edge cases. |
| **Viewport height** | Prefer `100dvh` with `100vh` fallback | Dynamic viewport reduces jump when mobile URL bar shows/hides. |
| **Tap target minimum** | 44px (height/width) for primary controls | Meets accessibility and touch guidelines. |
| **Swipe-to-close** | Optional; right-edge drag to close | Familiar pattern; implement so it doesn’t conflict with horizontal scroll in recommendations. |
| **Safe areas** | `env(safe-area-inset-*)` on drawer edges | Avoids content under notch/home indicator. |
| **Backdrop blur (mobile)** | Optional: disable or reduce in media query | Reduces GPU cost on low-end phones. |

---

## 3. Current State Summary

- **Drawer**: `DrawerV2.svelte`; styles in `cart-pro.css` and `cart-pro-v2.css`. No media queries; drawer is fixed `360px` on all viewports.
- **Scroll**: `#cart-pro-scroll.cp-drawer-scroll` has `-webkit-overflow-scrolling: touch`; footer is sticky.
- **Close**: Overlay click + close button + Escape; no swipe.
- **Host**: `mount.ts` sets host to `100vw` / `100vh`; drawer uses `max-height: 100vh`.
- **Tap targets**: Close ~18–20px; checkout 42px; qty/remove and rec "Add" vary.
- **No safe-area** or `dvh` usage today.

---

## 4. Implementation Phases

### Phase 1: Responsive drawer and viewport (required)

**1.1 Drawer width — mobile full-screen, desktop 360px**

- **Files**: `revstack/cart-pro-v3-runtime/src/styles/cart-pro.css`, `cart-pro-v2.css`
- **Approach**: Mobile-first.
  - **Default (mobile)**: `#cart-pro-drawer` uses `width: 100%`, `max-width: 100%`, `height: 100%`, `max-height: 100dvh` (with fallback below). Border-radius `0` on mobile for full-screen feel.
  - **Desktop**: Add `@media (min-width: 769px)` (or 768px) where you set `width: 360px`, `max-width: 100%`, and restore border-radius (e.g. `var(--cp-radius) 0 0 var(--cp-radius)`).
- **Viewport height**: In the same block, set `max-height: 100dvh` (and in a separate rule for older browsers `max-height: 100vh` as fallback, or use `min(100vh, 100dvh)` if supported).
- **Host (mount.ts)**: Optionally set host height to `100dvh` with `100vh` fallback so overlay matches visible viewport when URL bar toggles.
  - **File**: `revstack/cart-pro-v3-runtime/src/mount.ts` — where `host.style.height = '100vh'` is set, consider a small inline script or CSS variable so that on supporting browsers we use `100dvh` (e.g. via a class or style that sets `height: 100dvh; height: 100vh` for fallback).

**1.2 Safe-area insets**

- **Files**: Same CSS files.
- Add padding to the drawer panel (or inner wrapper) so content stays out of notch and home indicator:
  - `padding-top: env(safe-area-inset-top, 0);`
  - `padding-bottom: env(safe-area-inset-bottom, 0);`
  - `padding-right: env(safe-area-inset-right, 0);` (drawer is right-aligned)
- Ensure header and footer (especially checkout button) sit inside the safe area; add padding to `#cart-pro-header` and `#cart-pro-footer` if the drawer itself doesn’t have a single padding wrapper.

**Acceptance**: On viewport &lt; 769px the drawer is full width with no horizontal scroll; on ≥769px it’s 360px. Height remains usable when mobile browser chrome changes. Content avoids notch/home indicator on notched devices.

---

### Phase 2: Tap targets and touch-friendly UI (required)

**2.1 Minimum 44px tap targets**

- **Files**: `cart-pro.css`, `cart-pro-v2.css` (and component-level styles if any).
- **Elements to adjust** (mobile-first; use same or larger on desktop):
  - **Close button** (`#cart-pro-close`): Min size 44×44px; increase padding so hit area is at least 44px. Keep icon visually similar.
  - **Checkout button** (`#cart-pro-checkout` / `.cp-checkout-btn`): Set `min-height: 48px` (already 42px; bump for mobile in base or in a shared rule).
  - **Qty +/- buttons** (`.qty-btn` or equivalent): Min 44×44px touch target (can use padding + smaller visual icon).
  - **Remove item button**: Min 44px in the dimension users tap.
  - **Recommendation “Add” buttons** (`.cart-pro-rec-add`): Min height 44px; padding to match.
  - **Empty state CTA** (`.cp-empty-state-cta`): Min height 44px.
- Use `min-width` / `min-height` and padding; avoid shrinking the visible label/icon if possible.

**2.2 Header and footer spacing (mobile)**

- In the mobile block (or default), increase header/footer padding slightly so content breathes (e.g. header `padding: 12px 16px`, footer `padding: 16px`). Ensure close button remains clearly tappable.

**Acceptance**: All primary interactive elements have at least 44px touch target on mobile (and desktop where applicable).

---

### Phase 3: Swipe-to-close (optional)

**3.1 Gesture handling**

- **File**: `revstack/cart-pro-v3-runtime/src/ui/v2/DrawerV2.svelte`
- **Behavior**: When user drags the drawer to the right (toward close), if the drag exceeds a threshold (e.g. 50px) or a velocity threshold, close the drawer; otherwise snap back.
- **Implementation outline**:
  - Add `touchstart` / `touchmove` / `touchend` (and optionally `mousedown` / `mousemove` / `mouseup` for desktop) on the drawer panel or a dedicated “drag handle” (e.g. a thin bar in the header).
  - Track `clientX` at start and on move; compute delta. Only consider horizontal movement (ignore vertical to avoid fighting scroll).
  - During drag: apply `transform: translateX(…)` so the drawer follows the finger (cap at 0 so it doesn’t go left).
  - On release: if `translateX` &gt; threshold (e.g. 50px) or velocity right is high, call existing close logic (`handleClose`); else animate back to `translateX(0)`.
- **Conflict avoidance**: Start the gesture only from the header or a narrow strip so horizontal scroll in recommendations doesn’t trigger close. Use a small “handle” area (e.g. top 40px of the drawer) or a visible drag handle bar.

**3.2 Optional: visual drag handle**

- **Files**: `DrawerV2.svelte`, CSS.
- Add a small horizontal bar (e.g. 36×4px, rounded) centered in the header area on mobile only (e.g. visible in `@media (max-width: 768px)`). This signals “swipe down/close” and gives a clear start zone for the gesture.

**Acceptance**: User can close the drawer by swiping right from the header/handle area; drawer doesn’t close accidentally when scrolling recommendations.

---

### Phase 4: Footer, keyboard, and scroll behavior (required on mobile)

**4.1 Footer visibility when coupon input is focused**

- **File**: `DrawerV2.svelte` (and possibly `CouponSection.svelte` if it owns the input).
- When the coupon/footer input receives focus, ensure the footer (and checkout button) stays visible above the virtual keyboard:
  - Option A: After focus, scroll the scroll container so that the footer is in view (e.g. `#cart-pro-scroll.scrollTop` so that the footer is at the bottom of the visible area). Use `requestAnimationFrame` or `setTimeout` after focus so layout has updated.
  - Option B: Listen to `visualViewport.resize` and add bottom padding to the drawer or scroll area equal to `window.visualViewport.height` vs `window.innerHeight` so the footer is pushed up. Option A is simpler and often sufficient.

**4.2 Sticky footer and safe area**

- Ensure `#cart-pro-footer` has `padding-bottom: env(safe-area-inset-bottom, 0)` so the checkout button isn’t hidden behind the home indicator. If the footer is sticky at bottom, the padding keeps the CTA above the safe area.

**Acceptance**: Tapping the coupon input doesn’t leave the checkout button hidden behind the keyboard; footer respects safe area on notched devices.

---

### Phase 5: Performance and polish (optional)

**5.1 Backdrop blur on mobile**

- **Files**: `cart-pro.css`, `cart-pro-v2.css`
- In `@media (max-width: 768px)`, set `backdrop-filter: none` (and if needed `background` to solid) on `#cart-pro-drawer` to reduce GPU cost. Keep blur for desktop in the `min-width: 769px` block.

**5.2 Reduce motion**

- Respect `prefers-reduced-motion: reduce` for the drawer open/close transition (shorter or no animation). Same for swipe-to-close if implemented.

**5.3 Recommendations carousel on small screens**

- **Files**: CSS for `.cp-rec-list` and recommendation cards.
- In mobile breakpoint, optionally:
  - Slightly increase card size or padding for easier tap.
  - Ensure scroll-snap and `-webkit-overflow-scrolling: touch` are set (already in place); verify no layout overflow.

**Acceptance**: No jank on low-end mobile; reduced motion respected; recommendations remain usable on small screens.

---

### Phase 6: Host viewport height (optional but recommended)

**6.1 Dynamic viewport height for host**

- **File**: `revstack/cart-pro-v3-runtime/src/mount.ts`
- When setting the host size, use CSS that prefers dynamic viewport:
  - e.g. set `host.style.height = '100vh'` and add a style or class that sets `height: 100dvh` with fallback: a small injected style tag in the document or shadow root: `#cart-pro-root { height: 100dvh; height: 100vh; }` so the overlay never extends under the browser UI.
- Alternatively, set the host’s height in JS from `window.visualViewport.height` and listen to `resize` on `visualViewport` to update when the keyboard or URL bar changes. Prefer CSS `dvh` first for simplicity.

**Acceptance**: Overlay and drawer height stay correct when the mobile browser’s URL bar or keyboard opens or closes.

---

## 5. File Checklist

| File | Changes |
|------|--------|
| `cart-pro-v3-runtime/src/styles/cart-pro.css` | Mobile-first base; `@media (min-width: 769px)` for desktop; safe-area; tap targets; optional blur off on mobile. |
| `cart-pro-v3-runtime/src/styles/cart-pro-v2.css` | Same as above (keep in sync or refactor to shared variables). |
| `cart-pro-v3-runtime/src/mount.ts` | Optional: host height 100dvh/100vh; or inject CSS for it. |
| `cart-pro-v3-runtime/src/ui/v2/DrawerV2.svelte` | Swipe-to-close (optional); footer scroll-into-view or viewport handling when coupon focused. |
| `cart-pro-v3-runtime/src/ui/v2/CouponSection.svelte` | Optional: emit focus/blur or trigger scroll-into-view from parent. |
| `cart-pro-v3-runtime/src/styles/cart-pro-v3.css` | If this is used by the live drawer, apply same mobile-first and safe-area rules to `.drawer-panel` / `#cart-pro-drawer` there. |

---

## 6. Testing

- **Viewports**: 375×667, 390×844, 414×896 (common phones); 768 and 1024 for tablet/desktop.
- **Devices**: iOS Safari (notch, home indicator, keyboard), Android Chrome (keyboard, nav bar).
- **Checks**: Drawer full width on mobile, 360px on desktop; no horizontal overflow; all CTAs ≥44px; swipe-to-close from header only; footer visible when coupon focused; safe areas respected; no content under notch/home indicator; height stable when URL bar toggles.

---

## 7. Order of Implementation (recommended)

1. **Phase 1** — Responsive drawer + safe area + viewport height (required).
2. **Phase 2** — Tap targets and spacing (required).
3. **Phase 4** — Footer/keyboard and safe area for footer (required).
4. **Phase 6** — Host/viewport height refinement (recommended).
5. **Phase 3** — Swipe-to-close (optional).
6. **Phase 5** — Blur, reduced motion, carousel polish (optional).

This order delivers a solid mobile-first experience first, then adds gestures and performance tweaks.
