/**
 * Cart Pro V3 — variant availability.
 * GET /variants/{id}.js, batched. Results merged into upsell.cache by Engine.
 */

const BATCH_SIZE = 5;

function getBaseUrl(): string {
  if (typeof window !== 'undefined' && (window as any).Shopify?.routes?.root) {
    return (window as any).Shopify.routes.root;
  }
  return '/';
}

/**
 * Fetch availability for one variant. Returns true if variant exists and is available for purchase.
 */
async function fetchOneVariantAvailability(variantId: number): Promise<boolean> {
  const url = `${getBaseUrl()}variants/${variantId}.js`;
  try {
    const res = await fetch(url, {
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return false;
    const data = await res.json();
    return data?.available === true;
  } catch {
    return false;
  }
}

/**
 * Batch variant IDs into chunks of BATCH_SIZE.
 */
function batchIds(variantIds: number[]): number[][] {
  const batches: number[][] = [];
  for (let i = 0; i < variantIds.length; i += BATCH_SIZE) {
    batches.push(variantIds.slice(i, i + BATCH_SIZE));
  }
  return batches;
}

/**
 * Fetch availability for variant IDs. Only fetches IDs not already in existingCache.
 * Returns a map of variantId -> available. Caller merges into upsell.cache.
 */
export async function fetchVariantAvailability(
  variantIds: number[],
  existingCache: Record<number, boolean>
): Promise<Record<number, boolean>> {
  const toFetch = variantIds.filter((id) => existingCache[id] === undefined);
  if (toFetch.length === 0) return {};

  const batches = batchIds(toFetch);
  const result: Record<number, boolean> = {};
  for (const batch of batches) {
    const pairs = await Promise.all(
      batch.map(async (id) => ({ id, available: await fetchOneVariantAvailability(id) }))
    );
    for (const { id, available } of pairs) {
      result[id] = available;
    }
  }
  return result;
}
