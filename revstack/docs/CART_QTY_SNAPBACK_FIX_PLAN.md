# Cart Quantity Snap-Back — Implementation Plan

This document gives context, root cause, and a step-by-step plan with a **Cursor prompt** at the end to fix the cart quantity glitch (qty change snaps back to previous value).

---

## 1. Context

### Problem
When the user changes line item quantity (e.g. +/- in the cart drawer), the UI sometimes snaps back to the previous quantity. The change appears briefly (optimistic update) then reverts.

### Root cause
**Out-of-order mutation responses.** `changeCart` is not serialized:

1. User clicks + twice quickly → two `changeCart(lineKey, qty)` calls in flight (qty 2, then qty 3).
2. Response for qty 3 can complete first → we apply it (correct).
3. Response for qty 2 completes later → we apply it and overwrite state → **snap back** to 2.

Whichever response returns last wins; there is no request ordering or “only apply if this response is still the latest” check.

### What’s already guarded (no change needed)
- **Grace period** — `syncCart()` skips starting and applying when within `MUTATION_GRACE_MS` (600 ms) of `lastMutationAppliedAt`, so in-flight fetches from external sync don’t overwrite a just-applied mutation.
- **Interceptor** — `cart:external-update` is not emitted while `getInternalMutationInProgress()` is true, so our own `change.js` doesn’t trigger a competing sync.
- **Fetch cache** — `cartApi.ts` uses `cache: 'no-store'` for cart fetch to avoid stale GET overwriting.

### Reference code (current flow)
- **Engine.ts** ~1558–1615: `changeCart` does optimistic update → `apiChangeCart(lineKey, quantity)` → on success either `applyCartRawBatched(raw)` (if `serverLine` found and qty matches) or `await this.syncCart()`. No request ID or version check.
- **CartItem.svelte**: `onIncrease` / `onDecrease` call `engine.changeCart(item.key, item.quantity ± 1)` with no debouncing or lock.

---

## 2. Files to Change

| File | Purpose |
|------|--------|
| `revstack/cart-pro-v3-runtime/src/engine/Engine.ts` | Add mutation sequencing or stale-response guard for `changeCart` (and optionally `removeItem`). |
| `revstack/cart-pro-v3-runtime/src/ui/v2/CartItem.svelte` | Optional: debounce or disable buttons while a change is in flight for that line (UX polish). |

---

## 3. Implementation Options

Choose **one** of the two approaches below.

### Option A: Serialize quantity changes (recommended)

- **Idea:** Only one `changeCart` (and one `removeItem`) runs at a time per engine. New clicks either wait in a queue or are merged (e.g. “set lineKey to qty N” overwrites any pending “set lineKey to qty M” for the same line).
- **Implementation:**
  1. Add a **pending mutation map** in Engine: e.g. `Map<lineKey, { quantity: number, resolve }>` or a single “current changeCart promise” plus queue.
  2. When `changeCart(lineKey, quantity)` is called:
     - If there is already a pending mutation for this lineKey, update the desired quantity (or enqueue “set to quantity”) and optionally cancel/ignore the previous response for that line when it returns.
     - When the API returns, apply only if this response’s (lineKey, quantity) still matches the **current** desired state for that line; otherwise ignore or fire a fresh sync.
  3. Alternatively: run mutations through the **effect queue** so only one cart mutation runs at a time (simpler but serializes all cart changes globally).
- **Pros:** Predictable ordering; no snap-back. **Cons:** Slightly more state (pending map or queue).

### Option B: Ignore stale responses (version / “expected qty” check)

- **Idea:** Before applying a mutation response, check that the response is still “current” for that line.
- **Implementation:**
  1. When we call `apiChangeCart(lineKey, quantity)`, record “we expect lineKey to become quantity” (e.g. `lastExpectedQtyByLine: Map<string, number>` or single `pendingChangeCart: { lineKey, quantity }`).
  2. When the response returns, only call `applyCartRawBatched(raw)` (or apply that line’s update) if the response’s quantity for that lineKey matches what we **currently** expect (or if we have no pending expectation). If we’ve since requested a different quantity for that line, ignore this response and optionally trigger a single `syncCart()` to align with server.
  3. Clear or update the “expected” state when we apply or when we start a new change for that line.
- **Pros:** No queue; simple to add. **Cons:** Need to handle “ignore then sync” so UI eventually matches server; rapid clicks may still trigger multiple syncs.

---

## 4. Recommended Implementation Steps (Option A — serialize via “expected” state)

