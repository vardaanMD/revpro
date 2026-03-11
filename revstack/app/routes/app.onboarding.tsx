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
import { buildConfigV3FromOnboardingStep3 } from "~/lib/onboarding-wizard.server";
import { normalizeShopDomain, warnIfShopNotCanonical } from "~/lib/shop-domain.server";
import onboardingStyles from "~/styles/onboarding.module.css";
import { FormField } from "~/components/ui/FormField";

/** Onboarding: on completion configV3 is persisted for snapshot v3. Cart drawer is always V3. */
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
    const configV3 = buildConfigV3FromOnboardingStep3(config.configV3, {
      freeShippingThresholdCents,
      recommendationStrategy,
    });
    await prisma.shopConfig.update({
      where: { shopDomain: domain },
      data: {
        freeShippingThresholdCents,
        recommendationStrategy,
        configV3: configV3 as object,
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
                <s-heading>Welcome to RevPRO</s-heading>
                <s-text tone="neutral">You'll be live in about 5 minutes. Here's what we'll set up:</s-text>
                <s-stack direction="block" gap="small">
                  <s-text tone="neutral">1. Enable the cart extension in your theme</s-text>
                  <s-text tone="neutral">2. Verify the cart widget loads correctly</s-text>
                  <s-text tone="neutral">3. Configure your free shipping goal and recommendation style</s-text>
                  <s-text tone="neutral">4. Launch — your cart goes live immediately</s-text>
                </s-stack>
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
                <s-heading>Activate Cart Pro V3</s-heading>
                <s-text tone="neutral">
                  In the Theme Editor, go to <strong>App embeds</strong> and enable <strong>Cart Pro V3</strong> (the block named &quot;Cart Pro V3&quot;). Do not enable an older &quot;Cart Pro&quot; block—use the V3 embed so the latest cart runs on your storefront.
                </s-text>
                <s-box padding="small" borderWidth="base" borderRadius="base" background="base">
                  <s-text tone="neutral">
                    Why: The theme extension injects the cart widget into your storefront. Without it, RevPRO has nothing to display to customers.
                  </s-text>
                </s-box>
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
                <s-box padding="small" borderWidth="base" borderRadius="base" background="base">
                  <s-stack direction="block" gap="small">
                    <s-text tone="neutral">
                      Tip: You can also test manually — open your store in a new tab, add any product to the cart, then return here and click "Test my cart".
                    </s-text>
                  </s-stack>
                </s-box>
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
                  These two settings drive your cart's core experience. You can refine everything else in Settings later.
                </s-text>
                <Form method="post">
                  <input type="hidden" name="intent" value="step3_configure" />
                  <s-stack direction="block" gap="base">
                    <FormField
                      label="Free shipping threshold (USD)"
                      id="freeShippingThresholdDollars"
                      helperText="Enter 0 to disable the free shipping bar"
                      infoTip="The cart value at which you offer free shipping. This drives the progress bar customers see — e.g. 'Add $12 more for free shipping'."
                    >
                      <input
                        id="freeShippingThresholdDollars"
                        name="freeShippingThresholdDollars"
                        type="number"
                        min="0"
                        step="0.01"
                        defaultValue={centsToDollars(data.freeShippingThresholdCents)}
                        aria-invalid={!!(actionData?.success === false && actionData?.error)}
                        style={{ padding: "6px 8px", border: "1px solid var(--p-color-border, #c9cccf)", borderRadius: "6px", fontSize: "14px", width: "160px" }}
                      />
                    </FormField>
                    <FormField
                      label="Recommendation strategy"
                      id="recommendationStrategy"
                      infoTip="How RevPRO selects products to show in the cart. 'Collection match' is a great default — it recommends products from the same collections as items already in the cart."
                    >
                      <select
                        id="recommendationStrategy"
                        name="recommendationStrategy"
                        defaultValue={data.recommendationStrategy}
                        style={{ padding: "6px 8px", border: "1px solid var(--p-color-border, #c9cccf)", borderRadius: "6px", fontSize: "14px", minWidth: "200px", background: "var(--p-color-bg-surface, #fff)" }}
                      >
                        <option value="COLLECTION_MATCH">Collection match — show products from the same collections</option>
                        <option value="MANUAL_COLLECTION">Manual collection — you choose which collections</option>
                        <option value="TAG_MATCH">Tag match — match by product tags</option>
                        <option value="BEST_SELLING">Best selling — show your top sellers</option>
                        <option value="NEW_ARRIVALS">New arrivals — show recently added products</option>
                      </select>
                    </FormField>
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
                <s-heading>Ready to launch</s-heading>
                <s-text tone="neutral">Your cart widget is configured and the extension is active. Hit launch to go live.</s-text>
                <s-box padding="small" borderWidth="base" borderRadius="base" background="base">
                  <s-stack direction="block" gap="small">
                    <s-text tone="neutral">What happens next:</s-text>
                    <s-text tone="neutral">— Your cart drawer becomes active on the storefront immediately</s-text>
                    <s-text tone="neutral">— Metrics appear in Overview after your first customer interactions</s-text>
                    <s-text tone="neutral">— Fine-tune colors, milestones, and more in Settings anytime</s-text>
                  </s-stack>
                </s-box>
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
