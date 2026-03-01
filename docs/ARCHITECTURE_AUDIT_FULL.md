# Full Architecture Audit — revPRO Cart Pro

**Date:** 2025-02-24  
**Type:** Structural diagnostic. No refactor. Exact code paths only.

---

## PHASE 1 — Generation Mapping (V1 / V2 / V3)

### 1. V1 runtime entry points

| Type | File / path | Storefront URL (app proxy) |
|------|-------------|----------------------------|
| Bootstrap | `revstack/app/routes/cart.bootstrap.ts` | GET `/apps/cart-pro/bootstrap` |
| Decision | `revstack/app/routes/cart.decision.ts` | POST `/apps/cart-pro/decision` (re-export: `apps.cart-pro.decision.ts`) |
| Decision (alt) | Same handler | POST `/cart/decision` (proxy can forward either path) |
| Analytics event | `revstack/app/routes/cart.analytics.event.ts` | POST `/apps/cart-pro/analytics/event` (re-export: `apps.cart-pro.analytics.event.ts`) |

**Storefront JS (V1):** Only in archived extension.  
- `revstack/archived-extensions/cart-pro-v1-v2/assets/cart-pro.js` — bootstrap: `fetch("/apps/cart-pro/bootstrap")`, decision: `window.location.origin + "/apps/cart-pro/decision"`, analytics: `fetch(..., "/apps/cart-pro/analytics/event")`.  
- No V1 block in active extension.

### 2. V2 runtime entry points

| Type | File | Storefront URL |
|------|------|----------------|
| Snapshot | `revstack/app/routes/cart.snapshot.v2.ts` | GET `/apps/cart-pro/snapshot/v2` |
| Bootstrap (same builder) | `revstack/app/routes/apps.cart-pro.bootstrap.v2.ts` | GET `/apps/cart-pro/bootstrap/v2` |
| AI overlay | `revstack/app/routes/apps.cart-pro.ai.v2.ts` | POST `/apps/cart-pro/ai/v2` |

**Storefront JS (V2):** Only in archived extension.  
- `revstack/archived-extensions/cart-pro-v1-v2/blocks/cart_pro_embed.liquid` — `fetch("/apps/cart-pro/snapshot/v2", ...)`, then `cart-pro-ui.js` + `cart-pro-v2.js`; V2 uses `AI_V2_URL = "/apps/cart-pro/ai/v2"`.

### 3. V3 runtime entry points

| Type | File | Storefront URL |
|------|------|----------------|
| Snapshot | `revstack/app/routes/apps.cart-pro.snapshot.v3.ts` | GET `/apps/cart-pro/snapshot/v3` |
| Analytics | `revstack/app/routes/apps.cart-pro.analytics.v3.ts` | POST `/apps/cart-pro/analytics/v3` |

**Storefront JS (V3):**  
- `revstack/extensions/cart-pro/blocks/cart_pro_embed_v3.liquid` — inline: `fetch('/apps/cart-pro/snapshot/v3', { credentials: 'same-origin' })` → `loadConfig(config)` on `window.CartProV3Engine`; script: `{{ 'cart-pro-v3.js' | asset_url }}` (built from `cart-pro-v3-runtime`).  
- Runtime entry: `revstack/cart-pro-v3-runtime/src/main.ts` → `mountCartProV3(styles)`.

### 4. Liquid block references (active vs archived)

| Block | Extension location | References |
|-------|-------------------|------------|
| **Active** | `revstack/extensions/cart-pro/blocks/cart_pro_embed_v3.liquid` | `/apps/cart-pro/snapshot/v3`, `cart-pro-v3.js` |
| **Archived** | `revstack/archived-extensions/cart-pro-v1-v2/blocks/cart_pro_embed.liquid` | `/apps/cart-pro/snapshot/v2`, `cart-pro.css`, `cart-pro-ui.js`, `cart-pro-v2.js` |

Only the active extension is shipped; archived is not. So **in production (active extension only)** the only Liquid-referenced paths are **V3**: snapshot v3 and cart-pro-v3.js.

