/**
 * Single-site direct decision endpoint at /api/cart-decision.
 * Outside /apps/ path so Shopify framework auth does not intercept it.
 * Re-uses the same action as cart.decision.ts; isSingleSite auth is enforced there.
 */
export { action } from "./cart.decision";
