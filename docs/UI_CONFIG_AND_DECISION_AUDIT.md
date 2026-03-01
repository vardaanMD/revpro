# UI Config & Decision Logic — Audit Report

**Scope:** Diagnosis only. No refactor. No behavior change.  
**Goal:** Map how UI config and decision logic are handled so we can separate static shop config (DOM/Liquid) from dynamic cart decision (backend-driven).

---

## PART 1 — Current UI Config Flow (Per-Property)

Trace for: `primaryColor`, `accentColor`, `borderRadius`, `shippingBarPosition`, `showConfetti`, `enableHaptics`, `countdownEnabled`, `emojiMode`.

| Property | DB Source | Settings Route + Validation | getShopConfig / Cache | Decision Payload | Liquid Dataset | Frontend Usage | Truly Dynamic? |
|----------|-----------|-----------------------------|------------------------|------------------|----------------|----------------|----------------|
| **primaryColor** | `ShopConfig.primaryColor` (String?) | `app.settings.tsx` action → `validateSettingsForm` → `prisma.shopConfig.update`; validated as optional hex in `settings-validation.server.ts` | `getShopConfig(shop)` → Prisma or 5min in-memory cache; fallback via `getFallbackShopConfig` | `response.ui.primaryColor` (when `allowUIConfig`); else `SAFE_UI_FALLBACK` | **Yes** — `cart_pro_embed.liquid`: `data-primary-color` from block setting `primary_color` (default `#111111`) | Read from `root.dataset.primaryColor` into `sectionConfig`; `applyUIConfig()` sets `--cp-primary`; sectionConfig wins over decision in `applyUIConfig` when present | **No** — per-shop only |
| **accentColor** | `ShopConfig.accentColor` (String?) | Same as above; optional hex | Same | `response.ui.accentColor` | **Yes** — `data-accent-color` from block `accent_color` (default `#555555`) | Same pattern; `--cp-accent` | **No** |
| **borderRadius** | `ShopConfig.borderRadius` (Int, default 12) | Same; `z.number().int().min(0).max(32)` | Same | `response.ui.borderRadius` | **Yes** — `data-border-radius` from block `border_radius` (0–24, default 12) | Same; `--cp-radius` | **No** |
| **shippingBarPosition** | `ShopConfig.shippingBarPosition` (String, default `"top"`) | **Not in settings form** — no field in `validateSettingsForm` or `app.settings.tsx` | In Prisma only; not in `DEFAULT_SHOP_CONFIG` or `getFallbackShopConfig` | **Not in decision response** — not in `DecisionResponseUI` or decision route | **No** — not in Liquid embed | **Not read in cart-pro.js** | N/A — stored but unused on storefront |
| **showConfetti** | `ShopConfig.showConfetti` (Boolean, default true) | In form + validation (checkbox → boolean) | In getShopConfig / fallback | `response.ui.showConfetti` | **No** — not in Liquid | Used via `decision.ui` / `SAFE_UI` in `shouldShowConfetti()`, `applyDecisionDelta`; no sectionConfig fallback | **No** — per-shop only |
| **enableHaptics** | `ShopConfig.enableHaptics` (Boolean, default true) | **Not in settings form** | Not in `DEFAULT_SHOP_CONFIG` or `getFallbackShopConfig`; only in Prisma | **Not in decision response** | **No** | **Not read in cart-pro.js** | N/A — stored but unused on storefront |
| **countdownEnabled** | `ShopConfig.countdownEnabled` (Boolean, default true) | In form + validation | In getShopConfig / fallback | `response.ui.countdownEnabled` | **No** — not in Liquid | Used in `renderInitial`, `applyDecisionDelta` (countdownEl visibility, startCountdown); from decision/SAFE_UI only | **No** — per-shop only |
| **emojiMode** | `ShopConfig.emojiMode` (Boolean, default true) | In form + validation | In getShopConfig / fallback | `response.ui.emojiMode` | **No** — not in Liquid | Used in `formatWithEmoji()` (strip emoji when false); from decision/SAFE_UI only | **No** — per-shop only |

**Summary (Part 1):**

