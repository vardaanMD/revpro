/**
 * Cart Pro V3 — discount API layer.
 * Validates discount codes via POST /discounts/{code}.
 * No stacking logic here; engine handles application state.
 */

import type { DiscountValidationReason } from './discountValidationMessages';
import { parseDiscountValidationReason } from './discountValidationMessages';

export type DiscountValidationType = 'percentage' | 'fixed';

export interface ValidateDiscountResult {
  valid: boolean;
  code: string;
  amount: number;
  type: DiscountValidationType;
  /** Set when valid is false (from JSON body or inferred from HTTP status). */
  reason?: DiscountValidationReason;
}

/**
 * Validate a discount code against the current cart.
 * Calls POST /discounts/{code} with cart payload.
 * If the endpoint is not available (e.g. Shopify theme has no backend),
 * returns valid: false so UI can show error.
 */
export async function validateDiscount(
  code: string,
  cartRaw: any
): Promise<ValidateDiscountResult> {
  const normalizedCode = (code || '').trim();
  if (!normalizedCode) {
    return { valid: false, code: normalizedCode, amount: 0, type: 'fixed', reason: 'empty_code' };
  }

  const url = `/apps/cart-pro/discounts/${encodeURIComponent(normalizedCode)}`;
  const body = JSON.stringify({ cart: cartRaw ?? null });

  try {
    const res = await fetch(url, {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body,
    });

    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      const fromBody = parseDiscountValidationReason(data.reason);
      let reason: DiscountValidationReason = fromBody ?? 'request_failed';
      if (fromBody == null) {
        if (res.status === 401) reason = 'app_proxy_unauthorized';
        else if (res.status === 405) reason = 'method_not_allowed';
      }
      return {
        valid: false,
        code: normalizedCode,
        amount: 0,
        type: 'fixed',
        reason,
      };
    }

    const valid = Boolean(data.valid);
    const parsedReason = parseDiscountValidationReason(data.reason);

    return {
      valid,
      code: typeof data.code === 'string' ? data.code : normalizedCode,
      amount: Number(data.amount) || 0,
      type:
        data.type === 'percentage' || data.type === 'fixed' ? data.type : 'fixed',
      ...(!valid && parsedReason ? { reason: parsedReason } : {}),
    };
  } catch {
    return {
      valid: false,
      code: normalizedCode,
      amount: 0,
      type: 'fixed',
      reason: 'network_error',
    };
  }
}

/**
 * Ask backend to remove a discount code from the cart.
 * POST /discounts/remove with body { code }.
 * Used by engine when user removes one code; state is updated by engine.
 */
export async function removeDiscountFromCart(code: string): Promise<void> {
  const normalizedCode = (code || '').trim();
  if (!normalizedCode) return;

  try {
    await fetch('/apps/cart-pro/discounts/remove', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ code: normalizedCode }),
    });
  } catch {
    // Engine will still remove from state; cart may resync to reflect
  }
}
