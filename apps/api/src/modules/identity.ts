import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { z } from "zod";
import { normalizeSaudiMobile } from "../../../../packages/domain/src/phone.ts";
import type { AppContext } from "../context.ts";
import { ApiError, badRequest, notFound, withStatus, type Principal, type Router } from "../http/router.ts";
import { requireUser } from "../auth/rbac.ts";
import { config } from "../config.ts";

const OTP_TTL_MS = 5 * 60_000;
const OTP_MAX_ATTEMPTS = 5;
const OTP_MAX_PER_HOUR = 5;

const hashOtp = (phone: string, code: string) => createHmac("sha256", config.otpSecret).update(`${phone}:${code}`).digest("hex");
const hashToken = (t: string) => createHash("sha256").update(t).digest("hex");

export function makeAuthenticator(app: AppContext) {
  return async (req: IncomingMessage): Promise<Principal | null> => {
    const h = req.headers.authorization;
    let token = h?.startsWith("Bearer ") ? h.slice(7) : null;
    // EventSource cannot set headers: allow token via query only for SSE stream endpoints.
    if (!token && req.url?.includes("/stream")) token = new URL(req.url, "http://x").searchParams.get("access_token");
    if (!token) return null;
    const r = await app.db.query<{ session_id: string; user_id: string; roles: Array<{ role: string; scopeType: string; scopeId: string }> | null }>(
      `select s.id session_id, s.user_id,
              (select json_agg(json_build_object('role', ur.role, 'scopeType', ur.scope_type, 'scopeId', ur.scope_id)) from user_roles ur where ur.user_id = s.user_id) roles
       from sessions s join users u on u.id = s.user_id
       where s.token_hash = $1 and s.revoked_at is null and s.expires_at > now() and u.status = 'active'`,
      [hashToken(token)],
    );
    const row = r.rows[0];
    if (!row) return null;
    return { userId: row.user_id, sessionId: row.session_id, roles: row.roles ?? [] };
  };
}