- **Stored and saved via settings:** primaryColor, accentColor, borderRadius, showConfetti, countdownEnabled, emojiMode.
- **Stored in DB only (no settings UI, no decision, no Liquid, no frontend use):** enableHaptics, shippingBarPosition.
- **Liquid embed exposes at first paint:** primaryColor, accentColor, borderRadius only (plus suppressThemeDrawer). showConfetti, countdownEnabled, emojiMode are **not** in Liquid; they come only from the decision response after fetch.

---

## PART 2 — Static vs Dynamic Responsibilities

Classification: every property that appears in the **decision response** or drives **cart-pro** behavior.

### Static (candidate for DOM injection only)

- **primaryColor** — per shop; no cart/session dependency.
- **accentColor** — per shop; no cart/session dependency.
- **borderRadius** — per shop; no cart/session dependency.
- **showConfetti** — per shop; no cart/session dependency.
- **countdownEnabled** — per shop; no cart/session dependency.
- **emojiMode** — per shop; no cart/session dependency.

All of the above are read from `getShopConfig(shop)` and copied into `response.ui` when `allowUIConfig` is true; they do not depend on cart contents, session, or billing at response time (billing only gates *whether* custom UI is allowed, not the values).

### Dynamic (must remain backend decision)

- **crossSell** — depends on cart, catalog, strategy, recommendationLimit, capabilities.
- **freeShippingRemaining** — depends on cart total and shop threshold.
- **suppressCheckout** — from decision engine (cart/behavior).
- **milestones** — config-driven but filtered by capabilities; list is static per shop, visibility/capability is dynamic.
- **enableCouponTease** — capability + config; gated by billing.

**Note:** The entire `ui` object in the decision response is currently static (per-shop config). The “dynamic” part is that when `allowUIConfig` is false, the backend substitutes `SAFE_UI_FALLBACK` instead of shop config. So the *source* of UI (config vs fallback) is capability-driven; the values themselves are not cart-dependent.

---

## PART 3 — Decision Endpoint Payload Audit

**File:** `revstack/app/routes/cart.decision.ts`

**Top-level keys returned** (from `DecisionResponse` in `decision-response.server.ts` and construction in `cart.decision.ts`):

| Key | Category | Depends on cart/content? | Notes |
|-----|----------|---------------------------|--------|
| **crossSell** | Revenue logic | Yes | Products from engine; sliced by recommendationLimit and capabilities. |
| **freeShippingRemaining** | Revenue logic | Yes | Derived from cart total and config threshold. |
| **suppressCheckout** | Behavioral | Yes | From decision engine. |
| **milestones** | Revenue / behavioral | Partially | Config list; filtered by capabilities (allowMilestones, enableMilestones). |
| **enableCouponTease** | Behavioral toggle | No (capability + config) | Per-shop; no cart dependency. |
| **ui** | Styling + behavioral toggles | No | All fields (primaryColor, accentColor, borderRadius, showConfetti, countdownEnabled, emojiMode) are per-shop config or SAFE_UI_FALLBACK. |
| **crossSellDebug** | Analytics/debug | Yes | Only when CART_PRO_DEBUG=1. |

**UI styling keys that do NOT depend on cart contents:**

- **ui.primaryColor**
- **ui.accentColor**
- **ui.borderRadius**
- **ui.showConfetti**
- **ui.countdownEnabled**
- **ui.emojiMode**

All of these are either `config.*` or `SAFE_UI_FALLBACK`; none are computed from cart/session.

---

## PART 4 — Liquid Embed Capabilities

**File:** `revstack/extensions/cart-pro/blocks/cart_pro_embed.liquid`

**Current data-* attributes injected:**

| data-* attribute | Source | Available at first paint? |
|------------------|--------|----------------------------|
| `data-suppress-theme-drawer` | Block setting `suppress_theme_drawer` | Yes |
| `data-accent-color` | Block setting `accent_color` (default `#555555`) | Yes |
| `data-primary-color` | Block setting `primary_color` (default `#111111`) | Yes |
| `data-border-radius` | Block setting `border_radius` (0–24, default 12) | Yes |

**primaryColor / accentColor / borderRadius / shippingBarPosition at first paint:**

