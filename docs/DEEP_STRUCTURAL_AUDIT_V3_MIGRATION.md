# Deep Structural Audit — V3 Migration & cart.txt Parity

**Date:** 2025-02-24  
**Type:** Analysis only. No refactors. No edits.

---

## PHASE 1 — cart.txt Parity Analysis

### Sources compared

- **cart.txt / cart_unminified.txt** — Third-party (GoKwik-style) cart: Svelte, config from backend, AI recommendations from `POST /v3/kwik-cart/get-product-recommendations`, MutationObservers for cart icon and hide-other-carts.
- **revstack/cart-pro-v3-runtime** — Svelte engine, config from `/apps/cart-pro/snapshot/v3`, no decision route, Shadow DOM mount.
- **revstack/extensions/cart-pro** — Active extension: `cart_pro_embed_v3.liquid` → fetch snapshot v3, `cart-pro-v3.js`.
- **revstack/app/routes/apps.cart-pro.snapshot.v3.ts** — Returns `configV3` + billing-derived feature flags; no catalog, no decision.

---

### 1. Overlay strategy parity

| Aspect | cart.txt | V3 runtime | Parity |
|--------|----------|------------|--------|
| **Layering** | Full-viewport overlay; sidecart/drawer with high z-index (e.g. 9999999, 10000000). | Fixed full viewport host (`inset: 0`, `z-index: 10000000`), pointer-events: none on host, auto on app container. | **Equivalent** |
| **Hide other carts** | `otherSideCarts` list; `runCartHideMO` MutationObserver on `document.body` (childList, subtree); on new nodes matching selectors, calls `hideOtherCarts(selectors)` (inject style or hide nodes). Selectors: `cart-drawer`, `#CartDrawer`, `.mm-ajaxcart-overlay`, `.background-overlay`, etc. | `injectHideOtherCartsStyle()`: single injected `<style>` with `cart-drawer`, `#CartDrawer`, `.js-drawer-open::after` → `display: none !important; visibility: hidden; pointer-events: none`. No MutationObserver for hide. | **Partial** — Same goal; V3 uses CSS only and fewer selectors (no `.mm-ajaxcart-overlay`, `.background-overlay`). Themes with other cart containers may not be hidden. |
| **Cart icon hijacking** | `runCartIconMO`: MutationObserver on body; when nodes matching cart icon selectors are added, re-attaches `openGokwikSideCart` click. Optional localStorage for custom parent/element selectors. | `themeConnector`: MutationObserver on `document.body` (childList, subtree), debounced 200ms; re-runs `attachCartIconListeners()` to re-bind click (preventDefault + open drawer). Fixed selectors: `a[href="/cart"]`, `a[href*="/cart"]`, `button[name="cart"]`, `.cart-icon`, `.site-header__cart`, `[data-cart-toggle]`. | **Equivalent** — Same pattern (MO → re-attach). cart.txt can use custom selectors from storage; V3 uses fixed + optional `cartIconSelectors`. |
| **Stacking edge cases** | Discount stacking: `stacking_not_allowed` in response; UI/API handle non-stackable codes. | Engine: `stacking.allowStacking` from config; non-stacking path removes existing codes before apply. | **Present** in V3. |
| **MutationObserver parity** | Two MOs: (1) hide other carts when nodes appear, (2) cart icon re-attach on DOM change. | One MO: cart icon re-attach only. Hide is static CSS. | **Gap:** V3 does not observe for new “other cart” nodes; if theme injects cart UI after load, cart.txt would hide it dynamically, V3 would not (unless selector already in injected style). |

**Summary:** V3 layering is behaviorally equivalent for the host and drawer. Cart icon hijacking is equivalent (MO + re-attach). “Hide other carts” is partial: same intent, CSS-only and fewer selectors; no MO for late-injected competitor carts.

---

### 2. Runtime feature parity

