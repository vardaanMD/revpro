import styles from "~/styles/skeleton.module.css";

/**
 * Placeholder for sparkline/chart or table area. Same dimensions as typical chart block.
 */
export function ChartSkeleton() {
  return (
    <div
      className={styles.shimmer}
      style={{
        width: "100%",
        minHeight: 200,
        borderRadius: "var(--p-border-radius-base, 8px)",
        border: "1px solid var(--p-color-border-subdued, #e1e3e5)",
        padding: "var(--app-space-4, 16px)",
        background: "var(--p-color-bg-subdued, #f6f6f7)",
      }}
    />
  );
}
