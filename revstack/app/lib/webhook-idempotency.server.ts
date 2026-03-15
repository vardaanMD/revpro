import { prisma } from "~/lib/prisma.server";

/**
 * Atomically records a webhook event. Returns true if this was a new event
 * (inserted), false if duplicate (unique constraint violation).
 * Callers should return 200 without processing when false.
 */
export async function recordWebhook(
  webhookId: string,
  shop: string,
  topic: string
): Promise<boolean> {
  if (!webhookId) return false;
  try {
    await prisma.webhookEvent.create({
      data: { webhookId, shopDomain: shop, topic },
    });
    return true;
  } catch (e: unknown) {
    const prismaError = e as { code?: string };
    if (prismaError.code === "P2002") {
      return false;
    }
    throw e;
  }
}

/**
 * Read-only idempotency check: returns true if this webhookId was already
 * processed. Does NOT mark it as processed. Use with markWebhookProcessed
 * for handlers where side effects must complete before marking done.
 */
export async function isWebhookProcessed(webhookId: string): Promise<boolean> {
  if (!webhookId) return false;
  const existing = await prisma.webhookEvent.findUnique({
    where: { webhookId },
    select: { webhookId: true },
  });
  return existing !== null;
}

/**
 * Marks a webhook as processed. Call AFTER side effects succeed so that
 * Shopify retries re-execute if effects fail.
 */
export async function markWebhookProcessed(
  webhookId: string,
  shop: string,
  topic: string
): Promise<void> {
  if (!webhookId) return;
  try {
    await prisma.webhookEvent.create({
      data: { webhookId, shopDomain: shop, topic },
    });
  } catch (e: unknown) {
    const prismaError = e as { code?: string };
    if (prismaError.code === "P2002") {
      // Already marked — harmless (e.g. concurrent retry).
      return;
    }
    throw e;
  }
}