- **primaryColor, accentColor, borderRadius:** Yes — via `data-primary-color`, `data-accent-color`, `data-border-radius` from block settings.
- **shippingBarPosition:** Not in Liquid; not exposed in embed.

**Decision-dependent fields tied to Liquid:**

- None. Liquid only exposes the block’s theme-style settings (and suppress-theme-drawer). It does not expose milestones, cross-sell, freeShippingRemaining, or decision-only toggles (showConfetti, countdownEnabled, emojiMode).

**Gap:** The embed block settings are theme-customizer values (can differ from app settings). The app settings (saved in Prisma) are what the decision endpoint uses. So first paint uses Liquid/block; after decision loads, `applyUIConfig(d.ui)` can override with backend values — potential mismatch/flicker if merchant sets different values in app vs theme.

---

## PART 5 — Frontend Bootstrap Sequence

**File:** `revstack/extensions/cart-pro/assets/cart-pro.js`

**Execution order:**

1. **DOM ready** — Script runs with `defer`; `#cart-pro-root` exists with Liquid data-* attributes.
2. **sectionConfig read** — From `root.dataset`: enableCrossSell, enableFreeShippingBar, accentColor, primaryColor, borderRadius, showMilestones, mode, suppressThemeDrawer. (Liquid only provides accent/primary/borderRadius/suppressThemeDrawer; others get JS defaults.)
3. **applyUIConfig({ sectionConfig.primaryColor || SAFE_UI... })** — First paint: only primaryColor, accentColor, borderRadius from sectionConfig (or SAFE_UI). No showConfetti/countdown/emoji from DOM.
4. **Drawer render** — `init()`: inject critical CSS, drawer markup into shadow root, assignRefs(), attachDrawerListeners(), prewarmDecision(). Drawer is not opened yet.
5. **fetchDecisionSafe(cart)** — Called when cart is loaded (e.g. open drawer → loadCart → loadCartReal) or by prewarmDecision() after 1s. POST to `/apps/cart-pro/decision` with `{ cart }`.
6. **Decision response handling** — In `fetchDecisionSafe` then: `if (d && d.ui) applyUIConfig(d.ui);` — **first override** of UI by decision. Then in `applyDecisionDelta(prev, newDecision)`: `applyUIConfig(ui)` again — **second apply** when merging decision into state.

**When decision overrides UI config:**

- As soon as the decision response returns: `applyUIConfig(d.ui)` inside `fetchDecisionSafe` (line ~119).
- Again when `applyDecisionDelta` runs (e.g. after loadCartReal → fetchDecisionSafe → applyDecisionDelta): it sets `decisionState = newDecision` and calls `applyUIConfig(ui)` (line ~2202).

**Initial paint:**

- Uses **sectionConfig** for primary/accent/borderRadius (with SAFE_UI fallback). So first paint uses Liquid/block data when present.
- **showConfetti, countdownEnabled, emojiMode** have no DOM source; they are only applied when decision (or SAFE_DECISION/SAFE_UI) is used — i.e. after first cart load + decision fetch, or when rendering with cached/optimistic decision.

**Where flicker can occur:**

- **After decision returns:** If decision `ui` differs from sectionConfig (e.g. backend has different primary/accent than Liquid), `applyUIConfig(d.ui)` overwrites CSS variables. So colors/radius can change when the decision response arrives → **flicker**.
- **First open before decision:** First paint uses sectionConfig (or SAFE_UI). When `renderInitial(cart, decisionForRender)` runs, it uses optimistic or SAFE_DECISION; then when the real decision arrives, `applyDecisionDelta` runs and `applyUIConfig(ui)` can change colors again if backend config differs from Liquid/SAFE_UI.

---

## PART 6 — Caching & Staleness Risk

| Cache | TTL | Invalidation |
|-------|-----|--------------|
| **Shop config** (in-memory, per shop) | 5 minutes (`TTL = 5 * 60 * 1000` in `shop-config.server.ts`) | `invalidateShopConfigCache(shop)` on config update (e.g. `app.settings.tsx` action, onboarding, billing updates). |
| **Decision** (memory) | 30 s (`TTL_MS = 30_000` in `decision-cache.server.ts`) | Entry expires by time; no explicit invalidation. |
| **Decision** (Redis) | 60 s (`REDIS_DECISION_TTL_SECONDS = 60`) | No invalidation on config change. |

