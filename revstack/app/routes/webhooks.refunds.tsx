import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "~/shopify.server";
import { recordWebhook } from "~/lib/webhook-idempotency.server";
import { prisma } from "~/lib/prisma.server";
import { logWarn, logInfo } from "~/lib/logger.server";
import { normalizeShopDomain, warnIfShopNotCanonical } from "~/lib/shop-domain.server";

function getWebhookId(request: Request): string | null {
  return request.headers.get("x-shopify-event-id");
}

function getTopicFromHeaders(request: Request): string {
  return request.headers.get("x-shopify-topic") ?? "";
}

type RefundTransaction = {
  kind?: string;
  amount?: string | number | null;
};

type RefundsCreatePayload = {
  order_id?: number;
  transactions?: RefundTransaction[];
};

/**
 * refunds/create webhook: add refund amount to OrderInfluenceEvent.refundedCents
 * so analytics net revenue = orderValue - refundedCents.
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

  // Payload may be top-level or wrapped in "refund" (e.g. REST-style webhook).
  const raw = (payload as { refund?: RefundsCreatePayload }).refund ?? payload;
  const orderId = raw.order_id != null ? String(raw.order_id) : "";
  const transactions = Array.isArray(raw.transactions) ? raw.transactions : [];
  let refundCents = 0;
  for (const tx of transactions) {
    if (tx.kind !== "refund") continue;
    const a = tx.amount;
    const amount =
      typeof a === "string"
        ? parseFloat(a)
        : typeof a === "number"
          ? a
          : 0;
    if (Number.isFinite(amount) && amount > 0) {
      refundCents += Math.round(amount * 100);
    }
  }

  if (!orderId || refundCents <= 0) {
    return new Response(null, { status: 200 });
  }

  try {
    // Atomic update: no read-modify-write race. Single SQL statement ensures
    // concurrent refund webhooks for the same order don't lose data.
    const rowsAffected = await prisma.$executeRaw`
      UPDATE "OrderInfluenceEvent"
      SET "refundedCents" = LEAST("orderValue", "refundedCents" + ${refundCents})
      WHERE "shopDomain" = ${shop} AND "orderId" = ${orderId}
    `;
    if (rowsAffected === 0) {
      // Order not tracked (e.g. paid before app install); nothing to adjust.
      return new Response(null, { status: 200 });
    }
    logInfo({
      shop,
      message: "Refunds webhook: revenue adjusted",
      meta: { orderId, refundCents },
    });
  } catch (err) {
    logWarn({
      shop,
      message: "Refunds webhook: failed to update OrderInfluenceEvent",
      meta: { orderId, error: err instanceof Error ? err.message : String(err) },
    });
  }

  return new Response(null, { status: 200 });
};
