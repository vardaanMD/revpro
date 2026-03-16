import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { Form, redirect, useActionData, useLoaderData, useNavigation, useSearchParams } from "react-router";
import { AppLink } from "~/components/AppLink";
import { useState, useMemo, useEffect, useRef } from "react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "~/shopify.server";
import { getShopConfig, getFallbackShopConfig, invalidateShopConfigCache } from "~/lib/shop-config.server";
import { ensureShopCurrencySynced, getShopCurrency } from "~/lib/shop-currency.server";
import { getAppLayoutFromContext } from "~/lib/request-context.server";
import { normalizeShopDomain, warnIfShopNotCanonical } from "~/lib/shop-domain.server";
import { getBillingContext } from "~/lib/billing-context.server";
import { DEFAULT_SHOP_CONFIG } from "~/lib/default-config.server";
import { validateSettingsForm, parseMilestonesJson, parseManualCollectionIds, parseMilestonesForUI } from "~/lib/settings-validation.server";
import type { SettingsFormData } from "~/lib/settings-validation.server";
import { type CartProConfigV3, mergeWithDefaultV3 } from "~/lib/config-v3";
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
  if (formData.backgroundColor !== undefined && formData.backgroundColor !== "") {
    base.appearance.backgroundColor = formData.backgroundColor;
  }
  if (formData.bannerBackgroundColor !== undefined && formData.bannerBackgroundColor !== "") {
    base.appearance.bannerBackgroundColor = formData.bannerBackgroundColor;
  }
  const headerMessages = [
    formData.cartHeaderMessage1 ?? "",
    formData.cartHeaderMessage2 ?? "",
    formData.cartHeaderMessage3 ?? "",
  ]
    .map((m) => (typeof m === "string" ? m.trim() : ""))
    .filter((m) => m.length > 0)
    .slice(0, 3);
  base.appearance.cartHeaderMessages = headerMessages;

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
  base.upsell.recommendationsHeading =
    typeof formData.recommendationsHeading === "string" && formData.recommendationsHeading.trim()
      ? formData.recommendationsHeading.trim()
      : "You may also like";
  base.discounts.teaseMessage =
    typeof formData.couponTeaseMessage === "string" && formData.couponTeaseMessage.trim()
      ? formData.couponTeaseMessage.trim()
      : "Apply coupon at checkout to unlock savings";
  if (typeof formData.showHeaderBanner === "boolean") base.appearance.showHeaderBanner = formData.showHeaderBanner;
  if (typeof formData.showStickyCartButton === "boolean") base.appearance.showStickyCartButton = formData.showStickyCartButton;
  if (typeof formData.showTeaseMessage === "boolean") base.discounts.showTeaseMessage = formData.showTeaseMessage;

  // Cart drawer is always V3; no runtime toggle.
  base.runtimeVersion = "v3";

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
  const currency = await ensureShopCurrencySynced(shop, admin as Parameters<typeof ensureShopCurrencySynced>[1]);
  const manualCollectionIds =
    config.manualCollectionIds != null && Array.isArray(config.manualCollectionIds)
      ? JSON.stringify(config.manualCollectionIds as string[], null, 2)
      : "[]";

  const milestonesJson =
    typeof config.milestonesJson === "string"
      ? config.milestonesJson
      : JSON.stringify(config.milestonesJson as unknown, null, 2);
  const milestonesParsed = parseMilestonesForUI(config.milestonesJson);
  const defaultTiers = DEFAULT_SHOP_CONFIG.milestonesJson as { amount: number; label: string }[];
  const FIXED_MILESTONE_COUNT = 3;
  const milestones = (() => {
    const list = [...milestonesParsed];
    while (list.length < FIXED_MILESTONE_COUNT) {
      list.push(defaultTiers[list.length] ?? { amount: 2000, label: "10% OFF" });
    }
    return list.slice(0, FIXED_MILESTONE_COUNT);
  })();

  let initialPreviewRenderState: PreviewRenderState | null = null;
  try {
    const catalog = await getCatalogForShop(admin, shop, currency, request);
    initialPreviewRenderState = await generatePreviewDecision(shop, admin, undefined, config, catalog, request, currency);
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
  const appearanceV3 = (configV3?.appearance as Partial<CartProConfigV3["appearance"]> | undefined) ?? {};
  const cartHeaderMessages = Array.isArray(appearanceV3.cartHeaderMessages)
    ? appearanceV3.cartHeaderMessages.filter((m): m is string => typeof m === "string" && m.trim() !== "").slice(0, 3)
    : [];
  const upsellV3 = configV3?.upsell as { recommendationsHeading?: string } | undefined;
  const discountsV3 = configV3?.discounts as { teaseMessage?: string; showTeaseMessage?: boolean } | undefined;

  // Use configV3.appearance as source of truth so form shows same values as storefront; fall back to flat columns for backward compat
  const primaryColor = appearanceV3.primaryColor ?? config.primaryColor ?? "";
  const accentColor = appearanceV3.accentColor ?? config.accentColor ?? "";
  const backgroundColor = appearanceV3.backgroundColor ?? "#ffffff";
  const bannerBackgroundColor = appearanceV3.bannerBackgroundColor ?? "#16a34a";
  const borderRadius = typeof appearanceV3.borderRadius === "number" ? appearanceV3.borderRadius : (config.borderRadius ?? 12);
  const showConfetti = typeof appearanceV3.showConfetti === "boolean" ? appearanceV3.showConfetti : (config.showConfetti ?? true);
  const countdownEnabled = typeof appearanceV3.countdownEnabled === "boolean" ? appearanceV3.countdownEnabled : (config.countdownEnabled ?? true);
  const emojiMode = typeof appearanceV3.emojiMode === "boolean" ? appearanceV3.emojiMode : (config.emojiMode ?? true);

  const savedFromRedirect = new URL(request.url).searchParams.get("saved") === "1";
  return {
    savedFromRedirect,
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
      primaryColor: primaryColor || "#111111",
      accentColor: accentColor || "#16a34a",
      backgroundColor,
      bannerBackgroundColor,
      borderRadius,
      showConfetti,
      countdownEnabled,
      emojiMode,
      engineVersion: "v3",
      cartHeaderMessage1: cartHeaderMessages[0] ?? "",
      cartHeaderMessage2: cartHeaderMessages[1] ?? "",
      cartHeaderMessage3: cartHeaderMessages[2] ?? "",
      recommendationsHeading: upsellV3?.recommendationsHeading ?? "You may also like",
      couponTeaseMessage: discountsV3?.teaseMessage ?? "Apply coupon at checkout to unlock savings",
      showHeaderBanner: appearanceV3.showHeaderBanner !== false,
      showStickyCartButton: appearanceV3.showStickyCartButton !== false,
      showTeaseMessage: discountsV3?.showTeaseMessage !== false,
    },
    capabilities: billing.capabilities,
    initialPreviewRenderState,
    currency,
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
        engineVersion: "v3",
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
  if (milestones.length === 0) return [];
  return milestones.map((m) => ({
    spendDollars: (m.amount / 100).toFixed(2),
    label: m.label,
  }));
}

