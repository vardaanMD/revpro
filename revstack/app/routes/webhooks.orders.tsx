import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "~/shopify.server";
import { recordWebhook } from "~/lib/webhook-idempotency.server";
import { recordOrderSales } from "~/lib/product-metrics.server";
import { prisma } from "~/lib/prisma.server";
import { logWarn } from "~/lib/logger.server";
import { normalizeShopDomain, warnIfShopNotCanonical } from "~/lib/shop-domain.server";

function getWebhookId(request: Request): string | null {
  return request.headers.get("x-shopify-event-id");
}

function getTopicFromHeaders(request: Request): string {
  return request.headers.get("x-shopify-topic") ?? "";
}

type OrderLineItem = {
  product_id?: number | string | null;
  quantity?: number | null;
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
  if (process.env.NODE_ENV === "development" && rawShop !== shop) {
    console.warn("[WEBHOOK SHOP NORMALIZED]", rawShop, "→", shop);
  }
  const webhookId = getWebhookId(request);
  const topicResolved = topic ?? getTopicFromHeaders(request);

  if (webhookId) {
    const isNew = await recordWebhook(webhookId, shop, topicResolved);
    if (!isNew) return new Response(null, { status: 200 });
  }

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

  const lineItems = Array.isArray(payload.line_items) ? payload.line_items : [];
  const items: Array<{ productId: string; quantity: number }> = [];
  for (const item of lineItems) {
    const pid = item.product_id;
    if (pid == null) continue;
    const qty = typeof item.quantity === "number" ? item.quantity : 0;
    if (qty <= 0) continue;
    items.push({ productId: String(pid), quantity: qty });
  }

  if (items.length > 0) {
    try {
      await recordOrderSales(shop, items);
    } catch (err) {
      logWarn({
        shop,
        message: "Orders webhook: recordOrderSales failed",
        meta: { error: err instanceof Error ? err.message : String(err) },
      });
    }
  }

  const orderId = payload.id != null ? String(payload.id) : "";
  const totalPriceRaw = payload.total_price;
  const orderValueCents =
    typeof totalPriceRaw === "string"
      ? Math.round(parseFloat(totalPriceRaw) * 100)
      : typeof totalPriceRaw === "number"
        ? Math.round(totalPriceRaw * 100)
        : 0;

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

  // Store order total for "Revenue (paid orders)" when merchant has allowed order metrics.
  // When allowOrderMetrics is false, we do not store order data (merchant can turn off in Settings).
  if (orderId && orderValueCents > 0) {
    try {
      const shopConfig = await prisma.shopConfig.findUnique({
        where: { shopDomain: shop },
        select: { configV3: true },
      });
      const configV3 = shopConfig?.configV3 as { allowOrderMetrics?: boolean } | null | undefined;
      const allowOrderMetrics = configV3?.allowOrderMetrics !== false;
      if (allowOrderMetrics) {
        await prisma.orderInfluenceEvent.create({
          data: {
            shopDomain: shop,
            orderId,
            orderValue: orderValueCents,
            influenced,
          },
        });
      }
    } catch (err) {
      logWarn({
        shop,
        message: "Orders webhook: OrderInfluenceEvent create failed",
        meta: { error: err instanceof Error ? err.message : String(err) },
      });
    }
  }

  return new Response(null, { status: 200 });
};
