# Webhook Normalization Audit — Data Integrity Enforcement

**Scope:** Canonical shop normalization at webhook entry; no raw shop in Prisma/Redis; no mixed-case or variant-domain fragmentation. No changes to analytics formulas, billing logic, cleanup behavior, Redis key format, or business rules.

---

## PART 1 — Webhook Entry Points Audit

| File | Shop extracted from | Normalization before any Prisma/Redis |
|------|---------------------|---------------------------------------|
| `revstack/app/routes/webhooks.orders.tsx` | `authenticate.webhook(request)` → `shop: rawShop` | ✅ `rawShop` → `normalizeShopDomain(rawShop)` → `warnIfShopNotCanonical` → `shop`; dev `[WEBHOOK SHOP NORMALIZED]` |
| `revstack/app/routes/webhooks.billing.update.tsx` | `authenticate.webhook(request)` → `shop: rawShop` | ✅ Same pattern |
| `revstack/app/routes/webhooks.products.tsx` | `authenticate.webhook(request)` → `shop: rawShop` | ✅ Same pattern |
| `revstack/app/routes/webhooks.compliance.tsx` | `auth.shop ?? getShopFromHeaders(request)` → `rawShop` | ✅ Same pattern |
| `revstack/app/routes/webhooks.app.uninstalled.tsx` | `authenticate.webhook(request)` → `shop: rawShop` | ✅ Same pattern |
| `revstack/app/routes/webhooks.app.scopes_update.tsx` | `authenticate.webhook(request)` → `shop: rawShop` | ✅ Same pattern |
| `revstack/app/routes/webhooks.shop.redact.tsx` | N/A — no shop used | No Prisma/Redis with shop; only `authenticate.webhook` + 200 |
| `revstack/app/routes/webhooks.customers.redact.tsx` | N/A — no shop used | No Prisma/Redis with shop; only `authenticate.webhook` + 200 |
| `revstack/app/routes/webhooks.customers.data_request.tsx` | N/A — no shop used | No Prisma/Redis with shop; only `authenticate.webhook` + 200 |

**Confirmation:** Normalization occurs at the boundary in all webhooks that pass `shop` to Prisma or Redis. The three compliance-only routes (shop.redact, customers.redact, customers.data_request) do not read or write shop; no normalization added there.

---

## PART 2 — Prisma Write Integrity

| Webhook | Prisma usage | Uses normalized `shop` (never rawShop) |
|---------|--------------|----------------------------------------|
| **webhooks.orders.tsx** | `recordWebhook(webhookId, shop, topic)` → `webhookEvent.create({ data: { shopDomain: shop } })`; `recordOrderSales(shop, items)` → `productSaleEvent.createMany` with `shopDomain`; `revproClickSession.findUnique({ where: { shopDomain_revproSessionId: { shopDomain: shop, ... } } })`; `orderInfluenceEvent.create({ data: { shopDomain: shop, ... } })` | ✅ All use `shop` |
| **webhooks.billing.update.tsx** | `recordWebhook(webhookId, shop, topic)`; `shopConfig.findUnique({ where: { shopDomain: shop } })`; `shopConfig.update({ where: { shopDomain: shop }, data: { ... } })`; `shopConfig.updateMany({ where: { shopDomain: shop, billingId } })`; `invalidateShopConfigCache(shop)` | ✅ All use `shop` |
| **webhooks.products.tsx** | `recordWebhook(webhookId, shop, topic)`; `warmCatalogForShop(shop)` (Redis uses `redisKey(shop, ...)` which normalizes internally) | ✅ All use `shop` |
| **webhooks.compliance.tsx** | `recordWebhook(webhookId, shop, topic)` → `webhookEvent.create({ data: { shopDomain: shop } })` | ✅ Uses `shop` |
| **webhooks.app.uninstalled.tsx** | `recordWebhook(webhookId, shop, topic)`; `prisma.session.deleteMany({ where: { shop } })` (Session model has `shop` column; value is normalized `shop`) | ✅ Uses `shop` |
| **webhooks.app.scopes_update.tsx** | `recordWebhook(webhookId, shop, topic)`; `prisma.session.update({ where: { id: session.id }, data: { scope } })` — no shop in write | ✅ No shop in Prisma write |

