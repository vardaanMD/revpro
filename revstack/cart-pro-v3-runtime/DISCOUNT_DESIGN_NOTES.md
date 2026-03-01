# Cart Pro V3 — Discount engine design notes

Documented pressure points for Phase 4 discount core. Address in later phases (stacking, auto-apply, freebies, Phase 5 optimizations).

---

## 1. Reapply loop risk

**Current flow (correct):**

- `syncCart()` → if not `fromReapply` and `discount.applied.length > 0` → enqueue `reapplyDiscounts()`
- `reapplyDiscounts()` → revalidate each code → `syncCart({ fromReapply: true })` (no re-enqueue)

So we avoid an infinite reapply loop.

**Pressure point:** If the backend already applies the discount during validation (POST /discounts/{code}), then we:

1. Revalidate (backend may re-apply)
2. Call `syncCart()`

That can mean **syncing twice** on every cart mutation. Not wrong, but inefficient. When stacking + auto-apply + freebies are added, this path must be optimized (e.g. single sync, or skip reapply when backend is authoritative).

---

## 2. Duplicate sync per mutation

**Example sequence:**

1. User changes quantity
2. Interceptor emits `cart:external-update`
3. Engine runs `syncCart()` (first sync)
4. Reapply enqueued → `reapplyDiscounts()` runs
5. `syncCart({ fromReapply: true })` (second sync)

So we can get **2 syncs per cart mutation**. Safe, slightly heavy. Optimize in Phase 5 (e.g. coalesce external-update + reapply into one sync, or debounce).

---

## 3. Discount state vs Shopify reality

- **Current:** `discount.applied` is **local truth** only. We never read back what Shopify actually has on the cart.
- **Risk:** Shopify can reject or drop a code silently (expired, condition not met, etc.). Our UI would still show the code as applied.
- **Future:** Reconcile with `cart.cart_level_discount_applications` (or equivalent in cart payload), and remove from `discount.applied` any code that no longer exists on the cart.

---

*Phase 4 — core only. No auto-apply, stacking conflict resolution, free gift, or analytics.*

---

## Phase 5 (implemented)

- **One-click offers:** `setOneClickOffer(offerConfig)` with types `exact` | `min` | `max`; optional `autoApply`, `candidateCodes` (min), `maxSavingsCents` (max).
- **Stacking:** `discount.stacking.allowStacking`; when false, apply clears existing codes before applying; duplicate code is skipped.
- **Debounced revalidation:** `triggerRevalidation()` debounced 800ms after each sync; invalid codes are removed from state and cart, then one sync with `fromReapply: true` (no re-enqueue of reapply → no loop).
- **Cart reconciliation:** After every `syncCart()`, `reconcileCartDiscountState(raw)` keeps `discount.applied` in sync with `cart.raw` discount codes / cart_level_discount_applications.
- All discount operations run via effect queue. No free gift or analytics.
