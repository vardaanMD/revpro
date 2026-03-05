# Cursor Roadmap: Fast Cart Opening with Contextual Recommendations

**Purpose:** Phased implementation guide for Cursor. Use this doc to run phases in order; each phase has context, tasks, and copy-paste prompts.

**How to use with Cursor:**
1. Open this file and `REPOSITORY_AUDIT_REPORT.md` (or `CLAUDE.md`) for context.
2. Start with Phase 1. Read the phase context and tasks, then paste the **Cursor prompt** at the end of the phase into a new Cursor chat (Agent mode).
3. After the agent completes the phase, verify the task checklist, then move to the next phase.
4. If a phase depends on types or functions from a previous phase, mention the phase number (e.g. "Phase 2: use the CollectionAwareRecommendations type from Phase 1").

**Goals:**
- **Week 1:** Cart opens &lt;100ms with contextual recommendations (collection-aware snapshot + widget intelligence).
- **Week 2:** Smooth recommendation updates as cart changes (dynamic bucket swap, background decision refinement, transitions).

**References:**
- Architecture: `revstack/docs/REPOSITORY_AUDIT_REPORT.md` §1
- Snapshot today: `app/routes/cart.snapshot.v3.ts` + `app/lib/upsell-engine-v2/buildSnapshot.ts` (`getHydratedRecommendationsForShop` uses `EMPTY_CART` → generic list)
- Widget: `cart-pro-v3-runtime/src/engine/Engine.ts` (`loadConfig` sets `snapshotRecommendations`), `ui/v2/Recommendations.svelte` (uses `state.snapshotRecommendations` or `upsell.standard` / `aiRecommendations`)
- Decision: `app/routes/cart.decision.ts`, `packages/decision-engine`; widget does **not** call decision for main recs when snapshot has data
- Catalog: `app/lib/catalog-index.server.ts` (`collectionMap`, `resolveStrategyCatalogFromIndex`), `ShopProduct.collectionIds` in Prisma

---

## Phase 0: Context (read before starting)

**Current state:**
- Snapshot v3 returns one flat `recommendations: HydratedRecommendation[]` from `getHydratedRecommendationsForShop(shop)` with **no cart context** (EMPTY_CART).
- Widget shows that list immediately on open; no decision call for primary recs when snapshot exists.
- Cart API gives `product_id` per line item; it does **not** give collection IDs — so we need a **product → collections** map in the snapshot for the widget to infer "primary collection" from cart items.

**Target state:**
- Snapshot returns **keyed** recommendations: `recommendationsByCollection: Record<string, HydratedRecommendation[]>` (keys = collection IDs + `"default"`) and `productToCollections: Record<string, string[]>` (product ID → collection IDs).
- Widget derives primary collection(s) from cart, picks the right bucket, shows it instantly; optionally calls decision in background and refines with a smooth transition.
- On cart change: re-derive primary collection, swap bucket if needed, debounced decision for refinement.

---

## Phase 1: Backend — Collection-aware snapshot builder

**Context:** Add a new builder that produces keyed recommendations (per collection + default) and a product→collections map. Keep existing `getHydratedRecommendationsForShop` behavior for "default" so we can reuse logic. Snapshot route will be updated in Phase 2 to use the new shape.

**Files to touch:**
- `revstack/app/lib/upsell-engine-v2/buildSnapshot.ts`
- `revstack/app/lib/upsell-engine-v2/types.ts` (if you add new exported types)

