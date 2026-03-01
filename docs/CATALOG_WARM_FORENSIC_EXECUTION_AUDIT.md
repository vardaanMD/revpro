# Catalog Warming Forensic Execution Audit — Cart Pro V3

**Purpose:** Prove execution path of `warmCatalogForShop` with code-level certainty. No assumptions.

---

## STEP 1 — warmCatalogForShop definition

**File:** `revstack/app/lib/catalog-warm.server.ts`

**Imports used by warmCatalogForShop:**
- `Product` from `@revpro/decision-engine`
- `getRedis`, `redisKey` from `~/lib/redis.server`
- `getCatalogForShop` from `~/lib/catalog.server`
- `shopify` from `~/shopify.server`
- `logWarn`, `logResilience` from `~/lib/logger.server`
- `prisma` from `~/lib/prisma.server`

**Function signature (confirmed):**
```ts
export async function warmCatalogForShop(shop: string): Promise<Product[]>
```

**Full function logic (summary):**
1. **Trace log:** `[CATALOG WARM TRACE] warmCatalogForShop ENTER` + shop
2. **Early return:** If `isCatalogCircuitOpen(shop)` → return `[]`
3. **try block:**
   - `admin = await shopify.unauthenticated.admin(shop)`
   - `auth = admin?.admin ?? null`
   - **Trace:** `[CATALOG WARM TRACE] admin client created`
   - **Early return:** If `!auth` → return `[]`
   - `products = await getCatalogForShop(auth, shop, "USD")`
   - **Trace:** `[CATALOG WARM TRACE] products fetched:` + products.length
4. **catch:** `recordCatalogFailure(shop)`, then `throw err`
5. **After try:** `recordCatalogSuccess(shop)`
6. **Trace:** `[CATALOG WARM TRACE] starting upserts`
7. **Loop:** For each product, `prisma.shopProduct.upsert(...)`
8. **Verify:** `verifyCount = await prisma.shopProduct.count({ where: { shopDomain: shop } })`
9. **Trace:** `[CATALOG WARM TRACE] DB count after warm:` + verifyCount
10. **Redis:** set catalog + catalog_index (in try/catch; on failure only logs, does not throw)
11. **Return** `products`

**Conditions that prevent full execution:**
- Circuit open → return `[]` (no DB/Redis write)
- `shopify.unauthenticated.admin(shop)` returns null or no `admin` → return `[]`
- Any throw in try (e.g. getCatalogForShop or admin creation) → propagates; no upserts

---

## STEP 2 — Snapshot route and warm call

**File:** `revstack/app/routes/cart.snapshot.v3.ts`

**Confirmed:**
- `warmCatalogForShop` is imported from `~/lib/catalog-warm.server`
- `prisma` is imported from `~/lib/prisma.server`
- Inside the loader (request handler), after `authenticate.public.appProxy(request)` and shop resolution:
  - `const count = await prisma.shopProduct.count({ where: { shopDomain: shop } });`
  - `console.log("[CATALOG WARM TRACE] count before warm:", count);`
  - `if (count === 0) { console.log("[CATALOG WARM TRACE] calling warmCatalogForShop"); await warmCatalogForShop(shop); }`
- Code is on the main path (not inside an unreachable branch). Only skipped when `count !== 0`.

**Exact code block (current):**
```ts
const count = await prisma.shopProduct.count({
  where: { shopDomain: shop },
});
console.log("[CATALOG WARM TRACE] count before warm:", count);
if (count === 0) {
  console.log("[CATALOG WARM TRACE] calling warmCatalogForShop");
  await warmCatalogForShop(shop);
}
```

---

## STEP 3 — Shop value log

**Added:** Immediately after `shop = normalizeShopDomain(shopRaw)`:
```ts
console.log("[CATALOG WARM TRACE] shop:", shop);
```
So the resolved shop is logged before any early return (e.g. missing/invalid shop).

---

## STEP 4 — warmCatalogForShop internal trace points

**Added at these positions:**
- **TOP:** `console.log("[CATALOG WARM TRACE] warmCatalogForShop ENTER", shop);`
- **After admin client creation:** `console.log("[CATALOG WARM TRACE] admin client created");` (before `if (!auth) return [];`)
- **After getCatalogForShop:** `console.log("[CATALOG WARM TRACE] products fetched:", products.length);`
- **Before upsert loop:** `console.log("[CATALOG WARM TRACE] starting upserts");`
- **After upserts:** `verifyCount = await prisma.shopProduct.count(...)` and `console.log("[CATALOG WARM TRACE] DB count after warm:", verifyCount);`

---

## STEP 5 — getCatalogForShop trace

**File:** `revstack/app/lib/catalog.server.ts`

**Added:**
- At function entry: `console.log("[CATALOG WARM TRACE] getCatalogForShop called for:", shop);`
- After building `products` from GraphQL (before cache set and return): `console.log("[CATALOG WARM TRACE] GraphQL returned:", products.length);`

---

## STEP 6 — Prisma init trace

**File:** `revstack/app/lib/prisma.server.ts`

**Added:** After Prisma client creation/assignment:
```ts
console.log("[CATALOG WARM TRACE] Prisma initialized");
```

---

## STEP 7 — Snapshot route uniqueness and server registration

**Search:** `cart.snapshot.v3.ts` across repo.

**Result:** Exactly **one** file: `revstack/app/routes/cart.snapshot.v3.ts`.

**Server:** `revstack/server.ts` does **not** register routes by name. It uses:
- `const buildModule = await import(pathToFileURL(BUILD_PATH).href)` with `BUILD_PATH = path.resolve(process.cwd(), "build/server/index.js")`
- `createRequestHandler({ build: buildModule, mode })` or RSC `createRequestListener(wrappedFetch)` with `buildModule.default.fetch`

