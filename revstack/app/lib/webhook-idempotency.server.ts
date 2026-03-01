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
  if (!webhookId) return true;
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
