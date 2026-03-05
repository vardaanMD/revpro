# Reset database for “new install” testing

Use this when you want to clear all app data and test as if the app was just installed. Your DB and app run on Railway; you can run SQL in Railway’s Postgres console.

## Option 1: Run SQL in Railway (recommended)

1. In **Railway** → your project → **Postgres** service → **Data** (or **Query**).
2. Open a SQL tab and run the script below.

This truncates all RevPRO app tables (data only; tables and schema stay). Order uses `CASCADE` so dependent rows are cleared. `RESTART IDENTITY` resets any auto-increment/sequence counters.

```sql
-- RevPRO: reset all app data (new-install simulation)
-- Run in Railway Postgres console. Schema is unchanged.

TRUNCATE TABLE "Session" RESTART IDENTITY CASCADE;
TRUNCATE TABLE "ShopConfig" RESTART IDENTITY CASCADE;
TRUNCATE TABLE "WebhookEvent" RESTART IDENTITY CASCADE;
TRUNCATE TABLE "DecisionMetric" RESTART IDENTITY CASCADE;
TRUNCATE TABLE "CrossSellEvent" RESTART IDENTITY CASCADE;
TRUNCATE TABLE "CrossSellConversion" RESTART IDENTITY CASCADE;
TRUNCATE TABLE "CartProEventV3" RESTART IDENTITY CASCADE;
TRUNCATE TABLE "ProductSaleEvent" RESTART IDENTITY CASCADE;
TRUNCATE TABLE "RevproClickSession" RESTART IDENTITY CASCADE;
TRUNCATE TABLE "OrderInfluenceEvent" RESTART IDENTITY CASCADE;
TRUNCATE TABLE "ShopProduct" RESTART IDENTITY CASCADE;
```

After this:

- No shops, no sessions, no analytics, no catalog.
- Re-open the app from the Shopify admin (or reinstall the app) to go through install/onboarding again.

## Option 2: Reset only one shop

To clear data for a single shop (e.g. `your-store.myshopify.com`) and keep others:

```sql
-- Replace 'your-store.myshopify.com' with the shop domain
DELETE FROM "Session" WHERE shop = 'your-store.myshopify.com';
DELETE FROM "ShopConfig" WHERE "shopDomain" = 'your-store.myshopify.com';
DELETE FROM "WebhookEvent" WHERE "shopDomain" = 'your-store.myshopify.com';
DELETE FROM "DecisionMetric" WHERE "shopDomain" = 'your-store.myshopify.com';
DELETE FROM "CrossSellEvent" WHERE "shopDomain" = 'your-store.myshopify.com';
DELETE FROM "CrossSellConversion" WHERE "shopDomain" = 'your-store.myshopify.com';
DELETE FROM "CartProEventV3" WHERE shop = 'your-store.myshopify.com';
DELETE FROM "ProductSaleEvent" WHERE "shopDomain" = 'your-store.myshopify.com';
DELETE FROM "RevproClickSession" WHERE "shopDomain" = 'your-store.myshopify.com';
DELETE FROM "OrderInfluenceEvent" WHERE "shopDomain" = 'your-store.myshopify.com';
DELETE FROM "ShopProduct" WHERE "shopDomain" = 'your-store.myshopify.com';
```

Then open the app again for that store; you may need to re-authenticate.

## Option 3: Prisma migrate reset (from your machine)

If you have `DATABASE_URL` pointing at the Railway Postgres (e.g. in `.env`):

```bash
cd revstack
npm run migrate:dev -- --force
# or
npx prisma migrate reset --force
```

This **drops the database**, reapplies all migrations, and runs seed if configured. Use only if you want a full schema + data reset and can run migrations against Railway from your machine.
