# White-Label Single-Site Implementation Plan

Plan for one website: **cart always free**, **no admin access**, **no visible “app”** (position as custom-coded), **no merchant app download** (you install for them).

**Constraint:** No permanent changes to the main codebase — the same app continues to be sold to other merchants. Anything specific to the one merchant is **env-only** or **paste-in theme code** (or a separate Partner app with the same codebase).

---

## Overview

| Goal | Mechanism | Repo change? |
|------|------------|---------------|
| Cart free for one site | `PAYWALL_WHITELIST` env | ❌ No |
| No admin for that site | `ADMIN_DISABLED_SHOPS` env + block `/app/*` | ✅ New module + runAppAuth only |
| No “Cart Pro” in Theme Editor | **Theme paste-in** (snippet in their theme; no app embed) | ❌ No — use doc/snippet only |
| App name in Apps list | **Separate Partner app** for white-label (same codebase) | ❌ No |
| No app download | You install app for merchant; ops only | ❌ No |

---

## Phase 1: Cart Free (Already Done)

**Env:** `PAYWALL_WHITELIST`

- **Where:** `app/lib/billing-context.server.ts` — `isWhitelisted(shop)`; when true, `getBillingContext` returns `growth` plan, `isEntitled: true`, full capabilities.
- **Action:** Set `PAYWALL_WHITELIST=client-store.myshopify.com` (comma-separated for multiple). No code changes.

---

## Phase 2: No Admin for That Site

**Goal:** When a merchant from a “custom” shop opens the app (e.g. from Apps menu), they get a 404 or a minimal “No access” page instead of the dashboard/settings/billing.

### 2.1 Add `ADMIN_DISABLED_SHOPS` env and helper

- **New module:** `app/lib/admin-disabled.server.ts` (or add to an existing “feature flags” module).
- **Env:** `ADMIN_DISABLED_SHOPS` — comma-separated list of shop domains (e.g. `client-store.myshopify.com`). Same format as `PAYWALL_WHITELIST`: normalized via `normalizeShopDomain`.
- **API:**
  - `getAdminDisabledSet(): Set<string>` — parse env once, cache in module (same pattern as `billing-context.server.ts` `getWhitelistSet()`).
  - `isAdminDisabled(shop: string): boolean` — normalized shop in set.

### 2.2 Where to enforce

**Option A (recommended): in `runAppAuth`**

- **File:** `app/run-app-auth.server.ts`.
- **When:** After `authenticate.admin` and `normalizeShopDomain(shop)` (you have `shop`).
- **If `isAdminDisabled(shop)`:** Return a **404 Response** (e.g. `new Response(null, { status: 404 })`) instead of setting context and returning `null`. No layout, no dashboard — request ends there.
- **Pros:** Single choke point for all `/app/*`; no React Router or layout runs. **Cons:** None significant.

**Option B: in app layout**

- **File:** `app/routes/app.tsx` loader.
- **When:** After reading `shop` from context or auth.
- **If `isAdminDisabled(shop)`:** `throw new Response(null, { status: 404 })` or return loader data that renders a minimal “No access” page.
- **Pros:** Keeps server.ts unchanged. **Cons:** Auth and getShopConfig still run before the check.

**Recommendation:** Implement in **runAppAuth** so admin-disabled shops never hit layout or child loaders.

### 2.3 404 vs “No access” page

- **404:** Simple, no extra UI. Merchant sees “Page not found” in the embedded app frame.
- **“No access” page:** Requires a minimal route or component (e.g. “You don’t have access to this area”). Prefer **404** for simplicity unless you want a custom message.

### 2.4 Files to touch

| File | Change |
|------|--------|
| `app/lib/admin-disabled.server.ts` | **New.** Parse `ADMIN_DISABLED_SHOPS`, expose `isAdminDisabled(shop)`. |
| `app/run-app-auth.server.ts` | After resolving `shop`, if `isAdminDisabled(shop)` return 404 and do not set context. |

### 2.5 Tests

- **Unit:** `admin-disabled.server.ts` — empty env → no shop disabled; env with one shop → only that shop disabled; normalization (trailing slash, https, etc.) matches.
- **Integration:** Request `GET /app` (or any `/app/*`) with session for a shop in `ADMIN_DISABLED_SHOPS` → 404; shop not in list → 200 and app loads.

---

## Phase 3: White-Label Without Changing the Main Repo

### 3.1 Storefront (customer-facing)

- No “Revenity” or “Cart Pro” in customer-facing copy. Drawer title is “Your Cart”. No change needed.

### 3.2 Theme Editor — no “Cart Pro” block for this merchant (theme paste-in)

**Problem:** If they use the app’s theme extension, they see “Cart Pro V3” in App embeds. Changing that name in the repo would affect all merchants.

**Solution: don’t use the app extension for this merchant.** Give them **theme code to copy into their theme** (snippet or section). That code:

1. Renders `<div id="cart-pro-root"></div>`.
2. Loads the cart script from **your server** (e.g. `https://your-app-url.com/extensions-assets/cart-pro-v3.js` — same URL you use for the admin preview).
3. Fetches `/apps/cart-pro/snapshot/v3` (app proxy; app must be installed for this to work).

They **do not** enable “Cart Pro V3” in App embeds. So they never see that block name. The app is still installed (for proxy and backend), but the storefront integration is “custom code” you gave them.