So the **React Router build** (from `app/routes/`) is the single entry; all routes, including `cart.snapshot.v3`, come from that build. With `flatRoutes()` in `app/routes.ts`, the file `cart.snapshot.v3.ts` is included in the build. Route path is determined by React Router file-based routing (e.g. `/cart/snapshot/v3` or equivalent for the app proxy).

**Conclusion:** Snapshot route is the correct version; there is only one such file and the server uses the built router that includes it.

---

## STEP 8 — Deployed code vs local (trace string in build)

**Trace string:** `[CATALOG WARM TRACE]`

**Source locations (now in repo):**
- `revstack/app/lib/catalog-warm.server.ts`
- `revstack/app/lib/catalog.server.ts`
- `revstack/app/lib/prisma.server.ts`
- `revstack/app/routes/cart.snapshot.v3.ts`

**Build:** React Router compiles server bundle to `build/server/`. Railway runs from **root directory** `revstack` (per `railway.toml` and “Root Directory” setting). So:
- **Build output directory:** `revstack/build/` (i.e. `build/` when cwd is `revstack`)
- **Server entry:** `build/server/index.js`

If `[CATALOG WARM TRACE]` does **not** appear in production logs after deploying this code, the deployed artifact is old or a different build. After deploy, trigger the snapshot or `/debug/warm` and confirm these logs.

---

## STEP 9 — Railway DATABASE_URL

**Prisma connection:** `revstack/prisma/schema.prisma`:
```prisma
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}
```
So the connection string is **only** from `process.env.DATABASE_URL`.

**Railway:** Set `DATABASE_URL` in the Railway project (e.g. Postgres plugin or variable). The app does not hardcode it. Confirm in Railway dashboard that `DATABASE_URL` is set and points to Railway Postgres.

---

## STEP 10 — Debug warm endpoint

**File created:** `revstack/app/routes/debug.warm.ts`

```ts
import type { LoaderFunctionArgs } from "react-router";
import { warmCatalogForShop } from "~/lib/catalog-warm.server";

export async function loader({ request }: LoaderFunctionArgs) {
  await warmCatalogForShop("revdev-4.myshopify.com");
  return new Response("warm complete", {
    headers: { "Content-Type": "text/plain" },
  });
}
```

**Usage:** Deploy, then visit `https://<your-host>/debug/warm`. Check logs for the full trace chain. Remove or restrict this route after the audit.

---

## STEP 11 — Final forensic report

### Execution chain (code-level)

| Step | What | Evidence |
|------|------|----------|
| 1 | Snapshot loader runs | Request hits route; `authenticate.public.appProxy` and shop resolution run. |
| 2 | Shop resolved | `[CATALOG WARM TRACE] shop:` log. |
| 3 | Count query | `prisma.shopProduct.count({ where: { shopDomain: shop } })` runs. |
| 4 | Warm only if count === 0 | `[CATALOG WARM TRACE] count before warm:` then `[CATALOG WARM TRACE] calling warmCatalogForShop` only when count is 0. |
| 5 | warmCatalogForShop entered | `[CATALOG WARM TRACE] warmCatalogForShop ENTER` + shop. |
| 6 | Circuit check | If circuit open → return `[]` (no further trace). |
| 7 | Admin client | `shopify.unauthenticated.admin(shop)`; then `[CATALOG WARM TRACE] admin client created`. If `!auth` → return `[]`. |
| 8 | getCatalogForShop | `[CATALOG WARM TRACE] getCatalogForShop called for:` then `[CATALOG WARM TRACE] GraphQL returned:` + length. |
| 9 | Upserts | `[CATALOG WARM TRACE] starting upserts` then Prisma upserts per product. |
| 10 | Verify | `[CATALOG WARM TRACE] DB count after warm:` + count. |

### Answers (to be filled by runtime)

- **Is warmCatalogForShop called?**  
  If you see `[CATALOG WARM TRACE] calling warmCatalogForShop` and `warmCatalogForShop ENTER` → **yes**.

- **Is getCatalogForShop called?**  
  If you see `getCatalogForShop called for:` and `GraphQL returned:` → **yes**.

- **Do Prisma upserts run?**  
  If you see `starting upserts` and then `DB count after warm:` with a positive number → **yes**.

- **Exact failure point (if any):**  
  - Last trace you see before logs stop or before an error:
    - Only `shop:` and `count before warm:` → warm never called (count !== 0) or route/auth issue.
    - `warmCatalogForShop ENTER` then stop → circuit open or throw before admin.
    - `admin client created` then stop → `auth` null (admin failed for shop).
    - `getCatalogForShop called for:` then stop → failure inside getCatalogForShop (GraphQL/network/permissions).
    - `products fetched: 0` or `GraphQL returned: 0` → no products; upserts still run but write 0 rows.
    - `starting upserts` then stop → Prisma/DB error (connection, schema, or constraint).
    - `DB count after warm:` with 0 after non-zero fetch → upsert path or transaction issue.

- **Exact fix required:**  
  Depends on the failure point above (e.g. fix admin auth for shop, fix GraphQL/credentials, fix DB connection or schema, or fix circuit/Redis if circuit is stuck open).

### Summary

Trace logs are in place from shop resolution through Prisma verify. After deploy, trigger the snapshot (with a shop that has no products in `ShopProduct`) or hit `/debug/warm` and use the **last** `[CATALOG WARM TRACE]` log line to identify where execution stops. No assumptions; execution path is proven by log order.
