import type { ReactNode } from "react";
import styles from "./StatCard.module.css";

type StatCardProps = {
  label: string;
  value: ReactNode;
  subtext?: string;
  /** Small muted label above value (e.g. "At Evaluation", "Paid Orders Only") */
  contextLabel?: string;
  tone?: "default" | "success" | "critical" | "subdued";
};

export function StatCard({
  label,
  value,
  subtext,
  contextLabel,
  tone = "default",
}: StatCardProps) {
  return (
    <div className={styles.card}>
      <div className={styles.stack}>
        <span className={styles.label}>{label}</span>
        {contextLabel != null && contextLabel !== "" && (
          <span className={styles.contextLabel}>{contextLabel}</span>
        )}
        <div className={`${styles.value} ${tone !== "default" ? styles[`tone_${tone}`] : ""}`}>
          {value}
        </div>
        {subtext != null && subtext !== "" && (
          <span className={styles.subtext}>{subtext}</span>
        )}
      </div>
    </div>
  );
}
