# Forensic Audit: Stacking Context V2 vs V3 Runtime

**Scope:** Identify exact stacking-context and DOM differences that cause (1) backdrop-filter compositing to dim the drawer in V3, and (2) confetti to render behind the drawer in V3.  
**No code changes; audit only.**

---

## 1. Exact DOM hierarchy

### V2 (cart-pro-ui.js + shadow DOM)

**Markup source:** `DRAWER_MARKUP` in `cart-pro-ui.js` (lines 17–51). Only the **first** element is appended: `drawerEl = wrap.firstElementChild` → `#cart-pro`. The confetti div is a sibling in the markup but **not** appended from that string; it is created in code and appended to shadow (lines 437–441).

**Resulting DOM:**

```
document.body
└── [host — e.g. #cart-pro-root]  (position:fixed, z-index:2147483647 via JS in ensureDrawerDOM)
    └── #shadow-root
        ├── <style> (CRITICAL_CSS)
        ├── #cart-pro
        │   ├── #cart-pro-overlay
        │   └── #cart-pro-drawer
        │       ├── #cart-pro-header … #cart-pro-milestones, #cart-pro-items, #cart-pro-recommendations, #cart-pro-footer
        └── #cart-pro-confetti-layer
```

So in V2:

- **Parent of `#cart-pro-overlay`:** `#cart-pro`
- **Parent of `#cart-pro-drawer`:** `#cart-pro`
- **Parent of `#cart-pro-confetti-layer`:** `#shadow-root` (sibling of `#cart-pro`, not inside it)

---

### V3 (mount.ts → App.svelte → DrawerV2.svelte)

**Mount:** `mount.ts` creates host `#revstack-v3-root`, attaches shadow, appends `<style>` (componentCss) and `#cart-pro-v3-app`, then mounts Svelte `App` into `#cart-pro-v3-app`.  
**App.svelte:** Renders a button and `<DrawerV2 />`.  
**DrawerV2.svelte:** Renders multiple **top-level** elements: `#cart-pro`, optional `.checkout-overlay`, and `#cart-pro-confetti-layer` (lines 101–138). All are direct children of the Svelte component root, which is the **single** child of `#cart-pro-v3-app` (the Svelte target).

**Resulting DOM:**

```
document.body
└── #revstack-v3-root  (host: position:fixed, inset:0, z-index:10000000)
    └── #shadow-root
        ├── <style> (componentCss = cart-pro-v2.css)
        └── #cart-pro-v3-app
            ├── <button>Open V3 Drawer</button>
            ├── #cart-pro
            │   ├── #cart-pro-overlay
            │   └── #cart-pro-drawer
            │       └── (header, milestones, items, recommendations, footer)
            ├── [optional] .checkout-overlay
            └── #cart-pro-confetti-layer
```

So in V3:

- **Parent of `#cart-pro-overlay`:** `#cart-pro`
- **Parent of `#cart-pro-drawer`:** `#cart-pro`
- **Parent of `#cart-pro-confetti-layer`:** `#cart-pro-v3-app` (sibling of `#cart-pro`, not inside it)

---

## 2. Summary: parents of overlay, drawer, confetti

| Element                  | V2 parent     | V3 parent        |
|--------------------------|---------------|------------------|
| `#cart-pro-overlay`      | `#cart-pro`   | `#cart-pro`       |
| `#cart-pro-drawer`       | `#cart-pro`   | `#cart-pro`       |
| `#cart-pro-confetti-layer` | `#shadow-root` | `#cart-pro-v3-app` |

---

## 3. Stacking contexts (position, z-index, backdrop-filter, transform, filter, opacity)

Stacking contexts are created by, among other things: `position` (non-static) + `z-index`, `transform` (non-none), `opacity` &lt; 1, `filter` (non-none), `backdrop-filter` (non-none).

### V2

**Host (root):**  
Set in `ensureDrawerDOM`: `position:fixed`, `top/right/bottom/left:0`, `width/height:100%`, `z-index:2147483647` → **stacking context**.

**CRITICAL_CSS (cart-pro-ui.js lines 9–15):**

- `#cart-pro`: `position:fixed`, `z-index:2147483647` → **stacking context**. Contains overlay and drawer.
- `#cart-pro-overlay`: `position:fixed`, `z-index:2147483647`, `opacity:0` (transition to 1 when open) → **stacking context** when opacity 1.
- `#cart-pro-drawer`: `position:fixed`, `z-index:2147483648`, `transform:translateX(100%)` → **stacking context**.

**cart-pro.css (external, applied when loaded):**

- `#cart-pro-drawer`: adds `backdrop-filter: blur(12px)` → reinforces stacking context (and compositing layer).

