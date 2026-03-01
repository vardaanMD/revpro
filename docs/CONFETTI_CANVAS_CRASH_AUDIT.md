# Confetti Canvas Crash — Pure Audit

**Error:** `Uncaught InvalidStateError: Failed to set the 'width' property on 'HTMLCanvasElement': Cannot resize canvas after call to transferControlToOffscreen().`

**Scope:** Storefront JS; breaks `cart-pro.js` execution and prevents UI/decision rendering.

**Audit only — no fixes, no refactors.**

---

## PART 1 — All Canvas Usage

### Repo-wide matches

| Search term | File(s) | Notes |
|-------------|---------|--------|
| `canvas` | `revstack/extensions/cart-pro/assets/cart-pro.js`, `revstack/app/components/CartPreview.tsx`, `cart.txt` (library), TS libs | Application usage in cart-pro.js and CartPreview.tsx; library in cart.txt |
| `transferControlToOffscreen` | `cart.txt` (canvas-confetti), `apps/api/node_modules/typescript/lib/lib.dom.d.ts` | Only library + TypeScript defs |
| `OffscreenCanvas` | `cart.txt`, TS libs | Library and type defs only |
| `canvas-confetti` | `cart-pro.js` (CDN URL), `CartPreview.tsx` (CDN URL) | Both load same CDN |
| `useWorker` | `cart-pro.js`, `cart.txt` | cart-pro passes `useWorker: true`; library checks it |
| `width =` / `height =` (canvas) | `cart-pro.js` (canvas.width/height), `cart.txt` (library) | See below |

### Per-match detail (application code only)

**1. cart-pro.js — canvas creation and resize**

| Field | Value |
|-------|--------|
| **File** | `revstack/extensions/cart-pro/assets/cart-pro.js` |
| **Function** | `getConfettiInstance()` (inside `loadConfettiLib().then(...)`) |
| **Exact snippet** | `var canvas = document.createElement("canvas");` … `canvas.style.zIndex = "2147483649"; shadowRoot.appendChild(canvas); function resizeCanvas() { canvas.width = window.innerWidth; canvas.height = window.innerHeight; } resizeCanvas(); window.addEventListener("resize", resizeCanvas); confettiInstance = lib.create(canvas, { resize: false, useWorker: true });` |
| **When executed** | When confetti is first needed: **milestone unlock** (first time a milestone is crossed) or **add-to-cart** (first add-to-cart in session). Not on boot; deferred until first `firePremiumConfetti()` → `getConfettiInstance()`. |

**2. cart-pro.js — canvas dimension assignments**

| Field | Value |
|-------|--------|
| **File** | `revstack/extensions/cart-pro/assets/cart-pro.js` |
| **Function** | `resizeCanvas()` (local inside `getConfettiInstance()`) |
| **Exact snippet** | `canvas.width = window.innerWidth;` (line ~935), `canvas.height = window.innerHeight;` (line ~936) |
| **When executed** | (1) Once immediately after canvas creation. (2) **On every `window` "resize" event** for the lifetime of the page (listener is never removed). |

**3. CartPreview.tsx — canvas (preview only)**

| Field | Value |
|-------|--------|
| **File** | `revstack/app/components/CartPreview.tsx` |
| **Function** | `firePremiumConfettiPreview()` |
| **Exact snippet** | `const canvas = document.createElement("canvas");` … `confettiLib.create(canvas, { resize: true });` (no `useWorker` in type; default in library may apply) |
| **When executed** | Preview/Dev only (admin preview), not storefront. Not the crash source. |

**4. cart.txt (canvas-confetti library)**

| Location | Function / context | Snippet | When |
|----------|--------------------|---------|------|
| ~19654 | Worker capability check | `global.HTMLCanvasElement.prototype.transferControlToOffscreen` | Library load |
| ~19745 | Worker init | `var offscreen = canvas.transferControlToOffscreen(); worker2.postMessage({ canvas: offscreen }, [offscreen]);` | First `fire()` when `useWorker: true` and custom canvas |
| ~19886–19892 | Main-thread resize helpers | `setCanvasWindowSize`: `canvas.width = document.documentElement.clientWidth; canvas.height = ...`; `setCanvasRectSize`: `canvas.width = rect.width; canvas.height = rect.height` | Used only when library owns canvas or when not using worker |
| ~20047–20053 | Worker size sync in animation loop | `size.width = canvas.width = workerSize.width;` (and height) — **this is OffscreenCanvas in worker** | Inside worker; not main-thread HTMLCanvasElement |
| ~20161 | Init call | `worker.init(canvas);` | First `fire()` with worker + custom canvas |

