/**
 * Cart Pro V3 — discount API layer.
 * Validates discount codes via POST /discounts/{code}.
 * No stacking logic here; engine handles application state.
 */

export type DiscountValidationType = 'percentage' | 'fixed';

export interface ValidateDiscountResult {
  valid: boolean;
  code: string;
  amount: number;
  type: DiscountValidationType;
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
    return { valid: false, code: normalizedCode, amount: 0, type: 'fixed' };
  }

  const url = `/discounts/${encodeURIComponent(normalizedCode)}`;
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

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return {
        valid: false,
        code: normalizedCode,
        amount: 0,
        type: 'fixed',
      };
    }

    return {
      valid: Boolean(data.valid),
      code: typeof data.code === 'string' ? data.code : normalizedCode,
      amount: Number(data.amount) || 0,
      type:
        data.type === 'percentage' || data.type === 'fixed' ? data.type : 'fixed',
    };
  } catch {
    return {
      valid: false,
      code: normalizedCode,
      amount: 0,
      type: 'fixed',
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
    await fetch('/discounts/remove', {
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
