/**
 * Momentum layer: visible progress to create reason to return.
 * Uses existing s-* components; Polaris-native.
 */

type MomentumCardProps = {
  title: string;
  value: string;
  subtext?: string;
  tone?: "default" | "success" | "subdued";
};

export function MomentumCard({
  title,
  value,
  subtext,
  tone = "default",
}: MomentumCardProps) {
  const valueStyle: React.CSSProperties = {
    fontSize: "var(--app-metric-value-size)",
    fontWeight: "var(--app-metric-value-weight)",
  };
  if (tone === "success") valueStyle.color = "var(--p-color-text-success)";
  else if (tone === "subdued") valueStyle.color = "var(--p-color-text-subdued)";

  return (
    <s-box
      padding="base"
      borderWidth="base"
      borderRadius="base"
      background="subdued"
    >
      <s-stack direction="block" gap="small">
        <s-text tone="neutral">{title}</s-text>
        <div style={valueStyle}>{value}</div>
        {subtext != null && subtext !== "" && (
          <s-text tone="neutral">{subtext}</s-text>
        )}
      </s-stack>
    </s-box>
  );
}
