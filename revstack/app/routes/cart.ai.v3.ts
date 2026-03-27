/**
 * App proxy path: /apps/cart-pro/ai/v3
 * AI-powered recommendation endpoint (stub). Returns cross-sell recommendations
 * in the same Product[] shape as cart.decision.ts crossSell field.
 * Gated behind billing entitlement + rate limiting.
 */
import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "~/shopify.server";
import { normalizeShopDomain } from "~/lib/shop-domain.server";
import { getBillingContext } from "~/lib/billing-context.server";
import { checkRateLimitWithQuota } from "~/lib/rate-limit.server";
import { logWarn } from "~/lib/logger.server";
import type { Product } from "@revpro/decision-engine";

export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  let session: { shop: string };
  try {
    const ctx = await authenticate.public.appProxy(request);
    if (!ctx.session) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }
    session = ctx.session;
  } catch {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const shop = normalizeShopDomain(session.shop);
  if (!shop || shop === "unknown") {
    return Response.json({ error: "Invalid shop" }, { status: 400 });
  }

  const rateLimit = await checkRateLimitWithQuota(shop);
  if (!rateLimit.allowed) {
    return Response.json({ error: "Too many requests" }, {
      status: 429,
      headers: {
        "X-RateLimit-Limit": `${rateLimit.limit}`,
        "X-RateLimit-Remaining": `${rateLimit.remaining}`,
        "X-RateLimit-Reset": `${Math.ceil(rateLimit.resetAt / 1000)}`,
      },
    });
  }

  const billing = await getBillingContext(shop);
  if (!billing.isEntitled) {
    return Response.json({ error: "Not entitled" }, { status: 403 });
  }

  // TODO: replace with real AI model call
  // The stub returns an empty crossSell array. When the AI model is integrated,
  // it should accept the cart payload, call the model, and return Product[] recommendations.
  const crossSell: Product[] = [];

  return Response.json({
    crossSell,
    source: "ai-v3-stub",
  });
}

export async function loader() {
  return Response.json({ error: "Method not allowed" }, { status: 405 });
}
