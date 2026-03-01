/**
 * Re-exports pure formatting utilities for server-only usage.
 * Routes should import from ~/lib/format (not .server) to avoid client/server separation errors.
 */
export { formatCurrency, formatUplift } from "./format";
