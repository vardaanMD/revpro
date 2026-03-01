import type { ReactNode } from "react";
import styles from "./DataPanel.module.css";

type DataPanelProps = {
  children: ReactNode;
  className?: string;
};

export function DataPanel({ children, className }: DataPanelProps) {
  return (
    <div className={`${styles.panel} ${className ?? ""}`.trim()}>
      {children}
    </div>
  );
}
