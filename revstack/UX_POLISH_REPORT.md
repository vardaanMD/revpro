# UX Polish Audit — Friction Points

*Observed friction. No opinions.*

---

## Dashboard (/app)

- **Metric values pop in abruptly** — No fade-in or count-up; numbers appear instantly when skeleton → content transition completes.
- **Revenue Snapshot / Momentum sections** — Vertical spacing between sections may feel dense in some viewports.
- **Locked metrics** — LockedMetric uses blur(4px); overlay CTA "Unlock next stage" may not feel primary enough when billing inactive.
- **CTA hierarchy** — Multiple banners (onboarding incomplete, billing inactive, uplift) can compete; "Activate Growth Engine" vs "Continue your growth momentum" wording varies.
- **Skeleton → content transition** — contentFade opacity 0.6→1 over 200ms exists; metric values still snap in.

---

## Settings (/app/settings)

- **Save button** — Already has `disabled={isSubmitting}` and "Saving…" text ✓
- **Form controls not disabled during submit** — User can edit fields while saving; risk of form data changing mid-flight.
- **No inline spinner** — s-button may or may not show loading indicator; text change only.
- **Error display** — `actionData.error` shown in banner; validation errors from server could be technical (e.g. "invalid JSON").
- **Section spacing** — `.section` has `padding-bottom`, `border-bottom`; vertical rhythm generally consistent (var(--app-space-4)).
- **Milestone editor** — Remove button uses red text; no border-radius on `.removeMilestone` (uses 8px from tokens).

---

## Analytics (/app/analytics)

- **Metric values pop in abruptly** — Same as dashboard; numbers appear instantly.
- **Locked comparison block** — `blurAdvanced` applies blur(4px); "Continue your growth momentum to unlock full funnel breakdown" CTA below.
- **Locked Revenue Impact** — `blurredRevenue` blur(3px); overlay with lock icon and "Unlock revenue multiplier" CTA.
- **Upgrade CTAs** — "Unlock next stage" (tertiary) vs "Unlock revenue multiplier" (primary); hierarchy mixed.
- **Blurred content** — No opacity reduction; blur only.

---

## Onboarding (/app/onboarding)

- **Step completion buttons** — step1Fetcher, verifyFetcher, previewFetcher use `loading` prop on s-button ✓
- **Button text does not change** — "I've activated the extension", "Verify", "Open Preview" stay static; loading is visual only.
- **Form controls not disabled** — While one step is submitting, other actions remain clickable (lower risk here due to single-action steps).
- **Progress bar** — Smooth fill; no animation on percentage change.

---

## Preview (/app/preview)

- **Refresh button** — Already has `disabled={fetcher.state !== "idle"}` and "Refreshing…" text ✓
- **Preview content** — No fade when regenerating; CartPreview swaps in new decision data abruptly.
- **Layout stability** — previewDrawerSection has min-height: 400px; no jump.
- **No "Simulating…" label** — When fetcher is loading, only button shows "Refreshing…"; preview area has no loading indicator.
- **Preview controls form** — Strategy select, checkboxes, threshold input not disabled during submit.

---

## Upgrade (/app/upgrade)

- **Plan activate buttons** — No loading state; no "Upgrading…" or disabled state during submit.
- **Form in PlanComparisonTable** — Each plan has its own Form; submit triggers redirect; navigation.state === "submitting" would apply.
- **Double submit risk** — User could click "Activate Advanced" multiple times before redirect.
- **Current plan** — Button correctly disabled when isCurrent ✓

---

## Global

- **Loading bar** — Shows immediately when `navigation.state === "loading" || "submitting"`; no delay; can flicker on fast navigations (<120ms).
- **Loading bar animation** — Shimmer (translateX) runs indefinitely; no ease-in or completion animation.
- **No smooth completion** — Bar disappears when navigation completes; no "fill to 100% then fade" behavior.

---

## Visual Consistency

- **Border radius** — Mixed: 8px, 6px, 4px; `var(--p-border-radius-base, 8px)` used in some places.
- **Spacing scale** — tokens.css defines --app-space-1 through 6; some hardcoded values (e.g. 0.5rem, 1.5rem).
- **Locked content treatment** — LockedMetric overlay vs analytics overlay; different blur amounts (4px vs 3px).

---

## Error Handling

- **Settings** — `error` from action rendered in s-banner tone="critical"; could be raw validation message.
- **No raw JSON observed** — Error paths return `{ success: false, error: string }`.
- **Banner tone** — Critical (red) for errors; no sudden flash animation observed.

---

# UX Polish Implementation Summary

## Files Modified

| File | Changes |
|------|---------|
| `app/routes/app.settings.tsx` | Fieldset `disabled={isSubmitting}` around form; `loading` prop on save button |
| `app/routes/app.upgrade.tsx` | `useNavigation`, pass `isSubmitting` to PlanComparisonTable |
| `app/routes/app.onboarding.tsx` | Button text: "Processing…", "Verifying…", "Opening…" during submit |
| `app/routes/app.preview.tsx` | Fieldset `disabled` on form; "Simulating…" label; fade on regenerate |
| `app/routes/app.tsx` | Replace inline loading bar with `<LoadingBar>` component |
| `app/components/ui/PlanComparisonTable.tsx` | `isSubmitting` prop; "Upgrading…" text; `loading` + `disabled` on buttons |
| `app/components/ui/LockedMetric.tsx` | CTA variant `secondary` → `primary` |
| `app/components/LoadingBar.tsx` | **New** — 120ms show delay; smooth completion animation |
| `app/components/ui/MetricCard.module.css` | Fade-in animation for metric values |
| `app/styles/loadingBar.module.css` | Ease-in; completing animation (fill + fade) |
| `app/styles/analyticsPage.module.css` | Locked content opacity 0.72; overlay rgba; upgradeHint spacing |
| `app/styles/settingsPage.module.css` | Section spacing; padding tokens; removeMilestone padding |
| `app/styles/previewPage.module.css` | Section spacing; simulatingLabel; regenerating fade; border-radius tokens |
| `app/components/ui/LockedMetric.module.css` | Blur 3px; opacity 0.72; overlay rgba |
| `app/components/ui/PlanComparisonTable.module.css` | plansGrid gap → var(--app-space-6) |

## UX Friction Points Fixed

1. **Button loading states** — Settings, Upgrade, Onboarding, Preview all show loading text and disabled state
2. **Double submits** — Fieldset disabled during submit on Settings and Preview
3. **Metric pop-in** — MetricCard values fade in (0.22s)
4. **Section spacing** — Consistent 24px/32px via tokens; plans grid gap increased
5. **Upgrade CTA** — LockedMetric CTA primary; locked content opacity reduced; overlay more subtle
6. **Loading bar** — 120ms delay (no flicker); ease-in; fill-to-complete then fade out
7. **Preview** — "Simulating…" label; opacity fade when regenerating
8. **Harsh edges** — Border-radius and padding normalized to design tokens

## Remaining UX Gaps (for future)

- Onboarding form controls could be disabled during step submit (lower priority)
- Settings error messages from validation — ensure all paths return user-friendly strings
