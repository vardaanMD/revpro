import { PrismaClient } from "@prisma/client";

declare global {
  var prisma: PrismaClient | undefined;
}

/**
 * Multi-tenant guarantee:
 * All application read queries MUST include shopDomain scoping.
 * Only cleanup jobs may intentionally operate globally.
 *
 * Connection pool (production): set in DATABASE_URL, e.g.
 *   ?connection_limit=15&pool_timeout=10
 * Prisma defaults (~5 connections) can exhaust under load.
 */

import { logWarn } from "~/lib/logger.server";

const SLOW_QUERY_MS = 100;

function createPrismaClient(): PrismaClient {
  const isProd = process.env.NODE_ENV === "production";
  const client = new PrismaClient({
    log:
      isProd
        ? [{ emit: "event", level: "query" }]
        : ["error", "warn"],
  });
  if (isProd) {
    client.$on("query" as never, (e: { duration: number; query: string }) => {
      if (e.duration >= SLOW_QUERY_MS) {
        logWarn({
          route: "prisma",
          message: "Slow query",
          meta: { durationMs: e.duration, query: e.query?.slice(0, 200) },
        });
      }
    });
  }
  return client;
}

// SINGLE PrismaClient per process. Do not instantiate elsewhere.
export const prisma = global.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== "production") {
  global.prisma = prisma;
}
