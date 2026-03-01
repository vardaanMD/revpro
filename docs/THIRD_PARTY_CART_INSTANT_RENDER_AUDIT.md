# Third-Party Cart Script (cart.txt) — Instant Rendering Architecture Audit

**Scope:** Reverse engineering of how the third-party cart achieves instant rendering without skeletons or visible staging. Only timing, data flow, and architectural patterns; no UI/styling summary.

**Source:** `cart.txt` (bundled script, ~37.7k lines). All references are to line numbers in that file.

---

## 1. Cross-Sell Timing Architecture

### Where cross-sell / upsell logic is computed

- **Standard (rule-based) upsell:** Not “computed” at drawer open or on cart mutation. The **decision is pre-baked in config**. The list of suggested products lives in `configResponse.upSell.standard[].suggestedUpsellProducts` and `configResponse.oneTickUpsell.products`, returned from the single config request.
- **Which rule applies** (e.g. which standard rule matches the cart) is computed **synchronously in the client** when the upsell component mounts and when `store_cart` or `store_configurations` change, via:
  - `getStandardUpsellRecommendations(upSell.standard)` (≈32820–32956): iterates cart items and `upSell.standard` rules (e.g. `applicableOn`, `selectedProducts`) and returns the matching rule’s `suggestedUpsellProducts`.
  - `findUpsellProducts(cartItem, dataArray)` (≈32934–32956): finds the first matching rule and returns that rule’s `suggestedUpsellProducts`.
- **AI-powered recommendations:** Computed **on cart mutation**, not on drawer open. When `store_cart` updates and there is a `lastAddedItem`, the script calls `fetchAIProductRecommendations(lastAddedItem.product_id, intent, maxProducts)` (≈37212–37214). Results are stored in `store_aiProductRecommendations` and then used by the same upsell UI as an alternative source to `suggestedUpsellProducts`.

### When it runs

| Trigger            | What runs                                                                 |
|--------------------|---------------------------------------------------------------------------|
| **Page/script load** | Config is fetched once in `loadConfigurations()` (see §5). No “decision” API at this moment; the config payload already contains the full standard upsell rules and product lists. |
| **Drawer open**    | No extra decision or recommendation API. Upsell list is derived from existing `store_configurations` and `store_cart` (and optionally `store_aiProductRecommendations`) in memory. |
| **Cart mutation**  | `store_cart.subscribe` runs → for AI type only, `fetchAIProductRecommendations(...)` is called (≈37212). Standard upsell list is re-derived via `setUpsellProducts()` / `getStandardUpsellRecommendations` (≈32891–32893, 32900–32904). |

### Observers / polling

- No polling for recommendations. Reactivity is via Svelte stores: `store_configurations`, `store_cart`, `store_aiProductRecommendations`, `store_productDetails`.
- Cart icon is observed with `MutationObserver` (≈6458–6467) for re-attaching the open-cart handler when the DOM changes; not for fetching recommendations.

### SAFE-like fallback

- **Config:** If `fetchConfigurations()` fails, it returns `sessionStorage.getItem("kwik-cart-request-data") ?? error` (≈7338). So a previous successful config is reused from session.
- **Initial paint:** On mount, if `sessionStorage.getItem("kwik-cart-request-data")` exists, it is parsed and applied to `store_configurations` before `loadConfigurations()` is awaited (≈37157–37170). So the UI can show immediately from cached config while the fresh config request runs.

**Exact references:**

- Config request: `fetchConfigurations` (≈7330), URL `baseUrl + "/v3/kwik-cart/request"` (≈7332).
- Fallback: same function, catch path (≈7337–7338).
- Standard upsell from config: `updateVariantAvailability(configResponse)` (≈6470); product lists from `configResponse.upSell.standard`, `configResponse.oneTickUpsell.products` (≈6474–6491).
- AI recommendations: `fetchAIProductRecommendations` (≈7341), URL `baseUrl + "/v3/kwik-cart/get-product-recommendations"` (≈7343).
- Client-side rule matching: `getStandardUpsellRecommendations`, `findUpsellProducts`, `isPresentUpsellRuleApplicable` (≈32920–32966).
- Cart subscription driving AI fetch: unsubCart callback (≈37196–37215).

---

## 2. Data Hydration Strategy

### Source of cross-sell product data

