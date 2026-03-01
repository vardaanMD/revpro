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
let lastCleanupAt: number | null = null;
let cleanupInProgress = false;

/**
 * Retention: DecisionMetric 90d, WebhookEvent 30d,
 * CrossSellEvent 90d, CrossSellConversion 90d.
 */
async function cleanupOldData(): Promise<void> {
  try {
    const now = Date.now();
    const ninetyDaysAgo = new Date(now - 90 * 24 * 60 * 60 * 1000);
    const thirtyDaysAgo = new Date(now - 30 * 24 * 60 * 60 * 1000);

    await prisma.decisionMetric.deleteMany({
      where: { createdAt: { lt: ninetyDaysAgo } },
    });
    await prisma.webhookEvent.deleteMany({
      where: { createdAt: { lt: thirtyDaysAgo } },
    });
    await prisma.crossSellEvent.deleteMany({
      where: { createdAt: { lt: ninetyDaysAgo } },
    });
    await prisma.crossSellConversion.deleteMany({
      where: { createdAt: { lt: ninetyDaysAgo } },
    });
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