| Feature | cart.txt | V3 | Notes |
|---------|----------|-----|------|
| **Discount** | getDiscounts, line/cart-level allocations, stacking rules, reapply on cart change. | validateDiscount, removeDiscountFromCart, stacking (allowStacking/whitelist), reapplyDiscounts, reconcileCartDiscountState, triggerRevalidation. | **Parity** |
| **Free gifts** | freeGiftConfig, store_freeGiftLoading, rules applied on cart update. | syncFreeGifts, computeExpectedGifts, diffGifts, getGiftVariantIds; add/remove lines via cartApi. | **Parity** |
| **Upsell** | Standard list + AI (`fetchAIProductRecommendations` → POST `/v3/kwik-cart/get-product-recommendations`). | standardRules + aiEnabled; computeStandardUpsell; debouncedPostRecommendations → POST `/recommendations`. | **Partial** — Logic parity; AI endpoint differs and is missing in app (see below). |
| **Rewards / milestones** | Progress bar, tiers from config, confetti on unlock. | rewards.tiers, computeUnlockedTier, progress, confetti (clearConfetti). | **Parity** |
| **Checkout override** | Checkout buttons, optional custom flow. | openCheckout, checkout overlay, PostMessage to iframe (jwt, OTP, address, payment). | **Parity** (V3 has state machine + iframe). |
| **Cart icon hijacking** | MO + click bind. | themeConnector MO + click bind. | **Parity** |

---

### 3. Missing endpoints

- **POST `/recommendations`** — **Confirmed missing.**  
  - V3: `recommendationsApi.ts` calls `POST ${getBaseUrl()}recommendations` with `{ variant_ids }`. `getBaseUrl()` is `Shopify.routes.root` or `/`. So storefront calls same-origin `POST /recommendations`.  
  - revstack has **no** route for `/recommendations`. Result: 404 in production unless theme or external service provides it.  
  - cart.txt uses a different backend: `POST /v3/kwik-cart/get-product-recommendations` (different product/recommendation service).

- **Other phantom endpoints:** None identified. V3 uses only: snapshot v3 (GET), analytics v3 (POST), storefront `/cart.js`, `/cart/add.js`, `/cart/change.js`, and the missing `/recommendations`.

---

### 4. Stability risks vs cart.txt

**What cart.txt does that V3 does not:**

- MutationObserver-based “hide other carts” for dynamically added nodes (V3 relies on static CSS and fewer selectors).
- AI recommendations from a working backend (V3’s `/recommendations` is unimplemented → AI upsell effectively off or broken).
- Broader “other cart” selector list (e.g. `.mm-ajaxcart-overlay`, `.background-overlay`).

**Where V3 is more robust:**

- Single config fetch (snapshot v3); no decision round-trip or cache consistency issues.
- Billing-gated feature flags in snapshot; no decision timeout or SAFE fallback for config.
- Effect queue and revalidation debouncing; clearer discount/cart ordering.
- Shadow DOM + scoped styles; no global CSS leak from runtime.
- Analytics batch + dedup + retry; resilient event delivery.

---

### Parity score (Phase 1)

```
cart.txt Parity Score:
Overlay:        75%   (layering equivalent; hide-other-carts partial – CSS only, fewer selectors; no MO for late nodes)
Runtime:        85%   (discount, free gifts, rewards, checkout parity; upsell logic parity, AI endpoint missing)
Backend Coupling: 70% (snapshot v3 + analytics v3 present; /recommendations missing)
Admin Coupling:  50%   (admin writes only flat fields; configV3 not written by admin; snapshot v3 reads configV3)
Overall:        70%
```

---

## PHASE 2 — V1/V2 UI Reuse Feasibility

### Analyzed

- **revstack/archived-extensions/cart-pro-v1-v2:** `cart_pro_embed.liquid`, `cart-pro-ui.js`, `cart-pro-v2.js`, `cart-pro.js`, `cart-pro.css`.
- **app.settings.tsx**, **app._index.tsx** — Admin; preview uses `CartPreview` + `generatePreviewDecision` (decision-shaped).
- V1/V2 cart UI assets: snapshot/decision-driven; flat UI fields (primaryColor, accentColor, etc.).

### 1. Reusable as-is

- **None.**  
  - V2 UI expects snapshot shape: `ui`, `capabilities`, `upsell.products`, `variantIds`, `aiEnabled`.  
  - V1 UI expects bootstrap + decision: `bootstrap.ui`, `decision.crossSell`, `decision.milestones`, `decision.freeShippingRemaining`, `decision.enableCouponTease`.  
  - configV3 shape is different: `discounts`, `freeGifts.rules`, `upsell.standardRules` / `aiEnabled` / `oneTick`, `rewards.tiers`, `checkout`, `featureFlags`. No `upsell.products` or `variantIds` array from server; V3 computes standard upsell and AI client-side.

### 2. Needs refactor

