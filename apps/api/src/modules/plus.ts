import { z } from "zod";
import type { AppContext } from "../context.ts";
import { badRequest, withStatus, type Router } from "../http/router.ts";
import { requireUser } from "../auth/rbac.ts";
import { DEFAULT_PLUS_RULES, type Abu9PlusRules } from "../../../../packages/domain/src/pricing.ts";
import { cancel, offerFor, resume, subscribe } from "../services/plus.ts";
import { getSetting } from "../services/common.ts";

/** ABU9+ customer subscription + loyalty wallet endpoints. */
export function plusRoutes(r: Router, app: AppContext) {
  r.get("/api/v1/plus", async (ctx) => {
    const p = requireUser(ctx);
    const rules = await getSetting<Abu9PlusRules>(app.db, "abu9_plus_rules", DEFAULT_PLUS_RULES);
    const sub = (await app.db.query("select id, status, price, interval, current_period_start, current_period_end, cancel_at_period_end from plus_subscriptions where user_id = $1 and status in ('active','past_due','cancelled') order by created_at desc limit 1", [p.userId])).rows[0] ?? null;
    const savings = sub ? (await app.db.query<{ n: number; s: number }>("select count(*)::int n, coalesce(sum(discount),0)::bigint s from plus_benefit_uses where subscription_id = $1", [sub.id])).rows[0] : null;
    const offer = await offerFor(app, p.userId);
    return {
      subscription: sub,
      savings,
      offer: { price: offer.price, interval: offer.interval, isTestPrice: true },
      benefits: {
        ar: [
          "توصيل أساسي مجاني (أول ٢ كم) على كل طلب مؤهل — بدون حد شهري",
          `الحد الأدنى للطلب المؤهل ${(rules.minEligibleBasket / 100).toFixed(0)} ر.س بعد خصومات الطعام وقبل رسوم التوصيل`,
          "تدفع رسوم المسافة الإضافية بعد أول ٢ كم",
          "داخل مناطق خدمة أبو9 فقط",
        ],
        en: [
          "Free basic delivery (first 2 km) on every eligible order — no monthly cap",
          `Eligible orders: SAR ${(rules.minEligibleBasket / 100).toFixed(0)}+ food value after food discounts, before delivery fees`,
          "Distance beyond 2 km is charged normally",
          "Within ABU9 service areas only",
        ],
      },
    };
  });
  r.post("/api/v1/plus/subscribe", async (ctx) => {
    const p = requireUser(ctx);
    const key = String(ctx.req.headers["idempotency-key"] ?? "");
    if (key.length < 8) throw badRequest("idempotency_key_required");
    const { paymentToken } = await ctx.body(z.object({ paymentToken: z.string().min(3) }));
    return withStatus(201, await subscribe(app, p.userId, paymentToken, key));
  });
  r.post("/api/v1/plus/cancel", async (ctx) => cancel(app, requireUser(ctx).userId));
  r.post("/api/v1/plus/resume", async (ctx) => {
    await resume(app, requireUser(ctx).userId);
    return { ok: true };
  });

  r.get("/api/v1/me/loyalty", async (ctx) => {
    const p = requireUser(ctx);
    const [balance, expiring, history] = await Promise.all([
      app.db.query<{ b: number }>("select coalesce(sum(delta),0)::int b from points_transactions where user_id = $1", [p.userId]),
      app.db.query("select coalesce(sum(remaining),0)::int points, min(expires_at) next_expiry from points_lots where user_id = $1 and remaining > 0 and expires_at < now() + interval '30 days' and expires_at > now()", [p.userId]),
      app.db.query("select t.delta, t.kind, t.created_at, t.note, o.number order_number from points_transactions t left join orders o on o.id = t.order_id where t.user_id = $1 order by t.id desc limit 50", [p.userId]),
    ]);
    return { balance: balance.rows[0]!.b, valueHalalas: balance.rows[0]!.b, expiringSoon: expiring.rows[0], history: history.rows, rules: { earn: "1 نقطة لكل ريال", redeem: "100 نقطة = 1 ر.س، حتى 30٪ من قيمة الطعام، من 500 نقطة" } };
  });
}
