/**
 * Re-export prisma singleton. Use "~/lib/prisma.server" for direct imports.
 * Kept for backwards compatibility with shopify.server and any legacy imports.
 *
 * Production uses Railway Postgres. Set DATABASE_URL from your Railway project
 * dashboard. Railway provides connection pooling by default.
 */
export { prisma } from "~/lib/prisma.server";
