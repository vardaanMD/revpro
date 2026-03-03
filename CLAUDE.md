# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository Layout

```
revPRO/
├── revstack/                    # Main Shopify app (canonical backend + admin UI)
│   ├── app/                     # React Router v7 app (routes, loaders, actions)
│   │   ├── routes/              # All server routes
│   │   └── lib/                 # Server-only utilities (.server.ts)
│   ├── cart-pro-v3-runtime/src/ # Svelte storefront widget (Cart Pro V3)
│   │   ├── engine/              # Engine.ts + supporting modules (pure logic, no Svelte)
│   │   ├── ui/                  # Svelte components (Drawer.svelte, v2/*)
│   │   ├── integration/         # themeConnector (bridges theme events → engine)
│   │   └── mount.ts             # Mounts App.svelte into shadow DOM on the storefront
│   ├── extensions/cart-pro/     # Shopify theme extension (Liquid blocks, loads the JS)
│   ├── packages/decision-engine/ # Pure TS package: decideCartActions(), no side effects
│   ├── prisma/schema.prisma     # PostgreSQL schema (Railway)
│   └── server.ts                # Custom Express + React Router server
├── apps/api/                    # DEPRECATED — not used by Shopify storefront
└── ARCHITECTURE.md              # Single-paragraph architecture summary
```

## Commands

All commands run from `revstack/`:

```bash
# Development (requires Cloudflare tunnel to app.revenity.io → localhost:3000)
npm run dev

# Build
npm run build          # prisma generate + react-router build

# Production start
npm run start          # tsx server.ts

# Tests
npm run test           # vitest run (all tests)
npm run test:watch     # vitest watch mode

# Database
npm run migrate:dev    # prisma migrate dev (create migration)
npm run migrate:deploy # prisma migrate deploy (apply in prod)
npm run setup          # prisma generate (regen client only)

# Type check
npm run typecheck

# Lint
npm run lint
```

Tests are in `revstack/tests/`. To run a single test file:
```bash
npx vitest run tests/cart.decision.billing.test.ts
```

## Architecture

### Backend (revstack)

`revstack` is the **only** live decision backend for Shopify. `apps/api` is deprecated.

The server is `server.ts` (Express + React Router v7). It runs `runAppAuth` before every `GET /app/*` request to authenticate and pre-load shop config into request context, so loaders don't repeat it.

Key storefront routes (called via **Shopify App Proxy** at `/apps/cart-pro/*`):

| Route | Purpose |
|---|---|
| `cart.decision.ts` | POST: runs decision engine, returns cross-sell/milestone data |
| `cart.bootstrap.ts` / `cart.bootstrap.v2.ts` | Returns shop config snapshot (used by Liquid to set `window.__CART_PRO_SNAPSHOT__`) |
| `cart.snapshot.v3.ts` | Config snapshot for V3 |
| `cart.analytics.v3.ts` / `cart.analytics.event.ts` | Ingest storefront analytics events |

**Decision endpoint** (`cart.decision.ts`) has a **300 ms hard timeout** and a `safeDecisionResponse()` fallback (empty crossSell, no suppression). It never returns an error to the storefront — always 200. Cache pipeline: in-memory → Redis → compute. All monetary values throughout the system are in **cents**.

**Billing / capabilities**: `billing-context.server.ts` resolves a `capabilities` object from the shop's plan. All feature gating goes through `capabilities` (not raw plan strings). The decision endpoint enforces capabilities before writing metrics and before capping cross-sell count.

**Infrastructure**: PostgreSQL (Railway, `DATABASE_URL`), Redis (`REDIS_URL`, ioredis), Prisma for session + config + analytics.

### Storefront Widget (Cart Pro V3 Runtime)

The widget is a Svelte app bundled separately, mounted in an **open shadow DOM** on the merchant storefront.

Entry: `cart-pro-v3-runtime/src/main.ts` → imports `mountCartProV3()` from `mount.ts`.

`mount.ts` responsibilities:
1. Finds/creates the host element (`#cart-pro-root` or `#revstack-v3-root`)
2. Bootstraps config from `window.__CART_PRO_SNAPSHOT__` or `sessionStorage`
3. Applies CSS variables (`--cp-primary`, `--cp-accent`, `--cp-radius`) on the host
4. Attaches shadow DOM, injects component CSS, mounts `App.svelte`

`engine/Engine.ts` is the central controller: Svelte store for state, event bus, effect queue, cart API calls, analytics batching, gift/upsell/rewards logic, AI recommendations. It is a singleton (`getEngine()` in mount.ts). UI components only receive the `engine` prop and subscribe to its store.

### Decision Engine Package

`packages/decision-engine/src/decideCartActions.ts` is pure logic: takes `{ cart, catalog, storeMetrics, strategy }` and returns `{ crossSell, freeShippingRemaining, suppressCheckout }`. No hardcoded thresholds — all come from `storeMetrics` (baselineAOV, freeShippingThreshold).

### Local Development

The app URL is fixed at `https://app.revenity.io` (Partner Dashboard configured, `automatically_update_urls_on_dev = false` in toml). You need a Cloudflare named tunnel forwarding `app.revenity.io → http://localhost:3000` running before `npm run dev`.

For the decision endpoint in development, set `DEV_SKIP_PROXY=1` to bypass proxy signature verification (used by `npm run load:test`).
