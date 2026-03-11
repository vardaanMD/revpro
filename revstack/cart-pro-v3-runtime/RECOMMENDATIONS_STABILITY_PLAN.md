# Recommendations Stability Implementation Plan

This plan addresses flashing, snapping, and inconsistent show/add behavior of the recommendations UI by reducing multiple sequential updates and stabilizing the data source.

---

## Phase 1: Prevent Empty-Bucket Clearing (Quick Win)

**Goal:** Never overwrite `snapshotRecommendations` with an empty array when the chosen collection bucket is empty; keep previous list or fall back to `default`.

**Files:** `revstack/cart-pro-v3-runtime/src/engine/Engine.ts`

**Steps:**
1. In **both** places that set `snapshotRecommendations` from the collection bucket (batched path ~977–991 and `applyCartRaw` path ~1062–1076):
   - After computing `list` from the bucket, if `list.length === 0`, set `list` to `byCollection['default'] ?? []` (or keep current `s.snapshotRecommendations` so we don’t clear).
2. Optionally: only call `setState({ snapshotRecommendations: list, ... })` when `list.length > 0` **or** when we explicitly want to show “no recs” (e.g. cart empty). Prefer “keep previous list” when bucket is empty so the UI doesn’t flash to empty then back.

**Acceptance:** Adding an item whose collection has no bucket no longer briefly clears recommendations.

---

## Phase 2: Single Recommendation Update Per Cart Change

**Goal:** Only one visible update to the recommendations list per cart change: either from bucket **or** from decision, not both in sequence.

**Files:** `revstack/cart-pro-v3-runtime/src/engine/Engine.ts`

**Steps:**
1. **Option A (prefer decision when available):**  
   In the microtask after `applyCartRawBatched` and in `applyCartRaw`:
   - Do **not** set `snapshotRecommendations` from the collection bucket when the cart has items.
   - Only start the debounced decision call; when it returns, set `snapshotRecommendations` once from `result.items`.
   - For empty cart, keep showing the default bucket (or last list) and do not call decision.
2. **Option B (prefer bucket, decision as optional refinement):**  
   - Set from bucket immediately (with Phase 1 empty-bucket guard).
   - When the decision returns, only call `setState({ snapshotRecommendations: result.items })` if the current list is empty or if we have a “stale” marker (e.g. `recommendationListVersion` older than a threshold). Otherwise ignore the decision result for this cart signature.

Choose one of Option A or B and implement consistently in both `applyCartRawBatched` (microtask) and `applyCartRaw`.

**Acceptance:** After one cart change (e.g. add item), the list updates at most once (no snap from bucket then snap from decision).

---

## Phase 3: Don’t Re-run Recommendation Pipeline After addToCart

**Goal:** After adding a recommendation to cart, avoid immediately re-running the full bucket + decision pipeline so the list doesn’t change under the user.

**Files:** `revstack/cart-pro-v3-runtime/src/engine/Engine.ts`

**Steps:**
1. In `addToCart`, after merging the new line and building `mergedRaw`:
   - Call a **minimal** apply that updates only cart (and shipping/rewards if needed) **without** updating `snapshotRecommendations` and **without** starting the decision debounce. Reuse or extract something like `applyCartRawSilent` but ensure it updates cart, shipping, rewards; do **not** call the code path that sets snapshot from bucket or starts the decision timer.
2. Optionally: start a single debounced decision call (e.g. 500ms) that fires once after the user stops adding for a moment, and then update recommendations once when it returns. Ensure only one such timer is active (clear previous when starting new one).

**Acceptance:** Clicking “Add” on a recommendation updates the cart and does not replace the recommendations list immediately; list may update once later if you implement the optional debounced decision.

---

## Phase 4: Single Source of Truth in UI (No hasSnapshot Flip)

**Goal:** UI always reads from one source so it never flips between snapshot and standard+AI when the snapshot is temporarily empty.

**Files:** `revstack/cart-pro-v3-runtime/src/ui/v2/Recommendations.svelte`

**Steps:**
1. Prefer **snapshot-only** for the main list: always derive `recs` from `state.snapshotRecommendations` (and optionally merge in `state.upsell.aiRecommendations` only when snapshot is explicitly disabled or not used, not when it’s “empty”).
2. Remove or relax the `hasSnapshot` branch that switches to `upsell.standard` and `upsell.aiRecommendations` when `snapshotRecommendations.length === 0`. For example:
   - Always show `recs = state.snapshotRecommendations ?? []` (with optional AI merge if product wants both).
   - Or: keep fallback to standard+AI only when snapshot has never been set (e.g. no `recommendationsByCollection` in config), not when it was set and then cleared.
