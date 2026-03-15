import type { Product } from "@revpro/decision-engine";
import { logResilience } from "~/lib/logger.server";
import { handleAdminApiResponse } from "~/lib/admin-api-guard.server";

/** TTL for catalog cache (5 minutes). Reduces Shopify pressure without changing decision logic. */
const CACHE_TTL_MS = 300 * 1000; // 300 seconds (5 minutes)

/** Per-process cache; key includes shop + currency. With multiple instances each has its own cache (see SCALING.md). */
const catalogCache = new Map<
  string,
  { data: Product[]; expiresAt: number }
>();

type AdminGraphQL = {
  graphql(
    query: string,
    options?: { variables?: Record<string, unknown> }
  ): Promise<Response>;
};

const PRODUCTS_QUERY = `#graphql
  query getCatalogProducts($first: Int!, $query: String) {
    products(first: $first, query: $query) {
      edges {
        node {
          id
          title
          handle
          createdAt
          featuredImage {
            url
          }
          variants(first: 1) {
            edges {
              node {
                id
                price
                availableForSale
              }
            }
          }
          collections(first: 5) {
            edges {
              node {
                id
              }
            }
          }
        }
      }
    }
  }
`;

interface ProductNode {
  id: string;
  title: string;
  handle: string;
  createdAt?: string | null;
  featuredImage?: { url: string } | null;
  variants: {
    edges: Array<{
      node: {
        id: string;
        price: string;
        availableForSale: boolean;
      };
    }>;
  };
  collections: {
    edges: Array<{ node: { id: string } }>;
  };
}

interface ProductsResponse {
  data?: {
    products?: {
      edges: Array<{ node: ProductNode }>;
    };
  };
}

/**
 * Fetches the first N products from the shop via Admin GraphQL, maps them to
 * decision-engine Product (amounts in integer cents). Caches per shop+currency
 * with short TTL (see CACHE_TTL_MS). GraphQL variant.price is decimal string;
 * converted via Math.round(parseFloat(price) * 100).
 */
export async function getCatalogForShop(
  admin: AdminGraphQL,
  shop: string,
  currency: string = "USD",
  request?: Request
): Promise<Product[]> {
  const cacheKey = `catalog:${shop}:${currency}`;
  const cached = catalogCache.get(cacheKey);
  const now = Date.now();
  if (cached && now < cached.expiresAt) {
    return cached.data;
  }

  const response = await admin.graphql(PRODUCTS_QUERY, {
    variables: { first: 50, query: "status:active" },
  });

  handleAdminApiResponse(response, shop, "catalog", request);

  if (!response.ok) {
    logResilience({
      shop,
      route: "catalog",
      message: "Admin API non-OK response; returning empty catalog",
      meta: { errorType: "AdminApiError", status: response.status },
    });
    return [];
  }

  const json = (await response.json()) as ProductsResponse;
  const edges = json.data?.products?.edges ?? [];
  const products: Product[] = [];

  for (const { node: product } of edges) {
    const variantEdge = product.variants.edges[0];
    if (!variantEdge) continue;
    const variant = variantEdge.node;
    // GraphQL price is decimal string (e.g. "19.99"); convert to integer cents only.
    const priceCents = Math.round(parseFloat(variant.price || "0") * 100);
    const collectionIds = product.collections.edges.map(
      (e) => e.node.id
    );
    // Use numeric product ID so cart items with product_id (numeric) can match.
    const numericProductId =
      product.id.split("/").pop() ?? product.id;

    const numericVariantId = variant.id.split("/").pop() ?? variant.id;
    const createdAt =
      typeof product.createdAt === "string" ? product.createdAt : undefined;
    products.push({
      id: numericProductId,
      variantId: numericVariantId,
      handle: product.handle,
      imageUrl: product.featuredImage?.url ?? null,
      title: product.title,
      price: { amount: priceCents, currency },
      inStock: variant.availableForSale,
      collections: collectionIds,
      ...(createdAt ? { createdAt } : {}),
    } as Product);
  }

  catalogCache.set(cacheKey, { data: products, expiresAt: now + CACHE_TTL_MS });
  return products;
}
