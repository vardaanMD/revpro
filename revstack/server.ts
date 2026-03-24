/**
 * Custom server: runs requestContext.run for every request and, for GET /app/*,
 * runs authenticate.admin + getShopConfig once before React Router loaders,
 * then sets appLayout in context. This ensures single auth and single getShopConfig
 * per /app document request.
 *
 * Usage: npx tsx server.ts   (or npm run start which runs this)
 * Requires: build to exist (npm run build first).
 */
/// <reference types="node" />
import "dotenv/config";
import path from "node:path";
import { pathToFileURL } from "node:url";
import express, { type Request as ExpressRequest, type Response as ExpressResponse, type NextFunction } from "express";
import compression from "compression";
import helmet from "helmet";
import morgan from "morgan";
import { createRequestListener } from "@mjackson/node-fetch-server";
import type { ServerBuild } from "react-router";
import { createRequestHandler } from "@react-router/express";
import { requestContext } from "./app/lib/request-context.server";
import { runAppAuth } from "./app/run-app-auth.server";
import { getRedis } from "./app/lib/redis.server";
import { prisma } from "./app/lib/prisma.server";
import { clearShopConfigCacheForShop } from "./app/lib/shop-config.server";
import { logResilience, setLogSink } from "./app/lib/logger.server";
import { AdminApi401Error } from "./app/lib/admin-api-errors.server";

const BUILD_PATH = path.resolve(process.cwd(), "build/server/index.js");
const assetsBuildDirectory = path.resolve(path.dirname(BUILD_PATH), "../client");
const publicPath = "/";

function isRSCBuild(mod: unknown): mod is { default: { fetch: (req: Request) => Promise<Response> } } {
  return (
    typeof mod === "object" &&
    mod !== null &&
    "default" in mod &&
    typeof (mod as { default: unknown }).default === "object" &&
    (mod as { default: { fetch?: unknown } }).default !== null &&
    "fetch" in (mod as { default: object }).default &&
    typeof (mod as { default: { fetch: unknown } }).default.fetch === "function"
  );
}

/** Build a web Request from Express req for runAppAuth. */
function toRequest(req: express.Request): Request {
  const protocol = req.protocol || "http";
  const host = req.get("host") || "localhost";
  const url = `${protocol}://${host}${req.originalUrl || req.url || "/"}`;
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v !== undefined && typeof v === "string") headers.set(k, v);
    else if (Array.isArray(v)) v.forEach((s) => headers.set(k, s));
  }
  return new Request(url, { method: req.method, headers });
}

