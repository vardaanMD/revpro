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

const engineVersionSchema = z.enum(["v1", "v2"]);

/** Runtime version for dynamic embed (v1/v2/v3). Stored in configV3. */
const runtimeVersionSchema = z.enum(["v1", "v2", "v3"]).optional();

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
  borderRadius: z.number().int().min(0).max(32),
  showConfetti: z.boolean(),
  countdownEnabled: z.boolean(),
  emojiMode: z.boolean(),
  engineVersion: engineVersionSchema,
  runtimeVersion: runtimeVersionSchema,
  /** When true, we store order totals from orders/paid and show revenue in analytics. When false, we do not store or show. */
  allowOrderMetrics: z.boolean().optional(),
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
  const borderRadiusRaw = formData.get("borderRadius");
  const showConfetti = formData.get("showConfetti") === "on";
  const countdownEnabled = formData.get("countdownEnabled") === "on";
  const emojiMode = formData.get("emojiMode") === "on";
  const engineVersionRaw = formData.get("engineVersion");
  const engineVersion =
    engineVersionRaw === "v1" || engineVersionRaw === "v2" ? engineVersionRaw : "v1";

  const runtimeVersionRaw = formData.get("runtimeVersion");
  const runtimeVersion =
    runtimeVersionRaw === "v1" || runtimeVersionRaw === "v2" || runtimeVersionRaw === "v3"
      ? runtimeVersionRaw
      : undefined;

  const allowOrderMetrics =
    formData.has("allowOrderMetrics") ? formData.get("allowOrderMetrics") === "on" : undefined;

  const primaryColor = typeof primaryColorRaw === "string" ? primaryColorRaw.trim() || undefined : undefined;
  const accentColor = typeof accentColorRaw === "string" ? accentColorRaw.trim() || undefined : undefined;
  const borderRadiusNum = typeof borderRadiusRaw === "string" ? parseInt(borderRadiusRaw, 10) : NaN;
  const borderRadius = Number.isInteger(borderRadiusNum) ? borderRadiusNum : 12;

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
    borderRadius,
    showConfetti,
    countdownEnabled,
    emojiMode,
    engineVersion,
    runtimeVersion,
    allowOrderMetrics,
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
