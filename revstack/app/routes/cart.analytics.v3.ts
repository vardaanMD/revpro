/**
 * App proxy path: /apps/cart-pro/analytics/v3
 * Accepts batched analytics events from V3 engine. Validates, deduplicates, persists.
 * Writes to CartProEventV3 (raw events) and to DecisionMetric/CrossSellConversion so admin Analytics page shows V3 data.
 * Non-blocking; returns 200 fast. No aggregation or billing gating.
 */
import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "~/shopify.server";
import { prisma } from "~/lib/prisma.server";
import { normalizeShopDomain } from "~/lib/shop-domain.server";
import type { AnalyticsEventV3 } from "~/types/analytics-v3";
import { logWarn } from "~/lib/logger.server";

function isValidEvent(raw: unknown): raw is AnalyticsEventV3 {
  if (!raw || typeof raw !== "object") return false;
  const o = raw as Record<string, unknown>;
  if (typeof o.id !== "string" || !o.id) return false;
  if (typeof o.name !== "string" || !o.name) return false;
  if (typeof o.timestamp !== "number") return false;
  if (typeof o.sessionId !== "string" || !o.sessionId) return false;
  const cs = o.cartSnapshot;
  if (!cs || typeof cs !== "object") return false;
  const snap = cs as Record<string, unknown>;
  if (typeof snap.itemCount !== "number") return false;
  if (typeof snap.subtotal !== "number") return false;
  return true;
}

export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    });
  }

  let session: { shop: string };
  try {
    const ctx = await authenticate.public.appProxy(request);
    if (!ctx.session) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }
    session = ctx.session;
  } catch {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const shop = normalizeShopDomain(session.shop);
  if (!shop || shop === "unknown") {
    return new Response(JSON.stringify({ error: "Invalid shop" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const raw = body as Record<string, unknown>;
  const events = raw?.events;

  if (!Array.isArray(events)) {
    return new Response(JSON.stringify({ error: "Invalid events array" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (events.length === 0) {
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (events.length > 20) {
    return new Response(JSON.stringify({ error: "Batch size limit exceeded" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const validEvents = events.filter(isValidEvent);

  const data = validEvents.map((event) => ({
    id: event.id,
    shop,
    sessionId: event.sessionId,
    name: event.name,
    payload: event.payload,
    itemCount: Math.round(Number(event.cartSnapshot.itemCount)) || 0,
    subtotal: Math.round(Number(event.cartSnapshot.subtotal)) || 0,
    timestamp: new Date(event.timestamp),
  }));

  console.log("[analytics-v3] ingest", {
    shop,
    count: validEvents.length,
  });

  await prisma.cartProEventV3.createMany({
    data,
    skipDuplicates: true,
  });

  // Write to DecisionMetric / CrossSellConversion so admin Analytics page shows V3 events.
  const decisionMetrics = validEvents
    .filter((e) => e.name === "cart:evaluated" && e.payload && typeof (e.payload as Record<string, unknown>).hasCrossSell === "boolean")
    .map((e) => {
      const p = e.payload as Record<string, unknown>;
      return {
        shopDomain: shop,
        hasCrossSell: Boolean(p.hasCrossSell),
        cartValue: Math.round(Number(p.cartValue ?? e.cartSnapshot?.subtotal ?? 0)),
      };
    });
  if (decisionMetrics.length > 0) {
    await prisma.decisionMetric
      .createMany({ data: decisionMetrics })
      .catch((err) => {
        logWarn({
          shop,
          message: "analytics-v3 DecisionMetric createMany failed",
          meta: { error: err instanceof Error ? err.message : String(err) },
        });
      });
  }

  const conversions = validEvents
    .filter((e) => e.name === "upsell:add" && e.payload && typeof (e.payload as Record<string, unknown>).variantId === "number")
    .map((e) => {
      const p = e.payload as Record<string, unknown>;
      return {
        shopDomain: shop,
        productId: String(p.variantId),
        cartValue: Math.round(Number(e.cartSnapshot?.subtotal ?? 0)),
      };
    });
  if (conversions.length > 0) {
    await Promise.all(
      conversions.map((c) =>
        prisma.crossSellConversion.create({ data: c }).catch((err) => {
          logWarn({
            shop,
            message: "analytics-v3 CrossSellConversion create failed",
            meta: { error: err instanceof Error ? err.message : String(err) },
          });
        })
      )
    );
  }

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/** Only POST is allowed; GET returns 405. */
export async function loader() {
  return new Response(JSON.stringify({ error: "Method not allowed" }), {
    status: 405,
    headers: { "Content-Type": "application/json" },
  });
}
