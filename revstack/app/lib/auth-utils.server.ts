import crypto from "node:crypto";

/**
 * Timing-safe comparison for bearer token auth headers.
 * Prevents timing attacks on SINGLE_SITE_TOKEN and similar secrets.
 */
export function bearerTokenMatches(
  header: string | null,
  expectedToken: string
): boolean {
  const actual = header ?? "";
  const expected = `Bearer ${expectedToken}`;
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
}
