/**
 * customers/redact webhook (GDPR).
 * We do not store customer PII keyed by customer id; no data to delete. Acknowledge only.
 */
import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "~/shopify.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  await authenticate.webhook(request);
  return Response.json({ ok: true });
};
