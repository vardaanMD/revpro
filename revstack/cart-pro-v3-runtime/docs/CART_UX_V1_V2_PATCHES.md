# Cart UX: v1/v2-style patches (no snap-back, no stuck, no glitches)

This doc summarizes how v1/v2 kept cart quantity and price stable, and the equivalent patches in V3.

## V1 behaviour (cart-pro.js)

- **Single source of truth**: `cartState` is mutated in place for quantity changes; no full replace from a GET during the mutation flow.
- **Optimistic update**: On +/- click, v1 updates `item.quantity`, `item.final_line_price`, `cartState.total_price` and the UI immediately, then **debounces** the API call (250ms) via `syncTimers[lineKey]`.
- **Mutation response only**: `syncLineQuantity` uses **only** the POST `/cart/change.js` response to update state (`cartState = updatedCart`). It **never** does a separate GET `/cart.js` after a quantity change.
- **Stale response guard**: `latestRequestedQty[lineKey]` and `if (latestRequestedQty[lineKey] !== serverItem.quantity) return` so a late or out-of-order response does not overwrite.
- **inFlightRequests[lineKey]**: Prevents duplicate sync for the same line.
- **loadCart**: Has `cartLoadInFlight` and `CART_TTL_MS` short-circuit so a fresh fetch is not repeated. No observer fires loadCart on their own change.js request.

## V2 behaviour (cart-pro-v2.js)

- **No optimistic update**: `onQtyChange` does POST then `v2Cart = await fetchCart()` then `reopenWithFreshData()`. So the only update is after the GET; no “optimistic then snap back”.
- **Single cart variable**: `v2Cart` is only updated by that flow or by initial load.
- **safeRender**: Guard to avoid re-entrant render.

## V3 patches (this runtime)

1. **Use mutation response, not a follow-up GET (v1-style)**  
   In `addToCart` / `changeCart` / `removeItem` we use the **response** from the mutation (add/change returns cart or items). We call `applyCartRawSilent or applyCartRawBatched` so we don’t enqueue `reapplyDiscounts`/`syncFreeGifts` from that apply and trigger an extra sync.

2. **Grace period after our own mutation**  
   - `lastMutationAppliedAt` is set when we apply the mutation response.  
   - `MUTATION_GRACE_MS` (600ms): for that window we treat “mutation response is source of truth”.

3. **Don’t run sync when in grace (entry)**  
   At the **start** of `syncCart()` we skip if `Date.now() - lastMutationAppliedAt < MUTATION_GRACE_MS`. So we don’t start a new fetch that could overwrite the just-applied mutation.

4. **Don’t apply a sync that completed during grace (v1-style)**  
   **After** `await apiFetchCart()` in `syncCart()`, we check again: if we’re now in the grace period, we **don’t** call `applyCartRawBatched(raw)` and we just clear `syncing`. So a sync that was **already in flight** when the user mutated does not overwrite when it completes (avoids snap-back from stale GET).

5. **Interceptor: don’t emit during mutation or grace**  
   `getInternalMutationInProgress()` returns true if we’re in a mutation **or** within `MUTATION_GRACE_MS` of `lastMutationAppliedAt`. So the PerformanceObserver doesn’t emit `cart:external-update` for our own change.js, and we don’t enqueue a redundant `syncCart`.

6. **cart:external-update handler**  
   Before enqueueing `syncCart()`, we skip if `Date.now() - lastMutationAppliedAt < MUTATION_GRACE_MS`.

7. **No cached GET**  
   `fetchCart()` uses `cache: 'no-store'` so GET `/cart.js` is not served from cache and can’t overwrite with an old cart.

8. **Avoid redundant initial sync**  
   In `App.svelte` onMount we only enqueue `syncCart()` if `cart.raw` is not already set (e.g. loadConfig already ran and synced). Reduces duplicate in-flight syncs that can race with the first user action.

9. **Optimistic update + rollback**  
   We apply an optimistic cart (and for add, a placeholder line) before the API call; on success we replace with the mutation response; on error we restore the snapshot. So the UI doesn’t wait on the network for the first paint.

10. **Stale response guard for changeCart (v1-style)**  
    When the changeCart response returns, we only apply it if the server’s line quantity matches what we requested (`serverLine.quantity === quantity`). If it doesn’t (e.g. out-of-order response or server adjusted), we call `syncCart()` instead so we never overwrite with an older quantity.

These together give v1-style behaviour: mutation response is the source of truth for a short window, and no GET (including in-flight or cached) overwrites it so qty/price don’t snap back or get stuck.
