/**
 * Optimization Health: Active / Improving / Needs Attention.
 * Small badge with tooltip; merchants feel responsible for maintaining health.
 */

import type { HealthStatus } from "~/lib/retention.server";
import styles from "./HealthBadge.module.css";

const LABELS: Record<HealthStatus, string> = {
  active: "Active",
  improving: "Improving",
  needs_attention: "Needs attention",
};

const TOOLTIPS: Record<HealthStatus, string> = {
  active:
    "Recommendations are running. Check Analytics for trends.",
  improving:
    "Metrics are trending up.",
  needs_attention:
    "Activate your plan or check that your cart experience is live to restore health.",
};

type HealthBadgeProps = {
  status: HealthStatus;
};

export function HealthBadge({ status }: HealthBadgeProps) {
  const label = LABELS[status];
  const tooltip = TOOLTIPS[status];

  return (
    <span className={styles.badge} title={tooltip}>
      <span className={styles[status]}>{label}</span>
    </span>
  );
}
