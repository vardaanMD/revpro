/**
 * @deprecated This route is no longer active. Archived for reference.
 * App proxy path: /apps/cart-pro/bootstrap
 * Returns static shop UI config + capabilities. Additive; does not replace decision.
 * Uses authenticate.public.appProxy(request). Never throws 500 on config failure.
 */
import { data, type LoaderFunctionArgs } from "react-router";
import { authenticate } from "~/shopify.server";
import { getShopConfig } from "~/lib/shop-config.server";
import { getBillingContext } from "~/lib/billing-context.server";
import { normalizeShopDomain } from "~/lib/shop-domain.server";
import { resolveCapabilities } from "~/lib/capabilities.server";
import { logResilience } from "~/lib/logger.server";

/** Bootstrap response: UI + capabilities only. No cart, crossSell, or shipping. */
export type BootstrapResponse = {
  engineVersion: string;
  ui: {
    primaryColor: string | null;
    accentColor: string | null;
    borderRadius: number;
    showConfetti: boolean;
    countdownEnabled: boolean;
    emojiMode: boolean;
  };
  capabilities: {
    allowUIConfig: boolean;
    allowCrossSell: boolean;
    allowMilestones: boolean;
    allowCouponTease: boolean;
  };
};

/** Safe UI when config unavailable or allowUIConfig false. Bootstrap is the only source of UI for storefront. */
const SAFE_UI_FALLBACK: BootstrapResponse["ui"] = Object.freeze({
  primaryColor: null,
  accentColor: null,
  borderRadius: 12,
  showConfetti: false,
  countdownEnabled: false,
  emojiMode: true,
});

function minimalCapabilities(): BootstrapResponse["capabilities"] {
  const cap = resolveCapabilities("basic");
  return {
    allowUIConfig: cap.allowUIConfig,
    allowCrossSell: cap.allowCrossSell,
    allowMilestones: cap.allowMilestones,
    allowCouponTease: cap.allowCouponTease,
  };
}

function safeBootstrapResponse(
  engineVersion: string,
  ui: BootstrapResponse["ui"],
  capabilities: BootstrapResponse["capabilities"]
): BootstrapResponse {
  return { engineVersion, ui, capabilities };
}

export async function loader({ request }: LoaderFunctionArgs) {
  let shop = "unknown";

  try {
    await authenticate.public.appProxy(request);
    const shopRaw = new URL(request.url).searchParams.get("shop") ?? "unknown";
    shop = normalizeShopDomain(shopRaw);
  } catch (_) {
    logResilience({
      shop,
      route: "cart.bootstrap",
      message: "Bootstrap request: app proxy auth failed, returning safe fallback",
      meta: { fallbackUsed: true },
    });
    return data(
      safeBootstrapResponse("v1", SAFE_UI_FALLBACK, minimalCapabilities()),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }

  try {
    const config = await getShopConfig(shop);
    const billing = await getBillingContext(shop, config);
    const capabilities = resolveCapabilities(billing.plan);

    const responseCapabilities: BootstrapResponse["capabilities"] = {
      allowUIConfig: capabilities.allowUIConfig,
      allowCrossSell: capabilities.allowCrossSell,
      allowMilestones: capabilities.allowMilestones,
      allowCouponTease: capabilities.allowCouponTease,
    };

    if (!billing.isEntitled) {
      if (process.env.NODE_ENV === "development") {
        logResilience({
          shop,
          route: "cart.bootstrap",
          message: "Bootstrap request",
          meta: {
            entitled: billing.isEntitled,
            plan: billing.plan,
            allowUIConfig: responseCapabilities.allowUIConfig,
          },
        });
      }
      return data(
        safeBootstrapResponse("v1", SAFE_UI_FALLBACK, responseCapabilities),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    const ui: BootstrapResponse["ui"] = responseCapabilities.allowUIConfig
      ? {
          primaryColor: config.primaryColor ?? null,
          accentColor: config.accentColor ?? null,
          borderRadius: config.borderRadius ?? 12,
          showConfetti: config.showConfetti ?? true,
          countdownEnabled: config.countdownEnabled ?? true,
          emojiMode: config.emojiMode ?? true,
        }
      : SAFE_UI_FALLBACK;

    if (process.env.NODE_ENV === "development") {
      logResilience({
        shop,
        route: "cart.bootstrap",
        message: "Bootstrap request",
        meta: {
          entitled: billing.isEntitled,
          plan: billing.plan,
          allowUIConfig: responseCapabilities.allowUIConfig,
        },
      });
    }

    return data(safeBootstrapResponse(config.engineVersion ?? "v3", ui, responseCapabilities), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (_err) {
    logResilience({
      shop,
      route: "cart.bootstrap",
      message: "Bootstrap request: config/billing failed, returning safe fallback",
      meta: { fallbackUsed: true },
    });
    return data(
      safeBootstrapResponse("v3", SAFE_UI_FALLBACK, minimalCapabilities()),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }
}
