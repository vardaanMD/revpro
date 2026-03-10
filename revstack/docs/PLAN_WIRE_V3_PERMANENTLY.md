# Plan: Permanently Wire V3 to Admin UI and Cart Drawer (No Toggle)

**Goal:** Make Cart Pro V3 the only cart drawer runtime. Remove all runtime version toggle UI and language from the admin and storefront. The storefront always loads the V3 bundle; the admin always shows V3 preview and V3-only copy.

**Scope:** Runtime version (v1/v2/v3) only. **Engine version** (v1/v2 — decision route vs config-first) stays as-is unless you decide to change it later.

---

## 1. Storefront (Theme Extension)

**File:** `revstack/extensions/cart-pro/blocks/cart_pro_embed_v3.liquid`

- **Current:** Fetches snapshot from `/apps/cart-pro/snapshot/v3`, reads `config.runtimeVersion`, and loads either `cart-pro-v1.js`, `cart-pro-v2.js`, or `cart-pro-v3.js` via `loadRuntime(version)`. Cache path also branches on `parsed.runtimeVersion`.
- **Change:**
  - Always load `cart-pro-v3.js` (e.g. call `loadRuntime('v3')` or inline the single script tag).
  - Remove branching on `config.runtimeVersion` for script selection.
  - Optionally simplify: after applying snapshot to `window.__CART_PRO_SNAPSHOT__`, always append the v3 script; no `useConfigAndLoad(config)` version branch.
  - Cache key and snapshot fetch can stay; only the “which script to load” logic becomes v3-only.
- **Comment:** Update the block comment (e.g. “loads v1, v2, or v3 runtime based on config.runtimeVersion”) to state that the block always loads the V3 runtime.

**Backward compatibility:** Shops that currently have `configV3.runtimeVersion` = `"v1"` or `"v2"` in the DB will, after deploy, get the V3 drawer anyway because the Liquid no longer reads that field for script choice. No data migration required for “wire V3 only”; existing config can keep the field for backward compatibility elsewhere if needed.

---

## 2. Snapshot API (Storefront Config)

**File:** `revstack/app/routes/cart.snapshot.v3.ts`

- **Current:** Builds payload including `runtimeVersion` from `configV3.runtimeVersion ?? "v3"` and returns it in the JSON.
- **Change (optional but consistent):**
  - Always set `runtimeVersion: "v3"` in the payload (or keep reading from config and defaulting to `"v3"`). No behavior change for storefront if Liquid no longer uses it for script choice.
- **Fallback:** `safeFallbackSnapshot()` already returns `runtimeVersion: "v3"`. No change needed there.

---

## 3. Admin UI — Settings Page

**File:** `revstack/app/routes/app.settings.tsx`

### 3.1 Remove runtime version state and form controls

- Remove the **Runtime version (storefront)** dropdown and its state:
  - Remove `runtimeVersion` and `setRuntimeVersion` from `useState` (and any initial value from config).
  - Remove the `<SelectField>` for `runtimeVersion` (name="runtimeVersion", options v1/v2/v3).
- Keep the **Engine version** dropdown (v1/v2) as-is unless you decide to change it separately.

### 3.2 “Storefront state” section

- **Current:** Displays a row “Runtime” with value V1 / V2 / V3 from config.
- **Options:**
  - **A)** Remove the “Runtime” row entirely (storefront is always V3).
  - **B)** Keep one row that always shows “V3” with no toggle (no need to read from config for display).

Recommendation: **A** — remove the row to avoid implying there is a choice.

### 3.3 “Cart Pro Engine” section

- **Current:** Section has two dropdowns (Engine version + Runtime version) and description: “Choose which engine version runs on your storefront. Use V3 for custom header messages and drawer background. Change anytime for instant rollback.”
- **Change:**
  - Remove the Runtime version dropdown (see 3.1).
  - Update section title/description to drop references to “runtime” and “V3 for custom header messages…” (e.g. “Cart Pro Engine” with a short note that it controls the decision engine; no “runtime” or “storefront version” toggle language).

### 3.4 Visual Customization section

- **Current:** When `runtimeVersion !== "v3"`, a hint is shown: “Header messages and drawer background apply only when Runtime version (above) is set to **V3**.”
- **Change:** Remove this conditional block entirely; all users are on V3, so the hint is obsolete.

