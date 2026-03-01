import type { Product } from "@revpro/decision-engine";
import type { CartSnapshot } from "@revpro/decision-engine";

/** Product shape may include optional fields used by some strategies (tags, salesRank, createdAt). */
type ProductWithOptionalFields = Product & {
  tags?: string[];
  salesRank?: number;
  createdAt?: string;
};

/**
 * Applies the configured recommendation strategy to the catalog.
 * Returns a new array; never mutates the original.
 * No DB calls.
 */
export function applyRecommendationStrategy({
  strategy,
  catalog,
  cart,
  manualCollectionIds = [],
}: {
  strategy: string;
  catalog: Product[];
  cart: CartSnapshot;
  manualCollectionIds?: string[];
}): Product[] {
  const manualSet = manualCollectionIds.length > 0 ? new Set(manualCollectionIds) : null;

  switch (strategy) {
    case "COLLECTION_MATCH":
      return [...catalog];

    case "MANUAL_COLLECTION":
      if (!manualSet || manualSet.size === 0) return [];
      return catalog.filter((p) =>
        p.collections.some((c) => manualSet.has(c))
      );

    case "TAG_MATCH": {
      const cartProductIds = new Set(cart.items.map((i) => i.productId));
      const cartTags = new Set<string>();
      for (const p of catalog) {
        if (cartProductIds.has(p.id)) {
          const tags = (p as ProductWithOptionalFields).tags;
          if (Array.isArray(tags)) {
            for (const t of tags) {
              if (typeof t === "string") cartTags.add(t);
            }
          }
        }
      }
      if (cartTags.size === 0) return [...catalog];
      return catalog.filter((p) => {
        const tags = (p as ProductWithOptionalFields).tags;
        if (!Array.isArray(tags)) return true;
        return tags.some((t) => typeof t === "string" && cartTags.has(t));
      });
    }

    case "BEST_SELLING": {
      const hasSalesRank = catalog.some(
        (p) => typeof (p as ProductWithOptionalFields).salesRank === "number"
      );
      if (!hasSalesRank) return [...catalog];
      return [...catalog].sort((a, b) => {
        const ra = (a as ProductWithOptionalFields).salesRank;
        const rb = (b as ProductWithOptionalFields).salesRank;
        const va = typeof ra === "number" ? ra : Number.MAX_SAFE_INTEGER;
        const vb = typeof rb === "number" ? rb : Number.MAX_SAFE_INTEGER;
        return va - vb;
      });
    }

    case "NEW_ARRIVALS": {
      const hasCreatedAt = catalog.some(
        (p) => typeof (p as ProductWithOptionalFields).createdAt === "string"
      );
      if (!hasCreatedAt) return [...catalog];
      return [...catalog].sort((a, b) => {
        const ca = (a as ProductWithOptionalFields).createdAt;
        const cb = (b as ProductWithOptionalFields).createdAt;
        const va = typeof ca === "string" ? ca : "";
        const vb = typeof cb === "string" ? cb : "";
        return vb.localeCompare(va);
      });
    }

    default:
      return [...catalog];
  }
}
