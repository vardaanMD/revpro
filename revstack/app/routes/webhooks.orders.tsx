import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "~/shopify.server";
import { recordWebhook } from "~/lib/webhook-idempotency.server";
import { recordOrderSales } from "~/lib/product-metrics.server";
import { prisma } from "~/lib/prisma.server";
import { logWarn, logInfo } from "~/lib/logger.server";
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
  if (!webhookId) {
    logWarn({
      shop,
      message: "Orders webhook: missing x-shopify-event-id, returning 200 without processing",
      meta: { topic: topicResolved },
    });
    return new Response(null, { status: 200 });
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

  // orders/cancelled: remove this order from revenue so analytics reflects net paid revenue.
  if (topicResolved === "orders/cancelled") {
    const orderId = payload.id != null ? String(payload.id) : "";
    if (orderId) {
      try {
        const deleted = await prisma.orderInfluenceEvent.deleteMany({
          where: { shopDomain: shop, orderId },
        });
        if (deleted.count > 0) {
          logInfo({
            shop,
            message: "Orders webhook: revenue removed (order cancelled)",
            meta: { orderId },
          });
        }
      } catch (err) {
        logWarn({
          shop,
          message: "Orders webhook: failed to remove revenue for cancelled order",
          meta: { orderId, error: err instanceof Error ? err.message : String(err) },
        });
      }
    }
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

  const totalPriceRaw = payload.total_price;
  let orderValueCents =
    typeof totalPriceRaw === "string"
      ? Math.round(parseFloat(totalPriceRaw) * 100)
      : typeof totalPriceRaw === "number"
        ? Math.round(totalPriceRaw * 100)
        : 0;
  // Fallback: some payloads (e.g. draft order marked paid) may omit total_price; derive from line_items.
  if (orderValueCents <= 0 && lineItems.length > 0) {
    let fromLines = 0;
    for (const item of lineItems) {
      const qty = typeof item.quantity === "number" ? item.quantity : 0;
      const price =
        typeof item.price === "string"
          ? parseFloat(item.price)
          : typeof item.price === "number"
            ? item.price
            : 0;
      fromLines += Math.round((price * qty) * 100);
    }
    if (fromLines > 0) orderValueCents = fromLines;
  }

  const noteAttrs = Array.isArray(payload.note_attributes) ? payload.note_attributes : [];
  const revproSessionIdAttr = noteAttrs.find(
    (a) => a && a.name === "revpro_session_id" && typeof a.value === "string"
  );
  const revproSessionId = revproSessionIdAttr?.value?.trim() ?? null;

  let influenced = false;
  if (revproSessionId && orderId) {
    try {
      const clickSession = await prisma.revproClickSession.findUnique({
        where: { shopDomain_revproSessionId: { shopDomain: shop, revproSessionId } },
      });
      if (clickSession) {
        const clickedIds = Array.isArray(clickSession.clickedProductIds)
          ? (clickSession.clickedProductIds as string[]).map(String)
          : [];
        const orderProductIds = new Set(
          lineItems.map((item) => (item.product_id != null ? String(item.product_id) : null)).filter(Boolean) as string[]
        );
        influenced = clickedIds.some((id) => orderProductIds.has(id));
      }
    } catch (err) {
      logWarn({
        shop,
        message: "Orders webhook: OrderInfluenceEvent lookup/insert failed",
        meta: { error: err instanceof Error ? err.message : String(err) },
      });
    }
  }

  // Store order total for revenue metrics. Permission to read orders is granted on install.
  if (!orderId) {
    logInfo({
      shop,
      message: "Orders webhook: skipping revenue (no order id)",
      meta: { topic: topicResolved },
    });
  } else if (orderValueCents <= 0) {
    logInfo({
      shop,
      message: "Orders webhook: skipping revenue (order value 0 or missing total_price)",
      meta: { orderId, topic: topicResolved },
    });
  } else {
    try {
      await prisma.orderInfluenceEvent.upsert({
        where: {
          shopDomain_orderId: { shopDomain: shop, orderId },
        },
        create: {
          shopDomain: shop,
          orderId,
          orderValue: orderValueCents,
          influenced,
        },
        update: {
          orderValue: orderValueCents,
          influenced,
        },
      });
      logInfo({
        shop,
        message: "Orders webhook: revenue recorded",
        meta: { orderId, orderValueCents, influenced },
      });
    } catch (err) {
      logWarn({
        shop,
        message: "Orders webhook: OrderInfluenceEvent upsert failed",
        meta: { orderId, error: err instanceof Error ? err.message : String(err) },
      });
    }
  }

  return new Response(null, { status: 200 });
};
