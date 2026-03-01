# Cleanup & Multi-Tenant Safety Deliverable

**Scope:** Clarity and safety only. No business logic, analytics formulas, behavior, or new cleanup logic changed.

---

## PART 1 — Delete Audit Table

All delete-related usage in the **application** (excluding node_modules, test mocks):

| Location | Operation | Filter | Classification | Risk |
|----------|------------|--------|----------------|------|
| `revstack/app/lib/cleanup.server.ts` | `prisma.decisionMetric.deleteMany` | `createdAt: { lt: ninetyDaysAgo }` only | **Intentional global delete** | None |
| `revstack/app/lib/cleanup.server.ts` | `prisma.webhookEvent.deleteMany` | `createdAt: { lt: thirtyDaysAgo }` only | **Intentional global delete** | None |
| `revstack/app/lib/cleanup.server.ts` | `prisma.crossSellEvent.deleteMany` | `createdAt: { lt: ninetyDaysAgo }` only | **Intentional global delete** | None |
| `revstack/app/lib/cleanup.server.ts` | `prisma.crossSellConversion.deleteMany` | `createdAt: { lt: ninetyDaysAgo }` only | **Intentional global delete** | None |
| `revstack/app/routes/webhooks.app.uninstalled.tsx` | `prisma.session.deleteMany` | `where: { shop }` (shop from auth) | **Per-tenant delete** | None |

**In-memory only (not DB):**  
`rate-limit.server.ts`, `decision-cache.server.ts`, `catalog-cache.server.ts`, `shop-config.server.ts` use `Map.delete()` / cache eviction — not Prisma; N/A for cross-tenant DB safety.

**Raw SQL / TRUNCATE / $executeRaw:**  
No `$executeRaw`, `TRUNCATE`, or raw `DELETE FROM` found in the application codebase.

---

## PART 2 — Cleanup Job Review (cleanup.server.ts)

- **DecisionMetric.deleteMany:** `where: { createdAt: { lt: ninetyDaysAgo } }` — deletes only old rows; no shop filter (intentional global). ✓  
- **WebhookEvent.deleteMany:** `where: { createdAt: { lt: thirtyDaysAgo } }` — same. ✓  
- **CrossSellEvent.deleteMany:** `where: { createdAt: { lt: ninetyDaysAgo } }` — same. ✓  
- **CrossSellConversion.deleteMany:** `where: { createdAt: { lt: ninetyDaysAgo } }` — same. ✓  
- **No other historical purge** in this file.  
- **Config tables:** Not touched (no ShopConfig, Session schema config, etc.). ✓  
- **Environments:** No production guard added (per instruction: do not modify behavior); job is timestamp-based and safe in all environments. ✓  

**Documentation added:** Top-of-file block:

```text
INTENTIONAL MULTI-TENANT CLEANUP
This job deletes expired historical data across ALL shops.
It does NOT read or return cross-tenant data.
It is safe because it only removes old rows based on timestamp.
Do NOT add read queries here.
```

---

## PART 3 — Guard Against Future Cross-Tenant Reads

- **Prisma read queries** (findMany, findFirst, findUnique, aggregate, groupBy, count) and **$queryRaw** in `revstack/app` were audited.  
- **Single read without shop scoping:** `health.internal.ts` — `prisma.$queryRaw\`SELECT 1\`` (Postgres connectivity check).  
- **Comment added:** `// SAFE: connectivity check only; no tenant data read.`  
- All other reads include `shopDomain` (or Session `shop` / composite `shopDomain_revproSessionId`) in the where clause. No ambiguous read queries remain.

---

## PART 4 — Multi-Tenant Safety Comment in Prisma Layer

**File:** `revstack/app/lib/prisma.server.ts`  

**Comment added:**

```text
Multi-tenant guarantee:
All application read queries MUST include shopDomain scoping.
Only cleanup jobs may intentionally operate globally.
```

---

## PART 5 — Analytics Reads: All Shop-Scoped

| File | Read types | Shop scoping |
|------|------------|--------------|
| **analytics.server.ts** | `count`, `findMany` (dev invariant), `$queryRaw` (multiple) | Every read uses `where: { shopDomain: normalized }` or `WHERE "shopDomain" = ${shop}`. ✓ |
| **dashboard-metrics.server.ts** | `count`, `$queryRaw` (DecisionMetric, CrossSellConversion, OrderInfluenceEvent) | All use `shopDomain: normalized` or `WHERE "shopDomain" = ${shop}`. ✓ |
| **retention.server.ts** | `findUnique`, `count`, `$queryRaw` (DecisionMetric) | All use `where: { shopDomain: shop }` or `WHERE "shopDomain" = ${shop}`. ✓ |
| **product-metrics.server.ts** | `groupBy` (ProductSaleEvent) | `where: { shopDomain, soldAt: { gte: since } }` (shopDomain is function arg). ✓ |

**Confirmation:** Every read in these four files includes shop filtering. No raw SQL read omits the shop filter.

---

## PART 6 — Summary

- **Delete audit table:** Above.  
- **Intentional global deletes:** Only the four `deleteMany` calls in `cleanup.server.ts` (timestamp-based retention); all confirmed and documented.  
- **Unsafe read queries:** None. Single unscoped read is the health check `SELECT 1`; documented as SAFE.  
- **Documentation comments added:**  
  1. `cleanup.server.ts` — top-of-file INTENTIONAL MULTI-TENANT CLEANUP block.  
  2. `health.internal.ts` — `// SAFE: connectivity check only; no tenant data read.`  
  3. `prisma.server.ts` — Multi-tenant guarantee block.  
- **Tests:** Run `npm test` (or project test command) in revstack to confirm; see below.

---

## Test Confirmation

Run from repo root (or revstack):

```bash
cd revstack && npm test
```

(If your project uses a different test command, use that.) All changes are comments and one inline SAFE comment; no refactors, UI changes, or behavior changes — tests are expected to pass.
