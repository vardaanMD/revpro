# DEPRECATED — V1/V2 routes (no longer active)

These route files are **archived** and **not mounted** by the app. They served the legacy cart drawer runtimes (v1/v2) and the legacy analytics event endpoint.

- **cart.bootstrap.ts** — `/apps/cart-pro/bootstrap` (v1 bootstrap)
- **cart.bootstrap.v2.ts** — `/apps/cart-pro/bootstrap/v2` (v2 bootstrap)
- **cart.snapshot.v2.ts** — `/apps/cart-pro/snapshot/v2` (v2 snapshot)
- **cart.analytics.event.ts** — legacy analytics event (impression/click); storefront now uses `cart.analytics.v3.ts`

The storefront extension and app use **V3 only** (snapshot `/apps/cart-pro/snapshot/v3`, analytics `/apps/cart-pro/analytics/v3`). These files are kept for reference only.
