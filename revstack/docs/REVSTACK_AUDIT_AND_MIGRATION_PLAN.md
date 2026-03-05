# Revstack — Full Audit & Migration Plan (cart.txt Parity)

**Purpose:** Single reference for revstack state vs cart.txt (reference implementation), what is problematic, what remains for parity, why the V3 drawer does not perfectly copy the V2 drawer UI, admin–v3 gaps, and a step-by-step migration plan with prompts.

**Reference:** `cart.txt` (root) = minified Svelte bundle; behavior described in `docs/CART_TXT_ZERO_LATENCY_AUDIT.md`, `docs/CART_PRO_V3_FORENSIC_ARCHITECTURAL_AUDIT.md`, `docs/FORENSIC_AUDIT_V2_V3_AND_MIGRATION_PLAN.md`.

---

## Goals (Target State for Cart V3)

Cart V3 must achieve **three clear objectives**:

| Pillar | Target | Meaning |
|--------|--------|---------|
| **1. Architecture** | Like **cart.txt** | Config bootstrap (bundle defaults + sessionStorage cache + single snapshot fetch), store init, content gate (loadSidecart-style), theme timing, recommendation/shipping/coupon data flow, hide-other-carts, cart icon hijacking — all match cart.txt patterns. |
| **2. Styling & UI** | Exactly **cart V2** | DOM structure, CSS classes, component layout, and visual design are an **exact clone** of the cart V2 drawer (cart-pro-ui.js + cart-pro.css). Same IDs, same classes, same copy, same animations. No “V2-like”; pixel-perfect V2. |
| **3. Features & Admin** | **All cart.txt features + our own** | Every cart.txt feature (upsell, rewards, discounts, free shipping tease, countdown, recommendations, etc.) plus **our own** (e.g. analytics, overlay checkout, feature flags). **All admin pages** (Settings, Dashboard, Analytics, Onboarding, Billing, Upgrade, etc.) are **correctly wired to V3**: they read/write configV3, drive snapshot v3, and preview or report on V3 behavior. |

So: **architecture from cart.txt, look-and-feel from cart V2, feature set = cart.txt + analytics (and any other product features), and full admin ↔ V3 wiring.** The migration plan below is organized to deliver all three.

---

## 1. Revstack Directory Context

### 1.1 Structure (relevant to cart/storefront + admin)

```
revstack/
├── app/                          # Admin (React Router)
│   ├── routes/
│   │   ├── app.tsx               # Layout: auth, syncOnboardingProgress, billing
│   │   ├── app.settings.tsx      # Config form, CartPreview (V2-style), runtimeVersion v1|v2|v3
│   │   ├── app._index.tsx        # Dashboard
│   │   ├── app.analytics.tsx
│   │   ├── cart.snapshot.v2.ts   # /apps/cart-pro/snapshot/v2
│   │   ├── cart.snapshot.v3.ts   # /apps/cart-pro/snapshot/v3
│   │   └── ...
│   ├── components/
│   │   └── CartPreview.tsx       # Admin preview — V2 decision shape, not V3
│   └── lib/
│       ├── config-v3.ts          # CartProConfigV3, mergeWithDefaultV3, freeShipping, teaseMessage
│       ├── preview-simulator.server.ts  # generatePreviewDecision (V2 decision)
│       └── upsell-engine-v2/     # buildSnapshot, getHydratedRecommendationsForShop
├── cart-pro-v3-runtime/         # Storefront V3 (Svelte)
│   ├── src/
│   │   ├── mount.ts              # Bootstrap, shadow host, cache, App mount
│   │   ├── ui/
│   │   │   ├── App.svelte        # Uses DrawerV2; enqueues syncCart onMount
│   │   │   ├── Drawer.svelte    # Legacy drawer (still imports v2 components)
│   │   │   └── v2/
│   │   │       ├── DrawerV2.svelte
│   │   │       ├── CheckoutSection.svelte  # Countdown + ShippingSection
│   │   │       ├── ShippingSection.svelte  # V2-style cp-msg-visible, savings
│   │   │       ├── CouponSection.svelte
│   │   │       ├── Recommendations.svelte  # snapshotRecommendations vs upsell
│   │   │       └── ...
│   │   ├── engine/
│   │   │   ├── Engine.ts         # loadConfig, syncCart, stub/snapshot recs
│   │   │   ├── state.ts
│   │   │   └── recommendationsStub.ts
│   │   └── integration/themeConnector.ts
│   └── styles/cart-pro-v2.css
├── extensions/cart-pro/          # Block + assets (cart-pro-v3.js, cart-pro-v3.css)
└── docs/
```