- **Standard upsell:** Product details (title, image, price, variant) are **already present in the config response**. Each item in `suggestedUpsellProducts` has e.g. `productId`, `productName`, `handle`, `url`, `selectedVariants` (each with `variantId`, `price`, `imageUrl`, `compareAtPrice`, etc.). No extra Shopify product/variant request is needed to render the list.
- **AI recommendations:** Same shape: the API returns `response.data.recommendedProducts` (≈7356) with product/variant data; that is set into `store_aiProductRecommendations` and rendered the same way.

### When product data is available

- **Pre-synced:** Yes. Config (and thus standard upsell list + metadata) is loaded once in `loadConfigurations()` on app mount (≈37175, 37359–37376). That same flow calls `updateVariantAvailability(response.data)` (≈37376), which pre-warms variant availability for all upsell/free-gift variant IDs in `store_productDetails`.
- **At drawer open:** No fetch for cross-sell product list or metadata. The drawer reads from `store_configurations`, `store_cart`, `store_aiProductRecommendations`, and `store_productDetails` (availability). All are already in memory.
- **At interaction time:** `getProductData(handle)` is used only when the user opens the “product description” modal (≈32308–32309), not for the initial upsell list. That function uses `productDataCache` (Map) and Shopify’s `/products/{handle}.js` (≈5379–5386, 5382).

### Caching in memory

- **productDataCache:** `Map()` keyed by product handle (≈5379). Used by `getProductData`; no TTL; persists for session.
- **store_productDetails:** Writable store holding variantId → `{ available, compare_at_price }`. Filled by `updateVariantAvailability` (config load) and by `batchCheckVariantsAvailability` (also after AI recommendations and when fetching product data).
- **store_configurations:** Full config including `upSell.standard`, `oneTickUpsell`, etc.
- **store_aiProductRecommendations:** Array of AI-recommended products with full display fields.

**References:**

- Config and variant pre-warm: `loadConfigurations` (≈37359), `updateVariantAvailability(response.data)` (≈37376), `batchCheckVariantsAvailability(upsellVariantIds)` (≈6501), `store_productDetails.update` (≈6502–6505).
- Upsell tile props from product object: product name/price/image/variants from `ctx2[18]` (product from `upSellProducts`) (≈32609–32641).
- Product fetch only on modal: `getProductData(handle)` (≈32309).

---

## 3. Drawer Open Event Flow

### Sequence when the drawer is opened

1. **`window.openGokwikSideCart()`** (≈37321–37337):
   - `$$invalidate(4, cartDataLoader = true)` (≈37322) — loader can show.
   - If drawer already open: `await getCart()` (≈37324) then return.
   - `store_sideCartOpen.set(true)` (≈37326).
   - Optional `history.pushState` on mobile (≈37328).
   - Body/html `overflow` set to hidden (≈37330–37336).

2. **No additional network calls** for config, recommendations, or cart are triggered by the open action itself. Cart was already loaded on init (via `updateCart({ attributes: { "GoKwik-Cart": true } })` after `loadConfigurations` (≈37259)); config and variant availability were loaded in `loadConfigurations`.

3. **UI:** The sidecart component is already mounted when `loadSidecart` is true (set after init ≈37255). Content is driven by Svelte reactivity to `store_cart`, `store_configurations`, `store_productDetails`, `store_aiProductRecommendations`. So the drawer shows the current cart and upsell list from memory without a dedicated “drawer open” API.

4. **Loader:** `cartDataLoader` is set back to `false` inside `store_cart.subscribe` (≈37206), so it turns off on any cart update (including the one that already happened on init). If the user opens before any cart subscription run, the loader could stay until the next cart update; the design intent is that cart is already populated by init.

### Network calls on drawer open

- **None** for cross-sell or decision.
- **Optional:** `getCart()` only if the drawer was already open (refresh path).

**References:** `openGokwikSideCart` (≈37321–37337), `cartDataLoader` (≈37322, 37206), `loadConfigurations` and `updateCart` in onMount (≈37175, 37259).

---

## 4. Cart Mutation Event Flow (Add-to-cart)

### When add-to-cart is clicked

1. **`addToCart(params, pausePostExec, properties)`** (≈5254):
   - Validations: `shouldAllowUpsellAddToCart` / `shouldAllowAddToCart` (≈5258–5276).
   - `store_pauseInterceptorExecution.set(true)` (≈5279).
   - **POST** `${getURL(shopDomain$1)}/cart/add.js` with params (≈5280).
   - On success (no `response.description`): if not `pausePostExec`, **`await getCart(false, true)`** (≈5291) — so cart is refetched and store updated.
   - Triggers and store cleanup (≈5329–5342).

