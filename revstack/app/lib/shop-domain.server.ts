/**
 * Normalize shop domain to canonical format (store.myshopify.com).
 * - Lowercases and trims whitespace
 * - Strips leading http:// or https:// and trailing slashes
 * - Ensures consistent DB lookups regardless of how session.shop or env values are formatted.
 * Returns input unchanged if it doesn't look like a Shopify store domain.
 * Example: "https://revdev-4.myshopify.com/" -> "revdev-4.myshopify.com"
 */
export function normalizeShopDomain(shop: string): string {
  let s = shop.trim().toLowerCase();
  if (!s) return s;
  s = s.replace(/^https?:\/\//i, "").replace(/\/+$/, "").trim();
  if (!s) return s;
  // Skip normalization for placeholder or non-Shopify values
  if (s === "unknown" || s.includes(" ")) return s;
  if (s.endsWith(".myshopify.com")) return s;
  // Handle bare store handle (e.g. "revdev-4") -> "revdev-4.myshopify.com"
  return `${s.replace(/\.myshopify\.com$/i, "")}.myshopify.com`;
}

/** Dev-only: log if raw shop was not already canonical. Do not throw; do not run in production. */
export function warnIfShopNotCanonical(raw: string, normalized: string): void {
  if (process.env.NODE_ENV === "development" && raw !== normalized) {
    console.warn("[revPRO] Shop domain was not canonical:", raw, "->", normalized);
  }
}
