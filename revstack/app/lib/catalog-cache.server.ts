/**
 * In-memory LRU cache for catalog snapshots. Per-process; never throws or blocks.
 * Used as first tier: Memory → Redis → Shopify → SAFE.
 */
import type { Product } from "@revpro/decision-engine";

export type CatalogSnapshot = Product[];

const MAX_SHOPS = 100;
const TTL_MS = 5 * 60 * 1000; // 5 minutes

type Entry = { snapshot: CatalogSnapshot; updatedAt: number };
const store = new Map<string, Entry>();
const keyOrder: string[] = [];

function evictOldest(): void {
  if (keyOrder.length === 0) return;
  const oldest = keyOrder[0];
  store.delete(oldest);
  keyOrder.shift();
}

/**
 * Returns the cached catalog for the shop, or null if miss or expired.
 * Synchronous only; never throws.
 */
export function getMemoryCatalog(shop: string): CatalogSnapshot | null {
  try {
    const entry = store.get(shop);
    if (!entry) return null;
    if (Date.now() - entry.updatedAt > TTL_MS) {
      const idx = keyOrder.indexOf(shop);
      if (idx >= 0) keyOrder.splice(idx, 1);
      store.delete(shop);
      return null;
    }
    return entry.snapshot;
  } catch {
    return null;
  }
}

/**
 * Stores the catalog snapshot for the shop. Evicts oldest entry when at capacity.
 * Synchronous only; never throws.
 */
export function setMemoryCatalog(shop: string, snapshot: CatalogSnapshot): void {
  try {
    if (store.size >= MAX_SHOPS && !store.has(shop)) evictOldest();
    const idx = keyOrder.indexOf(shop);
    if (idx >= 0) keyOrder.splice(idx, 1);
    keyOrder.push(shop);
    store.set(shop, { snapshot, updatedAt: Date.now() });
  } catch {
    // no-op
  }
}

/** Current in-memory catalog cache entry count (for health diagnostics). */
export function getCatalogCacheSize(): number {
  return store.size;
}

/** Trim catalog cache to stay under limit (safety guard). */
export function trimCatalogCacheToLimit(): void {
  while (store.size > MAX_SHOPS && keyOrder.length > 0) {
    evictOldest();
  }
}
