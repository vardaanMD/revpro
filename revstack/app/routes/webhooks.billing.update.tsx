import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "~/shopify.server";
import { prisma } from "~/lib/prisma.server";
import { invalidateShopConfigCache } from "~/lib/shop-config.server";
import { recordWebhook } from "~/lib/webhook-idempotency.server";
import { logWarn } from "~/lib/logger.server";
import { normalizeShopDomain, warnIfShopNotCanonical } from "~/lib/shop-domain.server";

function getWebhookId(request: Request): string | null {
  return request.headers.get("x-shopify-event-id");
}

function getTopicFromHeaders(request: Request): string {
  return request.headers.get("x-shopify-topic") ?? "";
}

type AppSubscriptionUpdatePayload = {
  app_subscription?: {
    id?: string;
    status?: string;
    name?: string;
  };
};

const TERMINAL_STATUSES = ["CANCELLED", "DECLINED", "EXPIRED"];

/** Derive plan from subscription name (e.g. "Growth Plan" -> "growth"). */
function planFromSubscriptionName(name: string | undefined): "basic" | "advanced" | "growth" {
  if (!name || typeof name !== "string") return "basic";
  const n = name.toLowerCase();
  if (n.includes("growth")) return "growth";
  if (n.includes("advanced")) return "advanced";
  return "basic";
}

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

  let payload: AppSubscriptionUpdatePayload;
  try {
    payload = (await request.json()) as AppSubscriptionUpdatePayload;
  } catch (err) {
    logWarn({
      shop,
      message: "Billing webhook payload parse failed",
      meta: { error: err instanceof Error ? err.message : String(err) },
    });
    return new Response(null, { status: 200 });
  }

  const status = payload.app_subscription?.status;
  const subscriptionId = payload.app_subscription?.id;

  if (status && TERMINAL_STATUSES.includes(status.toUpperCase())) {
    const config = await prisma.shopConfig.findUnique({
      where: { shopDomain: shop },
    });
    if (!config) return new Response(null, { status: 200 });
    if (config.billingId !== subscriptionId) return new Response(null, { status: 200 });
    await prisma.shopConfig.update({
      where: { shopDomain: shop },
      data: { billingStatus: "cancelled" },
    });
    invalidateShopConfigCache(shop);
  } else if (status?.toUpperCase() === "ACTIVE" && subscriptionId) {
    const plan = planFromSubscriptionName(payload.app_subscription?.name);
    await prisma.shopConfig.updateMany({
      where: { shopDomain: shop, billingId: subscriptionId },
      data: { billingStatus: "active", plan },
    });
    invalidateShopConfigCache(shop);
  } else if (status?.toUpperCase() === "PAST_DUE") {
    const where = subscriptionId
      ? { shopDomain: shop, billingId: subscriptionId }
      : { shopDomain: shop };
    await prisma.shopConfig.updateMany({
      where,
      data: { billingStatus: "past_due" },
    });
    invalidateShopConfigCache(shop);
  }

  return new Response(null, { status: 200 });
};