async function main() {
  process.on("unhandledRejection", (reason: unknown) => {
    logResilience({
      route: "runtime",
      message: "Unhandled promise rejection",
      meta: {
        errorType: "UnhandledRejection",
        reason: reason instanceof Error ? reason.message : String(reason),
        stack: reason instanceof Error ? reason.stack : undefined,
      },
    });
  });

  const buildModule = await import(pathToFileURL(BUILD_PATH).href);
  const mode = process.env.NODE_ENV || "production";

  const port = Number(process.env.PORT ?? 3000);
  const app = express();
  app.disable("x-powered-by");
  app.use(helmet({ contentSecurityPolicy: false })); // CSP conflicts with Shopify embedded app
  app.use(compression());
  app.use(
    path.posix.join(publicPath, "assets"),
    express.static(path.join(assetsBuildDirectory, "assets"), { immutable: true, maxAge: "1y" })
  );
  app.use(publicPath, express.static(assetsBuildDirectory));
  app.use(express.static("public", { maxAge: "1h" }));
  // Cart Pro V3 runtime script for admin preview iframe (settings V3 preview)
  app.use(
    "/extensions-assets",
    express.static(path.join(process.cwd(), "extensions/cart-pro/assets"), { maxAge: "1h" })
  );
  // Body parsing: skip for /cart/* so React Router actions can read the raw body (request.arrayBuffer()).
  // express.json() consumes the stream once; cart.decision and cart.analytics.v3 would then get empty body → 400.
  app.use((req: ExpressRequest, res: ExpressResponse, next: NextFunction) => {
    const pathname = req.path || (req.url && req.url.split("?")[0]) || "";
    if (pathname.startsWith("/cart/") || pathname === "/api/seed-catalog") {
      return next();
    }
    express.json({ limit: "1mb" })(req, res, (err?: unknown) => {
      if (err) return next(err);
      express.urlencoded({ limit: "1mb", extended: false })(req, res, next);
    });
  });
  app.use(morgan("tiny"));

  app.get("/health-direct", (_req: ExpressRequest, res: ExpressResponse) => {
    res.status(200).json({ ok: true });
  });

  // Diagnostic: verify which server received the request (for "app failed to respond" debugging).
  // Shopify loads the app from the URL in Partner Dashboard → Configuration → App URL.
  // If that URL points here, requests will hit this endpoint. Use: curl https://<your-app-url>/api/app-ping
  app.get("/api/app-ping", (req: ExpressRequest, res: ExpressResponse) => {
    const appUrl = (process.env.SHOPIFY_APP_URL || process.env.HOST || "").trim();
    let appUrlHost = "";
    try {
      if (appUrl) appUrlHost = new URL(appUrl.startsWith("http") ? appUrl : `https://${appUrl}`).hostname;
    } catch {
      appUrlHost = "(invalid)";
    }
    res.status(200).json({
      ok: true,
      receivedAt: new Date().toISOString(),
      appUrlHost: appUrlHost || "(not set)",
      note: "If Shopify shows 'application failed to respond', ensure Partner Dashboard App URL matches where this server is reachable (e.g. tunnel URL for local dev).",
    });
  });

  if (isRSCBuild(buildModule)) {
    const originalFetch = buildModule.default.fetch;
    const wrappedFetch = async (request: Request): Promise<Response> => {
      const requestId = crypto.randomUUID();
      return requestContext.run({ requestId }, async () => {
        const pathname = new URL(request.url).pathname;
        if (pathname.startsWith("/app")) {
          const redirectResponse = await runAppAuth(request);
          if (redirectResponse) return redirectResponse;
        }
        try {
          return await originalFetch(request);
        } catch (e) {
          if (e instanceof AdminApi401Error) {
            const url = new URL(request.url);
            if (url.pathname.startsWith("/auth")) throw e;
            const search = url.searchParams.toString();
            const location = search ? `/auth/login?${search}` : "/auth/login";
            return new Response(null, { status: 302, headers: { Location: location } });
          }
          throw e;
        }
      });
    };
    app.use(createRequestListener(wrappedFetch));
  } else {
    app.use(async (req: ExpressRequest, res: ExpressResponse, next: NextFunction) => {
      const pathname = req.path || (req.url && req.url.split("?")[0]) || "";
      const requestId = crypto.randomUUID();
      try {
        await requestContext.run({ requestId }, async () => {
          if (pathname.startsWith("/app")) {
            const request = toRequest(req);
            const redirect = await runAppAuth(request);
            if (redirect) {
              res.status(redirect.status);
              redirect.headers.forEach((v, k) => res.setHeader(k, v));
              const body = await redirect.text();
              res.end(body);
              return;
            }
          }
          next();
        });
      } catch (err) {
        next(err);
      }
    });
    app.use(createRequestHandler({ build: buildModule as unknown as ServerBuild, mode }));
  }

  // Cold start mitigation: warm Redis so first request doesn't pay connection cost.
  // Also register log sink to buffer logs into a Redis ring buffer for the log viewer.
  // Subscribe to config invalidation so all replicas clear local cache when one invalidates.
  try {
    const redis = getRedis();
    redis.ping().catch(() => {});

    const LOG_KEY = "revstack:logs:stream";
    const LOG_MAX = 1000;
    let redisLogFailCount = 0;
    let redisLogCircuitOpenUntil = 0;
    const CIRCUIT_THRESHOLD = 3;
    const CIRCUIT_COOLDOWN_MS = 60_000;
    setLogSink((payload) => {
      if (Date.now() < redisLogCircuitOpenUntil) return;
      const str = JSON.stringify(payload);
      redis
        .pipeline()
        .lpush(LOG_KEY, str)
        .ltrim(LOG_KEY, 0, LOG_MAX - 1)
        .exec()
        .then(() => {
          redisLogFailCount = 0;
        })
        .catch(() => {
          redisLogFailCount += 1;
          if (redisLogFailCount >= CIRCUIT_THRESHOLD) {
            redisLogCircuitOpenUntil = Date.now() + CIRCUIT_COOLDOWN_MS;
          }
        });
    });

    // Subscriber must use a separate connection (Redis subscriber mode allows only sub commands).
    const CONFIG_INVALIDATE_CHANNEL = "revstack:config:invalidate";
    const sub = redis.duplicate();
    sub.subscribe(CONFIG_INVALIDATE_CHANNEL);
    sub.on("message", (channel: string, message: string) => {
      if (channel === CONFIG_INVALIDATE_CHANNEL) {
        clearShopConfigCacheForShop(message);
      }
    });
  } catch {
    // REDIS_URL missing or connect failed — log sink simply stays null
  }

  // Prisma: ensure connection is established before listening (avoids race conditions where
  // /app/* or auth runs before DB is ready). Then listen.
  let connected = false;
  let attempts = 0;
  while (!connected && attempts < 10) {
    try {
      await prisma.$queryRaw`SELECT 1`;
      connected = true;
    } catch (e) {
      attempts++;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  if (!connected) {
    console.error("[PRISMA] Failed to connect after retries");
    process.exit(1);
  }

  const server = app.listen(port, "0.0.0.0", () => {});
  ["SIGTERM", "SIGINT"].forEach((signal) => {
    process.once(signal, () => {
      server.close(async () => {
        try { await prisma.$disconnect(); } catch {}
        try { getRedis().quit(); } catch {}
        process.exit(0);
      });
      // Force exit after 5s if graceful shutdown stalls
      setTimeout(() => process.exit(1), 5000).unref();
    });
  });

  process.on("uncaughtException", (err) => {
    console.error("[FATAL] uncaughtException:", err);
    process.exit(1);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