2. **`getCart()`** (≈5132):
   - **GET** `${getURL(shopDomain$1)}/cart.js` (≈5135).
   - `store_cart.set(filterCartItems(response))` (≈5137).
   - Then `getDiscounts(skip_discounts)` (≈5139), which may call `fetchAvailableOffers` and discount APIs.

3. **`store_cart.subscribe` callback** (≈37196–37226):
   - `cartDataLoader = false` (≈37206).
   - `fetchProductDetails()` (≈37211) — fetches variant availability for current cart items (for MRP/discounts) if enabled.
   - If AI-powered upsell: **`fetchAIProductRecommendations(lastAddedItem.product_id, intent, maxProducts)`** (≈37212–37214) — **POST** `/v3/kwik-cart/get-product-recommendations` (≈7343).
   - Then `batchCheckVariantsAvailability(upsellVariantIds)` inside `fetchAIProductRecommendations` (≈7361–7366), and `store_productDetails.update` with the result.
   - Rest: discounts, total, manual discount subscription.

### Summary of network on add-to-cart

| Step        | Call                                                                 |
|------------|----------------------------------------------------------------------|
| Add item   | POST `/cart/add.js`                                                  |
| Refresh cart | GET `/cart.js` (via `getCart`)                                      |
| Discounts  | As per `getDiscounts` (e.g. valid-offers, validate, etc.)            |
| AI upsell  | POST `/v3/kwik-cart/get-product-recommendations` (if type is AI)    |
| Variants   | GET `/variants/{id}.js` in batches (from `batchCheckVariantsAvailability` / `getVariantData`) for new variant IDs |

No separate “decision” call for standard upsell; the list is re-derived from config + cart in memory.

**References:** `addToCart` (≈5254–5345), `getCart` (≈5132–5164), `fetchAIProductRecommendations` (≈7341–7369), `batchCheckVariantsAvailability` (≈6507), `getVariantData` (≈5362).

---

## 5. Caching + State Strategy

### In-memory caches

- **productDataCache:** Map, key = product handle (≈5379). Checked in `getProductData` (≈5381–5382); set after successful GET product (≈5387). No TTL; no eviction in file.
- **store_productDetails:** Variant ID → `{ available, compare_at_price }`. Updated by `updateVariantAvailability`, `batchCheckVariantsAvailability`, `getProductData` (≈5390–5393, 6502–6505, 7363–7366).
- **store_configurations:** Full config object. Set from `fetchConfigurations` and optionally from sessionStorage on mount.
- **store_aiProductRecommendations:** Array of AI recommendation objects. Set only in `fetchAIProductRecommendations` (≈7356).

### localStorage / sessionStorage

- **sessionStorage:**
  - `"kwik-cart-request-data"`: full config JSON. Written after successful `loadConfigurations` (≈37405). Read as fallback in `fetchConfigurations` (≈7338) and on mount for fast config hydrate (≈37157).
  - `"body-el-overflow"`, `"html-el-overflow"`: scroll state for drawer (≈37412–37417).
  - `"GKSCOpenedCheckout"`, `"kwik-cart-request-data"` (above), urgency/timer keys, etc.
- **localStorage:**
  - `"gokwik-sidecart-cart-icon-element"`: cart icon parent info (≈37505–37506).
  - `"KWIKSESSIONTOKEN"` read in one place (≈5573).
- No Redis or external cache API in this script.

### Promise de-duplication / TTL / locks

- **No** promise de-duplication (e.g. single in-flight request per key) found for config or recommendations.
- **No** TTL on `productDataCache` or `store_productDetails`.
- **No** explicit lock or mutex; `store_pauseInterceptorExecution` (≈5279, 5337) only gates interceptor execution around add/change, not recommendation or config fetch.

### Event-driven recompute

- **Mutation-based:** Cart and config updates drive recompute via Svelte stores. When `store_cart` or `store_configurations` changes, the upsell component’s subscriptions run and call `setUpsellProducts()` / `getStandardUpsellRecommendations` / `filterUpsellProducts` (≈32873–32907, 32890–32907).
- **In-flight reuse:** Not implemented for config or recommendation requests.

