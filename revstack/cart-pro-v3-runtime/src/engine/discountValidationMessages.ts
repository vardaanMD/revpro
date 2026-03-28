/**
 * Stable reason codes returned by POST /apps/cart-pro/discounts/:code (when valid is false).
 * Keep in sync with app/routes/cart.discounts.$code.ts
 */
export type DiscountValidationReason =
  | 'empty_code'
  | 'app_proxy_unauthorized'
  | 'code_not_found'
  | 'discount_inactive'
  | 'method_not_allowed'
  | 'request_failed'
  | 'network_error';

const KNOWN_REASONS = new Set<string>([
  'empty_code',
  'app_proxy_unauthorized',
  'code_not_found',
  'discount_inactive',
  'method_not_allowed',
  'request_failed',
  'network_error',
]);

export function parseDiscountValidationReason(raw: unknown): DiscountValidationReason | undefined {
  if (typeof raw !== 'string' || !KNOWN_REASONS.has(raw)) return undefined;
  return raw as DiscountValidationReason;
}

/**
 * User-facing copy for the cart coupon field (no raw status / internal details).
 */
export function userFacingDiscountErrorMessage(reason: DiscountValidationReason | undefined): string {
  switch (reason) {
    case 'app_proxy_unauthorized':
      return "We couldn't verify your store session. Refresh the page and try again, or open the cart from your shop.";
    case 'code_not_found':
      return "That code wasn't found. Use a customer-facing discount code from Shopify (not automatic discounts without a code).";
    case 'discount_inactive':
      return "This discount isn't active or has expired.";
    case 'empty_code':
      return 'Enter a discount code.';
    case 'method_not_allowed':
    case 'request_failed':
      return "Couldn't validate this code. Please try again.";
    case 'network_error':
      return 'Network error. Check your connection and try again.';
    default:
      return 'Invalid or expired code';
  }
}
