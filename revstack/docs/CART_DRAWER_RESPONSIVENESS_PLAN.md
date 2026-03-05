# Cart Drawer Responsiveness & Theme Suppression — Implementation Plan

This document gives context, the reference behavior from cart.txt, and a step-by-step plan with a **Cursor prompt** at the end to implement the fixes.

---

## 1. Context

### Problem
Sometimes after opening the Cart Pro V3 drawer, the website stops responding: the page can’t scroll and clicks don’t reach the right targets. Likely causes:

- **Body overflow** — We set `document.body.style.overflow = 'hidden'` on open and `''` on close. If the theme also uses a body class (e.g. `body.js-drawer-open { overflow: hidden }`), clearing our inline style leaves the theme’s rule in effect, so the page stays locked.
- **Theme suppression** — We inject a global style that hides theme cart/overlay (e.g. `.js-drawer-open::after`). We don’t exclude `html`/`body`, so we can affect the wrong thing; and we never skip `body`/`html` when applying inline hide in the theme connector.
- **Host pointer-events** — The host `#cart-pro-root` is always `pointer-events: none`. The inner `#cart-pro` gets `pointer-events: auto` when open, but the host stays none, so the overlay may not receive clicks and overlay-to-close can fail.

### Reference: cart.txt
The cart.txt codebase (Gokwik sidecart) handles this in a way we should mirror:

1. **Never touch `body` or `html` in hide logic** — When hiding “other cart” elements, they skip any element whose `nodeName` is `HTML` or `BODY`.
2. **Injected CSS never targets `html`/`body`** — They use `.js-drawer-open:not(html):not(body)::after` (only kill ::after on non-body elements) and append `:not(html):not(body)` to every element selector in the hide style. They also add `.main-content::after { content: none !important; display: none !important; }`.
3. **Save original overflow once, restore on close** — On config load they save `getComputedStyle(body).overflowY` (and same for `html`) to sessionStorage. On drawer open they set `overflowY = 'hidden'`. On close they restore from sessionStorage using `setProperty('overflow-y', value, 'important')` so theme rules don’t override.

Relevant cart.txt locations (for reference only; file is external):

- `hideOtherCarts`: skip when `el.nodeName !== "HTML" && el.nodeName !== "BODY"`.
- `createHideCartStyle`: `modifiedSelectors = otherSideCarts2.map(s => \`${s}:not(html):not(body)\`)`, and `.main-content::after`, `.js-drawer-open:not(html):not(body)::after`.
- Open: `bodyEl.style.overflowY = "hidden"`, same for html.
- Close: restore from `sessionStorage.getItem("body-el-overflow")` / `"html-el-overflow"` with `setProperty(..., "important")`.
- Save overflow on config load: `getComputedStyle(bodyEl).overflowY` → sessionStorage.

---

## 2. Files to Change

| File | Purpose |
|------|--------|
| `revstack/cart-pro-v3-runtime/src/mount.ts` | Injected hide style (align with cart.txt), optional host pointer-events API, save body/html overflow on bootstrap. |
| `revstack/cart-pro-v3-runtime/src/integration/themeConnector.ts` | Skip `body`/`html` in hide logic (hideElement / hideExistingOtherCarts / hideAddedOtherCartNodes). |
| `revstack/cart-pro-v3-runtime/src/ui/v2/DrawerV2.svelte` | Save overflow on first open or use saved value; on close/destroy restore with `setProperty(..., 'important')`; optionally toggle host pointer-events. |
| `revstack/cart-pro-v3-runtime/src/ui/Drawer.svelte` | Same overflow save/restore and optional host toggle if this component is still used. |

---

## 3. Implementation Steps

### Step A: Never hide or style `body`/`html` (themeConnector)

- In **themeConnector.ts**:
  - In `hideElement`: at the top, if `el === document.body || el === document.documentElement` (or `el.nodeName === 'BODY' || el.nodeName === 'HTML'`), return without applying any styles.
  - Ensure `hideExistingOtherCarts` and `hideAddedOtherCartNodes` only call `hideElement` for elements that can be hidden (the guard in `hideElement` is enough if all paths go through it).

### Step B: Injected hide style (mount.ts) — match cart.txt

- In **mount.ts** `injectHideOtherCartsStyle`:
  1. **Pseudo-elements only for drawer overlay (no body/html):**
     - Replace `.js-drawer-open::after` with `.js-drawer-open:not(html):not(body)::after`.
     - Add: `.main-content::after { content: none !important; display: none !important; }`
  2. **Element selectors:** Build a list of selectors for the “full hide” (e.g. `cart-drawer`, `#CartDrawer`, plus any from themeConnector’s DEFAULT_OTHER_CART_SELECTORS that are safe for global CSS). Append `:not(html):not(body)` to each and use that in the injected block so the hide rules never apply to `html` or `body`.
  3. Optional: extend the list to include common theme overlays (e.g. `.halo-cart-sidebar`, `#site-cart-sidebar`, `.mm-ajaxcart-overlay`, `.background-overlay`) with the same `:not(html):not(body)` safeguard.