const MOCK_CART_TOTAL_CENTS = 1999;

/** Build PreviewRenderState for live preview from initial server state + local form state. No API, no persist. */
/** Includes V3 appearance: backgroundColor, bannerBackgroundColor, cartHeaderMessages. */
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
    backgroundColor?: string;
    bannerBackgroundColor?: string;
    cartHeaderMessages?: string[];
    showHeaderBanner: boolean;
    showStickyCartButton: boolean;
    showTeaseMessage: boolean;
    couponTeaseMessage: string;
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
      backgroundColor: state.backgroundColor ?? initial?.ui?.backgroundColor ?? "#ffffff",
      bannerBackgroundColor: state.bannerBackgroundColor ?? initial?.ui?.bannerBackgroundColor ?? "#16a34a",
      cartHeaderMessages: state.cartHeaderMessages && state.cartHeaderMessages.length > 0
        ? state.cartHeaderMessages
        : (initial?.ui?.cartHeaderMessages ?? []),
      showHeaderBanner: state.showHeaderBanner,
      showStickyCartButton: state.showStickyCartButton,
      showTeaseMessage: state.showTeaseMessage,
      couponTeaseMessage: state.couponTeaseMessage,
    },
    decision: {
      ...baseDecision,
      crossSell,
      freeShippingRemaining,
      enableCouponTease: state.enableCouponTease,
      enableMilestones: state.enableMilestones,
      milestones,
    },
  };
}

