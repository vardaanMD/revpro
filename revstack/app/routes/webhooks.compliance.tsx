/**
 * Single endpoint for all mandatory GDPR/compliance webhooks.
 * Shopify sends customers/data_request, customers/redact, and shop/redact to this URI.
 * authenticate.webhook() validates HMAC and topic; we must return 200 to acknowledge.
 * shop/redact: delete all app data for the shop. customers/*: we do not store customer PII by customer id; acknowledge only.
 */
import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "~/shopify.server";
import { recordWebhook } from "~/lib/webhook-idempotency.server";
import { logWarn } from "~/lib/logger.server";
import { normalizeShopDomain, warnIfShopNotCanonical } from "~/lib/shop-domain.server";
import { deleteShopData } from "~/lib/redact.server";

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
  const topic =
    (auth as { topic?: string }).topic ?? getTopicFromHeaders(request);

  if (!webhookId) {
    logWarn({
      shop,
      message: "Compliance webhook: missing x-shopify-event-id, returning 200 without processing",
      meta: { topic },
    });
    return Response.json({ ok: true }, { status: 200 });
  }

  const isNew = await recordWebhook(webhookId, shop, topic);
  if (!isNew) return Response.json({ ok: true }, { status: 200 });

  if (topic === "shop/redact") {
    await deleteShopData(shop);
  }
  // customers/data_request and customers/redact: we do not store customer PII by customer id; acknowledge only.

  return Response.json({ ok: true }, { status: 200 });
};