### 5. Routes reachable from storefront (app proxy)

App proxy (`revstack/shopify.app.toml`): `url = "/cart"`, `prefix = "apps"`, `subpath = "cart-pro"`. Store requests to `https://store.com/apps/cart-pro/*` hit the app. React Router uses flat file-based routes; route file `apps.cart-pro.snapshot.v3.ts` → path `apps/cart-pro/snapshot/v3`. So all `apps.cart-pro.*` routes are reachable when the storefront calls them.

- **Reachable and referenced by active Liquid:**  
  - GET `/apps/cart-pro/snapshot/v3`  
  - POST `/apps/cart-pro/analytics/v3` (called by V3 engine when flushing analytics).
- **Reachable but not referenced by any active Liquid:**  
  - GET `/apps/cart-pro/bootstrap` (V1)  
  - GET `/apps/cart-pro/snapshot/v2` (V2)  
  - GET `/apps/cart-pro/bootstrap/v2` (V2)  
  - POST `/apps/cart-pro/decision` (V1)  
  - POST `/apps/cart-pro/analytics/event` (V1)  
  - POST `/apps/cart-pro/ai/v2` (V2)

### 6. Dead / orphaned

- **Backend routes not called by any current storefront flow (active extension):**  
  V1: `cart.bootstrap`, `cart.decision`, `apps.cart-pro.decision`, `cart.analytics.event`, `apps.cart-pro.analytics.event`.  
  V2: `cart.snapshot.v2`, `apps.cart-pro.bootstrap.v2`, `apps.cart-pro.ai.v2`.  
  These are **live code paths** (reachable if someone uses the archived block or calls the URL) but **orphaned from the single active embed** (cart_pro_embed_v3).

- **V3 frontend call with no backend in this repo:**  
  - `revstack/cart-pro-v3-runtime/src/engine/recommendationsApi.ts`: `POST ${getBaseUrl()}recommendations` (body: `{ variant_ids }`). No route in revstack handles `/recommendations`; 404 unless theme or another service provides it.

- **Truly dead (unreachable):**  
  No route file is unreachable; all are valid HTTP endpoints. Dead in the sense of “no active UI path”: V1/V2 routes above when only V3 block is enabled.

---

**Phase 1 output:**

```
V1 Active Paths:
  - Storefront: NONE (V1 only in archived block).
  - Backend (reachable): GET /apps/cart-pro/bootstrap (cart.bootstrap.ts),
    POST /apps/cart-pro/decision (cart.decision.ts, apps.cart-pro.decision.ts),
    POST /apps/cart-pro/analytics/event (cart.analytics.event.ts, apps.cart-pro.analytics.event.ts).

V2 Active Paths:
  - Storefront: NONE (V2 only in archived block).
  - Backend (reachable): GET /apps/cart-pro/snapshot/v2 (cart.snapshot.v2.ts),
    GET /apps/cart-pro/bootstrap/v2 (apps.cart-pro.bootstrap.v2.ts),
    POST /apps/cart-pro/ai/v2 (apps.cart-pro.ai.v2.ts).

V3 Active Paths:
  - Storefront: cart_pro_embed_v3.liquid → fetch /apps/cart-pro/snapshot/v3; cart-pro-v3.js (mount → Engine).
  - Backend: GET /apps/cart-pro/snapshot/v3 (apps.cart-pro.snapshot.v3.ts),
    POST /apps/cart-pro/analytics/v3 (apps.cart-pro.analytics.v3.ts).

Dead / Orphaned:
  - Orphaned from active Liquid: all V1 and V2 backend routes (still reachable if URL called).
  - V3 AI: POST /recommendations called by Engine but no handler in revstack (endpoint missing in app).
  - Archived extension: revstack/archived-extensions/cart-pro-v1-v2/ (not deployed with active app).
```

---

## PHASE 2 — Runtime → Backend → DB Wiring (V3)

**Exact flow when drawer opens (V3):**

