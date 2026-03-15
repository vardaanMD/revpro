# Cart Pro V3 — theme extension

## How the script loads

- The block `cart_pro_embed_v3.liquid` is an **app embed** (target: body).
- It must be **enabled** in **Theme customizer → App embeds → Cart Pro V3**.
- When enabled, the block injects `<div id="cart-pro-root"></div>` and a script that:
  1. Fetches config from `/apps/cart-pro/snapshot/v3` (or uses cache).
  2. Creates `<script src="{{ 'cart-pro-v3.js' | asset_url }}" defer></script>` and appends it to `document.body`.

So `cart-pro-v3.js` is loaded **dynamically** after the inline script runs. The URL comes from Shopify’s `asset_url` (often a CDN URL like `https://cdn.shopify.com/.../assets/cart-pro-v3.js?...`).

## If "cart-pro-v3" doesn’t show in Network

1. **Confirm the embed is on**
   - Theme customizer → App embeds → ensure **Cart Pro V3** is enabled.
   - Without this, the block doesn’t render and the script is never requested.

2. **Find the request**
   - Network tab: filter by **JS** or search for **`cart-pro-v3`** or **`cart-pro`**.
   - The request name might be the full URL; search in the filter box for `v3.js` or `cart-pro`.
   - Or in **Elements**, search for `cart-pro-v3.js` to see the `<script>` tag and its `src`.

3. **Confirm you’re on the latest build**
   - Build: from repo root, `cd revstack/cart-pro-v3-runtime && npm run build`.
   - Output: `revstack/extensions/cart-pro/assets/cart-pro-v3.js`.
   - For **Shopify Theme Dev**: extension assets are usually served from the built extension; after `npm run build`, restart or re-sync so the dev server serves the new file.
   - For **deployed apps**: deploy the app/extension so the new asset is uploaded; then hard refresh the storefront (Ctrl+Shift+R / Cmd+Shift+R) to avoid cache.

4. **Quick runtime check**
   - Open the storefront, then Console. If the script ran, you should see:
     - `[CartPro V3] load defer+v2`
     - After opening the cart: `[CartPro V3] opening drawer (deferred)`.
   - If those never appear, the script isn’t loading (embed off, or wrong page/env).
