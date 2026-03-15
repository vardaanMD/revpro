/**
 * shop/redact webhook: delete all app data for the shop (GDPR).
 */
import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "~/shopify.server";
import { normalizeShopDomain } from "~/lib/shop-domain.server";
import { deleteShopData } from "~/lib/redact.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop: rawShop } = await authenticate.webhook(request);
  const shop = normalizeShopDomain(rawShop);
  await deleteShopData(shop);
  return Response.json({ ok: true });
};
