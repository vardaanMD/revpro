type FormSectionProps = {
  heading: string;
  description?: string;
  children: React.ReactNode;
};

export function FormSection({ heading, description, children }: FormSectionProps) {
  return (
    <s-section heading={heading}>
      <s-stack direction="block" gap="base">
        {description && <s-text tone="neutral">{description}</s-text>}
        {children}
      </s-stack>
    </s-section>
  );
}
