/**
 * HTTP security primitives: cookies, CSRF (double-submit bound to the session token),
 * in-process rate limiting and response security headers.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

export const SESSION_COOKIE = "abu9_session";
export const CSRF_COOKIE = "abu9_csrf";
export const CSRF_HEADER = "x-csrf-token";

export function parseCookies(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (k && !(k in out)) out[k] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

interface CookieOpts {
  httpOnly?: boolean;
  secure: boolean;
  sameSite: "Strict" | "Lax";
  maxAgeSec: number;
  path?: string;
}

export function serializeCookie(name: string, value: string, o: CookieOpts): string {
  return [
    `${name}=${encodeURIComponent(value)}`,
    `Path=${o.path ?? "/"}`,
    `Max-Age=${o.maxAgeSec}`,
    `SameSite=${o.sameSite}`,
    ...(o.httpOnly ? ["HttpOnly"] : []),
    ...(o.secure ? ["Secure"] : []),
  ].join("; ");
}

export function appendSetCookie(res: ServerResponse, cookie: string) {
  const prev = res.getHeader("set-cookie");
  res.setHeader("set-cookie", [...(Array.isArray(prev) ? prev : prev ? [String(prev)] : []), cookie]);
}

/** The CSRF token is derived from the (secret) session token: unforgeable without it, no server state. */
export const csrfFor = (sessionToken: string) => createHash("sha256").update(`csrf:${sessionToken}`).digest("base64url");

export function csrfValid(sessionToken: string, header: string | undefined): boolean {
  if (!header) return false;
  const a = Buffer.from(csrfFor(sessionToken));
  const b = Buffer.from(header);
  return a.length === b.length && timingSafeEqual(a, b);
}

// ── rate limiting (fixed window, in-process) ──
// One API instance at launch; with several instances move the counters to Redis (same interface).
export class RateLimiter {
  private hits = new Map<string, { n: number; resetAt: number }>();
  private sweepAt = 0;

  /** Returns seconds until retry when the limit is exceeded, otherwise 0. */
  hit(key: string, limit: number, windowSec: number, now = Date.now()): number {
    if (now > this.sweepAt) {
      for (const [k, v] of this.hits) if (v.resetAt <= now) this.hits.delete(k);
      this.sweepAt = now + 60_000;
    }
    let e = this.hits.get(key);
    if (!e || e.resetAt <= now) {
      e = { n: 0, resetAt: now + windowSec * 1000 };
      this.hits.set(key, e);
    }
    e.n++;
    return e.n > limit ? Math.ceil((e.resetAt - now) / 1000) : 0;
  }

  reset() {
    this.hits.clear();
  }
}

export interface RateRule {
  /** Route path pattern prefix or exact path (as registered on the router). */
  match: (method: string, routePath: string) => boolean;
  limit: number;
  windowSec: number;
  by: "ip" | "user";
  name: string;
}

export const RATE_RULES: RateRule[] = [
  { name: "otp_request_ip", match: (m, p) => m === "POST" && p === "/api/v1/auth/otp/request", limit: 20, windowSec: 600, by: "ip" },
  { name: "otp_verify_ip", match: (m, p) => m === "POST" && p === "/api/v1/auth/otp/verify", limit: 40, windowSec: 600, by: "ip" },
  { name: "mfa_user", match: (m, p) => m === "POST" && p.startsWith("/api/v1/auth/mfa/"), limit: 10, windowSec: 300, by: "user" },
  { name: "checkout_user", match: (m, p) => m === "POST" && (p === "/api/v1/orders" || p === "/api/v1/checkout/quote"), limit: 60, windowSec: 60, by: "user" },
  { name: "writes_user", match: (m) => m !== "GET", limit: 300, windowSec: 60, by: "user" },
  { name: "all_ip", match: () => true, limit: 1200, windowSec: 60, by: "ip" },
];

// ── headers ──
export const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  // React sets style via the CSSOM (allowed); attribute styles from markup are not used.
  "style-src-attr 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

export function securityHeaders(res: ServerResponse, isProd: boolean) {
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("referrer-policy", "strict-origin-when-cross-origin");
  res.setHeader("x-frame-options", "DENY");
  res.setHeader("content-security-policy", CSP);
  res.setHeader("permissions-policy", "camera=(), microphone=(), geolocation=(self), payment=(self)");
  res.setHeader("cross-origin-opener-policy", "same-origin");
  if (isProd) res.setHeader("strict-transport-security", "max-age=31536000; includeSubDomains");
}
