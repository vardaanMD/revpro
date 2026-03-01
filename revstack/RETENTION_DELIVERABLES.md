# Phase 5 – Retention & Behavioral Loop – Deliverables

## Step 1 – Current Retention Audit

### Dashboard (`app._index.tsx`)
| Question | Before | After |
|----------|--------|--------|
| Reason to come back tomorrow? | Weak – only "today's decisions" and 7-day table | **Momentum section**: 7-day performance, revenue this week, engine active days; **PerformanceDelta** (this week vs last week); **Health badge** |
| Show momentum? | 7-day trend table only | **MomentumCard** row + **PerformanceDelta** with "Improving" reinforcement |
| Improvement over time? | No period comparison | **This week vs last week** decisions + uplift |
| Celebrate wins? | Onboarding-complete banner only | **AchievementBanner** for weekly uplift and milestones (100 decisions, 10k revenue, 30 days active) |

**Missing signals (addressed):** No health indicator, no "engine active X days", no week-over-week comparison, no milestone celebration, no re-engagement when away.

**Static → dynamic:** Plan/currency stayed; added dynamic retention context (health, days active, firstTimeAchieved, daysSinceLastActive).

---

### Analytics (`app.analytics.tsx`)
| Question | Before | After |
|----------|--------|--------|
| Reason to return? | Period comparison + sparklines | Same + **re-engagement suggestion** when metrics flat |
| Momentum? | 7d vs prev 7d in cards | Unchanged (already present) |
| Improvement? | Comparison rows (▲/▼) | Unchanged |
| Celebrate? | None | Upgrade framing only (no fake data) |

**Missing signals (addressed):** Contextual suggestion when add rate or decisions flat: "Try adjusting your recommendation strategy" → link to Optimization Controls. Upgrade copy changed to **"Continue your growth momentum"** / **"Unlock next stage"** / **"Unlock revenue multiplier"**.

**Static → dynamic:** Locked CTAs now use retention framing.

---

### Onboarding (`app.onboarding.tsx`)
| Question | Before | After |
|----------|--------|--------|
| Reason to return? | Progress bar + steps | Unchanged |
| Momentum? | X/5 completed | Unchanged |
| Improvement? | N/A | N/A |
| Celebrate? | Redirect to dashboard with banner | Unchanged |

**Missing signals:** Onboarding is one-time; no change except **micro-ownership**: "Let's Set Up **Your Growth Engine**".

**Static → dynamic:** Heading copy only.

---

### Upgrade (`app.upgrade.tsx`)
| Question | Before | After |
|----------|--------|--------|
| Reason to return? | Plans + ROI | **Framing**: "Continue your growth momentum", "Your growth engine — next stage" |
| Momentum? | N/A | Copy: "Growth accelerator and revenue multiplier" |
| Improvement? | N/A | N/A |
| Celebrate? | N/A | N/A |

**Missing signals (addressed):** **Upgrade retention framing**: page heading "Continue your growth momentum"; section "Your growth engine — next stage"; copy "Unlock the next stage of your optimization layer", "Growth accelerator and revenue multiplier".

**Static → dynamic:** All copy is static but reframed.

---

### Settings (`app.settings.tsx`)
| Question | Before | After |
|----------|--------|--------|
| Reason to return? | Save success | Unchanged |
| Momentum? | N/A | N/A |
| Improvement? | N/A | N/A |
| Celebrate? | Success banner | Unchanged |

**Missing signals (addressed):** Locked feature copy: **"Next stage: Advanced plan"** and **"Continue your growth momentum"** instead of "Available on Advanced plan" / "Upgrade to unlock".

---

## Step 2 – Momentum Layer

- **MomentumCard** (new): "7-day performance", "Revenue influenced this week", "Engine active (X days)".
- **PerformanceDelta** (new): This week vs last week (decisions) with "Improving" when current > previous.
- All values derived from **existing metrics** and **RetentionContext** (no fake data).
- **Today vs yesterday** not added (dashboard focuses on 7d; analytics already has 7d vs prev 7d).

## Step 3 – Celebration Mechanics

- **AchievementBanner** (new): Uses `<s-banner tone="success">` / `tone="info"`; no confetti.
- **Uplift banner:** When `upliftThisWeek >= 1` cent: "Your engine generated [currency]X additional revenue this week."
- **Milestones:** 100 decisions, 10k revenue (1M cents), 30 days active — each shows once; state stored in `ShopConfig.milestoneFlags`.

## Step 4 – Health Score

- **HealthBadge** (new): Status **Active** / **Improving** / **Needs attention** from:
  - Billing active + recent decisions + positive uplift → **Improving**
  - Billing active + some activity → **Active**
  - Billing inactive or zero recent decisions → **Needs attention**
