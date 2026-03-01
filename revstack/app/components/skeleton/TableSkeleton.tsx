import styles from "~/styles/skeleton.module.css";
import dashboardStyles from "~/styles/dashboardIndex.module.css";

type TableSkeletonProps = {
  rows?: number;
};

/**
 * Placeholder table with shimmer rows. Same padding/layout as dashboard and analytics tables.
 */
export function TableSkeleton({ rows = 4 }: TableSkeletonProps) {
  return (
    <div className={dashboardStyles.tableWrapper}>
      <table className={dashboardStyles.table}>
        <thead>
          <tr>
            <th>
              <div
                className={styles.shimmer}
                style={{ height: 14, width: 60, margin: "0 auto" }}
              />
            </th>
            <th>
              <div
                className={styles.shimmer}
                style={{ height: 14, width: 70, margin: "0 0 0 auto" }}
              />
            </th>
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: rows }, (_, i) => (
            <tr key={i}>
              <td>
                <div
                  className={styles.shimmer}
                  style={{ height: 14, width: 80 }}
                />
              </td>
              <td>
                <div
                  className={styles.shimmer}
                  style={{ height: 14, width: 40, marginLeft: "auto" }}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
