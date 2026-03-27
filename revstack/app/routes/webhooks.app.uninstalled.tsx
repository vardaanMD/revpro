/**
 * app/uninstalled webhook: delete all app data for the shop (same as shop/redact).
 * Single code path via deleteShopData.
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

function getTopicFromHeaders(request: Request): string {
  return request.headers.get("x-shopify-topic") ?? "";
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop: rawShop, topic } = await authenticate.webhook(request);
  const shop = normalizeShopDomain(rawShop);
  warnIfShopNotCanonical(rawShop, shop);
  const webhookId = getWebhookId(request);
  const topicResolved = topic ?? getTopicFromHeaders(request);

  // Idempotency note: proceeds without event ID because deleteShopData is
  // inherently idempotent — deleting already-deleted data is a no-op.
  // Critical to process even without header since uninstall must always clean up.
  if (webhookId) {
    const isNew = await recordWebhook(webhookId, shop, topicResolved);
    if (!isNew) return new Response(null, { status: 200 });
  } else {
    logWarn({
      shop,
      message: "Uninstall webhook: missing x-shopify-event-id header, skipping idempotency check",
      meta: { topic: topicResolved },
    });
  }

  await deleteShopData(shop);

  return new Response(null, { status: 200 });
};