---

## PART 2 — Confetti Entry Points

### fireConfettiFromElement

- **Not present** in repo. No function with this name.

### scheduleConfetti

- **Not present** in repo. No function with this name.

### Confetti-related helpers

| Symbol | File | Purpose |
|--------|------|---------|
| `shouldShowConfetti()` | cart-pro.js | Reads `bootstrapState.ui.showConfetti` / `SAFE_UI.showConfetti` |
| `loadConfettiLib()` | cart-pro.js | Loads CDN script, resolves `window.confetti` |
| `getConfettiInstance()` | cart-pro.js | Creates/reuses single canvas, attaches resize listener, calls `lib.create(canvas, { resize: false, useWorker: true })`, returns promise of confetti instance |
| `firePremiumConfetti()` | cart-pro.js | Gets drawer rect, calls `getConfettiInstance().then(...)` and runs confetti animation loop |

### Canvas initialization logic

| Where | Canvas created | transferControlToOffscreen() | Dimensions modified later | Reused across calls | Recreated per trigger |
|-------|-----------------|-------------------------------|----------------------------|---------------------|------------------------|
| **cart-pro.js** `getConfettiInstance()` | Once, `document.createElement("canvas")`, appended to `shadowRoot` | No (library does it) | **Yes** — `resizeCanvas()` on initial call and on every `window "resize"` | **Yes** — single `confettiInstance` and one canvas for all triggers | No |
| **CartPreview.tsx** `firePremiumConfettiPreview()` | Each call creates new canvas, appends to container | Library may use worker when default fire used; this path uses `resize: true`, no explicit useWorker | Only by library (resize: true) | No | Yes (new canvas per trigger) |

**Summary for cart-pro.js (storefront):**

- **Where canvas is created:** Inside `getConfettiInstance()`, once.
- **transferControlToOffscreen():** Called **inside canvas-confetti** when the returned instance’s `fire()` is first invoked (`worker.init(canvas)` in cart.txt ~20161 → ~19745).
- **Dimensions modified later:** **Yes.** `resizeCanvas()` is attached to `window` `"resize"` and sets `canvas.width` and `canvas.height`; it runs again on every resize after the canvas has been transferred.
- **Reused across calls:** Yes; one global canvas and one `confettiInstance`.
- **Recreated per trigger:** No.

---

## PART 3 — Execution Order

1. **Page load**  
   - cart-pro.js runs; `CART-PRO-BOOT-START` (diagnostic).  
   - No canvas yet.

2. **First confetti trigger (milestone or add-to-cart)**  
   - `firePremiumConfetti()` → `getConfettiInstance()`.  
   - `loadConfettiLib()` loads CDN if needed.  
   - **Canvas created:** `CONFETTI-CANVAS-CREATED` (diagnostic).  
   - Canvas styled and appended to `shadowRoot`.  
   - **First resize:** `resizeCanvas()` runs → `CONFETTI-RESIZE-ATTEMPT` → `canvas.width = window.innerWidth`, `canvas.height = window.innerHeight` (allowed).  
   - **Resize listener attached:** `window.addEventListener("resize", resizeCanvas)` (never removed).  
   - **Before create:** `CONFETTI-TRANSFER-OFFSCREEN` (diagnostic).  
   - **create:** `lib.create(canvas, { resize: false, useWorker: true })` returns a `fire` function; no transfer yet.

3. **First confetti fire**  
   - Returned `fire(options, ...)` is called (from `firePremiumConfetti()` animation loop).  
   - Inside library: `worker && !initialized` → `worker.init(canvas)` → **`canvas.transferControlToOffscreen()`** → offscreen canvas sent to worker.  
   - Main-thread canvas is now **transferred**; setting `width`/`height` on it is invalid.

4. **Later: window resize (or any resize event)**  
   - Browser fires `"resize"`.  
   - **cart-pro’s** `resizeCanvas()` runs (our listener, not the library’s).  
   - `CONFETTI-RESIZE-ATTEMPT` (diagnostic).  
   - **`canvas.width = window.innerWidth`** → **InvalidStateError** (resize after transfer).

5. **Crash**  
   - Execution breaks; rest of cart-pro.js and UI/decision rendering can fail.

**Conclusion:** Resizing that causes the crash is in **cart-pro.js** inside `resizeCanvas()`, at the first assignment (`canvas.width = window.innerWidth` or `canvas.height = window.innerHeight`) when that runs **after** the library has called `transferControlToOffscreen()` on the same canvas.

