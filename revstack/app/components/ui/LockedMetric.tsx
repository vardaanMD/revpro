import { AppLink } from "~/components/AppLink";
import styles from "./LockedMetric.module.css";

type LockedMetricProps = {
  children: React.ReactNode;
  ctaText?: string;
  ctaTo?: string;
};

/**
 * Wraps content in a blurred container with an inline CTA to upgrade.
 * Used for soft paywall - show preview, blur, prompt upgrade.
 */
export function LockedMetric({
  children,
  ctaText = "Activate plan",
  ctaTo = "/app/upgrade",
}: LockedMetricProps) {
  return (
    <div className={styles.wrapper}>
      <div className={styles.blurred}>{children}</div>
      <div className={styles.overlay}>
        <div className={styles.content}>
          <span className={styles.lockIcon}>🔒</span>
          <s-text tone="neutral">{ctaText}</s-text>
          <AppLink to={ctaTo}>
            <s-button variant="primary">Activate plan</s-button>
          </AppLink>
        </div>
      </div>
    </div>
  );
}
