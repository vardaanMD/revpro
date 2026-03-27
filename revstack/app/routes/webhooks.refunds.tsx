/**
 * refunds/create webhook: decrement BEST_SELLING sales volume for refunded line items.
 * Deletes matching ProductSaleEvent rows so recommendation scores stay accurate.
 * Idempotent via x-shopify-event-id + recordWebhook.
 */
import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "~/shopify.server";
import { recordWebhook } from "~/lib/webhook-idempotency.server";
import { reverseOrderSales } from "~/lib/product-metrics.server";
import { logWarn } from "~/lib/logger.server";
import { normalizeShopDomain, warnIfShopNotCanonical } from "~/lib/shop-domain.server";

function getWebhookId(request: Request): string | null {
  return request.headers.get("x-shopify-event-id");
}

function getTopicFromHeaders(request: Request): string {
  return request.headers.get("x-shopify-topic") ?? "";
}

type RefundLineItem = {
  line_item_id?: number | string | null;
  line_item?: { product_id?: number | string | null } | null;
  quantity?: number | null;
};

type RefundsCreatePayload = {
  id?: number;
  order_id?: number;
  refund_line_items?: RefundLineItem[];
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop: rawShop, topic } = await authenticate.webhook(request);
  const shop = normalizeShopDomain(rawShop);
  warnIfShopNotCanonical(rawShop, shop);
  const webhookId = getWebhookId(request);
  const topicResolved = topic ?? getTopicFromHeaders(request);

  // Require x-shopify-event-id for idempotency; return 400 so Shopify retries.
  if (!webhookId) {
    logWarn({
      shop,
      message: "Refunds webhook: missing x-shopify-event-id, returning 400 to trigger retry",
      meta: { topic: topicResolved },
    });
    return new Response(null, { status: 400 });
  }

  const isNew = await recordWebhook(webhookId, shop, topicResolved);
  if (!isNew) return new Response(null, { status: 200 });

  if (request.method !== "POST") {
    return new Response(null, { status: 200 });
  }

  let payload: RefundsCreatePayload;
  try {
    payload = (await request.json()) as RefundsCreatePayload;
  } catch (err) {
    logWarn({
      shop,
      message: "Refunds webhook payload parse failed",
      meta: { error: err instanceof Error ? err.message : String(err) },
    });
    return new Response(null, { status: 200 });
  }

  const orderId = payload.order_id != null ? String(payload.order_id) : "";
  const refundLineItems = Array.isArray(payload.refund_line_items) ? payload.refund_line_items : [];

  // Collect line_item_ids to delete from ProductSaleEvent.
  // Shopify refund payload has refund_line_items[].line_item_id which matches
  // the original order line_item.id we stored as lineItemId in recordOrderSales.
  const lineItemIds: string[] = [];
  for (const rli of refundLineItems) {
    const liId = rli.line_item_id;
    if (liId != null) {
      lineItemIds.push(String(liId));
    }
  }

  if (lineItemIds.length > 0 && orderId) {
    try {
      await reverseOrderSales(shop, orderId, lineItemIds);
    } catch (err) {
      logWarn({
        shop,
        message: "Refunds webhook: reverseOrderSales failed",
        meta: { error: err instanceof Error ? err.message : String(err) },
      });
    }
  }

  return new Response(null, { status: 200 });
};
