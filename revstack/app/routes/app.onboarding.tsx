import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { Form, useLoaderData, useActionData, useNavigation } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "~/shopify.server";
import { getAppLayoutFromContext } from "~/lib/request-context.server";
import { getShopConfig } from "~/lib/shop-config.server";
import { prisma } from "~/lib/prisma.server";
import { invalidateShopConfigCache } from "~/lib/shop-config.server";
import { normalizeShopDomain, warnIfShopNotCanonical } from "~/lib/shop-domain.server";
import onboardingStyles from "~/styles/onboarding.module.css";

/** Step indices for UI only; server step logic uses onboarding-wizard.server (dynamic import in action). */
const WIZARD_STEP_WELCOME = 0;
const WIZARD_STEP_ACTIVATE_EXTENSION = 1;
const WIZARD_STEP_VERIFY_CART = 2;
const WIZARD_STEP_CONFIGURE_BASICS = 3;
const WIZARD_STEP_LAUNCH = 4;
const WIZARD_STEP_COUNT = 4;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const appLayout = getAppLayoutFromContext();
  let shop: string;
  let authRedirect: (url: string, init?: ResponseInit) => Response;
  if (appLayout) {
    shop = appLayout.shop;
    authRedirect = appLayout.redirect;
  } else {
    const { session, redirect } = await authenticate.admin(request);
    const rawShop = session.shop;
    shop = normalizeShopDomain(rawShop);
    warnIfShopNotCanonical(rawShop, shop);
    authRedirect = redirect;
  }

  const config = await getShopConfig(shop);
  if (config.onboardingCompleted) {
    throw authRedirect("/app");
  }

  const step = config.onboardingStep ?? 0;
  const storeHandle = shop.replace(/\.myshopify\.com$/, "");
  const themeEditorUrl = `https://admin.shopify.com/store/${storeHandle}/themes/current/editor`;
  const storefrontUrl = `https://${shop.replace(/\.myshopify\.com$/, "")}.myshopify.com`;

  return {
    onboardingStep: step,
    themeEditorUrl,
    storefrontUrl,
    freeShippingThresholdCents: config.freeShippingThresholdCents,
    recommendationStrategy: config.recommendationStrategy ?? "COLLECTION_MATCH",
  };
};

type LoaderData = Awaited<ReturnType<typeof loader>>;