**Tasks:**
- [x] Define `CollectionAwareRecommendations` type: `{ recommendationsByCollection: Record<string, HydratedRecommendation[]>; productToCollections: Record<string, string[]> }`. Ensure keys include at least `"default"`.
- [x] Add `buildCollectionAwareRecommendations(shop: string): Promise<CollectionAwareRecommendations>` that:
  - Uses `ensureCatalogReady(shop)`, loads ShopProduct rows, builds index via `buildCatalogIndexFromDbRows` (already gives `collectionMap`).
  - Builds `productToCollections`: for each product in the index, set `productToCollections[productId] = product.collections` (from ProductLite / rows).
  - For each collection ID in `collectionMap`, take up to N products (e.g. 8) from that collection, hydrate to `HydratedRecommendation[]`, set `recommendationsByCollection[collectionId] = hydratedList`. Cap total collections (e.g. top 20 by product count) to limit payload.
  - Add `recommendationsByCollection["default"]` using existing logic from `getHydratedRecommendationsForShop` (same strategy/limit/capabilities), so "default" is the current generic list.
- [x] Export the new type and function. Add unit tests if the repo has tests for buildSnapshot (optional but recommended).

**Cursor prompt (Phase 1):**

```
We're implementing collection-aware snapshots for the cart widget. In revstack/app/lib/upsell-engine-v2/buildSnapshot.ts:

1. Define a type CollectionAwareRecommendations with:
   - recommendationsByCollection: Record<string, HydratedRecommendation[]>
   - productToCollections: Record<string, string[]>

2. Implement buildCollectionAwareRecommendations(shop: string) that:
   - Calls ensureCatalogReady(shop), gets ShopProduct rows, builds index with buildCatalogIndexFromDbRows
   - Builds productToCollections from the index (each product id -> its collections array)
   - For each collection in the index's collectionMap, take up to 8 in-stock products, hydrate to HydratedRecommendation (same shape as getHydratedRecommendationsForShop output), and set recommendationsByCollection[collectionId]. Cap to top 20 collections by product count to limit payload.
   - Sets recommendationsByCollection["default"] using the same logic as getHydratedRecommendationsForShop (strategy, limit, capabilities). Reuse that function's strategy/catalog resolution but pass EMPTY_CART so default stays generic.

Export the type and the new function. Keep getHydratedRecommendationsForShop unchanged for now (used by default bucket and backward compat).
```

---

## Phase 2: Backend — Snapshot v3 payload shape

**Context:** Snapshot v3 loader should return the new collection-aware shape. Support backward compatibility: also set top-level `recommendations` to `recommendationsByCollection["default"]` so existing runtimes that only read `recommendations` still work.

**Files to touch:**
- `revstack/app/routes/cart.snapshot.v3.ts`
- Optionally `revstack/app/lib/config-v3.ts` or snapshot payload types if they exist in a central place

**Tasks:**
- [x] In `cart.snapshot.v3.ts` loader: call `buildCollectionAwareRecommendations(shop)` instead of (or in addition to) `getHydratedRecommendationsForShop(shop)`.
- [x] Set snapshot payload to include: `recommendationsByCollection`, `productToCollections`, and `recommendations: recommendationsByCollection["default"]` (so old clients still get the default array).
- [x] Keep existing `buildV3SnapshotPayload(configV3)` and other fields unchanged. Ensure Cache-Control and error handling stay the same.

**Cursor prompt (Phase 2):**

```
In revstack/app/routes/cart.snapshot.v3.ts, switch to collection-aware recommendations:

1. Replace the recommendations fetch with buildCollectionAwareRecommendations(shop) (from buildSnapshot). Handle errors the same way (try/catch, fallback to empty).

2. Add to snapshotPayload:
   - recommendationsByCollection (from the new builder)
   - productToCollections (from the new builder)
   - recommendations: recommendationsByCollection["default"] (so existing runtimes that only read the flat 'recommendations' array still work)

Leave buildV3SnapshotPayload(configV3), runtimeVersion, and the rest of the response unchanged.
```

---

## Phase 3: Widget — Consume keyed snapshot and derive primary collection

**Context:** Engine's `loadConfig` currently expects `rawConfig.recommendations` (array) and sets `snapshotRecommendations`. We need to store `recommendationsByCollection` and `productToCollections` and compute which list to show from the current cart. Product IDs in cart items may be numeric or GID; normalize to the same format used in `productToCollections` (likely string id from catalog).

