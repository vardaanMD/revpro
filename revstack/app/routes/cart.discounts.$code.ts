/**
 * App proxy path: /apps/cart-pro/discounts/:code (POST) and /apps/cart-pro/discounts/remove (POST)
 *
 * Validation strategy: this route acts as a proxy-auth gate and returns optimistic { valid: true }
 * for any non-empty code. Actual discount validity is confirmed client-side after the Shopify
 * discount cookie is set and cart.js is synced — if the code doesn't appear in discount_codes_applied
 * the engine reverts the state. This avoids requiring the read_discounts Admin API scope.
 *
 * Remove endpoint is a no-op on the backend; the storefront widget calls /discount/remove directly.
 * Never throws 500 — always returns JSON.
 */
import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "~/shopify.server";

export async function action({ request, params }: ActionFunctionArgs) {
  const code = ((params as Record<string, string | undefined>).code ?? "").trim();

  // Remove endpoint — no-op; storefront clears discount cookie directly via /discount/remove
  if (code.toLowerCase() === "remove") {
    return Response.json({ ok: true });
  }

  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  if (!code) {
    return Response.json({ valid: false, code: "", amount: 0, type: "fixed" });
  }

  // Verify the request is a legitimate Shopify App Proxy request
  try {
    const ctx = await authenticate.public.appProxy(request);
    if (!ctx.session) {
      return Response.json({ valid: false, code, amount: 0, type: "fixed" }, { status: 401 });
    }
  } catch {
    return Response.json({ valid: false, code, amount: 0, type: "fixed" }, { status: 401 });
  }

  // Return optimistic valid — the engine verifies by checking cart.js after applying the cookie
  return Response.json({ valid: true, code, amount: 0, type: "fixed" });
}
