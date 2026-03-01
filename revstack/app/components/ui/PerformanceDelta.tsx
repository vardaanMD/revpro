/**
 * This week vs last week (or today vs yesterday) with positive reinforcement.
 * Uses s-* only; no Tailwind.
 */

import styles from "./PerformanceDelta.module.css";

type PerformanceDeltaProps = {
  label: string;
  current: number;
  previous: number;
  format?: "number" | "currency";
  currency?: string;
};

function formatValue(
  value: number,
  format: "number" | "currency",
  currency: string
): string {
  if (format === "currency") {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(value / 100);
  }
  return String(value);
}

export function PerformanceDelta({
  label,
  current,
  previous,
  format = "number",
  currency = "USD",
}: PerformanceDeltaProps) {
  const improved = current > previous;
  const same = current === previous;
  const pct =
    previous === 0
      ? (current > 0 ? 100 : 0)
      : Math.round(((current - previous) / previous) * 100);
  const pctText =
    previous === 0
      ? current > 0
        ? "+100%"
        : "—"
      : (pct >= 0 ? "+" : "") + pct + "%";

  return (
    <div className={styles.root}>
      <s-text tone="neutral">{label}</s-text>
      <span className={styles.values}>
        <span>{formatValue(current, format, currency)}</span>
        <span className={same ? styles.neutral : improved ? styles.improved : styles.declined}>
          {same ? "—" : pctText} vs last period
        </span>
      </span>
      {improved && (
        <span className={styles.reinforcement}>
          <s-text tone="success">Improving.</s-text>
        </span>
      )}
    </div>
  );
}
