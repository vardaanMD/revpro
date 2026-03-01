/**
 * Errors thrown when Shopify Admin API returns 401 (session/token expired).
 * Loaders should catch and force re-auth redirect; do not crash or show 500.
 */
export class AdminApi401Error extends Error {
  readonly shop: string;

  constructor(shop: string) {
    super(`Admin API returned 401 for shop ${shop}`);
    this.name = "AdminApi401Error";
    this.shop = shop;
  }
}