These steps implement a hybrid: track **expected quantity per line** and only apply a response when it matches the latest request for that line (Option B style). Optionally add a **per-line lock** so we don’t send a new request until the previous one for that line completes (reduces duplicate requests).

### Step 1: Track expected quantity per line in Engine

- Add a private field, e.g. `expectedQtyByLine: Map<string, number>` (or `Record<string, number>`).
- In `changeCart(lineKey, quantity)`:
  - Before calling the API, set `expectedQtyByLine.set(lineKey, quantity)` (or clear when quantity is 0 for remove).
  - After the API returns, when deciding whether to apply:
    - If `raw?.items` and we find `serverLine` for `lineKey`, check `Number(serverLine.quantity) === this.expectedQtyByLine.get(lineKey)`. Only then call `applyCartRawBatched(raw)`. Otherwise call `await this.syncCart()` and then clear the expected state for this line.
    - On success (after apply or after sync), clear `expectedQtyByLine` for this lineKey.
  - In the `catch` block, clear expected state for this lineKey and rethrow.

### Step 2: Optional — per-line lock to avoid duplicate in-flight requests

- Add e.g. `changeCartInFlightByLine: Set<string>`.
- At the start of `changeCart`, if `changeCartInFlightByLine.has(lineKey)`, either return immediately and do nothing, or enqueue a “retry” of the latest desired quantity for this line after the current request completes. Simpler variant: if in flight, just return (user can click again). Better UX: merge by updating `expectedQtyByLine.set(lineKey, quantity)` and not starting a second request; when the first request returns, if the response doesn’t match the **current** expected qty, call `syncCart()` once.

### Step 3: removeItem

- Apply the same idea: when we call `apiRemoveItem(lineKey)`, set expected state (e.g. “this line should be gone” or expected qty 0). When the response returns, only apply if the line is actually removed (or apply and clear). Ignore stale remove response if we’ve since done another mutation on the same line.

### Step 4: CartItem.svelte (optional)

- Disable +/- buttons (or show a small spinner) for that line while `engine` reports a change in progress for that line, if you expose a method like `isChangeInFlightForLine(lineKey)`. This avoids double-clicks and makes the “expected qty” logic matter less for UX but is not required for the snap-back fix.

---

## 5. Acceptance Criteria

- [ ] Rapid +/- clicks on the same line never result in the displayed quantity snapping back to an older value.
- [ ] After a change, the displayed quantity and totals match the server (one apply or one sync).
- [ ] Error path: on API failure, cart state is restored from snapshot and expected state for that line is cleared.
- [ ] No regression: single click change still works; grace period and interceptor behavior unchanged.

---

## 6. Cursor Prompt (copy-paste this)

Use the block below as the instruction for Cursor to implement the plan.

```
Fix the cart quantity snap-back: when the user changes line item quantity (e.g. +/-) multiple times quickly, the UI must not snap back to a previous value.

Context:
- Root cause: Out-of-order mutation responses. changeCart() is not serialized; multiple clicks send multiple API calls; whichever response returns last is applied, so an older response can overwrite a newer one and cause the displayed qty to revert.
- Existing guards (keep as-is): syncCart() grace period (MUTATION_GRACE_MS), interceptor skip when getInternalMutationInProgress(), fetchCart cache: 'no-store'.

Tasks (follow revstack/docs/CART_QTY_SNAPBACK_FIX_PLAN.md):

1. Engine.ts — Add expected-quantity tracking per line (e.g. expectedQtyByLine: Map<string, number>). In changeCart(lineKey, quantity): before calling apiChangeCart, set expectedQtyByLine.set(lineKey, quantity). When the response returns, only call applyCartRawBatched(raw) if the server line for lineKey has quantity equal to expectedQtyByLine.get(lineKey); otherwise call await this.syncCart(). Clear expected state for this lineKey after apply or after sync, and in the catch block.

2. Engine.ts — Apply the same pattern for removeItem(lineKey): track that we expect this line to be removed (or expected qty 0); only apply the response if it still matches; otherwise syncCart() and clear.

3. Optional: Add a per-line in-flight guard so we don’t send a second changeCart for the same lineKey until the first completes (or merge by updating expected qty and not starting a second request). Prefer not starting a second request and, when the first returns, if response qty !== current expected qty, call syncCart() once.

4. Optional: In CartItem.svelte, disable +/- (or show loading) for that line while a change is in flight for that line, if the engine exposes isChangeInFlightForLine(lineKey).

Do not change the effect queue contract, syncCart grace logic, or cartApi. Run typecheck and lint after edits.
```

---

*End of plan.*
