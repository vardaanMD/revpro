/**
 * =============================================================================
 * DEPRECATED — This backend is not used by the Shopify storefront.
 * revstack is the canonical backend.
 * Do not modify or deploy this backend unless multi-platform is reintroduced.
 * =============================================================================
 */
import { Router, Request, Response } from "express";
import { v4 as uuidv4 } from "uuid";
import {
  decideCartActions,
  type CartSnapshot,
  type CartItem,
  type Product,
  type StoreMetrics,
  type Money,
} from "../../../packages/decision-engine/src/index.ts";
import { ingestEvent } from "../events/ingestEvent";
import { ingestDecision } from "../events/ingestDecision";

const router = Router();

interface CartOpenRequest {
  storeId: string;
  cart: {
    value: number;
    items: any[];
  };
  catalog: any[];
  currency?: string;
  sessionId?: string;
}

interface CartOpenResponse {
  sessionId: string;
  decision: any;
}

router.post("/open", async (req: Request, res: Response) => {
  try {
    const body: CartOpenRequest = req.body;

    // Generate session_id if not provided
    const sessionId = body.sessionId || uuidv4();

    // Extract currency or default
    const currency = body.currency || "USD";

    // Transform request cart items to CartItem format
    const cartItems: CartItem[] = body.cart.items.map((item: any, index: number) => ({
      id: item.id || `item-${index}`,
      productId: item.productId || item.id || `product-${index}`,
      quantity: item.quantity || 1,
      unitPrice: {
        amount: item.price || item.unitPrice || 0,
        currency: currency,
      },
    }));

    // Build CartSnapshot
    const cartSnapshot: CartSnapshot = {
      id: `cart-${sessionId}`,
      items: cartItems,
    };

    // Transform catalog to Product format
    const products: Product[] = body.catalog.map((product: any) => ({
      id: product.id,
      title: product.title || product.name || "",
      price: {
        amount: product.price || 0,
        currency: currency,
      },
      inStock: product.inStock !== false,
      collections: product.collections || [],
    }));

    // Build StoreMetrics with temporary hardcoded values
    const storeMetrics: StoreMetrics = {
      currency: currency,
      freeShippingThreshold: null,
      baselineAOV: {
        amount: 100,
        currency: currency,
      },
    };

    // Record cart_opened event
    await ingestEvent({
      storeId: body.storeId,
      sessionId: sessionId,
      type: "cart_opened",
      payload: {
        cartValue: body.cart.value,
        currency: currency,
        items: body.cart.items,
      },
    });

    // Execute decision engine
    const decisionInput = {
      cart: cartSnapshot,
      catalog: products,
      storeMetrics: storeMetrics,
    };

    const decisionOutput = decideCartActions(decisionInput);

    // Record decision
    await ingestDecision({
      storeId: body.storeId,
      sessionId: sessionId,
      decisionType: "CART",
      inputSnapshot: decisionInput,
      output: decisionOutput,
    });

    // Return response
    const response: CartOpenResponse = {
      sessionId: sessionId,
      decision: decisionOutput,
    };

    res.json(response);
  } catch (error) {
    res.status(500).json({
      error: "Internal server error",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

export default router;
