# Cart System Stabilization and Restoration Plan

**Mode:** Planning only. No code modified. No files deleted.  
**Purpose:** Establish a single source of truth around `cart-pro-v3-runtime` and define a safe, step-by-step execution blueprint.  
**Reference:** Forensic analysis (`FORENSIC_ANALYSIS_FULL_REPO_CART_SYSTEM.md`, `CART_PRO_V3_FORENSIC_ARCHITECTURAL_AUDIT.md`, `CART_TXT_ZERO_LATENCY_AUDIT.md`).

---

## SECTION A — Source of Truth Confirmation

### Declared single source of truth

| Layer | Path | Role |
|-------|------|------|
| **Source of truth frontend** | `revstack/cart-pro-v3-runtime/` | Only storefront cart runtime (Svelte, Vite). Renders cart drawer, recommendations, shipping tease, checkout section. |
| **Source of truth storefront extension** | `revstack/extensions/cart-pro/` | Only theme extension that embeds V3. Block: `cart_pro_embed_v3.liquid`. Assets: `cart-pro-v3.js`, `cart-pro-v3.css`. |
| **Source of truth config backend** | `revstack/app/routes/cart.snapshot.v3.ts` | GET snapshot endpoint for V3 config (mergeWithDefaultV3 + featureFlags). |
| **Source of truth config lib** | `revstack/app/lib/config-v3.ts` | CartProConfigV3 types, DEFAULT_CONFIG_V3, mergeWithDefaultV3. |
| **Source of truth state/engine** | `revstack/cart-pro-v3-runtime/src/engine/Engine.ts` | Engine singleton: loadConfig, syncCart, state updates, effect queue. |
| **Source of truth state store** | `revstack/cart-pro-v3-runtime/src/engine/state.ts` | createStateStore(), createInitialState(), setState/updateState. |

### Verification: no other systems need to remain active for storefront cart

- **Storefront cart rendering:** Only the V3 block (`cart_pro_embed_v3.liquid`) is used when the merchant enables “Cart Pro V3” in Theme customizer. No other embed or script should drive the live cart.
- **Config for storefront:** Only `cart.snapshot.v3.ts` + `config-v3.ts` supply config to the storefront. Legacy bootstrap/snapshot v2 are for legacy/archived paths only.
- **State:** Only the Engine in `cart-pro-v3-runtime` and its single stateStore drive the cart UI. No second cart state system should be active on the storefront.

**Note on paths:** Engine and state live under `revstack/cart-pro-v3-runtime/src/engine/` (not `src/lib/engine/`). All references in this plan use the actual paths.

---

## SECTION B — Protected Systems (DO NOT MODIFY DURING CLEANUP)

### Frontend runtime — PROTECTED (fix in place; do not delete or replace)

