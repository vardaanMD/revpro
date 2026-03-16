/**
 * Admin-disabled shops: when a shop is in ADMIN_DISABLED_SHOPS, /app/* returns 404.
 * Used for white-label single-site so the merchant never sees the app dashboard.
 * Same pattern as PAYWALL_WHITELIST in billing-context.server.ts.
 */
import { normalizeShopDomain } from "~/lib/shop-domain.server";

let _adminDisabledSet: Set<string> | null = null;
let _adminDisabledRaw: string | undefined;

function getAdminDisabledSet(): Set<string> {
  const raw = process.env.ADMIN_DISABLED_SHOPS;
  if (raw !== _adminDisabledRaw || _adminDisabledSet === null) {
    _adminDisabledRaw = raw;
    _adminDisabledSet = new Set(
      (raw ?? "")
        .split(",")
        .map((s) => normalizeShopDomain(s.trim()))
        .filter(Boolean)
    );
  }
  return _adminDisabledSet;
}

export function isAdminDisabled(shop: string): boolean {
  const set = getAdminDisabledSet();
  if (set.size === 0) return false;
  return set.has(normalizeShopDomain(shop));
}