1. **What triggers cart sync?**  
   - **First sync:** `revstack/cart-pro-v3-runtime/src/ui/App.svelte` — `onMount` → `engine.enqueueEffect(async () => { await engine.syncCart(); })`.  
   - **Later syncs:** `Engine.ts` — `on('cart:external-update', () => this.enqueueEffect(() => this.syncCart()))`; `cart:external-update` is emitted by `revstack/cart-pro-v3-runtime/src/engine/interceptor.ts` (PerformanceObserver on `/cart/add`, `/cart/change`, `/cart/clear`).  
   - **Drawer open itself:** `themeConnector.ts` click handler sets `engine.setState({ ui: { drawerOpen: true } })`; it does **not** call sync. So first sync is on App mount; subsequent syncs on external cart update or internal mutations (add/change/remove).

2. **Which route is called for “cart sync”?**  
   Cart sync is **not** a single app route. Engine calls **Shopify storefront cart APIs** (same-origin):  
   - `revstack/cart-pro-v3-runtime/src/engine/cartApi.ts`: `fetchCart()` → GET `cartJsUrl()` (`/cart.js` or `Shopify.routes.root + 'cart.js'`), `addToCart` → POST `cart/add.js`, `changeCart` → POST `cart/change.js`, `removeItem` → POST `cart/change.js` with quantity 0.  
   So **no** app proxy route is called for cart sync; only storefront `/cart.js`, `/cart/add.js`, `/cart/change.js`.

3. **Does it call decision engine?**  
   **No.** V3 does not call `/apps/cart-pro/decision` or any decision route. Snapshot comment: “No decision engine, no catalog warm, no V2 snapshot.”

4. **Does it call catalog warm?**  
   **No.** V3 snapshot does not use `catalog-warm.server.ts`, `catalog-index.server.ts`, or Redis catalog.

5. **Does it use V1/V2 logic?**  
   **No.** Snapshot v3 uses only `getShopConfig`, `getBillingContext`, `mergeWithDefault(shopConfig.configV3)`, and `featureFlagsFromCapabilities(billing.capabilities)`. No `buildBootstrapSnapshotV2`, no decision, no V1 bootstrap.

6. **What Prisma models are touched on “drawer open + first sync”?**  
   - **Snapshot (config load):** Fetched once by Liquid inline script before/around mount. Loader `apps.cart-pro.snapshot.v3.ts` → `getShopConfig(shop)` → `prisma.shopConfig.findUnique` (or create). So **ShopConfig** is read.  
   - **Sync itself:** Only storefront cart APIs; no Prisma in this app for cart fetch.  
   - **If analytics flush runs:** `apps.cart-pro.analytics.v3.ts` action → `prisma.cartProEventV3.createMany`. So **CartProEventV3** is written when events are flushed.

7. **What DB tables are involved?**  
   - **ShopConfig** (read for snapshot; configV3 column used when present).  
   - **CartProEventV3** (write when V3 analytics batch is sent).  
   - Session (via `authenticate.public.appProxy` for snapshot and analytics).

---

**Phase 2 output:**

```
V3 Runtime Data Flow:

Frontend:
  - Block: fetch GET /apps/cart-pro/snapshot/v3 → loadConfig(engine).
  - main.ts: mountCartProV3(styles) → ensureBodyHost(), injectHideOtherCartsStyle(), themeConnector, App in shadow root.
  - App.svelte onMount: enqueueEffect(syncCart).
  - syncCart: cartApi.fetchCart() → GET /cart.js (storefront); then rewards/upsell/freeGifts/discount reapply; optional POST /recommendations (no app route).
  - Analytics: Engine.flushAnalyticsEvents → sendAnalyticsBatch() → POST /apps/cart-pro/analytics/v3.

Route (snapshot):
  - GET /apps/cart-pro/snapshot/v3 → apps.cart-pro.snapshot.v3.ts loader.

Service:
  - getShopConfig(shop) → prisma.shopConfig.findUnique (or create); on P2022 → getFallbackShopConfig (configV3: null).
  - getBillingContext(shop, shopConfig).
  - mergeWithDefault(shopConfig.configV3); featureFlagsFromCapabilities(billing.capabilities) overwrite.

Engine:
  - None (no decision engine, no catalog warm).

DB Model:
  - ShopConfig (read; configV3 read when column exists).
  - CartProEventV3 (write on analytics batch).

Tables:
  - ShopConfig.
  - CartProEventV3.
```

