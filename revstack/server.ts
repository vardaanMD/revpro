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
import morgan from "morgan";
import { createRequestListener } from "@mjackson/node-fetch-server";
import type { ServerBuild } from "react-router";
import { createRequestHandler } from "@react-router/express";
import { requestContext } from "./app/lib/request-context.server";
import { runAppAuth } from "./app/run-app-auth.server";
import { getRedis } from "./app/lib/redis.server";
import { prisma } from "./app/lib/prisma.server";
import { logResilience } from "./app/lib/logger.server";
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
  console.log("SERVER BOOT START", Date.now());
  let firstRequestHandled = false;
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

  console.log("Process argv:", process.argv);

  const buildModule = await import(pathToFileURL(BUILD_PATH).href);
  const mode = process.env.NODE_ENV || "production";

  const port = Number(process.env.PORT ?? 3000);
  const app = express();
  app.disable("x-powered-by");
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
  app.use(morgan("tiny"));

  app.get("/health-direct", (_req: ExpressRequest, res: ExpressResponse) => {
    console.log("health-direct hit");
    res.status(200).json({ ok: true });
  });

  if (isRSCBuild(buildModule)) {
    console.log("[revstack] build path: RSC (createRequestListener)");
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
    app.use(
      (req: ExpressRequest, res: ExpressResponse, next: NextFunction) => {
        if (!firstRequestHandled) {
          firstRequestHandled = true;
          console.log("FIRST REQUEST HANDLED", Date.now());
        }
        console.log("app.all reached:", req.method, req.url);
        next();
      },
      createRequestListener(wrappedFetch)
    );
  } else {
    console.log("[revstack] build path: non-RSC (createRequestHandler)");
    app.use((req: ExpressRequest, res: ExpressResponse, next: NextFunction) => {
      const pathname = req.path || (req.url && req.url.split("?")[0]) || "";
      const requestId = crypto.randomUUID();
      requestContext.run({ requestId }, () => {
        if (pathname.startsWith("/app")) {
          const request = toRequest(req);
          runAppAuth(request)
            .then((redirect) => {
              if (redirect) {
                res.status(redirect.status);
                redirect.headers.forEach((v, k) => res.setHeader(k, v));
                redirect.text().then((body) => res.end(body)).catch(next);
              } else next();
            })
            .catch(next);
        } else next();
      });
    });
    app.use(
      (req: ExpressRequest, res: ExpressResponse, next: NextFunction) => {
        if (!firstRequestHandled) {
          firstRequestHandled = true;
          console.log("FIRST REQUEST HANDLED", Date.now());
        }
        console.log("app.all reached:", req.method, req.url);
        next();
      },
      createRequestHandler({ build: buildModule as unknown as ServerBuild, mode })
    );
  }

  // Cold start mitigation: warm Redis so first request doesn't pay connection cost.
  try {
    const redis = getRedis();
    redis.ping().catch(() => {});
  } catch {
    // REDIS_URL missing or connect failed
  }

  // Prisma: ensure connection is established before listening (retry loop).
  let connected = false;
  let attempts = 0;
  while (!connected && attempts < 10) {
    try {
      console.log("[PRISMA] Connecting attempt", attempts + 1);
      await prisma.$queryRaw`SELECT 1`;
      connected = true;
      console.log("[PRISMA] Connected");
    } catch (e) {
      attempts++;
      console.log("[PRISMA] Failed attempt", attempts, (e as { code?: string })?.code);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  if (!connected) {
    console.error("[PRISMA] Failed to connect after retries");
    process.exit(1);
  }

  console.log("SERVER LISTEN START", Date.now());
  const server = app.listen(port, "0.0.0.0", () => {
    console.log("SERVER LISTEN READY", Date.now());
    console.log("ENV PORT:", process.env.PORT);
    console.log("Listening on:", server.address());
    console.log(`[revstack] listening on port ${port}`);
  });
  ["SIGTERM", "SIGINT"].forEach((signal) => {
    process.once(signal, () => server?.close(console.error));
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
