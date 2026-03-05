import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { Form, redirect, useActionData, useLoaderData, useNavigation, useSearchParams } from "react-router";
import { AppLink } from "~/components/AppLink";
import { useState, useMemo, useEffect } from "react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "~/shopify.server";
import { getShopConfig, getFallbackShopConfig, invalidateShopConfigCache } from "~/lib/shop-config.server";
import { getAppLayoutFromContext } from "~/lib/request-context.server";
import { normalizeShopDomain, warnIfShopNotCanonical } from "~/lib/shop-domain.server";
import { getBillingContext } from "~/lib/billing-context.server";
import { validateSettingsForm, parseMilestonesJson, parseManualCollectionIds, parseMilestonesForUI } from "~/lib/settings-validation.server";
import type { SettingsFormData } from "~/lib/settings-validation.server";
import { type CartProConfigV3, mergeWithDefaultV3 } from "~/lib/config-v3";
import { featureFlagsFromCapabilities } from "~/lib/feature-flags-from-billing.server";
import { logWarn, logResilience } from "~/lib/logger.server";
import { prisma } from "~/lib/prisma.server";
import { getCatalogForShop } from "~/lib/catalog.server";
import { generatePreviewDecision, type PreviewRenderState, type PreviewUI } from "~/lib/preview-simulator.server";
import { FormSection } from "~/components/ui/FormSection";
import { FormField } from "~/components/ui/FormField";
import { SelectField } from "~/components/ui/SelectField";
import { CartPreview } from "~/components/CartPreview";
import settingsStyles from "~/styles/settingsPage.module.css";
import previewPanelStyles from "~/styles/previewPanel.module.css";

/** Map form recommendation strategy to V3 upsell strategy. */
const FORM_STRATEGY_TO_V3: Record<string, CartProConfigV3["upsell"]["strategy"]> = {
  MANUAL_COLLECTION: "manual",
  COLLECTION_MATCH: "collection",
  TAG_MATCH: "aov",
  BEST_SELLING: "aov",
  NEW_ARRIVALS: "aov",
};

/**
 * Build canonical configV3 from settings form data and existing configV3.
 * Preserves existing nested rules (standardRules, freeGifts.rules, etc.) and any field not in the form.
 * Does not mutate DEFAULT_CONFIG_V3 or existingConfigV3.
 */
