# PHASE 6.1 — Onboarding flow — Audit (STEP 0)

## 1. ShopConfig schema
- **Location**: `prisma/schema.prisma`
- **Fields**: id, shopDomain, baselineAovCents, freeShippingThresholdCents, milestonesJson, enableCrossSell, enableMilestones, enableCouponTease, plan, billingStatus, trialEndsAt, billingId, version, createdAt, updatedAt, recommendationStrategy, manualCollectionIds, recommendationLimit, primaryColor, accentColor, borderRadius, showConfetti, enableHaptics, countdownEnabled, emojiMode, shippingBarPosition
- **Missing for onboarding**: onboardingCompleted, onboardingStepProgress, previewSeen

## 2. App route (`app/routes/app.tsx`)
- Loader: `authenticate.admin`, `requireActivePlan(session.shop)` (skipped for `/app/upgrade`)
- Returns: `{ apiKey }`
- No getShopConfig; no onboarding redirect

## 3. app.settings.tsx
- Loader: authenticate.admin, getShopConfig, resolveCapabilities; returns config + capabilities
- Config includes: freeShippingThresholdCents, enableCrossSell, enableMilestones, recommendationStrategy (default "COLLECTION_MATCH"), etc.
- Action: POST, validateSettingsForm, prisma.shopConfig.update, invalidateShopConfigCache

## 4. Decision route
- **File**: `app/routes/cart.decision.ts`
- POST only; proxy signature + replay check; writes `DecisionMetric` per successful decision (shopDomain, hasCrossSell, cartValue)
- **Cart verified**: at least one DecisionMetric for shop (count > 0)

## 5. Plan gating
- `requireActivePlan(session.shop)` in app.tsx loader; redirects to `/app/upgrade` if billingStatus !== "active"
- PAYWALL_DISABLED_SHOPS env can skip

## 6. recommendationStrategy
- Exists in ShopConfig, default "COLLECTION_MATCH"
- Used in settings UI and default-config.server

## 7. enableCrossSell, enableMilestones
- Both in ShopConfig and app.settings.tsx; default true in default-config.server

## 8. Default freeShippingThresholdCents
- 2000 in `app/lib/default-config.server.ts` (DEFAULT_SHOP_CONFIG)

## 9. Safe handler
- `withSafeHandler` in `app/lib/safe-handler.server.ts`; used for POST actions; catches errors, logs, returns 500

## 10. Routes
- flatRoutes (file-based). No app.onboarding.tsx yet.