- **CartPreview (app)** — Currently takes `PreviewRenderState` (decision-like: `crossSell`, `milestones`, `freeShippingRemaining`, `ui`). Could be refactored to accept a configV3-derived preview (e.g. map `rewards.tiers` → milestones, `upsell.standardRules` → synthetic crossSell, flat UI → `ui`) so settings preview works off configV3 without calling decision.
- **Preview pipeline** — `generatePreviewDecision` uses flat config + catalog; could add a path that builds preview from configV3 only (no catalog/decision) for V3-only preview.

### 3. Must rewrite

- **Storefront list/drawer content** — V2 renders from snapshot `upsell.products` and `variantIds`; V3 uses engine state (standard + aiRecommendations from config + API). Markup and data flow differ; reuse would require a compatibility layer that turns configV3 + engine state into something snapshot-like, which is tantamount to a rewrite of the data binding.
- **V1 decision-driven UI** — Tied to decision fetch, SAFE fallback, and optimistic decision cache; not reusable for config-only V3.

### Recommendation: copy-paste vs modularise

- **Do not** try to reuse V1/V2 storefront components as-is; data shapes and lifecycle are different.
- **Option A — Copy-paste and adapt:** Copy V2/V1 UI patterns (layout, sections, styles) into V3 Svelte components and wire to engine state and configV3. Fastest path; some style duplication.
- **Option B — Extract shared modules:** Extract shared styling tokens (e.g. CSS variables, spacing, typography) and optional shared primitives (e.g. button, input) into a small shared package; keep V3 Drawer/App and V2 markup separate. Balances consistency and maintenance.
- **Option C — Rewrite minimal logic, reuse styling:** Reuse only CSS (e.g. from cart-pro.css) via import or tokens; rewrite all behavior in V3. Reduces logic drift; styling stays aligned.

**Suggested:** Option B (shared design tokens/primitive components) + V3-specific Drawer/App. Avoid large copy-paste of V2 script logic.

---

### Phase 2 output

```
Reusable as-is:   (none)
Needs refactor:   CartPreview + preview pipeline (configV3-derived preview)
Must rewrite:     Storefront drawer/list content; V1 decision-driven UI
```

---

## PHASE 3 — Admin Migration Audit

### 1. Fields currently written to flat ShopConfig (app.settings.tsx action)

All writes go to **flat** columns only (no `configV3`):

- `freeShippingThresholdCents`
- `baselineAovCents`
- `enableCrossSell`
- `enableMilestones`
- `enableCouponTease`
- `milestonesJson`
- `recommendationStrategy`
- `recommendationLimit`
- `manualCollectionIds`
- `primaryColor`, `accentColor`
- `borderRadius`
- `showConfetti`, `countdownEnabled`, `emojiMode`
- `engineVersion`

`configV3` is **never written** by the admin UI; it is only read by snapshot v3. So configV3 is populated only by migration script or manual/DB write.

### 2. Flat field → configV3 mapping

| Flat Field | configV3 path | Runtime dependency | Safe to remove? |
|------------|----------------|--------------------|-----------------|
| freeShippingThresholdCents | freeGifts / rewards / checkout (context-dependent; not in current configV3 schema) | V3: not in RawCartProConfigV3. Decision/snapshot V2: used for free shipping. | N — used by decision, V2, preview |
| baselineAovCents | (none; analytics/strategy) | Decision / analytics. | N |
| enableCrossSell | featureFlags.enableUpsell (billing already gates; could mirror) | Decision, buildBootstrapSnapshotV2, preview. | N |
| enableMilestones | featureFlags.enableRewards | Decision, buildBootstrapSnapshotV2, preview. | N |
| enableCouponTease | featureFlags.enableDiscounts | Decision, buildBootstrapSnapshotV2, preview. | N |
| milestonesJson | rewards.tiers | Decision, buildBootstrapSnapshotV2, preview; snapshot v3 uses configV3.rewards.tiers. | N (until configV3.rewards populated and read everywhere) |
| recommendationStrategy | upsell strategy (V3 has standardRules; strategy could map to rule source) | buildBootstrapSnapshotV2, decision. | N |
| recommendationLimit | upsell.standardRules length or limit | buildBootstrapSnapshotV2. | N |
| manualCollectionIds | upsell / collection context | buildBootstrapSnapshotV2. | N |
| primaryColor, accentColor, borderRadius | (not in current configV3; could add ui or appearance) | Decision ui, buildBootstrapSnapshotV2 ui, preview ui. | N |
| showConfetti, countdownEnabled, emojiMode | (not in configV3) | Decision ui, buildBootstrapSnapshotV2 ui, preview. | N |
| engineVersion | (version in configV3 is "3.0.0") | Layout/settings for “which engine”; not in configV3. | N |

