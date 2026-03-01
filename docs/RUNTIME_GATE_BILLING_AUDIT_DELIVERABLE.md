# Runtime Gate & Billing Audit Deliverable

## PART 1 — Runtime Gate Audit (Decision Endpoint)

### Exact code path showing early return

**File:** `revstack/app/routes/cart.decision.ts`

1. **Order of operations (enforced):**
   - Method check → proxy/replay → parse & validate cart → memory cache lookup → Redis cache lookup → rate limit → **getShopConfig** → **getBillingContext(shop, config)** → **if (!billing.isEntitled) → return safeDecisionResponse(SAFE_UI_FALLBACK)** → (only when entitled) catalog fetch → lock → decision computation → cache set → **guarded** metric writes.

2. **Billing gate placement (lines ~384–408):**
   - `getBillingContext(shop, config)` is called **immediately after** `getShopConfig`, **before** any of:
     - Catalog fetch (`getCatalogIndexFromRedis`)
     - Decision computation (`decideCartActions`, `resolveStrategyCatalogFromIndex`)
     - Cross-sell logic (building `response.crossSell`)
     - Metric writes (`DecisionMetric`, `CrossSellEvent`)
     - Retention logic (none in this route; retention is in app/dashboard flows)

3. **Early return when not entitled:**
```ts
const billing = await getBillingContext(shop, config);
if (!billing.isEntitled) {
  usedSafeDecision = true;
  logResilience({ ... });
  logTiming();
  return data(safeDecisionResponse(SAFE_UI_FALLBACK), { headers: ... });
}
```
After this return, the handler does **not**: run the decision engine, fetch catalog, write `DecisionMetric`, write `CrossSellEvent`, write `CrossSellConversion`, or touch retention.

### Confirmation: no writes on unpaid path

- When `!billing.isEntitled` we return above before:
  - `getCatalogIndexFromRedis`
  - `tryLockDecision` / decision engine / `setCachedDecision`
  - Any `prisma.decisionMetric.create` or `prisma.crossSellEvent.create`
- Additionally, **PART 2** write guards ensure that even if logic were moved later, Prisma metric writes are only run when `billing.isEntitled` is true.

---

## PART 2 — Prevent Silent Metric Leakage

### Write guards (double-layer safety)

**Location:** `revstack/app/routes/cart.decision.ts` (around the DB write block)

- **Guard:** All Prisma metric writes are inside `if (billing.isEntitled) { ... }`:
  - `prisma.crossSellEvent.create` (per cross-sell impression)
  - `prisma.decisionMetric.create`
- So even if a future refactor moved the entitlement check or the write block, **no** `DecisionMetric` or `CrossSellEvent` is written when the shop is not entitled.

**Confirmation:** Write guards exist and wrap both CrossSellEvent and DecisionMetric writes.

---

## PART 3 — Billing State Transition Audit

### Sources

- **webhooks.billing.update.tsx:** Updates `shopConfig.billingStatus` from Shopify subscription webhooks.
- **billing-context.server.ts:** `getBillingContext(shop, existingConfig)` derives `isEntitled` and capabilities from `shopConfig.billingStatus` (and whitelist).

### State transition table (from code)

| State       | Set in webhook / DB        | isEntitled | Notes                          |
|------------|----------------------------|------------|--------------------------------|
| inactive   | default / not set          | no         | `billingStatus ?? "inactive"`  |
| active     | `ACTIVE` + subscriptionId  | yes        | Only status that grants entitlement |
| cancelled  | `CANCELLED` / `DECLINED` / `EXPIRED` | no  | Terminal statuses               |
| past_due   | `PAST_DUE` webhook         | no         | Treated same as non-active     |
| whitelist  | N/A (env PAYWALL_WHITELIST) | yes        | Override: shop in list → entitled (dev) |

