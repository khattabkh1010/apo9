import { createServer, type Server } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import path from "node:path";
import type { Db } from "../../../packages/db/src/pg.ts";
import { Router, send } from "./http/router.ts";
import { createAppContext, type AppContext } from "./context.ts";
import { config } from "./config.ts";
import { identityRoutes, makeAuthenticator } from "./modules/identity.ts";
import { catalogRoutes } from "./modules/catalog.ts";
import { orderRoutes } from "./modules/orders.ts";
import { restaurantRoutes } from "./modules/restaurant.ts";
import { courierRoutes } from "./modules/courier.ts";
import { adminRoutes } from "./modules/admin.ts";
import { logisticsRoutes } from "./modules/logistics.ts";
import { creatorRoutes } from "./modules/creator.ts";
import { plusRoutes } from "./modules/plus.ts";
import { paymentRoutes } from "./modules/payments.ts";
import { onboardingRoutes } from "./modules/onboarding.ts";
import { openApiDocument } from "./openapi/spec.ts";
import { securityHeaders } from "./security/http.ts";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp", ".mp4": "video/mp4", ".woff2": "font/woff2", ".ico": "image/x-icon", ".webmanifest": "application/manifest+json",
};

/** Serve a file with Range support (needed for video seeking on iOS Safari). */
function serveFile(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse, file: string, cache: string) {
  const st = statSync(file);
  const type = MIME[path.extname(file)] ?? "application/octet-stream";
  const range = req.headers.range;
  if (range && type === "video/mp4") {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    const start = m?.[1] ? Number(m[1]) : 0;
    const end = m?.[2] ? Number(m[2]) : st.size - 1;
    res.writeHead(206, { "content-type": type, "content-range": `bytes ${start}-${end}/${st.size}`, "accept-ranges": "bytes", "content-length": end - start + 1, "cache-control": cache });
    createReadStream(file, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, { "content-type": type, "content-length": st.size, "cache-control": cache, ...(type === "video/mp4" ? { "accept-ranges": "bytes" } : {}) });
  createReadStream(file).pipe(res);
}

export function buildApp(db: Db, overrides: Partial<AppContext> = {}): { app: AppContext; server: Server; router: Router } {
  const app = createAppContext(db, overrides);
  const router = new Router();
  router.authenticate = makeAuthenticator(app);
  router.limiter = app.limiter;
  router.trustProxy = config.trustProxy;
  router.secureCookies = config.secureCookies;

  router.get("/healthz", async () => {
    await app.db.query("select 1");
    return { ok: true, payments: app.payments.name, sms: app.sms.name, routing: app.routing.constructor.name };
  });
  router.get("/api/openapi.json", () => openApiDocument(router));

  identityRoutes(router, app);
  catalogRoutes(router, app);
  orderRoutes(router, app);
  restaurantRoutes(router, app);
  courierRoutes(router, app);
  adminRoutes(router, app);
  logisticsRoutes(router, app);
  creatorRoutes(router, app);
  plusRoutes(router, app);
  paymentRoutes(router, app);
  onboardingRoutes(router, app);

  const server = createServer(async (req, res) => {
    securityHeaders(res, config.isProd);
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (url.pathname.startsWith("/api/") || url.pathname === "/healthz") {
        if (await router.handle(req, res, url)) return;
        return send(res, 404, { error: { code: "route_not_found" } });
      }
      if (url.pathname.startsWith("/media/")) {
        const file = path.join(config.mediaDir, path.basename(url.pathname));
        if (existsSync(file)) return serveFile(req, res, file, "public, max-age=86400");
        return send(res, 404, { error: { code: "media_not_found" } });
      }
      // Static web apps (single build, role-specific entry pages). SPA fallback per app.
      const safe = path.normalize(url.pathname).replace(/^(\.\.[/\\])+/, "");
      let file = path.join(config.webDist, safe);
      if (!file.startsWith(config.webDist)) return send(res, 403, { error: { code: "forbidden" } });
      if (existsSync(file) && statSync(file).isFile()) return serveFile(req, res, file, safe.includes("/assets/") ? "public, max-age=31536000, immutable" : "no-cache");
      const appName = safe.split("/")[1] || "customer";
      file = path.join(config.webDist, ["customer", "courier", "restaurant", "logistics", "creator", "admin"].includes(appName) ? `${appName}.html` : "customer.html");
      if (existsSync(file)) return serveFile(req, res, file, "no-cache");
      send(res, 404, { error: { code: "web_not_built", message: "run npm run build:web" } });
    } catch (e) {
      send(res, 500, { error: { code: "internal_error", message: String(e) } });
    }
  });
  return { app, server, router };
}
