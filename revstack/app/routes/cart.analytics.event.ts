/**
 * Storefront analytics event (impression/click). Rate-limited; bounded writes (1 event + optional 1 conversion).
 * Schema: CrossSellEvent, CrossSellConversion use @@index([shopDomain, createdAt]).
 */
import crypto from "crypto";
import { data, type ActionFunctionArgs } from "react-router";
import { z } from "zod";
import { prisma } from "~/lib/prisma.server";
import {
  checkRateLimitWithQuota,
  type RateLimitResult,
} from "~/lib/rate-limit.server";
import { withSafeHandler } from "~/lib/safe-handler.server";
import { requestContext } from "~/lib/request-context.server";
import { verifyProxySignature, checkReplayTimestamp } from "~/lib/proxy-auth.server";
import { logWarn } from "~/lib/logger.server";
import { normalizeShopDomain, warnIfShopNotCanonical } from "~/lib/shop-domain.server";

const eventBodySchema = z.object({
  productId: z.string().min(1),
  eventType: z.enum(["impression", "click"]),
  cartValue: z.number().int().min(0),
  revproSessionId: z.string().uuid().optional(),
  recommendedProductIds: z.array(z.string()).optional(),
});

function responseHeaders(rateLimit: RateLimitResult): Record<string, string> {
  return {
    "X-RateLimit-Limit": `${rateLimit.limit}`,
    "X-RateLimit-Remaining": `${rateLimit.remaining}`,
    "X-RateLimit-Reset": `${Math.ceil(rateLimit.resetAt / 1000)}`,
  };
}

async function analyticsEventAction({ request }: ActionFunctionArgs) {
  const requestId = crypto.randomUUID();
  const url = new URL(request.url);
  const rawShop = url.searchParams.get("shop")?.trim() ?? null;
  const shop = rawShop !== null ? normalizeShopDomain(rawShop) : null;
  if (rawShop !== null) warnIfShopNotCanonical(rawShop, shop!);

  if (request.method !== "POST") {
    return data({ error: "Method not allowed" }, { status: 405 });
  }

  if (!verifyProxySignature(request) || !checkReplayTimestamp(request)) {
    return data({ error: "Unauthorized" }, { status: 401 });
  }
  if (!shop) {
    return data({ error: "Missing shop" }, { status: 400 });
  }

  const rateLimit = await checkRateLimitWithQuota(shop);

  if (!rateLimit.allowed) {
    return data(
      { error: "Too many requests" },
      { status: 429, headers: responseHeaders(rateLimit) }
    );
  }

  return requestContext.run({ requestId, rateLimit }, async () => {
    let body: unknown;
    try {
      body = await request.json();
    } catch (err) {
      logWarn({
        shop,
        message: "Analytics event invalid JSON body",
        meta: { error: err instanceof Error ? err.message : String(err) },
      });
      return data(
        { error: "Bad request", message: "Request body must be valid JSON." },
        { status: 400, headers: responseHeaders(rateLimit) }
      );
    }

    const parsed = eventBodySchema.safeParse(body);
    if (!parsed.success) {
      const message = parsed.error.issues.map((i) => i.message).join("; ");
      return data(
        { error: "Validation failed", message },
        { status: 400, headers: responseHeaders(rateLimit) }
      );
    }

    const { productId, eventType, cartValue, revproSessionId, recommendedProductIds } = parsed.data;

    try {
      await prisma.crossSellEvent.create({
        data: {
          shopDomain: shop,
          productId,
          eventType,
          cartValue,
        },
      });
    } catch (err) {
      logWarn({
        shop,
        message: "CrossSellEvent create failed",
        meta: { error: err instanceof Error ? err.message : String(err) },
      });
      return data(
        { error: "Internal error" },
        { status: 500, headers: responseHeaders(rateLimit) }
      );
    }

    if (eventType === "click") {
      try {
        await prisma.crossSellConversion.create({
          data: {
            shopDomain: shop,
            productId,
            cartValue,
          },
        });
      } catch (err) {
        logWarn({
          shop,
          message: "CrossSellConversion create failed; event already recorded",
          meta: { error: err instanceof Error ? err.message : String(err) },
        });
      }

      if (revproSessionId && Array.isArray(recommendedProductIds)) {
        try {
          const recIds = recommendedProductIds.filter((id): id is string => typeof id === "string");
          const existing = await prisma.revproClickSession.findUnique({
            where: { shopDomain_revproSessionId: { shopDomain: shop, revproSessionId } },
          });
          const clickedIds = existing
            ? [...(Array.isArray(existing.clickedProductIds) ? (existing.clickedProductIds as string[]) : []), productId]
            : [productId];
          await prisma.revproClickSession.upsert({
            where: { shopDomain_revproSessionId: { shopDomain: shop, revproSessionId } },
            create: {
              shopDomain: shop,
              revproSessionId,
              clickedProductIds: clickedIds,
              recommendedProductIds: recIds,
            },
            update: { clickedProductIds: clickedIds },
          });
        } catch (err) {
          logWarn({
            shop,
            message: "RevproClickSession upsert failed",
            meta: { error: err instanceof Error ? err.message : String(err) },
          });
        }
      }
    }

    return data({ ok: true }, { status: 200, headers: responseHeaders(rateLimit) });
  });
}

export const action = withSafeHandler(analyticsEventAction) as typeof analyticsEventAction;