### Step C: Body/html overflow — save once, restore on close with `!important`

- **Save:** When config is available and we’re about to lock scroll (e.g. on first drawer open or at bootstrap), if not already saved, read `getComputedStyle(document.body).overflow` (and optionally `document.documentElement`) and store in a module-level variable or sessionStorage (e.g. keys `body-el-overflow` / `html-el-overflow` with string values). Run this once (e.g. in mount after bootstrap or in DrawerV2 on first open).
- **Open:** On drawer open, set `document.body.style.overflow = 'hidden'` (and optionally `html`). Do not overwrite the saved value.
- **Close / onDestroy:** Restore body (and html if used) from the saved value. Use `document.body.style.setProperty('overflow', savedValue, 'important')`. Fallback: if no saved value, use `''` or `'visible'`. Do the same in `handleClose`, in the reactive block when `drawerOpen` becomes false, and in `onDestroy`. Prefer a single helper (e.g. `releaseBodyScroll()`) that restores both so all paths stay in sync.

### Step D: Host pointer-events (mount or DrawerV2)

- When the drawer **opens**: set the host element (`#cart-pro-root`, from `getResolvedHostElement()` or the same ref used in mount) to `pointer-events: auto`.
- When the drawer **closes** and on unmount: set it back to `pointer-events: none`.
- Implement either in mount.ts (e.g. a small API that the engine or DrawerV2 calls with open/close) or in DrawerV2.svelte in the same reactive block that handles overflow (get host by `document.getElementById('cart-pro-root')` and set `host.style.pointerEvents`).

### Step E: Optional — remove theme body class

- When opening the Cart Pro drawer, call `document.body.classList.remove('js-drawer-open')` (and any other known theme drawer class) so the theme doesn’t keep overflow or overlay. When closing, remove again. This complements the overflow restore.

---

## 4. Acceptance Criteria

- [ ] Opening the cart drawer never leaves the page stuck; closing always restores scroll.
- [ ] Clicking the overlay closes the drawer reliably (host pointer-events when open).
- [ ] No hide rules or inline styles are ever applied to `document.body` or `document.documentElement`.
- [ ] Injected CSS uses `.js-drawer-open:not(html):not(body)::after` and `:not(html):not(body)` on element selectors; `.main-content::after` is included.
- [ ] Body (and html if locked) overflow is restored with `setProperty(..., 'important')` on close and on destroy.

---

## 5. Cursor Prompt (copy-paste this)

Use the block below as the instruction for Cursor to implement the plan.

```
Implement the Cart Drawer Responsiveness & Theme Suppression plan so the site never gets stuck after opening/closing the cart drawer, and behavior matches cart.txt.

Context:
- Problem: Sometimes after opening the cart drawer the website stops responding (no scroll, wrong click target). Causes: (1) body overflow not restored properly when theme also uses body class e.g. body.js-drawer-open; (2) we never skip body/html in hide logic; (3) injected CSS can affect body; (4) host #cart-pro-root is always pointer-events: none so overlay may not receive clicks.
- Reference: cart.txt (external) does: (a) never apply hide to HTML/BODY; (b) use .js-drawer-open:not(html):not(body)::after and :not(html):not(body) on all element selectors in injected style, plus .main-content::after; (c) save getComputedStyle(body).overflow (and html) once on config load, restore on close with setProperty(..., 'important').

Tasks (follow revstack/docs/CART_DRAWER_RESPONSIVENESS_PLAN.md):

1. themeConnector.ts — In hideElement(), skip when el === document.body || el === document.documentElement (or nodeName BODY/HTML); do not apply any styles to body/html.

2. mount.ts injectHideOtherCartsStyle() — (a) Use .js-drawer-open:not(html):not(body)::after and add .main-content::after { content: none !important; display: none !important; }; (b) For every element selector (cart-drawer, #CartDrawer, etc.), append :not(html):not(body) so the full hide block never applies to html or body.

3. Overflow save/restore — Save body (and html if you lock it) computed overflow once when config is ready or on first drawer open (e.g. module var or sessionStorage "body-el-overflow"). On drawer close and onDestroy, restore using body.style.setProperty('overflow', savedValue, 'important'); fallback to '' or 'visible' if not saved. Do this in DrawerV2.svelte (and Drawer.svelte if still used); use a single releaseBodyScroll() helper called from handleClose, reactive block when drawerOpen becomes false, and onDestroy.

4. Host pointer-events — When drawer opens set #cart-pro-root (host) to pointer-events: auto; when it closes (and on destroy) set to pointer-events: none. Implement in DrawerV2 reactive block or via mount.ts API.

5. Optional: On drawer open (and close) remove theme body class: document.body.classList.remove('js-drawer-open').

Do not change engine or API contracts; only adjust theme connector, mount inject style, and Drawer(V2) overflow/host logic. Run typecheck and lint after edits.
```

---

*End of plan.*
