# Cart First-Load Improvement Plan

**Source:** [CART_FIRST_LOAD_AND_LATENCY_AUDIT.md](./CART_FIRST_LOAD_AND_LATENCY_AUDIT.md)  
**Goal:** Reduce time-to-interactive for the cart (script load + snapshot + first sync).

Tasks are ordered for implementation: backend snapshot changes first (no storefront dependency), then Liquid, then optional UX.

---

## Task 1: Don’t block snapshot on catalog warm

**Context:**  
When `getShopProductCount(shop) === 0`, the snapshot route **awaits** `warmCatalogForShop(shop)`, which does Shopify Admin GraphQL + a large Prisma transaction. That can add several seconds to the first snapshot response and blocks script load (Liquid waits for snapshot). Cold first load is unnecessarily slow.

**Fix:**

- **File:** `app/routes/cart.snapshot.v3.ts`
- **Change:**  
  - If `count === 0`, do **not** `await warmCatalogForShop(shop)`.  
  - Call **`triggerAsyncCatalogWarm(shop)`** (or equivalent fire-and-forget) so the next request can hit a warm catalog.  
  - Proceed with the rest of the loader using **empty/default recommendations** (e.g. `buildCollectionAwareRecommendations` will need to handle “catalog not ready” without calling `ensureCatalogReady`, or we return a snapshot with empty `recommendationsByCollection` / `recommendations` when count is 0).
- **Detail:**  
  - Keep the existing `getShopProductCount(shop)` and the 1-min in-memory count cache.  
  - When `count === 0`: set `collectionAware = { recommendationsByCollection: { default: [] }, productToCollections: {} }` (or call a helper that returns that without DB), then trigger async warm.  
  - When `count > 0`: keep current behavior (call `buildCollectionAwareRecommendations(shop)` as today).
- **Edge case:** First-ever load for a shop may return empty recommendations once; next load (or next page) gets warmed catalog and full recommendations.

---

## Task 2: Remove duplicate work in snapshot (single findMany)

**Context:**  
In one snapshot request, `buildCollectionAwareRecommendations(shop)` does a full `findMany(ShopProduct)`, then calls `getHydratedRecommendationsForShop(shop)`, which does **ensureCatalogReady**, **getShopConfig**, and **findMany(ShopProduct)** again. So we do two full catalog reads and repeated config/catalog checks per request, which adds latency and load.

**Fix:**

- **Files:**  
  - `app/lib/upsell-engine-v2/buildSnapshot.ts`  
  - Optionally `app/routes/cart.snapshot.v3.ts` if we keep a thin wrapper.
- **Change:**  
  - **Option A (recommended):** Add an overload or internal helper that accepts **pre-fetched** `rows` (and optionally `config` / `billing`) so that a **single** `findMany` in the snapshot loader can feed both:  
    - building collection buckets (per-collection recommendations + `productToCollections`), and  
    - the “default” bucket (same logic as current `getHydratedRecommendationsForShop`).  
  - **Option B:** Refactor `buildCollectionAwareRecommendations` to:  
    - do a single `findMany` and single `buildCatalogIndexFromDbRows`;  
    - build collection buckets from that index;  
    - compute the “default” recommendations from the same index (inline the strategy/limit/capabilities logic from `getHydratedRecommendationsForShop`) and set `recommendationsByCollection["default"]`.  
  - In both cases, **remove** the second `ensureCatalogReady`, second `getShopConfig`, and second `findMany` from the snapshot request.
- **Detail:**  
  - In `cart.snapshot.v3.ts`, we already have `getShopConfig` and `getBillingContext` before `buildCollectionAwareRecommendations`. So we can pass `shop`, `config`, and `billing` (and optionally pre-fetched `rows` if we fetch once in the route) into a new signature that doesn’t re-fetch.  
  - Ensure `buildCollectionAwareRecommendations` (or the new helper) still respects capabilities and strategy/limit for the “default” bucket so behavior is unchanged.

---

## Task 3: Load script in parallel with snapshot (Liquid)

**Context:**  
The Liquid embed waits for `fetch('/apps/cart-pro/snapshot/v3')` to resolve before calling `loadV3()`, so the widget script only starts loading after the full snapshot response. Snapshot server time is therefore on the critical path for script load. Loading the script in parallel with the snapshot removes that blocking and lets the runtime bootstrap when the snapshot arrives (already supported via `window.__CART_PRO_SNAPSHOT__` and mount polling).

**Fix:**

- **File:** `extensions/cart-pro/blocks/cart_pro_embed_v3.liquid`
- **Change:**  
  - Call **`loadV3()` immediately** (or as soon as the block runs), so the script tag is appended to the page without waiting for the snapshot fetch.  
  - Start **`fetch('/apps/cart-pro/snapshot/v3')`** in parallel.  
  - When the fetch resolves: set `window.__CART_PRO_SNAPSHOT__` and optionally update sessionStorage (same as current `applySnapshot(config)`).  
  - If the script has already loaded and mounted, the runtime’s existing logic (e.g. `getGlobalSnapshot()` in mount, or late config in `waitForConfig`) will pick up `__CART_PRO_SNAPSHOT__` when it appears; no change required in the runtime if it already supports “config arrives after mount.”  
  - If the script loads **before** the fetch completes, mount may run with no config and use the existing “wait for config” polling (up to 2 s) in `mount.ts`, then apply snapshot when it arrives; that’s acceptable and still faster than blocking script load on snapshot.