export function identityRoutes(r: Router, app: AppContext) {
  r.post("/api/v1/auth/otp/request", async (ctx) => {
    const { phone } = await ctx.body(z.object({ phone: z.string().min(6).max(20) }));
    const e164 = normalizeSaudiMobile(phone);
    if (!e164) throw badRequest("invalid_phone", "رقم جوال سعودي غير صحيح");
    const recent = await app.db.query<{ n: number }>("select count(*)::int n from otp_challenges where phone = $1 and created_at > now() - interval '1 hour'", [e164]);
    if (recent.rows[0]!.n >= OTP_MAX_PER_HOUR) throw new ApiError(429, "too_many_requests", "حاول مرة أخرى لاحقاً");
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    const row = await app.db.query<{ id: string }>("insert into otp_challenges(phone, code_hash, expires_at) values ($1,$2,$3) returning id", [e164, hashOtp(e164, code), new Date(Date.now() + OTP_TTL_MS)]);
    await app.sms.send(e164, `رمز الدخول إلى أبو9: ${code}\nلا تشاركه مع أحد.`);
    return { challengeId: row.rows[0]!.id, phone: e164, expiresInSec: OTP_TTL_MS / 1000, ...(config.otpDevEcho ? { devCode: code, devNote: "DEV ONLY — mock SMS" } : {}) };
  });

  r.post("/api/v1/auth/otp/verify", async (ctx) => {
    const body = await ctx.body(z.object({ challengeId: z.string().uuid(), code: z.string().regex(/^\d{6}$/), name: z.string().min(1).max(80).optional() }));
    return app.db.tx(async (q) => {
      const c = (await q.query<{ id: string; phone: string; code_hash: string; expires_at: Date; attempts: number; consumed_at: Date | null }>("select * from otp_challenges where id = $1 for update", [body.challengeId])).rows[0];
      if (!c || c.consumed_at || c.expires_at < new Date()) throw badRequest("otp_expired", "انتهت صلاحية الرمز");
      if (c.attempts >= OTP_MAX_ATTEMPTS) throw new ApiError(429, "otp_locked", "تجاوزت عدد المحاولات");
      const ok = timingSafeEqual(Buffer.from(c.code_hash), Buffer.from(hashOtp(c.phone, body.code)));
      if (!ok) throw Object.assign(badRequest("otp_invalid", "الرمز غير صحيح"), { commit: true });
      await q.query("update otp_challenges set consumed_at = now() where id = $1", [c.id]);
      let user = (await q.query<{ id: string; name: string | null; status: string }>("select id, name, status from users where phone = $1", [c.phone])).rows[0];
      let isNew = false;
      if (!user) {
        isNew = true;
        user = (await q.query<{ id: string; name: string | null; status: string }>("insert into users(phone, name) values ($1,$2) returning id, name, status", [c.phone, body.name ?? null])).rows[0]!;
        await q.query("insert into user_roles(user_id, role) values ($1, 'customer')", [user.id]);
      }
      if (user.status !== "active") throw new ApiError(403, "account_suspended");
      const token = randomBytes(32).toString("base64url");
      await q.query("insert into sessions(user_id, token_hash, expires_at, user_agent) values ($1,$2,$3,$4)", [user.id, hashToken(token), new Date(Date.now() + config.sessionDays * 86_400_000), ctx.req.headers["user-agent"] ?? null]);
      return withStatus(201, { token, userId: user.id, isNew });
    }).catch(async (e) => {
      // Failed-attempt increments must persist: redo it outside the rolled-back transaction.
      if (e && (e as { commit?: boolean }).commit) await app.db.query("update otp_challenges set attempts = attempts + 1 where id = $1", [body.challengeId]);
      throw e;
    });
  });

  r.post("/api/v1/auth/logout", async (ctx) => {
    const p = requireUser(ctx);
    await app.db.query("update sessions set revoked_at = now() where id = $1", [p.sessionId]);
    return { ok: true };
  });

  r.get("/api/v1/me", async (ctx) => {
    const p = requireUser(ctx);
    const u = (await app.db.query("select id, phone, name, email, locale, created_at from users where id = $1", [p.userId])).rows[0];
    const extras = (
      await app.db.query<{ courier_id: string | null; company_id: string | null; creator_id: string | null; points: number }>(
        `select (select id from couriers where user_id = $1) courier_id,
                (select company_id from couriers where user_id = $1) company_id,
                (select id from creators where user_id = $1) creator_id,
                coalesce((select sum(delta) from points_transactions where user_id = $1),0)::int points`,
        [p.userId],
      )
    ).rows[0]!;
    return { user: u, roles: p.roles, courierId: extras.courier_id, courierCompanyId: extras.company_id, creatorId: extras.creator_id, points: extras.points };
  });

  r.patch("/api/v1/me", async (ctx) => {
    const p = requireUser(ctx);
    const b = await ctx.body(z.object({ name: z.string().min(1).max(80).optional(), locale: z.enum(["ar", "en"]).optional(), email: z.string().email().optional() }));
    await app.db.query("update users set name = coalesce($2, name), locale = coalesce($3, locale), email = coalesce($4, email) where id = $1", [p.userId, b.name ?? null, b.locale ?? null, b.email ?? null]);
    return { ok: true };
  });

  // ── addresses ──
  const AddressBody = z.object({
    label: z.string().min(1).max(40),
    lat: z.number().min(15).max(33),
    lng: z.number().min(34).max(56),
    district: z.string().max(80).optional(),
    details: z.string().max(200).optional(),
    building: z.string().max(80).optional(),
    notes: z.string().max(200).optional(),
    isDefault: z.boolean().optional(),
  });
  r.get("/api/v1/me/addresses", async (ctx) => {
    const p = requireUser(ctx);
    return { addresses: (await app.db.query("select * from addresses where user_id = $1 order by is_default desc, created_at", [p.userId])).rows };
  });
  r.post("/api/v1/me/addresses", async (ctx) => {
    const p = requireUser(ctx);
    const b = await ctx.body(AddressBody);
    return app.db.tx(async (q) => {
      if (b.isDefault) await q.query("update addresses set is_default = false where user_id = $1", [p.userId]);
      const row = await q.query("insert into addresses(user_id, label, lat, lng, district, details, building, notes, is_default) values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning *", [p.userId, b.label, b.lat, b.lng, b.district ?? null, b.details ?? null, b.building ?? null, b.notes ?? null, b.isDefault ?? false]);
      return withStatus(201, { address: row.rows[0] });
    });
  });
  r.delete("/api/v1/me/addresses/:id", async (ctx) => {
    const p = requireUser(ctx);
    const r2 = await app.db.query("delete from addresses where id = $1 and user_id = $2", [ctx.params.id, p.userId]);
    if (!r2.rowCount) throw notFound("address");
    return undefined;
  });

  // ── notifications ──
  r.get("/api/v1/me/notifications", async (ctx) => {
    const p = requireUser(ctx);
    return { notifications: (await app.db.query("select * from notifications where user_id = $1 order by created_at desc limit 50", [p.userId])).rows };
  });
  r.post("/api/v1/me/notifications/read", async (ctx) => {
    const p = requireUser(ctx);
    await app.db.query("update notifications set read_at = now() where user_id = $1 and read_at is null", [p.userId]);
    return { ok: true };
  });
}