**References:** `productDataCache` (≈5379–5387), `store_productDetails` (≈6502–6505, 7363–7366), sessionStorage read/write (≈7338, 37157, 37405, 37412–37417), `store_cart.subscribe` (≈37196), upsell `store_configurations.subscribe` and `setUpsellProducts` (≈32873–32907).

---

## 6. Cold Start Strategy

### Initialization

- **onMount** of the root sidecart container (≈37154–37282):
  1. Read `sessionStorage.getItem("kwik-cart-request-data")`; if present, parse and apply to `store_configurations` (and fix atcBehaviour) so UI can render from cache immediately (≈37157–37170).
  2. Set `store_shopDomain.set(window.gk_cart_domain)` (≈37171).
  3. In production (non-dashboard): **`await loadConfigurations()`** (≈37175):
     - **GET** `/v3/kwik-cart/request` via `fetchConfigurations()` (≈7332).
     - `removeFreebieBeforeOpening(response.data)` (≈37362) — may call `getCart` and freebie logic.
     - **`updateVariantAvailability(response.data)`** (≈37376): collects all upsell/oneTick/free-gift variant IDs from config and calls **`batchCheckVariantsAvailability(upsellVariantIds)`** (≈6501), then merges result into `store_productDetails`. So **before the drawer is ever opened**, all standard upsell (and related) variant availabilities are pre-warmed.
     - Config merged into `store_configurations` (≈37391–37394), saved to sessionStorage (≈37405).
  4. Subscriptions attached: `store_sideCartOpen`, `store_cart`, `store_offers`, etc. (≈37184–37245).
  5. **`updateCart({ attributes: { "GoKwik-Cart": true } })`** (≈37259): POST `/cart/update.js`, then `store_cart.set(filterCartItems(response))` — so **initial cart is fetched here**, not on first drawer open.
  6. **`getDiscounts()`** (≈37260).
  7. **`$$invalidate(2, loadSidecart = true)`** (≈37255) — sidecart content can render.

So on first load: config + variant availability + cart are loaded in one init sequence; no “first open” stall for those.

### Pre-warming

- **Config:** One GET on mount; result cached in store and sessionStorage.
- **Variant availability:** All upsell/free-gift variant IDs from config are batch-checked in `updateVariantAvailability` (≈6470–6505) using `getVariantData` (Shopify `/variants/{id}.js`) in batches of 5 (≈6516).
- **Cart:** Fetched via `updateCart` on init (≈37259). No full catalog or product map download; only the current cart.

### SAFE-like behavior avoidance

- **Config:** SessionStorage supplies last config on failure and on next load for immediate hydrate; fresh config then overwrites.
- **No “wait for recommendation API” on open:** Standard upsell list is in config; AI recommendations are fetched on cart update and then shown from store. Drawer open does not trigger a recommendation request.
- **Availability:** By the time the user can open the drawer, `updateVariantAvailability` has already run, so upsell tiles can show in-stock/out-of-stock from `store_productDetails` without a loading state for that data.

**References:** onMount (≈37154–37282), `loadConfigurations` (≈37359–37443), `updateVariantAvailability` (≈6470–6505), `batchCheckVariantsAvailability` (≈6507–6554), `updateCart` (≈5345–5350), `loadSidecart` (≈37255).

---

## 7. Layout Strategy

### Cross-sell container and content

- The upsell block is part of the Svelte component tree. It is **always present** when the parent conditions (e.g. config has upsell enabled, not hidden by `store_hideUpsellFlow`) are met; visibility is toggled by data, not by mounting after fetch.
- **Structure:** The container (e.g. `upSell-container`, scroll container, title) is defined in the template; the list is an `each` over `upSellProducts` (≈32431, 32502–32505, 32607–32635). So **structure is static**, **content is dynamic** from `upSellProducts`.
- **Data for content:** `upSellProducts` is derived synchronously from:
  - `store_configurations` (upSell.standard or oneTickUpsell) and `store_cart` (for rule matching and filtering), or
  - `store_aiProductRecommendations` (when AI type and list is non-empty).
- No “insert after fetch” for the list itself: the list is reactive to stores that are already filled by init or by cart-subscription (AI). So **structure does not depend on async**; only the reactive inputs (config, cart, AI result) are async, and they are loaded or updated outside the drawer-open path.

### Hidden state