**Files to touch:**
- `revstack/cart-pro-v3-runtime/src/engine/Engine.ts` (loadConfig, state updates)
- `revstack/cart-pro-v3-runtime/src/engine/state.ts` (state shape for snapshot data)
- `revstack/cart-pro-v3-runtime/src/engine/configSchema.ts` (optional: extend RawCartProConfig for new keys)

**Tasks:**
- [x] Extend engine state (or config) to hold `recommendationsByCollection: Record<string, SnapshotRecommendationItem[]>` and `productToCollections: Record<string, string[]>`. If you keep them on config, ensure they're read-only and available after loadConfig.
- [x] In `loadConfig`, when `rawConfig.recommendationsByCollection` exists, store it and `rawConfig.productToCollections`. Set initial `snapshotRecommendations` to `recommendationsByCollection["default"]` (or fallback to `rawConfig.recommendations` for backward compat).
- [x] Add a helper that, given cart raw items, returns "primary collection key": collect product IDs from cart (e.g. `item.product_id` or variant/product mapping), look up each in `productToCollections`, then pick the most frequent collection id that exists in `recommendationsByCollection`, or "default" if none.
- [x] Call this helper when cart is applied (in `applyCartRaw` or wherever cart state is set). When primary collection key is determined, set `snapshotRecommendations` to `recommendationsByCollection[primaryKey] ?? recommendationsByCollection["default"]`.
- [x] Ensure product ID format: cart may have numeric id or GID; catalog uses string id. Normalize (e.g. GID to numeric or string) so lookups in `productToCollections` succeed. Document the chosen normalization in a short comment.

**Cursor prompt (Phase 3):**

```
Implement widget-side logic for collection-aware recommendations in the Cart Pro V3 runtime.

1. In state or config, store recommendationsByCollection (Record<string, SnapshotRecommendationItem[]>) and productToCollections (Record<string, string[]>). SnapshotRecommendationItem is the same shape as current snapshot recs (variantId, title, imageUrl, price, handle).

2. In Engine.loadConfig: if rawConfig has recommendationsByCollection and productToCollections, save them (state or this.*). Set initial snapshotRecommendations to recommendationsByCollection["default"] or rawConfig.recommendations for backward compat.

3. Add getPrimaryCollectionKey(cartRaw, recommendationsByCollection, productToCollections): get product IDs from cart items (item.product_id or equivalent), look up each in productToCollections, then choose the most frequent collection id that exists in recommendationsByCollection; if none, return "default". Normalize product IDs so they match productToCollections keys (cart may send numeric or GID; catalog may use string — add a small normalizeProductId helper and use it for lookups).

4. When cart is applied (in applyCartRaw), after setting cart state, call getPrimaryCollectionKey and set snapshotRecommendations to recommendationsByCollection[primaryKey] ?? recommendationsByCollection["default"] so the UI shows the right bucket without a network call.
```

---

## Phase 4: Widget — Background decision call and refinement

**Context:** The widget does not currently call the decision endpoint for the main recommendations when snapshot recs exist. We want to optionally call POST /apps/cart-pro/decision with the cart, get crossSell, and then update the displayed list (or merge) with a smooth transition.

**Files to touch:**
- `revstack/cart-pro-v3-runtime/src/engine/Engine.ts` (trigger decision after cart applied; store decision result)
- `revstack/cart-pro-v3-runtime/src/engine/recommendationsApi.ts` or new `decisionApi.ts` (call decision endpoint)
- `revstack/cart-pro-v3-runtime/src/ui/v2/Recommendations.svelte` (optional: show loading/refinement state)

