/**
 * IMPORTANT:
 * Decision cache stores cart intelligence ONLY.
 * UI config must NEVER be cached here.
 * UI is served exclusively from /bootstrap.
 */
import crypto from "crypto";
import type { DecisionResponse } from "~/lib/decision-response.server";
import { getRedis, redisKey } from "~/lib/redis.server";
import { logResilience } from "~/lib/logger.server";

const DECISION_CACHE_TTL_SECONDS = 30;
const TTL_MS = DECISION_CACHE_TTL_SECONDS * 1000;
const LOCK_TTL_SECONDS = 5;
const LOCK_RETRY_MS = 75;

const MAX_PER_SHOP = 100;
const MAX_GLOBAL = 5_000;

/** Internal cache payload: only known fields, no unknown properties (e.g. ui). */
interface CachedDecisionPayload {
  crossSell: DecisionResponse["crossSell"];
  freeShippingRemaining: number;
  suppressCheckout: boolean;
  milestones: DecisionResponse["milestones"];
  enableCouponTease: boolean;
  crossSellDebug?: DecisionResponse["crossSellDebug"];
}

type CacheEntry = {
  response: CachedDecisionPayload;
  expiresAt: number;
};

const cache = new Map<string, CacheEntry>();
const keyOrder: string[] = [];
const shopKeys = new Map<string, string[]>();

function cacheKey(shop: string, cartHash: string): string {
  return `${shop}:${cartHash}`;
}

function redisDecisionKey(shop: string, cartHash: string): string {
  return redisKey(shop, "decision", cartHash);
}

function redisLockKey(shop: string, cartHash: string): string {
  return redisKey(shop, "decision_lock", cartHash);
}

function evictKey(key: string): void {
  if (!cache.has(key)) return;
  cache.delete(key);
  const idx = keyOrder.indexOf(key);
  if (idx >= 0) keyOrder.splice(idx, 1);
  const shop = key.includes(":") ? key.slice(0, key.indexOf(":")) : "";
  const list = shopKeys.get(shop);
  if (list) {
    const i = list.indexOf(key);
    if (i >= 0) list.splice(i, 1);
    if (list.length === 0) shopKeys.delete(shop);
  }
}

function evictUntilShopUnderLimit(shop: string): void {
  const list = shopKeys.get(shop);
  while (list && list.length >= MAX_PER_SHOP) {
    const oldest = list[0];
    evictKey(oldest);
  }
}

function evictUntilGlobalUnderLimit(): void {
  while (keyOrder.length >= MAX_GLOBAL) {
    const oldest = keyOrder[0];
    evictKey(oldest);
  }
}

export function hashCartPayload(cartJson: string): string {
  return crypto.createHash("sha256").update(cartJson).digest("hex");
}

/**
 * 1) Check memory cache (sync).
 * Returns cached response or null.
 */
export function getCachedDecision(
  shop: string,
  cartHash: string
): DecisionResponse | null {
  const key = cacheKey(shop, cartHash);
  const entry = cache.get(key);
  if (!entry) {
    if (process.env.NODE_ENV === "development") {
      console.log("[DecisionCache] memory miss", { shop });
    }
    return null;
  }
  if (Date.now() > entry.expiresAt) {
    evictKey(key);
    return null;
  }
  const cached = entry.response;
  if (!Array.isArray(cached.crossSell) || typeof cached.freeShippingRemaining !== "number") {
    return null;
  }
  if (process.env.NODE_ENV === "development") {
    console.log("[DecisionCache] memory hit", { shop });
  }
  return cached as DecisionResponse;
}

/**
 * 2) Check Redis decision cache. Use after memory miss for cross-replica safety.
 * Returns parsed response or null. On Redis error logs and returns null; never blocks request.
 */
