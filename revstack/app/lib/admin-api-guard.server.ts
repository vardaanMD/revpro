/**
 * Uniform 401 handling for Shopify Admin API calls.
 * On 401: log and redirect to /auth/login (preserving shop, host, search params).
 * Use after every admin.graphql() call so session/token expiry always triggers re-auth, never 500 or empty fallback.
 */
import { logResilience } from "~/lib/logger.server";
import { AdminApi401Error } from "~/lib/admin-api-errors.server";

/**
 * If response is 401, logs and throws either a 302 redirect to /auth/login (when request is provided)
 * or AdminApi401Error (when request is missing, so caller can redirect).
 * Call after admin.graphql() before reading response body.
 */
export function handleAdminApiResponse(
  response: Response,
  shop: string,
  route: string,
  request?: Request
): void {
  if (response.status !== 401) return;

  logResilience({
    shop,
    route,
    message: "Admin API 401; session/token expired, force re-auth",
    meta: {
      errorType: "AdminApi401",
      fallbackUsed: false,
      redirecting: true,
      sessionPresent: false,
    },
  });

  if (request) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/auth")) {
      throw new AdminApi401Error(shop);
    }
    const search = url.searchParams.toString();
    const location = search ? `/auth/login?${search}` : "/auth/login";
    throw new Response(null, { status: 302, headers: { Location: location } });
  }

  throw new AdminApi401Error(shop);
}