### 1.2 Data Flow (current)

- **Storefront V3:** Liquid embed fetches `/apps/cart-pro/snapshot/v3` → `applyAppearanceAndLoadConfig(config)` → `loadConfig` + sessionStorage write. Runtime: `mount.ts` → cache read / global snapshot → `bootstrapConfig` → shadow host + App → DrawerV2. App onMount enqueues `syncCart()`. Snapshot includes `recommendations`, `freeShipping`, `teaseMessage` (via mergeWithDefaultV3).
- **Admin:** Settings loads `getShopConfig` + catalog; `generatePreviewDecision(shop, admin, undefined, config, catalog)` returns **V2-style** `PreviewRenderState` (decision + ui). CartPreview is React and uses that shape; it does **not** use V3 engine or snapshot v3 payload.

---

## 2. What Is Problematic

### 2.1 Storefront V3 Drawer vs V2 / cart.txt

| Issue | Location | Detail |
|-------|----------|--------|
| **Host ID mismatch** | mount.ts, embed block | Block renders `#cart-pro-v3-root`; runtime uses `#revstack-v3-root`. Theme/CSS targeting the block div never apply to actual host. |
| **No bundle default config** | Engine, mount | cart.txt initializes config store with full defaults at load; V3 engine has `config = null` until loadConfig. First paint can see null config. |
| **Content not gated** | App.svelte | cart.txt sets `loadSidecart = true` only after loadConfigurations + updateCart + getDiscounts. V3 mounts drawer immediately; no “content ready” gate. |
| **Recommendations when no snapshot** | Engine.syncCart | When `snapshotRecommendations` is empty, stub (AI disabled) still sets `aiRecommendations` to first-two-cart-items; standard rules are used only if no snapshot. Logic is correct for “has snapshot” but fallback is poor. |
| **Coupon tease element** | CouponSection.svelte | V3 uses `.cp-coupon-tease`; V2/V1 use `#cart-pro-coupon-banner` + `cp-coupon-banner-visible`. DOM/class differ from reference. |
| **Footer order / IDs** | DrawerV2, CheckoutSection | Largely aligned (subtotal → ShippingSection → checkout); coupon banner vs tease placement can still diverge from V2 DOM. |
| **Hide-other-carts** | mount.ts | V3 injects a fixed list of selectors; cart.txt uses config (merchantCartDrawerSelector, global_cart_drawer_selector) + MutationObserver for dynamic nodes. V3 has no MO for “other carts” appearing later. |

### 2.2 Config / Snapshot

| Issue | Location | Detail |
|-------|----------|--------|
| **freeShipping / teaseMessage** | app/lib/config-v3.ts | **Fixed:** mergeWithDefaultV3 and types include `freeShipping.thresholdCents` and `discounts.teaseMessage`. Snapshot v3 and runtime can receive them. |
| **Cache key vs cart.txt** | mount.ts | V3 uses `cart-pro-v3-config`; cart.txt uses `kwik-cart-request-data`. Behavioral parity is “cache before mount + write after fetch”; key name is cosmetic. |

### 2.3 Admin and V3

| Issue | Location | Detail |
|-------|----------|--------|
| **Preview uses V2 decision shape** | app/lib/preview-simulator.server.ts, CartPreview.tsx | `generatePreviewDecision` returns V2-style decision (crossSell, milestones, freeShippingRemaining, ui). CartPreview is React and does not consume V3 snapshot or V3 engine. |
| **Settings form vs V3 snapshot** | app.settings.tsx | Form builds `configV3` (buildConfigV3FromForm) and persists; snapshot v3 uses same config-v3 + mergeWithDefaultV3. Preview state is derived from form + V2 decision, not from “snapshot v3 payload” so preview can diverge from storefront V3. |
| **No admin “V3 preview” path** | — | There is no dedicated “preview with V3 payload” (same shape as storefront) or “preview with DrawerV2 + engine” in admin. |

### 2.4 Remaining UI / Logic Gaps (from forensic docs)