**Tasks:**
- [x] Add a function to call the decision endpoint: POST to the app proxy decision URL (same origin as storefront, with shop/timestamp/signature from snapshot or window). Request body: cart in the shape the decision route expects. Parse response for `crossSell`.
- [x] Map decision `crossSell` to the same shape as SnapshotRecommendationItem (variantId, title, imageUrl, price, handle) so the same UI can render it. Decision response may use different field names; normalize in the widget.
- [x] In Engine, after applying cart (and after setting snapshot bucket from Phase 3), fire a background decision request (non-blocking). When it returns, update state so the recommendations list is replaced (or merged) with the decision crossSell. Prefer replacing for simplicity so "refinement" is clearly decision-driven.
- [x] Ensure we don't block the initial paint: decision runs after snapshot bucket is already shown. Optionally only run when cart has items.

**Cursor prompt (Phase 4):**

```
Add a background decision call so the widget can refine snapshot recommendations with cart-specific cross-sell from the decision endpoint.

1. In the runtime, add a function that POSTs the current cart to the decision endpoint (app proxy URL for /apps/cart-pro/decision with shop, timestamp, signature). Use the same cart shape the backend expects (see cart.decision.ts or validation schema). Parse response.crossSell.

2. Map crossSell items to the same shape as SnapshotRecommendationItem (variantId, title, imageUrl, price, handle). Decision engine returns Product objects; adapt to the UI shape.

3. In Engine, after applyCartRaw has set the snapshot bucket (Phase 3), trigger this decision request in the background (e.g. requestIdleCallback or setTimeout(0)). When the response returns, set snapshotRecommendations to the mapped decision crossSell (replace snapshot list with decision list). Only run when cart has at least one item. Do not block initial render on this call.
```

---

## Phase 5: Cart state management — Dynamic updates and debounce

**Context:** When the user adds/removes items, the cart's "primary collection" may change (e.g. add a dress → fashion bucket). We should re-run primary-collection logic on every cart update and swap the snapshot bucket. Decision should be re-invoked after cart change but debounced (e.g. 500ms) to avoid flooding the backend.

**Files to touch:**
- `revstack/cart-pro-v3-runtime/src/engine/Engine.ts` (applyCartRaw already runs on each cart update; ensure primary-collection + decision are triggered correctly)

**Tasks:**
- [x] Ensure that on every `applyCartRaw`, we re-run getPrimaryCollectionKey and update `snapshotRecommendations` to the new bucket (instant snapshot swap when category changes).
- [x] Debounce the background decision call: when cart changes, clear any pending decision timeout, set a new 500ms timeout to call the decision endpoint; when it fires, run the same "replace snapshotRecommendations with decision crossSell" logic. Ensure only one in-flight decision request at a time; cancel or ignore stale responses using a simple request id or cart signature.
- [x] When decision returns, apply the same replacement of the visible list. If you added a short fade in Phase 6, use it here for "refinement" updates.

**Cursor prompt (Phase 5):**

```
Implement dynamic recommendation updates when the cart changes.

1. On every applyCartRaw, re-run the primary-collection logic (getPrimaryCollectionKey) and set snapshotRecommendations to recommendationsByCollection[primaryKey] ?? default. So when the user adds items from a different collection, the visible list switches immediately to that collection's bucket.

2. Debounce the background decision call: on cart change, clear any existing timeout, set a new timeout of 500ms. When it fires, POST cart to decision and on response replace snapshotRecommendations with the mapped crossSell. Use a cart signature or request id to ignore responses that no longer match the current cart (avoid overwriting with stale data).
```

---

## Phase 6: UX — Transitions and image preload

**Context:** When we swap from snapshot bucket to decision refinement, a sudden list replace can feel jarring. Add a short fade. Preloading images for the visible recommendations avoids layout shift and improves perceived performance.

**Files to touch:**
- `revstack/cart-pro-v3-runtime/src/ui/v2/Recommendations.svelte` (optional transition class when list source changes)
- `revstack/cart-pro-v3-runtime/src/styles/cart-pro-v2.css` (fade transition)
- Engine or a small util: preload images for the current recommendation list

