/**
 * INTENTIONAL MULTI-TENANT CLEANUP
 *
 * This job deletes expired historical data across ALL shops.
 * It does NOT read or return cross-tenant data.
 * It is safe because it only removes old rows based on timestamp.
 *
 * Do NOT add read queries here.
 *
 * ---
 * Opportunistic retention cleanup — not a cron.
 * Runs at most once per CLEANUP_INTERVAL_MS per instance, triggered after decision
 * metric write. For higher scale, consider a dedicated background worker; no
 * external services or cron dependencies are added here.
 */

import { prisma } from "~/lib/prisma.server";
import { logError } from "~/lib/logger.server";

const CLEANUP_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes
const BATCH_LIMIT = 10_000;
let lastCleanupAt: number | null = null;
let cleanupInProgress = false;

/**
 * Batched delete by date column using Prisma only (no raw SQL).
 * Selects up to BATCH_LIMIT ids, then deleteMany; repeats until no rows.
 * Avoids $executeRawUnsafe and keeps identifiers out of user control.
 */
async function batchDeleteByDate<K extends string>(
  delegate: { findMany: (args: { where: Record<string, unknown>; take: number; select: { id: true } }) => Promise<{ id: string }[]>; deleteMany: (args: { where: { id: { in: string[] } } }) => Promise<unknown> },
  dateColumn: K,
  cutoff: Date
): Promise<void> {
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const rows = await delegate.findMany({
      where: { [dateColumn]: { lt: cutoff } } as { [key in K]: { lt: Date } },
      take: BATCH_LIMIT,
      select: { id: true },
    });
    if (rows.length === 0) break;
    await delegate.deleteMany({ where: { id: { in: rows.map((r) => r.id) } } });
  }
}

/**
 * Retention: DecisionMetric 90d, WebhookEvent 30d,
 * CrossSellEvent 90d, CrossSellConversion 90d, CartProEventV3 90d,
 * ProductSaleEvent 90d (BEST_SELLING uses 30d window; 90d keeps buffer),
 * (paid order revenue analytics removed).
 */
async function cleanupOldData(): Promise<void> {
  try {
    const now = Date.now();
    const ninetyDaysAgo = new Date(now - 90 * 24 * 60 * 60 * 1000);
    const thirtyDaysAgo = new Date(now - 30 * 24 * 60 * 60 * 1000);

    await batchDeleteByDate(prisma.decisionMetric, "createdAt", ninetyDaysAgo);
    await batchDeleteByDate(prisma.webhookEvent, "createdAt", thirtyDaysAgo);
    await batchDeleteByDate(prisma.crossSellEvent, "createdAt", ninetyDaysAgo);
    await batchDeleteByDate(prisma.crossSellConversion, "createdAt", ninetyDaysAgo);
    await batchDeleteByDate(prisma.cartProEventV3, "timestamp", ninetyDaysAgo);
    await batchDeleteByDate(prisma.productSaleEvent, "soldAt", ninetyDaysAgo);
    // MonthlyOrderCount: keep 12 months for historical billing reference.
    const twelveMonthsAgo = new Date(now - 365 * 24 * 60 * 60 * 1000);
    await batchDeleteByDate(prisma.monthlyOrderCount, "createdAt", twelveMonthsAgo);
    // OrderInfluenceEvent cleanup removed (paid order revenue analytics removed).
  } catch (err) {
    logError({
      message: "Retention cleanup failed",
      meta: { error: err instanceof Error ? err.message : String(err) },
    });
  }
}

function runCleanupAsync(): void {
  cleanupOldData().finally(() => {
    cleanupInProgress = false;
  });
}

/**
 * Triggers retention cleanup if the throttle interval has passed. Non-blocking;
 * must not be awaited. Safe to call from the decision route — never throws.
 */
export function triggerCleanupIfNeeded(): void {
  const now = Date.now();
  if (cleanupInProgress) return;
  if (lastCleanupAt !== null && now - lastCleanupAt < CLEANUP_INTERVAL_MS) return;

  lastCleanupAt = now;
  cleanupInProgress = true;
  runCleanupAsync();
}
