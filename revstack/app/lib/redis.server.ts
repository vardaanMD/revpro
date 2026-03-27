/**
 * Redis client for revstack. Server-side only.
 * Uses ioredis with Railway Redis. Singleton to avoid multiple instances in dev hot reload.
 */

import Redis from "ioredis";
import { logInfo, logWarn } from "~/lib/logger.server";
import { normalizeShopDomain } from "~/lib/shop-domain.server";

/**
 * Centralized Redis key builder. All keys must use this to enforce namespace and normalized shop.
 * Format: revstack:{normalizedShop}:{...parts}
 * No raw ${shop} or template-string key construction elsewhere.
 */
export function redisKey(shop: string, ...parts: string[]): string {
  const normalized = normalizeShopDomain(shop);
  return ["revstack", normalized, ...parts].join(":");
}

function getRedisClient(): Redis {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    throw new Error("Missing required environment variable: REDIS_URL");
  }

  const globalForRedis = globalThis as unknown as { redis: Redis | undefined };

  if (globalForRedis.redis) {
    return globalForRedis.redis;
  }

  const client = new Redis(redisUrl, {
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
    lazyConnect: false,
  });

  // Prevent unhandled 'error' events from crashing the process
  client.on("error", (err) => {
    logWarn({ message: "Redis connection error", meta: { error: err?.message ?? String(err) } });
  });

  globalForRedis.redis = client;

  // --- TEMPORARY: dev-only connectivity test. Remove after confirmation. ---
  if (process.env.NODE_ENV === "development") {
    void (async () => {
      const testKey = "revstack:redis:health-check";
      try {
        await client.set(testKey, "ok");
        const val = await client.get(testKey);
        await client.del(testKey);
        if (val === "ok") {
          logInfo({ message: "Redis connectivity test passed", meta: { key: testKey } });
        } else {
          logWarn({ message: "Redis connectivity test: unexpected value", meta: { expected: "ok", got: val } });
        }
      } catch (err) {
        logWarn({
          message: "Redis connectivity test failed",
          meta: { error: err instanceof Error ? err.message : String(err) },
        });
      }
    })();
  }
  // --- END TEMPORARY ---

  return client;
}

/**
 * Returns the Redis client. Connects on first call.
 * Throws if REDIS_URL is not set.
 */
export function getRedis(): Redis {
  return getRedisClient();
}
