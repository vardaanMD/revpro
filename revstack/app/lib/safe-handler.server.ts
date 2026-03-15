import { randomUUID } from "node:crypto";
import { data, type ActionFunctionArgs } from "react-router";
import { getRequestId, getRateLimit } from "~/lib/request-context.server";
import { logInternalError } from "~/lib/logger.server";

function safeHandlerHeaders(requestId: string | undefined): Record<string, string> {
  const headers: Record<string, string> = {};
  if (requestId) headers["X-Request-Id"] = requestId;
  const rateLimit = getRateLimit();
  if (rateLimit) {
    headers["X-RateLimit-Limit"] = `${rateLimit.limit}`;
    headers["X-RateLimit-Remaining"] = `${rateLimit.remaining}`;
    headers["X-RateLimit-Reset"] = `${Math.ceil(rateLimit.resetAt / 1000)}`;
  }
  return headers;
}

export function withSafeHandler(
  actionFn: (args: ActionFunctionArgs) => Promise<unknown>
): (args: ActionFunctionArgs) => Promise<unknown> {
  return async (args) => {
    try {
      return await actionFn(args);
    } catch (err: unknown) {
      const requestId = getRequestId() ?? randomUUID();
      const path = new URL(args.request.url).pathname;
      const shop = new URL(args.request.url).searchParams.get("shop") ?? undefined;
      logInternalError({
        requestId,
        path,
        shop,
        message: err instanceof Error ? err.message : "Internal error",
        meta: { name: err instanceof Error ? err.name : undefined },
        error: err,
      });
      return data(
        { error: "Internal error" },
        { status: 500, headers: safeHandlerHeaders(requestId) }
      );
    }
  };
}
