import { AppLink } from "~/components/AppLink";
import styles from "./FeatureGate.module.css";

const LockIcon = () => (
  <svg
    className={styles.lockIcon}
    width="24"
    height="24"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
  >
    <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
    <path d="M7 11V7a5 5 0 0 1 10 0v4" />
  </svg>
);

type FeatureGateProps = {
  locked: boolean;
  children: React.ReactNode;
  ctaLabel?: string;
  ctaTo?: string;
};

export function FeatureGate({
  locked,
  children,
  ctaLabel = "Activate plan",
  ctaTo = "/app/upgrade",
}: FeatureGateProps) {
  if (!locked) {
    return <>{children}</>;
  }
  return (
    <div className={styles.wrapper}>
      <div className={styles.blurred}>{children}</div>
      <div className={styles.overlay}>
        <div className={styles.content}>
          <LockIcon />
          <span className={styles.ctaText}>{ctaLabel}</span>
          <AppLink to={ctaTo}>
            <s-button variant="primary">{ctaLabel}</s-button>
          </AppLink>
        </div>
      </div>
    </div>
  );
}
