# Cart Pro V3 Runtime — Build, Deploy & Verify

## 1. Where the storefront loads the runtime

- **Shopify serves:** `extensions/<extension-id>/assets/cart-pro-v3.js`
- **In this repo:** That file is **`revstack/extensions/cart-pro/assets/cart-pro-v3.js`**
- **Extension:** Theme app extension `cart-pro` (handle), block `cart_pro_embed_v3.liquid` loads the script via `{{ 'cart-pro-v3.js' | asset_url }}`.

## 2. Build pipeline (no copy step)

The runtime is **built directly into** the extension assets:

| Step | Location |
|------|----------|
| Source | `revstack/cart-pro-v3-runtime/` (Svelte + Engine, Vite) |
| Build output | **Same repo:** `revstack/extensions/cart-pro/assets/` |
| Vite config | `revstack/cart-pro-v3-runtime/vite.config.ts` → `outDir: '../extensions/cart-pro/assets'`, `fileName: 'cart-pro-v3.js'` |

So **there is no separate copy step**. Building the runtime overwrites the extension asset in place.

## 3. Build the runtime (updates extension asset)

```bash
cd revstack/cart-pro-v3-runtime
npm run build
```

This writes:

- `revstack/extensions/cart-pro/assets/cart-pro-v3.js`
- `revstack/extensions/cart-pro/assets/cart-pro-v3.css` (if emitted)

The storefront script is `cart-pro-v3.js`; the CSS is inlined in the JS bundle by the Vite plugin.

## 4. Push extension to Shopify

From the **app root** (where `shopify.app.toml` lives):

- **Development (preview):**  
  `shopify app dev`  
  Pushes the extension and runs the app; storefront uses the updated assets in the dev store.

- **Production:**  
  `shopify app deploy`  
  Deploys the app and extensions; storefront will load the new `cart-pro-v3.js` from the deployed extension.

Ensure the extension directory (e.g. `revstack/extensions/cart-pro` or the path referenced by your app config) is the one included in the deploy.

## 5. Verify on the storefront

Open the storefront (dev or production, depending on what you deployed). In the browser console run:

```javascript
// 1) V3 root and DrawerV2 in shadow DOM (implementation detail may appear in markup/comments)
document.querySelector('#revstack-v3-root')?.shadowRoot?.innerHTML.includes('DrawerV2');

// 2) Engine global (required for V3 to work)
window.CartProV3Engine !== undefined;
```

**Expected:**

- `true` for the first check if the shadow root contains the string `"DrawerV2"` (e.g. in a comment or class name).
- `true` for the second check — the storefront is loading the updated runtime with the V2 CSS and DrawerV2 implementation.

If the first is `false` but the second is `true`, the runtime is correct and the UI is DrawerV2; the string "DrawerV2" might be minified or not present in the DOM. Rely on `window.CartProV3Engine !== undefined` as the main indicator that the updated bundle is loaded.

## Summary

| Goal | Action |
|------|--------|
| Ensure storefront uses updated runtime (exact V2 CSS + DrawerV2) | Run `npm run build` in `revstack/cart-pro-v3-runtime`, then `shopify app dev` or `shopify app deploy`. |
| Confirm updated bundle on storefront | Open storefront → Console: `window.CartProV3Engine !== undefined` and optionally the `#revstack-v3-root` shadow root check above. |
