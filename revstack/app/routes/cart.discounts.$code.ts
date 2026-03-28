/**
 * App proxy path: /apps/cart-pro/discounts/:code (POST) and /apps/cart-pro/discounts/remove (POST)
 *
 * Validates a Shopify discount code via Admin GraphQL (requires read_discounts scope).
 * Falls back to optimistic { valid: true } if Admin API is unavailable (scope not yet granted,
 * session missing, etc.) so the storefront never breaks.
 *
 * Remove endpoint is a no-op on the backend; the storefront widget calls /discount/remove directly.
 * Never throws 500 — always returns JSON.
 */
import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "~/shopify.server";
import { normalizeShopDomain } from "~/lib/shop-domain.server";
import shopify from "~/shopify.server";
import { logInfo, logWarn } from "~/lib/logger.server";

type AdminGraphQL = {
  graphql(
    query: string,
    options?: { variables?: Record<string, unknown> }
  ): Promise<Response>;
};

const DISCOUNT_CODE_QUERY = `#graphql
  query DiscountCodeValidate($code: String!) {
    codeDiscountNodeByCode(code: $code) {
      id
      codeDiscount {
        __typename
        ... on DiscountCodeBasic {
          status
          customerGets {
            value {
              ... on DiscountAmount {
                amount {
                  amount
                  currencyCode
                }
              }
              ... on DiscountPercentage {
                percentage
              }
            }
          }
        }
        ... on DiscountCodeBxgy {
          status
        }
        ... on DiscountCodeFreeShipping {
          status
        }
        ... on DiscountCodeApp {
          status
        }
      }
    }
  }
`;

interface DiscountNodeResponse {
  data?: {
    codeDiscountNodeByCode?: {
      id: string;
      codeDiscount?: {
        status?: string;
        customerGets?: {
          value?: {
            amount?: { amount: string; currencyCode: string };
            percentage?: number;
          };
        };
      };
    } | null;
  };
  errors?: unknown[];
}

/** Stable codes; keep in sync with cart-pro-v3-runtime/src/engine/discountValidationMessages.ts */
type DiscountInvalidReason = "code_not_found" | "discount_inactive";

function parseDiscountResponse(
  json: DiscountNodeResponse,
  _code: string
):
  | { valid: true; amount: number; type: "percentage" | "fixed" }
  | { valid: false; amount: number; type: "fixed"; reason: DiscountInvalidReason } {
  // GraphQL errors (e.g. missing scope) → fall back to optimistic
  if (json.errors && Array.isArray(json.errors) && json.errors.length > 0) {
    return { valid: true, amount: 0, type: "fixed" };
  }

  const node = json?.data?.codeDiscountNodeByCode;
  if (!node) return { valid: false, amount: 0, type: "fixed", reason: "code_not_found" };

  const discount = node.codeDiscount;
  if (!discount) return { valid: false, amount: 0, type: "fixed", reason: "code_not_found" };

  // DiscountStatus is typically ACTIVE | EXPIRED | SCHEDULED; treat missing status as active (unknown union shapes).
  const status = discount.status as string | undefined;
  if (status != null && status !== "" && status !== "ACTIVE") {
    return { valid: false, amount: 0, type: "fixed", reason: "discount_inactive" };
  }

  const value = discount.customerGets?.value;
  if (value?.percentage !== undefined) {
    return { valid: true, amount: Math.round(value.percentage * 10000), type: "percentage" };
  }
  if (value?.amount?.amount) {
    return {
      valid: true,
      amount: Math.round(parseFloat(value.amount.amount) * 100),
      type: "fixed",
    };
  }

  // BXGY / FreeShipping / unknown value shape — still valid
  return { valid: true, amount: 0, type: "fixed" };
}

export async function action({ request, params }: ActionFunctionArgs) {
  const code = ((params as Record<string, string | undefined>).code ?? "").trim();

  // Remove endpoint — no-op; storefront clears discount cookie directly via /discount/remove
  if (code.toLowerCase() === "remove") {
    return Response.json({ ok: true });
  }

  if (request.method !== "POST") {
    return Response.json(
      {
        valid: false,
        code,
        amount: 0,
        type: "fixed",
        reason: "method_not_allowed",
        error: "Method not allowed",
      },
      { status: 405 }
    );
  }

  if (!code) {
    return Response.json({
      valid: false,
      code: "",
      amount: 0,
      type: "fixed",
      reason: "empty_code",
    });
  }

  /**
   * Resolve shop from app proxy session only. If proxy auth fails or session is missing, we still return
   * optimistic { valid: true } (same as when offline Admin token is missing) so the widget can call
   * GET /discount/:code on the storefront — Shopify validates there. Returning 401 made every code look
   * "invalid" in themes where proxy session is intermittently absent.
   */
  let shop: string | null = null;
  try {
    const ctx = await authenticate.public.appProxy(request);
    if (ctx.session?.shop) {
      shop = normalizeShopDomain(ctx.session.shop);
    }
  } catch {
    shop = null;
  }

  if (!shop) {
    logInfo({
      route: "cart.discounts",
      message:
        "Discount validate: no app proxy session; optimistic valid (Shopify validates at /discount/:code)",
      meta: { codeLen: code.length },
    });
    return Response.json({ valid: true, code, amount: 0, type: "fixed" });
  }

  // Try Admin GraphQL validation (requires read_discounts scope)
  let admin: AdminGraphQL | null = null;
  try {
    const unauthCtx = await shopify.unauthenticated.admin(shop);
    admin = unauthCtx?.admin ?? null;
  } catch {
    // No admin session — fall through to optimistic
  }

  if (!admin) {
    // Graceful degradation: return valid so the cookie approach works at checkout
    return Response.json({ valid: true, code, amount: 0, type: "fixed" });
  }

  try {
    const res = await admin.graphql(DISCOUNT_CODE_QUERY, { variables: { code } });
    const json: DiscountNodeResponse = await res.json().catch(() => ({}));
    const result = parseDiscountResponse(json, code);
    if (result.valid) {
      return Response.json({ valid: true, code, amount: result.amount, type: result.type });
    }
    return Response.json({
      valid: false,
      code,
      amount: result.amount,
      type: result.type,
      reason: result.reason,
    });
  } catch (err) {
    logWarn({
      shop,
      route: "cart.discounts",
      message: "Discount validation error; returning optimistic valid",
      meta: { error: err instanceof Error ? err.message : String(err) },
    });
    // Graceful fallback
    return Response.json({ valid: true, code, amount: 0, type: "fixed" });
  }
}
