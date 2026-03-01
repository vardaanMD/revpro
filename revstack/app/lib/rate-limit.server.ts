import { getRedis, redisKey } from "~/lib/redis.server";
import { logWarn } from "~/lib/logger.server";

const LIMIT = 60;
const WINDOW_SECONDS = 60;
const REDIS_TIMEOUT_MS = 2000;
const REDIS_FAILURE_LOG_THROTTLE_SECONDS = 60;

export type RateLimitResult = {
  allowed: boolean;
  remaining: number;
  limit: number;
  resetAt: number;
};

/** In-memory store: per-shop window. Not shared across instances. */
const memoryStore = new Map<
  string,
  { count: number; windowStartMs: number }
>();

function checkRateLimitInMemory(shop: string): RateLimitResult {
  const nowMs = Date.now();
  const windowMs = WINDOW_SECONDS * 1000;
  const currentWindowStart = Math.floor(nowMs / windowMs) * windowMs;
  const key = `${shop}:${currentWindowStart}`;
  const prevKey = `${shop}:${currentWindowStart - windowMs}`;
  memoryStore.delete(prevKey);

  let entry = memoryStore.get(key);
  if (!entry || entry.windowStartMs !== currentWindowStart) {
    entry = { count: 0, windowStartMs: currentWindowStart };
    memoryStore.set(key, entry);
  }
  entry.count += 1;

  const allowed = entry.count <= LIMIT;
  const remaining = allowed ? LIMIT - entry.count : 0;
  const resetAtMs = currentWindowStart + windowMs;

  return {
    allowed,
    remaining,
    limit: LIMIT,
    resetAt: resetAtMs,
  };
}

async function checkRateLimitWithRedis(shop: string): Promise<RateLimitResult> {
  const redis = getRedis();
  const now = Math.floor(Date.now() / 1000);
  const window = String(Math.floor(now / WINDOW_SECONDS));
  const key = redisKey(shop, "ratelimit", window);

  const count = await redis.incr(key);
  if (count === 1) {
    await redis.expire(key, WINDOW_SECONDS);
  }

  const allowed = count <= LIMIT;
  const remaining = allowed ? LIMIT - count : 0;
  const resetAtSec = (Math.floor(now / WINDOW_SECONDS) + 1) * WINDOW_SECONDS;
  const resetAt = resetAtSec * 1000;

  return {
    allowed,
    remaining,
    limit: LIMIT,
    resetAt,
  };
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error("Redis timeout")), ms)
    ),
  ]);
}

let lastRedisFailureLogAt = 0;

/**
 * Rate limit check with Redis. On Redis failure or timeout, falls back to
 * in-memory rate limiting (same window + quota, per-instance). Never throws.
 * Does NOT await Redis reconnection; request is never blocked by Redis.
 */
export async function checkRateLimitWithQuota(
  shop: string
): Promise<RateLimitResult> {
  try {
    return await withTimeout(checkRateLimitWithRedis(shop), REDIS_TIMEOUT_MS);
  } catch (err) {
    const nowSec = Math.floor(Date.now() / 1000);
    if (nowSec - lastRedisFailureLogAt >= REDIS_FAILURE_LOG_THROTTLE_SECONDS) {
      lastRedisFailureLogAt = nowSec;
      logWarn({
        route: "rate-limit",
        message: "Redis unavailable, using in-memory fallback",
        meta: {
          shop,
          errorType: err instanceof Error ? err.name : "Unknown",
          error: err instanceof Error ? err.message : String(err),
          fallbackUsed: true,
        },
      });
    }
    return checkRateLimitInMemory(shop);
  }
}