### 3.5 Preview panel (right column)

- **Current:** Label is “Cart Pro V3 preview” when `runtimeVersion === "v3"`, else “Live preview”. When V3, shows the V3 iframe; otherwise shows the old `CartPreview` component.
- **Change:**
  - Always show the V3 preview: same iframe and “Cart Pro V3 preview” (or “Cart drawer preview”) label.
  - Remove the `runtimeVersion === "v3" ? ... : ...` branch and the `CartPreview` path for non-V3.
  - Remove any “Live preview” copy.

### 3.6 Form submit and config build

- **Current:** Form includes `runtimeVersion`; `buildConfigV3FromForm` sets `base.runtimeVersion = formData.runtimeVersion` when valid.
- **Change:**
  - In `buildConfigV3FromForm`, always set `base.runtimeVersion = "v3"` (and remove reading from `formData.runtimeVersion`), or omit and rely on `mergeWithDefaultV3` default. Prefer explicitly setting `"v3"` so saved config is consistent.
  - Either remove `runtimeVersion` from the form (no hidden input) or add a single hidden input `name="runtimeVersion" value="v3"` if the action still expects it. Prefer removing from form and setting in `buildConfigV3FromForm` only.

### 3.7 Loader

- Loader currently passes `runtimeVersion` from config for initial state. After removing the dropdown, you can either:
  - Stop passing `runtimeVersion` to the settings page (and remove from component props/types), or
  - Keep passing a fixed `"v3"` for any remaining display (e.g. if you keep a read-only “Runtime: V3” somewhere). Recommendation: don’t pass it if the Settings UI no longer shows runtime at all.

---

## 4. Settings Validation and Action

**File:** `revstack/app/lib/settings-validation.server.ts`

- **Current:** `runtimeVersionSchema = z.enum(["v1","v2","v3"]).optional()` and form parsing reads `runtimeVersion` from the request.
- **Change:**
  - Either remove `runtimeVersion` from the schema and from `parseSettingsFormData` (and have the action/buildConfigV3FromForm always use `"v3"`), or keep it optional and default to `"v3"` when building config. Recommendation: remove from form schema and parsing; always set `"v3"` when building `configV3` in the action.

**File:** `revstack/app/routes/app.settings.tsx` (action)

- When calling `buildConfigV3FromForm(data, ...)`, `data` will no longer include `runtimeVersion`; `buildConfigV3FromForm` will set `base.runtimeVersion = "v3"` unconditionally.

---

## 5. Config Types and Defaults

**File:** `revstack/app/lib/config-v3.ts`

- **Current:** `CartProConfigV3` has optional `runtimeVersion?: RuntimeVersion`; `DEFAULT_CONFIG_V3` and `mergeWithDefaultV3` support v1/v2/v3.
- **Change:**
  - **Option A:** Keep the type and defaults; only the UI and Liquid stop offering/using other values. Always persist `"v3"` from admin and always load v3 on storefront.
  - **Option B:** Narrow type to `runtimeVersion?: "v3"` and simplify `mergeWithDefaultV3` so only `"v3"` is ever set. Safer for “no toggle” is Option A; Option B is a follow-up cleanup.

Recommendation: **Option A** for this pass. No type or default change required if we only stop sending non-V3 from the UI and always load v3 in Liquid.

---

## 6. Other Admin Routes (Layout, Dashboard, Analytics)

**Files:**  
`revstack/app/routes/app.tsx`, `revstack/app/routes/app._index.tsx`, `revstack/app/routes/app.analytics.tsx`

- **Current:** Each derives `runtimeVersion` from `configV3?.runtimeVersion` and shows a “Runtime: V1/V2/V3” badge (nav or section).
- **Change:**
  - **Option A:** Always show “V3” (or “Cart runtime: V3”) and stop reading from config for this display; you can remove loader logic that passes `runtimeVersion` and hardcode the label.
  - **Option B:** Remove the runtime badge entirely from nav and dashboard/analytics, since there is no longer a choice.

Recommendation: **Option B** for app layout nav and dashboard/analytics to remove all “version choice” language; optionally keep a single “Cart Pro” or “V3” label in one place if you still want to indicate which stack is running.

---

## 7. Onboarding

**File:** `revstack/app/lib/onboarding-wizard.server.ts`

