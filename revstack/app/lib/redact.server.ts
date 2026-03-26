/**
 * GDPR redact: delete shop or customer data when Shopify sends compliance webhooks.
 * shop/redact → delete all data for the shop.
 * customers/redact → we do not store customer PII by customer id; acknowledge only.
 */
import { prisma } from "~/lib/prisma.server";
import { logWarn, logInfo } from "~/lib/logger.server";
import { invalidateShopConfigCache } from "~/lib/shop-config.server";

/**
 * Deletes all app data for the given shop (shop/redact).
 * Uses a Prisma interactive transaction for atomicity: if the process crashes
 * mid-delete, nothing is committed and the webhook retry will re-attempt cleanly.
 */
export async function deleteShopData(shop: string): Promise<void> {
  try {
    await prisma.$transaction(async (tx) => {
      // Session uses `shop` field (not `shopDomain`) per Shopify's session schema
      await tx.session.deleteMany({ where: { shop } });
      await tx.webhookEvent.deleteMany({ where: { shopDomain: shop } });
      await tx.decisionMetric.deleteMany({ where: { shopDomain: shop } });
      await tx.crossSellEvent.deleteMany({ where: { shopDomain: shop } });
      await tx.crossSellConversion.deleteMany({ where: { shopDomain: shop } });
      await tx.cartProEventV3.deleteMany({ where: { shop } });
      await tx.productSaleEvent.deleteMany({ where: { shopDomain: shop } });
      await tx.shopProduct.deleteMany({ where: { shopDomain: shop } });
      await tx.monthlyOrderCount.deleteMany({ where: { shopDomain: shop } });
      await tx.shopConfig.deleteMany({ where: { shopDomain: shop } });
    }, { timeout: 30_000 });

    logInfo({
      shop,
      route: "redact",
      message: "shop/redact: all data deleted",
    });
  } catch (err) {
    logWarn({
      shop,
      route: "redact",
      message: "shop/redact: transaction failed",
      meta: { error: err instanceof Error ? err.message : String(err) },
    });
    throw err; // Let webhook retry
  }

  invalidateShopConfigCache(shop);
}
