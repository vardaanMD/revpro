/**
 * Public health check for infra monitoring and cold-start readiness.
 * Returns status, prisma, redis. No secrets. Does NOT call decision logic.
 */
import type { LoaderFunctionArgs } from "react-router";
import { prisma } from "~/lib/prisma.server";
import { getRedis } from "~/lib/redis.server";

const startTime = Date.now();

export async function loader(_args: LoaderFunctionArgs) {
  const uptime = Math.floor((Date.now() - startTime) / 1000);

  let prismaStatus: "connected" | "error" = "error";
  try {
    await prisma.$queryRaw`SELECT 1`;
    prismaStatus = "connected";
  } catch {
    prismaStatus = "error";
  }

  let redisStatus: "connected" | "degraded" = "degraded";
  try {
    const redis = getRedis();
    await redis.ping();
    redisStatus = "connected";
  } catch {
    redisStatus = "degraded";
  }

  const status = prismaStatus === "connected" ? "ok" : "degraded";
  const body = {
    status,
    prisma: prismaStatus,
    redis: redisStatus,
    uptime,
    timestamp: new Date().toISOString(),
  };

  return Response.json(body, { status: 200 });
}
