/**
 * Single-site shop config setup endpoint. POST /api/setup-config
 * Protected by SINGLE_SITE_TOKEN.
 * Sets freeShippingThresholdCents, milestonesJson, baselineAovCents,
 * enableCouponTease, recommendationLimit for the single-site shop.
 */
import type { ActionFunctionArgs } from "react-router";
import { prisma } from "~/lib/prisma.server";
import { bearerTokenMatches } from "~/lib/auth-utils.server";

export async function action({ request }: ActionFunctionArgs) {
  const singleSiteToken = process.env.SINGLE_SITE_TOKEN;
  const singleSiteShop = process.env.SINGLE_SITE_SHOP;

  if (!singleSiteToken || !singleSiteShop) {
    return Response.json({ error: "Not configured" }, { status: 404 });
  }
  if (!bearerTokenMatches(request.headers.get("Authorization"), singleSiteToken)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json() as Record<string, unknown>;
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const update: Record<string, unknown> = {};
  if (typeof body.freeShippingThresholdCents === "number") update.freeShippingThresholdCents = body.freeShippingThresholdCents;
  if (typeof body.baselineAovCents === "number") update.baselineAovCents = body.baselineAovCents;
  if (Array.isArray(body.milestonesJson)) update.milestonesJson = body.milestonesJson;
  if (typeof body.enableCouponTease === "boolean") update.enableCouponTease = body.enableCouponTease;
  if (typeof body.enableCrossSell === "boolean") update.enableCrossSell = body.enableCrossSell;
  if (typeof body.enableMilestones === "boolean") update.enableMilestones = body.enableMilestones;
  if (typeof body.recommendationLimit === "number") update.recommendationLimit = body.recommendationLimit;

  if (Object.keys(update).length === 0) {
    return Response.json({ error: "No valid fields to update" }, { status: 400 });
  }

  await prisma.shopConfig.upsert({
    where: { shopDomain: singleSiteShop },
    update,
    create: {
      shopDomain: singleSiteShop,
      baselineAovCents: typeof body.baselineAovCents === "number" ? body.baselineAovCents : 3000,
      freeShippingThresholdCents: typeof body.freeShippingThresholdCents === "number" ? body.freeShippingThresholdCents : 0,
      milestonesJson: Array.isArray(body.milestonesJson) ? body.milestonesJson : [],
      enableCouponTease: typeof body.enableCouponTease === "boolean" ? body.enableCouponTease : true,
      enableCrossSell: true,
      enableMilestones: true,
      recommendationLimit: typeof body.recommendationLimit === "number" ? body.recommendationLimit : 4,
    },
  });

  return Response.json({ ok: true, updated: Object.keys(update) });
}
