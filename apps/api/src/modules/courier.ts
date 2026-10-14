import { z } from "zod";
import type { AppContext } from "../context.ts";
import { forbidden, withStatus, type Ctx, type Router } from "../http/router.ts";
import { requireUser } from "../auth/rbac.ts";
import { courierAction, courierRejectJob, recordCourierLocation } from "../services/dispatch.ts";

/** Courier app API. A courier only ever sees jobs assigned to them. */
export function courierRoutes(r: Router, app: AppContext) {
  const me = async (ctx: Ctx) => {
    const p = requireUser(ctx);
    const c = (await app.db.query<{ id: string; company_id: string; status: string; display_name: string }>("select id, company_id, status, display_name from couriers where user_id = $1", [p.userId])).rows[0];
    if (!c) throw forbidden("not_a_courier");
    if (c.status === "suspended") throw forbidden("courier_suspended");
    return c;
  };

  r.get("/api/v1/courier/me", async (ctx) => {
    const c = await me(ctx);
    const company = (await app.db.query("select id, name_ar, name_en from logistics_companies where id = $1", [c.company_id])).rows[0];
    const today = (await app.db.query(
      `select count(*) filter (where status = 'delivered')::int delivered, coalesce(sum(compensation) filter (where status = 'delivered'),0)::bigint earnings_to_company,
              coalesce(sum(distance_km) filter (where status = 'delivered'),0)::float km
       from delivery_jobs where courier_id = $1 and created_at > date_trunc('day', now() at time zone 'Asia/Riyadh') at time zone 'Asia/Riyadh'`,
      [c.id],
    )).rows[0];
    return { courier: c, company, today, note: "Per-order amounts are paid by ABU9 to your logistics company; your personal pay is set by your company." };
  });

  r.post("/api/v1/courier/status", async (ctx) => {
    const c = await me(ctx);
    const { status } = await ctx.body(z.object({ status: z.enum(["online", "offline", "on_break"]) }));
    if (status !== "online") {
      const active = (await app.db.query<{ n: number }>("select count(*)::int n from delivery_jobs where courier_id = $1 and status in ('assigned','at_pickup','picked_up','at_dropoff')", [c.id])).rows[0]!.n;
      if (active > 0) throw forbidden("active_jobs", "أكمل الطلبات الحالية أولاً");
    }
    await app.db.query("update couriers set status = $2, last_seen_at = now() where id = $1", [c.id, status]);
    return { status };
  });

  r.post("/api/v1/courier/location", async (ctx) => {
    const c = await me(ctx);
    const b = await ctx.body(z.object({ lat: z.number().min(15).max(33), lng: z.number().min(34).max(56) }));
    await recordCourierLocation(app, c.id, b.lat, b.lng);
    return withStatus(202, { ok: true });
  });

  r.get("/api/v1/courier/jobs", async (ctx) => {
    const c = await me(ctx);
    const scope = ctx.query.get("scope") ?? "active";
    const rows = (
      await app.db.query(
        `select j.id, j.status, j.order_id, j.batched_with_job_id, j.eta_at, j.suggested_depart_at, j.assigned_at, j.picked_up_at, j.delivered_at, j.distance_km, j.compensation,
                o.number, o.promised_by, o.ready_at, o.status order_status, o.address, o.dropoff_lat, o.dropoff_lng, o.notes, o.total,
                r.name_ar restaurant_name_ar, b.name_ar branch_name_ar, b.lat pickup_lat, b.lng pickup_lng, b.phone branch_phone,
                u.name customer_name, (select count(*) from order_items i where i.order_id = o.id)::int item_count
         from delivery_jobs j join orders o on o.id = j.order_id join restaurants r on r.id = o.restaurant_id join branches b on b.id = o.branch_id join users u on u.id = o.customer_id
         where j.courier_id = $1 and (($2 = 'active' and j.status in ('assigned','at_pickup','picked_up','at_dropoff')) or ($2 = 'history' and j.status in ('delivered','failed')))
         order by j.assigned_at desc limit 50`,
        [c.id, scope],
      )
    ).rows;
    return { jobs: rows };
  });

  r.post("/api/v1/courier/jobs/:id/reject", async (ctx) => {
    const c = await me(ctx);
    const { reason } = await ctx.body(z.object({ reason: z.enum(["too_far", "vehicle_issue", "safety", "other"]) }));
    await courierRejectJob(app, ctx.params.id!, c.id, reason);
    return { ok: true };
  });

  for (const action of ["arrive_pickup", "pickup", "arrive_dropoff", "deliver", "fail"] as const) {
    r.post(`/api/v1/courier/jobs/:id/${action.replace("_", "-")}`, async (ctx) => {
      const c = await me(ctx);
      const b = await ctx.body(z.object({ code: z.string().regex(/^\d{4}$/).optional(), reason: z.string().max(300).optional() }));
      return courierAction(app, ctx.params.id!, c.id, action, b);
    });
  }

  r.post("/api/v1/courier/incidents", async (ctx) => {
    const c = await me(ctx);
    const b = await ctx.body(z.object({ jobId: z.string().uuid().optional(), kind: z.enum(["accident", "vehicle_breakdown", "unsafe_location", "restaurant_delay", "customer_issue", "other"]), description: z.string().max(1000), severity: z.enum(["low", "medium", "high", "critical"]).default("medium") }));
    const row = (await app.db.query<{ id: string }>(
      "insert into incidents(order_id, job_id, reported_by, kind, description, severity) values ((select order_id from delivery_jobs where id = $1 and courier_id = $2), $1, (select user_id from couriers where id = $2), $3, $4, $5) returning id",
      [b.jobId ?? null, c.id, b.kind, b.description, b.severity],
    )).rows[0]!;
    app.bus.publish("ops", { type: "incident.reported", incidentId: row.id, severity: b.severity });
    return withStatus(201, { incidentId: row.id });
  });
}
