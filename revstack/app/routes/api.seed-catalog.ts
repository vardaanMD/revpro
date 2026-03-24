/**
 * Single-site catalog seed endpoint. POST /api/seed-catalog
 * Protected by SINGLE_SITE_TOKEN. Accepts { adminToken } body.
 * Seeds the catalog index for SINGLE_SITE_SHOP using a Custom App admin token
 * so collection-match recommendations work without a full app install.
 */
import type { ActionFunctionArgs } from "react-router";
import { warmCatalogForShop } from "~/lib/catalog-warm.server";

export async function action({ request }: ActionFunctionArgs) {
  const singleSiteToken = process.env.SINGLE_SITE_TOKEN;
  const singleSiteShop = process.env.SINGLE_SITE_SHOP;

  if (!singleSiteToken || !singleSiteShop) {
    return Response.json({ error: "Not configured" }, { status: 404 });
  }
  if (request.headers.get("Authorization") !== `Bearer ${singleSiteToken}`) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const adminToken = new URL(request.url).searchParams.get("adminToken");
  if (!adminToken) {
    return Response.json({ error: "adminToken query param required" }, { status: 400 });
  }

  const products = await warmCatalogForShop(singleSiteShop, adminToken);
  return Response.json({ ok: true, seeded: products.length });
}