**Confetti:**  
`#cart-pro-confetti-layer`: inline `position:fixed`, `z-index:2147483649` → **stacking context**.

So in V2 the **shadow root’s direct children** that participate in the host’s stacking context are:

1. `#cart-pro` (z 2147483647) — stacking context containing overlay + drawer  
2. `#cart-pro-confetti-layer` (z 2147483649) — stacking context

Confetti (2147483649) is above the whole `#cart-pro` (2147483647).

---

### V3

**Host:**  
`#revstack-v3-root`: `position:fixed`, `inset:0`, `z-index:10000000` (mount.ts) → **stacking context**.

**Injected CSS:** `cart-pro-v2.css`. It does **not** define `#cart-pro`. So in V3, `#cart-pro` has no `position` or `z-index` → **does not create a stacking context**; it is a normal (static) block.

**cart-pro-v2.css:**

- `#cart-pro-overlay`: `position:fixed`, `z-index:2147483647`, `opacity:0` → **stacking context** when open.
- `#cart-pro-drawer`: `position:fixed`, `z-index:2147483648`, `transform:translateX(100%)`, `backdrop-filter: blur(12px)` → **stacking context** (and compositing layer).
- `#cart-pro-confetti-layer`: inline `position:fixed`, `z-index:2147483649` → **stacking context**.

`#cart-pro-v3-app` has no `position`/`z-index` in the code (only `pointer-events:auto` in mount.ts) → **no stacking context**.

So in V3, overlay, drawer, and confetti are **not** grouped under a single `#cart-pro` stacking context. They are all **stacking-context-forming elements** inside the same ancestor stacking context (the host). Their order is determined by the host’s context and their own z-indices: overlay 2147483647, drawer 2147483648, confetti 2147483649. So by z-index alone, confetti should be on top.

---

## 4. Compositing root: V2 vs V3

- **V2:** The **stacking-context (and thus compositing) root** for the drawer UI is effectively **`#cart-pro`**: it has `position:fixed` and `z-index:2147483647`. Overlay and drawer live inside this one root. Confetti is a **sibling** of `#cart-pro` in the shadow root, with higher z-index (2147483649), so it sits above the entire `#cart-pro` block.
- **V3:** The root for the whole UI is the **host** `#revstack-v3-root` (z 10000000). There is **no** `#cart-pro` stacking context. Overlay, drawer, and confetti are all direct descendants (through `#cart-pro-v3-app`) of that root, each with their own stacking context and z-index. So the **compositing root** for overlay, drawer, and confetti is the **host**, not a single wrapper like `#cart-pro`.

So the **compositing root** for the drawer is **`#cart-pro` in V2** and the **host `#revstack-v3-root` in V3**.

---

## 5. Is `#cart-pro-overlay` in the same compositing group as the drawer in V3 but not in V2?

- **V2:** Overlay and drawer are both **inside** `#cart-pro`’s stacking context. So they are in the same stacking (and typically same compositing) group under `#cart-pro`.
- **V3:** Overlay and drawer are **not** under a common stacking-context parent; they are siblings under `#cart-pro-v3-app`, with `#cart-pro` being a non-stacking-context wrapper. So overlay and drawer are in the **same** host stacking context but **not** under a single intermediate compositing/stacking root like `#cart-pro` in V2.

So: **No** — in V3 the overlay is **not** “more” in the same compositing group as the drawer than in V2. The difference is the opposite: in V2, overlay and drawer are **both** inside one compositing root (`#cart-pro`); in V3 they are **siblings** in the host’s context with no such wrapper. So in V3, overlay and drawer can be composited as **separate layers** relative to the host, whereas in V2 they are grouped under `#cart-pro`.

---

## 6. Backdrop-filter and host stacking context

**Backdrop-filter** uses the “backdrop” = content that is **behind** the element in stacking order, within the same stacking context (or what the implementation uses for the backdrop).

- **V2:** The drawer has `backdrop-filter: blur(12px)` and lives inside `#cart-pro`’s stacking context. The backdrop it samples is the overlay (and anything below that). Overlay and drawer share the same stacking root (`#cart-pro`), so the backdrop is well-defined and consistent.
- **V3:** The drawer still has `backdrop-filter: blur(12px)` from `cart-pro-v2.css`, but the **stacking root** for overlay and drawer is the **host**. So:
  - The host is the compositing root.
  - Overlay (z 2147483647) and drawer (z 2147483648) are separate stacking contexts under the host.
  - The drawer’s backdrop is supposed to be whatever is behind it in that host context — i.e. the overlay and the host’s background.

So the **backdrop is taken from the host stacking context** in both cases, but:

- In V2, overlay and drawer are in one **sub-context** (`#cart-pro`), so the drawer’s backdrop is the overlay inside that group.
- In V3, there is no such sub-context; overlay and drawer are separate layers under the host. The compositor may treat the **drawer’s layer** (with backdrop-filter) as a single composited layer that samples “content below.” If the overlay is in a **different** compositing layer and the order or blending is wrong, the drawer could sample the **host** (or the page) instead of (or in addition to) the overlay, or the overlay could be composited in a way that **double-dims** (overlay + blurred backdrop). That would explain **backdrop-filter “dimming” the drawer** in V3: the drawer may be blurring/dimming content that already includes the overlay, or the backdrop might be the wrong layer.

So: **Yes.** Backdrop-filter can be sampling a different effective “backdrop” in V3 because the **host** is the stacking context root and overlay/drawer are separate stacking (and compositing) contexts; the host’s stacking context can change which content is considered “behind” the drawer for backdrop-filter and how it’s composited.

---

## 7. Why confetti can render behind the drawer in V3

By z-index (2147483649 vs 2147483648), confetti should be on top. Two plausible causes:

1. **Backdrop-filter and compositing:** The drawer has `backdrop-filter` and `transform`, so it is promoted to its own **compositing layer**. Some engines paint/Composite layers in an order that can put a backdrop-filter layer **above** later siblings in DOM order when they are in the same stacking context, or they can create a “filter” group that sits above other content. So the drawer’s layer might be composited **above** the confetti layer even though confetti has a higher z-index.
2. **No `#cart-pro` grouping in V3:** In V2, confetti is a **sibling** of `#cart-pro` with higher z-index, so it is unambiguously above the whole drawer block. In V3, confetti is a **sibling** of `#cart-pro` under `#cart-pro-v3-app`. If the drawer’s compositing layer (backdrop-filter) is handled in a way that creates a new “stacking” or “compositing” boundary, the confetti layer could end up **under** that boundary in the actual paint order.

So the confetti-behind-drawer behavior in V3 is consistent with **backdrop-filter (and transform) on the drawer** creating a compositing layer that is ordered above the confetti layer in the actual composite step, despite z-index.

---

## 8. Exact stacking-context trees

### V2

```
[host: position fixed, z-index 2147483647]
└── #shadow-root
    ├── #cart-pro [position:fixed, z-index:2147483647]  ← stacking context
    │   ├── #cart-pro-overlay [position:fixed, z-index:2147483647, opacity:1 when open]
    │   └── #cart-pro-drawer [position:fixed, z-index:2147483648, transform, backdrop-filter]
    └── #cart-pro-confetti-layer [position:fixed, z-index:2147483649]
```

### V3

```
#revstack-v3-root [position:fixed, z-index:10000000]
└── #shadow-root
    └── #cart-pro-v3-app [no position/z-index]
        ├── #cart-pro [static, no stacking context]
        │   ├── #cart-pro-overlay [position:fixed, z-index:2147483647]
        │   └── #cart-pro-drawer [position:fixed, z-index:2147483648, transform, backdrop-filter]
        ├── .checkout-overlay [position:fixed, z-index:10] (when present)
        └── #cart-pro-confetti-layer [position:fixed, z-index:2147483649]
```

---

## 9. Findings (audit only)

| Item | Result |
|------|--------|
| **DOM:** Confetti parent | V2: `#shadow-root`. V3: `#cart-pro-v3-app`. |
| **DOM:** Extra wrapper in V3 | V3 adds `#cart-pro-v3-app`; V2 has no such wrapper. |
| **Stacking:** `#cart-pro` | V2: `position:fixed`, `z-index:2147483647` (CRITICAL_CSS) → stacking context. V3: no rule in cart-pro-v2.css → static, **no stacking context**. |
| **Compositing root** | V2: `#cart-pro`. V3: host `#revstack-v3-root`. |
| **Overlay/drawer grouping** | V2: both under one root `#cart-pro`. V3: both under host, no shared wrapper stacking context. |
| **Backdrop-filter** | In V3, drawer’s backdrop-filter runs in the host’s context with overlay and drawer as separate layers; compositing can cause wrong/double dimming. |
| **Confetti behind drawer** | Explained by drawer’s backdrop-filter + transform creating a compositing layer that can be painted above the confetti layer despite z-index. |

**Root cause (summary):** In V3, `#cart-pro` is not given `position:fixed` and `z-index` (because cart-pro-v2.css omits `#cart-pro`). So the single stacking/compositing root that wraps overlay and drawer in V2 is absent in V3. Overlay, drawer, and confetti then all participate directly in the host’s stacking context as separate layers; the drawer’s `backdrop-filter` (and `transform`) promotes it to a compositing layer that can be ordered above confetti and can sample the wrong backdrop, producing the observed dimming and confetti-behind-drawer behavior.
