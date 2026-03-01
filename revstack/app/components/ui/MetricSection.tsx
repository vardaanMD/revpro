import type { ReactNode } from "react";
import styles from "./MetricSection.module.css";

type MetricSectionProps = {
  children: ReactNode;
};

export function MetricSection({ children }: MetricSectionProps) {
  return <div className={styles.grid}>{children}</div>;
}