---

## PHASE 3 — Snapshot & Config Integrity (V3)

1. **Where is configV3 loaded?**  
   - **Backend:** `revstack/app/routes/apps.cart-pro.snapshot.v3.ts` loader: `const shopConfig = await getShopConfig(shop); const persisted = shopConfig.configV3;`  
   - **Source:** `revstack/app/lib/shop-config.server.ts` — `getShopConfig()` → `prisma.shopConfig.findUnique({ where: { shopDomain } })`; no `select`, so full row including `configV3` is returned.  
   - **Fallback:** On Prisma error P2022 (e.g. configV3 column missing), `getFallbackShopConfig(shop)` is used; it sets `configV3: null` (see `shop-config.server.ts` line 127).

2. **Where is it edited?**  
   **Nowhere in the repo.** No `prisma.shopConfig.update` or `updateMany` writes `configV3`. Grep: only reads and fallback; no write path to configV3.

3. **Is admin UI writing to configV3?**  
   **No.** `revstack/app/routes/app.settings.tsx` action updates: freeShippingThresholdCents, baselineAovCents, enableCrossSell, enableMilestones, enableCouponTease, milestonesJson, recommendationStrategy, recommendationLimit, manualCollectionIds, primaryColor, accentColor, borderRadius, showConfetti, countdownEnabled, emojiMode, engineVersion. It does **not** include configV3.

4. **Is fallback masking missing DB columns?**  
   **Partially.** `getFallbackShopConfig` returns a full object including `configV3: null`. So if the DB has no `configV3` column (P2022), the snapshot still runs with `persisted = null` and `mergeWithDefault(null)` returns defaults; then `featureFlagsFromCapabilities(billing.capabilities)` overwrites feature flags. So runtime gets a valid shape and billing still gates. The only “masking” is that **persisted V3 config** (discounts, freeGifts, upsell, rewards, checkout, analytics) is lost when using fallback — all come from defaults. No silent wrong value; just no persisted V3 config.

5. **Are billing capabilities enforced at runtime AND snapshot?**  
   - **Snapshot:** Yes. `apps.cart-pro.snapshot.v3.ts`: `rawConfig.featureFlags = featureFlagsFromCapabilities(billing.capabilities);` — server overwrites feature flags from billing. So snapshot always reflects billing.  
   - **Runtime:** Yes. Engine checks `this.config.featureFlags.enable*` before applying discounts, free gifts, upsell, rewards, checkout, analytics (e.g. `emitEvent` returns early if `!config.featureFlags.enableAnalytics`).  
   - **Analytics route:** `apps.cart-pro.analytics.v3.ts` does **not** re-check billing; it accepts any valid batch from app-proxy-authenticated request. Gating is at snapshot (enableAnalytics false) and engine (no emit when disabled). So billing is enforced at snapshot + runtime; analytics endpoint is “trust the client after auth.”

---

**Phase 3 output:**

```
Config Source of Truth:
  - DB: ShopConfig.configV3 (Json?). Read in getShopConfig() in shop-config.server.ts; no select, full row.

Admin Writes To:
  - app.settings.tsx: ShopConfig fields only (V1/flat fields). configV3 is NOT written anywhere.

Runtime Reads From:
  - apps.cart-pro.snapshot.v3 loader → getShopConfig(shop) → shopConfig.configV3 → mergeWithDefault(persisted) + featureFlagsFromCapabilities(billing.capabilities).

Billing Gate Enforcement:
  - Snapshot: featureFlags overwritten by getBillingContext + resolveCapabilities (allowCrossSell → enableUpsell, etc.).
  - Runtime: Engine checks config.featureFlags.enable* before discount/upsell/analytics/etc.
  - Analytics v3 route: No billing check; relies on snapshot + engine to gate.

Inconsistencies:
  - configV3 is never written by admin; V3 persisted config can only be changed by direct DB or a future admin screen. Fallback when configV3 column missing is safe (defaults + billing flags).
```

