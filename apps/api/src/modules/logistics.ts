import { z } from "zod";
import type { AppContext } from "../context.ts";
import { conflict, notFound, withStatus, type Ctx, type Router } from "../http/router.ts";
import { logisticsScopes, requireLogisticsAccess, requirePermission, requireUser } from "../auth/rbac.ts";
import { audit } from "../audit.ts";
import { disputeClaim } from "../services/support.ts";

/**
 * Logistics partner portal. Partners manage their own couriers and capacity; ABU9 controls dispatch.
 * Partners remain responsible for their couriers' employment, vehicles and compliance.
 */
export function logisticsRoutes(r: Router, app: AppContext) {
  const scope = (ctx: Ctx) => {
    requireLogisticsAccess(ctx, ctx.params.cid!);
    return ctx.params.cid!;
  };

  r.get("/api/v1/logistics/mine", async (ctx) => {
    const p = requireUser(ctx);
    const ids = logisticsScopes(p);
    return { companies: ids.length ? (await app.db.query("select * from logistics_companies where id = any($1::uuid[])", [ids])).rows : [] };
  });

  r.get("/api/v1/logistics/:cid/overview", async (ctx) => {
    const cid = scope(ctx);
    const [company, couriers, active, perf, contract, commitments] = await Promise.all([
      app.db.query("select * from logistics_companies where id = $1", [cid]),
      app.db.query("select status, count(*)::int n from couriers where company_id = $1 group by status", [cid]),
      app.db.query("select status, count(*)::int n from delivery_jobs where company_id = $1 and status in ('assigned','at_pickup','picked_up','at_dropoff') group by status", [cid]),
      app.db.query(
        `select count(*)::int delivered, count(*) filter (where j.delivered_at <= o.promised_by)::int on_time,
                coalesce(avg(extract(epoch from j.delivered_at - j.assigned_at)/60),0)::float avg_trip_min,
                count(*) filter (where j.batched_with_job_id is not null)::int batched,
                (select count(*) from delivery_jobs f where f.company_id = $1 and f.status = 'failed' and f.created_at > now() - interval '7 days')::int failed,
                coalesce(sum(j.compensation),0)::bigint accrued
         from delivery_jobs j join orders o on o.id = j.order_id where j.company_id = $1 and j.status = 'delivered' and j.delivered_at > now() - interval '7 days'`,
        [cid],
      ),
      app.db.query("select * from logistics_contracts where company_id = $1 order by effective_from desc limit 1", [cid]),
      app.db.query("select c.*, z.code zone, z.name_ar zone_name from zone_capacity_commitments c join zones z on z.id = c.zone_id where c.company_id = $1 order by c.weekday, z.code", [cid]),
    ]);
    if (!company.rows[0]) throw notFound("company");
    const p = perf.rows[0] as { delivered: number; on_time: number };
    return {
      company: company.rows[0],
      couriers: couriers.rows,
      activeJobs: active.rows,
      last7d: { ...p, onTimeRate: p.delivered ? p.on_time / p.delivered : null },
      contract: contract.rows[0] ?? null,
      commitments: commitments.rows,
      responsibilities: "Partner is responsible for couriers' employment arrangements, vehicles and regulatory compliance.",
    };
  });

  r.get("/api/v1/logistics/:cid/couriers", async (ctx) => {
    const cid = scope(ctx);
    return {
      couriers: (await app.db.query(
        `select c.id, c.display_name, c.status, c.vehicle_type, c.capacity_type, c.last_seen_at, u.phone,
                (select count(*) from delivery_jobs j where j.courier_id = c.id and j.status in ('assigned','at_pickup','picked_up','at_dropoff'))::int load,
                (select count(*) from delivery_jobs j where j.courier_id = c.id and j.status = 'delivered' and j.delivered_at > now() - interval '7 days')::int delivered_7d,
                (select round(avg(r.courier_stars)::numeric,1)::text from ratings r join delivery_jobs j on j.order_id = r.order_id where j.courier_id = c.id) rating
         from couriers c join users u on u.id = c.user_id where c.company_id = $1 order by c.display_name`,
        [cid],
      )).rows,
    };
  });

  r.post("/api/v1/logistics/:cid/couriers/:id/status", async (ctx) => {
    const cid = scope(ctx);
    const b = await ctx.body(z.object({ status: z.enum(["offline", "suspended"]), reason: z.string().min(3) }));
    return app.db.tx(async (q) => {
      const c = (await q.query("select status from couriers where id = $1 and company_id = $2 for update", [ctx.params.id, cid])).rows[0];
      if (!c) throw notFound("courier");
      const active = (await q.query<{ n: number }>("select count(*)::int n from delivery_jobs where courier_id = $1 and status in ('assigned','at_pickup','picked_up','at_dropoff')", [ctx.params.id])).rows[0]!.n;
      if (active) throw conflict("courier_has_active_jobs", "ask ABU9 ops to reassign active jobs first");
      await q.query("update couriers set status = $2 where id = $1", [ctx.params.id, b.status]);
      await audit(q, ctx, { action: `courier.${b.status}`, entityType: "courier", entityId: ctx.params.id!, before: c, after: { status: b.status }, reason: b.reason });
      return { ok: true };
    });
  });

  r.get("/api/v1/logistics/:cid/jobs", async (ctx) => {
    const cid = scope(ctx);
    return {
      jobs: (await app.db.query(
        `select j.id, j.status, j.assigned_at, j.picked_up_at, j.delivered_at, j.distance_km, j.compensation, j.batched_with_job_id is not null batched, o.number, o.promised_by,
                (j.delivered_at is not null and j.delivered_at <= o.promised_by) on_time, c.display_name courier, z.code zone
         from delivery_jobs j join orders o on o.id = j.order_id left join couriers c on c.id = j.courier_id left join zones z on z.id = o.zone_id
         where j.company_id = $1 order by j.created_at desc limit 200`,
        [cid],
      )).rows,
    };
  });

  // ── capacity: ABU9 requests peak capacity; partner responds ──
  r.get("/api/v1/logistics/:cid/capacity-requests", async (ctx) => {
    const cid = scope(ctx);
    return { requests: (await app.db.query("select cr.*, z.code zone, z.name_ar zone_name from capacity_requests cr join zones z on z.id = cr.zone_id where cr.company_id = $1 or cr.company_id is null order by cr.window_start desc", [cid])).rows };
  });
  r.post("/api/v1/logistics/:cid/capacity-requests/:id/respond", async (ctx) => {
    const cid = scope(ctx);
    const b = await ctx.body(z.object({ committedCouriers: z.number().int().min(0).max(500) }));
    return app.db.tx(async (q) => {
      const cr = (await q.query<{ requested_couriers: number; status: string }>("select * from capacity_requests where id = $1 and (company_id = $2 or company_id is null) for update", [ctx.params.id, cid])).rows[0];
      if (!cr) throw notFound("capacity request");
      if (cr.status !== "open") throw conflict("request_closed");
      const status = b.committedCouriers === 0 ? "declined" : b.committedCouriers >= cr.requested_couriers ? "accepted" : "partially_accepted";
      await q.query("update capacity_requests set status = $2, committed_couriers = $3, company_id = $4 where id = $1", [ctx.params.id, status, b.committedCouriers, cid]);
      await audit(q, ctx, { action: "capacity_request.respond", entityType: "capacity_request", entityId: ctx.params.id!, after: { status, committed: b.committedCouriers } });
      return { status };
    });
  });
  r.post("/api/v1/admin/capacity-requests", async (ctx) => {
    requirePermission(ctx, "logistics.manage_all");
    const b = await ctx.body(z.object({ zoneId: z.string().uuid(), companyId: z.string().uuid().nullable(), requestedCouriers: z.number().int().min(1).max(500), windowStart: z.string().datetime(), windowEnd: z.string().datetime() }));
    const row = (await app.db.query<{ id: string }>("insert into capacity_requests(zone_id, company_id, requested_couriers, window_start, window_end, created_by) values ($1,$2,$3,$4,$5,$6) returning id", [b.zoneId, b.companyId, b.requestedCouriers, b.windowStart, b.windowEnd, ctx.principal!.userId])).rows[0]!;
    await audit(app.db, ctx, { action: "capacity_request.create", entityType: "capacity_request", entityId: row.id, after: b });
    return withStatus(201, { id: row.id });
  });

  r.get("/api/v1/logistics/:cid/settlements", async (ctx) => {
    const cid = scope(ctx);
    const payable = (await app.db.query<{ balance: number }>("select balance from account_balances where code = $1", [`liability:logistics_payable:${cid}`])).rows[0]?.balance ?? 0;
    return { currentPayable: payable, settlements: (await app.db.query("select * from settlements where party_type = 'logistics' and party_id = $1 order by period_start desc", [cid])).rows };
  });
  r.get("/api/v1/logistics/:cid/claims", async (ctx) => {
    const cid = scope(ctx);
    return { claims: (await app.db.query("select c.*, o.number from compensation_claims c join orders o on o.id = c.order_id where c.party_type = 'logistics' and c.party_id = $1 order by c.created_at desc", [cid])).rows };
  });
  r.post("/api/v1/logistics/:cid/claims/:id/dispute", async (ctx) => {
    const cid = scope(ctx);
    const { note } = await ctx.body(z.object({ note: z.string().min(5).max(1000) }));
    await disputeClaim(app, ctx.params.id!, cid, note);
    await audit(app.db, ctx, { action: "claim.disputed", entityType: "compensation_claim", entityId: ctx.params.id!, after: { note } });
    return { ok: true };
  });
}
