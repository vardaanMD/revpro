# Phase 4 – Revenue-Optimized SaaS UX Layer

## Output Summary

### 1. UI Changes Implemented

| Page | Change |
|------|--------|
| **App Layout** | Soft paywall: removed hard redirect when `billingStatus !== "active"`; users can access all pages with limited/locked content |
| **App Layout** | Added "Activate Growth Engine" nav link when billing inactive |
| **Dashboard** | New "Revenue Snapshot" section at top with: Revenue influenced, Estimated monthly uplift, Decisions taken, Conversion impact |
| **Dashboard** | Growth narrative: "Your cart engine influenced $X in revenue this month." |
| **Dashboard** | When `billingStatus !== "active"`: locked metric preview, blurred advanced metrics, inline CTA "Unlock advanced optimization" |
| **Dashboard** | Revenue engine inactive banner when billing inactive |
| **Analytics** | Soft paywall: limited 7-day metrics visible; 30-day summary, period comparison, revenue impact blurred/locked when plan or billing inactive |
| **Analytics** | Inline CTAs: "Upgrade to unlock full funnel breakdown", "Unlock advanced optimization" |
| **Upgrade** | Full redesign: plan comparison table with benefit-driven copy, ROI emphasis |
| **Upgrade** | Urgency framing: "Revenue engine inactive", "Advanced optimization locked" |
| **Settings** | Locked feature labels: "Available on Advanced plan" for strategy selection, UI config, coupon tease |
| **Settings** | Locked blocks with upgrade CTA instead of hidden fields |
| **Onboarding** | Button copy: "Go to Optimization Controls" instead of "Go to Settings" |

### 2. Copy Changes

| Before | After |
|--------|-------|
| Home (nav) | Revenue Overview |
| Settings (nav) | Optimization Controls |
| Analytics (nav) | Revenue Intelligence |
| Upgrade (nav, when inactive) | Activate Growth Engine |
| "Choose a plan" | Activate Growth Engine |
| "Billing required" | Revenue engine inactive |
| "Upgrade" (buttons) | Activate Growth Engine / Unlock advanced optimization |
| "Upgrade to view period comparison" | Upgrade to unlock full funnel breakdown |
| "Upgrade to unlock full revenue analytics" | Upgrade to unlock full funnel breakdown |
| "Unlock rule stacking and advanced analytics" | (unchanged, used in plan card) |
| "Go to Settings" | Go to Optimization Controls |

### 3. Before vs After Structure

**Dashboard (Before):**
- Page title: Revenue Overview
- Flat metric cards (Today's Decisions, Show Rate, Add Rate, Avg Cart, Estimated Revenue Influence)
- 7 Day Trend table
- Current Plan card + Upgrade button

**Dashboard (After):**
- Page title: Revenue Overview
- **Revenue Snapshot** (new top section): growth narrative + 4-metric grid (Revenue influenced, Monthly uplift, Decisions, Conversion impact)
- When billing inactive: banner "Revenue engine inactive", locked/blurred metrics with CTAs
- Metric cards (unchanged layout, success tone on money values)
- 7 Day Trend (locked when billing inactive)
- Current Plan + "Activate Growth Engine" CTA

**Upgrade (Before):**
- "Choose a plan" heading
- "Billing required" section
- Vertical list of plan boxes (Basic, Advanced, Growth) with description + price + "Select" button

**Upgrade (After):**
- "Activate Growth Engine" heading
- "Revenue engine inactive" section with micro-proof: "Most stores see 8–15% AOV lift — pays for itself in ~3 orders"
- Plan comparison grid (PlanComparisonTable): benefit bullets, ROI text, "Recommended" badge on Advanced, "Current plan" when active

**Analytics (Before):**
- Page title: Analytics
- Plan-gated blur on period comparison and revenue impact
- Generic "Upgrade" CTAs

**Analytics (After):**
- Page title: Revenue Intelligence
- Same sections, but gated by both `plan` and `billingStatus` (soft paywall)
- Contextual CTAs: "Activate Growth Engine", "Unlock advanced optimization"

**Settings (Before):**
- Page title: Settings
- Locked features: hidden, replaced with hidden form inputs

**Settings (After):**
- Page title: Optimization Controls
- Locked features: visible disabled blocks with "Available on Advanced plan" and "Upgrade to unlock" CTA

### 4. New Reusable Components

| Component | Path | Purpose |
|-----------|------|---------|
| **RevenueBanner** | `app/components/ui/RevenueBanner.tsx` | Top-of-page growth narrative with optional metrics and CTA; supports success/subdued tone |
| **LockedMetric** | `app/components/ui/LockedMetric.tsx` | Wraps content in blurred overlay with lock icon + "Unlock advanced optimization" CTA |
| **PlanComparisonTable** | `app/components/ui/PlanComparisonTable.tsx` | SaaS-style plan grid: name, price, ROI text, benefit bullets, recommended badge, current plan state |

### 5. Files Modified

- `app/routes/app.tsx` – Soft paywall, nav labels, billing link
- `app/routes/app._index.tsx` – Revenue Snapshot, locked metrics, growth narrative
- `app/routes/app.analytics.tsx` – Revenue Intelligence title, billingStatus gating, copy
- `app/routes/app.upgrade.tsx` – Full redesign with PlanComparisonTable
- `app/routes/app.settings.tsx` – Optimization Controls, locked feature labels
- `app/routes/app.onboarding.tsx` – Optimization Controls button copy
- `app/styles/tokens.css` – Added `--app-revenue-emphasis`
- `app/styles/settingsPage.module.css` – New: lockHint, lockedBlock, lockedInline

### 6. Files Created

- `app/components/ui/RevenueBanner.tsx`
- `app/components/ui/LockedMetric.tsx`
- `app/components/ui/LockedMetric.module.css`
- `app/components/ui/PlanComparisonTable.tsx`
- `app/components/ui/PlanComparisonTable.module.css`
- `app/styles/settingsPage.module.css`

---

## STEP 1 – Value Hierarchy Audit (Findings)

### Weak Revenue Framing Areas
- Dashboard: "Estimated Revenue Influence" was buried below operational metrics
- Analytics: "Estimated Uplift" not visually emphasized as primary value
- Upgrade: Feature counts instead of ROI/outcomes
- Settings: Locked features invisible (hidden entirely)
- Nav: Neutral labels (Home, Analytics, Settings) did not convey value

### Missed Monetization Moments
- No growth narrative on dashboard
- No urgency framing when billing inactive
- Hard block on upgrade redirect prevented seeing value before paywall
- Period comparison and revenue impact lacked contextual upgrade prompts
- Plan comparison was feature-list, not benefit-driven