---

## PHASE 4 — Admin UI Audit

1. **Which admin pages exist:**  
   - `revstack/app/routes/app._index.tsx` — dashboard.  
   - `revstack/app/routes/app.settings.tsx` — settings (config form).  
   - `revstack/app/routes/app.onboarding.tsx` — onboarding.  
   - `revstack/app/routes/app.analytics.tsx` — analytics.  
   - `revstack/app/routes/app.billing.tsx` — billing.  
   - `revstack/app/routes/app.upgrade.tsx` — upgrade.  
   - `revstack/app/routes/app.additional.tsx` — additional.  
   - `revstack/app/routes/app.tsx` — layout wrapper.

2. **Which edit V1 config:**  
   **app.settings.tsx** only. Action: `prisma.shopConfig.update` with freeShippingThresholdCents, baselineAovCents, enableCrossSell, enableMilestones, enableCouponTease, milestonesJson, recommendationStrategy, recommendationLimit, manualCollectionIds, primaryColor, accentColor, borderRadius, showConfetti, countdownEnabled, emojiMode, engineVersion.

3. **Which edit V2 config:**  
   **None.** V2 uses same ShopConfig flat fields (e.g. enableCrossSell, manualCollectionIds) built by `buildBootstrapSnapshotV2`; the only writer of those is still app.settings (V1-style fields). No separate “V2 config” editor.

4. **Does any page edit configV3?**  
   **No.** No admin route writes configV3.

5. **Duplicate config editors:**  
   **No.** Single settings page. No second UI writing ShopConfig for cart.

---

**Phase 4 output:**

```
Admin Pages:
  app._index.tsx, app.settings.tsx, app.onboarding.tsx, app.analytics.tsx, app.billing.tsx, app.upgrade.tsx, app.additional.tsx, app.tsx.

Config Editors:
  app.settings.tsx (single form).

V1 Config Writes:
  app.settings.tsx → prisma.shopConfig.update (flat fields: thresholds, toggles, colors, engineVersion, etc.).

V2 Config Writes:
  None (V2 reads same ShopConfig flat fields; no dedicated V2 editor).

V3 Config Writes:
  None. configV3 is never written by admin.

Conflicts:
  None. Single editor; no duplicate writes. V3 config (configV3 JSON) has no UI to edit.
```

---

## PHASE 5 — Cart Layer Comparison vs cart.txt

Reference: `cart.txt` / `cart_unminified.txt` in repo root (GoKwik-style sidecart: shadow DOM, body append, hide other carts, etc.).

| Concern | cart.txt / cart_unminified | revstack V3 (cart-pro-v3-runtime) |
|--------|----------------------------|-----------------------------------|
| Body-mounted shadow root | Yes: `document.body.appendChild(container); container.attachShadow({ mode: "open" });` (cart_unminified.txt ~38727–38775). | Yes: `ensureBodyHost()` creates div, `host.attachShadow({ mode: 'open' })`, App in shadow (mount.ts). |
| Fixed z-index overlay | Yes: high z-index (e.g. 99999999, 100001 in snippets). | Yes: host `zIndex: '10000000'`, `position: fixed`, `inset: 0` (mount.ts). |
| MutationObserver hide strategy | Yes: MutationObserver used (e.g. cart_unminified 6403, 6444); hide other carts via selectors. | Partial: No MutationObserver for “hide.” Uses injectHideOtherCartsStyle() — injects `<style>` with `cart-drawer, #CartDrawer, .js-drawer-open::after { display: none !important; ... }` (mount.ts). Same goal, different mechanism. |
| Hijacked cart icon | Yes: cart icon listeners / selectors. | Yes: themeConnector DEFAULT_CART_SELECTORS (a[href="/cart"], etc.), click → preventDefault, set drawerOpen (themeConnector.ts). |
| Analytics batching | Not clearly present in snippet. | Yes: Engine queue, BATCH_SIZE 10, FLUSH_INTERVAL_MS 5000, dedup window (analytics.ts, Engine.ts). |
| Feature flags | Store/config driven. | Yes: snapshot featureFlags (enableDiscounts, enableUpsell, etc.) from billing; engine gates by config.featureFlags. |
| Admin-driven config | Yes (concept). | V1/V2: admin settings → ShopConfig. V3: configV3 read from ShopConfig but no admin UI to edit configV3. |
| Billing gating | N/A in file. | Yes: snapshot overwrites featureFlags from getBillingContext; engine respects featureFlags. |

