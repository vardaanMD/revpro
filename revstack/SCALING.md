# Scaling and production checklist

This doc covers limitations of the current dev/single-instance setup and what to change for multi-instance or serverless.

---

## 1. Rate limiter (Redis)

**Current:** Rate limiter in `app/lib/rate-limit.server.ts` uses Redis with a fixed window (60s, 60 req/shop). Keys expire automatically; no DB or cleanup required. Limits are shared across instances.

**Redis config (production):**

- **maxmemory-policy:** Avoid `volatile-lru` unless you explicitly want rate-limit keys to be evicted under memory pressure (which would reset limits unpredictably). Prefer `noeviction` or ensure rate-limit keys are not evicted (e.g. separate instance or a policy that keeps keys with TTL).
- **Persistence:** Railway Redis should have persistence enabled (AOF or RDB snapshot) so restarts don’t lose data unnecessarily. For rate limiting only, loss on restart is acceptable: **if Redis restarts, rate limits reset** — that’s an accepted trade-off.

---

## 2. Catalog fetch and cache

**Current:** `getCatalogForShop()` in `app/lib/catalog.server.ts` fetches the product catalog (GraphQL) and caches it in a **process-local** `Map` with a 5-minute TTL. The catalog is fetched (or served from cache) on **every** cart decision call.

**Limitation:** With multiple instances, Shop A on instance 1 gets a cache hit; the same shop on instance 2 gets a cache miss and triggers another GraphQL request. Not fatal, but redundant work and extra Admin API usage at scale.

**For production:** Use shared storage:

- **Redis** — cache key e.g. `catalog:{shop}:{currency}`, TTL 5 min.
- **Postgres table** — e.g. `catalog_cache (shop, currency, data, expires_at)` with cleanup or in-DB TTL.
- Or **in-DB TTL** if your Postgres setup supports it.

For now, per-process cache is **acceptable for dev**.

---

## 3. Replay protection and proxy signature

**Current:** `cart.decision.ts` validates:

- **Timestamp** — `timestamp` query param, must be within last 5 minutes (no future, no stale).
- **Signature** — HMAC-SHA256 over query params (excluding `signature`), sorted alphabetically, concatenated with **no separator** between `key=value` pairs (per Shopify docs). Multi-value params use comma-separated values. Comparison is **timing-safe**.

This matches Shopify’s [Authenticate app proxies](https://shopify.dev/docs/apps/build/online-store/app-proxies/authenticate-app-proxies) behaviour. If you change the signature construction (e.g. add `&` between params), verification will fail in production.

---

## 4. GDPR webhooks

**Current:** Mandatory compliance webhooks are registered in `shopify.app.toml` under one subscription with `compliance_topics = ["customers/data_request", "customers/redact", "shop/redact"]` and `uri = "/webhooks/compliance"`. The route `webhooks.compliance.tsx` uses `authenticate.webhook(request)` (validates HMAC and topic) and returns **200** with JSON body. This satisfies Shopify’s requirements for app store submission.

---

## 5. Prisma and Postgres

**Current:** Prisma uses `DATABASE_URL` from env (Railway Postgres). A single PrismaClient singleton per process is used; migrations are run manually (CI or before deploy), not on app startup.

**For production:** Ensure `DATABASE_URL` is set in the deployment environment only. No hardcoded DB values. Railway Postgres provides connection pooling by default. Set `DATABASE_URL` from your Railway project dashboard.

---

## 6. Caches (per-process)

**Current:** Several caches are per-process in-memory:

- **Catalog** (`catalog.server.ts`) — 5 min TTL per shop
- **Shop config** (`shop-config.server.ts`) — TTL until invalidation
- **Dashboard metrics** (`dashboard-metrics.server.ts`) — 30s TTL per shop
- **Analytics metrics** (`analytics.server.ts`) — 30s TTL per shop
- **Decision cache** (`decision-cache.server.ts`) — bounded: 100 entries per shop, 5000 global; 30s TTL

**Limitation:** With multiple instances, each process has its own cache. Cache hits are not shared. For decision cache, eviction is per-process (100/shop, 5000 global per instance).
