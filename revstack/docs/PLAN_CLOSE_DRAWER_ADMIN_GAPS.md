# Plan: Close Drawer–Admin Gaps

This document outlines the work to close the two gaps identified in the Drawer ↔ Admin connectivity audit (COMPLETE_REVPRO_AUDIT.md §1.4.1).

**Status: Implemented.** Both gaps have been addressed (see "Implementation summary" at the end).

---

## Gap 1: Order Impact for V3 (session linking + click recording)

**Problem:** Order Impact in the admin (avg order value with/without exposure, influenced orders, lift %) is driven by `OrderInfluenceEvent`, which is created in the orders/paid webhook. That webhook requires:
- Order `note_attributes` to include `revpro_session_id`
- `RevproClickSession` to exist for that session with `clickedProductIds` (product IDs the user clicked from recommendations)

The V3 runtime does not set `revpro_session_id` on the cart or record recommendation clicks to `RevproClickSession`.

**Solution:**

1. **Persist and set `revpro_session_id` on the cart**
   - Add `updateCartAttributes(attrs)` to the Cart API (POST `/cart/update.js` with `{ attributes: { revpro_session_id: "<uuid>" } }`).
   - In the Engine, maintain a stable session ID that survives page reloads (e.g. `localStorage` key `revpro_session_id`; generate UUID once per browser session).
   - After the first successful cart fetch (or when the drawer opens with a non-empty cart), call `updateCartAttributes({ revpro_session_id: sessionId })` once per session so the attribute is on the cart and flows to checkout/order.

2. **Record recommendation clicks for RevproClickSession**
   - Extend analytics v3 to handle a new event type (e.g. `recommendation:click`) with payload `{ productId: string, recommendedProductIds: string[] }`. Use the existing event `sessionId` as `revproSessionId`. Backend upserts `RevproClickSession` (append `productId` to `clickedProductIds`, set `recommendedProductIds`).
   - Ensure recommendations carry `productId` where possible: add optional `productId` to `SnapshotRecommendationItem` and have the decision/snapshot response include product id so the storefront can send it when the user adds from a recommendation.
   - When the user adds to cart from a recommendation (existing `upsell:add` path), also emit `recommendation:click` (or send the same data in a single batched event) so the backend can update `RevproClickSession`.

**Files to touch:**
- `cart-pro-v3-runtime/src/engine/cartApi.ts` — add `updateCartAttributes`.
- `cart-pro-v3-runtime/src/engine/Engine.ts` — get/create persistent `revpro_session_id`, call `updateCartAttributes` after cart load; emit/send `recommendation:click` when adding from recommendation (with `productId` + `recommendedProductIds`).
- `cart-pro-v3-runtime/src/engine/state.ts` (and config/types) — add optional `productId` to `SnapshotRecommendationItem`.
- `cart-pro-v3-runtime/src/engine/decisionApi.ts` — map `productId` from decision response into `SnapshotRecommendationItem`.
- `app/routes/cart.analytics.v3.ts` — handle `recommendation:click`: upsert `RevproClickSession` (sessionId → revproSessionId, append productId to clickedProductIds, set recommendedProductIds).
- Snapshot/buildSnapshot if recommendations include product id — ensure snapshot v3 recommendations include `productId` when available.

---

## Gap 2: Decision double-count (DecisionMetric written twice per drawer open)

**Problem:** Both the decision route (`cart.decision.ts`) and the analytics v3 pipeline (`cart:evaluated`) write to `DecisionMetric`. For V3, when the drawer opens the engine both calls the decision API and sends `cart:evaluated`, so “decisions” can be counted twice.

**Solution:**
- Have the V3 storefront send a header (e.g. `X-Cart-Pro-Runtime: v3`) on POST `/apps/cart-pro/decision`.
- In `cart.decision.ts`, when that header is present, skip the fire-and-forget `DecisionMetric.create` so only analytics v3’s `cart:evaluated` event writes the metric. V1/V2 continue to get `DecisionMetric` from the decision route.

**Files to touch:**
- `cart-pro-v3-runtime/src/engine/decisionApi.ts` — add header `X-Cart-Pro-Runtime: v3` to the decision request.
- `app/routes/cart.decision.ts` — read `X-Cart-Pro-Runtime` (or similar); if value is `v3`, skip creating `DecisionMetric`.

---

## Implementation order

1. **Gap 2 (double-count)** — Small, isolated change; unblocks accurate “decisions” in admin for V3.
2. **Gap 1 (Order Impact)** — Cart attribute + click recording + backend handling for `recommendation:click` and optional `productId` on recommendations.

---

## Testing

- **Gap 2:** With V3 runtime, open drawer and trigger a decision; confirm only one new row in `DecisionMetric` for that shop/time. With V2 (or no header), confirm `DecisionMetric` is still created by the decision route.
- **Gap 1:** Set up a test shop with V3; open drawer, add a recommended product, complete checkout with an order that has `revpro_session_id` in note_attributes. Confirm `OrderInfluenceEvent` is created with `influenced: true` and that the admin Order Impact section shows the order as influenced.

---

## Implementation summary

- **Gap 2 (double-count):** `decisionApi.ts` sends header `X-Cart-Pro-Runtime: v3` on decision requests. `cart.decision.ts` skips creating `DecisionMetric` when that header is present so only analytics v3’s `cart:evaluated` writes the metric for V3.
- **Gap 1 (Order Impact):**
  - **Cart attribute:** `cartApi.ts` has `updateCartAttributes()`. Engine uses `getOrCreateRevproSessionId()` (localStorage `revpro_session_id`) and calls `ensureCartHasRevproSessionId(raw)` after `syncCart` so the cart gets `revpro_session_id` and it flows to checkout/order.
  - **Session ID:** Engine init uses `getOrCreateRevproSessionId()` (with fallback to `createSessionId()`) as the analytics `sessionId` so the same id is used on the cart and in events.
  - **Clicks:** `SnapshotRecommendationItem` has optional `productId`; `decisionApi.ts` maps it from the decision response. When the user adds from a recommendation (including from `snapshotRecommendations`), Engine emits `recommendation:click` with `{ productId, recommendedProductIds }`. `cart.analytics.v3.ts` handles `recommendation:click` and upserts `RevproClickSession` (append `productId` to `clickedProductIds`, set `recommendedProductIds`). Orders/paid webhook already uses `revpro_session_id` + `RevproClickSession` to set `OrderInfluenceEvent.influenced`.
