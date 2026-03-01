import type { CSSProperties, ReactNode } from "react";
import styles from "./MetricCard.module.css";

type MetricCardProps = {
  label: string;
  value: ReactNode;
  tone?: "default" | "success" | "critical";
  subtext?: string;
};

export function MetricCard({
  label,
  value,
  tone = "default",
  subtext,
}: MetricCardProps) {
  const valueStyle: CSSProperties = {
    fontSize: "var(--app-metric-value-size)",
    fontWeight: "var(--app-metric-value-weight)",
  };
  if (tone === "success") valueStyle.color = "var(--p-color-text-success)";
  else if (tone === "critical") valueStyle.color = "var(--p-color-text-critical)";

  return (
    <s-box
      padding="base"
      borderWidth="base"
      borderRadius="base"
      background="subdued"
    >
      <s-stack direction="block" gap="small">
        <s-text tone="neutral">{label}</s-text>
        <div className={styles.metricValue} style={valueStyle}>
          {value}
        </div>
        {subtext != null && subtext !== "" && (
          <s-text tone="neutral">{subtext}</s-text>
        )}
      </s-stack>
    </s-box>
  );
}
