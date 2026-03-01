# Cart Pro V3 — Extension forensic & correction

## PART 1 — Confirm extension asset is updated locally ✅ DONE

- **File edited:** `revstack/extensions/cart-pro/assets/cart-pro-v3.js`
- **Change:** At the very top, inserted:
  ```javascript
  console.log("CartPro V3 Runtime BUILD ID:", "BUILD_" + Date.now());
  ```
- **Do NOT rebuild yet.**

**Your steps:**
1. Refresh the storefront (normal refresh).
2. Open DevTools → Console.
3. Check whether this log appears: `CartPro V3 Runtime BUILD ID: BUILD_<timestamp>`

**Result to report:**  
- If the log **appears** → Shopify is loading this extension’s asset (possibly cached).  
- If the log **does not appear** → The storefront is loading a different extension instance or a cached bundle from another extension ID.

---

## PART 2 — Identify actual extension ID serving runtime

Run this in the **browser console** (storefront page):

```javascript
[...document.querySelectorAll('script')]
  .map(s => s.src)
  .filter(src => src.includes('cart-pro-v3.js'))
```

**Report:** The full URL(s) printed. Example:

`https://cdn.shopify.com/extensions/<EXTENSION-ID>/assets/cart-pro-v3.js`

We need the exact **EXTENSION-ID** from that URL.

---

## PART 3 — Match extension ID to local extension folder ✅ DOCUMENTED

Extension configs in the repo:

| Location | name / handle | uid (from shopify.extension.toml) |
|----------|----------------|-----------------------------------|
| **revstack/extensions/cart-pro/** | name = "Cart-Pro-V3", handle = "cart-pro" | `78916742-bb96-07f4-7747-0dab65451c23ea5d865f` |
| revstack/archived-extensions/cart-pro-v1-v2/ | name = "Cart-Pro" | `d6a2a04c-6542-dccc-6276-c0982eb49bc75074bbfa` |

- The **active** extension you want the storefront to use is: **`revstack/extensions/cart-pro/`** (handle `cart-pro`, uid `78916742-bb96-07f4-7747-0dab65451c23ea5d865f`).
- CDN URLs often use a **numeric** extension ID. Compare the ID from Part 2 with the one shown in Shopify Admin (Settings → Apps and sales channels → [your app] → Extensions) to confirm which extension is actually serving `cart-pro-v3.js`.

---

## PART 4 — Force extension asset replacement

1. Run:
   ```bash
   shopify app dev
   ```
2. Wait until the extension is **rebuilt and pushed** (watch terminal output).
3. **Hard refresh** the storefront:
   - **Mac:** `Cmd + Shift + R`
   - Or: DevTools → Network → enable **Disable cache**, then refresh.

---

## PART 5 — Verify runtime is correct

In the **browser console** after Part 4:

```javascript
// 1) Engine present
window.CartProV3Engine !== undefined

// 2) Shadow root present
document.querySelector('#revstack-v3-root')?.shadowRoot

// 3) BUILD_ID log
// In Console tab, confirm you see: CartPro V3 Runtime BUILD ID: BUILD_<timestamp>
```

- If all three are true, the storefront is running the updated runtime from `revstack/extensions/cart-pro/assets/cart-pro-v3.js`.

---

## Goal

Ensure the storefront executes the updated runtime from **revstack/extensions/cart-pro/assets/cart-pro-v3.js** and not a stale cached extension bundle (or a different extension).
