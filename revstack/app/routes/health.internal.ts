/**
 * Internal health diagnostics: Redis, Postgres, cache sizes.
 * For debugging infra only. Do NOT expose to storefront.
 */
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

export async function loader(_args: LoaderFunctionArgs) {
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
