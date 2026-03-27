import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "~/shopify.server";
import { warmCatalogForShop } from "~/lib/catalog-warm.server";
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
 * Products webhook: on product create/update/delete, warm the shop catalog so
 * /cart/decision can serve from Redis/memory. Idempotent.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop: rawShop, topic } = await authenticate.webhook(request);
  const shop = normalizeShopDomain(rawShop);
  warnIfShopNotCanonical(rawShop, shop);
  const webhookId = getWebhookId(request);
  const topicResolved = topic ?? getTopicFromHeaders(request);

  // Idempotency note: proceeds without event ID because warmCatalogForShop is
  // inherently idempotent — it upserts the full catalog and deletes stale products.
  // Re-running the same webhook produces the same catalog state.
  if (webhookId) {
    const isNew = await recordWebhook(webhookId, shop, topicResolved);
    if (!isNew) return new Response(null, { status: 200 });
  }

  if (request.method !== "POST") {
    return new Response(null, { status: 200 });
  }

  try {
    await warmCatalogForShop(shop);
  } catch (err) {
    logWarn({
      shop,
      message: "Products webhook: catalog warm failed",
      meta: { error: err instanceof Error ? err.message : String(err) },
    });
  }

  return new Response(null, { status: 200 });
};
