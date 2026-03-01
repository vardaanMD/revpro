# Phase 5: Stress Test Validation

After implementing stability, fallback, and observability hardening, validate under these scenarios.

## 1. Redis down → cart still works

- Stop Redis (or set `REDIS_URL` to an invalid endpoint).
- Open cart on storefront; decision route should return 200 with safe decision (empty cross-sell, default UI).
- Rate limit should fall back to in-memory; no request should block waiting for Redis.

## 2. Postgres down → cart still works

- Stop Postgres or use an invalid `DATABASE_URL`.
- Open cart; decision route should return 200 (config load may fail → safe decision; metrics/crossSell writes are fire-and-forget and must not block).

## 3. Shopify Admin slow → cart still works

- Throttle or delay Shopify Admin (e.g. network delay).
- Catalog warm may fail; after 3 consecutive failures, circuit opens for 60s.
- Decision route uses cached index or returns safe decision; no long stalls.

## 4. 50 rapid cart opens → no crash

- Send 50 rapid POSTs to `/cart/decision` (same or different shops).
- No 500s; rate limit may return 429 after quota; others get 200 with decision or safe decision.
- No OOM; decision and catalog caches stay within max size (LRU eviction).

## 5. Hard refresh first open → no 500

- Restart server; immediately open cart (first request pays cold start).
- Server has warmed Redis and Prisma on startup (fire-and-forget).
- First request should still return 200 (may be slower, but no 500).

## Quick checks

- `GET /health/internal` returns `{ redis, postgres, catalogCacheSize, decisionCacheSize }`.
- Decision route logs one structured summary per request: `totalMs`, `cacheHit`, `usedSafeDecision`, `rateLimitMs`, `configMs`, `catalogMs`, `engineMs`.
- No exception from the decision route should reach the storefront as 500; all failures return 200 with safe decision.