### 3. Logic relying on flat fields outside admin

- **cart.decision.ts** — `getShopConfig(shop)` → uses `config.enableCrossSell`, `config.enableMilestones`, `config.milestonesJson`, etc. for decision and `response.ui` (when allowUIConfig).
- **buildBootstrapSnapshotV2** — `getShopConfig(shop)` → primaryColor, accentColor, borderRadius, showConfetti, countdownEnabled, emojiMode, manualCollectionIds, recommendationStrategy, recommendationLimit.
- **cart.bootstrap.ts** — Flat config for bootstrap UI and capabilities.
- **preview-simulator.server.ts** — Flat config for plan, crossSell, milestones, ui.
- **app.tsx / app._index.tsx / app.onboarding.tsx** — `config.onboardingCompleted`, `config.activatedAt`, `config.lastActiveAt`, `config.milestoneFlags` (layout/retention).
- **getBillingContext** — Uses `config.plan`, `config.billingStatus` (flat).
- **apps.cart-pro.snapshot.v3.ts** — Reads **only** `shopConfig.configV3` and billing; does not read flat UI/capability fields for the response (feature flags from billing only).

### 4. Migration risks if flat fields are deleted

- **High:** Decision, V2 snapshot, preview, and layout/retention all assume flat fields exist. Deleting flat columns without migrating reads to configV3 (and writing configV3 from settings) would break those paths.
- **Medium:** Billing/plan are flat; must remain or be moved to a dedicated store (e.g. billing table or configV3.billing) and all readers updated.

### 5. V2 builder dependency on flat

- **Yes.** `buildBootstrapSnapshotV2` uses only flat fields from `getShopConfig(shop)` (ui, recommendationStrategy, recommendationLimit, manualCollectionIds, etc.). No configV3.

---

### Phase 3 output (migration mapping table)

```
Flat Field                    → configV3 path              → Runtime dependency                    → Safe to remove?
freeShippingThresholdCents    → (none in schema)           → decision, V2, preview                  → N
baselineAovCents              → (none)                     → decision, analytics                  → N
enableCrossSell               → featureFlags.enableUpsell   → decision, V2, preview                 → N
enableMilestones              → featureFlags.enableRewards  → decision, V2, preview                 → N
enableCouponTease              → featureFlags.enableDiscounts → decision, V2, preview             → N
milestonesJson                → rewards.tiers               → decision, V2, preview, snapshot v3   → N
recommendationStrategy        → (strategy in upsell)         → V2, decision                         → N
recommendationLimit           → (limit in upsell)           → V2                                    → N
manualCollectionIds           → (collections in upsell)     → V2                                    → N
primaryColor, accentColor, borderRadius → (ui not in configV3) → decision ui, V2 ui, preview        → N
showConfetti, countdownEnabled, emojiMode → (not in configV3) → decision ui, V2 ui, preview         → N
engineVersion                 → (version "3.0.0" in config) → layout, settings                      → N
```

---

## PHASE 4 — configV3 Hard Cut Risk Assessment

**Scenario:** Stop writing flat fields immediately; write only configV3; make snapshot ignore flat fields.

- Snapshot v3 **already** ignores flat (reads only `configV3` + billing for feature flags). So “snapshot ignore flat” is already true for v3.
- Admin **does not** write configV3 today. “Write only configV3” implies changing settings to write configV3 (and optionally dual-write flat during transition).

### 1. What breaks immediately

- **Preview** — Uses `generatePreviewDecision(shop, admin, ..., config, catalog)` with flat config. If flat is no longer updated, preview stays stale unless we add configV3-based preview.
- **V2 snapshot and V2 embed** — `buildBootstrapSnapshotV2` reads only flat. If flat is frozen, V2 stores get stale config.
- **Decision route** — Reads flat for capabilities and UI. If flat is not written, decision response becomes stale or wrong for V1 stores.
- **Layout/retention** — `config.onboardingCompleted`, `activatedAt`, `lastActiveAt`, `milestoneFlags` are flat. If we ever stop writing them (e.g. move to configV3), those readers must be updated.

### 2. Routes that depend on flat fields