export default function SettingsPage() {
  const { config, capabilities, initialPreviewRenderState, savedFromRedirect, currency } = useLoaderData<typeof loader>();
  const actionData = useActionData() as ActionData | undefined;
  const navigation = useNavigation();
  const [searchParams, setSearchParams] = useSearchParams();
  const success = savedFromRedirect === true || actionData?.success === true;
  const error = actionData && !actionData.success ? actionData.error : null;
  const isSubmitting = navigation.state === "submitting";

  const [strategy, setStrategy] = useState(config.recommendationStrategy);
  const initialRows = useMemo(
    () => toMilestoneRows(config.milestones ?? []),
    [config.milestones]
  );
  const [milestoneRows, setMilestoneRows] = useState<MilestoneRow[]>(initialRows);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [showSuccessBanner, setShowSuccessBanner] = useState(true);
  const [showStickySave, setShowStickySave] = useState(false);
  const saveButtonRef = useRef<HTMLDivElement>(null);

  /* Reactive preview state: derived from form, not persisted until submit */
  const [previewPrimaryColor, setPreviewPrimaryColor] = useState(config.primaryColor || "#111111");
  const [previewAccentColor, setPreviewAccentColor] = useState(config.accentColor || "#16a34a");
  const [previewBackgroundColor, setPreviewBackgroundColor] = useState(config.backgroundColor || "#ffffff");
  const [previewBannerBackgroundColor, setPreviewBannerBackgroundColor] = useState(config.bannerBackgroundColor || "#16a34a");
  const [previewBorderRadius, setPreviewBorderRadius] = useState(config.borderRadius);
  const [previewThresholdCents, setPreviewThresholdCents] = useState(config.freeShippingThresholdCents);
  const [previewEmojiMode, setPreviewEmojiMode] = useState(config.emojiMode);
  const [previewShowConfetti, setPreviewShowConfetti] = useState(config.showConfetti);
  const [previewCountdownEnabled, setPreviewCountdownEnabled] = useState(config.countdownEnabled);
  const [previewEnableCrossSell, setPreviewEnableCrossSell] = useState(config.enableCrossSell);
  const [previewEnableMilestones, setPreviewEnableMilestones] = useState(config.enableMilestones);
  const [previewEnableCouponTease, setPreviewEnableCouponTease] = useState(config.enableCouponTease);
  const [previewShowHeaderBanner, setPreviewShowHeaderBanner] = useState(config.showHeaderBanner !== false);
  const [previewShowStickyCartButton, setPreviewShowStickyCartButton] = useState(config.showStickyCartButton !== false);
  const previewShowTeaseMessage = true;

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

  useEffect(() => {
    const el = saveButtonRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      ([entry]) => setShowStickySave(!entry?.isIntersecting),
      { threshold: 0, rootMargin: "-80px 0px 0px 0px" }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

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
          backgroundColor: previewBackgroundColor,
          bannerBackgroundColor: previewBannerBackgroundColor,
          cartHeaderMessages: [config.cartHeaderMessage1 ?? "", config.cartHeaderMessage2 ?? "", config.cartHeaderMessage3 ?? ""]
            .map((m) => (typeof m === "string" ? m.trim() : ""))
            .filter((m) => m.length > 0),
          showHeaderBanner: previewShowHeaderBanner,
          showStickyCartButton: previewShowStickyCartButton,
          showTeaseMessage: previewShowTeaseMessage,
          couponTeaseMessage: config.couponTeaseMessage ?? "Apply coupon at checkout to unlock savings",
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
      previewBackgroundColor,
      previewBannerBackgroundColor,
      previewShowHeaderBanner,
      previewShowStickyCartButton,
      previewShowTeaseMessage,
      config.cartHeaderMessage1,
      config.cartHeaderMessage2,
      config.cartHeaderMessage3,
      config.couponTeaseMessage,
      capabilities,
    ]
  );

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
      <div role="status" aria-live="polite" aria-atomic="true" className={settingsStyles.bannerRegion}>
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
      </div>
      <div className={previewPanelStyles.settingsWithPreview}>
        <div className={previewPanelStyles.formColumn}>
      <Form id="settings-form" method="post" onSubmit={handleSubmit}>
        <input type="hidden" name="milestonesJson" value={milestonesJsonValue} />
        <fieldset disabled={isSubmitting} className={settingsStyles.fieldsetReset}>
        <div className={settingsStyles.cardsGrid}>
          <div className={settingsStyles.cardRow}>
            <div className={settingsStyles.card}>
            <FormSection
              heading="Thresholds"
              description="Free shipping and baseline cart value used for recommendations and free shipping bar."
            >
              <FormField
                label="Free Shipping Threshold"
                id="freeShippingThresholdDollars"
                helperText="Spend amount in dollars (e.g. 50.00)"
                error={fieldErrors.freeShippingThreshold}
                infoTip="Cart value (in dollars) at which free shipping unlocks. This drives the progress bar customers see in the cart drawer."
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
                infoTip="Your store's typical order size. Used to tune when upsell recommendations appear. Set to your actual average order value."
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
            <div className={settingsStyles.card}>
            <FormSection heading="Cross-Sell Controls">
              <s-checkbox
                name="enableCrossSell"
                label="Enable Cross-Sell"
                defaultChecked={config.enableCrossSell}
                value="on"
                onChange={(e: React.FormEvent<HTMLElement>) => setPreviewEnableCrossSell((e.currentTarget as HTMLInputElement).checked)}
              />
              {capabilities.allowStrategySelection ? (
                <>
                  <SelectField
                    label="Recommendation Strategy"
                    name="recommendationStrategy"
                    value={strategy}
                    options={[...RECOMMENDATION_STRATEGIES]}
                    onChange={setStrategy}
                    infoTip="How products are chosen to recommend. Collection match uses the product's collections; Tag match uses product tags; Manual lets you specify collection IDs directly."
                  />
                  <FormField
                    label="Recommendation Limit"
                    id="recommendationLimit"
                    helperText="Number of recommendations to show (1–8)"
                    error={fieldErrors.recommendationLimit}
                    infoTip="Max number of recommendations shown per cart session. Higher limits require Advanced or Growth plan."
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
                  <FormField
                    label="Recommendations section title"
                    id="recommendationsHeading"
                    helperText="Heading above the cross-sell product list (e.g. You may also like)"
                    infoTip="The heading text shown above the recommended products list inside the cart drawer."
                  >
                    <input
                      id="recommendationsHeading"
                      type="text"
                      name="recommendationsHeading"
                      placeholder="You may also like"
                      defaultValue={config.recommendationsHeading ?? "You may also like"}
                      className={settingsStyles.textInput}
                      aria-label="Recommendations section title"
                    />
                  </FormField>
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
                  <input type="hidden" name="recommendationsHeading" value={config.recommendationsHeading ?? "You may also like"} />
                </div>
              )}
            </FormSection>
            </div>
          </div>

          <div className={settingsStyles.cardRow}>
            <div className={`${settingsStyles.card} ${settingsStyles.cardFull}`}>
            <FormSection
              heading="Reward Milestones"
              description="Incentives customers unlock as cart value increases."
            >
              {/* Hidden ensures we receive the key when checkbox is unchecked (browsers omit unchecked checkboxes) */}
              <input type="hidden" name="enableMilestones" value="" />
              <s-checkbox
                name="enableMilestones"
                label="Enable Milestones"
                defaultChecked={config.enableMilestones}
                value="on"
                onChange={(e: React.FormEvent<HTMLElement>) => setPreviewEnableMilestones((e.currentTarget as HTMLInputElement).checked)}
              />
              {previewEnableMilestones && (
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
                  </div>
                ))}
              </div>
              )}
              {fieldErrors.milestones && (
                <p className={settingsStyles.inlineError} role="alert">
                  {fieldErrors.milestones}
                </p>
              )}
              {capabilities.allowCouponTease ? (
                <>
                  <s-checkbox
                    name="enableCouponTease"
                    label="Enable Coupon Tease"
                    defaultChecked={config.enableCouponTease}
                    value="on"
                    onChange={(e: React.FormEvent<HTMLElement>) => setPreviewEnableCouponTease((e.currentTarget as HTMLInputElement).checked)}
                  />
                  <FormField
                    label="Coupon tease message"
                    id="couponTeaseMessage"
                    helperText="Message shown when no discount code is applied"
                  >
                    <input
                      id="couponTeaseMessage"
                      type="text"
                      name="couponTeaseMessage"
                      placeholder="Apply coupon at checkout to unlock savings"
                      defaultValue={config.couponTeaseMessage ?? "Apply coupon at checkout to unlock savings"}
                      className={settingsStyles.textInput}
                      aria-label="Coupon tease message"
                    />
                  </FormField>
                  <input type="hidden" name="showTeaseMessage" value="on" />
                </>
              ) : (
                <div className={settingsStyles.lockedInline}>
                  <s-text tone="neutral">Enable Coupon Tease</s-text>
                  <span className={settingsStyles.lockHint}>
                    <s-text tone="neutral">Next stage: Advanced plan</s-text>
                  </span>
                  <input type="hidden" name="enableCouponTease" value="" />
                  <input type="hidden" name="couponTeaseMessage" value={config.couponTeaseMessage ?? "Apply coupon at checkout to unlock savings"} />
                  <input type="hidden" name="showTeaseMessage" value={config.showTeaseMessage !== false ? "on" : ""} />
                </div>
              )}
            </FormSection>
            </div>
          </div>

          <div className={settingsStyles.cardRow}>
            <div className={`${settingsStyles.card} ${settingsStyles.cardFull}`}>
              <FormSection heading="Cart button" description="Show a sticky cart button on the storefront so customers can open the cart from any page.">
                <input type="hidden" name="showStickyCartButton" value="" />
                <s-checkbox
                  name="showStickyCartButton"
                  label="Show sticky cart button"
                  defaultChecked={config.showStickyCartButton !== false}
                  value="on"
                  onChange={(e: React.FormEvent<HTMLElement>) => setPreviewShowStickyCartButton((e.currentTarget as HTMLInputElement).checked)}
                />
              </FormSection>
            </div>
          </div>

          <div className={settingsStyles.cardRow}>
            <div className={`${settingsStyles.card} ${settingsStyles.cardFull}`}>
            {capabilities.allowUIConfig ? (
              <FormSection heading="Visual Customization">
                <div className={settingsStyles.colorRow}>
                <FormField label="Brand color" id="primaryColor" helperText="Primary brand color" infoTip="Main brand color applied to buttons and primary UI elements in the cart drawer.">
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
                <FormField label="Accent color" id="accentColor" helperText="Accent and CTAs" infoTip="Used for call-to-action buttons and highlights in the cart drawer.">
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
                <FormField label="Drawer background" id="backgroundColor" helperText="Cart drawer background color">
                  <input
                    id="backgroundColor"
                    type="color"
                    name="backgroundColor"
                    defaultValue={config.backgroundColor || "#ffffff"}
                    className={settingsStyles.colorInput}
                    aria-label="Drawer background color"
                    onChange={(e) => setPreviewBackgroundColor(e.target.value)}
                  />
                </FormField>
                <FormField label="Message banner background" id="bannerBackgroundColor" helperText="Background for the rotating message section below “Your cart”">
                  <input
                    id="bannerBackgroundColor"
                    type="color"
                    name="bannerBackgroundColor"
                    defaultValue={config.bannerBackgroundColor || "#16a34a"}
                    className={settingsStyles.colorInput}
                    aria-label="Message banner background color"
                    onChange={(e) => setPreviewBannerBackgroundColor(e.target.value)}
                  />
                </FormField>
                </div>
                <FormField label="Border radius" id="borderRadius" helperText="0–32" infoTip="Controls corner rounding across the cart drawer (0 = square corners, 32 = fully rounded).">
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
                  onChange={(e: React.FormEvent<HTMLElement>) => setPreviewEmojiMode((e.currentTarget as HTMLInputElement).checked)}
                />
                <s-checkbox
                  name="showConfetti"
                  label="Confetti"
                  defaultChecked={config.showConfetti}
                  value="on"
                  onChange={(e: React.FormEvent<HTMLElement>) => setPreviewShowConfetti((e.currentTarget as HTMLInputElement).checked)}
                />
                <s-checkbox
                  name="countdownEnabled"
                  label="Countdown"
                  defaultChecked={config.countdownEnabled}
                  value="on"
                  onChange={(e: React.FormEvent<HTMLElement>) => setPreviewCountdownEnabled((e.currentTarget as HTMLInputElement).checked)}
                />
                {/* Hidden ensures we always receive the key when checkbox is unchecked (browsers omit unchecked checkboxes) */}
                <input type="hidden" name="showHeaderBanner" value="" />
                <s-checkbox
                  name="showHeaderBanner"
                  label="Show header message banner"
                  defaultChecked={config.showHeaderBanner !== false}
                  value="on"
                  onChange={(e: React.FormEvent<HTMLElement>) => setPreviewShowHeaderBanner((e.currentTarget as HTMLInputElement).checked)}
                />
                <FormField
                  label="Header messages"
                  id="cartHeaderMessages"
                  helperText="Up to 3 short messages shown under “Your cart”. They rotate automatically."
                >
                  <div className={settingsStyles.stackVertical}>
                    <input
                      id="cartHeaderMessage1"
                      type="text"
                      name="cartHeaderMessage1"
                      defaultValue={config.cartHeaderMessage1 || ""}
                      className={settingsStyles.textInput}
                      placeholder="e.g. Free shipping over $50"
                    />
                    <input
                      id="cartHeaderMessage2"
                      type="text"
                      name="cartHeaderMessage2"
                      defaultValue={config.cartHeaderMessage2 || ""}
                      className={settingsStyles.textInput}
                      placeholder="Optional second message"
                    />
                    <input
                      id="cartHeaderMessage3"
                      type="text"
                      name="cartHeaderMessage3"
                      defaultValue={config.cartHeaderMessage3 || ""}
                      className={settingsStyles.textInput}
                      placeholder="Optional third message"
                    />
                  </div>
                </FormField>
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
                <input type="hidden" name="backgroundColor" value={config.backgroundColor || "#ffffff"} />
                <input type="hidden" name="bannerBackgroundColor" value={config.bannerBackgroundColor || "#16a34a"} />
                <input type="hidden" name="borderRadius" value={String(config.borderRadius)} />
                <input type="hidden" name="showConfetti" value={config.showConfetti ? "on" : ""} />
                <input type="hidden" name="countdownEnabled" value={config.countdownEnabled ? "on" : ""} />
                <input type="hidden" name="emojiMode" value={config.emojiMode ? "on" : ""} />
                <input type="hidden" name="cartHeaderMessage1" value={config.cartHeaderMessage1 || ""} />
                <input type="hidden" name="cartHeaderMessage2" value={config.cartHeaderMessage2 || ""} />
                <input type="hidden" name="cartHeaderMessage3" value={config.cartHeaderMessage3 || ""} />
                <input type="hidden" name="showHeaderBanner" value={config.showHeaderBanner !== false ? "on" : ""} />
                <input type="hidden" name="showStickyCartButton" value={config.showStickyCartButton !== false ? "on" : ""} />
              </FormSection>
            )}
            </div>
          </div>

          <div ref={saveButtonRef} className={settingsStyles.saveButtonWrap}>
            <s-button type="submit" variant="primary" disabled={isSubmitting} loading={isSubmitting}>
              {isSubmitting ? "Saving…" : showSuccessBanner ? "Saved ✓" : "Save Changes"}
            </s-button>
          </div>
        </div>
        </fieldset>
      </Form>
      {showStickySave && (
        <div className={settingsStyles.stickySaveBar} role="region" aria-label="Save settings">
          <s-button
            type="submit"
            form="settings-form"
            variant="primary"
            disabled={isSubmitting}
            loading={isSubmitting}
          >
            {isSubmitting ? "Saving…" : "Save Changes"}
          </s-button>
        </div>
      )}
        </div>
        <div className={previewPanelStyles.previewColumn}>
          <div className={previewPanelStyles.previewLabel}>
            Live preview
          </div>
          <div className={previewPanelStyles.previewDrawerWrap}>
            <CartPreview
              ui={previewRenderState.ui}
              decision={previewRenderState.decision}
              capabilities={capabilities}
              enableCrossSellOverride={previewEnableCrossSell}
              currency={currency}
            />
          </div>
        </div>
      </div>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
