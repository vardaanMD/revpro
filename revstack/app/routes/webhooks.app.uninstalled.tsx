import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { prisma } from "~/lib/prisma.server";
import { recordWebhook } from "~/lib/webhook-idempotency.server";
import { normalizeShopDomain, warnIfShopNotCanonical } from "~/lib/shop-domain.server";

function getWebhookId(request: Request): string | null {
  return request.headers.get("x-shopify-event-id");
}

function getTopicFromHeaders(request: Request): string {
  return request.headers.get("x-shopify-topic") ?? "";
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop: rawShop, session, topic } = await authenticate.webhook(request);
  const shop = normalizeShopDomain(rawShop);
  warnIfShopNotCanonical(rawShop, shop);
  if (process.env.NODE_ENV === "development" && rawShop !== shop) {
    console.warn("[WEBHOOK SHOP NORMALIZED]", rawShop, "→", shop);
  }
  const webhookId = getWebhookId(request);

  if (webhookId) {
    const isNew = await recordWebhook(webhookId, shop, topic ?? getTopicFromHeaders(request));
    if (!isNew) return new Response(null, { status: 200 });
  }

  if (session) {
    await prisma.session.deleteMany({ where: { shop } });
  }

  return new Response(null, { status: 200 });
};