**Does config invalidation clear decision cache?**

- **No.** `invalidateShopConfigCache(shop)` only clears the shop config in-memory cache. It does **not** clear the decision cache (memory or Redis). So after a merchant saves new UI settings:
  - Next decision request for that shop will get fresh config via `getShopConfig(shop)` (cache miss or refill).
  - Cached decisions (same shop + cart hash) can still be served for up to 30–60 s with the **old** `response.ui`.

**Is static UI config unnecessarily coupled to decision cache?**

- **Yes.** The full decision response (including `ui`) is cached by (shop, cartHash). So static UI fields (primaryColor, accentColor, borderRadius, showConfetti, countdownEnabled, emojiMode) are tied to the same cache entry as crossSell, freeShippingRemaining, etc. Changing only shop UI config does not invalidate decision cache; clients may see old UI until cache TTL expires or cart hash changes.

---

## PART 7 — Deliverable Summary

### Clear separation: STATIC vs DYNAMIC

- **Static (candidates for DOM-only):** primaryColor, accentColor, borderRadius, showConfetti, countdownEnabled, emojiMode. All are per-shop; none depend on cart/session. They could be supplied only by Liquid/block (and optionally app-backed endpoint for theme app block sync) and not in the decision payload.
- **Dynamic (must stay in decision):** crossSell, freeShippingRemaining, suppressCheckout, milestones (config-derived but capability-gated), enableCouponTease (capability + config). These depend on cart, catalog, or billing and must remain backend-driven.

### Properties that should move to DOM-only responsibility (for a future refactor)

- **primaryColor, accentColor, borderRadius** — Already in Liquid at first paint; duplicate in decision causes override and possible flicker. Moving to DOM-only would remove them from the decision payload and avoid staleness in decision cache.
- **showConfetti, countdownEnabled, emojiMode** — Not in Liquid today; could be added as data-* (or block settings) so first paint and behavior are consistent without waiting for decision.

### Coupling that makes refactor risky

- **applyUIConfig** prefers **sectionConfig** over the `ui` argument for primary/accent/radius (sectionConfig wins when set). So if we stop sending these in the decision, the current code would still use DOM; but showConfetti/countdown/emoji have no DOM source today — they would need to be added to Liquid/block or a separate “static config” source.
- **Decision cache** stores the whole response including `ui`. Moving UI to DOM-only would allow decision cache to be invalidated or keyed without UI (or UI could be omitted from cached payload). Today, changing UI in app settings does not invalidate decision cache.
- **allowUIConfig** capability: when false, backend returns SAFE_UI_FALLBACK. If UI moves to DOM, capability could still gate what the theme/app block is allowed to show (e.g. hide advanced options in Liquid), but the decision endpoint would no longer need to send `ui` for static fields.

### Summary statements

**“Current architecture mixes static styling with dynamic cart intelligence because…”**  
…the decision endpoint returns a single payload that includes both cart-dependent data (crossSell, freeShippingRemaining, suppressCheckout, milestones, enableCouponTease) and per-shop UI config (primaryColor, accentColor, borderRadius, showConfetti, countdownEnabled, emojiMode). That UI config is loaded from the same `getShopConfig()` used elsewhere, copied into `response.ui`, and cached as part of the decision response. The frontend applies it by calling `applyUIConfig(d.ui)` when the decision returns, which can override the Liquid-supplied first paint and ties static look-and-feel to the decision request and decision cache TTL.

**“Separation is safe because…”**  
…all six UI fields in the decision response are already independent of cart contents; they depend only on shop config and capability (allowUIConfig). The Liquid embed already exposes primaryColor, accentColor, and borderRadius at first paint, and the frontend already prefers sectionConfig for those three in `applyUIConfig`. So moving static UI entirely to DOM/Liquid (and optionally a small “shop config” endpoint that does not depend on cart) would not change the semantics of revenue or cart logic; it would only change where the frontend reads those values and would allow decision cache to be used purely for cart-dependent data, reducing staleness and flicker from config changes.

---

*End of audit. No code changes. Mapping only.*
