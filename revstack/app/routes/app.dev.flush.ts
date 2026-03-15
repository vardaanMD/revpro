/**
 * Dev-only cache flush. Admin-only. Not exposed in production.
 * GET /app/dev/flush: clear in-memory analytics caches (no-op after removal), delete Redis keys for current shop, log DB counts.
 */
import type { LoaderFunctionArgs } from "react-router";
import { data } from "react-router";
import { authenticate } from "~/shopify.server";
import { normalizeShopDomain } from "~/lib/shop-domain.server";
import { getRedis, redisKey } from "~/lib/redis.server";
import { prisma } from "~/lib/prisma.server";
import { clearAnalyticsCache } from "~/lib/analytics.server";
import { clearDashboardMetricsCache } from "~/lib/dashboard-metrics.server";

const DEV_ONLY = process.env.NODE_ENV === "development";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  if (!DEV_ONLY) {
    return data({ error: "Not available" }, { status: 404 });
  }

  let shop: string;
  try {
    const { session } = await authenticate.admin(request);
    shop = normalizeShopDomain(session.shop);
  } catch {
    return data({ error: "Unauthorized" }, { status: 401 });
  }

  clearAnalyticsCache(shop);
  clearDashboardMetricsCache(shop);

  let deletedKeys = 0;
  try {
    const redis = getRedis();
    const prefix = redisKey(shop);
    const pattern = prefix + "*";
    const keys = await redis.keys(pattern);
    if (keys.length > 0) {
      await redis.del(...keys);
      deletedKeys = keys.length;
    }
  } catch (_err) {
    // Redis flush failed; counts still returned
  }

  const [decisionMetricCount, orderInfluenceEventCount, crossSellConversionCount] =
    await Promise.all([
      prisma.decisionMetric.count({ where: { shopDomain: shop } }),
      prisma.orderInfluenceEvent.count({ where: { shopDomain: shop } }),
      prisma.crossSellConversion.count({ where: { shopDomain: shop } }),
    ]);

  return data({
    ok: true,
    shop,
    DecisionMetric: decisionMetricCount,
    OrderInfluenceEvent: orderInfluenceEventCount,
    CrossSellConversion: crossSellConversionCount,
    redisKeysDeleted: deletedKeys,
  });
};
