# Cart First-Load & Latency Audit

**Scope:** Why the first load of the cart feels slow; latency of notable operations.  
**Date:** 2025-03-15.

---

## 1. First-load critical path (cold, no cache)

End-to-end: **Liquid embed → snapshot → script → mount → syncCart → cart button visible.**

| Step | What runs | Blocks? | Typical cost |
|------|-----------|--------|---------------|
| 1 | **Liquid:** `fetch('/apps/cart-pro/snapshot/v3')` | **Yes** — script not loaded until snapshot resolves | **Snapshot RTT + server work** (see §2) |
| 2 | **Liquid:** `loadV3()` — inject `<script src="cart-pro-v3.js">` | Yes | Script network + parse/compile |
| 3 | **mount.ts:** `getEngine()` → `Engine.init()`, `bootstrapConfig()`, `doMount()` | Yes | Sync; config already on `window` from step 1 |
| 4 | **App.svelte onMount:** `enqueueEffect(syncCart)` | Yes (for “cart ready”) | Effect queue runs `syncCart()` |
| 5 | **syncCart:** `apiFetchCart()` → GET `/cart.js` (Shopify) | **Yes** — `initialSyncDone` set only after this returns | **Cart API RTT** (Shopify origin) |
| 6 | **applyCartRawBatched:** one `setState` (cart + shipping + rewards + `initialSyncDone: true`) | Yes | Sync; single re-render |
| 7 | **Cart button visible** | — | User sees “Open V3 Drawer” |

So **time to interactive (cart button)** = **snapshot response time** + **script load** + **mount/init** + **GET /cart.js**.

The **cart button is deliberately gated on `initialSyncDone`** (App.svelte: `contentReady = !!$stateStore?.initialSyncDone`). So the first thing the user can do (open drawer) only appears after the first `syncCart()` completes. That’s correct for consistency but adds one full cart fetch to “first load” from the user’s perspective.

---

## 2. Snapshot route latency (`/apps/cart-pro/snapshot/v3`)

The snapshot loader runs **sequentially**; any slow step delays the whole response and thus script load (see §1).

| Operation | Location | Notes |
|-----------|----------|--------|
| **authenticate.public.appProxy** | cart.snapshot.v3.ts:42 | Proxy HMAC + session; usually fast. |
| **getShopProductCount(shop)** | cart.snapshot.v3.ts:58–59 | Prisma `count`; cache 1 min. Cold: 1 DB round-trip. |
| **warmCatalogForShop(shop)** (if count === 0) | cart.snapshot.v3.ts:59–61 | **Major cost.** Shopify Admin GraphQL (products/collections) + Prisma transaction (N upserts + deleteMany). Can be **several seconds** for large catalogs. Blocks snapshot. |
| **getShopConfig(shop)** | cart.snapshot.v3.ts:64 | Prisma or 5 min in-memory cache. |
| **getBillingContext(shop, shopConfig)** | cart.snapshot.v3.ts:65 | No extra DB; uses config. |
| **buildCollectionAwareRecommendations(shop)** | cart.snapshot.v3.ts:95 | **Heavy.** See below. |
| **buildV3SnapshotPayload / mergeWithDefaultV3** | cart.snapshot.v3.ts:120–126 | In-memory; cheap. |

### 2.1 buildCollectionAwareRecommendations

- **ensureCatalogReady(shop)** — `count`; if 0, **await warmCatalogForShop** again, then count. (On first load after warm in step above, count > 0 so no second warm.)
- **getShopConfig(shop)** — second config read (often cache hit).
- **prisma.shopProduct.findMany({ where: { shopDomain: shop } })** — **loads all products** for the shop. Large catalog = large payload + DB time.
- **buildCatalogIndexFromDbRows** — in-memory; cost scales with product count.
- **getHydratedRecommendationsForShop(shop)**:
  - **ensureCatalogReady(shop)** again (redundant).
  - **getShopConfig(shop)** again (redundant).
  - **prisma.shopProduct.findMany** again — **second full catalog read** for the same request.
  - getBillingContext, buildCatalogIndexFromDbRows, resolveStrategyCatalogFromIndex, slice.

So on a cold snapshot we do:

- Up to **one** (or two, if count was 0 in both places) **full catalog warm** (Admin API + Prisma transaction).
- **Two** full **findMany(ShopProduct)** for the same shop in a single snapshot request.

That duplicate work and large findMany add directly to first-load latency.

---

## 3. Why the first load feels slow — summary