- **cart.decision.ts** — Full flat usage (milestones, cross-sell, ui, etc.).
- **cart.bootstrap.ts** — Flat for bootstrap UI.
- **cart.snapshot.v2.ts** (via buildBootstrapSnapshotV2) — Full flat.
- **apps.cart-pro.bootstrap.v2.ts** — Same as above.
- **apps.cart-pro.ai.v2.ts** — getShopConfig (for catalog/capabilities; some flat).
- **app.settings.tsx** — Loader reads flat for form; action writes flat.
- **preview-simulator.server.ts** — Flat for decision-shaped preview.
- **app.tsx, app._index.tsx, app.onboarding.tsx** — Flat for onboarding and retention.

### 3. Prisma columns that become “orphaned”

- None are removed by a “hard cut”; we only stop writing. Orphaned in the sense of “no longer written”: every flat column currently written by settings would stop being updated. Columns remain in schema and could still be read (e.g. for backward compat or migration). True deletion would require a schema migration and then removing all reads.

### 4. What needs a migration script

- **Backfill configV3 from flat** for existing shops so snapshot v3 returns correct data after we switch to “configV3 is source of truth”: e.g. map milestonesJson → configV3.rewards.tiers, enableCrossSell/enableMilestones/enableCouponTease → featureFlags (or leave flags to billing), primaryColor/accentColor/borderRadius/showConfetti/countdownEnabled/emojiMode → a new configV3.ui or similar. Snapshot v3’s `mergeWithDefault` and feature-flag logic must then use that shape.
- **Dual-write:** On settings save, write both flat (for decision/V2/preview) and configV3 (for snapshot v3) until all consumers are migrated to configV3.

### 5. Hidden coupling

- **Billing:** plan/billingStatus live on ShopConfig (flat). Snapshot v3 uses them via getBillingContext(shop, shopConfig). So “config only in configV3” would still need plan/billingStatus somewhere (flat or configV3) for feature flags.
- **Onboarding / retention:** onboardingCompleted, onboardingStep, activatedAt, lastActiveAt, milestoneFlags are used by layout and retention; not part of current configV3. Either keep flat for these or add a separate “app state” blob/config.

---

### Phase 4 output

```
Hard Cut Risk Level: HIGH

Blocking items:
  - Admin does not write configV3; snapshot v3 would return empty/default for new/updated settings.
  - Decision, V2 snapshot, preview, layout all read flat; stopping flat write breaks them.
  - No migration path yet: no script flat → configV3, no dual-write.

Non-blocking items:
  - Snapshot v3 already ignores flat (no change needed there).
  - Prisma columns need not be dropped immediately; can keep flat and dual-write.
```

---

## PHASE 5 — V1/V2 Deletion Feasibility

**Simulated deletion of:**

- cart.bootstrap.ts
- cart.decision.ts
- cart.snapshot.v2.ts
- apps.cart-pro.bootstrap.v2.ts
- apps.cart-pro.ai.v2.ts
- archived-extensions folder (cart-pro-v1-v2)

### 1. Imports that break

- **cart.decision.ts** — Imported by:
  - `revstack/tests/cart.decision.integration.test.ts` (action import)
  - `revstack/tests/cart.decision.billing.test.ts` (action import)
  - `revstack/tests/decision.toggles.test.ts` (action import)
  Deleting the route file removes the handler; tests that import `~/routes/cart.decision` would fail (module not found or route missing).
- **apps.cart-pro.bootstrap.v2.ts** — Imports `buildBootstrapSnapshotV2` from `~/lib/upsell-engine-v2/buildSnapshot`. Deleting the route does not remove buildSnapshot; only the route disappears.
- **cart.snapshot.v2.ts** — Same: imports buildBootstrapSnapshotV2. Route only.
- **apps.cart-pro.ai.v2.ts** — Imports `extractNumericProductId` (and possibly others) from buildSnapshot. Route only.
- **archived-extensions** — No app or runtime code imports it; only docs reference it. Deleting the folder does not break app code.

### 2. Routes that break

- React Router is file-based. Deleting a route file removes that URL:
  - Removing cart.bootstrap.ts → GET `/apps/cart-pro/bootstrap` 404.
  - Removing cart.decision.ts → POST `/apps/cart-pro/decision` 404 (and apps.cart-pro.decision.ts re-exports it — that re-export would need to be removed or point to a stub).
  - Removing cart.snapshot.v2.ts → GET `/apps/cart-pro/snapshot/v2` 404.
  - Removing apps.cart-pro.bootstrap.v2.ts → GET `/apps/cart-pro/bootstrap/v2` 404.
  - Removing apps.cart-pro.ai.v2.ts → POST `/apps/cart-pro/ai/v2` 404.
