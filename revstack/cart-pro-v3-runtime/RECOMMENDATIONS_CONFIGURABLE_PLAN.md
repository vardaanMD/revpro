# Plan: Configurable Recommendations Title, Coupon Tease Text & Accent-Coloured Banner

This plan covers three changes:

1. **Configurable “You may like” title** — Make the recommendations section heading configurable (default: “You may also like”).
2. **Configurable “Apply coupon at checkout…” text** — Ensure the coupon tease message is configurable end-to-end (backend already supports it; verify admin UI and runtime).
3. **Coupon tease banner uses accent colour** — Replace hardcoded green in the coupon tease section with the user’s accent colour (`--cp-accent`).

---

## Current state

| Item | Where | Status |
|------|--------|--------|
| Recommendations heading | `Recommendations.svelte` line 44: `<h4>You may also like</h4>` | **Hardcoded** |
| Coupon tease message | `config-v3.ts`: `discounts.teaseMessage`; runtime: `CouponSection.svelte` reads `getConfig()?.discounts?.teaseMessage` | **Already configurable** in backend & runtime; admin may not expose edit field |
| Coupon banner background | `cart-pro-v2.css` `.cp-coupon-banner`: hardcoded `#1a5f2a`, `rgba(76,175,80,...)` for gradient/border/shadow | **Hardcoded green**; should use `--cp-accent` |

---

## 1. Configurable recommendations title (“You may like”)

### Backend (config schema & snapshot)

- **File: `revstack/app/lib/config-v3.ts`**
  - Add to `CartProConfigV3Upsell`: `recommendationsHeading?: string;`
  - In `DEFAULT_CONFIG_V3.upsell`: `recommendationsHeading: "You may also like",`
  - In `mergeWithDefaultV3`, when merging `persisted.upsell`:  
    `if (typeof u.recommendationsHeading === 'string') base.upsell.recommendationsHeading = u.recommendationsHeading.trim() || base.upsell.recommendationsHeading;`  
    (or keep default when empty)

- **File: `revstack/app/routes/cart.snapshot.v3.ts`**  
  - No change required: snapshot already returns full config from `buildV3SnapshotPayload(configForPayload)`, which spreads `config` including `upsell`.

### Runtime (engine config & UI)

- **File: `revstack/cart-pro-v3-runtime/src/engine/configSchema.ts`**
  - Add to `CartProConfigV3Upsell`: `recommendationsHeading?: string;`

- **File: `revstack/cart-pro-v3-runtime/src/engine/defaultConfig.ts`** (if used for defaults)
  - Add `recommendationsHeading: "You may also like"` to upsell defaults.

- **File: `revstack/cart-pro-v3-runtime/src/engine/normalizeConfig.ts`**
  - In upsell normalization: read `recommendationsHeading` from raw config (string trim), default to `"You may also like"` when missing/empty.

- **File: `revstack/cart-pro-v3-runtime/src/ui/v2/Recommendations.svelte`**
  - Replace hardcoded heading with config-driven value, e.g.  
    `$: recommendationsHeading = engine?.getConfig?.()?.upsell?.recommendationsHeading ?? 'You may also like';`  
  - Use in template: `<h4 style="margin-bottom:10px;">{recommendationsHeading}</h4>`

### Admin (optional)

- **File: `revstack/app/routes/app.settings.tsx`**
  - Add optional text input for “Recommendations section title” that maps to `config.upsell.recommendationsHeading`, with placeholder “You may also like”. Persist via existing config save (configV3.upsell).

- **File: `revstack/app/lib/settings-validation.server.ts`**
  - If settings are validated/sanitized before save, allow `upsell.recommendationsHeading` (string, optional).

---

## 2. Configurable “Apply coupon at checkout to unlock savings”

- **Backend:** Already in `config-v3.ts` as `discounts.teaseMessage`; merged in `mergeWithDefaultV3`; snapshot includes full config → **no change**.
- **Runtime:** `CouponSection.svelte` already uses `engine?.getConfig?.()?.discounts?.teaseMessage` → **no change**.
- **Admin:** Confirm whether the Settings page has a text field for “Coupon tease message”. If **not**, add one (e.g. near “Enable Coupon Tease”) that reads/writes `config.discounts.teaseMessage`, with placeholder “Apply coupon at checkout to unlock savings”.
- **Fallback:** Ensure `safeFallbackSnapshot()` in `cart.snapshot.v3.ts` includes `discounts: { ..., teaseMessage: "Apply coupon at checkout to unlock savings" }` so fallback payloads still show a default message.

