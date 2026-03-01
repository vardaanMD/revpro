/**
 * =============================================================================
 * DEPRECATED — This backend is not used by the Shopify storefront.
 * revstack is the canonical backend.
 * Do not modify or deploy this backend unless multi-platform is reintroduced.
 * =============================================================================
 */
import { Router, Request, Response } from "express";
import {
  decideCartActions,
  type CartSnapshot,
  type CartItem,
  type Money,
  type StoreMetrics,
} from "../../../packages/decision-engine/src/index.ts";

const router = Router();

// Shopify cart payload from storefront (type-safe)
interface ShopifyCartItem {
  id: string | number;
  product_id: string | number;
  product_title?: string;
  quantity: number;
  price: number;
  final_line_price?: number;
}

interface ShopifyCartPayload {
  items: ShopifyCartItem[];
  total_price?: number;
  currency?: string;
}

/** All monetary values in cents. Payload (e.g. from Shopify cart) must supply price/totals in cents. */
const BASELINE_AOV_CENTS = 1000;
const FREE_SHIPPING_THRESHOLD_CENTS = 2000;

function toMoney(amount: number, currency: string): Money {
  return { amount, currency };
}

function transformShopifyCartToSnapshot(
  payload: ShopifyCartPayload
): { cart: CartSnapshot; storeMetrics: StoreMetrics } {
  const currency = payload.currency ?? "USD";

  const items: CartItem[] = payload.items.map((item, index) => ({
    id: String(item.id ?? `item-${index}`),
    productId: String(item.product_id ?? item.id ?? `product-${index}`),
    quantity: Number(item.quantity) || 1,
    unitPrice: toMoney(Number(item.price) || 0, currency),
  }));

  const cart: CartSnapshot = {
    id: "cart-decision",
    items,
  };

  const storeMetrics: StoreMetrics = {
    currency,
    baselineAOV: toMoney(BASELINE_AOV_CENTS, currency),
    freeShippingThreshold: toMoney(FREE_SHIPPING_THRESHOLD_CENTS, currency),
  };

  return { cart, storeMetrics };
}

router.post("/decision", (req: Request, res: Response) => {
  try {
    const payload = req.body as ShopifyCartPayload;

    if (!payload || !Array.isArray(payload.items)) {
      res.status(400).json({
        error: "Bad request",
        message: "Request body must include an 'items' array (Shopify cart format).",
      });
      return;
    }

    const { cart, storeMetrics } = transformShopifyCartToSnapshot(payload);

    const decision = decideCartActions({
      cart,
      catalog: [],
      storeMetrics,
    });

    res.json(decision);
  } catch (error) {
    res.status(500).json({
      error: "Internal server error",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

export default router;
