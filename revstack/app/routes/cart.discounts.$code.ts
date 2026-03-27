/**
 * App proxy path: /apps/cart-pro/discounts/:code (POST) and /apps/cart-pro/discounts/remove (POST)
 * Validates a Shopify discount code via Admin GraphQL and returns { valid, code, amount, type }.
 * The remove endpoint is a no-op on the backend; the storefront widget clears the discount cookie directly.
 * Never throws 500 — always returns JSON so storefront gracefully degrades.
 */
import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "~/shopify.server";
import { normalizeShopDomain } from "~/lib/shop-domain.server";
import shopify from "~/shopify.server";
import { logWarn } from "~/lib/logger.server";

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
}

async function validateCodeViaAdmin(
  admin: AdminGraphQL,
  code: string
): Promise<{ valid: boolean; amount: number; type: "percentage" | "fixed" }> {
  const res = await admin.graphql(DISCOUNT_CODE_QUERY, { variables: { code } });
  const json: DiscountNodeResponse = await res.json().catch(() => ({}));

  const node = json?.data?.codeDiscountNodeByCode;
  if (!node) return { valid: false, amount: 0, type: "fixed" };

  const discount = node.codeDiscount;
  if (!discount) return { valid: false, amount: 0, type: "fixed" };

  const status = discount.status;
  if (status && status !== "ACTIVE") return { valid: false, amount: 0, type: "fixed" };

  const value = discount.customerGets?.value;
  if (value?.percentage !== undefined) {
    // percentage is 0–1 (e.g. 0.1 = 10%). Convert to human-readable integer cents equivalent (0–10000).
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

  // Handle remove endpoint — no-op on backend; storefront clears discount cookie directly
  if (code.toLowerCase() === "remove") {
    return Response.json({ ok: true });
  }

  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }
  if (!code) {
    return Response.json({ valid: false, code: "", amount: 0, type: "fixed" });
  }

  let shop: string;
  let admin: AdminGraphQL | null = null;

  try {
    const ctx = await authenticate.public.appProxy(request);
    if (!ctx.session) {
      return Response.json(
        { valid: false, code, amount: 0, type: "fixed" },
        { status: 401 }
      );
    }
    shop = normalizeShopDomain(ctx.session.shop);
    // authenticate.public.appProxy may return admin — use it if present
    if ((ctx as unknown as { admin?: AdminGraphQL }).admin) {
      admin = (ctx as unknown as { admin: AdminGraphQL }).admin;
    }
  } catch {
    return Response.json({ valid: false, code, amount: 0, type: "fixed" }, { status: 401 });
  }

  // Fall back to unauthenticated admin if appProxy didn't return one
  if (!admin) {
    try {
      const unauthCtx = await shopify.unauthenticated.admin(shop);
      admin = unauthCtx?.admin ?? null;
    } catch {
      // ignore
    }
  }

  if (!admin) {
    logWarn({ shop, route: "cart.discount", message: "No admin context; returning valid: false" });
    return Response.json({ valid: false, code, amount: 0, type: "fixed" });
  }

  try {
    const result = await validateCodeViaAdmin(admin, code);
    return Response.json({ ...result, code });
  } catch (err) {
    logWarn({
      shop,
      route: "cart.discount",
      message: "Discount validation error",
      meta: { error: err instanceof Error ? err.message : String(err) },
    });
    return Response.json({ valid: false, code, amount: 0, type: "fixed" });
  }
}
