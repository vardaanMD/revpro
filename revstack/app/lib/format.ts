/**
 * Pure formatting utilities. Safe for client and server (no DB, no env).
 * Use for cents-to-currency and uplift display.
 */
export function formatCurrency(cents: number, currency: string): string {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(cents / 100);
}

/**
 * Format uplift (signed cents) as "+$X.XX" or "-$X.XX".
 */
export function formatUplift(cents: number, currency: string): string {
  const formatted = formatCurrency(Math.abs(cents), currency);
  return cents >= 0 ? `+${formatted}` : `-${formatted}`;
}
