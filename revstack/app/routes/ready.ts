/**
 * Readiness check — verifies Redis connectivity when configured.
 * Returns 503 if Redis is configured but unavailable.
 */
import type { LoaderFunctionArgs } from "react-router";
import { logWarn } from "~/lib/logger.server";

export async function loader(_args: LoaderFunctionArgs) {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    return Response.json({ status: "ready" }, { status: 200 });
  }

  try {
    const { getRedis } = await import("~/lib/redis.server");
    const redis = getRedis();
    await redis.ping();
    return Response.json({ status: "ready" }, { status: 200 });
  } catch (err) {
    logWarn({
      route: "ready",
      message: "Redis unavailable; readiness check failed",
      meta: { error: err instanceof Error ? err.message : String(err) },
    });
    return Response.json(
      { status: "unavailable", reason: "Redis unreachable" },
      { status: 503 }
    );
  }
}
