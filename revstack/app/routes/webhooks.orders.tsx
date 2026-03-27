import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "~/shopify.server";
import { recordWebhook } from "~/lib/webhook-idempotency.server";
import { recordOrderSales } from "~/lib/product-metrics.server";
import { incrementMonthlyOrderCount } from "~/lib/order-usage.server";
import { logWarn } from "~/lib/logger.server";
import { normalizeShopDomain, warnIfShopNotCanonical } from "~/lib/shop-domain.server";

function getWebhookId(request: Request): string | null {
  return request.headers.get("x-shopify-event-id");
}

function getTopicFromHeaders(request: Request): string {
  return request.headers.get("x-shopify-topic") ?? "";
}

type OrderLineItem = {
  id?: number | string | null;
  product_id?: number | string | null;
  quantity?: number | null;
  price?: string | number | null;
};

type NoteAttribute = { name?: string; value?: string };

type OrdersPaidPayload = {
  id?: number;
  line_items?: OrderLineItem[];
  note_attributes?: NoteAttribute[];
  total_price?: string | number | null;
};

/**
 * Orders/paid webhook: record product sales for BEST_SELLING strategy.
 * Extracts line_items.product_id and quantity; idempotent per webhook event.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop: rawShop, topic } = await authenticate.webhook(request);
  const shop = normalizeShopDomain(rawShop);
  warnIfShopNotCanonical(rawShop, shop);
  const webhookId = getWebhookId(request);
  const topicResolved = topic ?? getTopicFromHeaders(request);

  // Require x-shopify-event-id for idempotency; without it retries could double-apply.
  // Return 400 so Shopify retries with the header present.
  if (!webhookId) {
    logWarn({
      shop,
      message: "Orders webhook: missing x-shopify-event-id, returning 400 to trigger retry",
      meta: { topic: topicResolved },
    });
    return new Response(null, { status: 400 });
  }

  const isNew = await recordWebhook(webhookId, shop, topicResolved);
  if (!isNew) return new Response(null, { status: 200 });

  if (request.method !== "POST") {
    return new Response(null, { status: 200 });
  }

  let payload: OrdersPaidPayload;
  try {
    payload = (await request.json()) as OrdersPaidPayload;
  } catch (err) {
    logWarn({
      shop,
      message: "Orders webhook payload parse failed",
      meta: { error: err instanceof Error ? err.message : String(err) },
    });
    return new Response(null, { status: 200 });
  }

  // orders/cancelled: paid revenue analytics removed; nothing to record.
  if (topicResolved === "orders/cancelled") {
    return new Response(null, { status: 200 });
  }

  // Below: orders/paid only.
  const orderId = payload.id != null ? String(payload.id) : "";
  const lineItems = Array.isArray(payload.line_items) ? payload.line_items : [];
  const items: Array<{ productId: string; quantity: number; lineItemId: string }> = [];
  for (let i = 0; i < lineItems.length; i++) {
    const item = lineItems[i];
    const pid = item.product_id;
    if (pid == null) continue;
    const qty = typeof item.quantity === "number" ? item.quantity : 0;
    if (qty <= 0) continue;
    const lineItemId =
      item.id != null ? String(item.id) : `${orderId}-${i}`;
    items.push({ productId: String(pid), quantity: qty, lineItemId });
  }

  if (items.length > 0 && orderId) {
    try {
      await recordOrderSales(shop, orderId, items);
    } catch (err) {
      logWarn({
        shop,
        message: "Orders webhook: recordOrderSales failed",
        meta: { error: err instanceof Error ? err.message : String(err) },
      });
    }
  }

  // Increment monthly order count for usage-based billing (fire-and-forget).
  await incrementMonthlyOrderCount(shop);

  return new Response(null, { status: 200 });
};