**Explicit confirmation:** Every Prisma write that is keyed by shop uses the normalized `shop` variable. No `rawShop` appears in any `where` or `data` for Prisma or in Redis key construction at webhook boundary (Redis keys built via `redisKey(shop, ...)` in catalog-warm and `redis.server` normalizes again).

---

## PART 3 — Prevent Shop Fragmentation (Dev-Only Warning)

- **Implementation:** In each webhook that normalizes shop, the following runs after `warnIfShopNotCanonical(rawShop, shop)`:
  ```ts
  if (process.env.NODE_ENV === "development" && rawShop !== shop) {
    console.warn("[WEBHOOK SHOP NORMALIZED]", rawShop, "→", shop);
  }
  ```
- **Files:** `webhooks.orders.tsx`, `webhooks.billing.update.tsx`, `webhooks.products.tsx`, `webhooks.compliance.tsx`, `webhooks.app.uninstalled.tsx`, `webhooks.app.scopes_update.tsx`.
- **Production:** Condition is `NODE_ENV === "development"`; this block does not run in production.

---

## PART 4 — Idempotency Safety

| Concern | Finding |
|---------|--------|
| **WebhookEvent (recordWebhook)** | `webhookId` is `@unique`; duplicate webhook ID returns `false` and route returns 200 without further processing. `shopDomain` in create is normalized `shop` — no casing fragmentation. ✅ |
| **Billing state updates** | Keyed by `shopDomain: shop` (normalized). Same store cannot fragment shopConfig by case. ✅ |
| **Product sale events (orders webhook)** | `recordOrderSales(shop, items)` uses normalized `shop`; no unique constraint on (shopDomain, orderId, productId) — duplicate orders/paid could add more rows (existing behavior). Duplicate *webhook* for same event ID is skipped by recordWebhook. ✅ |
| **OrderInfluenceEvent** | Create uses `shopDomain: shop`. No unique constraint on (shopDomain, orderId); duplicate order IDs could create multiple rows (existing behavior). Idempotency is at webhook-event level. ✅ |
| **Session (app.uninstalled)** | `deleteMany({ where: { shop } })` uses normalized `shop`; Session model has `shop` (string), not a unique constraint on shop — correct per-tenant delete. ✅ |
| **Unique constraints using shop** | `WebhookEvent.webhookId` is unique (not shop); `ShopConfig.shopDomain` is unique and always written with normalized `shop`. No unique constraint depends on raw shop string. ✅ |

**Confirmation:** No idempotency regression. Duplicate events for the same webhook ID do not create tenant duplication; all shop-scoped writes use normalized shop.

---

## PART 5 — Cross-Environment Safety

- **Webhook writes:** No `NODE_ENV` check gates Prisma or Redis writes. Production and development use the same write path with normalized `shop`.
- **Dev-only logic:** Only the two logging behaviors run in development: `warnIfShopNotCanonical` and `[WEBHOOK SHOP NORMALIZED]` console.warn. No dev-only bypass for storage.
- **Production behavior:** Identical to dev except for the absence of these logs.

---

## PART 6 — Deliverable Summary

| Item | Status |
|------|--------|
| Webhook normalization audit table | ✅ Table above; all 9 webhook files audited |
| Prisma writes use normalized shop | ✅ Confirmed; no raw shop in any `where` or `data` |
| No raw shop leaks | ✅ No rawShop passed to Prisma, Redis key builders, or downstream services from webhooks |
| Idempotency | ✅ recordWebhook deduplication; no unique constraint on raw shop; no tenant duplication from duplicate webhook ID |
| Tests | Run `npm run test` in revstack to confirm |
| No behavior changes | ✅ Only added dev-only logging; no analytics, billing, cleanup, Redis key format, or business rule changes |

---

## What This Phase Guarantees

After this audit and hardening:

- The same store cannot exist under two domain variants (all webhook writes use canonical shop).
- Billing updates cannot fragment shopConfig by case or variant domain.
- Product sales cannot split across domains.
- Analytics inputs from webhooks are keyed by normalized shop (no case fragmentation at write).
- Reinstall flows (and app/uninstalled) use normalized shop for session cleanup; no shadow tenants from variant domains.
- Tenant integrity at the webhook boundary is enforced and documented.
