/**
 * Security controls against a real database: staff MFA gate, TOTP replay protection,
 * cookie sessions + CSRF, rate limiting, security headers.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startTestServer, Client, DEMO_PHONES, type TestServer } from "./helpers.ts";
import { base32Encode, currentStep, totpAt, verifyTotp, seal, unseal } from "../src/security/totp.ts";

let s: TestServer;
before(async () => {
  s = await startTestServer();
});
after(() => s.close());

test("TOTP matches the RFC 6238 SHA-1 vector and sealing round-trips", () => {
  const secret = base32Encode(Buffer.from("12345678901234567890"));
  assert.equal(secret, "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
  assert.equal(totpAt(secret, 1), "287082"); // T = 59 s → 94287082 (8 digits)
  assert.equal(totpAt(secret, Math.floor(1111111109 / 30)), "081804");
  assert.equal(verifyTotp(secret, totpAt(secret, currentStep()), Date.now()), currentStep());
  assert.equal(verifyTotp(secret, "12345"), null);
  const sealed = seal(secret, "k1");
  assert.equal(unseal(sealed, "k1"), secret);
  assert.throws(() => unseal(sealed, "wrong-key"));
});

/** Log in without completing MFA (the helper normally completes it). */
async function rawLogin(phone: string, transport: "token" | "cookie" = "token") {
  const c = new Client(s.base);
  const r1 = await c.post("/api/v1/auth/otp/request", { phone });
  const r2 = await fetch(s.base + "/api/v1/auth/otp/verify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ challengeId: r1.body.challengeId, code: r1.body.devCode, transport }),
  });
  return { c, res: r2, body: await r2.json() };
}

test("staff permissions require MFA; codes cannot be replayed", async () => {
  const { c, body } = await rawLogin(DEMO_PHONES.finance);
  c.token = body.token;
  const denied = await c.get("/api/v1/admin/dashboard");
  assert.equal(denied.status, 403);
  assert.equal(denied.body.error.code, "mfa_required");

  const en = await c.post("/api/v1/auth/mfa/totp/enroll");
  assert.equal(en.status, 200);
  assert.match(en.body.otpauthUri, /^otpauth:\/\/totp\/ABU9/);
  const code = totpAt(en.body.secret, currentStep());
  assert.equal((await c.post("/api/v1/auth/mfa/totp/activate", { code: "000000" === code ? "111111" : "000000" })).status, 400);
  assert.equal((await c.post("/api/v1/auth/mfa/totp/activate", { code })).status, 200);
  assert.equal((await c.get("/api/v1/admin/dashboard")).status, 200);
  assert.equal((await c.post("/api/v1/auth/mfa/totp/enroll")).status, 409, "cannot silently re-enrol");

  // New session: same code (same time-step) is rejected as a replay.
  const { c: c2, body: b2 } = await rawLogin(DEMO_PHONES.finance);
  c2.token = b2.token;
  assert.equal((await c2.post("/api/v1/auth/mfa/verify", { code })).status, 400);
  assert.equal((await c2.get("/api/v1/admin/dashboard")).status, 403);

  const audit = await s.db.query("select 1 from audit_logs where action = 'mfa.totp_enrolled'");
  assert.equal(audit.rowCount, 1);

  // Non-staff users are never asked for MFA.
  const cust = await new Client(s.base).login(DEMO_PHONES.customer);
  const m = await cust.get("/api/v1/auth/mfa");
  assert.equal(m.body.required, false);
});

test("cookie sessions: token never reaches JS, writes need the CSRF header, logout clears", async () => {
  const { res, body } = await rawLogin(DEMO_PHONES.customer2, "cookie");
  assert.equal(res.status, 201);
  assert.equal(body.token, undefined, "token is not exposed to JavaScript");
  const cookies = res.headers.getSetCookie();
  const session = cookies.find((x) => x.startsWith("abu9_session="))!;
  const csrf = cookies.find((x) => x.startsWith("abu9_csrf="))!;
  assert.match(session, /HttpOnly/);
  assert.match(session, /SameSite=Lax/);
  assert.doesNotMatch(csrf, /HttpOnly/);
  const jar = [session, csrf].map((x) => x.split(";")[0]).join("; ");
  const csrfValue = decodeURIComponent(csrf.split(";")[0]!.split("=")[1]!);

  const me = await fetch(s.base + "/api/v1/me", { headers: { cookie: jar } });
  assert.equal(me.status, 200);

  const patchMe = (headers: Record<string, string>) =>
    fetch(s.base + "/api/v1/me", { method: "PATCH", headers: { cookie: jar, "content-type": "application/json", ...headers }, body: JSON.stringify({ name: "سارة" }) });
  const noCsrf = await patchMe({});
  assert.equal(noCsrf.status, 403);
  assert.equal((await noCsrf.json()).error.code, "csrf_failed");
  assert.equal((await patchMe({ "x-csrf-token": "forged" })).status, 403);
  assert.equal((await patchMe({ "x-csrf-token": csrfValue })).status, 200);

  const out = await fetch(s.base + "/api/v1/auth/logout", { method: "POST", headers: { cookie: jar, "x-csrf-token": csrfValue } });
  assert.equal(out.status, 200);
  assert.ok(out.headers.getSetCookie().some((x) => x.startsWith("abu9_session=;") && /Max-Age=0/.test(x)));
  const after = await fetch(s.base + "/api/v1/me", { headers: { cookie: jar } });
  assert.equal(after.status, 401);
  assert.ok(after.headers.getSetCookie().some((x) => x.startsWith("abu9_session=;")), "stale cookie is cleared");
});

test("security headers: strict CSP, no framing", async () => {
  const r = await fetch(s.base + "/healthz");
  const csp = r.headers.get("content-security-policy")!;
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /script-src 'self'(;|$)/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.equal(r.headers.get("x-frame-options"), "DENY");
});

test("rate limiting: OTP requests per IP are capped with Retry-After", async () => {
  s.app.limiter!.reset();
  let limited: Response | null = null;
  for (let i = 0; i < 25 && !limited; i++) {
    const phone = `05${String(51000000 + i)}`;
    const r = await fetch(s.base + "/api/v1/auth/otp/request", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ phone }) });
    if (r.status === 429) limited = r;
  }
  assert.ok(limited, "limit reached");
  assert.ok(Number(limited!.headers.get("retry-after")) > 0);
  assert.equal((await limited!.json()).error.details.rule, "otp_request_ip");
  // X-Forwarded-For is ignored unless TRUST_PROXY=1, so spoofing it does not bypass the limit.
  const spoof = await fetch(s.base + "/api/v1/auth/otp/request", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.9" }, body: JSON.stringify({ phone: "0551999999" }) });
  assert.equal(spoof.status, 429);
  s.app.limiter!.reset();
});

test("metrics: Prometheus text with HTTP and operational gauges", async () => {
  await fetch(s.base + "/healthz");
  const r = await fetch(s.base + "/metrics");
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type")!, /text\/plain/);
  const body = await r.text();
  assert.match(body, /abu9_http_requests_total\{method="GET",route="\/healthz",status="200"\} \d+/);
  assert.match(body, /abu9_http_request_duration_seconds_bucket\{method="GET",route="\/healthz",le="\+Inf"\} \d+/);
  for (const g of ["abu9_orders_active", "abu9_dispatch_oldest_unassigned_seconds", "abu9_couriers_online", "abu9_orders_awaiting_restaurant"]) assert.match(body, new RegExp(`^${g} \\d`, "m"), g);
  // Route patterns, never raw ids, keep label cardinality bounded.
  assert.doesNotMatch(body, /route="\/api\/v1\/restaurants\/najd/);
});