**V3-specific gaps vs cart.txt-style behavior:**  
- **Recommendations endpoint:** V3 calls POST `/recommendations`; app has no such route (cart.txt may assume different backend).  
- **Discount validation:** V3 calls POST `/discounts/{code}` (theme/Shopify); not an app route in revstack.  
- **Variant availability:** V3 uses GET `variants/{id}.js` (Shopify storefront); not app.

---

**Phase 5 output:**

```
Matches cart.txt:
  - Body-mounted shadow root (mount.ts: body host, attachShadow, App in shadow).
  - Fixed z-index overlay (mount.ts: position fixed, inset 0, zIndex 10000000).
  - Hijacked cart icon (themeConnector: selectors, preventDefault, drawerOpen).
  - Feature flags / config-driven behavior (snapshot featureFlags, engine checks).
  - Billing gating at snapshot + runtime.

Partially Matches:
  - MutationObserver hide strategy: V3 uses injected CSS (cart-drawer, #CartDrawer, .js-drawer-open::after display:none) instead of MutationObserver to hide other carts; same outcome, different implementation.

Missing:
  - Admin UI for configV3 (persisted V3 JSON). configV3 is read-only from DB.
  - Backend route for POST /recommendations (V3 engine calls it; 404 in app).
  - /discounts/{code} and /variants/{id}.js are storefront/theme, not app routes (by design).

Over-Engineered:
  - None identified relative to cart.txt; V3 is more structured (effect queue, dedup analytics, interceptor).

Under-Engineered:
  - configV3 has no write path: cannot configure V3-specific rules (discounts, freeGifts, upsell, rewards, checkout) from admin; only defaults + billing flags.
  - /recommendations not implemented in app — AI upsell in V3 will 404 unless theme or external service provides it.
```

---

## PHASE 6 — Production Readiness Score

- **Runtime stability (0–100):** 70. V3 mount/sync/analytics path is clear and bounded. Minus: POST /recommendations 404; discount/variant rely on theme; no retry for snapshot fetch in Liquid (catch empty).  
- **Data integrity (0–100):** 75. Snapshot merge + billing overwrite are correct; configV3 never written so no write conflicts. Minus: configV3 can be stale or missing with no way to fix from admin.  
- **Admin completeness (0–100):** 50. V1/flat config is editable; V3-specific config (configV3) has no UI.  
- **Billing enforcement (0–100):** 85. Snapshot overwrites featureFlags; engine gates by featureFlags; analytics route does not re-check (acceptable if snapshot is trusted).  
- **Repo cleanliness (0–100):** 55. V1/V2 routes and archived extension still present; two bootstrap paths (v1 + v2); duplicate snapshot/buildBootstrapSnapshotV2 for V2.  
- **Dead code risk (0–100):** 45. Many live routes unused by active embed; no removal plan.  
- **Migration risk (0–100):** 60. Moving to V3-only would require removing or deprecating V1/V2 routes and clarifying /recommendations.

**Overall (average of above, harsh):** ~62/100.

---

**Phase 6 output:**

