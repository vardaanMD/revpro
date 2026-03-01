import "@shopify/shopify-app-react-router/adapters/node";
import {
  ApiVersion,
  AppDistribution,
  shopifyApp,
} from "@shopify/shopify-app-react-router/server";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import { prisma } from "~/lib/prisma.server";
import { ENV } from "./lib/env.server";
import { logWarn } from "~/lib/logger.server";
import { normalizeShopDomain, warnIfShopNotCanonical } from "~/lib/shop-domain.server";

const shopify = shopifyApp({
  apiKey: ENV.SHOPIFY_API_KEY,
  apiSecretKey: ENV.SHOPIFY_API_SECRET,
  apiVersion: ApiVersion.October25,
  scopes: process.env.SCOPES?.split(","),
  appUrl: ENV.SHOPIFY_APP_URL,
  authPathPrefix: "/auth",
  sessionStorage: new PrismaSessionStorage(prisma),
  distribution: AppDistribution.AppStore,
  future: {
    expiringOfflineAccessTokens: true,
  },
  ...(process.env.SHOP_CUSTOM_DOMAIN
    ? { customShopDomains: [process.env.SHOP_CUSTOM_DOMAIN] }
    : {}),
  hooks: {
    afterAuth: async ({ session }) => {
      const rawShop = session.shop;
      const shop = normalizeShopDomain(rawShop);
      warnIfShopNotCanonical(rawShop, shop);
      console.log("[CATALOG WARM] afterAuth warm start:", shop);
      if (process.env.NODE_ENV === "development") {
        // Session persisted by library; log only in dev
        console.log("[afterAuth] Session persisted for shop:", shop);
      }
      try {
        const { warmCatalogForShop } = await import("~/lib/catalog-warm.server");
        await warmCatalogForShop(shop);
      } catch (err) {
        logWarn({
          shop,
          message: "afterAuth: catalog warm failed",
          meta: { error: err instanceof Error ? err.message : String(err) },
        });
      }
    },
  },
});

export default shopify;
export const apiVersion = ApiVersion.October25;
export const addDocumentResponseHeaders = shopify.addDocumentResponseHeaders;
export const authenticate = shopify.authenticate;
export const unauthenticated = shopify.unauthenticated;
export const login = shopify.login;
export const registerWebhooks = shopify.registerWebhooks;
export const sessionStorage = shopify.sessionStorage;
