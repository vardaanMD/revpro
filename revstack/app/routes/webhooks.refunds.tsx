import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "~/shopify.server";
import { recordWebhook } from "~/lib/webhook-idempotency.server";
import { logWarn } from "~/lib/logger.server";
import { normalizeShopDomain, warnIfShopNotCanonical } from "~/lib/shop-domain.server";

function getWebhookId(request: Request): string | null {
  return request.headers.get("x-shopify-event-id");
}

function getTopicFromHeaders(request: Request): string {
  return request.headers.get("x-shopify-topic") ?? "";
}

/**
 * refunds/create webhook:
 * paid revenue analytics removed, so we intentionally do nothing besides idempotency.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop: rawShop, topic } = await authenticate.webhook(request);
  const shop = normalizeShopDomain(rawShop);
  warnIfShopNotCanonical(rawShop, shop);
  const webhookId = getWebhookId(request);
  const topicResolved = topic ?? getTopicFromHeaders(request);

  if (!webhookId) {
    logWarn({
      shop,
      message: "Refunds webhook: missing x-shopify-event-id, returning 200 without processing",
      meta: { topic: topicResolved },
    });
    return new Response(null, { status: 200 });
  }

  const isNew = await recordWebhook(webhookId, shop, topicResolved);
  if (!isNew) return new Response(null, { status: 200 });

  if (request.method !== "POST") {
    return new Response(null, { status: 200 });
  }

  return new Response(null, { status: 200 });
};