- Shown on dashboard with tooltip (title attribute) explaining each status.
- Logic in `getHealthStatus()` in `~/lib/retention.server.ts`.

## Step 5 – Re-engagement Hooks

- **"Here's what happened while you were away"** when `daysSinceLastActive >= 5` (dashboard), with CTA to check Revenue Snapshot and 7-day trend.
- **"Try adjusting your recommendation strategy"** on Analytics when add rate or decisions are flat (vs previous 7d), with link to Optimization Controls.
- `lastActiveAt` updated on dashboard load via `touchLastActive(shop)` so next visit can compute days since last active.

## Step 6 – Upgrade Retention Framing

- Replaced **"Upgrade to unlock"** with **"Continue your growth momentum"** (dashboard, settings, analytics, LockedMetric default).
- Premium framed as **"Next stage"**, **"Growth accelerator"**, **"Revenue multiplier"** (upgrade page, analytics lock CTA).
- LockedMetric default CTA: **"Unlock next stage"**.

## Step 7 – Micro-ownership Signals

- Dashboard: "**Your growth engine** influenced…", "**Your growth engine** is inactive", "**Your optimization layer** is adding value".
- Onboarding: "Let's Set Up **Your Growth Engine**".
- Upgrade: "**Your growth engine** — next stage".
- Achievement: "**Your engine** generated…", "**Your optimization layer** is in motion", "**Your cart intelligence** is part of the routine."
- Tone kept confident and professional.

## Step 8 – Minimal Data Additions

- **ShopConfig** (Prisma):
  - `activatedAt` (DateTime?) – set when onboarding is completed (app layout).
  - `lastActiveAt` (DateTime?) – updated on dashboard load.
  - `milestoneFlags` (Json?) – `{ "100_decisions", "10k_revenue", "30_days_active" }` booleans; updated when milestone first reached.
- No new tables, no background workers. **ensureActivatedAt** and **touchLastActive** run in existing loaders.

---

## New Retention UI Elements

1. **Health badge** – Optimization health (Active / Improving / Needs attention) with tooltip on dashboard.
2. **Re-engagement banner** – "Here's what happened while you were away" when last active ≥ 5 days.
3. **Uplift celebration banner** – "Your engine generated [X] additional revenue this week" when weekly uplift > 0.
4. **Milestone banners** – 100 decisions, 10k revenue, 30 days active (one-time each).
5. **Momentum section** – MomentumCards (7-day performance, revenue this week, engine active days) + PerformanceDelta (this week vs last week).
6. **Flat-analytics suggestion** – "Try adjusting your recommendation strategy" on Analytics when metrics flat.

---

## New Components

| Component | Path | Purpose |
|-----------|------|--------|
| **MomentumCard** | `app/components/ui/MomentumCard.tsx` | Single momentum metric (title, value, subtext, tone). |
| **PerformanceDelta** | `app/components/ui/PerformanceDelta.tsx` | Current vs previous with % change and "Improving" when positive. |
| **AchievementBanner** | `app/components/ui/AchievementBanner.tsx` | Thin wrapper around `<s-banner>` for success/info. |
| **HealthBadge** | `app/components/ui/HealthBadge.tsx` | Status badge + tooltip for optimization health. |

All use existing **s-*** components and **CSS modules** (no Tailwind). Polaris-native feel.

---

## Behavioral Loop

1. **Entry:** Merchant opens app → **lastActiveAt** updated on dashboard load; **health badge** and **momentum** visible.
2. **Momentum:** 7-day performance, revenue this week, engine active days + **this week vs last week** create reason to return and see progress.
3. **Wins:** Uplift and milestone banners reinforce that the product is working.
4. **Health:** Badge creates mild ownership ("keep my optimization healthy").
5. **Re-engagement:** After 5+ days away, "Here's what happened while you were away" pulls them back; flat metrics suggest a next action (strategy in settings).
6. **Upgrade:** Framed as "Continue your growth momentum" and "next stage" so upgrade feels like progression, not paywall.

---

## Confirmation: No Hard Dependencies

- **Billing:** No changes to billing logic or subscription flow.
- **Infrastructure:** No new queues, workers, or external services.
- **Data:** Only optional fields on `ShopConfig` and one new server module (`retention.server.ts`) using existing Prisma and dashboard/analytics metrics.
- **UI:** Only existing s-* and current CSS modules; no Tailwind, no new design system.

---

## Migration

Run after pulling:

```bash
npx prisma migrate dev --name add_retention_fields
```

Existing rows get `activatedAt`, `lastActiveAt`, `milestoneFlags` as null; they are backfilled when the merchant completes onboarding (activatedAt) and when they load the dashboard (lastActiveAt, milestoneFlags when milestones are reached).