3. Ensure loading/shimmer still uses `state.upsell.loading` for the AI-loading state if AI recommendations are shown; otherwise rely on a single “recommendations loading” concept if you introduce one.

**Acceptance:** When the engine temporarily sets snapshot to [] (e.g. bug or edge case), the UI does not switch to a different source and back; list either stays previous or shows empty from the same source.

---

## Phase 5: Revalidation Without Extra Recommendation Update

**Goal:** Revalidation (discount check) does not trigger a full sync that causes another recommendation list update.

**Files:** `revstack/cart-pro-v3-runtime/src/engine/Engine.ts`

**Steps:**
1. In `runRevalidation`, after removing invalid codes and calling `removeDiscountFromCart`, either:
   - Call a **cart-only** sync (e.g. fetch cart and apply only cart + discount reconciliation + shipping/rewards), **without** updating `snapshotRecommendations` or starting the decision timer; or
   - Call `syncCart({ fromReapply: true })` but add a flag or branch so that when the apply runs (e.g. `applyCartRawBatched`), it **skips** the recommendation-update block (bucket + decision) when the revalidation was triggered only by discount removal (e.g. `options.fromRevalidation: true`).
2. Ensure `triggerRevalidation` is still called where needed after cart apply, but that the revalidation path no longer triggers a second recommendation update.

**Acceptance:** After revalidation runs (e.g. invalid code removed), the recommendations list does not change unless the cart contents actually changed.

---

## Phase 6: Optional – Reduce Shimmer Re-triggers

**Goal:** Avoid the recommendations container shimmer re-running on every list content change so updates feel less “flashy”.

**Files:** `revstack/cart-pro-v3-runtime/src/ui/v2/Recommendations.svelte`, `revstack/cart-pro-v3-runtime/src/styles/cart-pro-v2.css` (if needed)

**Steps:**
1. Only add the shimmer class when transitioning from “no recs” to “has recs” (e.g. bind class to a derived “justLoaded” that is true for one tick or 200ms after `recs.length` goes from 0 to > 0), or remove the permanent `cp-rec-container-shimmer` from the content div when there are recs so the animation doesn’t replay on every reactive update.
2. If the list is keyed by `recommendationListVersion`, ensure the container doesn’t remount on every version bump; only the inner list should update.

**Acceptance:** Shimmer runs at most once when recommendations first appear, not on every subsequent list change.

---

## Implementation Order

| Order | Phase | Rationale |
|-------|--------|------------|
| 1 | Phase 1 (empty bucket) | Small, low-risk change; stops list from clearing. |
| 2 | Phase 2 (single update) | Core fix for snap/flash; do after Phase 1 so “don’t clear” is already in place. |
| 3 | Phase 4 (single source UI) | Prevents hasSnapshot flip; supports Phase 2 behavior. |
| 4 | Phase 3 (addToCart) | Builds on Phase 2; avoids duplicate update after add. |
| 5 | Phase 5 (revalidation) | Removes extra update from discount revalidation. |
| 6 | Phase 6 (shimmer) | Polish; do last. |

---

## Testing Checklist

- [ ] Open drawer with empty cart: recommendations show default list (or empty) and do not flash.
- [ ] Add first item: recommendations update at most once (no snap then snap again).
- [ ] Add item from recommendations: cart updates, list does not immediately replace; optional delayed refresh only.
- [ ] Add item that changes primary collection: list updates once to new bucket or decision result, not to empty then to list.
- [ ] Invalid discount removed by revalidation: recommendations list unchanged.
- [ ] Rapid add/change: no repeated flashing; at most one list update per logical cart change.
- [ ] “Add” on recommendation card always adds (no lost clicks); list may update once after.

---

## Files Summary

| File | Phases |
|------|--------|
| `cart-pro-v3-runtime/src/engine/Engine.ts` | 1, 2, 3, 5 |
| `cart-pro-v3-runtime/src/ui/v2/Recommendations.svelte` | 4, 6 |
| `cart-pro-v3-runtime/src/styles/cart-pro-v2.css` | 6 (if needed) |
