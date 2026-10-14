import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { ZodError, type ZodType } from "zod";
import { PgError } from "../../../../packages/db/src/pg.ts";
import { log } from "../log.ts";
import { RATE_RULES, SESSION_COOKIE, CSRF_COOKIE, appendSetCookie, parseCookies, serializeCookie, type RateLimiter } from "../security/http.ts";

export class ApiError extends Error {
  status: number;
  code: string;
  details: unknown;
  constructor(status: number, code: string, message?: string, details?: unknown) {
    super(message ?? code);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (code: string, msg?: string, details?: unknown) => new ApiError(400, code, msg, details);
export const notFound = (what = "resource") => new ApiError(404, "not_found", `${what} not found`);
export const forbidden = (code = "forbidden", msg?: string) => new ApiError(403, code, msg);
export const conflict = (code: string, msg?: string, details?: unknown) => new ApiError(409, code, msg, details);
export const unauthorized = () => new ApiError(401, "unauthorized", "authentication required");

export interface Principal {
  userId: string;
  sessionId: string;
  roles: Array<{ role: string; scopeType: string; scopeId: string }>;
  /** How the session token arrived. Cookie sessions must pass CSRF on unsafe methods. */
  via?: "bearer" | "cookie";
  csrfOk?: boolean;
  /** Staff sessions must be MFA-verified before global (staff) permissions apply. */
  mfa?: { required: boolean; verified: boolean };
}

export interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  params: Record<string, string>;
  query: URLSearchParams;
  requestId: string;
  ip: string;
  principal: Principal | null;
  /** Parsed + validated JSON body. */
  body<T>(schema: ZodType<T>): Promise<T>;
  rawBody(): Promise<Buffer>;
  /** Set when the response is a stream and the handler wrote it directly. */
  handled?: boolean;
}

export type Handler = (ctx: Ctx) => Promise<unknown> | unknown;

interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  handler: Handler;
  path: string;
}

const MAX_BODY = 1_000_000;

export class Router {
  routes: Route[] = [];
  authenticate: ((req: IncomingMessage) => Promise<Principal | null>) | null = null;
  limiter: RateLimiter | null = null;
  trustProxy = false;
  secureCookies = false;

