import type { ComponentProps } from "react";
import { Link, useLocation } from "react-router";

/**
 * Link that preserves embedded-app query params (shop, host, embedded, id_token) for /app/* routes.
 * Use for all in-app navigation so loader requests include params required by authenticate.admin.
 * Without this, client-side navigation requests lack shop/host and redirect to /auth/login.
 */
export function AppLink({
  to,
  ...props
}: ComponentProps<typeof Link>) {
  const location = useLocation();
  const path = typeof to === "string" ? to : (to as { pathname?: string }).pathname ?? "";
  const [pathname, hash] = path.split("#");
  const isAppRoute = pathname.startsWith("/app");
  const inAppContext = location.pathname.startsWith("/app");
  const preserveSearch = isAppRoute && inAppContext && location.search;
  const searchPart = location.search.startsWith("?") ? location.search : `?${location.search}`;
  const resolvedTo = preserveSearch
    ? `${pathname}${pathname.includes("?") ? "&" + searchPart.slice(1) : searchPart}${hash ? `#${hash}` : ""}`
    : to;
  return <Link to={resolvedTo} {...props} />;
}
