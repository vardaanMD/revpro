import { AsyncLocalStorage } from "async_hooks";
import type { RateLimitResult } from "~/lib/rate-limit.server";
import type { ShopConfig } from "@prisma/client";

/** Auth result from layout; admin is the GraphQL client (server-only, not serialized). */
export type AppLayoutAuth = {
  session: { shop: string };
  admin: { graphql: (query: string, opts?: unknown) => Promise<Response> };
  redirect: (url: string, init?: ResponseInit) => Response;
};

export type RequestContextValue = {
  requestId: string;
  rateLimit?: RateLimitResult;
  /** Set by request entry (custom server) for GET /app/* or by app layout loader; child loaders use getAppLayoutFromContext() and do not call authenticate.admin or getShopConfig. */
  appLayout?: { shop: string; config: ShopConfig; session: AppLayoutAuth["session"]; admin: AppLayoutAuth["admin"]; redirect: AppLayoutAuth["redirect"] };
};

export const requestContext = new AsyncLocalStorage<RequestContextValue>();

export function getRequestId(): string | undefined {
  return requestContext.getStore()?.requestId;
}

export function getRateLimit(): RateLimitResult | undefined {
  return requestContext.getStore()?.rateLimit;
}

/** Used by child loaders under /app/* to get shop, config, and auth from layout (single auth/config authority). */
export function getAppLayoutFromContext(): RequestContextValue["appLayout"] {
  return requestContext.getStore()?.appLayout;
}

/** Called by request entry (run-app-auth) or app layout loader to expose shop, config, and auth so child loaders do not call auth/getShopConfig again. */
export function setAppLayoutInContext(
  shop: string,
  config: ShopConfig,
  auth: AppLayoutAuth
): void {
  const store = requestContext.getStore();
  if (store) store.appLayout = { shop, config, session: auth.session, admin: auth.admin, redirect: auth.redirect };
}