- **Current:** `buildConfigV3FromOnboardingStep3(..., runtimeVersion?: RuntimeVersion)` optionally sets `base.runtimeVersion` when provided.
- **Change:** Always set `base.runtimeVersion = "v3"` when building config from onboarding (e.g. ignore or remove the parameter and set `"v3"` inside the function). Update the file comment to say config is persisted with V3 as the cart drawer runtime.

**File:** `revstack/app/routes/app.onboarding.tsx`

- **Current:** Comment mentions “configV3 (including runtimeVersion) is persisted”.
- **Change:** Update comment to state that the cart drawer is always V3 (no runtime choice in onboarding).

If onboarding step 3 form or any step ever sent `runtimeVersion`, stop sending it and rely on the server always setting `"v3"`.

---

## 8. Preview iframe

**File:** `revstack/app/routes/app.preview-v3-frame.ts`

- **Current:** May read `runtimeVersion` from config for consistency.
- **Change:** No functional change required; this route already serves the V3 preview. You can keep returning `runtimeVersion: "v3"` in any payload it exposes, or leave as-is.

---

## 9. Tests

**File:** `revstack/tests/snapshot.v3.contract.test.ts`

- Already uses `runtimeVersion: "v3"` in payloads. No change required unless you remove or rename the field from the snapshot response (then update tests accordingly).

---

## 10. Optional Cleanup (Later)

- **Liquid:** Remove dead code paths that would have loaded v1/v2 (e.g. `loadRuntime('v1'|'v2')` branches) if you want to keep the file minimal.
- **Docs/comments:** Search for “runtime version”, “v1”, “v2”, “toggle”, “rollback” in `revstack/docs/` and `README` and update or remove as needed.
- **DB:** No migration required. Existing `configV3.runtimeVersion` values can remain; they are simply ignored for script loading and no longer editable in the UI.
- **Assets:** `cart-pro-v1.js` / `cart-pro-v2.js` can remain in the extension for now (e.g. for rollback or legacy themes) or be removed in a later cleanup; the plan does not depend on deleting them.

---

## 11. Order of Implementation (Safe Sequence)

1. **Liquid:** Always load `cart-pro-v3.js` and stop branching on `config.runtimeVersion`. Deploy storefront extension. All stores now see V3 drawer regardless of saved config.
2. **Settings action + validation:** In the settings action, always build `configV3` with `runtimeVersion: "v3"`; remove `runtimeVersion` from form schema/parsing or pass hidden "v3".
3. **Settings UI:** Remove runtime dropdown, “Runtime” row in Storefront state, conditional V3 hint in Visual Customization, and the non-V3 preview path; always show V3 preview.
4. **buildConfigV3FromForm:** Always set `base.runtimeVersion = "v3"`.
5. **Onboarding:** Always set `runtimeVersion` to `"v3"` in `buildConfigV3FromOnboardingStep3`.
6. **Layout / dashboard / analytics:** Remove or simplify runtime badge (always “V3” or remove).
7. **Comments and docs:** Update or remove toggle/version language.

This order avoids any period where the UI still allows selecting v1/v2 but the storefront already ignores it; after step 1, storefront is V3-only, then the admin is simplified to match.

---

## Summary Table

| Area | Action |
|------|--------|
| **Liquid block** | Always load `cart-pro-v3.js`; remove version branch for script choice. |
| **Snapshot API** | Keep returning `runtimeVersion` (e.g. always `"v3"`) or leave as-is. |
| **Settings – form** | Remove Runtime version dropdown and related state. |
| **Settings – Storefront state** | Remove “Runtime” row (or show fixed “V3”). |
| **Settings – Cart Pro Engine** | Remove Runtime dropdown; update section copy (no runtime/toggle language). |
| **Settings – Visual Customization** | Remove “only when Runtime is V3” hint. |
| **Settings – Preview** | Always V3 iframe; remove “Live preview” / CartPreview branch. |
| **buildConfigV3FromForm** | Always set `base.runtimeVersion = "v3"`. |
| **Settings validation** | Drop `runtimeVersion` from form schema/parsing. |
| **app.tsx / _index / analytics** | Remove or fix runtime badge to “V3” only. |
| **Onboarding** | Always set `runtimeVersion = "v3"` when building config. |
| **config-v3 types** | No change (optional: narrow to `"v3"` later). |

No DB migration; no removal of cart-pro-v1/v2 assets required for this plan.
