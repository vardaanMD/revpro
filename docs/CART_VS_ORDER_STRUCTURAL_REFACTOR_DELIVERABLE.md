# Cart vs Order Structural Separation Refactor — Deliverable

## Summary

Structural and labeling refactor only. No changes to analytics formulas, billing logic, DB schema, tenant isolation, Redis logic, or decision engine logic.

---

## 1. Files Modified

| File | Changes |
|------|--------|
| `revstack/app/routes/app._index.tsx` | Overview restructure: Order Outcomes (top), Cart Metrics (below); renamed labels; conditional “Impact analysis begins after 30 paid orders”; contextLabel for timeline. |
| `revstack/app/routes/app.analytics.tsx` | Two tabs (Cart View, Order View); Cart View = cart metrics + 7/30-day trend; Order View = order outcomes only; renamed labels; contextLabel; impact message when &lt; 30 paid orders. |
| `revstack/app/components/ui/StatCard.tsx` | Optional `contextLabel` prop for micro-label above value (“At Evaluation” / “Paid Orders Only”). |
| `revstack/app/components/ui/StatCard.module.css` | `.contextLabel` style (small, muted, uppercase). |
| `revstack/app/styles/dashboardIndex.module.css` | `.sectionOrderOutcomes`, `.sectionCartMetrics`, `.sectionHeader`, `.sectionSubtext`, `.divider` for visual separation. |
| `revstack/app/styles/analyticsPage.module.css` | `.tabBar`, `.tab`, `.tabActive`, `.tabPanel`, `.tabPanelHidden`, `.sectionSubtext` for Analytics tabs and section subtext. |

**Total: 6 files modified.**

---

## 2. Before / After Section Structure

### Overview Page (`/app`)

**Before**

- Momentum (7-day performance, order impact, days active)
- Cart Performance (Decisions taken, Adds per session, Avg cart value, Total cart value evaluated)
- Order Impact (Last 7 Days) — AOV lift, AOV with/without, Orders with recommendations
- 7 Day Trend table
- Current Plan

**After**

1. **Order Outcomes (Paid Orders Only)** — primary, at top  
   - Subtext: “These metrics reflect completed and paid orders.”  
   - Metrics: Observed AOV difference (when ≥30 paid orders), AOV (paid orders with exposure), AOV (paid orders without exposure), Orders with recommendation exposure.  
   - When sample &lt; 30 paid orders: show “Impact analysis begins after 30 paid orders.” and hide lift (logic unchanged, lift only conditionally hidden).

2. **Divider**

3. **Cart Metrics (At Evaluation)**  
   - Subtext: “These metrics reflect cart state at the moment the engine evaluated the cart. They are not revenue figures.”  
   - Metrics: Unique carts evaluated, Decisions taken, Recommendation show rate, Adds per recommendation session, Avg cart value (at evaluation), Total cart value processed (at evaluation).

4. Momentum (unchanged)

5. 7 Day Trend table (unchanged)

6. Current Plan (unchanged)

### Analytics Page (`/app/analytics`)

**Before**

- Single flow: Last 7 Days → 30 Day Summary (Cart Performance) → Compared to previous 30 days → Order Impact (Last 7 Days).

**After**

- **Tab bar:** “Cart View” | “Order View”.

- **Cart View tab**  
  - Header: “Cart Metrics (At Evaluation)”.  
  - Metrics: Total decisions, Unique carts evaluated, Recommendation show rate, Adds per recommendation session, Avg cart value (at evaluation), Total cart value processed (at evaluation).  
  - 7-day / 30-day trend (decisions + adds per session).  
  - Compared to previous 30 days (cart-only).  
  - No revenue or paid-order metrics.

- **Order View tab**  
  - Header: “Order Outcomes (Paid Orders Only)”.  
  - Metrics: Observed AOV difference (when ≥30), AOV (paid orders with exposure), AOV (paid orders without exposure), Orders with recommendation exposure.  
  - When &lt; 30 paid orders: “Impact analysis begins after 30 paid orders.”  
  - No cart-time metrics.

---

## 3. Renamed Labels (Overview + Analytics)

| Previous | After |
|----------|--------|
| Total cart value evaluated | Total cart value processed (at evaluation) |
| Avg cart value (decision time) | Avg cart value (at evaluation) |
| AOV with recommendations | AOV (paid orders with exposure) |
| AOV without recommendations | AOV (paid orders without exposure) |
| Observed AOV Lift (%) | Observed AOV difference |
| Orders with recommendations | Orders with recommendation exposure |
| Adds per Recommendation Session | Adds per recommendation session (lowercase “p”) |
| Show Rate | Recommendation show rate (in Cart section) |

Tooltips/helper text updated to match; no changes to underlying calculations.

---

## 4. Timeline Clarification (PART 3)

- **Cart metrics:** Each currency/numeric cart metric uses `contextLabel="At Evaluation"` (small, muted above value).
- **Order metrics:** Each order outcome metric uses `contextLabel="Paid Orders Only"`.
- Implemented in `StatCard` via optional `contextLabel` and `.contextLabel` CSS.

---

## 5. Emotional / Wording (PART 4)

- Cart copy states they are “not revenue figures” and reflect “cart state at the moment the engine evaluated the cart.”
- No use of “generated,” “earned,” or “produced” for cart metrics.
- Neutral wording used: “processed,” “evaluated,” “observed.”

---

## 6. Confirmation: No Logic or API Changes

- **Calculations:** Unchanged. Same `cp.*`, `orderImpact.*`, loader data, and formulas.
- **APIs:** No new endpoints; no request/response shape changes.
- **DB / Redis / Billing / Tenant isolation / Decision engine:** Not modified.
- **Order-impact logic:** `ORDER_IMPACT_MIN_SAMPLES = 30` and stage “early” vs “full” unchanged; only the **display** of lift is conditional (hidden when stage is “early”), with the message “Impact analysis begins after 30 paid orders.”

---

## 7. Tests

- `revstack/tests/analytics.math.test.ts` — 14 tests passed.
- `revstack/tests/analytics.gating.test.ts` — 6 tests passed.

---

## 8. Screenshot-Ready Layout Hierarchy

**Overview**

1. **Order Outcomes (Paid Orders Only)**  
   - One block; subtle border/background.  
   - Subtext: “These metrics reflect completed and paid orders.”  
   - Cards: Observed AOV difference (if ≥30 paid orders), AOV (paid orders with exposure), AOV (paid orders without exposure), Orders with recommendation exposure.  
   - If &lt; 30 paid orders: text “Impact analysis begins after 30 paid orders.” and no lift card.

2. **Horizontal divider**

3. **Cart Metrics (At Evaluation)**  
   - Different subtle background.  
   - Subtext: “These metrics reflect cart state at the moment the engine evaluated the cart. They are not revenue figures.”  
   - Cards: Unique carts evaluated, Decisions taken, Recommendation show rate, Adds per recommendation session, Avg cart value (at evaluation), Total cart value processed (at evaluation).  
   - Each card: small “At Evaluation” above the value where applicable.

4. Momentum → 7 Day Trend → Current Plan (unchanged).

**Analytics**

- Tabs: **Cart View** (default) | **Order View**.
- **Cart View:** “Cart Metrics (At Evaluation)” block → 7/30-day trend → comparison table (cart only).
- **Order View:** “Order Outcomes (Paid Orders Only)” block only; “Impact analysis begins after 30 paid orders.” when applicable.

Icons used in overview section headers: Order Outcomes, Cart Metrics (emojis in section titles for clarity only).