| File | Purpose |
|------|---------|
| `revstack/cart-pro-v3-runtime/src/main.ts` | Entry; calls mountCartProV3(componentStyles). |
| `revstack/cart-pro-v3-runtime/src/mount.ts` | Shadow DOM host, getEngine(), cache read, loadConfig from cache, App mount. |
| `revstack/cart-pro-v3-runtime/src/engine/Engine.ts` | Core engine: init, loadConfig, syncCart, setState, effect queue, event bus. |
| `revstack/cart-pro-v3-runtime/src/engine/state.ts` | createStateStore, createInitialState, setState, updateState. |
| `revstack/cart-pro-v3-runtime/src/engine/configSchema.ts` | Runtime config types used by normalizeConfig. |
| `revstack/cart-pro-v3-runtime/src/engine/normalizeConfig.ts` | Normalizes raw config to NormalizedEngineConfig (including freeShipping, discounts.teaseMessage). |
| `revstack/cart-pro-v3-runtime/src/engine/cartApi.ts` | Shopify cart fetch. |
| `revstack/cart-pro-v3-runtime/src/engine/effectQueue.ts` | Effect queue used by Engine. |
| `revstack/cart-pro-v3-runtime/src/engine/eventBus.ts` | Internal events (e.g. cart:external-update). |
| `revstack/cart-pro-v3-runtime/src/ui/App.svelte` | Root component; binds stateStore, enqueues syncCart. |
| `revstack/cart-pro-v3-runtime/src/ui/v2/DrawerV2.svelte` | Drawer shell; passes state to CheckoutSection, CouponSection, Recommendations. |
| `revstack/cart-pro-v3-runtime/src/ui/v2/CheckoutSection.svelte` | Checkout UI, ShippingSection, countdown slot. |
| `revstack/cart-pro-v3-runtime/src/ui/v2/ShippingSection.svelte` | Shipping tease (remaining, unlocked, loading). |
| `revstack/cart-pro-v3-runtime/src/ui/v2/CouponSection.svelte` | Coupon input, teaseMessage from config. |
| `revstack/cart-pro-v3-runtime/src/ui/v2/Recommendations.svelte` | Renders standard + AI recommendations. |
| `revstack/cart-pro-v3-runtime/src/ui/v2/RecommendationCard.svelte` | Single recommendation card; addToCart. |
| `revstack/cart-pro-v3-runtime/src/engine/upsell.ts` | computeStandardUpsell (rule-based, exclude in-cart). |
| `revstack/cart-pro-v3-runtime/src/styles/cart-pro-v2.css` | Primary styles for V3 UI (variables, layout). |

**Protected but to be corrected (behavior only):**

- `revstack/cart-pro-v3-runtime/src/engine/recommendationsApi.ts` — Fix URL/body/response handling; do not remove.
- `revstack/cart-pro-v3-runtime/src/engine/recommendationsStub.ts` — Fix usage (stub only when AI disabled or no result yet); do not delete.
- `revstack/cart-pro-v3-runtime/src/engine/interceptor.ts` — Used by Engine for cart:external-update; do not remove.

### Extension — PROTECTED

| File | Purpose |
|------|---------|
| `revstack/extensions/cart-pro/blocks/cart_pro_embed_v3.liquid` | Injects #cart-pro-v3-root, script src, inline fetch snapshot + applyAppearanceAndLoadConfig. |
| `revstack/extensions/cart-pro/assets/cart-pro-v3.js` | Built bundle from cart-pro-v3-runtime. |
| `revstack/extensions/cart-pro/assets/cart-pro-v3.css` | Built CSS from runtime styles. |

### Config backend — PROTECTED (fix in place)

| File | Purpose |
|------|---------|
| `revstack/app/routes/cart.snapshot.v3.ts` | GET /cart/snapshot/v3 (app proxy: /apps/cart-pro/snapshot/v3). Returns mergeWithDefaultV3 + featureFlags. |
| `revstack/app/lib/config-v3.ts` | CartProConfigV3, DEFAULT_CONFIG_V3, mergeWithDefaultV3. Must include freeShipping and discounts.teaseMessage in type and merge. |

### Engine and state — PROTECTED

Already listed under Frontend runtime above: `Engine.ts`, `state.ts`.

---

## SECTION C — Safe Removal Candidates

**DO NOT DELETE YET — ONLY MARK.** Execute deletion/archive only in Phase 6 after all repairs are verified.

### SAFE TO DELETE (after Phase 6)

| Item | Reason |
|------|--------|
| None recommended for immediate delete | Legacy routes and archived extension may still be needed for themes using old embeds or for rollback. Prefer “disable” or “archive” first. |

### SAFE TO ARCHIVE

| Item | Action |
|------|--------|
| `revstack/archived-extensions/cart-pro-v1-v2/` | Already archived. Keep as archive; ensure no active theme uses it. Document that only V3 embed is supported for new stores. |
| Duplicate route implementation | `cart.snapshot.v2.ts` and `cart.bootstrap.v2.ts` both call buildBootstrapSnapshotV2. One can be archived or redirected to the other in a later cleanup. |

### SAFE TO IGNORE (leave as-is but do not use for V3)