- **Entitlement rule:** `isEntitled = (billingStatus === "active") || isWhitelisted(shop)`.
- No other state grants entitlement; no capability bleed. Logic uses the single source of truth `getBillingContext`; routes do not rely on raw `config.billingStatus` / `config.plan` for gating (only `billing-context.server` and `preview-simulator` read plan; preview is internal).

### Confirmation

- No state mismatch: only `active` and whitelist yield `isEntitled === true`.
- No logic depends on raw string comparisons in routes; all use `getBillingContext().isEntitled` / `billing.capabilities`.
- No capability bleed: capabilities are derived from plan/entitlement in `billing-context.server` and `capabilities.server`.

---

## PART 4 — Structured Billing Logs

### Implementation

In the decision endpoint, **per request**:

1. **Early return (not entitled):**  
   `logResilience({ shop, requestId, route: "cart.decision", message: "Decision request: not entitled, returning safe fallback", meta: { billingState: billing.billingStatus, isEntitled: false, decisionExecuted: false, fallbackUsed: true } })`

2. **Normal completion (after building response):**  
   `logResilience({ shop, requestId, route: "cart.decision", message: "Decision request end", meta: { billingState: billing.billingStatus, isEntitled: billing.isEntitled, decisionExecuted: !usedSafeDecision, fallbackUsed: usedSafeDecision } })`

- **billingState** = `billing.billingStatus`
- **decisionExecuted** = whether a real decision was run (not fallback)
- **fallbackUsed** = whether the response was the safe fallback
- Logs do not include tokens or sensitive data.

**Confirmation:** Logging added for both the unpaid early-return path and the normal completion path.

---

## PART 5 — Billing Transition Tests

### Tests added

- **cart.decision.integration.test.ts**
  - **Test 6:** Unpaid shop (`billingStatus: "inactive"`) → 200, safe fallback shape, **no** `DecisionMetric` or `CrossSellEvent` writes.
  - **Test 7:** Canceled subscription (`billingStatus: "cancelled"`) → 200, safe fallback, **no** metric writes.

- **cart.decision.billing.test.ts**
  - **Test 1:** Paid shop (`billingStatus: "active"`) → real decision, **DecisionMetric** written.
  - **Test 4:** Dev whitelist (shop in `PAYWALL_WHITELIST`, `billingStatus` inactive) → **isEntitled** true, decision runs, **DecisionMetric** written.

Test 3 (cancel transition) is covered by Test 7: when status is `cancelled`, the next decision call returns fallback and no metrics.

**Confirmation:** Test results pass (run: `npm test -- --run tests/cart.decision.billing.test.ts tests/cart.decision.integration.test.ts`).

---

## PART 6 — Revenue Leak Prevention Check

### Findings

- **Layout billing gate runs before onboarding:**  
  In `app.tsx` loader: `getBillingContext` → then **if (!billing.isEntitled && !pathMatches(pathname, BILLING_EXEMPT_PATHS))** → redirect to `/app/billing`. Onboarding gate runs **after** the billing gate. So unpaid users cannot reach dashboard/onboarding without being redirected to billing first.

- **No direct route bypass:**  
  Child routes (`app._index`, `app.analytics`, `app.settings`, etc.) are under the same layout. Their loaders run **after** the layout loader; the layout already redirects when `!billing.isEntitled` (except exempt paths). So there is no direct route that exposes premium data without the layout billing check.

- **Feature gating:**  
  All premium/analytics surfaces use `getBillingContext` and either:
  - Rely on layout redirect (so unpaid never reach the route), or
  - Use `billing.capabilities` / `billing.isEntitled` for data (e.g. `getDashboardMetrics(shop, billing.capabilities)`, `getAnalyticsMetrics(shop, billing.capabilities)`).

- **No raw config gating in routes:**  
  No route uses `config.billingStatus` or `config.plan` directly for access control; only `billing-context.server` and internal preview code use plan. No analytics surface exposes paid metrics without going through the layout (which enforces entitlement).

**Confirmation:** No revenue leak paths identified; layout billing gate runs first, no bypass, and premium data is gated by `billing.isEntitled` / capabilities.
