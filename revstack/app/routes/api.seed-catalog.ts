/**
 * Single-site catalog seed endpoint. POST /api/seed-catalog
 * Protected by SINGLE_SITE_TOKEN. Accepts JSON body: { adminToken: string }.
 * Seeds the catalog index for SINGLE_SITE_SHOP using a Custom App admin token
 * so collection-match recommendations work without a full app install.
 */
import type { ActionFunctionArgs } from "react-router";
import { warmCatalogForShop } from "~/lib/catalog-warm.server";
import { bearerTokenMatches } from "~/lib/auth-utils.server";

export async function action({ request }: ActionFunctionArgs) {
  const singleSiteToken = process.env.SINGLE_SITE_TOKEN;
  const singleSiteShop = process.env.SINGLE_SITE_SHOP;

  if (!singleSiteToken || !singleSiteShop) {
    return Response.json({ error: "Not configured" }, { status: 404 });
  }
  if (!bearerTokenMatches(request.headers.get("Authorization"), singleSiteToken)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const adminToken = typeof body.adminToken === "string" ? body.adminToken : "";
  if (!adminToken) {
    return Response.json({ error: "adminToken required in body" }, { status: 400 });
  }

  const products = await warmCatalogForShop(singleSiteShop, adminToken);
  return Response.json({ ok: true, seeded: products.length });
}
