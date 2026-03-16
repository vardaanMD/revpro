# Theme paste-in (white-label, one merchant only)

Use these files **only** when you want a single merchant to see the cart as “custom coded” for them — no “Cart Pro V3” in Theme Editor, no app embed.

- **Main app and extension:** Unchanged. Other merchants keep using the normal app and “Cart Pro V3” app embed.
- **This merchant:** App is installed (for proxy), but you **do not** enable the app embed. Instead you add the snippet to their theme.

## Steps

1. **Install the app** on the merchant’s store (you do it; they don’t “download” from the store).
2. **Set env** for that shop: `PAYWALL_WHITELIST`, `ADMIN_DISABLED_SHOPS` (see `WHITE_LABEL_SINGLE_SITE_PLAN.md`).
3. **Edit `cart-embed-snippet.liquid`:** Replace `YOUR_APP_ORIGIN` with your app’s public URL (e.g. `https://app.revenity.io`). No trailing slash.
4. **Add to their theme:** Create a snippet (e.g. `custom-cart.liquid`) with the contents of `cart-embed-snippet.liquid`, then in their theme layout (e.g. `theme.liquid`) before `</body>` add: `{% render 'custom-cart' %}` (or the name you gave the snippet).
5. **Do not** enable “Cart Pro V3” (or any cart app embed) in Theme Editor for this store.

Optional: use a **separate Partner app** (same codebase, different app name) for this merchant so the app tile in their Apps list shows your custom name.
