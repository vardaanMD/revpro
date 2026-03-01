/**
 * Temporary forensic route: call warmCatalogForShop for a fixed shop.
 * Visit /debug/warm to trigger. Remove after audit.
 */
import type { LoaderFunctionArgs } from "react-router";
import { warmCatalogForShop } from "~/lib/catalog-warm.server";

export async function loader({ request }: LoaderFunctionArgs) {
  await warmCatalogForShop("revdev-4.myshopify.com");
  return new Response("warm complete", {
    headers: { "Content-Type": "text/plain" },
  });
}
