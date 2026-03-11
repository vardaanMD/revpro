# Recommendations Implementation Plan

This plan implements the improvements from the [recommendations audit](#audit-context) to eliminate card glitching, reduce redundant updates, and simplify the architecture. It builds on the existing [RECOMMENDATIONS_STABILITY_PLAN.md](./RECOMMENDATIONS_STABILITY_PLAN.md) (Phases 1–6), which are largely in place.

---

## Audit context

- **Recommendations work**: Bootstrap → decision API → UI and add-to-cart all function.
- **Glitch causes**: (1) One hard swap when the decision result replaces the list. (2) With items in cart, we show default bucket then ~500ms later replace with decision result. (3) Full list replacement with no transition. (4) Multiple setState per cart change (batched + microtask + decision callback).
- **Dead code**: `applyCartRaw` is never called; `syncCart` uses only `applyCartRawBatched`.

---

## Implementation order (summary)

| # | Phase | Area | Effort |
|---|--------|------|--------|
| 1 | **Phase 7** | List transition (UI) | Small |
| 2 | **Phase 8** | Skeleton / no default-then-decision (Engine + UI) | Medium |
| 3 | **Phase 9** | Stable list / skip no-op updates (Engine) | Small |
| 4 | **Phase 10** | Single render for empty-cart recs (Engine) | Small |
| 5 | **Phase 11** | Remove or refactor dead `applyCartRaw` (Engine) | Medium |
| 6 | **Phase 12** | Card image layout (UI + CSS) | Small |

---

## Phase 7: List transition (soften the snap)

**Goal:** When the recommendation list changes, the update is animated (fade or fly) so it no longer feels like a hard “glitch”.

**Files:** `src/ui/v2/Recommendations.svelte`, optionally `src/ui/v2/RecommendationCard.svelte`

**Steps:**

1. In `Recommendations.svelte`, import Svelte transitions, e.g. `import { fade } from 'svelte/transition';` (or `fly` if you prefer a slide).
2. Expose `recommendationListVersion` from state (e.g. `$: listVersion = state?.recommendationListVersion ?? 0`).
3. Wrap the list block in `{#key listVersion}` so that when the version changes, the block is torn down and recreated, and apply `transition:fade` (e.g. `duration={150}`) to the list container or to each card.
   - **Option A (list-level):** One key on the list container so the whole “You may also like” + list fades out and in when the list content changes.
   - **Option B (card-level):** Keep `{#each recs as rec (rec.variantId)}` but add `transition:fade` to `RecommendationCard` so added/removed/reordered cards animate. Prefer this if you want to avoid the whole list flashing.
4. If using Option A, ensure the key is `listVersion` (or a stable derivative) so we only transition when the engine actually replaced the list, not on every store tick.

**Acceptance:**

- Changing cart (e.g. add item) and getting a new decision result no longer produces an instant snap; the list (or cards) transition in/out smoothly.
- No regression: empty state and loading state still behave correctly.

---

## Phase 8: Skeleton until first decision (avoid default-then-decision)

**Goal:** When the cart has items, do not show the default bucket and then replace it with the decision result. Show a skeleton (or keep previous list) until the first decision response, then show the list once.

**Files:** `src/engine/Engine.ts`, `src/engine/state.ts` (optional), `src/ui/v2/Recommendations.svelte`

**Steps:**

1. **Engine:** Introduce a “recommendations loading” concept for the decision call when cart has items. For example:
   - Add `recommendationsDecisionPending: boolean` to state (or reuse a single “recommendations loading” flag). Set it to `true` when we call `scheduleDecisionUpdate` and the current `snapshotRecommendations` are still the bootstrap default (e.g. we have never received a decision for this cart/session). Set it to `false` when the decision callback runs (success or failure).
   - Alternatively, in the microtask of `applyCartRawBatched`, when `hasItems` is true and we have `recommendationsByCollection` but no decision result yet, set `snapshotRecommendations` to `[]` and set a “decision pending” flag so the UI shows skeleton instead of the default bucket. When the decision returns, set the list and clear the flag. (Simpler: just don’t set from bucket when cart has items—already true—and have the UI show skeleton when cart has items and list is “stale”, e.g. list is the default bucket and we just started a decision request.)
2. **UI:** In `Recommendations.svelte`, when the cart has at least one item and we are in “decision pending” state (e.g. new flag, or heuristic: `loading` or a dedicated flag), show the recommendations skeleton instead of the current list. When the first decision result arrives, show the list (with Phase 7 transition).
3. Ensure empty cart still shows the default bucket immediately (no skeleton).

**Acceptance:**

- With items in cart, opening the drawer shows recommendations skeleton (or “loading”) until the decision returns, then the list appears once with a smooth transition. No “default list → decision list” snap.
- Empty cart still shows default bucket without unnecessary loading state.

---

## Phase 9: Stable list / skip no-op updates

**Goal:** When the decision returns the same set of variant IDs (possibly in a different order), avoid replacing the list or preserve order to reduce reorders and visual jump.

**Files:** `src/engine/Engine.ts`

**Steps:**

1. In `scheduleDecisionUpdate`, when the decision callback runs and `result.items.length > 0`:
   - Compute the set of current variant IDs: `const nextIds = new Set(result.items.map(r => r.variantId));`
   - Get the previous list and its IDs: `const prev = curState.snapshotRecommendations ?? [];` and `const prevIds = prev.map(r => r.variantId).join(',');` (or use a Set).
   - If the sets are equal (same variant IDs, ignoring order), either:
     - **Option A:** Do not call `setState` for `snapshotRecommendations` (skip the update), or
     - **Option B:** Reorder `result.items` to match the previous order for existing IDs, then append new IDs; set that as `snapshotRecommendations` so the DOM order changes less.
2. If you choose Option A, you can still bump `recommendationListVersion` only when the set of IDs actually changes, so the UI transition (Phase 7) runs only when the list content really changed.

**Acceptance:**

- When the backend returns the same products in a different order, either the list does not update (Option A) or the order stays stable (Option B), reducing visible reordering.
- When the set of products changes, the list still updates and the transition runs.

---

## Phase 10: Single render for empty-cart recommendations

**Goal:** For the empty-cart case, include the bucket-derived list in the first batched `setState` so we get one render instead of two (main setState + microtask setState).

**Files:** `src/engine/Engine.ts`

**Steps:**

1. In `applyCartRawBatched`, before calling `this.setState(partial)`:
   - If `(raw?.items?.length ?? 0) === 0`, compute the recommendation list synchronously (same logic as in the current microtask): get `byCollection` and `productToCollections` from state, compute `primaryKey` and `bucket`, derive `list` with empty-bucket fallback (`byCollection['default'] ?? s.snapshotRecommendations ?? []`).
   - If `list.length > 0` and the list differs from current `snapshotRecommendations` (e.g. by comparing variant ID strings), set `partial.snapshotRecommendations = list` and `partial.recommendationListVersion = Date.now()`.
2. In the microtask, when `!hasItems`, **skip** the block that sets `snapshotRecommendations` from the bucket (it’s already in `partial`). Keep the rest (e.g. `scheduleDecisionUpdate` is not run for empty cart; countdown; revalidation).

**Acceptance:**

- With empty cart, one cart sync produces one render that includes both cart/shipping/rewards and the correct recommendation list. No second render from the microtask for recs.

---

## Phase 11: Remove or refactor dead `applyCartRaw`

**Goal:** Eliminate dead code and avoid multiple sequential setState paths. `syncCart` uses only `applyCartRawBatched`; `applyCartRaw` is never called.

**Files:** `src/engine/Engine.ts`, `docs/CART_UX_V1_V2_PATCHES.md` (if it references `applyCartRaw`)

**Steps:**

1. **Option A (remove):**
   - Delete the entire `applyCartRaw` method (from its declaration through the closing `}` that matches the method body). Ensure no call site exists (grep for `applyCartRaw(`).
   - Update docs (e.g. `CART_UX_V1_V2_PATCHES.md`) to say that sync applies via `applyCartRawBatched` only.
2. **Option B (refactor):**
   - If you want a single “full apply” path for future use (e.g. mutation handlers that receive full cart and need one place to apply it), refactor so that:
     - One function builds the full partial state (cart, shipping, rewards, discount, countdown, and optionally recs for empty cart) and calls `setState` once.
     - `applyCartRawBatched` and any other caller use that builder and a single `setState`, with recommendations and decision scheduling handled in a single place (e.g. microtask that only runs recommendation logic and does at most one setState for recs).

**Acceptance:**

- No unused code path that performs multiple sequential setState calls for the same logical update. Documentation matches behavior.

---

## Phase 12: Card image layout (reduce layout shift)

**Goal:** Reserve space for recommendation card images so when images load they don’t cause layout shift or pop-in.

**Files:** `src/ui/v2/RecommendationCard.svelte`, `src/styles/cart-pro-v2.css`

**Steps:**

1. In `RecommendationCard.svelte`, give the image wrapper a fixed aspect ratio (e.g. 1:1 or 4:3) via a class or inline style, e.g. `aspect-ratio: 1` or a fixed height with `object-fit: cover` on the image.
2. In CSS (e.g. `.cp-rec-list .cart-pro-rec-img-wrap`), set a minimum height and/or aspect-ratio so the card doesn’t grow when the image loads. Ensure the image uses `object-fit: cover` (or `contain`) so it fills the box without distorting.
3. Optionally add a very light placeholder (e.g. background color or a tiny skeleton) for the image area until `rec.imageUrl` loads.

**Acceptance:**

- Adding or changing recommendations does not cause the card row to jump when images load. Cards have a stable size.

---

## Testing checklist (all phases)

After implementing, verify:

- [ ] **Phase 7:** List or cards transition smoothly when recommendations change; no instant snap.
- [ ] **Phase 8:** With items in cart, no “default list then decision list” snap; skeleton or loading until first decision, then one list appearance.
- [ ] **Phase 9:** Same products in different order either don’t replace the list or keep order stable; new/different products still update the list.
- [ ] **Phase 10:** Empty cart: one render per sync including recommendations.
- [ ] **Phase 11:** No dead code; docs accurate; at most one extra setState for recs per logical cart change.
- [ ] **Phase 12:** No layout shift when recommendation images load.
- [ ] Regression: Empty cart shows default list; add from recommendations updates cart and list updates once after debounce; revalidation doesn’t change recommendations; rapid add/change doesn’t cause repeated flashing.

---

## Files summary

| File | Phases |
|------|--------|
| `cart-pro-v3-runtime/src/engine/Engine.ts` | 8, 9, 10, 11 |
| `cart-pro-v3-runtime/src/ui/v2/Recommendations.svelte` | 7, 8 |
| `cart-pro-v3-runtime/src/ui/v2/RecommendationCard.svelte` | 7 (optional), 12 |
| `cart-pro-v3-runtime/src/styles/cart-pro-v2.css` | 12 |
| `cart-pro-v3-runtime/src/engine/state.ts` | 8 (if adding a flag) |
| `docs/CART_UX_V1_V2_PATCHES.md` | 11 |

---

## Dependency graph

- **Phase 7** can be done first (UI only).
- **Phase 8** can be done after or in parallel with 7; it may use the same “list version” or loading state.
- **Phase 9** is independent; do after 7 if you want transitions only when the set of IDs changes.
- **Phase 10** is independent; do anytime.
- **Phase 11** is independent; do after you’re satisfied with the batched path.
- **Phase 12** is independent polish.

Recommended order: **7 → 8 → 9 → 10 → 11 → 12** so the user-visible “glitch” fix (7) and “no default-then-decision” (8) land first, then stability (9, 10), then cleanup (11) and layout (12).
