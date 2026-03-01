/**
 * Compact achievement banner: uplift above threshold or milestone reached.
 * Non-intrusive, SaaS professional. No confetti.
 */

type AchievementBannerProps = {
  message: string;
  tone?: "success" | "info";
};

export function AchievementBanner({
  message,
  tone = "success",
}: AchievementBannerProps) {
  return (
    <s-banner tone={tone} dismissible={false}>
      {message}
    </s-banner>
  );
}
