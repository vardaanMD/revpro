import { PrismaClient } from "@prisma/client";

declare global {
  var prisma: PrismaClient | undefined;
}

/**
 * Multi-tenant guarantee:
 * All application read queries MUST include shopDomain scoping.
 * Only cleanup jobs may intentionally operate globally.
 */

// SINGLE PrismaClient per process. Do not instantiate elsewhere.
export const prisma =
  global.prisma ??
  new PrismaClient({
    log:
      process.env.NODE_ENV === "development"
        ? ["error", "warn"]
        : ["error"],
  });

if (process.env.NODE_ENV !== "production") {
  global.prisma = prisma;
}

console.log("[CATALOG WARM TRACE] Prisma initialized");
if (process.env.NODE_ENV === "development") {
  console.log("[prisma] client initialized once");
}