---

## 3. Coupon tease section uses accent colour (no hardcoded green)

- **File: `revstack/cart-pro-v3-runtime/src/styles/cart-pro-v2.css`**
  - In `.cp-coupon-banner` (around lines 780–795):
    - **Background:** Replace  
      `background: linear-gradient(135deg, rgba(76, 175, 80, 0.12), rgba(76, 175, 80, 0.06));`  
      with a gradient based on `var(--cp-accent)` (e.g. `color-mix(in srgb, var(--cp-accent) 12%, transparent)` and a lighter variant for the second stop), or a simple `background: color-mix(in srgb, var(--cp-accent) 15%, transparent);` if a single colour is enough.
    - **Border:** Replace  
      `border: 1px solid rgba(76, 175, 80, 0.4);`  
      with something like `border: 1px solid color-mix(in srgb, var(--cp-accent) 40%, transparent);`
    - **Box-shadow:** Replace  
      `box-shadow: 0 0 12px rgba(76, 175, 80, 0.2);`  
      with `box-shadow: 0 0 12px color-mix(in srgb, var(--cp-accent) 20%, transparent);`
    - **Text colour:** Replace  
      `color: #1a5f2a;`  
      with `color: var(--cp-accent);` or a darker variant for readability (e.g. `color-mix(in srgb, var(--cp-accent) 80%, black)`). Prefer a variant that stays readable on the new accent-based background.

- **File: `revstack/cart-pro-v3-runtime/src/styles/cart-pro.css`** (if V1/V2 still use the same block)
  - Apply the same `.cp-coupon-banner` changes there if that file is still in use for the same component.

- **Result:** The coupon tease section will follow the merchant’s accent colour set in appearance (already applied to the host as `--cp-accent` in `mount.ts`).

---

## Implementation order

| Step | Task | Area |
|------|------|------|
| 1 | Add `recommendationsHeading` to config-v3 (interface, default, merge) | Backend |
| 2 | Add `recommendationsHeading` to runtime config schema, defaults, normalizeConfig | Runtime |
| 3 | Use config heading in `Recommendations.svelte` | Runtime |
| 4 | (Optional) Add “Recommendations section title” and “Coupon tease message” inputs in Settings | Admin |
| 5 | Replace hardcoded green in `.cp-coupon-banner` with `--cp-accent` (and optionally fix fallback snapshot teaseMessage) | CSS + snapshot |

---

## Files summary

| File | Changes |
|------|--------|
| `revstack/app/lib/config-v3.ts` | Add `recommendationsHeading` to upsell type, default, and merge. |
| `revstack/app/routes/cart.snapshot.v3.ts` | Optionally add `teaseMessage` to `safeFallbackSnapshot().discounts`. |
| `revstack/app/routes/app.settings.tsx` | Optional: recommendations title + coupon tease message inputs. |
| `revstack/app/lib/settings-validation.server.ts` | Optional: allow `upsell.recommendationsHeading` (and persist teaseMessage if not already). |
| `revstack/cart-pro-v3-runtime/src/engine/configSchema.ts` | Add `recommendationsHeading?: string` to upsell. |
| `revstack/cart-pro-v3-runtime/src/engine/defaultConfig.ts` | Add default `recommendationsHeading`. |
| `revstack/cart-pro-v3-runtime/src/engine/normalizeConfig.ts` | Normalize `recommendationsHeading` with default. |
| `revstack/cart-pro-v3-runtime/src/ui/v2/Recommendations.svelte` | Use `recommendationsHeading` from config for `<h4>`. |
| `revstack/cart-pro-v3-runtime/src/styles/cart-pro-v2.css` | `.cp-coupon-banner`: use `--cp-accent` for background, border, shadow, text. |
| `revstack/cart-pro-v3-runtime/src/styles/cart-pro.css` | Same as above if that stylesheet still styles the coupon banner. |

---

## Testing

- **Recommendations title:** Change `recommendationsHeading` in stored config (or via Settings if added); reload storefront and confirm the recommendations section shows the custom title.
- **Coupon tease message:** Change `discounts.teaseMessage` (or use Settings); confirm the coupon tease banner shows the new text when no code is applied.
- **Accent colour:** Change appearance accent colour in Settings; confirm the coupon tease section (background, border, shadow, text) uses the new accent and no green remains.