- **Detail:**  
  - Preserve the **cached path**: when `sessionStorage` has valid cached config, still apply it and load the script immediately; the background fetch can still run to refresh config (as today).  
  - Ensure both code paths (cold and cached) load the script without waiting for the network snapshot response.  
  - No change to snapshot response body or to runtime bootstrap logic beyond confirming late-applied `__CART_PRO_SNAPSHOT__` is applied correctly (already documented in audit).

---

## Task 4 (optional): Show cart button before first sync

**Context:**  
The cart button is gated on `initialSyncDone`, which is set only after the first `syncCart()` (GET /cart.js) completes. Letting the user see and click the button earlier (with a loading/skeleton state inside the drawer) could improve perceived first load, at the cost of a slightly more complex loading UX.

**Fix:**

- **Files:**  
  - `cart-pro-v3-runtime/src/ui/App.svelte`  
  - `cart-pro-v3-runtime/src/ui/v2/DrawerV2.svelte` (or equivalent drawer component).
- **Change:**  
  - **Option A:** Set `contentReady = true` when config is loaded (or when the app has mounted), instead of when `initialSyncDone` is true. Keep `initialSyncDone` for controlling **drawer content**: when the user opens the drawer, show a skeleton/loading state until `initialSyncDone`, then show cart items.  
  - **Option B:** Keep `contentReady` tied to `initialSyncDone`, but add a second “cart available” signal (e.g. “config loaded and engine ready”) and show the button then; when the user opens the drawer before first sync, show “Loading cart…” until `syncCart` completes.  
  - Ensure the drawer never shows stale or empty state as “final” when sync is still in flight (e.g. show a clear loading indicator until `initialSyncDone`).
- **Detail:**  
  - Document the chosen behavior (when the button appears vs when the drawer shows full content).  
  - Consider accessibility (e.g. button disabled or aria-busy until first sync if you want to avoid opening an empty drawer).

---

## Task 5 (optional): Short-lived snapshot cache

**Context:**  
Rapid reloads or multiple requests in a short window all hit the full snapshot path. A short-lived cache (e.g. 5–10 s) per shop can reduce redundant work and improve repeat loads; invalidation on config/settings change keeps data fresh.

**Fix:**

- **File:** `app/routes/cart.snapshot.v3.ts` (or a small server-side cache module used by the loader).
- **Change:**  
  - Introduce an in-memory cache keyed by `shop` (normalized).  
  - Cache the **serialized snapshot response** (or the payload object) with a TTL of **5–10 seconds**.  
  - On snapshot loader: if cache hit and not expired, return cached response (same headers as needed, e.g. `Cache-Control: no-store` or short max-age as appropriate).  
  - On cache miss: compute snapshot as today, then store in cache before returning.  
  - **Invalidation:** When shop config or settings are updated (e.g. in the flow that calls `invalidateShopConfigCache` or similar), clear the snapshot cache entry for that shop so the next request gets a fresh snapshot.  
  - Optional: cap cache size (e.g. by number of shops) to avoid unbounded growth.
- **Detail:**  
  - Use the same `normalizeShopDomain(shop)` as elsewhere so cache keys are consistent.  
  - Ensure cached responses are not shared across different shops (key = shop only).  
  - If you add this, document TTL and invalidation in the audit or in code comments.

---

## Implementation order

| Order | Task | Deps | Notes |
|-------|------|------|--------|
| 1 | Task 1: Don’t block snapshot on catalog warm | None | Backend only; quick win. |
| 2 | Task 2: Single findMany in snapshot | None | Backend refactor; test buildCollectionAwareRecommendations. |
| 3 | Task 3: Load script in parallel (Liquid) | None | Theme extension; verify with cold and cached paths. |
| 4 | Task 4: Cart button before first sync | None | Optional; runtime UX. |
| 5 | Task 5: Snapshot cache | 1, 2 | Optional; add invalidation when config changes. |

After 1–3, re-measure first load (snapshot time, script load, time to cart button). Tasks 4 and 5 can be done later if desired.

---

## Implemented (2025-03-15)

| Task | File(s) changed | Summary |
|------|-----------------|--------|
| **Task 1** | `app/routes/cart.snapshot.v3.ts` | When `getShopProductCount(shop) === 0`, call `triggerAsyncCatalogWarm(shop)` (fire-and-forget) instead of `await warmCatalogForShop(shop)`. Use empty `collectionAware` for that request; only call recommendations builder when `count > 0`. |
| **Task 2** | `app/lib/upsell-engine-v2/buildSnapshot.ts`, `app/routes/cart.snapshot.v3.ts` | Added `getDefaultBucketFromIndex(index, config, capabilities)` and `buildCollectionAwareRecommendationsWithContext(shop, config, billing)` that perform a single `findMany` and build both collection buckets and default bucket. Snapshot route now passes `shopConfig` and `billing` and uses this path when `count > 0`. Original `buildCollectionAwareRecommendations(shop)` kept for other callers. |
| **Task 3** | `extensions/cart-pro/blocks/cart_pro_embed_v3.liquid` | Cold path: call `loadV3()` immediately and `fetchSnapshotThenApply()` in parallel; when fetch resolves, `applySnapshot(config)`. Cached path unchanged: apply cached config, start background fetch, load script. Script no longer blocks on snapshot response. |
