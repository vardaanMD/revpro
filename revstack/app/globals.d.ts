declare module "*.css";

// Custom s-* elements accept HTML attributes plus arbitrary props (tone, heading, variant, etc.)
type SElement = React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement> & Record<string, unknown>;

declare namespace JSX {
  interface IntrinsicElements {
    "s-app-nav": SElement;
    "s-banner": SElement;
    "s-box": SElement;
    "s-button": SElement;
    "s-checkbox": SElement;
    "s-heading": SElement;
    "s-link": SElement;
    "s-list-item": SElement;
    "s-page": SElement;
    "s-paragraph": SElement;
    "s-section": SElement;
    "s-stack": SElement;
    "s-text": SElement;
    "s-text-area": SElement;
    "s-text-field": SElement;
    "s-unordered-list": SElement;
  }
}