**Tasks:**
- [x] When the displayed recommendation list changes (snapshot bucket swap or decision refinement), apply a short CSS transition (e.g. opacity 120–180ms). You can add a "listKey" or "listVersion" in state that changes when the list is replaced, and in Recommendations.svelte use a transition block or class to trigger the fade.
- [x] Preload images: when snapshotRecommendations is set, for each item with imageUrl, create `new Image()` and set .src to imageUrl (or use link rel=preload). Limit to the first 8–12 items to avoid too many requests.

**Cursor prompt (Phase 6):**

```
Improve UX for recommendation list updates:

1. When the recommendation list changes (bucket swap or decision refinement), add a short fade transition (120–180ms opacity). In Recommendations.svelte, use a Svelte transition (fade) or a class that triggers a CSS transition when the list reference or a listVersion in state changes. Reuse existing .cp-fade-in or similar in cart-pro-v2.css if it fits.

2. When snapshotRecommendations is updated in the engine, preload images for the first 8–12 items: for each item with imageUrl, do new Image(); img.src = imageUrl. Run this in a non-blocking way (e.g. after setting state) so it doesn't delay rendering.
```

---

## Phase 7: Testing and backward compatibility

**Context:** Ensure old clients (that only read `recommendations`) still work, and that new clients handle missing `recommendationsByCollection` (e.g. old snapshot or error fallback).

**Tasks:**
- [x] Verify snapshot response: when `buildCollectionAwareRecommendations` is used, top-level `recommendations` is still the default array. Test with a client that only reads `recommendations`.
- [x] In the widget, when `recommendationsByCollection` is missing, fall back to `rawConfig.recommendations` and set snapshotRecommendations from it (current behavior). Do not assume productToCollections exists when deriving primary key; if missing, always use "default".
- [ ] Manual test: load storefront, open cart with empty cart → see default recs; add product from collection A → see collection A recs; add product from collection B → see bucket switch or merged behavior; confirm decision refinement after 500ms (if implemented) updates the list with a smooth fade.

**Cursor prompt (Phase 7):**

```
Backward compatibility and robustness:

1. In the snapshot route, ensure that when we return recommendationsByCollection, we also set recommendations = recommendationsByCollection["default"] so clients that only read 'recommendations' still get the same array as before.

2. In the widget loadConfig and primary-collection logic: if rawConfig.recommendationsByCollection is missing, set snapshotRecommendations from rawConfig.recommendations (array) and do not run primary-collection logic. If productToCollections is missing when deriving primary key, use "default". Add short comments in code documenting this fallback.

3. In applyCartRaw, only update snapshotRecommendations from bucket when recommendationsByCollection and productToCollections are present; otherwise leave snapshotRecommendations as already set from loadConfig.
```

---

## Summary checklist

**Verification (code audit):** All phases 1–6 and Phase 7 (code paths) are implemented. Phase 7 manual test remains for QA.

| Phase | Focus | Key deliverables |
|-------|--------|-------------------|
| 1 | Backend builder | `buildCollectionAwareRecommendations`, `CollectionAwareRecommendations` type |
| 2 | Snapshot payload | Snapshot v3 returns keyed recs + productToCollections + legacy `recommendations` |
| 3 | Widget snapshot + primary key | Store keyed data, derive primary collection from cart, set snapshotRecommendations from bucket |
| 4 | Background decision | Call decision endpoint, replace list with crossSell when returned |
| 5 | Dynamic updates | Re-run bucket on cart change, debounce decision (500ms) |
| 6 | UX | Fade on list change, preload images for visible recs |
| 7 | Compatibility | Fallbacks for missing keyed data; legacy `recommendations` preserved |

**Order:** Execute phases 1 → 2 → 3 → 4 → 5 → 6 → 7. Phases 1–3 give "instant contextual recs"; 4–5 add refinement and cart-state updates; 6–7 polish and safety.
