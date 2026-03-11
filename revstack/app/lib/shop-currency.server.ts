/**
 * Shop primary currency resolution for multi-currency support.
 * Source of truth: ShopConfig.primaryCurrency, synced from Shopify shop.currencyCode.
 * Fallback: "USD" when not set or on error.
 */
import type { ShopConfig } from "@prisma/client";
import { prisma } from "~/lib/prisma.server";
import { invalidateShopConfigCache } from "~/lib/shop-config.server";
import { normalizeShopDomain } from "~/lib/shop-domain.server";

type AdminGraphQL = {
  graphql(
    query: string,
    options?: { variables?: Record<string, unknown> }
  ): Promise<Response>;
};

const SHOP_CURRENCY_QUERY = `#graphql
  query getShopCurrency {
    shop {
      currencyCode
    }
  }
`;

const FALLBACK_CURRENCY = "USD";

/**
 * Returns the currency code to use for this shop from config.
 * Use everywhere we previously hardcoded "USD" for shop context.
 */
export function getShopCurrency(config: ShopConfig): string {
  const code = config.primaryCurrency;
  return (typeof code === "string" && code.trim().length >= 2) ? code.trim() : FALLBACK_CURRENCY;
}

/**
 * Fetches the shop's primary currency from Shopify Admin API.
 * Returns FALLBACK_CURRENCY on error or missing data.
 */
export async function getShopCurrencyFromAdmin(admin: AdminGraphQL): Promise<string> {
  try {
    const response = await admin.graphql(SHOP_CURRENCY_QUERY);
    if (!response.ok) return FALLBACK_CURRENCY;
    const json = (await response.json()) as { data?: { shop?: { currencyCode?: string } }; errors?: unknown[] };
    if (json.errors?.length) return FALLBACK_CURRENCY;
    const code = json.data?.shop?.currencyCode;
    return (typeof code === "string" && code.trim().length >= 2) ? code.trim() : FALLBACK_CURRENCY;
  } catch {
    return FALLBACK_CURRENCY;
  }
}

/**
 * Ensures ShopConfig.primaryCurrency is synced from Shopify.
 * Call when you have Admin API access (e.g. settings loader, dashboard).
 * Updates DB and invalidates config cache if currency changed or was null.
 * Returns the currency code to use.
 */
export async function ensureShopCurrencySynced(
  shop: string,
  admin: AdminGraphQL
): Promise<string> {
  const domain = normalizeShopDomain(shop);
  const currency = await getShopCurrencyFromAdmin(admin);
  const row = await prisma.shopConfig.findUnique({
    where: { shopDomain: domain },
    select: { primaryCurrency: true },
  });
  const current = row?.primaryCurrency ?? null;
  if (current === currency) return currency;
  await prisma.shopConfig.update({
    where: { shopDomain: domain },
    data: { primaryCurrency: currency },
  });
  invalidateShopConfigCache(shop);
  return currency;
}