export const action = async ({ request }: ActionFunctionArgs) => {
  const wizard = await import("~/lib/onboarding-wizard.server");
  const auth = await authenticate.admin(request);
  const rawShop = auth.session.shop;
  const shop = normalizeShopDomain(rawShop);
  warnIfShopNotCanonical(rawShop, shop);
  const admin = auth.admin as { graphql: (query: string, opts?: { variables?: Record<string, unknown> }) => Promise<Response> };

  if (request.method !== "POST") {
    return Response.json({ success: false, error: "Method not allowed" }, { status: 405 });
  }

  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "start_setup") {
    await wizard.setOnboardingStep(shop, wizard.WIZARD_STEP_ACTIVATE_EXTENSION);
    return Response.json({ success: true, nextStep: wizard.WIZARD_STEP_ACTIVATE_EXTENSION });
  }

  if (intent === "step1_verified") {
    const verification = await wizard.verifyCartInfrastructure(shop, admin, request);
    if (!verification.success) {
      return Response.json({ success: false, error: verification.error }, { status: 400 });
    }
    await wizard.setOnboardingStep(shop, wizard.WIZARD_STEP_VERIFY_CART);
    return Response.json({ success: true, nextStep: wizard.WIZARD_STEP_VERIFY_CART });
  }

  if (intent === "step2_test") {
    const verification = await wizard.verifyStep2TestCart(shop, admin, request);
    if (!verification.success) {
      return Response.json({ success: false, error: verification.error }, { status: 400 });
    }
    await wizard.setOnboardingVerifiedAt(shop);
    await wizard.setOnboardingStep(shop, wizard.WIZARD_STEP_CONFIGURE_BASICS);
    return Response.json({ success: true, nextStep: wizard.WIZARD_STEP_CONFIGURE_BASICS });
  }

  if (intent === "step3_configure") {
    const thresholdDollars = formData.get("freeShippingThresholdDollars");
    const thresholdNum = typeof thresholdDollars === "string" ? parseFloat(thresholdDollars) : NaN;
    const freeShippingThresholdCents = Number.isFinite(thresholdNum) ? Math.round(thresholdNum * 100) : 0;
    const recommendationStrategy = (formData.get("recommendationStrategy") as string) ?? "COLLECTION_MATCH";

    const config = await getShopConfig(shop);
    const submitted = {
      freeShippingThresholdCents,
      recommendationStrategy,
    };
    if (!wizard.step3RequiresMutation(config, submitted)) {
      return Response.json(
        { success: false, error: "Set free shipping threshold above 0 or change at least one setting." },
        { status: 400 }
      );
    }
    const domain = normalizeShopDomain(shop);
    await prisma.shopConfig.update({
      where: { shopDomain: domain },
      data: {
        freeShippingThresholdCents,
        recommendationStrategy,
      },
    });
    invalidateShopConfigCache(domain);
    await wizard.setOnboardingStep(shop, wizard.WIZARD_STEP_LAUNCH);
    return Response.json({ success: true, nextStep: wizard.WIZARD_STEP_LAUNCH });
  }

  if (intent === "launch") {
    await wizard.completeOnboardingWizard(shop);
    const url = new URL(request.url);
    const search = url.searchParams.toString();
    const appUrl = search ? `/app?${search}` : "/app";
    throw new Response(null, { status: 302, headers: { Location: appUrl } });
  }

  if (intent === "back") {
    const config = await getShopConfig(shop);
    const currentStep = config.onboardingStep ?? 0;
    const prev = Math.max(wizard.WIZARD_STEP_WELCOME, currentStep - 1);
    await wizard.setOnboardingStep(shop, prev);
    return Response.json({ success: true, nextStep: prev });
  }

  return Response.json({ success: false, error: "Unknown intent" }, { status: 400 });
};

function centsToDollars(cents: number): string {
  return (cents / 100).toFixed(2);
}