- **Countdown:** CheckoutSection has countdown logic (countdownStore, countdownDisplay). If engine.countdown or config.appearance.countdownEnabled are not wired in all paths, visibility or content can still be wrong.
- **Shipping:** ShippingSection has V2-style structure (cp-msg-visible, .cp-shipping-content, #cart-pro-savings). If snapshot or DB never sends freeShipping.thresholdCents for a shop, shipping bar stays empty (no threshold).
- **Recommendations:** When snapshot provides `recommendations`, loadConfig sets `snapshotRecommendations` and syncCart does not overwrite them. When snapshot has no recommendations, fallback is stub (or standard/AI). Ensure RecommendationCard gets full fields (title, imageUrl, price) from snapshotRecommendations.

---

## 3. What Is Left (Organized by Goals)

### 3.1 Architecture (cart.txt parity)

- [x] **Bundle-embedded default config:** Add a default config object; initialize engine so `getConfig()` never returns null (structure always present; values overridden by cache/snapshot).
- [x] **Content gate:** Gate drawer content (or open button) on “config loaded and optionally cart synced” so first paint matches cart.txt’s loadSidecart behavior.
- [x] **Single canonical host ID:** Align block and runtime on one host ID; document it for theme developers.
- [ ] **applyAppearanceVariables:** Keep as single place for theme vars on host (no duplicate or conflicting CSS).
- [x] **Hide other carts:** Config-driven selectors + MutationObserver for dynamically added “other cart” nodes (cart.txt behavior).
- [x] **Re-sync after config:** When snapshot/cache loads, `loadConfig` runs and calls `syncCart`, so shipping and recommendations state are updated. Both the happy path (line 237) and the error fallback (line 275) in `Engine.loadConfig()` call `this.syncCart()`; there is no path that sets `this.config` without a subsequent sync.

### 3.2 Styling & UI (exact cart V2 clone)

- [ ] **Coupon:** Use `#cart-pro-coupon-banner` and `cp-coupon-banner-visible` for tease — exact V2 DOM/classes.
- [ ] **Footer order & IDs:** Match V2: coupon section → coupon banner → subtotal → shipping container → checkout; same IDs/classes as cart-pro-ui.js DRAWER_MARKUP.
- [ ] **Shipping:** Already V2-style (cp-msg-visible, .cp-shipping-content, #cart-pro-savings); confirm copy and tiered messages match V2.
- [ ] **Countdown:** Pass `countdownVisible` from config; ensure countdown store and display match V2 behavior.
- [ ] **Recommendations block:** Same “You may also like” + card structure and styling as V2.
- [ ] **CSS authority:** Use cart-pro.css (or cart-pro-v2.css) as the single styling authority so V3 drawer is a pixel-perfect V2 clone.

### 3.3 Features: cart.txt + ours + admin wired to V3

**Cart.txt features (all present and correct in V3):**

- [x] Upsell (standard rules + AI when enabled), rewards/milestones, discounts/coupon tease, free shipping tease, countdown, recommendations, checkout (default or overlay), cart icon hijacking, hide other carts, ATC behavior (open cart / toast).

  **D.1 audit (completed):**
  | Feature | Engine gate | UI gate | Notes |
  |---|---|---|---|
  | Upsell standard | `featureFlags.enableUpsell` | DrawerV2 `{#if enableUpsell}` wraps Recommendations ✅ | Fixed: was always rendered |
  | Upsell AI | `upsell.aiEnabled` from config | same Recommendations block ✅ | |
  | Snapshot recommendations | set unconditionally in loadConfig | behind `enableUpsell` block ✅ | intentional: billing-guaranteed |
  | Rewards/tiers | `featureFlags.enableRewards` | confetti from engine state ✅ | no tier-bar UI; confetti is the V2 reward signal |
  | Discounts/coupon tease | `featureFlags.enableDiscounts` | DrawerV2 `{#if enableDiscounts}` wraps CouponSection ✅ | Fixed: was always rendered |
  | Free shipping | threshold drives compute | Milestones + ShippingSection read config threshold ✅ | no billing flag; threshold = feature |
  | Countdown | `appearance.countdownEnabled` | DrawerV2 passes `countdownVisible`; CheckoutSection re-reads config ✅ | |
  | Checkout overlay | `featureFlags.enableCheckout` | state.checkout.enabled gates button; openCheckout() guard ✅ | |
  | Cart icon hijack | always active | themeConnector ✅ | |
  | Hide other carts | `merchantCartDrawerSelector` | themeConnector MO + injectHideOtherCartsStyle ✅ | |
  | ATC | engine.addToCart + interceptor | — ✅ | |

**Our features (on top of cart.txt):**

- [ ] **Analytics:** V3 analytics (events, batch, flush) wired and reported in admin; analytics route and dashboard show V3-driven metrics where applicable.
- [ ] **Feature flags / billing:** Snapshot v3 featureFlags from billing; admin reflects which features are on for the plan.
- [ ] Any other product-specific features (e.g. overlay checkout URL, one-tick upsell) — all driven by configV3 and snapshot v3.

**Admin pages correctly wired to V3:**

- [ ] **Settings:** Form reads/writes configV3; preview uses V3 snapshot shape (or iframe V3); saving updates snapshot v3 response; runtimeVersion v1/v2/v3 clearly shown and applied.
- [ ] **Dashboard:** Uses getShopConfig (configV3); any cart/decision metrics that depend on runtime version reflect V3 when store uses V3.
- [ ] **Analytics:** Events and aggregates that come from V3 runtime (e.g. cart.analytics.v3) are used on analytics page; no disconnect between storefront V3 and admin analytics.
- [ ] **Onboarding / Billing / Upgrade:** Use same configV3/snapshot v3 pipeline where relevant; no V2-only assumptions that break when merchant is on V3.

---

## 4. Why V3 Drawer Doesn’t Perfectly Copy V2 Drawer UI

- **Different codebases:** V2 drawer is built by cart-pro-ui.js (DOM + refs, ensureDrawerDOM, renderShippingBar, updateFreeShippingAndSavings, updateCouponBanner, updateRecommendationUI). V3 drawer is Svelte (DrawerV2 + ShippingSection, CouponSection, Recommendations, CheckoutSection). They were implemented separately; V3 was not a line-by-line port.
- **Different host ID:** V2 uses `#cart-pro-root`; V3 uses `#revstack-v3-root`, so any theme targeting the V2 host does not apply to V3.
- **Class and node differences:** V2 uses `#cart-pro-shipping-msg` + `cp-msg-visible` (and .cp-shipping-content, #cart-pro-savings); V3 ShippingSection was updated to match. Coupon: V2 uses `#cart-pro-coupon-banner` + `cp-coupon-banner-visible`; V3 uses `.cp-coupon-tease`. So coupon DOM/class still differ.
- **Data timing:** In V2, render runs after openDrawer → safeRender with cart + syntheticDecision. In V3, reactive state drives Svelte; if syncCart runs before loadConfig, shipping threshold can be null once; loadConfig does call syncCart(), but race can still occur on first load.
- **Preview vs drawer:** Admin CartPreview is a React implementation that mirrors V2 layout/copy and is fed V2-style decision data. The storefront V3 drawer is Svelte and is fed by engine state from snapshot v3. So “preview looks correct” is because preview was designed to match V2; the live V3 drawer was built to be “V2-like” but not a pixel-perfect clone.

---

## 5. Admin Pages: Not Yet Connected to V3 Logic

- **Settings:** Persists configV3 (including runtimeVersion v1/v2/v3) and drives snapshot v3 via getShopConfig + mergeWithDefaultV3. So “backend” is connected. What’s not connected: the **live preview** is still V2 decision + React CartPreview, not “run V3 engine + DrawerV2” or “render from snapshot v3 JSON”.
- **Dashboard / Analytics:** Use getShopConfig, getDashboardMetrics, getAnalyticsMetrics; no V3-specific metrics or “V3 usage” yet.
- **Preview simulator:** generatePreviewDecision uses recommendation strategy and decision engine for a mock cart; it does not call snapshot v3 or return the exact payload the storefront V3 receives.

To “connect admin to V3 logic” you can: (1) Add a “V3 preview” that fetches or builds the same payload as snapshot v3 and renders it (e.g. in an iframe with cart-pro-v3.js or a React mimic of V3 state), or (2) Keep CartPreview as V2-style but ensure the form’s configV3 fields (freeShipping, teaseMessage, etc.) are what snapshot v3 returns so storefront V3 and admin settings stay in sync.

---

## 6. Step-by-Step Migration Plan — Prompts with Full Context

**For AI execution:** All prompts are written to be **self-contained** in a separate file. An AI (or developer) should **read only that file** and nothing else to execute each step; each prompt includes goal, repo context, files to touch, current/target state, and the exact task.

**→ [revstack/docs/REVSTACK_MIGRATION_PROMPTS_FULL_CONTEXT.md](./REVSTACK_MIGRATION_PROMPTS_FULL_CONTEXT.md)** — open this file and use the prompts there. You do **not** need to read this audit (Sections 1–5), the rest of Section 6, or Section 7; everything needed to implement each step (paths, code references, doc references, success criteria) is inside each prompt in that file. Each prompt (A.1–F.3) has all relevant context embedded (paths, code references, doc references, success criteria). No need to read the rest of this audit when executing a step.

**Quick reference (steps only):**

| Phase | Step | One-line description |
|-------|------|----------------------|
| A | A.1 | Bundle default config so getConfig() never null |
| A | A.2 | Content gate (loadSidecart-style) until config + optional syncCart |
| A | A.3 | Align host ID (block + runtime); document in README |
| A | A.4 | Hide other carts: MutationObserver + config-driven selectors |
| B | B.1 | Coupon: #cart-pro-coupon-banner + cp-coupon-banner-visible (V2 DOM) |
| B | B.2 | Footer order and IDs match V2 DRAWER_MARKUP |
| B | B.3 | Countdown from config; countdown store for time-limited offers |
| B | B.4 | CSS authority: cart-pro.css / cart-pro-v2.css as single source |
| C | C.1 | Snapshot v3 returns recommendations, freeShipping, teaseMessage; test/log |
| C | C.2 | loadConfig calls syncCart; document ordering |
| C | C.3 | Stub excludes in-cart variants (recommendationsStub.ts) |
| D | D.1 | Verify all cart.txt features driven by config/snapshot v3 |
| D | D.2 | V3 analytics sent when enabled; admin Analytics shows them |
| D | D.3 | Feature flags from billing; admin shows runtimeVersion + features |
| E | E.1 | Settings: configV3 form + V3 preview (iframe or React from snapshot payload) |
| E | E.2 | Dashboard uses configV3; show runtimeVersion |
| E | E.3 | Analytics page consumes V3 events when merchant on V3 |
| E | E.4 | Onboarding/Billing/Upgrade use configV3; no V2-only assumptions |
| E | E.5 | Show runtimeVersion (v1/v2/v3) in nav or settings/dashboard |
| F | F.1 | Remove or document legacy Drawer.svelte |
| F | F.2 | Update this audit after each phase (mark done, update Sections 2–3) |
| F | F.3 | README: V3 goals, host ID, config bootstrap, link to this audit |

*(Full prompts with context are in REVSTACK_MIGRATION_PROMPTS_FULL_CONTEXT.md.)*

### Phase A — Architecture: Config and bootstrap (cart.txt parity)

| Step | Action | Prompt / instruction |
|------|--------|------------------------|
| A.1 | Add bundle default config | “In revstack/cart-pro-v3-runtime, add a defaultConfig.ts that exports a full default object matching NormalizedEngineConfig (appearance, freeShipping, discounts, upsell, rewards, checkout, analytics). In Engine constructor or init, if config is still null, set this.config to Object.freeze(normalizeConfig(defaultConfig)) so getConfig() never returns null.” |
| A.2 | Content gate | “In App.svelte or DrawerV2.svelte, add a reactive flag ‘contentReady’ that becomes true only after engine.getConfig() is non-null and (optionally) after first syncCart has run. Hide drawer body (or show skeleton) until contentReady; optionally hide the Open button until then. Match cart.txt loadSidecart behavior.” |
| A.3 | Align host ID | “Update cart_pro_embed_v3.liquid so the block’s root div id is revstack-v3-root (to match mount.ts), or change mount.ts ensureBodyHost to use getElementById('cart-pro-v3-root') when present so the block div is the host. Document the chosen host ID in revstack README or docs.” |
| A.4 | Hide other carts (cart.txt-style) | “In mount.ts or themeConnector, add a MutationObserver on document.body for childList/subtree; when nodes matching cart.txt's otherSideCarts (or config-driven selectors from config.appearance) appear, run the same hide logic. Support merchantCartDrawerSelector / global_cart_drawer_selector from config when available.” |

### Phase B — Styling & UI: Drawer exact V2 clone

| Step | Action | Prompt / instruction |
|------|--------|------------------------|
| B.1 | Coupon banner parity | “In CouponSection.svelte, when showing tease, render the message in #cart-pro-coupon-banner.cp-coupon-banner and add class cp-coupon-banner-visible when visible; remove the class when hidden. Keep or remove .cp-coupon-tease depending on whether we want a single banner (V2) or both.” |
| B.2 | Footer order and IDs | “In DrawerV2.svelte, ensure footer order is: CouponSection, then #cart-pro-coupon-banner (if used), then #cart-pro-subtotal (inside CheckoutSection), then .cp-shipping-container (ShippingSection), then .cp-checkout-container. Match IDs/classes from FORENSIC_AUDIT_V2_V3_AND_MIGRATION_PLAN.md PART 1A.” |
| B.3 | Countdown from config | “In DrawerV2.svelte, pass countdownVisible={engine?.getConfig?.()?.appearance?.countdownEnabled === true} to CheckoutSection instead of true. Ensure engine.countdown is started when appropriate (e.g. when a time-limited offer is active) so countdownDisplay in CheckoutSection shows.” |
| B.4 | CSS authority | “Use cart-pro.css (or cart-pro-v2.css) as the single styling authority for the V3 drawer so layout, colours, and components are a pixel-perfect clone of cart V2. Inject the same critical CSS and variables into the shadow root; no extra overrides that change V2 look.” |

### Phase C — Snapshot and engine (architecture + data)

| Step | Action | Prompt / instruction |
|------|--------|------------------------|
| C.1 | Snapshot v3 surface area | “Confirm cart.snapshot.v3.ts returns recommendations, freeShipping.thresholdCents, discounts.teaseMessage (via mergeWithDefaultV3). Add a short test or log that snapshot response includes these when set in configV3.” |
| C.2 | Re-sync after config | “When Liquid calls applyAppearanceAndLoadConfig(config), after engine.loadConfig(config), ensure syncCart runs (loadConfig already calls this.syncCart()). If there is a race where snapshot arrives after first syncCart, document or add a second syncCart when loadConfig is called from Liquid.” |
| C.3 | Recommendations fallback | “When snapshotRecommendations is empty and AI is disabled, keep current stub behavior but ensure stub never recommends items already in cart (filter by variant id). In recommendationsStub.ts, exclude items whose variantId is in cart.items.” |

### Phase D — Features: cart.txt + ours (analytics, etc.)

| Step | Action | Prompt / instruction |
|------|--------|------------------------|
| D.1 | Cart.txt feature checklist | “Verify in runtime: upsell (standard + AI), rewards/milestones, discounts/coupon tease, free shipping tease, countdown, recommendations, checkout (default + overlay), cart icon hijacking, hide other carts, ATC behavior (open cart / toast). All driven by config and snapshot v3.” |
| D.2 | Analytics (our feature) | “Ensure V3 analytics (events, batch, flush) are sent from storefront when config.featureFlags.enableAnalytics; ensure admin Analytics page (app.analytics) reads and displays these V3 events/aggregates. No disconnect between V3 runtime and admin analytics.” |
| D.3 | Feature flags from billing | “Snapshot v3 featureFlags come from billing capabilities; admin Settings/Dashboard reflect which features are enabled for the current plan and show runtimeVersion (v1/v2/v3) clearly.” |

### Phase E — Admin pages correctly wired to V3

| Step | Action | Prompt / instruction |
|------|--------|------------------------|
| E.1 | Settings ↔ V3 | “Settings form reads/writes configV3. Add a V3 preview: build the exact snapshot v3 payload and either (a) render in an iframe that loads cart-pro-v3.js with __CART_PRO_V3_SNAPSHOT__, or (b) render a React component that displays the same sections as DrawerV2 from that payload. Saving must update snapshot v3 response.” |
| E.2 | Dashboard ↔ V3 | “Dashboard (app._index) uses getShopConfig (configV3); any metrics that depend on runtime or configV3 are correct. Show runtimeVersion when relevant.” |
| E.3 | Analytics ↔ V3 | “Analytics page (app.analytics) consumes events/aggregates from V3 runtime. When merchant is on V3, analytics reflect V3 behavior.” |
| E.4 | Onboarding / Billing / Upgrade | “Onboarding, Billing, Upgrade routes use configV3 and snapshot v3 pipeline where relevant. No flows that assume only V2.” |
| E.5 | Runtime version in nav | “On settings or dashboard (or layout), show current runtimeVersion (v1/v2/v3) from configV3 so merchants know which storefront bundle is active.” |

### Phase F — Cleanup and docs

| Step | Action | Prompt / instruction |
|------|--------|------------------------|
| F.1 | Remove or document Drawer.svelte | “Drawer.svelte is legacy and not used by App.svelte (which uses DrawerV2). Either remove it or add a comment that it is legacy and DrawerV2 is the active drawer.” |
| F.2 | Audit doc | “Update this audit after each phase: mark completed steps, update What is problematic and What is left.” |
| F.3 | README | “In revstack/README.md add: (1) V3 goals: architecture like cart.txt, UI exactly cart V2, all cart.txt features + analytics, admin wired to V3; (2) host ID, config bootstrap; (3) link to this audit.” |

## 7. Prompt Summary (copy-paste)

**A.1 — Default config**  
“In revstack/cart-pro-v3-runtime, add defaultConfig.ts exporting a full default object for NormalizedEngineConfig. In Engine, initialize this.config from it when null so getConfig() never returns null.”

**A.2 — Content gate**  
“In revstack/cart-pro-v3-runtime App.svelte or DrawerV2.svelte, add contentReady (true only after config loaded and optionally first syncCart). Hide drawer content until contentReady to match cart.txt loadSidecart.”

**A.3 — Host ID**  
“Align V3 host ID: either set Liquid block root to id=revstack-v3-root or make mount.ts use getElementById('cart-pro-v3-root') as host. Document in revstack README.”


**A.4 — Hide other carts**  
“Add MutationObserver for other cart nodes; support merchantCartDrawerSelector / global_cart_drawer_selector from config.”

**B.1 — Coupon banner**  
“In CouponSection.svelte use #cart-pro-coupon-banner and cp-coupon-banner-visible for tease text so it matches V2 DOM/classes.”

**B.3 — Countdown**  
“In DrawerV2.svelte pass countdownVisible from engine.getConfig()?.appearance?.countdownEnabled to CheckoutSection. Ensure countdown store is started when offer is time-limited.”

**C.3 — Stub filter**  
“In recommendationsStub.ts filter out any item whose variantId is already in cart.items so we never recommend in-cart products.”

**D.1 — Cart.txt features**  
“Verify in runtime all cart.txt features (upsell, rewards, discounts, free shipping tease, countdown, recommendations, checkout, cart icon hijacking, hide other carts, ATC behavior) are driven by config and snapshot v3.”


**D.2 — Analytics**  
“Ensure V3 analytics (events, batch, flush) are sent when enableAnalytics; admin app.analytics reads and displays V3 events/aggregates.”


**E.1 — Settings ↔ V3**  
“Settings form reads/writes configV3. Add V3 preview (snapshot v3 payload in iframe or React). Saving updates snapshot v3 response.”

**E.5 — Runtime version**  
“On settings or dashboard, show runtimeVersion (v1/v2/v3) from configV3.”

**F.3 — README**  
“In revstack/README.md add: V3 goals (architecture like cart.txt, UI exactly cart V2, all cart.txt features + analytics, admin wired to V3); host ID and config bootstrap; link to this audit.”


---

## 8. References

- `docs/CART_TXT_ZERO_LATENCY_AUDIT.md` — cart.txt config/bootstrap/theme/recommendations/shipping/coupon.
- `docs/CART_PRO_V3_FORENSIC_ARCHITECTURAL_AUDIT.md` — Config, state, UI, recommendations, snapshot, parity table, bug list.
- `docs/FORENSIC_AUDIT_V2_V3_AND_MIGRATION_PLAN.md` — V2 DOM (1A), pipeline (1B), shipping/coupon (1C–1E), V3 structure (2A–2E), root causes (4), migration blueprint (5–6).
- `docs/DEEP_STRUCTURAL_AUDIT_V3_MIGRATION.md` — cart.txt parity score, MOs, hide-other-carts.
- `revstack/ADMIN_LAYOUT_AUDIT.md` — Layout loader, route loaders, no V3-specific logic.

---

*End of audit and migration plan. Update this document as steps are completed.*
