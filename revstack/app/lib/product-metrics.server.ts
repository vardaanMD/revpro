/**
 * Product sales metrics for BEST_SELLING strategy.
 * Rolling 30-day sales count per product; recorded via order webhook.
 */
import { prisma } from "~/lib/prisma.server";

const ROLLING_DAYS = 30;

/**
 * Records sold quantities for an order. Call from orders/paid webhook.
 * Idempotent: same (shopDomain, orderId, lineItemId) is skipped (skipDuplicates).
 * Use Shopify line_item.id as lineItemId when present; otherwise orderId-index.
 */
export async function recordOrderSales(
  shopDomain: string,
  orderId: string,
  lineItems: Array<{ productId: string; quantity: number; lineItemId: string }>
): Promise<void> {
  if (lineItems.length === 0 || !orderId) return;
  await prisma.productSaleEvent.createMany({
    data: lineItems.map((item) => ({
      shopDomain,
      orderId,
      lineItemId: item.lineItemId,
      productId: String(item.productId),
      quantity: Math.max(0, Math.floor(item.quantity)),
    })),
    skipDuplicates: true,
  });
}

/**
 * Reverses sales for refunded line items. Deletes matching ProductSaleEvent rows
 * so BEST_SELLING counts stay accurate. Idempotent: if rows don't exist, no-op.
 * Call from refunds/create webhook.
 */
export async function reverseOrderSales(
  shopDomain: string,
  orderId: string,
  lineItemIds: string[]
): Promise<void> {
  if (lineItemIds.length === 0 || !orderId) return;
  await prisma.productSaleEvent.deleteMany({
    where: {
      shopDomain,
      orderId,
      lineItemId: { in: lineItemIds },
    },
  });
}

/**
 * Returns map of productId -> total quantity sold in the last 30 days for the shop.
 * Used by BEST_SELLING to sort catalog by sales count descending.
 */
export async function getProductSalesCounts30d(
  shopDomain: string
): Promise<Record<string, number>> {
  const since = new Date(Date.now() - ROLLING_DAYS * 24 * 60 * 60 * 1000);
  const rows = await prisma.productSaleEvent.groupBy({
    by: ["productId"],
    where: { shopDomain, soldAt: { gte: since } },
    _sum: { quantity: true },
  });
  const out: Record<string, number> = {};
  for (const r of rows) {
    const sum = r._sum.quantity ?? 0;
    if (sum > 0) out[r.productId] = sum;
  }
  return out;
}
