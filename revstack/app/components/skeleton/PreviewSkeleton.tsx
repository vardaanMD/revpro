import styles from "~/styles/skeleton.module.css";
import layoutStyles from "~/styles/previewPage.module.css";

/**
 * Mimics preview layout: header, config block, carousel area, milestones, buttons.
 * Gray boxes to avoid layout shift when CartPreview loads.
 */
export function PreviewSkeleton() {
  return (
    <div className={layoutStyles.previewLayout}>
      <div style={{ marginBottom: "var(--app-space-5, 24px)" }}>
        <div
          className={styles.shimmer}
          style={{ height: 24, width: 200, marginBottom: 8, borderRadius: 4 }}
        />
        <div
          className={styles.shimmer}
          style={{ height: 16, width: 320, borderRadius: 4 }}
        />
      </div>

      <div style={{ marginBottom: "var(--app-space-5, 24px)" }}>
        <div
          className={styles.shimmer}
          style={{ height: 18, width: 180, marginBottom: 12, borderRadius: 4 }}
        />
        <div
          className={styles.shimmer}
          style={{
            height: 120,
            width: "100%",
            maxWidth: 400,
            borderRadius: 8,
          }}
        />
      </div>

      <div style={{ marginBottom: "var(--app-space-5, 24px)" }}>
        <div
          className={styles.shimmer}
          style={{ height: 18, width: 140, marginBottom: 12, borderRadius: 4 }}
        />
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          <div
            className={styles.shimmer}
            style={{ height: 36, width: 120, borderRadius: 8 }}
          />
          <div
            className={styles.shimmer}
            style={{ height: 36, width: 100, borderRadius: 8 }}
          />
        </div>
      </div>

      <div className={layoutStyles.previewDrawerSection}>
        <div
          className={styles.shimmer}
          style={{
            width: "100%",
            maxWidth: 480,
            minWidth: 280,
            minHeight: 400,
            borderRadius: 16,
            background: "var(--p-color-bg-subdued, #f6f6f7)",
          }}
        >
          <div
            className={styles.shimmer}
            style={{
              height: 44,
              margin: 12,
              borderRadius: 8,
            }}
          />
          <div
            className={styles.shimmer}
            style={{
              height: 80,
              margin: "0 12px 12px",
              borderRadius: 8,
            }}
          />
          <div
            className={styles.shimmer}
            style={{
              height: 100,
              margin: "0 12px 12px",
              borderRadius: 8,
            }}
          />
          <div
            className={styles.shimmer}
            style={{
              height: 140,
              margin: "0 12px 12px",
              borderRadius: 8,
            }}
          />
          <div
            className={styles.shimmer}
            style={{
              height: 60,
              margin: 12,
              borderRadius: 8,
            }}
          />
        </div>
      </div>
    </div>
  );
}
