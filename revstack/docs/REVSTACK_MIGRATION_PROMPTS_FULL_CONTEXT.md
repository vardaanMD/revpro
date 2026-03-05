# Revstack Migration — Prompts with Full Context (AI-Executable)

**Instruction for AI:** To execute any migration step (A.1–F.3), read **only this file**. Each prompt below is **self-contained**: it includes goal, repo context, file paths, current/target state, and the exact task. You do not need to read REVSTACK_AUDIT_AND_MIGRATION_PLAN.md or any other doc to implement a step.

**Use this file with the migration plan:** Each prompt below is **self-contained**. It includes goal, repo context, files to touch, current vs target state, and the exact task. An AI can execute from the prompt alone without reading the rest of REVSTACK_AUDIT_AND_MIGRATION_PLAN.md.

**Goals recap:** (1) **Architecture** like cart.txt — config bootstrap, content gate, hide-other-carts, etc. (2) **Styling & UI** exactly cart V2 — same DOM/IDs/classes. (3) **Features & Admin** — all cart.txt features + analytics; all admin pages wired to V3.

**Repo root:** `revstack/` under project root. Paths below are relative to repo root (e.g. `cart-pro-v3-runtime/`, `app/`).

---

## Phase A — Architecture (cart.txt parity)

### A.1 — Bundle default config

**Goal:** cart.txt creates a config store with a **bundle-embedded default** at module load so the UI never sees null config. V3 has `engine.config = null` until `loadConfig()`.

**Repo context:**
- `cart-pro-v3-runtime/src/engine/Engine.ts`: constructor and `init()` do not set config; `loadConfig(rawConfig)` sets `this.config` via `normalizeConfig`.
- Config shape: `configSchema.ts` (or in Engine) defines `NormalizedEngineConfig` and `normalizeConfig(raw)`.
- Reference: `docs/CART_TXT_ZERO_LATENCY_AUDIT.md` Section 1 — cart.txt uses `store_configurations = writable({ appearance: {...}, ... })` at load.

**Files to touch:** Create `cart-pro-v3-runtime/src/engine/defaultConfig.ts`; edit `cart-pro-v3-runtime/src/engine/Engine.ts`.

**Current state:** `getConfig()` can return null until snapshot/cache runs.

**Target state:** `getConfig()` never returns null; engine starts with a frozen default; cache/snapshot overwrite when available.

**Task:**
1. Add `defaultConfig.ts` exporting a full default object matching `NormalizedEngineConfig` (appearance, freeShipping, discounts, upsell, rewards, checkout, analytics, featureFlags with safe defaults).
2. In Engine constructor or start of `init()`, if `this.config` is null, set `this.config = Object.freeze(normalizeConfig(defaultConfig))`.
3. Ensure `loadConfig(raw)` still overwrites `this.config` when called from mount or Liquid.
Result: First paint has default config; after cache/snapshot, loaded config.

---

### A.2 — Content gate (loadSidecart-style)

**Goal:** cart.txt sets `loadSidecart = true` only **after** `await loadConfigurations()` and updateCart/getDiscounts; drawer content is hidden until then. V3 mounts drawer immediately.

**Repo context:**
- `cart-pro-v3-runtime/src/ui/App.svelte`: mounts DrawerV2, `engine.enqueueEffect(async () => await engine.syncCart())` in onMount.
- `cart-pro-v3-runtime/src/ui/v2/DrawerV2.svelte`: drawer body.
- Reference: `docs/CART_TXT_ZERO_LATENCY_AUDIT.md` Section 7 — loadSidecart after async block.

**Files to touch:** `cart-pro-v3-runtime/src/ui/App.svelte` and/or `DrawerV2.svelte`.

**Current state:** Drawer visible as soon as app mounts.

**Target state:** Drawer body (or open button) hidden or skeleton until config loaded and optionally first syncCart done.

**Task:**
1. Add reactive flag `contentReady`: true only when `engine.getConfig()` non-null and (optionally) first syncCart done.
2. In DrawerV2 or App, hide drawer body or show skeleton until `contentReady`; optionally hide "Open V3 Drawer" until then.
3. Set flag after config (from A.1 default or cache/snapshot) and optionally after first syncCart.
Result: First paint matches cart.txt loadSidecart.

---

### A.3 — Align host ID

**Goal:** One canonical host element. Block renders `#cart-pro-v3-root`, mount uses `#revstack-v3-root` — theme CSS can target the wrong node.

