import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { AppLink } from "~/components/AppLink";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { getShopConfig } from "~/lib/shop-config.server";
import { getAppLayoutFromContext } from "~/lib/request-context.server";
import { normalizeShopDomain, warnIfShopNotCanonical } from "~/lib/shop-domain.server";
import { getBillingContext } from "~/lib/billing-context.server";
import { authenticate } from "~/shopify.server";
import type { Plan } from "~/lib/capabilities.server";

/** Billing page: uses layout config and getBillingContext (same source as snapshot v3 feature flags). No V2-only flows. */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const appLayout = getAppLayoutFromContext();
  let config: Awaited<ReturnType<typeof getShopConfig>>;
  let shop: string;
  if (appLayout) {
    config = appLayout.config;
    shop = appLayout.shop;
  } else {
    const { session } = await authenticate.admin(request);
    const rawShop = session.shop;
    shop = normalizeShopDomain(rawShop);
    warnIfShopNotCanonical(rawShop, shop);
    config = await getShopConfig(shop);
  }
  const billing = await getBillingContext(shop, config);
  const storeHandle = shop.replace(/\.myshopify\.com$/, "");
  const shopifyBillingUrl = `https://admin.shopify.com/store/${storeHandle}/settings/billing`;
  return { billingActive: billing.isEntitled, plan: billing.plan, shopifyBillingUrl };
};

export default function BillingPage() {
  const { billingActive, plan, shopifyBillingUrl } = useLoaderData<typeof loader>();
  const planLabel = plan === "growth" ? "Growth" : plan === "advanced" ? "Advanced" : "Basic";

  return (
    <s-page heading="Billing">
      <s-section>
        <s-stack direction="block" gap="base">
          {billingActive ? (
            <>
              <s-text tone="auto">Current plan: {planLabel}</s-text>
              <s-text tone="neutral">
                Subscription and invoices are managed in your Shopify admin billing settings.
              </s-text>
              <s-text tone="subdued">
                To update your payment method or view invoices, open{" "}
                <a href={shopifyBillingUrl} target="_blank" rel="noopener noreferrer">
                  Shopify admin → Settings → Billing
                </a>
                .
              </s-text>
              <AppLink to="/app/upgrade">
                <s-button variant="secondary">Change plan</s-button>
              </AppLink>
            </>
          ) : (
            <>
              <s-text tone="neutral">Activate a plan to use recommendations and analytics.</s-text>
              <AppLink to="/app/upgrade">
                <s-button variant="primary">Activate Plan</s-button>
              </AppLink>
            </>
          )}
        </s-stack>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
