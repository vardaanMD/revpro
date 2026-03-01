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

const PLAN_PRICES: Record<Plan, { name: string; priceUsd: number }> = {
  basic: { name: "Basic", priceUsd: 9 },
  advanced: { name: "Advanced", priceUsd: 29 },
  growth: { name: "Growth", priceUsd: 49 },
};

export type CreateSubscriptionResult = {
  confirmationUrl: string | null;
  userErrors: Array<{ field: string[]; message: string }>;
};

/**
 * Creates a recurring app subscription for the given plan.
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