- Any store or partner still using V1 (bootstrap + decision) or V2 (snapshot/v2, bootstrap/v2, ai/v2) would see 404s. Active extension uses only V3 (snapshot v3 + cart-pro-v3.js).

### 3. Active code references

- **V1/V2 routes:** Referenced only by tests (cart.decision), by Liquid/JS in **archived** extension (cart_pro_embed.liquid, cart-pro.js, cart-pro-v2.js). No reference from **active** extension or active app UI.
- **archived-extensions:** No imports; only documentation references.

### 4. Safe deletion after migration

- **Yes, provided:**
  - No production store uses V1 or V2 (only V3 block enabled).
  - Decision tests are removed or rewritten (e.g. test a stub or a new “config-only” path).
  - Re-exports (e.g. apps.cart-pro.decision.ts) are removed or replaced so no import points at deleted modules.
- **Recommended order:** (1) Confirm no V1/V2 traffic (logs or feature flags). (2) Remove or adjust tests that import cart.decision. (3) Delete V1/V2 route files and re-exports. (4) Delete archived-extensions when no longer needed for reference.

---

## PHASE 6 — Final Strategic Recommendation

### 1. Incremental migration vs full generational rewrite

- **Storefront:** Closer to a **full generational rewrite**. V3 is a separate codebase (Svelte, config-only, no decision, different config shape and lifecycle). Reusing V1/V2 storefront UI as-is is not feasible; data shapes differ.
- **Backend:** **Incremental** is possible: keep V1/V2 routes and flat config; add configV3 write from settings (or sync from flat); snapshot v3 already reads configV3; later migrate decision/preview to configV3 and deprecate flat.

### 2. Is V3 stable enough to be the single spine?

- **Not yet.** Gaps:
  - **POST /recommendations** is missing → AI upsell 404 or must be disabled when endpoint absent.
  - **configV3 is not written by admin** → New or updated settings do not populate configV3; snapshot v3 falls back to defaults unless configV3 is backfilled or written elsewhere.
  - **Overlay “hide other carts”** is CSS-only with fewer selectors → Some themes may show native cart alongside V3.
- After adding /recommendations (or documenting that theme/external service provides it), and after admin writes (or syncs) configV3, V3 can be the single storefront spine. Decision/V2 can remain for backward compat until no longer needed.

### 3. Estimated effort to reach ~90% cart.txt parity

- **Implement or proxy POST /recommendations** (or disable AI upsell when 404): small (1–2 days).
- **Admin: dual-write or configV3-only write** + **migration script flat → configV3**: ~2–4 days.
- **Expand “hide other carts” selectors** to match cart.txt (and optionally add MO for dynamic nodes): ~0.5–1 day.
- **Optional: configV3-derived preview** so settings preview works without decision: ~1–2 days.
- **Total (to ~90% parity):** on the order of **5–9 days** for a small team.

### 4. Recommended migration order (exact steps)

1. **Add POST /recommendations** (or document external provider and disable AI when 404). Prevents silent failure of AI upsell in V3.
2. **Backfill configV3** from flat for all shops (migration script) so snapshot v3 returns correct data.
3. **Admin: on settings save, write configV3** (and keep dual-write to flat for decision/V2/preview). Snapshot v3 then stays in sync with settings.
4. **Optional:** Add configV3-based preview path (no decision) and point CartPreview to it when “V3 only” is selected.
5. **Deprecate V1/V2 routes** (feature flag or timeline): stop using in new installs; keep routes for existing stores if needed.
6. **Remove or refactor tests** that import cart.decision.
7. **Delete V1/V2 route files** (cart.bootstrap, cart.decision, cart.snapshot.v2, apps.cart-pro.bootstrap.v2, apps.cart-pro.ai.v2) and re-exports once no traffic and tests are updated.
8. **Delete archived-extensions** when no longer needed for reference.
9. **Optional:** Migrate decision and preview to read from configV3 (or a shared “config” built from configV3); then stop writing flat and eventually drop flat columns (separate migration).

---

## Verdict

```
Verdict:
Can V3 safely replace V1/V2 completely?
NO

If NO, what must exist first?
  1. POST /recommendations implemented (or AI upsell disabled when endpoint missing).
  2. configV3 written from admin (or synced from flat on save) so snapshot v3 reflects settings.
  3. Backfill configV3 from flat for existing shops.
  4. Confirmation that no production store uses V1/V2 (or a sunset plan for those stores).
  5. Tests updated so removal of cart.decision (and related routes) does not break CI.
After these, V3 can be the single storefront spine and V1/V2 routes can be safely removed.
```
