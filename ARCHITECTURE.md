# Architecture

- **revstack** = canonical backend for the Shopify storefront. All live cart-decision traffic is served by revstack.
- **apps/api** = deprecated backend. Not used by the Shopify storefront. Was intended for future multi-platform support.
- **decision-engine** = pure logic only. No hardcoded business thresholds; it receives store metrics (e.g. baseline AOV, free-shipping threshold) from the caller.
- The theme extension (storefront) calls revstack via the **Shopify App Proxy**.
- There must never be two live decision endpoints. Only revstack serves decisions for Shopify.