export async function getCachedDecisionFromRedis(
  shop: string,
  cartHash: string
): Promise<DecisionResponse | null> {
  try {
    const redis = getRedis();
    const raw = await redis.get(redisDecisionKey(shop, cartHash));
    if (raw == null || raw === "") {
      if (process.env.NODE_ENV === "development") {
        console.log("[DecisionCache] Redis miss", { shop });
      }
      return null;
    }
    const parsed = JSON.parse(raw) as CachedDecisionPayload;
    if (!Array.isArray(parsed.crossSell) || typeof parsed.freeShippingRemaining !== "number") {
      return null;
    }
    if (process.env.NODE_ENV === "development") {
      console.log("[DecisionCache] Redis hit", { shop });
    }
    return parsed as DecisionResponse;
  } catch (err) {
    logResilience({
      shop,
      route: "decision-cache",
      message: "Redis get decision cache failed; continuing without cache",
      meta: {
        errorType: err instanceof Error ? err.name : "Unknown",
        redisHitMiss: "miss",
      },
    });
    return null;
  }
}

/**
 * Set memory cache only (sync). Used when we populate from Redis hit.
 */
export function setMemoryCachedDecision(
  shop: string,
  cartHash: string,
  response: DecisionResponse
): void {
  const sanitized: CachedDecisionPayload = {
    crossSell: response.crossSell,
    freeShippingRemaining: response.freeShippingRemaining,
    suppressCheckout: response.suppressCheckout,
    milestones: response.milestones,
    enableCouponTease: response.enableCouponTease,
    crossSellDebug: response.crossSellDebug,
  };
  const key = cacheKey(shop, cartHash);
  if (cache.has(key)) {
    cache.set(key, {
      response: sanitized,
      expiresAt: Date.now() + TTL_MS,
    });
    return;
  }
  evictUntilShopUnderLimit(shop);
  evictUntilGlobalUnderLimit();
  cache.set(key, {
    response: sanitized,
    expiresAt: Date.now() + TTL_MS,
  });
  keyOrder.push(key);
  const list = shopKeys.get(shop) ?? [];
  list.push(key);
  shopKeys.set(shop, list);
}

/**
 * Set both memory and Redis decision cache. Call after computing decision.
 * On Redis error logs and continues; memory cache still set. Never throws.
 */
export async function setCachedDecision(
  shop: string,
  cartHash: string,
  response: DecisionResponse
): Promise<void> {
  const sanitized: CachedDecisionPayload = {
    crossSell: response.crossSell,
    freeShippingRemaining: response.freeShippingRemaining,
    suppressCheckout: response.suppressCheckout,
    milestones: response.milestones,
    enableCouponTease: response.enableCouponTease,
    crossSellDebug: response.crossSellDebug,
  };
  setMemoryCachedDecision(shop, cartHash, response);
  try {
    const redis = getRedis();
    const key = redisDecisionKey(shop, cartHash);
    await redis.set(key, JSON.stringify(sanitized), "EX", DECISION_CACHE_TTL_SECONDS);
  } catch (err) {
    logResilience({
      shop,
      route: "decision-cache",
      message: "Redis set decision cache failed; memory cache only",
      meta: { errorType: err instanceof Error ? err.name : "Unknown" },
    });
  }
}

/**
 * Concurrency guard: try to acquire lock for this shop+cartHash.
 * Returns true if lock acquired, false if another request holds it or Redis fails.
 * Lock TTL 5s so it auto-releases if process dies. Never blocks request on Redis.
 */
export async function tryLockDecision(
  shop: string,
  cartHash: string
): Promise<boolean> {
  try {
    const redis = getRedis();
    const key = redisLockKey(shop, cartHash);
    const result = await redis.set(key, "1", "EX", LOCK_TTL_SECONDS, "NX");
    return result === "OK";
  } catch (err) {
    logResilience({
      shop,
      route: "decision-cache",
      message: "Redis tryLock failed; continuing without lock",
      meta: { errorType: err instanceof Error ? err.name : "Unknown" },
    });
    return false;
  }
}

/**
 * Wait briefly then re-check Redis decision cache (for when lock was held by another request).
 */
export function lockRetryDelayMs(): number {
  return LOCK_RETRY_MS;
}

/** Current in-memory decision cache entry count (for health diagnostics). */
export function getDecisionCacheSize(): number {
  return keyOrder.length;
}

/** Trim cache to stay under global limit (safety guard against leaks). */
export function trimDecisionCacheToLimit(): void {
  evictUntilGlobalUnderLimit();
}
