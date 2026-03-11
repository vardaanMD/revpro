/**
 * Structured JSON logger for revstack. Production always emits logs to stdout.
 * Use logInfo/logWarn/logError only; no console.log in production code.
 *
 * LOG_LEVEL: "info" | "warn" | "error" (default: info)
 * Order: info < warn < error — only messages at or above level are logged.
 */

const LEVEL_ORDER: Record<string, number> = { info: 0, warn: 1, error: 2 };

function shouldLog(level: string): boolean {
  const configured = (process.env.LOG_LEVEL || "info").toLowerCase();
  const minOrder = LEVEL_ORDER[configured] ?? 0;
  const msgOrder = LEVEL_ORDER[level] ?? 0;
  return msgOrder >= minOrder;
}

type LogPayload = {
  level: "info" | "warn" | "error";
  timestamp: string;
  requestId: string | null;
  shop: string | null;
  route: string;
  message: string;
  meta?: Record<string, unknown>;
};

type LogSink = (payload: LogPayload) => void;
let _logSink: LogSink | null = null;

/** Register an external sink (e.g. Redis ring buffer). Call from server.ts after Redis is ready. */
export function setLogSink(fn: LogSink): void {
  _logSink = fn;
}


function write(level: "info" | "warn" | "error", params: {
  shop?: string;
  requestId?: string;
  path?: string;
  route?: string;
  message: string;
  meta?: Record<string, unknown>;
}): void {
  if (!shouldLog(level)) return;
  const payload: LogPayload = {
    level,
    timestamp: new Date().toISOString(),
    requestId: params.requestId ?? null,
    shop: params.shop ?? null,
    route: params.route ?? params.path ?? "",
    message: params.message,
    meta: params.meta,
  };
  process.stdout.write(JSON.stringify(payload) + "\n");
  if (_logSink) {
    try { _logSink(payload); } catch { /* never let sink errors affect logging */ }
  }
}

export function logInfo(params: {
  shop?: string;
  requestId?: string;
  path?: string;
  route?: string;
  message: string;
  meta?: Record<string, unknown>;
}): void {
  write("info", params);
}

export function logWarn(params: {
  shop?: string;
  requestId?: string;
  path?: string;
  route?: string;
  message: string;
  meta?: Record<string, unknown>;
}): void {
  write("warn", params);
}

export function logError(params: {
  shop?: string;
  requestId?: string;
  path?: string;
  route?: string;
  message: string;
  meta?: Record<string, unknown>;
}): void {
  write("error", params);
}

/**
 * Log internal errors (e.g. in safe-handler).
 * Never include stack traces in production responses.
 */
export function logInternalError(params: {
  shop?: string;
  requestId?: string;
  path?: string;
  route?: string;
  message: string;
  meta?: Record<string, unknown>;
}): void {
  write("error", params);
}

/**
 * Structured resilience logging: dependency failures, fallbacks, redis hit/miss.
 * Use for Prisma/Redis/Admin API errors. Do NOT log sensitive tokens.
 */
export function logResilience(params: {
  shop?: string;
  requestId?: string;
  route: string;
  message: string;
  meta?: Record<string, unknown> & {
    errorType?: string;
    fallbackUsed?: boolean;
    redisHitMiss?: "hit" | "miss";
    billingState?: string;
    decisionOutcome?: string;
    stack?: string;
  };
}): void {
  write("warn", params);
}
