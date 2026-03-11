import { z } from "zod";
import { logWarn } from "~/lib/logger.server";

const milestoneSchema = z.object({
  amount: z.number().min(0),
  label: z.string().min(1),
});

const milestonesArraySchema = z.array(milestoneSchema);

const recommendationStrategySchema = z.enum([
  "COLLECTION_MATCH",
  "MANUAL_COLLECTION",
  "TAG_MATCH",
  "BEST_SELLING",
  "NEW_ARRIVALS",
]);

const manualCollectionIdsSchema = z.string().refine(
  (s) => {
    try {
      const parsed = JSON.parse(s) as unknown;
      return Array.isArray(parsed) && parsed.every((x): x is string => typeof x === "string");
    } catch (err) {
      logWarn({
        message: "Settings validation: manualCollectionIds JSON parse failed",
        meta: { error: err instanceof Error ? err.message : String(err) },
      });
      return false;
    }
  },
  { message: "Must be a valid JSON array of strings (collection IDs)" }
);

export const settingsFormSchema = z.object({
  freeShippingThresholdCents: z.number().min(0),
  baselineAovCents: z.number().min(0),
  enableCrossSell: z.boolean(),
  enableMilestones: z.boolean(),
  enableCouponTease: z.boolean(),
  milestonesJson: z.string().refine(
    (s) => {
      try {
        const parsed = JSON.parse(s) as unknown;
        return Array.isArray(parsed) && milestonesArraySchema.safeParse(parsed).success;
      } catch (err) {
        logWarn({
          message: "Settings validation: milestonesJson parse failed",
          meta: { error: err instanceof Error ? err.message : String(err) },
        });
        return false;
      }
    },
    { message: "Each milestone needs a valid spend amount and reward label." }
  ),
  recommendationStrategy: recommendationStrategySchema,
  recommendationLimit: z.number().int().min(1).max(8),
  manualCollectionIds: manualCollectionIdsSchema,
  primaryColor: z.string().optional().refine((v) => v === undefined || /^#([0-9A-Fa-f]{6})$/.test(v), { message: "Must be a hex color (e.g. #111111)" }),
  accentColor: z.string().optional().refine((v) => v === undefined || /^#([0-9A-Fa-f]{6})$/.test(v), { message: "Must be a hex color (e.g. #16a34a)" }),
  backgroundColor: z.string().optional().refine((v) => v === undefined || /^#([0-9A-Fa-f]{6})$/.test(v), { message: "Must be a hex color (e.g. #ffffff)" }),
  bannerBackgroundColor: z.string().optional().refine((v) => v === undefined || /^#([0-9A-Fa-f]{6})$/.test(v), { message: "Must be a hex color (e.g. #16a34a)" }),
  borderRadius: z.number().int().min(0).max(32),
  showConfetti: z.boolean(),
  countdownEnabled: z.boolean(),
  emojiMode: z.boolean(),
  cartHeaderMessage1: z.string().optional(),
  cartHeaderMessage2: z.string().optional(),
  cartHeaderMessage3: z.string().optional(),
  /** Recommendations section heading (e.g. "You may also like"). */
  recommendationsHeading: z.string().optional(),
  /** Coupon tease message shown when no code is applied. */
  couponTeaseMessage: z.string().optional(),
  /** When true, show the rotating header message banner below "Your Cart". */
  showHeaderBanner: z.boolean(),
  /** When true, show the coupon tease message banner when no code is applied. */
  showTeaseMessage: z.boolean(),
});

export type SettingsFormData = z.infer<typeof settingsFormSchema>;

export function parseMilestonesJson(s: string): z.infer<typeof milestonesArraySchema> {
  const parsed = JSON.parse(s) as unknown;
  return milestonesArraySchema.parse(parsed);
}

/** Safe parse for loader UI: returns array of { amount (cents), label } or [] on invalid data. */
export function parseMilestonesForUI(milestonesJson: string | unknown): z.infer<typeof milestonesArraySchema> {
  const s = typeof milestonesJson === "string" ? milestonesJson : JSON.stringify(milestonesJson ?? []);
  try {
    const parsed = JSON.parse(s) as unknown;
    const result = milestonesArraySchema.safeParse(parsed);
    return result.success ? result.data : [];
  } catch {
    return [];
  }
}

export function parseManualCollectionIds(s: string): string[] {
  const parsed = JSON.parse(s) as unknown;
  return z.array(z.string()).parse(parsed);
}

export function validateSettingsForm(formData: FormData): {
  success: true;
  data: SettingsFormData;
} | {
  success: false;
  error: string;
} {
  const freeShippingDollars = formData.get("freeShippingThresholdDollars");
  const baselineAovDollars = formData.get("baselineAovDollars");
  const enableCrossSell = formData.get("enableCrossSell") === "on";
  const enableMilestones = formData.get("enableMilestones") === "on";
  const enableCouponTease = formData.get("enableCouponTease") === "on";
  const milestonesJson = formData.get("milestonesJson");
  const recommendationStrategyRaw = formData.get("recommendationStrategy");
  const recommendationLimitRaw = formData.get("recommendationLimit");
  const manualCollectionIdsRaw = formData.get("manualCollectionIds");

  const freeShippingNum = typeof freeShippingDollars === "string" ? parseFloat(freeShippingDollars) : NaN;
  const baselineAovNum = typeof baselineAovDollars === "string" ? parseFloat(baselineAovDollars) : NaN;

  const freeShippingThresholdCents = Number.isFinite(freeShippingNum) ? Math.round(freeShippingNum * 100) : NaN;
  const baselineAovCents = Number.isFinite(baselineAovNum) ? Math.round(baselineAovNum * 100) : NaN;

  const recommendationStrategy =
    typeof recommendationStrategyRaw === "string" ? recommendationStrategyRaw : "";
  const recommendationLimitNum =
    typeof recommendationLimitRaw === "string"
      ? parseInt(recommendationLimitRaw, 10)
      : NaN;
  const recommendationLimit = Number.isInteger(recommendationLimitNum) ? recommendationLimitNum : NaN;
  const manualCollectionIds =
    typeof manualCollectionIdsRaw === "string" && manualCollectionIdsRaw.trim() !== ""
      ? manualCollectionIdsRaw
      : "[]";

  const primaryColorRaw = formData.get("primaryColor");
  const accentColorRaw = formData.get("accentColor");
  const backgroundColorRaw = formData.get("backgroundColor");
  const bannerBackgroundColorRaw = formData.get("bannerBackgroundColor");
  const borderRadiusRaw = formData.get("borderRadius");
  const showConfetti = formData.get("showConfetti") === "on";
  const countdownEnabled = formData.get("countdownEnabled") === "on";
  const emojiMode = formData.get("emojiMode") === "on";

  const primaryColor = typeof primaryColorRaw === "string" ? primaryColorRaw.trim() || undefined : undefined;
  const accentColor = typeof accentColorRaw === "string" ? accentColorRaw.trim() || undefined : undefined;
  const backgroundColor = typeof backgroundColorRaw === "string" ? backgroundColorRaw.trim() || undefined : undefined;
  const bannerBackgroundColor = typeof bannerBackgroundColorRaw === "string" ? bannerBackgroundColorRaw.trim() || undefined : undefined;
  const borderRadiusNum = typeof borderRadiusRaw === "string" ? parseInt(borderRadiusRaw, 10) : NaN;
  const borderRadius = Number.isInteger(borderRadiusNum) ? borderRadiusNum : 12;

  const cartHeaderMessage1Raw = formData.get("cartHeaderMessage1");
  const cartHeaderMessage2Raw = formData.get("cartHeaderMessage2");
  const cartHeaderMessage3Raw = formData.get("cartHeaderMessage3");
  const cartHeaderMessage1 = typeof cartHeaderMessage1Raw === "string" ? cartHeaderMessage1Raw : "";
  const cartHeaderMessage2 = typeof cartHeaderMessage2Raw === "string" ? cartHeaderMessage2Raw : "";
  const cartHeaderMessage3 = typeof cartHeaderMessage3Raw === "string" ? cartHeaderMessage3Raw : "";

  const recommendationsHeadingRaw = formData.get("recommendationsHeading");
  const couponTeaseMessageRaw = formData.get("couponTeaseMessage");
  const recommendationsHeading = typeof recommendationsHeadingRaw === "string" ? recommendationsHeadingRaw : "";
  const couponTeaseMessage = typeof couponTeaseMessageRaw === "string" ? couponTeaseMessageRaw : "";

  const showHeaderBanner = formData.get("showHeaderBanner") === "on";
  const showTeaseMessage = formData.get("showTeaseMessage") === "on";

  const raw = {
    freeShippingThresholdCents,
    baselineAovCents,
    enableCrossSell,
    enableMilestones,
    enableCouponTease,
    milestonesJson: typeof milestonesJson === "string" ? milestonesJson : "",
    recommendationStrategy,
    recommendationLimit,
    manualCollectionIds,
    primaryColor,
    accentColor,
    backgroundColor,
    bannerBackgroundColor,
    borderRadius,
    showConfetti,
    countdownEnabled,
    emojiMode,
    cartHeaderMessage1,
    cartHeaderMessage2,
    cartHeaderMessage3,
    recommendationsHeading,
    couponTeaseMessage,
    showHeaderBanner,
    showTeaseMessage,
  };

  const result = settingsFormSchema.safeParse(raw);
  if (result.success) {
    return { success: true, data: result.data };
  }
  const firstIssue = result.error.errors[0];
  if (firstIssue?.path?.includes("milestonesJson")) {
    return { success: false, error: "Each milestone needs a valid spend amount and reward label." };
  }
  if (firstIssue?.path?.includes("manualCollectionIds")) {
    return { success: false, error: "Manual collection IDs must be a valid JSON array of strings (collection IDs)." };
  }
  if (firstIssue?.path?.includes("recommendationLimit")) {
    return { success: false, error: "Recommendation limit must be an integer between 1 and 8." };
  }
  if (firstIssue?.path?.includes("recommendationStrategy")) {
    return { success: false, error: "Recommendation strategy must be one of: COLLECTION_MATCH, MANUAL_COLLECTION, TAG_MATCH, BEST_SELLING, NEW_ARRIVALS." };
  }
  if (firstIssue?.path?.includes("primaryColor") || firstIssue?.path?.includes("accentColor")) {
    return { success: false, error: "Primary and accent color must be hex (e.g. #111111)." };
  }
  if (firstIssue?.path?.includes("borderRadius")) {
    return { success: false, error: "Border radius must be an integer between 0 and 32." };
  }
  const message =
    firstIssue?.message && typeof firstIssue.message === "string"
      ? firstIssue.message
      : "Validation failed";
  return { success: false, error: message };
}
