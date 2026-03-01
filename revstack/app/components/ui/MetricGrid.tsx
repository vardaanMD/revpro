import type { ReactNode } from "react";
import styles from "./MetricGrid.module.css";

type MetricGridProps = {
  children: ReactNode;
};

export function MetricGrid({ children }: MetricGridProps) {
  return <div className={styles.grid}>{children}</div>;
}