---

## PART 4 — Worker Mode Analysis

- **useWorker:** cart-pro.js passes **`useWorker: true`** to `lib.create(canvas, { resize: false, useWorker: true })`.
- **Manual canvas:** We create the canvas and pass it into `confetti.create(canvas, { ... })`.
- **Flow:** Library uses `confettiCannon(canvas, globalOpts)`. When `shouldUseWorker` is true it uses `getWorker()`. On first `fire()`, it calls `worker.init(canvas)`, which does `canvas.transferControlToOffscreen()` and posts the offscreen canvas to the worker. After that, the main-thread `HTMLCanvasElement` is no longer resizable.
- **Interaction with OffscreenCanvas and resizing:** We pass `resize: false`, so the library does **not** register its own resize listener for our canvas. However, **cart-pro.js** registers its **own** `resize` listener and in that handler sets `canvas.width` and `canvas.height`. That handler runs after transfer → crash. So worker mode is active, and our own resize logic is what conflicts with OffscreenCanvas.

---

## PART 5 — Lifecycle Bug Identification

- **Same canvas reused across multiple triggers:** Yes. One canvas, one `confettiInstance`.
- **transferControlToOffscreen() called more than once:** No. Called once in library on first `fire()`.
- **width/height set after transfer:** Yes. Our `resizeCanvas()` runs on every `"resize"` and sets `canvas.width` and `canvas.height` after the first fire (i.e. after transfer).
- **Canvas recreated on every trigger:** No.

**CONFETTI ARCHITECTURE CURRENTLY IS:**  
Single shared canvas created once in `getConfettiInstance()`, appended to shadow root, initially resized by a local `resizeCanvas()`, then given to canvas-confetti via `lib.create(canvas, { resize: false, useWorker: true })`. A single `window "resize"` listener (resizeCanvas) is attached and never removed. The library transfers control of that canvas to an offscreen worker on first `fire()`. The same canvas is reused for all subsequent confetti triggers.

**THE CRASH IS MOST LIKELY CAUSED BY:**  
The `resizeCanvas()` listener in cart-pro.js running on a `window "resize"` event after the library has called `transferControlToOffscreen()` on that canvas. Setting `canvas.width` or `canvas.height` on the transferred main-thread canvas triggers InvalidStateError.

---

## PART 6 — Diagnostic Logs (Added)

Temporary logs were added to confirm which path runs and which line throws:

| Location | Log |
|----------|-----|
| Very top of cart-pro.js (before early return) | `console.log("CART-PRO-BOOT-START")` |
| Before first canvas creation | `console.log("CONFETTI-CANVAS-CREATED")` |
| Before `lib.create(...)` (transfer happens later, inside library on first fire) | `console.log("CONFETTI-TRANSFER-OFFSCREEN")` |
| Before any canvas dimension assignment (inside `resizeCanvas()`) | `console.log("CONFETTI-RESIZE-ATTEMPT")` |

**Expected when crash occurs:** You will see `CONFETTI-RESIZE-ATTEMPT` immediately before the InvalidStateError (i.e. the throw is on the next line: `canvas.width = window.innerWidth` or `canvas.height = window.innerHeight` in `resizeCanvas()`). The actual `transferControlToOffscreen()` runs inside the CDN library on first `fire()`, so it is not logged from application code.

---

## Deliverable Summary

| Item | Result |
|------|--------|
| **Confetti architecture** | Single global canvas in shadow root; created once in `getConfettiInstance()`; passed to `lib.create(canvas, { resize: false, useWorker: true })`; reused for all triggers; `window "resize"` listener in cart-pro.js sets canvas dimensions and is never removed. |
| **Exact line where resizing happens after transfer** | **cart-pro.js** inside `resizeCanvas()`: `canvas.width = window.innerWidth` and `canvas.height = window.innerHeight` (lines ~935–936). The crash occurs when this runs after the library has called `transferControlToOffscreen()` (on first `fire()`). |
| **Worker mode** | **Active.** `useWorker: true` is passed; library calls `worker.init(canvas)` on first fire, which performs `transferControlToOffscreen()`. |
| **Canvas scope** | **Global (per cart-pro):** one canvas per page, shared across all confetti triggers; not per-trigger. |
| **Root cause hypothesis** | Our resize listener runs after the canvas has been transferred to the worker. The listener is our code and is the only code that mutates the main-thread canvas dimensions after transfer; that mutation is invalid and throws InvalidStateError. |

**No logic or behavior was changed except adding the four diagnostic console logs.**
