import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useNavigation } from "react-router";
import { authenticate } from "~/shopify.server";
import { createSubscription } from "~/lib/billing.server";
import { getShopConfig } from "~/lib/shop-config.server";
import { getBillingContext } from "~/lib/billing-context.server";
import { getAppLayoutFromContext } from "~/lib/request-context.server";
import { normalizeShopDomain, warnIfShopNotCanonical } from "~/lib/shop-domain.server";
import { ENV } from "~/lib/env.server";
import { boundary } from "@shopify/shopify-app-react-router/server";
import type { Plan } from "~/lib/capabilities.server";
import { PlanComparisonTable } from "~/components/ui/PlanComparisonTable";

const PLANS = [
  {
    id: "basic" as Plan,
    name: "Basic",
    price: "$9/mo",
    benefits: [
      "Up to 1 recommendation per session",
      "Milestones & free shipping bar",
      "Standard cart metrics",
    ],
    roi: "Sessions where recommendations were shown. Standard cart metrics.",
  },
  {
    id: "advanced" as Plan,
    name: "Advanced",
    price: "$29/mo",
    benefits: [
      "Up to 3 recommendations per session",
      "Strategy selection",
      "Comparison metrics",
    ],
    roi: "Strategy selection. Period comparison. Comparison metrics.",
    recommended: true,
  },
  {
    id: "growth" as Plan,
    name: "Growth",
    price: "$49/mo",
    benefits: [
      "Up to 8 recommendations per session",
      "Comparison metrics",
      "Order outcome comparison (observational)",
    ],
    roi: "Comparison metrics. Order outcome comparison (observational).",
    mostPopular: true,
  },
];

/** Uses layout config and getBillingContext for plan limits (same source as snapshot v3). No V2-only flows. */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const appLayout = getAppLayoutFromContext();
  let shop: string;
  let config: Awaited<ReturnType<typeof getShopConfig>>;
  if (appLayout) {
    shop = appLayout.shop;
    config = appLayout.config;
  } else {
    const { session } = await authenticate.admin(request);
    const rawShop = session.shop;
    shop = normalizeShopDomain(rawShop);
    warnIfShopNotCanonical(rawShop, shop);
    config = await getShopConfig(shop);
  }
  const billing = await getBillingContext(shop, config);
  return { plans: PLANS, currentPlan: billing.isEntitled ? billing.plan : undefined };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return new Response(null, { status: 405 });
  }

  const { admin, session } = await authenticate.admin(request);
  const rawShop = session.shop;
  const shop = normalizeShopDomain(rawShop);
  warnIfShopNotCanonical(rawShop, shop);

  const formData = await request.formData();
  const planId = formData.get("planId");
  if (planId !== "basic" && planId !== "advanced" && planId !== "growth") {
    return new Response(null, { status: 400 });
  }

  const search = new URL(request.url).searchParams.toString();
  const returnUrl = search ? `${ENV.SHOPIFY_APP_URL}/app?${search}` : `${ENV.SHOPIFY_APP_URL}/app`;
  const billingUrl = `${ENV.SHOPIFY_APP_URL}/app/billing`;

  const billing = await getBillingContext(shop);

  if (billing.billingStatus === "active" && billing.plan === (planId as Plan)) {
    return Response.redirect(billingUrl, 302);
  }

  if (billing.billingStatus === "pending") {
    return Response.redirect(billingUrl, 302);
  }

  const result = await createSubscription(admin, shop, planId as Plan, returnUrl, request);

  if (result.userErrors.length > 0) {
    return new Response(null, { status: 400 });
  }

  if (result.confirmationUrl) {
    return Response.redirect(result.confirmationUrl, 302);
  }

  return Response.redirect(returnUrl, 302);
};

export default function UpgradePage() {
  const { plans, currentPlan } = useLoaderData<typeof loader>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  return (
    <s-page heading="Activate Plan">
      <s-section heading="Plans">
        <PlanComparisonTable plans={plans} currentPlan={currentPlan} isSubmitting={isSubmitting} />
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