| Item | Notes |
|------|--------|
| `apps/api/` (Express) | Deprecated; not used by Shopify storefront. Leave in repo; do not wire to storefront. |
| `revstack/app/routes/cart.bootstrap.ts` | V1 bootstrap. Used by legacy embed only. Do not use for V3. |
| `revstack/app/routes/cart.decision.ts` | Decision route for legacy. Do not use for V3. |

### SAFE TO LEAVE BUT DISABLE (optional, later phases)

| Item | Disable strategy |
|------|------------------|
| `cart.snapshot.v2.ts` | Keep route; document as legacy. V3 storefront must not call it. |
| `cart.bootstrap.v2.ts` | Same as above; or make it redirect to snapshot v2. |
| `cart.bootstrap.ts` | Keep for legacy; document. |
| `cart.decision.ts` | Keep for legacy; document. |

### Specific evaluation

- **cart.snapshot.v2.ts** — SAFE TO ARCHIVE or leave as legacy. V3 uses only snapshot v3.
- **cart.bootstrap.v2.ts** — SAFE TO ARCHIVE or leave; duplicate of snapshot v2.
- **cart.bootstrap.ts** — SAFE TO LEAVE; used by legacy v1 path.
- **cart.decision.ts** — SAFE TO LEAVE; used by legacy decision flow.
- **apps/api/** — SAFE TO IGNORE; deprecated for storefront.
- **archived-extensions/cart-pro-v1-v2/** — SAFE TO ARCHIVE; already separate; do not activate.

---

## SECTION D — Recommendation System Restoration Plan

### Correct endpoint and contract

- **Endpoint:** POST `/apps/cart-pro/ai/v2` (app proxy). Base URL for runtime must resolve to the app proxy root so that path is `/apps/cart-pro/ai/v2`.
- **Request:** `{ lastAddedProductId: string }` (product ID of last added item). Not `variant_ids`.
- **Response:** `{ products: ProductSnapshot[] }` where ProductSnapshot has: id, productId, variantId, title, imageUrl, price, currency, handle, collections.

### Where recommendations must originate

- **Standard (rule-based):** From config: `config.upsell.standardRules` + `computeStandardUpsell(cart, standardConfig)` in Engine (already correct). Must not be overwritten by stub.
- **AI:** From POST `/apps/cart-pro/ai/v2` with `lastAddedProductId`. Backend: `cart.ai.v2.ts` (same-collection logic, ShopProduct table).

### Where they must be stored

- In Engine state: `state.upsell.standard` (rule-based), `state.upsell.aiRecommendations` (AI).
- Standard: set once per sync from computeStandardUpsell; never overwrite with stub.
- AI: set from API callback only when AI is enabled; use stub only when AI disabled or before first result (and stub must not be “first two cart items” as recommendations).

### Where they must be rendered

- `Recommendations.svelte`: `recommendations = state?.upsell?.standard ?? []`, `aiRecommendations = state?.upsell?.aiRecommendations ?? []`, then combine for display.
- `RecommendationCard.svelte`: render each item; addToCart(variantId). Optional: filter out variants already in cart in the UI or in the data layer.

### Corrective steps (no code yet — specification only)

1. **recommendationsApi.ts**
   - Base URL: must resolve to app proxy so that POST goes to `/apps/cart-pro/ai/v2`. Use same mechanism as snapshot (e.g. same origin + path `/apps/cart-pro/ai/v2`).
   - Body: `JSON.stringify({ lastAddedProductId: String(productId) })`. Obtain lastAddedProductId from cart (e.g. last added line item’s product id).
   - Response: read `data.products` (not `data.recommendations` or `data.variants`). Map ProductSnapshot to the shape expected by UI (variantId, title, imageUrl, price, etc.).

2. **Engine.ts (syncCart)**
   - After computing `standard = computeStandardUpsell(...)`, set `upsell.standard = standard`. Do not overwrite with stub.
   - For AI: if aiEnabled, call debouncedPostRecommendations with cart and lastAddedProductId (from cart). In callback, set `upsell.aiRecommendations = result` (mapped from backend products). Do not set aiRecommendations to stub when AI is enabled; only set stub when AI is disabled or as initial/fallback before first successful fetch, and ensure stub does not recommend items already in cart.

3. **recommendationsStub.ts**
   - Stub must not be “first two cart items.” Options: (a) return [] for stub when used as placeholder, or (b) build stub from config/standardRules only, or (c) filter buildStubRecommendations so it never includes variants already in cart. Rule: recommendations never include items already in cart.

4. **Backend**
   - No change required; already returns `{ products }`. Optionally add `recommendations` alias for compatibility; not required if runtime is updated to read `products`.

### Summary

- Origin: standard from config + computeStandardUpsell; AI from POST `/apps/cart-pro/ai/v2` with `lastAddedProductId`.
- Store: state.upsell.standard and state.upsell.aiRecommendations; no overwrite of standard with stub.
- Render: Recommendations.svelte; data must exclude in-cart items (handled in computeStandardUpsell and backend; stub must not add in-cart items).

---

## SECTION E — Config Loading Restoration Plan (Match cart.txt)

### When config must load

1. **At module load (optional):** Bundle-embedded default config so engine never starts with `config === null` for structure. UI can show safe defaults immediately.
2. **Synchronously before or at mount:** Read sessionStorage key `cart-pro-v3-config`. If present, parse and call `engine.loadConfig(parsed)` and `applyAppearanceVariables(host, parsed)` before or at App mount. This matches cart.txt “first line of onMount = sessionStorage read.”
3. **Async:** Inline script in Liquid already fetches `/apps/cart-pro/snapshot/v3`. On success, call `applyAppearanceAndLoadConfig(config)` → loadConfig + sessionStorage write. Snapshot overwrites cache and engine config when it completes.

### When UI must render

- **Current:** App mounts immediately; no gate. Components that depend on config may see null until snapshot returns.
- **Target (cart.txt parity):** Option A — Mount App immediately but ensure config is never null (bundle default + cache). Option B — Gate drawer content visibility (e.g. “content ready” flag) on “config loaded” (and optionally “cart synced”), set after loadConfig from cache or snapshot. Recommendation: Option A for simplicity; add bundle default + cache read so config is always defined; optionally add a content gate in a later iteration.

### Whether UI must wait for config

- For “no flash of wrong/missing data”: config should be available before drawer content is shown. With bundle default + cache read before mount, config is usually present; snapshot can refresh in background.
- No requirement to block script load on snapshot; snapshot can run in parallel with mount when cache exists.

### Whether default config must exist in bundle

- **Yes.** Define a single default config object (aligned with DEFAULT_CONFIG_V3 or a runtime-specific default) and initialize the engine (or a config store) with it at module load so that `getConfig()` never returns null. Override with cache or snapshot when available.

### Precise loading sequence (target)

1. **Script load:** Engine created; config set to bundle default (not null).
2. **mount.ts:** ensureBodyHost(); read sessionStorage `cart-pro-v3-config`; if present, applyAppearanceVariables(host, parsed), engine.loadConfig(parsed). Then mount App.
3. **Liquid inline:** fetch `/apps/cart-pro/snapshot/v3` (already in parallel). On resolve: applyAppearanceAndLoadConfig(config) → loadConfig + sessionStorage write.
4. **App.svelte onMount:** enqueue syncCart (unchanged).
5. **Result:** First paint has config (default or cache); snapshot refreshes and overwrites; no null config for structure.

---

## SECTION F — UI Rendering Restoration Plan

### Render lifecycle (target)

```
Page load
  → Liquid: div #cart-pro-v3-root, script cart-pro-v3.js (defer), inline fetch snapshot
  → Runtime load (main.ts → mountCartProV3)
  → Engine created with bundle default config (config !== null)
  → mount: ensureBodyHost, sessionStorage read → if cache: loadConfig(cache), applyAppearance(host, cache)
  → Config load: from cache (sync) or from snapshot (async when fetch completes)
  → App mount (Svelte)
  → onMount: enqueue syncCart
  → Cart load: syncCart in effect queue → cart fetch → state update (cart, shipping, upsell, etc.)
  → State ready: stateStore has cart, shipping, upsell (standard from computeStandardUpsell; AI from callback or stub only when appropriate)
  → UI render: DrawerV2, CheckoutSection, ShippingSection, CouponSection, Recommendations react to stateStore and engine.getConfig()
```

### Correct gating mechanism

- **Option 1 (minimal):** No explicit gate; ensure config is never null (bundle default + cache). Components already handle missing data with fallbacks.
- **Option 2 (cart.txt-style):** Introduce a “content ready” flag (e.g. `loadSidecart`). Set to true only after loadConfig has run (from cache or snapshot) and optionally after first syncCart. Drawer content (or the open button) is hidden until flag is true. Implement in App.svelte or DrawerV2.svelte.

Recommendation: Implement Option 1 first (default config + cache); add Option 2 if product requires “no drawer until ready.”

### Fixes that affect UI

- **Shipping tease:** Backend snapshot must include `freeShipping: { thresholdCents }`; config-v3 merge must include it; then syncCart will set shipping.remaining and ShippingSection will show “Add X more for free shipping.”
- **Coupon tease:** Snapshot must include `discounts.teaseMessage`; config-v3 merge must include it; CouponSection will show tease when no codes applied.
- **Countdown:** CheckoutSection countdownVisible should be bound to `config?.appearance?.countdownEnabled` (or --cp-countdown-enabled). Countdown div must have actual content (timer or message); add logic in CheckoutSection or a child component.
- **Recommendations:** See Section D; no stub overwrite of standard; AI from correct endpoint; stub never recommends in-cart items.

---

## SECTION G — Final Target Architecture Map

### High-level flow

```
Storefront (merchant theme)
  → Theme includes block "Cart Pro V3"
  → Extension: cart_pro_embed_v3.liquid
       → div #cart-pro-v3-root
       → script cart-pro-v3.js (defer)
       → inline: fetch /apps/cart-pro/snapshot/v3 → applyAppearanceAndLoadConfig(config)

Extension assets
  → cart-pro-v3.js (built from cart-pro-v3-runtime)
  → cart-pro-v3.css

Runtime (cart-pro-v3-runtime)
  → main.ts → mountCartProV3(componentCss)
  → mount.ts → getEngine(), ensureBodyHost(), cache read, loadConfig(cache), App mount
  → Engine (singleton)
       → stateStore (single writable)
       → loadConfig(raw) from cache or snapshot
       → syncCart() → cartApi, shipping from config, standard upsell, AI recommendations (POST /apps/cart-pro/ai/v2)
  → UI: App.svelte → DrawerV2 → CheckoutSection, ShippingSection, CouponSection, Recommendations

Backend (revstack React Router app)
  → Snapshot endpoint: GET /cart/snapshot/v3 → cart.snapshot.v3.ts → mergeWithDefaultV3(shopConfig.configV3) + featureFlags
  → Recommendation endpoint: POST /cart/ai/v2 → cart.ai.v2.ts → same-collection by lastAddedProductId, returns { products }
  → Config lib: config-v3.ts (DEFAULT_CONFIG_V3, mergeWithDefaultV3)
  → App proxy: /cart/* ↔ /apps/cart-pro/*
```

### Data flow

| Data | Source | Consumer |
|------|--------|----------|
| Config | GET /apps/cart-pro/snapshot/v3, sessionStorage cache, bundle default | Engine.loadConfig; applyAppearanceVariables; UI via engine.getConfig() |
| Cart | Shopify Cart API (cartApi) in syncCart | stateStore.cart; DrawerV2, CheckoutSection, CartItems |
| Shipping tease | config.freeShipping.thresholdCents + cart subtotal in syncCart | stateStore.shipping; ShippingSection |
| Standard recommendations | config.upsell.standardRules + computeStandardUpsell(cart) | stateStore.upsell.standard; Recommendations.svelte |
| AI recommendations | POST /apps/cart-pro/ai/v2 { lastAddedProductId } → { products } | stateStore.upsell.aiRecommendations; Recommendations.svelte |
| Analytics | POST /apps/cart-pro/analytics/v3 | Engine (analytics module) |

### Component ownership

- **Storefront:** Only V3 block; only cart-pro-v3-runtime bundle.
- **Config:** Only snapshot v3 and config-v3.ts for storefront.
- **State:** Only Engine + state.ts.
- **Recommendations:** Standard from config + computeStandardUpsell; AI from cart.ai.v2 only.

---

## SECTION H — Execution Phases

### Phase 1 — Isolate source of truth

| Step | Files involved | Purpose | Expected result |
|------|----------------|--------|-----------------|
| 1.1 | docs, README or internal doc | Document that cart-pro-v3-runtime + extensions/cart-pro + cart.snapshot.v3 + config-v3.ts + Engine + state.ts are the single source of truth for storefront cart. | Single reference for all future work. |
| 1.2 | revstack/app/routes.ts (or route config) | Ensure only snapshot v3 is referenced for V3 embed; no accidental v2 bootstrap for V3. | No V3 code path calls v2 or v1 bootstrap. |
| 1.3 | cart_pro_embed_v3.liquid | Confirm it only fetches /apps/cart-pro/snapshot/v3 and loads cart-pro-v3.js. | No legacy script or snapshot URL. |

**Deliverable:** Written source-of-truth definition; V3 path uses only V3 endpoints and assets.

---

### Phase 2 — Disable legacy systems

| Step | Files involved | Purpose | Expected result |
|------|----------------|--------|-----------------|
| 2.1 | No code change | Confirm no active theme uses archived-extensions/cart-pro-v1-v2. Document that new stores use only V3. | Clarity that V3 is the only supported embed. |
| 2.2 | Optional: cart.bootstrap.v2.ts, cart.snapshot.v2.ts | Add comment or short-circuit that these are legacy; V3 must not call them. Or leave as-is and document. | No V3 flow depends on v2 snapshot/bootstrap. |
| 2.3 | apps/api | Do not wire to storefront; document as deprecated. | No storefront traffic to apps/api. |

**Deliverable:** Legacy and duplicate routes clearly marked or documented; no impact on V3.

---

### Phase 3 — Repair runtime pipeline

| Step | Files involved | Purpose | Expected result |
|------|----------------|--------|-----------------|
| 3.1 | config-v3.ts | Ensure CartProConfigV3 and mergeWithDefaultV3 include freeShipping and discounts.teaseMessage (types and merge branches). | Snapshot response includes freeShipping.thresholdCents and discounts.teaseMessage. |
| 3.2 | cart.snapshot.v3.ts | Ensure response passes through mergeWithDefaultV3 output including new fields. | No strip of freeShipping or teaseMessage. |
| 3.3 | cart-pro-v3-runtime: normalizeConfig.ts, configSchema.ts | Already support freeShipping and teaseMessage; verify they are normalized from raw. | Runtime config has freeShipping and discounts.teaseMessage when snapshot sends them. |
| 3.4 | Engine.ts (loadConfig) | Already updates state from config; verify shipping is updated in syncCart from this.config.freeShipping. | Shipping threshold available in syncCart. |
| 3.5 | Default config in bundle | Add bundle-embedded default config; initialize engine (or config) with it so getConfig() never returns null. | First paint has valid config structure. |
| 3.6 | mount.ts | Keep sessionStorage read before App mount; when cache exists, loadConfig(parsed) and applyAppearanceVariables(host, parsed). | Cache restores config and appearance before mount. |

**Deliverable:** Config always defined (default + cache + snapshot); snapshot and runtime support freeShipping and teaseMessage; shipping tease and coupon tease can render.

---

### Phase 4 — Repair recommendations

| Step | Files involved | Purpose | Expected result |
|------|----------------|--------|-----------------|
| 4.1 | recommendationsApi.ts | Change URL to app-proxy path for AI: e.g. /apps/cart-pro/ai/v2. Body: { lastAddedProductId }. Parse response.products and map to UI shape. | Runtime calls correct endpoint with correct body; AI results stored in state. |
| 4.2 | Engine.ts (syncCart) | After setting upsell.standard from computeStandardUpsell, do not overwrite with stub. Set aiRecommendations only from API callback (or stub only when AI disabled / no result yet). | Standard recommendations always from rules; AI slot from API or safe stub. |
| 4.3 | recommendationsStub.ts or Engine | Stub must not recommend items already in cart. Either stub = [] or stub built from config/standardRules only, or filter out in-cart variants. | No “same product in cart” in recommendations list. |
| 4.4 | Engine.ts | Pass lastAddedProductId (from cart) into debouncedPostRecommendations; recommendationsApi accepts it and sends in body. | Backend receives lastAddedProductId and returns same-collection products. |

**Deliverable:** Recommendations endpoint and contract fixed; standard and AI both correct; no in-cart items in recommendations.

---

### Phase 5 — Restore exact cart.txt behavior

| Step | Files involved | Purpose | Expected result |
|------|----------------|--------|-----------------|
| 5.1 | mount.ts, Engine | Bundle default config + cache read before App mount (already partially in place). | Config bootstrap matches cart.txt (default + cache + snapshot). |
| 5.2 | CheckoutSection.svelte, DrawerV2.svelte | Bind countdownVisible to config.appearance.countdownEnabled (or --cp-countdown-enabled). | Countdown visibility configurable. |
| 5.3 | CheckoutSection.svelte (or new component) | Add countdown content: timer or urgency message using config.appearance.countdownDurationMs or similar. | Countdown div shows real content. |
| 5.4 | Optional: App.svelte or DrawerV2 | Content gate: set “content ready” to true only after config (and optionally cart) ready; hide drawer content until then. | Optional parity with cart.txt loadSidecart behavior. |

**Deliverable:** Config bootstrap, countdown visibility and content, and optional content gate aligned with cart.txt.

---

### Phase 6 — Cleanup and finalize

| Step | Files involved | Purpose | Expected result |
|------|----------------|--------|-----------------|
| 6.1 | All modified files | Run tests, manual smoke test: load storefront, open cart, check config, shipping tease, coupon tease, recommendations, countdown. | No regressions; all features work. |
| 6.2 | docs | Update any runbooks or architecture docs with final source of truth and data flow. | Documentation matches implementation. |
| 6.3 | Optional: cart.snapshot.v2.ts, cart.bootstrap.v2.ts | If desired, remove one of the duplicate v2 routes or add deprecation comments; do not remove until no legacy theme depends on them. | Reduced duplication or clear deprecation. |
| 6.4 | Do not delete | archived-extensions, cart.bootstrap.ts, cart.decision.ts, apps/api remain unless explicitly approved for removal in a separate change. | Safe cleanup; no accidental removal of legacy paths. |

**Deliverable:** Stable V3-only cart; docs updated; optional deprecation/cleanup only after verification.

---

## Summary

- **Single source of truth:** Frontend: `cart-pro-v3-runtime`; extension: `extensions/cart-pro`; config backend: `cart.snapshot.v3.ts` + `config-v3.ts`; state: `Engine.ts` + `state.ts`.
- **Protected:** All critical runtime, extension, and config files listed in Section B; fix in place, do not delete.
- **Safe to remove later:** Only after Phase 6; prefer archive/disable over delete for legacy routes and archived extension.
- **Recommendations:** Use POST `/apps/cart-pro/ai/v2` with `lastAddedProductId`; response `products`; do not overwrite standard with stub; stub must not recommend in-cart items.
- **Config:** Bundle default + sessionStorage cache + snapshot; snapshot must include freeShipping and discounts.teaseMessage; UI must not see null config.
- **UI:** Render lifecycle and optional content gate defined; countdown bound to config and given real content.
- **Phases:** 1 Isolate → 2 Disable legacy → 3 Repair config pipeline → 4 Repair recommendations → 5 cart.txt parity → 6 Cleanup and finalize.

**No code has been modified in this plan. This document is the execution blueprint only.**