- **No repo change:** Keep the paste-in as a **standalone file** in `docs/` or `docs/theme-paste-in/` (e.g. `cart-embed-snippet.liquid`). It’s for you to copy-paste into the client’s theme, not part of the app build. Main extension stays as-is for other merchants.
- **Script URL:** In the snippet, the script `src` is your app’s public URL (e.g. `https://app.revenity.io/extensions-assets/cart-pro-v3.js`). Ensure that path is reachable on the storefront (no admin-only auth).

### 3.3 App name in the Apps list (only for this merchant)

- The app will still appear under **Apps** when installed. To show a different name (e.g. “Cart” or the client’s brand) **only for white-label**, use a **second app** in Partner Dashboard: same codebase, same deployment, but a different “App name” in App setup. Install that white-label app on the one merchant’s store. No code changes — only Partner Dashboard config.

---

## Theme paste-in snippet (white-label, no extension)

Use this **only for the one merchant** where you want “we coded this for you.” Store it in `docs/theme-paste-in/` (or similar) — not in the app extension. You (or the merchant) add it to their theme as a **snippet** or **section** that’s included in the theme layout (e.g. before `</body>`).

Replace `YOUR_APP_ORIGIN` with your app’s public origin (e.g. `https://app.revenity.io`). The script must be publicly loadable (no admin auth).

```liquid
{% comment %}
  Custom cart embed — paste into theme as snippet, include in layout (e.g. theme.liquid before </body>).
  Requires app installed for /apps/cart-pro/* proxy. Script URL: your app origin + /extensions-assets/cart-pro-v3.js
{% endcomment %}
<div id="cart-pro-root"></div>
<script>
(function() {
  var CACHE_KEY = 'cart-pro-v3-config';
  var SCRIPT_URL = 'YOUR_APP_ORIGIN/extensions-assets/cart-pro-v3.js';
  function loadV3() {
    var script = document.createElement('script');
    script.src = SCRIPT_URL;
    script.defer = true;
    document.body.appendChild(script);
  }
  function applySnapshot(config) {
    window.__CART_PRO_SNAPSHOT__ = config;
    try { sessionStorage.setItem(CACHE_KEY, JSON.stringify(config)); } catch (e) {}
    if (typeof window.__CART_PRO_RELOAD_CONFIG__ === 'function') window.__CART_PRO_RELOAD_CONFIG__(config);
  }
  function fetchSnapshotThenApply() {
    fetch('/apps/cart-pro/snapshot/v3', { credentials: 'same-origin' })
      .then(function(r) {
        if (!r.ok) throw new Error('Snapshot ' + r.status);
        return r.json();
      })
      .then(function(config) { if (config) applySnapshot(config); })
      .catch(function(err) { console.error('[Cart] Snapshot failed', err); });
  }
  try {
    var cached = sessionStorage.getItem(CACHE_KEY);
    if (cached) {
      var parsed = JSON.parse(cached);
      if (parsed && typeof parsed === 'object') {
        applySnapshot(parsed);
        fetchSnapshotThenApply();
        loadV3();
        return;
      }
    }
  } catch (e) {}
  loadV3();
  fetchSnapshotThenApply();
})();
</script>
```

- **No change to main repo:** This file lives in `docs/` (or a one-off folder). The app extension stays “Cart Pro V3” for everyone else.
- **CORS:** Ensure your server allows the store’s domain to load the script (same as for admin preview iframe if needed; many setups already allow it).

---

## Phase 4: No App Download (Ops)

- **Meaning:** Merchant does not go to the App Store to install; you install the app on their store.
- **Steps for white-label merchant:**
  1. Install the app on the client’s store (Partner Dashboard or API). Optionally use a **separate Partner app** (same codebase) so the app name in Apps is custom.
  2. **Do not** enable “Cart Pro V3” in App embeds. Instead, add the **theme paste-in snippet** (above) to their theme, with `YOUR_APP_ORIGIN` set.
  3. Set env: `PAYWALL_WHITELIST`, `ADMIN_DISABLED_SHOPS` for that shop.
- No code changes to the app; only env and theme paste-in.

---

## Implementation Checklist

- [x] **Phase 2.1** Add `app/lib/admin-disabled.server.ts`: parse `ADMIN_DISABLED_SHOPS`, `getAdminDisabledSet()`, `isAdminDisabled(shop)`.
- [x] **Phase 2.2** In `runAppAuth`: after resolving `shop`, if `isAdminDisabled(shop)` return 404 and do not call `setAppLayoutInContext`.
- [x] **Phase 2.5** Add tests for admin-disabled (unit + runAppAuth integration): `tests/admin-disabled.server.test.ts`, `tests/run-app-auth.admin-disabled.test.ts`.
- [x] **Theme paste-in** Add `docs/theme-paste-in/cart-embed-snippet.liquid` (and README); replace `YOUR_APP_ORIGIN` in snippet when using for a merchant.
- [ ] **Phase 4** Document white-label flow in runbook: install app (optional separate Partner app for custom name), use paste-in snippet instead of App embeds, set `PAYWALL_WHITELIST` and `ADMIN_DISABLED_SHOPS`.

**No permanent changes:** Extension block name stays “Cart Pro V3” in the repo. Other merchants use the extension; the one white-label merchant uses the paste-in snippet only.

---

## Env Summary (Single-Site)

```bash
# Cart free + full capabilities for this shop
PAYWALL_WHITELIST=client-store.myshopify.com

# Block admin UI (404) for this shop
ADMIN_DISABLED_SHOPS=client-store.myshopify.com
```

Use the same domain in both for “free cart + no admin” for that one site.