- If there are no products to show (e.g. no matching rule, or AI not yet loaded), `store_hideUpsellFlow` is set true (≈32906, 32905) and the upsell section can be hidden. There is no separate “skeleton” component for upsell; the section is either shown with product tiles or hidden.

**References:** Upsell block and `upSellProducts` (≈32420–32467, 32502–32505), `each` over `upSellProducts` (≈32630–32635), `store_hideUpsellFlow` (≈32905–32906).

---

## 8. Performance Patterns (Relevant to Timing)

- **requestAnimationFrame:** Used in Svelte runtime for task loop and style cleanup (≈137, 147, 152, 447, 19707–19716). Not used to delay or batch recommendation or config fetch.
- **Debounce/throttle:** `triggerValidation` uses `setTimeout` for validation (≈3285–3286). No debounce on drawer open or recommendation fetch.
- **Optimistic UI:** Cart is updated from server response after `getCart()` post add (≈5291); no optimistic cart update in this file. Variant availability is not optimistically assumed; it’s filled by `updateVariantAvailability` and `batchCheckVariantsAvailability`.
- **Prefetch:** Config load and `updateVariantAvailability` together act as prefetch for all upsell-related variant IDs. No explicit prefetch of product JSON for upsell (product metadata is in config/AI response).
- **IntersectionObserver:** Used for cart icon re-render (≈6458). Not used for lazy-loading recommendations.
- **requestIdleCallback:** Not found in the script.
- **Microtask batching:** Only via Svelte’s normal update cycle; no custom batching for network or state.

So the main “precomputation” is: **config + variant availability on init**, and **AI recommendations on cart update**, not on drawer open.

---

## 9. Key Architectural Differences vs a “SAFE-like” System

- **Decision timing:** Their “decision” for standard upsell is **server-side and static per session**: the config API returns the full rule set and product lists. The client only selects which rule applies (synchronous) and filters by cart. There is no “get recommendation for this cart” call at drawer open.
- **Data at open:** Config and variant availability are loaded **once on script init**, and cart is loaded in the same init (updateCart). So at first drawer open, all data needed for standard upsell is already in memory.
- **AI path:** The only “recommendation API” is for AI type, and it is triggered **on cart mutation** (store_cart.subscribe), not on drawer open. So the drawer can show previous AI results or standard list immediately.
- **No skeleton:** They avoid a loading state for recommendations by not fetching recommendations on open; they either show the pre-loaded standard list or the last AI result, and hide the block when there is nothing to show.
- **Fallback:** SessionStorage holds last config; on failure or on reload, the UI can render from cache while a fresh config is fetched.

---

## 10. How They Achieve “Instant” UX (Summary)

1. **Single config payload** includes full standard upsell rules and product metadata (`suggestedUpsellProducts`, `oneTickUpsell.products`); no extra “recommendation” or “decision” request at drawer open.
2. **Config and variant availability are loaded once on app mount** in `loadConfigurations()` and `updateVariantAvailability()`; drawer open does not trigger config or variant fetch.
3. **Cart is loaded on init** via `updateCart({ attributes: { "GoKwik-Cart": true } })` after config, so the drawer has cart data before first open.
4. **Upsell list is derived synchronously** from in-memory stores (`store_configurations`, `store_cart`, optionally `store_aiProductRecommendations`) via `getStandardUpsellRecommendations` / `filterUpsellProducts` / `setUpsellProducts`; no async “decision” step at render.
5. **Product display data (title, image, price, variants) is embedded in config and AI response**; no per-product Shopify fetch for the list. `getProductData` is only used for the optional product-detail modal.
6. **Variant availability is pre-warmed** for all upsell/free-gift variant IDs at config load, so in-stock/out-of-stock can be shown without a separate request at open.
7. **SessionStorage** provides a config fallback and immediate hydrate on reload, avoiding a blank or stalled UI when the config request fails or is slow.
8. **Reactivity only:** Drawer content is driven by Svelte stores; no “fetch then mount” for the upsell block, so no skeleton needed for that block.
9. **AI recommendations are decoupled from open:** Fetched on cart update and stored; drawer displays whatever is in `store_aiProductRecommendations` at open time (or standard list).
10. **Loader** (`cartDataLoader` / `store_apiLoader`) is used for add-to-cart and free-gift flows, not for “loading recommendations” on drawer open.

---

**Document generated from code inspection of `cart.txt` only. No speculation; all claims tied to the cited line ranges.**
