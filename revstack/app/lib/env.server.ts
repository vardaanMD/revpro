import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

// Load .env from app root (revstack) so it works when running from monorepo root or via shopify app dev
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, "..", "..");
dotenv.config({ path: path.join(appRoot, ".env"), override: false });

const REQUIRED_DEV = ["DATABASE_URL", "SHOPIFY_API_KEY", "SHOPIFY_API_SECRET"] as const;
const REQUIRED_PROD = [...REQUIRED_DEV, "REDIS_URL", "SHOPIFY_APP_URL"] as const;

function requireEnv(name: string): string {
  const value = process.env[name];
  const trimmed = typeof value === "string" ? value.trim() : value;
  if (!trimmed) {
    const required =
      process.env.NODE_ENV === "production" ? REQUIRED_PROD : REQUIRED_DEV;
    const missing = required.filter((k) => !(process.env[k] ?? "").trim());
    const hint =
      missing.length > 0
        ? `\n\nMissing: ${missing.join(", ")}. Add them to .env (see .env.example). For local dev, run \`shopify app dev\` to inject Shopify vars, or copy Client credentials from Partners → Your app → App setup.`
        : "";
    throw new Error(`Missing required environment variable: ${name}${hint}`);
  }
  return trimmed;
}

if (process.env.NODE_ENV === "production") {
  requireEnv("REDIS_URL");
  requireEnv("SHOPIFY_APP_URL");
  if (process.env.CART_PRO_DEBUG === "1") {
    console.warn("[env] WARNING: CART_PRO_DEBUG is set in production — debug output is disabled but remove this env var");
  }
}

// App URL: required in production; in dev use env or fallback to localhost.
const appUrlRaw =
  (process.env.SHOPIFY_APP_URL ?? process.env.HOST ?? process.env.RAILWAY_PUBLIC_DOMAIN ?? "").trim();
const devFallback =
  process.env.NODE_ENV === "development"
    ? `http://localhost:${process.env.PORT || 3000}`
    : "";

/** Ensure value is a valid URL; if it's a bare hostname (e.g. from Railway), add https:// so Shopify SDK accepts it. */
function normalizeAppUrl(value: string): string {
  if (!value) return value;
  const trimmed = value.trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  const scheme = process.env.NODE_ENV === "development" ? "http" : "https";
  return `${scheme}://${trimmed}`;
}

const appUrlResolved = appUrlRaw || devFallback || "";

export const ENV = {
  DATABASE_URL: requireEnv("DATABASE_URL"),
  REDIS_URL: process.env.REDIS_URL,
  SHOPIFY_API_KEY: requireEnv("SHOPIFY_API_KEY"),
  SHOPIFY_API_SECRET: requireEnv("SHOPIFY_API_SECRET"),
  SHOPIFY_APP_URL: normalizeAppUrl(appUrlResolved),
};
