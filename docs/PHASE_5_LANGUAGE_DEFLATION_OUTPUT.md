# PHASE 5 — LANGUAGE DEFLATION & TONE HARDENING — OUTPUT

Language-only changes. No UI redesign. No feature or billing/analytics logic changes.

---

## 1. Before → After Terminology Mapping

| Before | After |
|--------|--------|
| Revenue Overview | Overview |
| Revenue Intelligence | Analytics |
| Optimization Controls | Settings |
| Activate Growth Engine | Activate Plan |
| RevPRO — Cart Intelligence Engine | RevPRO |
| Let's Set Up Your Growth Engine | Set up recommendations |
| Go to Optimization Controls | Go to Settings |
| Choose strategy in Optimization Controls | Choose strategy in Settings |
| Your optimization layer is now active | Recommendations are live. Metrics will appear after customer interactions. |
| Your plan is inactive — activate to unlock advanced optimization and analytics | Your plan is inactive — activate to access recommendation settings and analytics. |
| Finish setup to unlock full performance | Finish setup to see metrics. |
| Complete setup to unlock this page | Complete setup to access this page. |
| Finish setup to unlock the dashboard | Finish setup to access the dashboard. |
| Milestone: 100 cart decisions — your optimization layer is active | Milestone: 100 cart decisions recorded. |
| Your cart engine is live. Data will appear... | Recommendations are live. Data will appear after customer interactions. |
| Engine active | Days active |
| Unlock full access (FeatureGate / CTAs) | Activate plan |
| Unlock rule stacking and advanced analytics | Access strategy selection and comparison metrics |
| Unlock this feature / Unlock next stage (LockedMetric) | Activate plan |
| Optimization health | Status |
| Your optimization layer is running. Keep an eye on Revenue Intelligence for trends. | Recommendations are running. Check Analytics for trends. |
| Performance is trending up. Your growth engine is driving results. | Metrics are trending up. |
| Activate a plan to unlock the full Cart Intelligence Engine | Activate a plan to use recommendations and analytics. |
| Try adjusting... in Optimization Controls / Open Optimization Controls | Try adjusting... in Settings / Open Settings |
| Your optimization layer — next stage (Upgrade section heading) | Removed; single "Plans" section only. |
| Unlock more recommendations, strategy controls, and full analytics when you activate | Removed (persuasive intro). |
| Your cart optimization is live (revenue narrative) | Recommendations are live. |
| Compare cart behavior when recommendations are shown vs. not shown below. | Sessions where recommendations were shown. Average cart value difference between sessions with and without recommendations below. |

**Upgrade page plan benefits (factual, no ROI):**

| Plan | Before (summary) | After |
|------|------------------|--------|
| Basic | 1 cross-sell per cart, Basic performance metrics, ROI line | Up to 1 recommendation per session. Milestones & free shipping bar. Standard cart metrics. roi text: Sessions where recommendations were shown. Standard cart metrics. |
| Advanced | 3 cross-sells, Strategy & UI, Coupon & period comparison, ROI line | Up to 3 recommendations per session. Strategy selection. Comparison metrics. roi text: Strategy selection. Period comparison. Comparison metrics. |
| Growth | 8 cross-sells, Full feature access, Revenue intelligence & advanced analytics, ROI line | Up to 8 recommendations per session. Comparison metrics. Estimated revenue difference (observed). roi text: Comparison metrics. Estimated revenue difference (observed). |

---

## 2. Updated Navigation Labels

| Location | Label |
|---------|--------|
| Home | **Overview** |
| Settings | **Settings** |
| Analytics | **Analytics** |
| Upgrade (when billing inactive) | **Activate Plan** |
| Billing (when entitled) | Billing |
| Footer | **RevPRO** |

Page headings aligned:
- Dashboard: **Overview**
- Settings: **Settings**
- Analytics: **Analytics**
- Upgrade: **Activate Plan**

---

## 3. Upgrade Page Copy (Final)

**Page heading:** Activate Plan

**Structure:** Single section "Plans" with `PlanComparisonTable`. No persuasive intro paragraph; no "Your optimization layer — next stage"; no ROI or time-to-ROI claims.

**Plan cards:**

