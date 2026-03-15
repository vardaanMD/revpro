/**
 * Internal health diagnostics: Redis, Postgres, cache sizes.
 * For debugging infra only. Do NOT expose to storefront.
 * Rate-limited by IP to reduce reconnaissance / abuse.
 */
import crypto from "crypto";
import type { LoaderFunctionArgs } from "react-router";
import { getRedis } from "~/lib/redis.server";
import { prisma } from "~/lib/prisma.server";
import { getDecisionCacheSize } from "~/lib/decision-cache.server";
import { getCatalogCacheSize } from "~/lib/catalog-cache.server";

export type HealthInternalResult = {
  redis: "ok" | "error";
  postgres: "ok" | "error";
  catalogCacheSize: number;
  decisionCacheSize: number;
};

const HEALTH_RATE_LIMIT_PER_MIN = 10;
const HEALTH_RATE_WINDOW_MS = 60_000;
const healthRateByIp = new Map<string, { count: number; windowStart: number }>();

function isHealthRateLimited(ip: string): boolean {
  const now = Date.now();
  const entry = healthRateByIp.get(ip);
  if (!entry) {
    healthRateByIp.set(ip, { count: 1, windowStart: now });
    return false;
  }
  if (now - entry.windowStart >= HEALTH_RATE_WINDOW_MS) {
    healthRateByIp.set(ip, { count: 1, windowStart: now });
    return false;
  }
  entry.count += 1;
  return entry.count > HEALTH_RATE_LIMIT_PER_MIN;
}

function timingSafeKeyMatch(provided: string | null, expected: string): boolean {
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function getClientIp(request: Request): string {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? request.headers.get("x-real-ip") ?? "unknown";
}

export async function loader({ request }: LoaderFunctionArgs) {
  const ip = getClientIp(request);
  if (isHealthRateLimited(ip)) {
    return Response.json({ error: "too many requests" }, { status: 429 });
  }

  // Auth gate: require INTERNAL_HEALTH_KEY to prevent public infra reconnaissance.
  const url = new URL(request.url);
  const key = url.searchParams.get("key");
  if (!process.env.INTERNAL_HEALTH_KEY || !timingSafeKeyMatch(key, process.env.INTERNAL_HEALTH_KEY)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  let redis: "ok" | "error" = "error";
  let postgres: "ok" | "error" = "error";

  try {
    const r = getRedis();
    await r.ping();
    redis = "ok";
  } catch {
    redis = "error";
  }

  try {
    // SAFE: connectivity check only; no tenant data read.
    await prisma.$queryRaw`SELECT 1`;
    postgres = "ok";
  } catch {
    postgres = "error";
  }

  const catalogCacheSize = getCatalogCacheSize();
  const decisionCacheSize = getDecisionCacheSize();

  const body: HealthInternalResult = {
    redis,
    postgres,
    catalogCacheSize,
    decisionCacheSize,
  };

  return Response.json(body, { status: 200 });
}
