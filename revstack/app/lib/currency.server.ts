/**
 * Format monetary amount (in cents) for display.
 * Uses Intl.NumberFormat; zero-decimal currencies are handled by the runtime.
 */
export function formatMoney(
  amountCents: number,
  currency: string,
  locale?: string
): string {
  const value = amountCents / 100;
  return new Intl.NumberFormat(locale ?? "en", {
    style: "currency",
    currency,
  }).format(value);
}
