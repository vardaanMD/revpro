import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import { prisma } from "~/lib/prisma.server";
import { invalidateShopConfigCache } from "~/lib/shop-config.server";
import type { Plan } from "~/lib/capabilities.server";
import { handleAdminApiResponse } from "~/lib/admin-api-guard.server";

const APP_SUBSCRIPTION_CREATE = `#graphql
mutation AppSubscriptionCreate($name: String!, $lineItems: [AppSubscriptionLineItemInput!]!, $returnUrl: URL!) {
  appSubscriptionCreate(name: $name, returnUrl: $returnUrl, lineItems: $lineItems) {
    userErrors { field message }
    appSubscription { id }
    confirmationUrl
  }
}
`;

const APP_USAGE_RECORD_CREATE = `#graphql
mutation AppUsageRecordCreate($subscriptionLineItemId: ID!, $price: MoneyInput!, $description: String!) {
  appUsageRecordCreate(subscriptionLineItemId: $subscriptionLineItemId, price: $price, description: $description) {
    userErrors { field message }
    appUsageRecord { id }
  }
}
`;

const PLAN_PRICES: Record<Plan, { name: string; priceUsd: number }> = {
  basic: { name: "Basic", priceUsd: 9 },
  advanced: { name: "Advanced", priceUsd: 29 },
  growth: { name: "Growth", priceUsd: 49 },
};

/** Overage terms shown to merchant on Shopify approval screen. */
const USAGE_TERMS = "Additional orders beyond plan limit at $0.01/order";
const USAGE_CAPPED_AMOUNT = 50.0;

export type CreateSubscriptionResult = {
  confirmationUrl: string | null;
  userErrors: Array<{ field: string[]; message: string }>;
};

/**
 * Creates a recurring app subscription with a usage-based overage line item.
 * Returns the confirmation URL for the merchant to approve charges.
 * No free plan; all plans are paid.
 */
export async function createSubscription(
  admin: AdminApiContext,
  shop: string,
  plan: Plan,
  returnUrl: string,
  request?: Request
): Promise<CreateSubscriptionResult> {
  const definition = PLAN_PRICES[plan];
  const response = await admin.graphql(APP_SUBSCRIPTION_CREATE, {
    variables: {
      name: `${definition.name} Plan`,
      returnUrl,
      lineItems: [
        {
          plan: {
            appRecurringPricingDetails: {
              price: { amount: definition.priceUsd, currencyCode: "USD" },
              interval: "EVERY_30_DAYS",
            },
          },
        },
        {
          plan: {
            appUsagePricingDetails: {
              terms: USAGE_TERMS,
              cappedAmount: { amount: USAGE_CAPPED_AMOUNT, currencyCode: "USD" },
            },
          },
        },
      ],
    },
  });

  handleAdminApiResponse(response, shop, "billing", request);

  const json = (await response.json()) as {
    data?: {
      appSubscriptionCreate?: {
        userErrors: Array<{ field: string[]; message: string }>;
        appSubscription?: { id: string };
        confirmationUrl?: string | null;
      };
    };
    errors?: Array<{ message: string }>;
  };

  const payload = json.data?.appSubscriptionCreate;
  if (!payload) {
    return { confirmationUrl: null, userErrors: [{ field: [], message: "Failed to create subscription" }] };
  }

  const userErrors = payload.userErrors ?? [];
  if (userErrors.length > 0) {
    return { confirmationUrl: null, userErrors };
  }

  const subscriptionId = payload.appSubscription?.id ?? null;
  if (subscriptionId) {
    await prisma.shopConfig.update({
      where: { shopDomain: shop },
      data: {
        plan,
        billingStatus: "pending",
        billingId: subscriptionId,
      },
    });
    invalidateShopConfigCache(shop);
  }

  return {
    confirmationUrl: payload.confirmationUrl ?? null,
    userErrors: [],
  };
}

/**
 * Records a usage charge for orders exceeding the plan's included volume.
 * Called from the orders/paid webhook when the monthly count exceeds the limit.
 * Requires the subscription's usage line item ID (resolved from Shopify).
 */
export async function recordUsageCharge(
  admin: AdminApiContext,
  subscriptionLineItemId: string,
  amount: number,
  description: string
): Promise<{ success: boolean; error?: string }> {
  const response = await admin.graphql(APP_USAGE_RECORD_CREATE, {
    variables: {
      subscriptionLineItemId,
      price: { amount, currencyCode: "USD" },
      description,
    },
  });

  const json = (await response.json()) as {
    data?: {
      appUsageRecordCreate?: {
        userErrors: Array<{ field: string[]; message: string }>;
        appUsageRecord?: { id: string };
      };
    };
  };

  const payload = json.data?.appUsageRecordCreate;
  const errors = payload?.userErrors ?? [];
  if (errors.length > 0) {
    return { success: false, error: errors.map((e) => e.message).join(", ") };
  }

  return { success: true };
}
