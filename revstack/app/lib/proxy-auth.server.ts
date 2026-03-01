import crypto from "crypto";
import { ENV } from "~/lib/env.server";
import { logWarn } from "~/lib/logger.server";

const REPLAY_WINDOW_MS = 5 * 60 * 1000;

/**
 * Verify app proxy request per Shopify docs: params (excluding signature) sorted
 * alphabetically, concatenated as key=value with NO separator between pairs
 * (multi-value for same key joined with comma), then HMAC-SHA256 hex.
 * Uses timing-safe compare to avoid timing attacks.
 */
export function verifyProxySignature(request: Request): boolean {
  const url = new URL(request.url);
  const signature = url.searchParams.get("signature");
  if (!signature) return false;

  const byKey = new Map<string, string[]>();
  for (const [key, value] of url.searchParams.entries()) {
    if (key === "signature") continue;
    const list = byKey.get(key) ?? [];
    list.push(value);
    byKey.set(key, list);
  }

  const sorted = [...byKey.entries()].sort(([a], [b]) => a.localeCompare(b));
  const message = sorted.map(([k, vals]) => `${k}=${vals.join(",")}`).join("");

  const hmac = crypto
    .createHmac("sha256", ENV.SHOPIFY_API_SECRET)
    .update(message)
    .digest("hex");

  if (hmac.length !== signature.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(hmac, "hex"), Buffer.from(signature, "hex"));
  } catch (err) {
    logWarn({
      message: "Proxy signature verification failed (timingSafeEqual)",
      meta: { error: err instanceof Error ? err.message : String(err) },
    });
    return false;
  }
}

export function checkReplayTimestamp(request: Request): boolean {
  const url = new URL(request.url);
  const ts = url.searchParams.get("timestamp");
  if (!ts) return false;
  const t = parseInt(ts, 10);
  if (Number.isNaN(t)) return false;
  const age = Date.now() - t * 1000;
  return age >= 0 && age <= REPLAY_WINDOW_MS;
}
