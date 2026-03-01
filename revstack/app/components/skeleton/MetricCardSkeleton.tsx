import styles from "~/styles/skeleton.module.css";

/**
 * Same approximate height and padding as StatCard.
 * Used inside a MetricSection-style grid to avoid layout shift.
 */
export function MetricCardSkeleton() {
  return (
    <div className={skeletonStyles.card}>
      <div
        className={styles.shimmer}
        style={{
          height: 14,
          width: "60%",
          marginBottom: "var(--app-space-2)",
          borderRadius: "var(--app-radius-sm)",
        }}
      />
      <div
        className={styles.shimmer}
        style={{
          height: "var(--app-font-metric)",
          width: "80%",
          borderRadius: "var(--app-radius-sm)",
        }}
      />
    </div>
  );
}