function buildConfigV3FromForm(
  formData: SettingsFormData,
  existingConfigV3: unknown
): CartProConfigV3 {
  const base = mergeWithDefaultV3(
    existingConfigV3 as Partial<CartProConfigV3> | null | undefined
  );

  // Appearance: flat → appearance.*
  if (formData.primaryColor !== undefined && formData.primaryColor !== "") {
    base.appearance.primaryColor = formData.primaryColor;
  }
  if (formData.accentColor !== undefined && formData.accentColor !== "") {
    base.appearance.accentColor = formData.accentColor;
  }
  base.appearance.borderRadius = formData.borderRadius;
  base.appearance.showConfetti = formData.showConfetti;
  base.appearance.countdownEnabled = formData.countdownEnabled;
  base.appearance.emojiMode = formData.emojiMode;

  // Feature flags: flat → featureFlags.*
  base.featureFlags.enableUpsell = formData.enableCrossSell;
  base.featureFlags.enableRewards = formData.enableMilestones;
  base.featureFlags.enableDiscounts = formData.enableCouponTease;

  // Rewards: milestonesJson → rewards.tiers (safe parse)
  let tiers = base.rewards.tiers;
  try {
    const parsed = JSON.parse(formData.milestonesJson) as unknown;
    if (Array.isArray(parsed)) {
      tiers = parsed;
    }
  } catch {
    // keep base.rewards.tiers
  }
  base.rewards.tiers = tiers;

  // Upsell: strategy, limit, collections
  const v3Strategy =
    FORM_STRATEGY_TO_V3[formData.recommendationStrategy] ?? base.upsell.strategy;
  base.upsell.strategy = v3Strategy;
  base.upsell.limit = formData.recommendationLimit;
  let collections = base.upsell.collections;
  try {
    const parsed = JSON.parse(formData.manualCollectionIds) as unknown;
    if (Array.isArray(parsed)) {
      collections = parsed.filter((c): c is string => typeof c === "string");
    }
  } catch {
    // keep base.upsell.collections
  }
  base.upsell.collections = collections;

  // Runtime version for dynamic embed (v1/v2/v3). Default "v2".
  if (
    formData.runtimeVersion === "v1" ||
    formData.runtimeVersion === "v2" ||
    formData.runtimeVersion === "v3"
  ) {
    base.runtimeVersion = formData.runtimeVersion;
  }

  // Safety: always set version; ensure no undefined nested objects
  base.version = "3.0.0";
  return base;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const appLayout = getAppLayoutFromContext();
  let shop: string;
  let config: Awaited<ReturnType<typeof getShopConfig>>;
  let admin: { graphql: (query: string, opts?: unknown) => Promise<Response> };
  if (appLayout) {
    shop = appLayout.shop;
    config = appLayout.config;
    admin = appLayout.admin;
  } else {
    const auth = await authenticate.admin(request);
    const rawShop = auth.session.shop;
    shop = normalizeShopDomain(rawShop);
    warnIfShopNotCanonical(rawShop, shop);
    try {
      config = await getShopConfig(shop);
    } catch (err) {
      logResilience({
        shop,
        route: "app.settings",
        message: "getShopConfig failed; using fallback config",
        meta: { errorType: err instanceof Error ? err.name : "Unknown", fallbackUsed: true },
      });
      config = getFallbackShopConfig(shop);
    }
    admin = auth.admin as { graphql: (query: string, opts?: unknown) => Promise<Response> };
  }
  const billing = await getBillingContext(shop, config);
  const manualCollectionIds =
    config.manualCollectionIds != null && Array.isArray(config.manualCollectionIds)
      ? JSON.stringify(config.manualCollectionIds as string[], null, 2)
      : "[]";

  const milestonesJson =
    typeof config.milestonesJson === "string"
      ? config.milestonesJson
      : JSON.stringify(config.milestonesJson as unknown, null, 2);
  const milestones = parseMilestonesForUI(config.milestonesJson);

  let initialPreviewRenderState: PreviewRenderState | null = null;
  try {
    const catalog = await getCatalogForShop(admin, shop, "USD", request);
    initialPreviewRenderState = await generatePreviewDecision(shop, admin, undefined, config, catalog);
  } catch (err) {
    if (err instanceof Response && err.status === 302) throw err;
    logWarn({
      shop,
      route: "app.settings",
      message: "Settings: failed to generate initial preview render state",
      meta: { error: err instanceof Error ? err.message : String(err) },
    });
  }

  const configV3 = config.configV3 as Partial<CartProConfigV3> | null | undefined;
  const runtimeVersion =
    configV3?.runtimeVersion === "v1" || configV3?.runtimeVersion === "v2" || configV3?.runtimeVersion === "v3"
      ? configV3.runtimeVersion
      : "v2";

  /** Feature flags as applied on storefront (from billing). Shown so merchants see plan state. */
  const planFeatureFlags = featureFlagsFromCapabilities(billing.capabilities);

  const savedFromRedirect = new URL(request.url).searchParams.get("saved") === "1";
  return {
    savedFromRedirect,
    planFeatureFlags,
    config: {
      freeShippingThresholdCents: config.freeShippingThresholdCents,
      baselineAovCents: config.baselineAovCents,
      enableCrossSell: config.enableCrossSell,
      enableMilestones: config.enableMilestones,
      enableCouponTease: config.enableCouponTease,
      milestonesJson,
      milestones,
      recommendationStrategy: config.recommendationStrategy ?? "COLLECTION_MATCH",
      recommendationLimit: config.recommendationLimit ?? 1,
      manualCollectionIds,
      primaryColor: config.primaryColor ?? "",
      accentColor: config.accentColor ?? "",
      borderRadius: config.borderRadius ?? 12,
      showConfetti: config.showConfetti ?? true,
      countdownEnabled: config.countdownEnabled ?? true,
      emojiMode: config.emojiMode ?? true,
      engineVersion: config.engineVersion ?? "v1",
      runtimeVersion,
    },
    capabilities: billing.capabilities,
    initialPreviewRenderState,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const rawShop = session.shop;
  const shop = normalizeShopDomain(rawShop);
  warnIfShopNotCanonical(rawShop, shop);

  if (request.method !== "POST") {
    return Response.json({ success: false, error: "Method not allowed" }, { status: 405 });
  }

  const formData = await request.formData();
  const validation = validateSettingsForm(formData);

  if (!validation.success) {
    return Response.json({ success: false, error: validation.error }, { status: 400 });
  }

  const { data } = validation;
  const milestones = parseMilestonesJson(data.milestonesJson);
  const manualCollectionIds = parseManualCollectionIds(data.manualCollectionIds);

  try {
    const existingShopConfig = await prisma.shopConfig.findUnique({
      where: { shopDomain: shop },
      select: { configV3: true },
    });
    const newConfigV3 = buildConfigV3FromForm(data, existingShopConfig?.configV3 ?? null);

    await prisma.shopConfig.update({
      where: { shopDomain: shop },
      data: {
        freeShippingThresholdCents: data.freeShippingThresholdCents,
        baselineAovCents: data.baselineAovCents,
        enableCrossSell: data.enableCrossSell,
        enableMilestones: data.enableMilestones,
        enableCouponTease: data.enableCouponTease,
        milestonesJson: milestones,
        recommendationStrategy: data.recommendationStrategy,
        recommendationLimit: data.recommendationLimit,
        manualCollectionIds,
        primaryColor: data.primaryColor ?? null,
        accentColor: data.accentColor ?? null,
        borderRadius: data.borderRadius,
        showConfetti: data.showConfetti,
        countdownEnabled: data.countdownEnabled,
        emojiMode: data.emojiMode,
        engineVersion: data.engineVersion,
        configV3: newConfigV3 as object,
      },
    });
  } catch (err) {
    logWarn({
      shop,
      message: "Failed to save settings",
      meta: { error: err instanceof Error ? err.message : String(err) },
    });
    return Response.json(
      { success: false, error: "Failed to save settings." },
      { status: 500 }
    );
  }

  invalidateShopConfigCache(shop);
  const url = new URL(request.url);
  url.searchParams.set("saved", "1");
  return redirect(url.pathname + "?" + url.searchParams.toString());
};

function centsToDollars(cents: number): string {
  return (cents / 100).toFixed(2);
}

type ActionData =
  | { success: true }
  | { success: false; error: string };

type FieldErrors = {
  freeShippingThreshold?: string;
  baselineAov?: string;
  milestones?: string;
  recommendationLimit?: string;
};

function parseActionErrorToFieldErrors(error: string): FieldErrors {
  const out: FieldErrors = {};
  if (/milestone|spend amount|reward label/i.test(error)) out.milestones = error;
  else if (/free shipping|threshold|positive/i.test(error)) out.freeShippingThreshold = error;
  else if (/baseline|aov/i.test(error)) out.baselineAov = error;
  else if (/recommendation limit|1 and 8/i.test(error)) out.recommendationLimit = error;
  else out.freeShippingThreshold = error;
  return out;
}

const RECOMMENDATION_STRATEGIES = [
  { value: "COLLECTION_MATCH", label: "Collection match" },
  { value: "MANUAL_COLLECTION", label: "Manual collection" },
  { value: "TAG_MATCH", label: "Tag match" },
  { value: "BEST_SELLING", label: "Best selling" },
  { value: "NEW_ARRIVALS", label: "New arrivals" },
] as const;

type MilestoneRow = { spendDollars: string; label: string };

function toMilestoneRows(milestones: { amount: number; label: string }[]): MilestoneRow[] {
  if (milestones.length === 0) return [{ spendDollars: "", label: "" }];
  return milestones.map((m) => ({
    spendDollars: (m.amount / 100).toFixed(2),
    label: m.label,
  }));
}

const MOCK_CART_TOTAL_CENTS = 1999;

/** Build PreviewRenderState for live preview from initial server state + local form state. No API, no persist. */
function mergePreviewRenderState(
  initial: PreviewRenderState | null,
  state: {
    primaryColor: string;
    accentColor: string;
    borderRadius: number;
    freeShippingThresholdCents: number;
    emojiMode: boolean;
    showConfetti: boolean;
    countdownEnabled: boolean;
    enableCrossSell: boolean;
    enableMilestones: boolean;
    enableCouponTease: boolean;
    milestoneAmounts: { amount: number; label: string }[];
  },
  capabilities: { allowMilestones: boolean }
): PreviewRenderState {
  const baseDecision = initial?.decision ?? {
    crossSell: [],
    freeShippingRemaining: 0,
    suppressCheckout: false,
    milestones: [],
    enableCouponTease: false,
  };
  const freeShippingRemaining = Math.max(0, state.freeShippingThresholdCents - MOCK_CART_TOTAL_CENTS);
  const milestones =
    capabilities.allowMilestones && state.enableMilestones && state.milestoneAmounts.length > 0
      ? state.milestoneAmounts
      : state.enableMilestones
        ? baseDecision.milestones
        : [];
  const crossSell = state.enableCrossSell ? baseDecision.crossSell : [];
  return {
    ui: {
      primaryColor: state.primaryColor || null,
      accentColor: state.accentColor || null,
      borderRadius: state.borderRadius,
      showConfetti: state.showConfetti,
      countdownEnabled: state.countdownEnabled,
      emojiMode: state.emojiMode,
    },
    decision: {
      ...baseDecision,
      crossSell,
      freeShippingRemaining,
      enableCouponTease: state.enableCouponTease,
      milestones,
    },
  };
}

export default function SettingsPage() {
  const { config, capabilities, planFeatureFlags, initialPreviewRenderState, savedFromRedirect } = useLoaderData<typeof loader>();
  const actionData = useActionData() as ActionData | undefined;
  const navigation = useNavigation();
  const [searchParams, setSearchParams] = useSearchParams();
  const success = savedFromRedirect === true || actionData?.success === true;
  const error = actionData && !actionData.success ? actionData.error : null;
  const isSubmitting = navigation.state === "submitting";

  const [strategy, setStrategy] = useState(config.recommendationStrategy);
  const [engineVersion, setEngineVersion] = useState(config.engineVersion);
  const [runtimeVersion, setRuntimeVersion] = useState(
    (config as { runtimeVersion?: "v1" | "v2" | "v3" }).runtimeVersion ?? "v2"
  );
  const initialRows = useMemo(
    () => toMilestoneRows(config.milestones ?? []),
    [config.milestones]
  );
  const [milestoneRows, setMilestoneRows] = useState<MilestoneRow[]>(initialRows);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [showSuccessBanner, setShowSuccessBanner] = useState(true);

  /* Reactive preview state: derived from form, not persisted until submit */
  const [previewPrimaryColor, setPreviewPrimaryColor] = useState(config.primaryColor || "#111111");
  const [previewAccentColor, setPreviewAccentColor] = useState(config.accentColor || "#16a34a");
  const [previewBorderRadius, setPreviewBorderRadius] = useState(config.borderRadius);
  const [previewThresholdCents, setPreviewThresholdCents] = useState(config.freeShippingThresholdCents);
  const [previewEmojiMode, setPreviewEmojiMode] = useState(config.emojiMode);
  const [previewShowConfetti, setPreviewShowConfetti] = useState(config.showConfetti);
  const [previewCountdownEnabled, setPreviewCountdownEnabled] = useState(config.countdownEnabled);
  const [previewEnableCrossSell, setPreviewEnableCrossSell] = useState(config.enableCrossSell);
  const [previewEnableMilestones, setPreviewEnableMilestones] = useState(config.enableMilestones);
  const [previewEnableCouponTease, setPreviewEnableCouponTease] = useState(config.enableCouponTease);

  useEffect(() => {
    if (actionData && !actionData.success && actionData.error) {
      setFieldErrors(parseActionErrorToFieldErrors(actionData.error));
    } else if (savedFromRedirect || actionData?.success === true) {
      setFieldErrors({});
      setShowSuccessBanner(true);
      if (searchParams.get("saved") === "1") {
        setSearchParams(
          (prev) => {
            const p = new URLSearchParams(prev);
            p.delete("saved");
            return p;
          },
          { replace: true }
        );
      }
      const t = setTimeout(() => setShowSuccessBanner(false), 4500);
      return () => clearTimeout(t);
    }
  }, [actionData, savedFromRedirect]);

  const milestonesJsonValue = useMemo(() => {
    const valid = milestoneRows.filter(
      (r) => r.label.trim() !== "" && r.spendDollars.trim() !== "" && !Number.isNaN(parseFloat(r.spendDollars))
    );
    const arr = valid.map((r) => ({
      amount: Math.round(parseFloat(r.spendDollars) * 100),
      label: r.label.trim(),
    }));
    return JSON.stringify(arr);
  }, [milestoneRows]);

  const previewMilestoneAmounts = useMemo(() => {
    const valid = milestoneRows.filter(
      (r) => r.label.trim() !== "" && r.spendDollars.trim() !== "" && !Number.isNaN(parseFloat(r.spendDollars))
    );
    return valid.map((r) => ({
      amount: Math.round(parseFloat(r.spendDollars) * 100),
      label: r.label.trim(),
    }));
  }, [milestoneRows]);

  const previewRenderState = useMemo(
    () =>
      mergePreviewRenderState(
        initialPreviewRenderState ?? null,
        {
          primaryColor: previewPrimaryColor,
          accentColor: previewAccentColor,
          borderRadius: previewBorderRadius,
          freeShippingThresholdCents: previewThresholdCents,
          emojiMode: previewEmojiMode,
          showConfetti: previewShowConfetti,
          countdownEnabled: previewCountdownEnabled,
          enableCrossSell: previewEnableCrossSell,
          enableMilestones: previewEnableMilestones,
          enableCouponTease: previewEnableCouponTease,
          milestoneAmounts: previewMilestoneAmounts,
        },
        capabilities
      ),
    [
      initialPreviewRenderState,
      previewPrimaryColor,
      previewAccentColor,
      previewBorderRadius,
      previewThresholdCents,
      previewEmojiMode,
      previewShowConfetti,
      previewCountdownEnabled,
      previewEnableCrossSell,
      previewEnableMilestones,
      previewEnableCouponTease,
      previewMilestoneAmounts,
      capabilities,
    ]
  );

  const addMilestone = () => {
    setMilestoneRows((prev) => [...prev, { spendDollars: "", label: "" }]);
  };
  const removeMilestone = (index: number) => {
    setMilestoneRows((prev) => {
      const next = prev.filter((_, i) => i !== index);
      return next.length === 0 ? [{ spendDollars: "", label: "" }] : next;
    });
  };
  const updateMilestone = (index: number, field: "spendDollars" | "label", value: string) => {
    setMilestoneRows((prev) =>
      prev.map((row, i) => (i === index ? { ...row, [field]: value } : row))
    );
    setFieldErrors((e) => ({ ...e, milestones: undefined }));
  };

  const validateThreshold = (value: string): string | undefined => {
    const n = parseFloat(value);
    if (value.trim() === "") return undefined;
    if (Number.isNaN(n)) return "Enter a valid number.";
    if (n < 0) return "Threshold must be a positive number.";
    return undefined;
  };

  const validateMilestonesFromRows = (rows: MilestoneRow[]): string | undefined => {
    const valid = rows.filter(
      (r) => r.label.trim() !== "" && r.spendDollars.trim() !== "" && !Number.isNaN(parseFloat(r.spendDollars))
    );
    if (valid.length === 0) return undefined;
    for (const r of valid) {
      const amount = parseFloat(r.spendDollars);
      if (amount <= 0) return "Each milestone needs a valid spend amount (positive number) and reward label.";
    }
    return undefined;
  };

  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    const form = e.currentTarget;
    const threshVal = (form.elements.namedItem("freeShippingThresholdDollars") as HTMLInputElement | null)?.value ?? "";
    const aovVal = (form.elements.namedItem("baselineAovDollars") as HTMLInputElement | null)?.value ?? "";
    const threshErr = validateThreshold(threshVal);
    const aovErr = validateThreshold(aovVal);
    const milestonesErr = validateMilestonesFromRows(milestoneRows);
    const next: FieldErrors = {};
    if (threshErr) next.freeShippingThreshold = threshErr;
    if (aovErr) next.baselineAov = aovErr;
    if (milestonesErr) next.milestones = milestonesErr;
    if (Object.keys(next).length > 0) {
      e.preventDefault();
      setFieldErrors(next);
      return;
    }
    setFieldErrors({});
  };

  return (
    <s-page heading="Settings">
      {success && showSuccessBanner && (
        <s-banner tone="success" dismissible={true}>
          Settings saved successfully.
        </s-banner>
      )}
      {error && (
        <s-banner tone="critical" dismissible={false}>
          {error.includes("Failed to save") ? "We couldn't save your changes. Please check the fields below and try again." : error}
        </s-banner>
      )}
      <div className={previewPanelStyles.settingsWithPreview}>
        <div className={previewPanelStyles.formColumn}>
      <Form method="post" onSubmit={handleSubmit}>
        <input type="hidden" name="milestonesJson" value={milestonesJsonValue} />
        <fieldset disabled={isSubmitting} className={settingsStyles.fieldsetReset}>
        <s-stack direction="block" gap="base">
          <div className={settingsStyles.section}>
            <FormSection
              heading="Storefront state"
              description="What your storefront is using. Features are gated by your plan."
            >
              <div className={settingsStyles.planStateBlock}>
                <div className={settingsStyles.planStateRow}>
                  <s-text tone="subdued">Runtime</s-text>
                  <s-text><strong>{(config as { runtimeVersion?: string }).runtimeVersion === "v3" ? "V3" : (config as { runtimeVersion?: string }).runtimeVersion === "v1" ? "V1" : "V2"}</strong></s-text>
                </div>
                <div className={settingsStyles.planStateRow}>
                  <s-text tone="subdued">Upsell</s-text>
                  <s-text>{planFeatureFlags.enableUpsell ? "On" : "Off"}</s-text>
                </div>
                <div className={settingsStyles.planStateRow}>
                  <s-text tone="subdued">Rewards</s-text>
                  <s-text>{planFeatureFlags.enableRewards ? "On" : "Off"}</s-text>
                </div>
                <div className={settingsStyles.planStateRow}>
                  <s-text tone="subdued">Coupon tease</s-text>
                  <s-text>{planFeatureFlags.enableDiscounts ? "On" : "Off"}</s-text>
                </div>
                <div className={settingsStyles.planStateRow}>
                  <s-text tone="subdued">Analytics</s-text>
                  <s-text>{planFeatureFlags.enableAnalytics ? "On" : "Off"}</s-text>
                </div>
                {(!capabilities.allowStrategySelection || !capabilities.allowUIConfig || !capabilities.allowCouponTease) && (
                  <p className={settingsStyles.lockHint}>
                    Some features are limited by your plan. <AppLink to="/app/upgrade">Upgrade</AppLink> for more.
                  </p>
                )}
              </div>
            </FormSection>
          </div>
          <div className={settingsStyles.section}>
            <FormSection
              heading="Cart Pro Engine"
              description="Choose which engine version runs on your storefront. Change anytime for instant rollback."
            >
              <SelectField
                label="Engine version"
                name="engineVersion"
                value={engineVersion}
                options={[
                  { value: "v1", label: "V1 (decision route)" },
                  { value: "v2", label: "V2 (config-first)" },
                ]}
                onChange={setEngineVersion}
              />
              <SelectField
                label="Runtime version (storefront)"
                name="runtimeVersion"
                value={runtimeVersion}
                options={[
                  { value: "v1", label: "V1" },
                  { value: "v2", label: "V2" },
                  { value: "v3", label: "V3" },
                ]}
                onChange={(v) => setRuntimeVersion(v as "v1" | "v2" | "v3")}
              />
            </FormSection>
          </div>
          <div className={settingsStyles.section}>
            <FormSection
              heading="Core Revenue Controls"
              description="Thresholds that drive free shipping and upsell timing."
            >
              <FormField
                label="Free Shipping Threshold"
                id="freeShippingThresholdDollars"
                helperText="Spend amount in dollars (e.g. 50.00)"
                error={fieldErrors.freeShippingThreshold}
              >
                <input
                  id="freeShippingThresholdDollars"
                  type="number"
                  name="freeShippingThresholdDollars"
                  min={0}
                  step={0.01}
                  defaultValue={centsToDollars(config.freeShippingThresholdCents)}
                  className={settingsStyles.numberInput}
                  aria-invalid={!!fieldErrors.freeShippingThreshold}
                  onChange={(e) => setPreviewThresholdCents(Math.round(parseFloat(e.target.value || "0") * 100))}
                />
              </FormField>
              <FormField
                label="Baseline AOV"
                id="baselineAovDollars"
                helperText="Baseline AOV helps determine intelligent upsell timing."
                error={fieldErrors.baselineAov}
              >
                <input
                  id="baselineAovDollars"
                  type="number"
                  name="baselineAovDollars"
                  min={0}
                  step={0.01}
                  defaultValue={centsToDollars(config.baselineAovCents)}
                  className={settingsStyles.numberInput}
                  aria-invalid={!!fieldErrors.baselineAov}
                />
              </FormField>
            </FormSection>
          </div>

          <div className={settingsStyles.section}>
            <FormSection heading="Cross-Sell Controls">
              <s-checkbox
                name="enableCrossSell"
                label="Enable Cross-Sell"
                defaultChecked={config.enableCrossSell}
                value="on"
                onChange={(e: { currentTarget: { checked: boolean } }) => setPreviewEnableCrossSell(e.currentTarget.checked)}
              />
              {capabilities.allowStrategySelection ? (
                <>
                  <SelectField
                    label="Recommendation Strategy"
                    name="recommendationStrategy"
                    value={strategy}
                    options={[...RECOMMENDATION_STRATEGIES]}
                    onChange={setStrategy}
                  />
                  <FormField
                    label="Recommendation Limit"
                    id="recommendationLimit"
                    helperText="Number of recommendations to show (1–8)"
                    error={fieldErrors.recommendationLimit}
                  >
                    <input
                      id="recommendationLimit"
                      type="number"
                      name="recommendationLimit"
                      min={1}
                      max={8}
                      defaultValue={String(config.recommendationLimit)}
                      className={settingsStyles.numberInput}
                      aria-invalid={!!fieldErrors.recommendationLimit}
                    />
                  </FormField>
                  {strategy === "MANUAL_COLLECTION" && (
                    <s-text-area
                      name="manualCollectionIds"
                      label="Manual collection IDs"
                      defaultValue={config.manualCollectionIds}
                      rows={4}
                      data-1p-ignore
                    />
                  )}
                </>
              ) : (
                <div className={settingsStyles.lockedBlock}>
                  <span className={settingsStyles.lockHint}>
                    <s-text tone="neutral">Next stage: Advanced plan</s-text>
                  </span>
                  <s-text tone="neutral">
                    Strategy: Collection match · Limit: 1
                  </s-text>
                  <AppLink to="/app/upgrade">
                    <s-button variant="tertiary">Upgrade for Advanced Controls</s-button>
                  </AppLink>
                  <input type="hidden" name="recommendationStrategy" value="COLLECTION_MATCH" />
                  <input type="hidden" name="recommendationLimit" value={String(config.recommendationLimit)} />
                  <input type="hidden" name="manualCollectionIds" value={config.manualCollectionIds} />
                </div>
              )}
            </FormSection>
          </div>

          <div className={settingsStyles.section}>
            <FormSection
              heading="Reward Milestones"
              description="Incentives customers unlock as cart value increases."
            >
              <s-checkbox
                name="enableMilestones"
                label="Enable Milestones"
                defaultChecked={config.enableMilestones}
                value="on"
                onChange={(e: { currentTarget: { checked: boolean } }) => setPreviewEnableMilestones(e.currentTarget.checked)}
              />
              <div className={settingsStyles.milestoneEditor}>
                <s-text tone="neutral">Spend threshold (dollars) → Reward label</s-text>
                {milestoneRows.map((row, index) => (
                  <div key={index} className={settingsStyles.milestoneRow}>
                    <span className={settingsStyles.milestoneSpendWrap}>
                      <span className={settingsStyles.milestoneSpendPrefix}>$</span>
                      <input
                        type="text"
                        inputMode="decimal"
                        placeholder="0.00"
                        className={settingsStyles.milestoneInput}
                        value={row.spendDollars}
                        onChange={(e) => updateMilestone(index, "spendDollars", e.target.value)}
                        data-1p-ignore
                        aria-label="Spend amount (dollars)"
                      />
                    </span>
                    <span className={settingsStyles.milestoneArrow} aria-hidden>→</span>
                    <input
                      type="text"
                      placeholder="Reward label"
                      className={settingsStyles.milestoneInput}
                      value={row.label}
                      onChange={(e) => updateMilestone(index, "label", e.target.value)}
                      data-1p-ignore
                      aria-label="Reward label"
                    />
                    <button
                      type="button"
                      className={settingsStyles.removeMilestone}
                      onClick={() => removeMilestone(index)}
                      aria-label="Remove milestone"
                    >
                      Remove
                    </button>
                  </div>
                ))}
                <s-button type="button" variant="secondary" onClick={addMilestone}>
                  Add Milestone
                </s-button>
              </div>
              {fieldErrors.milestones && (
                <p className={settingsStyles.inlineError} role="alert">
                  {fieldErrors.milestones}
                </p>
              )}
              {capabilities.allowCouponTease ? (
                <s-checkbox
                  name="enableCouponTease"
                  label="Enable Coupon Tease"
                  defaultChecked={config.enableCouponTease}
                  value="on"
                  onChange={(e: { currentTarget: { checked: boolean } }) => setPreviewEnableCouponTease(e.currentTarget.checked)}
                />
              ) : (
                <div className={settingsStyles.lockedInline}>
                  <s-text tone="neutral">Enable Coupon Tease</s-text>
                  <span className={settingsStyles.lockHint}>
                    <s-text tone="neutral">Next stage: Advanced plan</s-text>
                  </span>
                  <input type="hidden" name="enableCouponTease" value="" />
                </div>
              )}
            </FormSection>
          </div>

          <div className={settingsStyles.section}>
            {capabilities.allowUIConfig ? (
              <FormSection heading="Visual Customization">
                <FormField label="Brand color" id="primaryColor" helperText="Primary brand color">
                  <input
                    id="primaryColor"
                    type="color"
                    name="primaryColor"
                    defaultValue={config.primaryColor || "#111111"}
                    className={settingsStyles.colorInput}
                    aria-label="Brand color"
                    onChange={(e) => setPreviewPrimaryColor(e.target.value)}
                  />
                </FormField>
                <FormField label="Accent color" id="accentColor" helperText="Accent and CTAs">
                  <input
                    id="accentColor"
                    type="color"
                    name="accentColor"
                    defaultValue={config.accentColor || "#16a34a"}
                    className={settingsStyles.colorInput}
                    aria-label="Accent color"
                    onChange={(e) => setPreviewAccentColor(e.target.value)}
                  />
                </FormField>
                <FormField label="Border radius" id="borderRadius" helperText="0–32">
                  <input
                    id="borderRadius"
                    type="number"
                    name="borderRadius"
                    min={0}
                    max={32}
                    defaultValue={String(config.borderRadius)}
                    className={settingsStyles.numberInput}
                    onChange={(e) => setPreviewBorderRadius(parseInt(e.target.value, 10) || 0)}
                  />
                </FormField>
                <s-checkbox
                  name="emojiMode"
                  label="Emoji mode"
                  defaultChecked={config.emojiMode}
                  value="on"
                  onChange={(e: { currentTarget: { checked: boolean } }) => setPreviewEmojiMode(e.currentTarget.checked)}
                />
                <s-checkbox
                  name="showConfetti"
                  label="Confetti"
                  defaultChecked={config.showConfetti}
                  value="on"
                  onChange={(e: { currentTarget: { checked: boolean } }) => setPreviewShowConfetti(e.currentTarget.checked)}
                />
                <s-checkbox
                  name="countdownEnabled"
                  label="Countdown"
                  defaultChecked={config.countdownEnabled}
                  value="on"
                  onChange={(e: { currentTarget: { checked: boolean } }) => setPreviewCountdownEnabled(e.currentTarget.checked)}
                />
              </FormSection>
            ) : (
              <FormSection heading="Visual Customization">
                <div className={settingsStyles.lockedBlock}>
                  <span className={settingsStyles.lockHint}>
                    <s-text tone="neutral">Next stage: Advanced plan</s-text>
                  </span>
                  <AppLink to="/app/upgrade">
                    <s-button variant="tertiary">Upgrade for Advanced Controls</s-button>
                  </AppLink>
                </div>
                <input type="hidden" name="primaryColor" value={config.primaryColor} />
                <input type="hidden" name="accentColor" value={config.accentColor} />
                <input type="hidden" name="borderRadius" value={String(config.borderRadius)} />
                <input type="hidden" name="showConfetti" value={config.showConfetti ? "on" : ""} />
                <input type="hidden" name="countdownEnabled" value={config.countdownEnabled ? "on" : ""} />
                <input type="hidden" name="emojiMode" value={config.emojiMode ? "on" : ""} />
              </FormSection>
            )}
          </div>

          <s-button type="submit" variant="primary" disabled={isSubmitting} loading={isSubmitting}>
            {isSubmitting ? "Saving…" : "Save Changes"}
          </s-button>
        </s-stack>
        </fieldset>
      </Form>
        </div>
        <div className={previewPanelStyles.previewColumn}>
          <div className={previewPanelStyles.previewLabel}>Live preview</div>
          <div className={previewPanelStyles.previewDrawerWrap}>
            <CartPreview ui={previewRenderState.ui} decision={previewRenderState.decision} capabilities={capabilities} enableCrossSellOverride={previewEnableCrossSell} />
          </div>
          {runtimeVersion === "v3" && (
            <>
              <div className={previewPanelStyles.previewLabel} style={{ marginTop: "var(--app-space-6)" }}>
                V3 preview
              </div>
              <p className={settingsStyles.v3PreviewHint}>
                Same snapshot as storefront (mergeWithDefaultV3 + featureFlags + recommendations). Save to refresh.
              </p>
              <div className={previewPanelStyles.previewDrawerWrap}>
                <iframe
                  title="Cart Pro V3 preview"
                  src="/app/preview-v3-frame"
                  className={previewPanelStyles.previewV3Iframe}
                />
              </div>
            </>
          )}
        </div>
      </div>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