**Repo context:**
- `cart-pro-v3-runtime/src/mount.ts`: `ROOT_ID = 'revstack-v3-root'`, `EMBED_ROOT_ID = 'cart-pro-root'`; `getResolvedHostElement()` returns embed then ROOT_ID. `ensureBodyHost()` creates `#revstack-v3-root` if none.
- Liquid/embed (extensions or block): often renders div `id="cart-pro-v3-root"`.

**Files to touch:** Liquid template for V3 root div and/or `mount.ts`; `revstack/README.md` or docs.

**Current state:** Block id and runtime host id can differ.

**Target state:** One canonical host id; documented for theme developers.

**Task:**
1. Pick one id (e.g. `revstack-v3-root`).
2. Either set Liquid root div to that id, or have mount use block div (`cart-pro-v3-root`) when present.
3. Document in README: "V3 cart host element id is &lt;chosen-id&gt;."
Result: Single host id, documented.

---

### A.4 — Hide other carts (cart.txt-style)

**Goal:** cart.txt hides other cart UIs via config-driven selectors and a **MutationObserver** when new nodes appear. V3 only injects fixed selectors in `injectHideOtherCartsStyle()`.

**Repo context:**
- `cart-pro-v3-runtime/src/mount.ts`: `injectHideOtherCartsStyle()` adds `<style>` with fixed selectors (cart-drawer, #CartDrawer, .js-drawer-open::after).
- cart.txt: `config.appearance.merchantCartDrawerSelector`, `global_cart_drawer_selector`; `runCartHideMO()` on body (childList, subtree); `hideOtherCarts()` on match.
- Add to config schema if missing: appearance.merchantCartDrawerSelector, global_cart_drawer_selector.

**Files to touch:** `cart-pro-v3-runtime/src/mount.ts` and/or `themeConnector.ts`; config schema if needed.

**Current state:** Static style only; no reaction to dynamically added other-cart nodes.

**Target state:** MutationObserver on document.body; when new nodes match other-cart selectors (or config), run same hide logic; support config selectors when present.

**Task:**
1. Add MutationObserver on document.body `{ childList: true, subtree: true }`.
2. On new nodes, check match against list (e.g. cart-drawer, #CartDrawer, #monster-upsell-cart, etc.) or config.appearance.merchantCartDrawerSelector / global_cart_drawer_selector.
3. When match, run same hide logic (display:none / inject style).
4. Prefer config selectors over default list when set.
Result: Dynamic other-cart nodes hidden like cart.txt.

---

## Phase B — Styling & UI (exact V2 clone)

### B.1 — Coupon banner (V2 DOM/classes)

**Goal:** V2 uses `#cart-pro-coupon-banner.cp-coupon-banner` and `cp-coupon-banner-visible`. V3 uses `.cp-coupon-tease`.

**Repo context:**
- `cart-pro-v3-runtime/src/ui/v2/CouponSection.svelte`: tease in e.g. `.cp-coupon-tease`.
- V2: `docs/FORENSIC_AUDIT_V2_V3_AND_MIGRATION_PLAN.md` Part 1D — #cart-pro-coupon-banner, cp-coupon-banner-visible.
- CSS: .cp-coupon-banner / .cp-coupon-banner-visible in cart-pro.css.

**Files to touch:** `CouponSection.svelte`; optionally DrawerV2 if banner is outside.

**Current state:** Tease in different node/class than V2.

**Target state:** Tease in `#cart-pro-coupon-banner.cp-coupon-banner`; add/remove `cp-coupon-banner-visible`; drop or repurpose .cp-coupon-tease.

**Task:**
1. Render tease in `<div id="cart-pro-coupon-banner" class="cp-coupon-banner" class:cp-coupon-banner-visible={showTease}>...</div>`.
2. showTease from same condition (e.g. getConfig()?.discounts?.teaseMessage and no applied codes).
3. When showTease false, remove cp-coupon-banner-visible.
Result: Coupon area DOM/classes match V2.

---

### B.2 — Footer order and IDs (V2)

**Goal:** Footer structure and IDs match cart-pro-ui.js DRAWER_MARKUP.

**Repo context:**
- DrawerV2: footer = CouponSection then CheckoutSection (subtotal, ShippingSection, checkout, countdown).
- CheckoutSection: #cart-pro-subtotal, ShippingSection, .cp-checkout-container, #cart-pro-checkout, #cart-pro-countdown.
- V2 order: `docs/FORENSIC_AUDIT_V2_V3_AND_MIGRATION_PLAN.md` Part 1A — coupon section → #cart-pro-coupon-banner → #cart-pro-subtotal → .cp-shipping-container (skeleton, .cp-shipping-content, #cart-pro-shipping-msg, #cart-pro-savings) → .cp-checkout-container.

**Files to touch:** DrawerV2.svelte, CheckoutSection.svelte, ShippingSection.svelte.

**Current state:** Order roughly correct; IDs/classes may differ.

**Target state:** Exact order and IDs/classes per Part 1A.

**Task:**
1. DrawerV2 footer order: CouponSection → coupon banner (B.1) → subtotal → shipping container → checkout container.
2. CheckoutSection + ShippingSection: all IDs/classes from Part 1A (cart-pro-subtotal, cp-shipping-container, cart-pro-shipping-skeleton, cp-shipping-content, cart-pro-shipping-msg, cart-pro-savings, cp-checkout-container, cart-pro-checkout, cart-pro-countdown).
Result: Footer DOM 1:1 with V2.

---

### B.3 — Countdown from config

**Goal:** Countdown visibility and content from config and engine; V2 shows urgency when time-limited offer active.

**Repo context:**
- DrawerV2 passes countdownVisible to CheckoutSection (may be hardcoded true).
- CheckoutSection: engine.countdown?.store, countdownState.remainingMs, countdownDisplay; showCountdown.
- Config: getConfig()?.appearance?.countdownEnabled. Engine may have countdown.ts.

**Files to touch:** DrawerV2.svelte; engine/countdown or Engine for start/stop.

**Current state:** countdownVisible may be hardcoded; countdown store may not run for all offers.

**Target state:** countdownVisible = getConfig()?.appearance?.countdownEnabled === true; when active offer, countdown store has remainingMs and CheckoutSection shows V2-style copy ("Offer reserved for MM:SS").

**Task:**
1. DrawerV2: countdownVisible = engine?.getConfig?.()?.appearance?.countdownEnabled === true.
2. When time-limited offer active, engine.countdown (or countdown module) updates remainingMs; CheckoutSection shows correct text.
Result: Countdown config-driven and matches V2.

---

### B.4 — CSS authority (V2 clone)

**Goal:** One CSS source (cart-pro.css or cart-pro-v2.css); no overrides that change V2 look.

**Repo context:**
- `cart-pro-v3-runtime/styles/cart-pro-v2.css`. mount.ts injects one `<style>` into shadow root with componentCss.

**Files to touch:** Build that feeds mount; remove conflicting overrides.

**Current state:** cart-pro-v2.css used; possible extra CSS diverging from V2.

**Target state:** Drawer styles = cart-pro.css (or cart-pro-v2.css) + same critical rules as V2; host gets --cp-* from applyAppearanceVariables; no conflicting overrides.

**Task:**
1. Ensure componentCss passed to mountCartProV3 is from cart-pro.css / cart-pro-v2.css + minimal V2-matching additions.
2. No other styles override V2 layout/colours.
3. Include V2 critical CSS (overlay, drawer transform, open state) if separate.
Result: V3 drawer pixel-perfect visual clone of V2.

---

## Phase C — Snapshot and engine

### C.1 — Snapshot v3 surface area

**Goal:** Snapshot v3 returns recommendations, freeShipping.thresholdCents, discounts.teaseMessage.

**Repo context:**
- `app/routes/cart.snapshot.v3.ts`: mergeWithDefaultV3(shopConfig.configV3), buildV3SnapshotPayload, getHydratedRecommendationsForShop.
- `app/lib/config-v3.ts`: mergeWithDefaultV3 has freeShipping, discounts.teaseMessage.

**Files to touch:** cart.snapshot.v3.ts; optional test or log.

**Current state:** mergeWithDefaultV3 and types include these; snapshot may already return.

**Target state:** Confirmed response has recommendations, freeShipping.thresholdCents, discounts.teaseMessage when set in configV3; test or log for regression.

**Task:**
1. Inspect snapshot v3 response and mergeWithDefaultV3 output; confirm the three fields present when set in DB.
2. Add test or log that asserts/logs these fields.
Result: Snapshot contract explicit and regression-safe.

---

### C.2 — Re-sync after config

**Goal:** When Liquid calls loadConfig(config), cart-derived state (e.g. shipping threshold) must be updated so first paint after load is correct.

**Repo context:**
- Liquid: fetch snapshot v3 → __applyCartProAppearance(config), CartProV3Engine.loadConfig(config).
- Engine.loadConfig(rawConfig) calls this.syncCart() after set config. App onMount enqueues syncCart().

**Files to touch:** Engine.ts; this audit doc.

**Current state:** loadConfig already calls syncCart(); late snapshot still gets correct state.

**Target state:** Documented that loadConfig always calls syncCart so no race.

**Task:**
1. Confirm Engine.loadConfig() calls this.syncCart() after setting this.config.
2. If any path sets config without syncCart, add call or document.
3. Add one sentence in audit: "When snapshot/cache loads, loadConfig runs and calls syncCart, so shipping and recommendations state are updated."
Result: Guarantee config load refreshes cart state.

---

### C.3 — Recommendations fallback (exclude in-cart)

**Goal:** Stub must not recommend items already in cart when no snapshot recs and AI disabled.

**Repo context:**
- `cart-pro-v3-runtime/src/engine/recommendationsStub.ts`: buildStubRecommendations(cart) from cart.items (e.g. first two); no filter for "variant not in cart".
- Engine uses stub when snapshotRecommendations empty and AI disabled. Cart items: variant_id/id; stub: variantId.

**Files to touch:** recommendationsStub.ts.

**Current state:** Stub can recommend same product as in cart.

**Target state:** Stub excludes any item whose variantId is in cart.items.

**Task:**
1. In buildStubRecommendations(cart), build candidate list then filter out items whose variantId (or id) is in cart.items (variant_id or id).
2. Return filtered list (e.g. cap at 2).
Result: Stub never recommends in-cart products.

---

## Phase D — Features (cart.txt + ours)

### D.1 — Cart.txt feature checklist

**Goal:** All cart.txt features present and driven by config/snapshot v3.

**Repo context:** cart.txt: upsell (standard+AI), rewards/milestones, discounts/coupon tease, free shipping tease, countdown, recommendations, checkout, cart icon hijacking, hide other carts, ATC behavior. V3: Engine, state, mount, themeConnector, DrawerV2; config from snapshot v3 and cache.

**Files to touch:** Verification across runtime/snapshot; optional checklist in Engine or doc.

**Task:**
1. For each feature (upsell, rewards, discounts, free shipping, countdown, recommendations, checkout, cart icon, hide other carts, ATC), confirm driven by getConfig() and/or snapshot v3.
2. Fix gaps; add TODO or checklist comment if needed.
Result: All cart.txt features confirmed and config/snapshot-driven.

---

### D.2 — Analytics (our feature)

**Goal:** V3 analytics sent when enabled; admin Analytics page shows them (no disconnect).

**Repo context:**
- Runtime: send when config.featureFlags.enableAnalytics (e.g. cart.analytics.v3).
- Admin: app/routes/app.analytics.tsx; snapshot v3 sets featureFlags from billing.

**Files to touch:** Runtime analytics send path; app.analytics route and data source.

**Current state:** Analytics may be partial; admin may not show V3 events.

**Target state:** When enableAnalytics, runtime sends; admin Analytics page shows same events/aggregates.

**Task:**
1. Confirm runtime sends when getConfig()?.featureFlags?.enableAnalytics.
2. Confirm app.analytics reads from same store/API as runtime writes.
3. Fix any missing link.
Result: V3 analytics end-to-end in admin.

---

### D.3 — Feature flags from billing

**Goal:** Snapshot v3 featureFlags from billing; admin shows plan features and runtimeVersion.

**Repo context:**
- cart.snapshot.v3.ts: featureFlagsFromCapabilities(billing.capabilities). config-v3: featureFlags, runtimeVersion.
- Settings/Dashboard: getShopConfig, configV3.

**Files to touch:** Settings/Dashboard UI.

**Current state:** Snapshot sets featureFlags; admin may not show runtimeVersion or limits.

**Target state:** Admin shows features enabled for plan and runtimeVersion (v1/v2/v3).

**Task:**
1. Snapshot continues to set featureFlags from billing.
2. Settings/Dashboard read configV3.runtimeVersion and featureFlags; display ("Runtime: V3", "Upsell: On", etc.).
3. If plan limits features, show that.
Result: Merchants see runtime and feature state in admin.

---

## Phase E — Admin wired to V3

### E.1 — Settings ↔ V3 (form + V3 preview)

**Goal:** Settings form reads/writes configV3; preview shows what storefront V3 receives (same snapshot v3 payload or iframe V3).

**Repo context:**
- app.settings.tsx: buildConfigV3FromForm, persist configV3; CartPreview uses V2 decision from generatePreviewDecision.
- cart.snapshot.v3.ts returns mergeWithDefaultV3 + featureFlags + recommendations. Storefront expects __CART_PRO_V3_SNAPSHOT__ or fetch.

**Files to touch:** app.settings.tsx (add V3 preview); new iframe or React component.

**Current state:** Form saves configV3; preview is V2, not V3 payload.

**Target state:** "V3 preview" builds exact snapshot v3 payload; render in iframe (cart-pro-v3.js + __CART_PRO_V3_SNAPSHOT__) or React mimic of DrawerV2 sections. Saving still updates snapshot v3.

**Task:**
1. In app.settings add "V3 preview" section.
2. Build same object as snapshot v3: mergeWithDefaultV3(shopConfig.configV3) + featureFlags + getHydratedRecommendationsForShop(shop).
3. (a) Set __CART_PRO_V3_SNAPSHOT__ and iframe cart-pro-v3.js, or (b) React component that renders DrawerV2 sections from that payload.
4. Form save still updates configV3.
Result: Admin preview matches storefront V3.

---

### E.2 — Dashboard ↔ V3

**Goal:** Dashboard uses configV3; metrics and runtime version correct for V3.

**Repo context:** app._index.tsx: getShopConfig, getDashboardMetrics, getRetentionContext. configV3 in shopConfig.

**Files to touch:** app._index.tsx (or dashboard components).

**Task:**
1. Dashboard uses getShopConfig so configV3 available.
2. Any metric that depends on runtime (e.g. "stores on V3") use configV3.runtimeVersion.
3. Show runtimeVersion (e.g. "V3" badge).
Result: Dashboard reflects V3 and configV3.

---

### E.3 — Analytics ↔ V3

**Goal:** Analytics page consumes V3 runtime events when merchant on V3.

**Repo context:** app.analytics.tsx; events from cart.analytics.v3 or shared store.

**Files to touch:** app.analytics.tsx and its data layer.

**Task:**
1. Analytics route reads from same source V3 runtime writes to (see D.2).
2. If V2 vs V3 pipelines, use correct one by configV3.runtimeVersion.
3. Remove "all stores V2" assumptions.
Result: Analytics page works for V3 merchants.

---

### E.4 — Onboarding / Billing / Upgrade ↔ V3

**Goal:** These routes use configV3 and snapshot v3; no V2-only flows.

**Repo context:** app.onboarding, app.billing, app.upgrade; getShopConfig, configV3, billing.

**Files to touch:** Those route loaders and components.

**Task:**
1. Onboarding: when complete, configV3 (including runtimeVersion if chosen) persisted for snapshot v3.
2. Billing/Upgrade: feature flags already in snapshot; admin plan limits from same source.
3. Remove any "!v3" or v2-only assumptions.
Result: Onboarding/Billing/Upgrade work for V3.

---

### E.5 — Runtime version in nav

**Goal:** Merchants see which runtime is active (v1/v2/v3) in admin.

**Repo context:** configV3.runtimeVersion from getShopConfig and snapshot v3. Layout or settings/dashboard can show it.

**Files to touch:** app.tsx layout or Settings/Dashboard.

**Task:**
1. Layout or settings/dashboard loader passes configV3.runtimeVersion to UI.
2. Show label "Cart runtime: V3" (or v1/v2) in nav, settings header, or dashboard.
Result: Runtime version visible in admin.

---

## Phase F — Cleanup and docs

### F.1 — Remove or document Drawer.svelte

**Goal:** No confusion between legacy Drawer.svelte and active DrawerV2.

**Repo context:** cart-pro-v3-runtime/src/ui/Drawer.svelte unused; App.svelte uses DrawerV2 from v2/DrawerV2.svelte.

**Files to touch:** Drawer.svelte; any imports.

**Task:**
1. Either remove Drawer.svelte and update imports to DrawerV2, or add top-of-file comment: "Legacy; not used. Active drawer is v2/DrawerV2.svelte."
Result: Clear which drawer is active.

---

### F.2 — Audit doc

**Goal:** Keep REVSTACK_AUDIT_AND_MIGRATION_PLAN.md up to date after each step.

**Files to touch:** revstack/docs/REVSTACK_AUDIT_AND_MIGRATION_PLAN.md.

**Task:**
1. When a step A.1–F.3 is done, mark it completed (e.g. [x] or "Done").
2. Update Section 2 (What is problematic) and Section 3 (What is left) accordingly.
Result: Audit stays single source of truth.

---

### F.3 — README

**Goal:** Revstack README states V3 goals and points to this audit.

**Files to touch:** revstack/README.md.

**Task:**
1. Add "Cart V3" / "V3 goals" section: architecture like cart.txt, UI exactly cart V2, features = cart.txt + analytics, admin wired to V3.
2. Mention host id and config bootstrap (cache + snapshot).
3. Link to revstack/docs/REVSTACK_AUDIT_AND_MIGRATION_PLAN.md and docs/CART_TXT_ZERO_LATENCY_AUDIT.md.
Result: New contributors and AIs get V3 design from README + audit.

---

*End of prompts. Use with REVSTACK_AUDIT_AND_MIGRATION_PLAN.md for full audit context.*
