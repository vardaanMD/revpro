/**
 * Monthly order counting for usage-based billing tiers.
 * Upserts MonthlyOrderCount on each orders/paid webhook.
 * Used by billing-context to expose order volume and plan limits.
 */
import { prisma } from "~/lib/prisma.server";
import { logWarn } from "~/lib/logger.server";

/**
 * Atomically increment the order count for the current calendar month.
 * Safe to call multiple times for the same webhook (idempotency is handled
 * by the webhook layer, not here).
 */
export async function incrementMonthlyOrderCount(shop: string): Promise<void> {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth() + 1; // 1-12

  try {
    await prisma.monthlyOrderCount.upsert({
      where: { shopDomain_year_month: { shopDomain: shop, year, month } },
      create: { shopDomain: shop, year, month, orderCount: 1 },
      update: { orderCount: { increment: 1 } },
    });
  } catch (err) {
    logWarn({
      shop,
      message: "Failed to increment monthly order count",
      meta: { error: err instanceof Error ? err.message : String(err), year, month },
    });
  }
}

/**
 * Returns the order count for a given month (defaults to current month).
 */
export async function getMonthlyOrderCount(
  shop: string,
  year?: number,
  month?: number
): Promise<number> {
  const now = new Date();
  const y = year ?? now.getUTCFullYear();
  const m = month ?? now.getUTCMonth() + 1;

  try {
    const row = await prisma.monthlyOrderCount.findUnique({
      where: { shopDomain_year_month: { shopDomain: shop, year: y, month: m } },
      select: { orderCount: true },
    });
    return row?.orderCount ?? 0;
  } catch (err) {
    logWarn({
      shop,
      message: "Failed to read monthly order count; returning 0",
      meta: { error: err instanceof Error ? err.message : String(err) },
    });
    return 0;
  }
}
