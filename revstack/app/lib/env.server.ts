import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

// Load .env from app root (revstack) so it works when running from monorepo root or via shopify app dev
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, "..", "..");
dotenv.config({ path: path.join(appRoot, ".env"), override: false });

const REQUIRED_DEV = ["DATABASE_URL", "SHOPIFY_API_KEY", "SHOPIFY_API_SECRET"] as const;
const REQUIRED_PROD = [...REQUIRED_DEV, "REDIS_URL"] as const;

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
}

// App URL is set by Shopify CLI on `shopify app dev` (changes each run). Never require in .env for dev.
const appUrlRaw =
  (process.env.SHOPIFY_APP_URL ?? process.env.HOST ?? "").trim();
const devFallback =
  process.env.NODE_ENV === "development"
    ? `http://localhost:${process.env.PORT || 3000}`
    : "";

export const ENV = {
  DATABASE_URL: requireEnv("DATABASE_URL"),
  REDIS_URL: process.env.REDIS_URL,
  SHOPIFY_API_KEY: requireEnv("SHOPIFY_API_KEY"),
  SHOPIFY_API_SECRET: requireEnv("SHOPIFY_API_SECRET"),
  SHOPIFY_APP_URL: appUrlRaw || devFallback || requireEnv("SHOPIFY_APP_URL"),
};