export default function OnboardingWizardPage() {
  const data = useLoaderData<LoaderData>();
  const actionData = useActionData<{ success: boolean; error?: string; nextStep?: number; redirect?: string }>();
  const navigation = useNavigation();
  const step = data.onboardingStep ?? 0;
  const isSubmitting = navigation.state === "submitting" || navigation.state === "loading";

  const progressPercent = step >= WIZARD_STEP_LAUNCH ? 100 : Math.round((step / WIZARD_STEP_COUNT) * 100);
  const stepLabel =
    step <= WIZARD_STEP_CONFIGURE_BASICS ? `Step ${step + 1} of 4` : step === WIZARD_STEP_LAUNCH ? "Complete" : "";

  return (
    <s-page>
      <s-stack direction="block" gap="large">
        <s-section>
          <div className={onboardingStyles.progressTrack}>
            <div
              className={onboardingStyles.progressFill}
              style={{ width: `${progressPercent}%` }}
              role="progressbar"
              aria-valuenow={step + 1}
              aria-valuemin={1}
              aria-valuemax={WIZARD_STEP_COUNT + 1}
            />
          </div>
          {stepLabel && (
            <s-text tone="subdued">{stepLabel}</s-text>
          )}
        </s-section>

        <s-section>
          {step === WIZARD_STEP_WELCOME && (
            <s-box padding="base" borderWidth="base" borderRadius="base" background="subdued">
              <s-stack direction="block" gap="base">
                <s-heading>Welcome</s-heading>
                <s-text tone="neutral">Complete the steps below to activate your cart experience.</s-text>
                <Form method="post">
                  <input type="hidden" name="intent" value="start_setup" />
                  <s-button type="submit" variant="primary" loading={isSubmitting}>
                    Start Setup
                  </s-button>
                </Form>
              </s-stack>
            </s-box>
          )}

          {step === WIZARD_STEP_ACTIVATE_EXTENSION && (
            <s-box padding="base" borderWidth="base" borderRadius="base" background="subdued">
              <s-stack direction="block" gap="base">
                <s-heading>Activate extension</s-heading>
                <s-text tone="neutral">
                  Add the app block to your theme in the Theme Editor and enable it so the cart runs on your storefront.
                </s-text>
                <s-stack direction="inline" gap="base">
                  <a
                    href={data.themeEditorUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ textDecoration: "none" }}
                  >
                    <s-button variant="primary">Open Theme Editor</s-button>
                  </a>
                  <Form method="post">
                    <input type="hidden" name="intent" value="step1_verified" />
                    <s-button type="submit" variant="secondary" loading={isSubmitting}>
                      I've enabled the cart
                    </s-button>
                  </Form>
                </s-stack>
                {actionData?.success === false && actionData?.error && (
                  <s-text tone="critical">{actionData.error}</s-text>
                )}
              </s-stack>
            </s-box>
          )}

          {step === WIZARD_STEP_VERIFY_CART && (
            <s-box padding="base" borderWidth="base" borderRadius="base" background="subdued">
              <s-stack direction="block" gap="base">
                <s-heading>Verify recommendations</s-heading>
                <s-text tone="neutral">
                  We'll run a test with a sample cart to confirm the decision engine returns recommendations.
                </s-text>
                <Form method="post">
                  <input type="hidden" name="intent" value="step2_test" />
                  <s-button type="submit" variant="primary" loading={isSubmitting}>
                    Test my cart
                  </s-button>
                </Form>
                {actionData?.success === false && actionData?.error && (
                  <s-text tone="critical">{actionData.error}</s-text>
                )}
              </s-stack>
            </s-box>
          )}

          {step === WIZARD_STEP_CONFIGURE_BASICS && (
            <s-box padding="base" borderWidth="base" borderRadius="base" background="subdued">
              <s-stack direction="block" gap="base">
                <s-heading>Configure basics</s-heading>
                <s-text tone="neutral">
                  Set a free shipping threshold (greater than 0) or change at least one setting.
                </s-text>
                <Form method="post">
                  <input type="hidden" name="intent" value="step3_configure" />
                  <s-stack direction="block" gap="base">
                    <label htmlFor="freeShippingThresholdDollars">
                      <s-text>Free shipping threshold (USD)</s-text>
                    </label>
                    <input
                      id="freeShippingThresholdDollars"
                      name="freeShippingThresholdDollars"
                      type="number"
                      min="0"
                      step="0.01"
                      defaultValue={centsToDollars(data.freeShippingThresholdCents)}
                      aria-invalid={!!(actionData?.success === false && actionData?.error)}
                    />
                    <label htmlFor="recommendationStrategy">
                      <s-text>Recommendation strategy</s-text>
                    </label>
                    <select
                      id="recommendationStrategy"
                      name="recommendationStrategy"
                      defaultValue={data.recommendationStrategy}
                    >
                      <option value="COLLECTION_MATCH">Collection match</option>
                      <option value="MANUAL_COLLECTION">Manual collection</option>
                      <option value="TAG_MATCH">Tag match</option>
                      <option value="BEST_SELLING">Best selling</option>
                      <option value="NEW_ARRIVALS">New arrivals</option>
                    </select>
                    <s-button type="submit" variant="primary" loading={isSubmitting}>
                      Continue
                    </s-button>
                  </s-stack>
                </Form>
                {actionData?.success === false && actionData?.error && (
                  <s-text tone="critical">{actionData.error}</s-text>
                )}
              </s-stack>
            </s-box>
          )}

          {step === WIZARD_STEP_LAUNCH && (
            <s-box padding="base" borderWidth="base" borderRadius="base" background="subdued">
              <s-stack direction="block" gap="base">
                <s-heading>Launch</s-heading>
                <s-text tone="neutral">You're ready. Finish to access the dashboard.</s-text>
                <Form method="post">
                  <input type="hidden" name="intent" value="launch" />
                  <s-button type="submit" variant="primary" loading={isSubmitting}>
                    Launch cart
                  </s-button>
                </Form>
              </s-stack>
            </s-box>
          )}

        {step > WIZARD_STEP_WELCOME && step < WIZARD_STEP_LAUNCH && (
          <s-section>
            <Form method="post">
              <input type="hidden" name="intent" value="back" />
              <s-button type="submit" variant="plain" loading={isSubmitting}>
                Back
              </s-button>
            </Form>
          </s-section>
        )}
        </s-section>
      </s-stack>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
