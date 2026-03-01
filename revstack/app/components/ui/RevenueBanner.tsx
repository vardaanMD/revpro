import type { ReactNode } from "react";
import { AppLink } from "~/components/AppLink";

type RevenueBannerProps = {
  narrative: string;
  cta?: {
    label: string;
    to: string;
  };
  tone?: "success" | "subdued" | "default";
  children?: ReactNode;
};

/**
 * Top-of-page revenue snapshot banner with growth narrative.
 * Uses success tone for active revenue, subdued for inactive.
 */
export function RevenueBanner({
  narrative,
  cta,
  tone = "success",
  children,
}: RevenueBannerProps) {
  return (
    <s-box
      padding="large"
      borderWidth="base"
      borderRadius="base"
      background={tone === "subdued" ? "subdued" : "base"}
    >
      <s-stack direction="block" gap="base">
        <p
          style={{
            fontSize: "1.1rem",
            lineHeight: 1.4,
          }}
        >
          <s-text tone={tone === "subdued" ? "neutral" : "auto"}>{narrative}</s-text>
        </p>
        {children}
        {cta && (
          <AppLink to={cta.to}>
            <s-button variant="primary">{cta.label}</s-button>
          </AppLink>
        )}
      </s-stack>
    </s-box>
  );
}
