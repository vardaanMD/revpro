/**
 * Runs authenticate.admin and getShopConfig once for /app/* document requests.
 * Called from the custom server BEFORE React Router loaders run.
 * Sets appLayout in request context so layout and child loaders can use getAppLayoutFromContext().
 * Returns a redirect Response if auth fails; otherwise returns null (caller continues to RR handler).
 * Resilience: getShopConfig failure uses fallback config; auth failure always redirects to /auth/login (never 500).
 */
import { authenticate } from "~/shopify.server";
import { getShopConfig, getFallbackShopConfig } from "~/lib/shop-config.server";
import { setAppLayoutInContext } from "~/lib/request-context.server";
import type { AppLayoutAuth } from "~/lib/request-context.server";
import { normalizeShopDomain, warnIfShopNotCanonical } from "~/lib/shop-domain.server";
import { isAdminDisabled } from "~/lib/admin-disabled.server";
import { logResilience } from "~/lib/logger.server";

/** Build search string for redirect (preserve shop, host, embedded params). */
function authLoginSearch(request: Request): string {
  const url = new URL(request.url);
  return url.searchParams.toString();
}

/** Redirect to /auth/login preserving query params. Never redirect if already on /auth/ (loop protection). */
function redirectToAuthLogin(request: Request): Response {
  const url = new URL(request.url);
  if (url.pathname.startsWith("/auth")) {
    throw new Error("Auth redirect loop prevented: already on /auth path");
  }
  const search = authLoginSearch(request);
  const location = search ? `/auth/login?${search}` : "/auth/login";
  return new Response(null, { status: 302, headers: { Location: location } });
}

export async function runAppAuth(request: Request): Promise<Response | null> {
  let auth: Awaited<ReturnType<typeof authenticate.admin>>;
  try {
    auth = await authenticate.admin(request);
  } catch (e) {
    if (e instanceof Response && e.status >= 300 && e.status < 400) {
      return e;
    }
    logResilience({
      route: "runAppAuth",
      message: "authenticate.admin threw; redirecting to re-auth",
      meta: {
        errorType: "AuthFailure",
        redirecting: true,
        sessionPresent: false,
      },
    });
    return redirectToAuthLogin(request);
  }

  const { session, redirect } = auth;
  const rawShop = session.shop;
  const shop = normalizeShopDomain(rawShop);
  warnIfShopNotCanonical(rawShop, shop);

  if (isAdminDisabled(shop)) {
    return new Response(null, { status: 404 });
  }

  let config: Awaited<ReturnType<typeof getShopConfig>>;
  try {
    config = await getShopConfig(shop);
  } catch (err) {
    logResilience({
      shop,
      route: "runAppAuth",
      message: "getShopConfig failed; using fallback config",
      meta: {
        errorType: "PrismaColdStart",
        fallbackUsed: true,
        sessionPresent: true,
        redirecting: false,
      },
    });
    config = getFallbackShopConfig(shop);
  }

  const layoutAuth: AppLayoutAuth = {
    session,
    admin: auth.admin as AppLayoutAuth["admin"],
    redirect,
  };
  setAppLayoutInContext(shop, config, layoutAuth);
  return null;
}