- **Basic — $9/mo**  
  - Up to 1 recommendation per session  
  - Milestones & free shipping bar  
  - Standard cart metrics  
  - Subtext: Sessions where recommendations were shown. Standard cart metrics.  
  - Button: Activate Basic / Current plan

- **Advanced — $29/mo** (Recommended)  
  - Up to 3 recommendations per session  
  - Strategy selection  
  - Comparison metrics  
  - Subtext: Strategy selection. Period comparison. Comparison metrics.  
  - Button: Activate Advanced / Current plan

- **Growth — $49/mo** (Most popular)  
  - Up to 8 recommendations per session  
  - Comparison metrics  
  - Estimated revenue difference (observed)  
  - Subtext: Comparison metrics. Estimated revenue difference (observed).  
  - Button: Activate Growth / Current plan

No percentages (e.g. 8–15% lift). No "pays for itself." No emotional CTA copy.

---

## 4. Confirmation: Billing and Analytics Logic Unchanged

- **Billing:** No changes to `billing.server.ts`, `billing-context.server.ts`, `createSubscription`, plan IDs, or entitlement checks.
- **Analytics:** No changes to `analytics.server.ts`, `dashboard-metrics.server.ts`, metric computation, thresholds (e.g. count_with ≥ 30), or gating logic.
- **Capabilities:** No changes to `capabilities.server.ts` or plan capability flags.
- Only copy/strings and navigation labels were changed in routes and UI components.

---

## 5. Banned-Word Search (revstack/app) — Zero User-Facing Matches

Searches run after implementation:

- **Phrases:** "Growth Engine", "Optimization Engine", "Revenue Engine", "Intelligent timing", "Unlock growth", "Supercharge", "Maximize", "Boost revenue", "Powerful", "Advanced optimization", "Revenue impact", "Earned for you", "Pays for itself", "Increase your revenue", "Drive growth", "Scale your revenue" → **0 matches** in app UI/copy.
- **Nav/headings:** "Revenue Overview", "Revenue Intelligence", "Optimization Controls", "Activate Growth Engine" → **0 matches** in app UI/copy.
- **Engine metaphor (user-facing):** "your engine", "your growth engine", "Your optimization layer" (in tooltips/banners), "You earned", "generated... revenue" → **0 matches** in app UI/copy.
- **ROI/hype:** "Cart Intelligence Engine", "8–15%", "pays for itself", ROI promises → **0 matches** in app UI/copy.

Remaining "engine" occurrences are limited to:
- Package name `@revpro/decision-engine` (imports).
- Internal code/comments (e.g. timings.engine, "engine snapshot") — not user-facing.

---

## Validation Checklist

1. **No hype words remain** — Yes (in app UI/copy).
2. **No ROI claims exist** — Yes; upgrade and plan copy are capability-only.
3. **No causation language** — Yes; disclaimers retain "observational data and does not prove causation."
4. **Tone reads like infrastructure software** — Yes; factual, neutral descriptions.
5. **Terminology consistent** — Yes; Overview, Settings, Analytics, Activate Plan used in nav and headings.
6. **Billing logic untouched** — Yes.
7. **No metric logic changed** — Yes.

---

## Files Modified (Language Only)

- `revstack/app/routes/app.tsx` — Nav labels, footer, block copy.
- `revstack/app/routes/app._index.tsx` — Page heading, banners, narrative, metric labels, FeatureGate CTAs, Status label.
- `revstack/app/routes/app.analytics.tsx` — Page heading, banner/button (Settings), FeatureGate CTAs.
- `revstack/app/routes/app.settings.tsx` — Page heading.
- `revstack/app/routes/app.onboarding.tsx` — Heading, button labels (Settings).
- `revstack/app/routes/app.upgrade.tsx` — Section removed, plan benefits/roi text made factual.
- `revstack/app/routes/app.billing.tsx` — One line of copy.
- `revstack/app/components/ui/HealthBadge.tsx` — Tooltip copy.
- `revstack/app/components/ui/FeatureGate.tsx` — Default ctaLabel.
- `revstack/app/components/ui/LockedMetric.tsx` — Default ctaText and button text.
- `revstack/app/components/ui/PlanComparisonTable.tsx` — Comment only (no ROI emphasis).

No changes to: `cart.decision.ts`, catalog/analytics/billing/capabilities server logic, Prisma, or extensions.
