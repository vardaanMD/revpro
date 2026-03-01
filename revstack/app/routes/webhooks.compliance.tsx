/**
 * Single endpoint for all mandatory GDPR/compliance webhooks.
 * Shopify sends customers/data_request, customers/redact, and shop/redact to this URI.
 * authenticate.webhook() validates HMAC and topic; we must return 200 to acknowledge.
 */
import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "~/shopify.server";
import { recordWebhook } from "~/lib/webhook-idempotency.server";
import { normalizeShopDomain, warnIfShopNotCanonical } from "~/lib/shop-domain.server";

function getWebhookId(request: Request): string | null {
  return request.headers.get("x-shopify-event-id");
}

function getShopFromHeaders(request: Request): string {
  return request.headers.get("x-shopify-shop-domain") ?? "";
}

function getTopicFromHeaders(request: Request): string {
  return request.headers.get("x-shopify-topic") ?? "";
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const auth = await authenticate.webhook(request);
  const webhookId = getWebhookId(request);
  const rawShop =
    (auth as { shop?: string }).shop ?? getShopFromHeaders(request);
  const shop = normalizeShopDomain(rawShop);
  warnIfShopNotCanonical(rawShop, shop);
  if (process.env.NODE_ENV === "development" && rawShop !== shop) {
    console.warn("[WEBHOOK SHOP NORMALIZED]", rawShop, "→", shop);
  }
  const topic =
    (auth as { topic?: string }).topic ?? getTopicFromHeaders(request);

  if (webhookId) {
    const isNew = await recordWebhook(webhookId, shop, topic);
    if (!isNew) return Response.json({ ok: true }, { status: 200 });
  }

  return Response.json({ ok: true }, { status: 200 });
};