```
Production Readiness Score: 62/100

Blocking Issues:
  - V3 AI recommendations: Engine calls POST /recommendations; no handler in app (404 in production unless theme provides it). File: cart-pro-v3-runtime/src/engine/recommendationsApi.ts.
  - configV3 never written: V3 stores cannot change V3-specific config (discounts, upsell rules, etc.) except via DB. No admin write path.

Non-Blocking Issues:
  - Fallback ShopConfig omits configV3 (null) on P2022; snapshot still works with defaults + billing. shop-config.server.ts getFallbackShopConfig.
  - Analytics v3 route does not check billing (relies on snapshot + engine). apps.cart-pro.analytics.v3.ts.
  - Liquid snapshot fetch has no retry; .catch(function(){}) swallows errors. cart_pro_embed_v3.liquid.

Must-Fix Before Prod:
  - Implement POST /recommendations (or document that theme/external service must provide it) and/or disable AI upsell when endpoint missing.
  - Either add admin UI to edit configV3 or document that configV3 is DB-only / future.

Can-Fix After Prod:
  - Consolidate or deprecate V1/V2 routes and archived extension.
  - Add retry/feedback for snapshot fetch in block.
  - Unify V2 snapshot vs bootstrap.v2 (same builder, two routes).
```

---

## PHASE 7 — Repo Cleanup Plan

- **Delete (safely removable if V3-only is the target):**  
  - `revstack/archived-extensions/cart-pro-v1-v2/` (only if no store uses it).  
  - Optional: `revstack/app/routes/apps.cart-pro.bootstrap.v2.ts` if snapshot/v2 is the single V2 entry and bootstrap/v2 is redundant (same builder).  
  Do not delete without confirming no stores use V1/V2.

- **Migrate:**  
  - V1/V2 stores to V3: ensure they use cart_pro_embed_v3 and snapshot v3; then deprecate V1/V2 routes.  
  - configV3: add migration or admin screen to populate configV3 from existing flat config if desired.

- **Unify:**  
  - V2: `cart.snapshot.v2.ts` and `apps.cart-pro.bootstrap.v2.ts` both call `buildBootstrapSnapshotV2`; one route could redirect or one file re-export the other to avoid duplication.  
  - Decision: `apps.cart-pro.decision.ts` and `cart.decision.ts` — already unified (re-export).  
  - Analytics event: same pattern (re-export); keep as-is for URL compatibility.

- **Refactor (no behavior change):**  
  - Extract shared “safe bootstrap response” / capabilities shape if V1 bootstrap and V3 snapshot are to share more code.  
  - Consider a single “cart-pro app proxy” doc that lists all paths and which version uses them.

- **Keep:**  
  - All V3 runtime and snapshot/analytics routes.  
  - cart.decision + apps.cart-pro.decision (and analytics event re-exports) if any store or partner still uses V1.  
  - shop-config.server.ts getShopConfig/getFallbackShopConfig and configV3 read path.  
  - Prisma schema (ShopConfig.configV3, CartProEventV3, etc.).

---

**Phase 7 output:**

```
Delete:
  - revstack/archived-extensions/cart-pro-v1-v2/ (only after confirming no production use).
  - Optional: apps.cart-pro.bootstrap.v2.ts if V2 is deprecated and snapshot/v2 is sole entry.

Migrate:
  - Stores to V3 embed + snapshot v3; then deprecate V1/V2 backend routes.
  - configV3: add admin or migration to write configV3 if V3-specific config is required.

Unify:
  - V2 snapshot vs bootstrap.v2 (same buildBootstrapSnapshotV2); single route or re-export.
  - Document all app-proxy routes and which version uses each.

Refactor:
  - Optional: shared bootstrap/capabilities helpers between V1 bootstrap and V3 snapshot.
  - Optional: single “cart-pro routes” reference doc.

Keep:
  - V3: apps.cart-pro.snapshot.v3.ts, apps.cart-pro.analytics.v3.ts, cart-pro-v3-runtime, cart_pro_embed_v3.liquid, cart-pro-v3.js.
  - shop-config.server.ts (getShopConfig, fallback, configV3 read).
  - cart.decision + apps.cart-pro.decision, cart.analytics.event + apps.cart-pro.analytics.event (if V1 still in use).
  - Prisma: ShopConfig, CartProEventV3, Session, etc.
```

---

*End of audit. No refactors or code changes; analysis only.*