1. **Snapshot blocks script load (Liquid).** On cold, the browser waits for the full snapshot response before loading `cart-pro-v3.js`. So snapshot server time (including warm + double findMany) is fully on the critical path.
2. **Cart button waits for first sync.** `contentReady` is gated on `initialSyncDone`, which is set only after the first `syncCart()` (GET /cart.js) completes. So one extra round-trip (Shopify cart) before the user can open the drawer.
3. **Cold snapshot work is heavy and redundant:**
   - **warmCatalogForShop** when catalog is empty: Admin API + big Prisma transaction.
   - **Two** full `findMany(ShopProduct)` in one snapshot (buildCollectionAwareRecommendations + getHydratedRecommendationsForShop).
   - ensureCatalogReady + getShopConfig each run twice in the same request.

---

## 4. Latency of other notable operations

| Operation | Location | Timeout / limit | Notes |
|-----------|----------|-----------------|--------|
| **GET /cart.js** (fetchCart) | cartApi.ts | 15 s | Shopify; same-origin. Dominant for “cart ready” after snapshot. |
| **POST /apps/cart-pro/decision** | decisionApi.ts | None (client); server 300 ms | Server aborts at 300 ms and returns safe fallback. Not on first-paint path; debounced 500 ms after cart apply. |
| **POST /apps/cart-pro/analytics/v3** | analytics.ts | None | Batch every 5 s or 10 events. Fire-and-forget. |
| **Snapshot (Liquid)** | cart_pro_embed_v3.liquid | None | Blocks script until done. |
| **Config not ready (mount)** | mount.ts:266–291 | Up to 2 s | Polls `getGlobalSnapshot()` every 50 ms × 40. If snapshot never arrives, mount with defaults after 2 s. |
| **Decision debounce** | Engine.ts | 500 ms | After applyCartRawBatched, decision request scheduled 500 ms later; refines recommendations. |
| **Cart revalidation / discount reapply** | Engine (effect queue) | — | Serialized in effect queue; can add latency after mutations. |

---

## 5. Recommendations (concise)

1. **Don’t block script load on snapshot (Liquid).**  
   Load `cart-pro-v3.js` immediately (e.g. in parallel with snapshot fetch). Let the runtime bootstrap from `window.__CART_PRO_SNAPSHOT__` when the fetch completes (already supported). Optionally show a minimal “loading” state until snapshot is there. This removes snapshot server time from the script-load path.

2. **Remove duplicate work in snapshot.**  
   - In **buildCollectionAwareRecommendations**, call **getHydratedRecommendationsForShop** with the already-fetched `rows` (and config/billing) instead of re-calling ensureCatalogReady + getShopConfig + findMany.  
   - Or refactor so a single `findMany` + single index build feeds both collection buckets and “default” recommendations.  
   This cuts one full findMany and repeated config/catalog readiness checks per snapshot.

3. **Avoid blocking snapshot on catalog warm.**  
   If **getShopProductCount** is 0, return snapshot immediately with empty/default recommendations and **trigger warm in the background** (e.g. triggerAsyncCatalogWarm). Next snapshot (or next page load) gets a warm catalog. First load stays fast; recommendations may be empty or default for one request.

4. **Optional: show cart button before first sync.**  
   If you’re willing to show the drawer with a loading/skeleton state on first open, set `contentReady = true` earlier (e.g. after config load or mount) and let syncCart run in parallel. User can open drawer sooner; cart content appears when fetch returns. Trade-off: more complex loading UX.

5. **Consider caching snapshot for a few seconds.**  
   e.g. short-lived (5–10 s) cache by shop so rapid reloads or prefetch don’t hit the full snapshot path. Invalidate on config/settings change if needed.

---

## 6. Quick reference — where time goes (cold first load)

```
[Browser]                    [App proxy / backend]              [Shopify]
   |                                    |                           |
   |  GET /apps/cart-pro/snapshot/v3    |                           |
   |----------------------------------->|                           |
   |                                    | getShopProductCount       |
   |                                    | warmCatalogForShop? (slow)|
   |                                    | getShopConfig             |
   |                                    | buildCollectionAwareRecs  |
   |                                    |   - findMany (all products)|
   |                                    |   - getHydrated...        |
   |                                    |     - findMany again      |
   |<-----------------------------------|                           |
   |  snapshot JSON                     |                           |
   |  load cart-pro-v3.js               |                           |
   |  mount + syncCart                  |                           |
   |  GET /cart.js                      |-------------------------->|
   |<----------------------------------------------------------------|
   |  setState(initialSyncDone: true)   |                           |
   |  "Open V3 Drawer" visible          |                           |
```

Removing snapshot from the script-load path (§5.1) and removing duplicate DB work (§5.2) should give the largest first-load improvement.