  add(method: string, path: string, handler: Handler): void {
    const keys: string[] = [];
    const pattern = new RegExp(
      "^" + path.replace(/\/:([a-zA-Z_]+)/g, (_, k) => (keys.push(k), "/([^/]+)")).replace(/\//g, "\\/") + "\\/?$",
    );
    this.routes.push({ method, pattern, keys, handler, path });
  }
  get = (p: string, h: Handler) => this.add("GET", p, h);
  post = (p: string, h: Handler) => this.add("POST", p, h);
  patch = (p: string, h: Handler) => this.add("PATCH", p, h);
  put = (p: string, h: Handler) => this.add("PUT", p, h);
  delete = (p: string, h: Handler) => this.add("DELETE", p, h);

  /** Throws 429 when any matching rule for this key is exhausted. */
  rateLimit(by: "ip" | "user", method: string, routePath: string, key: string): void {
    if (!this.limiter) return;
    for (const rule of RATE_RULES) {
      if (rule.by !== by || !rule.match(method, routePath)) continue;
      const retry = this.limiter.hit(`${rule.name}:${key}`, rule.limit, rule.windowSec);
      if (retry > 0) throw new ApiError(429, "rate_limited", "طلبات كثيرة، حاول بعد قليل", { retryAfterSec: retry, rule: rule.name });
    }
  }

  match(method: string, pathname: string): { route: Route; params: Record<string, string> } | null {
    for (const r of this.routes) {
      if (r.method !== method) continue;
      const m = r.pattern.exec(pathname);
      if (!m) continue;
      const params: Record<string, string> = {};
      r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1]!)));
      return { route: r, params };
    }
    return null;
  }

  async handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const found = this.match(req.method ?? "GET", url.pathname);
    if (!found) return false;
    const requestId = (req.headers["x-request-id"] as string) || randomUUID();
    const started = performance.now();
    let bodyBuf: Buffer | null = null;
    const rawBody = async () => {
      if (bodyBuf) return bodyBuf;
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const c of req) {
        size += (c as Buffer).length;
        if (size > MAX_BODY) throw new ApiError(413, "payload_too_large");
        chunks.push(c as Buffer);
      }
      bodyBuf = Buffer.concat(chunks);
      return bodyBuf;
    };
    const ctx: Ctx = {
      req,
      res,
      params: found.params,
      query: url.searchParams,
      requestId,
      ip: clientIp(req, this.trustProxy),
      principal: null,
      rawBody,
      async body<T>(schema: ZodType<T>): Promise<T> {
        const buf = await rawBody();
        let json: unknown = {};
        if (buf.length) {
          try {
            json = JSON.parse(buf.toString("utf8"));
          } catch {
            throw badRequest("invalid_json");
          }
        }
        return schema.parse(json);
      },
    };
    res.setHeader("x-request-id", requestId);
    let status = 200;
    try {
      const method = req.method ?? "GET";
      this.rateLimit("ip", method, found.route.path, ctx.ip);
      ctx.principal = this.authenticate ? await this.authenticate(req) : null;
      if (!ctx.principal && parseCookies(req)[SESSION_COOKIE]) {
        // Stale/revoked cookie: clear it so the web app falls back to the login screen cleanly.
        for (const name of [SESSION_COOKIE, CSRF_COOKIE]) appendSetCookie(res, serializeCookie(name, "", { secure: this.secureCookies, sameSite: "Lax", maxAgeSec: 0 }));
      }
      this.rateLimit("user", method, found.route.path, ctx.principal?.userId ?? `ip:${ctx.ip}`);
      if (ctx.principal?.via === "cookie" && !["GET", "HEAD", "OPTIONS"].includes(method) && !ctx.principal.csrfOk) {
        throw forbidden("csrf_failed", "missing or invalid CSRF token");
      }
      const result = await found.route.handler(ctx);
      if (ctx.handled) return true;
      status = result === undefined ? 204 : 200;
      if (result && typeof result === "object" && "_status" in result) {
        status = (result as { _status: number })._status;
        delete (result as { _status?: number })._status;
      }
      send(res, status, result ?? null);
    } catch (e) {
      const err = toApiError(e);
      status = err.status;
      if (status >= 500) log.error("request_failed", { requestId, path: url.pathname, error: (e as Error).stack ?? String(e) });
      if (status === 429 && err.details && typeof err.details === "object" && "retryAfterSec" in err.details) res.setHeader("retry-after", String((err.details as { retryAfterSec: number }).retryAfterSec));
      send(res, status, { error: { code: err.code, message: err.message, details: err.details, requestId } });
    } finally {
      log.info("request", { requestId, method: req.method, path: found.route.path, status, ms: Math.round(performance.now() - started), user: ctx.principal?.userId });
    }
    return true;
  }
}

function clientIp(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const xff = (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim();
    if (xff) return xff;
  }
  return req.socket.remoteAddress ?? "";
}

function toApiError(e: unknown): ApiError {
  if (e instanceof ApiError) return e;
  if (e instanceof ZodError) return badRequest("validation_failed", "request validation failed", e.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
  if (e instanceof PgError) {
    if (e.code === "23505") return conflict("duplicate", "already exists", { constraint: e.constraint });
    if (e.code === "23514" || e.code === "23503") return badRequest("constraint_violation", e.message, { constraint: e.constraint });
    if (e.code === "42501") return forbidden("immutable", e.message);
  }
  if (e && typeof e === "object" && "code" in e && (e as { code: string }).code === "invalid_transition") return conflict("invalid_transition", (e as unknown as Error).message);
  return new ApiError(500, "internal_error", "unexpected error");
}

export function send(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) return;
  if (status === 204) {
    res.writeHead(204);
    res.end();
    return;
  }
  const json = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(json);
}

/** Mark a handler result with a non-200 status. */
export function withStatus<T extends object>(status: number, body: T): T & { _status: number } {
  return Object.assign(body, { _status: status });
}
