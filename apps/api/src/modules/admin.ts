import { z } from "zod";
import type { AppContext } from "../context.ts";
import { ApiError, badRequest, conflict, notFound, withStatus, type Router } from "../http/router.ts";
import { requirePermission } from "../auth/rbac.ts";
import { audit } from "../audit.ts";
import { getSetting } from "../services/common.ts";
import { acceptOrder, rejectOrder, transitionOrder } from "../services/orders.ts";
import { dispatchJob, overrideAssign } from "../services/dispatch.ts";
import { decideClaim, resolveTicket } from "../services/support.ts";
import { approveSettlement, generateSettlement, markSettlementPaid, periodFor, reconcile } from "../services/settlements.ts";

/** Central admin & operations ("control tower"). Every mutating action is permission-checked and audited. */
export function adminRoutes(r: Router, app: AppContext) {
  // ── executive dashboard ──
  r.get("/api/v1/admin/dashboard", async (ctx) => {
    requirePermission(ctx, "analytics.read");
    const today = `date_trunc('day', now() at time zone 'Asia/Riyadh') at time zone 'Asia/Riyadh'`;
    const [orders, live, couriers, revenue, onTime, zones, hourly] = await Promise.all([
      app.db.query(
        `select count(*)::int total, count(*) filter (where status = 'delivered')::int delivered, count(*) filter (where status in ('rejected','cancelled','delivery_failed'))::int lost,
                coalesce(sum(total) filter (where status = 'delivered'),0)::bigint gmv, coalesce(sum(food_subtotal - food_discount) filter (where status = 'delivered'),0)::bigint food_collected_for_restaurants,
                coalesce(avg(total) filter (where status = 'delivered'),0)::int aov, count(*) filter (where plus_applied)::int plus_orders
         from orders where created_at >= ${today}`,
      ),
      app.db.query("select status, count(*)::int n from orders where status in ('placed','accepted','preparing','ready_for_pickup','picked_up') group by status"),
      app.db.query("select status, count(*)::int n from couriers group by status"),
      app.db.query(
        `select a.code, coalesce(sum(case when a.type = 'revenue' then l.credit - l.debit else l.debit - l.credit end),0)::bigint amount
         from journal_lines l join journal_entries e on e.id = l.entry_id join ledger_accounts a on a.code = l.account_code
         where e.occurred_at >= ${today} and a.type in ('revenue','expense') group by a.code order by a.code`,
      ),
      app.db.query(
        `select count(*) filter (where delivered_at <= promised_by)::int on_time, count(*)::int delivered,
                coalesce(avg(extract(epoch from delivered_at - placed_at)/60),0)::float avg_minutes
         from orders where status = 'delivered' and created_at >= ${today}`,
      ),
      app.db.query("select z.id, z.code, z.name_ar, z.status, z.sla_minutes, (select count(*) from orders o where o.zone_id = z.id and o.status in ('placed','accepted','preparing','ready_for_pickup','picked_up'))::int active from zones z order by z.code"),
      app.db.query(`select extract(hour from created_at at time zone 'Asia/Riyadh')::int h, count(*)::int n from orders where created_at >= ${today} group by 1 order by 1`),
    ]);
    const rev = revenue.rows as Array<{ code: string; amount: number }>;
    const abu9Revenue = rev.filter((x) => x.code.startsWith("revenue:")).reduce((a, x) => a + Number(x.amount), 0);
    const costs = rev.filter((x) => x.code.startsWith("expense:")).reduce((a, x) => a + Number(x.amount), 0);
    return {
      today: orders.rows[0],
      definitions: {
        gmv: "Total charged to customers for delivered orders (food + fees). NOT ABU9 revenue.",
        food_collected_for_restaurants: "Food value collected on behalf of restaurants — a liability, not revenue.",
        abu9Revenue: "Delivery/service fees net of VAT + recognised subscription revenue (from the ledger).",
      },
      abu9Revenue,
      costs,
      contributionToday: abu9Revenue - costs,
      revenueBreakdown: rev,
      live: live.rows,
      couriers: couriers.rows,
      delivery: onTime.rows[0],
      zones: zones.rows,
      hourly: hourly.rows,
    };
  });

  // ── orders ──
  r.get("/api/v1/admin/orders", async (ctx) => {
    requirePermission(ctx, "orders.read_all");
    const status = ctx.query.get("status");
    const search = ctx.query.get("q");
    return {
      orders: (await app.db.query(
        `select o.id, o.number, o.status, o.total, o.created_at, o.promised_by, o.eta_at, o.delivered_at, r.name_ar restaurant, u.name customer, u.phone customer_phone, z.code zone,
                (select json_build_object('status', j.status, 'courier', c.display_name, 'jobId', j.id) from delivery_jobs j left join couriers c on c.id = j.courier_id where j.order_id = o.id order by j.created_at desc limit 1) delivery,
                (o.promised_by < now() and o.status not in ('delivered','rejected','cancelled','delivery_failed')) late
         from orders o join restaurants r on r.id = o.restaurant_id join users u on u.id = o.customer_id left join zones z on z.id = o.zone_id
         where ($1::text is null or o.status = $1) and ($2::text is null or o.number::text = $2 or u.phone like '%' || $2)
         order by o.created_at desc limit 200`,
        [status, search],
      )).rows,
    };
  });

  r.get("/api/v1/admin/orders/:id", async (ctx) => {
    requirePermission(ctx, "orders.read_all");
    const o = (await app.db.query("select o.*, r.name_ar restaurant, u.name customer, u.phone customer_phone from orders o join restaurants r on r.id = o.restaurant_id join users u on u.id = o.customer_id where o.id = $1", [ctx.params.id])).rows[0];
    if (!o) throw notFound("order");
    const [items, events, jobs, decisions, payments, ledger, tickets, auditRows] = await Promise.all([
      app.db.query("select * from order_items where order_id = $1", [o.id]),
      app.db.query("select * from order_events where order_id = $1 order by id", [o.id]),
      app.db.query("select j.*, c.display_name courier, lc.name_ar company from delivery_jobs j left join couriers c on c.id = j.courier_id left join logistics_companies lc on lc.id = j.company_id where j.order_id = $1 order by j.created_at", [o.id]),
      app.db.query("select d.* from dispatch_decisions d join delivery_jobs j on j.id = d.job_id where j.order_id = $1 order by d.id", [o.id]),
      app.db.query("select * from payments where order_id = $1", [o.id]),
      app.db.query("select e.event_type, e.occurred_at, json_agg(json_build_object('account', l.account_code, 'debit', l.debit, 'credit', l.credit)) lines from journal_entries e join journal_lines l on l.entry_id = e.id where e.ref_id = $1 group by e.id order by e.posted_at", [o.id]),
      app.db.query("select * from support_tickets where order_id = $1", [o.id]),
      app.db.query("select * from audit_logs where entity_id = $1 order by id", [o.id]),
    ]);
    return { order: o, items: items.rows, events: events.rows, jobs: jobs.rows, dispatchDecisions: decisions.rows, payments: payments.rows, ledger: ledger.rows, tickets: tickets.rows, audit: auditRows.rows };
  });

  r.post("/api/v1/admin/orders/:id/intervene", async (ctx) => {
    const p = requirePermission(ctx, "orders.intervene");
    const b = await ctx.body(z.object({ action: z.enum(["accept", "reject", "mark_ready", "cancel"]), prepMinutes: z.number().int().min(3).max(90).optional(), reason: z.string().min(3).max(300) }));
    const before = (await app.db.query("select status from orders where id = $1", [ctx.params.id])).rows[0];
    if (!before) throw notFound("order");
    if (b.action === "accept") {
      const { jobId } = await acceptOrder(app, ctx.params.id!, p.userId, b.prepMinutes ?? 15, "ops");
      await dispatchJob(app, jobId).catch(() => null);
    } else if (b.action === "reject") await rejectOrder(app, ctx.params.id!, "ops", p.userId, b.reason);
    else if (b.action === "mark_ready") await app.db.tx((q) => transitionOrder(app, q, ctx.params.id!, "ready_for_pickup", "ops", p.userId, b.reason));
    else await app.db.tx((q) => transitionOrder(app, q, ctx.params.id!, "cancelled", "ops", p.userId, b.reason));
    await audit(app.db, ctx, { action: `order.ops_${b.action}`, entityType: "order", entityId: ctx.params.id!, before, reason: b.reason });
    return { ok: true };
  });

  // ── dispatch ──
  r.get("/api/v1/admin/dispatch", async (ctx) => {
    requirePermission(ctx, "orders.read_all");
    const [jobs, couriers] = await Promise.all([
      app.db.query(
        `select j.id, j.status, j.courier_id, j.batched_with_job_id, j.eta_at, j.assigned_at, o.number, o.promised_by, o.ready_at, o.status order_status, r.name_ar restaurant, z.code zone,
                b.lat pickup_lat, b.lng pickup_lng, o.dropoff_lat, o.dropoff_lng,
                (select d.decision->'rejected' from dispatch_decisions d where d.job_id = j.id order by d.id desc limit 1) last_rejections
         from delivery_jobs j join orders o on o.id = j.order_id join restaurants r on r.id = o.restaurant_id join branches b on b.id = o.branch_id left join zones z on z.id = o.zone_id
         where j.status not in ('delivered','failed','cancelled') order by o.promised_by`,
      ),
      app.db.query(
        `select c.id, c.display_name, c.status, c.capacity_type, c.last_lat, c.last_lng, c.last_seen_at, lc.name_ar company,
                (select count(*) from delivery_jobs j where j.courier_id = c.id and j.status in ('assigned','at_pickup','picked_up','at_dropoff'))::int load
         from couriers c join logistics_companies lc on lc.id = c.company_id order by c.status, c.display_name`,
      ),
    ]);
    return { jobs: jobs.rows, couriers: couriers.rows };
  });
  r.post("/api/v1/admin/dispatch/jobs/:id/assign", async (ctx) => {
    const p = requirePermission(ctx, "dispatch.override");
    const b = await ctx.body(z.object({ courierId: z.string().uuid(), reason: z.string().min(3).max(300) }));
    await app.db.tx(async (q) => {
      const before = (await q.query("select status, courier_id from delivery_jobs where id = $1 for update", [ctx.params.id])).rows[0];
      await overrideAssign(app, q, ctx.params.id!, b.courierId, p.userId);
      await audit(q, ctx, { action: "dispatch.manual_assign", entityType: "delivery_job", entityId: ctx.params.id!, before, after: { courierId: b.courierId }, reason: b.reason });
    });
    return { ok: true };
  });
  r.post("/api/v1/admin/dispatch/jobs/:id/redispatch", async (ctx) => {
    requirePermission(ctx, "dispatch.override");
    const j = (await app.db.query<{ status: string }>("select status from delivery_jobs where id = $1", [ctx.params.id])).rows[0];
    if (!j) throw notFound("job");
    if (j.status === "assigned") await app.db.query("update delivery_jobs set status = 'unassigned', courier_id = null, company_id = null where id = $1", [ctx.params.id]);
    const d = await dispatchJob(app, ctx.params.id!);
    await audit(app.db, ctx, { action: "dispatch.redispatch", entityType: "delivery_job", entityId: ctx.params.id!, after: { courierId: d.assignment?.courierId ?? null } });
    return { decision: d };
  });

  // ── zones, coverage & pricing ──
  r.get("/api/v1/admin/zones", async (ctx) => {
    requirePermission(ctx, "zones.configure");
    return {
      zones: (await app.db.query("select * from zones order by code")).rows,
      rules: (await app.db.query("select bz.*, b.name_ar branch, r.name_ar restaurant from branch_zone_rules bz join branches b on b.id = bz.branch_id join restaurants r on r.id = b.restaurant_id")).rows,
      pricing: (await app.db.query("select * from delivery_pricing_configs order by effective_from desc limit 20")).rows,
    };
  });
  r.patch("/api/v1/admin/zones/:id", async (ctx) => {
    requirePermission(ctx, "zones.configure");
    const b = await ctx.body(z.object({ status: z.enum(["active", "paused", "restricted"]).optional(), slaMinutes: z.number().int().min(15).max(120).optional(), reason: z.string().min(3) }));
    return app.db.tx(async (q) => {
      const before = (await q.query("select status, sla_minutes from zones where id = $1 for update", [ctx.params.id])).rows[0];
      if (!before) throw notFound("zone");
      const after = (await q.query("update zones set status = coalesce($2, status), sla_minutes = coalesce($3, sla_minutes) where id = $1 returning status, sla_minutes", [ctx.params.id, b.status ?? null, b.slaMinutes ?? null])).rows[0];
      await audit(q, ctx, { action: "zone.update", entityType: "zone", entityId: ctx.params.id!, before, after, reason: b.reason });
      return { zone: after };
    });
  });
  r.put("/api/v1/admin/coverage-rules", async (ctx) => {
    requirePermission(ctx, "zones.configure");
    const b = await ctx.body(z.object({ branchId: z.string().uuid(), zoneId: z.string().uuid(), enabled: z.boolean(), maxRoadKm: z.number().min(0.5).max(30), maxTravelMinutes: z.number().int().min(5).max(60), reason: z.string().min(3) }));
    return app.db.tx(async (q) => {
      const before = (await q.query("select * from branch_zone_rules where branch_id = $1 and zone_id = $2", [b.branchId, b.zoneId])).rows[0] ?? null;
      await q.query(
        `insert into branch_zone_rules(branch_id, zone_id, enabled, max_road_km, max_travel_minutes) values ($1,$2,$3,$4,$5)
         on conflict (branch_id, zone_id) do update set enabled = $3, max_road_km = $4, max_travel_minutes = $5`,
        [b.branchId, b.zoneId, b.enabled, b.maxRoadKm, b.maxTravelMinutes],
      );
      await audit(q, ctx, { action: "coverage_rule.upsert", entityType: "branch", entityId: b.branchId, before, after: b, reason: b.reason });
      return { ok: true };
    });
  });
  r.post("/api/v1/admin/pricing", async (ctx) => {
    const p = requirePermission(ctx, "pricing.configure");
    const b = await ctx.body(z.object({
      zoneId: z.string().uuid().nullable(), basicFee: z.number().int().min(0), baseDistanceKm: z.number().min(0).max(10), additionalFeePerIncrement: z.number().int().min(0),
      additionalIncrementKm: z.number().min(0.1).max(5), additionalFeeCap: z.number().int().min(0).nullable().optional(), serviceFee: z.number().int().min(0), vatRateBps: z.number().int().min(0).max(5000), reason: z.string().min(3),
    }));
    // Pricing is versioned (new row, effective now) — never edited in place.
    return app.db.tx(async (q) => {
      const row = (await q.query<{ id: string }>(
        `insert into delivery_pricing_configs(zone_id, basic_fee, base_distance_km, additional_fee_per_increment, additional_increment_km, additional_fee_cap, service_fee, vat_rate_bps, created_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning *`,
        [b.zoneId, b.basicFee, b.baseDistanceKm, b.additionalFeePerIncrement, b.additionalIncrementKm, b.additionalFeeCap ?? null, b.serviceFee, b.vatRateBps, p.userId],
      )).rows[0]!;
      await audit(q, ctx, { action: "pricing.new_version", entityType: "delivery_pricing", entityId: row.id, after: row, reason: b.reason });
      return withStatus(201, { pricing: row });
    });
  });
  r.get("/api/v1/admin/settings", async (ctx) => {
    requirePermission(ctx, "settings.configure");
    return { settings: (await app.db.query("select * from platform_settings order by key")).rows };
  });
  r.put("/api/v1/admin/settings/:key", async (ctx) => {
    requirePermission(ctx, "settings.configure");
    const allowed = ["batching", "abu9_plus_rules", "abu9_plus_experiment", "loyalty", "coverage", "restaurant_acceptance_timeout_s"];
    if (!allowed.includes(ctx.params.key!)) throw badRequest("unknown_setting");
    const b = await ctx.body(z.object({ value: z.unknown(), reason: z.string().min(3) }));
    if (ctx.params.key === "batching") {
      const v = z.object({ enabled: z.boolean(), maxOrdersPerCourier: z.number().int().min(1).max(2), maxDetourKm: z.number().min(0).max(5), maxAddedDelayMin: z.number().min(0).max(20) }).parse(b.value);
      b.value = v; // hard cap of 2 orders per courier is a business rule, enforced here and in the strategy
    }
    return app.db.tx(async (q) => {
      const before = (await q.query("select value from platform_settings where key = $1", [ctx.params.key])).rows[0]?.value ?? null;
      await q.query("insert into platform_settings(key, value, updated_by) values ($1,$2,$3) on conflict (key) do update set value = $2, updated_by = $3, updated_at = now()", [ctx.params.key, JSON.stringify(b.value), ctx.principal!.userId]);
      await audit(q, ctx, { action: "setting.update", entityType: "setting", entityId: ctx.params.key!, before, after: b.value, reason: b.reason });
      return { ok: true };
    });
  });

  // ── moderation ──
  r.get("/api/v1/admin/moderation/videos", async (ctx) => {
    requirePermission(ctx, "content.moderate");
    return {
      videos: (await app.db.query(
        `select v.*, r.name_ar restaurant, c.handle creator_handle, (select json_agg(m.name_ar) from video_items vi join menu_items m on m.id = vi.item_id where vi.video_id = v.id) items
         from videos v join restaurants r on r.id = v.restaurant_id left join creators c on c.id = v.creator_id where v.status = coalesce($1, 'pending_review') order by v.created_at`,
        [ctx.query.get("status")],
      )).rows,
    };
  });
  r.post("/api/v1/admin/moderation/videos/:id", async (ctx) => {
    const p = requirePermission(ctx, "content.moderate");
    const b = await ctx.body(z.object({ decision: z.enum(["approved", "rejected", "removed"]), reason: z.string().max(300).optional() }));
    if (b.decision !== "approved" && !b.reason) throw badRequest("reason_required");
    return app.db.tx(async (q) => {
      const before = (await q.query("select status from videos where id = $1 for update", [ctx.params.id])).rows[0];
      if (!before) throw notFound("video");
      await q.query("update videos set status = $2, moderated_by = $3, moderated_at = now(), rejection_reason = $4 where id = $1", [ctx.params.id, b.decision, p.userId, b.reason ?? null]);
      await audit(q, ctx, { action: `video.${b.decision}`, entityType: "video", entityId: ctx.params.id!, before, after: { status: b.decision }, reason: b.reason });
      return { ok: true };
    });
  });
  r.get("/api/v1/admin/creators", async (ctx) => {
    requirePermission(ctx, "creators.approve");
    return {
      creators: (await app.db.query("select c.*, u.phone, (select count(*) from attributions a where a.creator_id = c.id)::int attributed_orders from creators c join users u on u.id = c.user_id order by c.created_at desc")).rows,
      campaigns: (await app.db.query("select cc.*, r.name_ar restaurant from creator_campaigns cc left join restaurants r on r.id = cc.restaurant_id order by cc.created_at desc")).rows,
      incentives: (await app.db.query("select ci.*, c.handle from creator_incentives ci join creators c on c.id = ci.creator_id order by ci.created_at desc limit 100")).rows,
    };
  });
  r.post("/api/v1/admin/creators/:id/status", async (ctx) => {
    const p = requirePermission(ctx, "creators.approve");
    const { status } = await ctx.body(z.object({ status: z.enum(["approved", "suspended"]) }));
    await app.db.query("update creators set status = $2, approved_by = $3 where id = $1", [ctx.params.id, status, p.userId]);
    await audit(app.db, ctx, { action: `creator.${status}`, entityType: "creator", entityId: ctx.params.id! });
    return { ok: true };
  });
  // Campaign approval lives in modules/campaigns.ts (four-eyes).
  r.post("/api/v1/admin/creator-enrollments/:campaignId/:creatorId/approve", async (ctx) => {
    requirePermission(ctx, "promotions.approve");
    const r2 = await app.db.query("update creator_campaign_enrollments set status = 'approved' where campaign_id = $1 and creator_id = $2 and status = 'opted_in'", [ctx.params.campaignId, ctx.params.creatorId]);
    if (!r2.rowCount) throw conflict("not_opted_in", "creator must opt in first");
    await audit(app.db, ctx, { action: "creator_enrollment.approve", entityType: "creator_campaign", entityId: ctx.params.campaignId!, after: { creatorId: ctx.params.creatorId } });
    return { ok: true };
  });

  // ── support, refunds & claims ──
  r.get("/api/v1/admin/tickets", async (ctx) => {
    requirePermission(ctx, "refunds.issue");
    return { tickets: (await app.db.query("select t.*, o.number, o.total, u.name customer from support_tickets t left join orders o on o.id = t.order_id join users u on u.id = t.user_id order by (t.status = 'open') desc, t.created_at desc limit 200")).rows };
  });
  r.post("/api/v1/admin/tickets/:id/resolve", async (ctx) => {
    const p = requirePermission(ctx, "refunds.issue");
    const b = await ctx.body(z.object({ faultParty: z.enum(["abu9", "restaurant", "logistics", "customer", "external"]), refundAmount: z.number().int().min(0), note: z.string().min(3).max(500) }));
    // Four-eyes above the threshold: the refund becomes a proposal; a different person approves it.
    const threshold = await getSetting<number>(app.db, "refund_four_eyes_threshold", 10_000);
    if (b.refundAmount > threshold) {
      return app.db.tx(async (q) => {
        const tk = (await q.query<{ status: string }>("select status from support_tickets where id = $1 for update", [ctx.params.id])).rows[0];
        if (!tk) throw notFound("ticket");
        if (tk.status !== "open" && tk.status !== "awaiting_evidence") throw conflict("ticket_not_open");
        const a = (await q.query<{ id: string }>(
          "insert into refund_approvals(ticket_id, fault_party, amount, note, proposed_by) values ($1,$2,$3,$4,$5) returning id",
          [ctx.params.id, b.faultParty, b.refundAmount, b.note, p.userId],
        )).rows[0]!;
        await q.query("update support_tickets set status = 'pending_approval' where id = $1", [ctx.params.id]);
        await audit(q, ctx, { action: "refund.proposed", entityType: "support_ticket", entityId: ctx.params.id!, after: { ...b, approvalId: a.id, threshold } });
        return withStatus(202, { pendingApproval: a.id, threshold });
      });
    }
    const res = await resolveTicket(app, ctx.params.id!, { faultParty: b.faultParty, refundAmount: b.refundAmount, actorId: p.userId, note: b.note });
    await audit(app.db, ctx, { action: "ticket.resolve", entityType: "support_ticket", entityId: ctx.params.id!, after: { ...b, ...res } });
    return res;
  });
  r.get("/api/v1/admin/refund-approvals", async (ctx) => {
    requirePermission(ctx, "refunds.issue");
    return {
      approvals: (await app.db.query(
        `select a.*, t.reason_code, t.description, o.number order_number, o.total order_total, u.name proposed_by_name
         from refund_approvals a join support_tickets t on t.id = a.ticket_id left join orders o on o.id = t.order_id join users u on u.id = a.proposed_by
         where a.status = 'pending' order by a.created_at`,
      )).rows,
    };
  });
  r.post("/api/v1/admin/refund-approvals/:id/decide", async (ctx) => {
    const p = requirePermission(ctx, "refunds.issue_large");
    const b = await ctx.body(z.object({ approve: z.boolean(), reason: z.string().min(3).max(300) }));
    const a = (await app.db.query<{ id: string; ticket_id: string; fault_party: string; amount: number; note: string; proposed_by: string; status: string }>("select * from refund_approvals where id = $1", [ctx.params.id])).rows[0];
    if (!a) throw notFound("approval");
    if (a.status !== "pending") throw conflict("already_decided");
    if (a.proposed_by === p.userId) throw new ApiError(403, "four_eyes_required", "لا يمكنك اعتماد استرداد اقترحته بنفسك");
    // Claim the decision first so two approvers cannot both execute the refund.
    const claimed = await app.db.query("update refund_approvals set status = $2, decided_by = $3, decision_reason = $4, decided_at = now() where id = $1 and status = 'pending'", [a.id, b.approve ? "approved" : "rejected", p.userId, b.reason]);
    if (!claimed.rowCount) throw conflict("already_decided");
    if (!b.approve) {
      await app.db.query("update support_tickets set status = 'open' where id = $1 and status = 'pending_approval'", [a.ticket_id]);
      await audit(app.db, ctx, { action: "refund.rejected", entityType: "support_ticket", entityId: a.ticket_id, before: a, reason: b.reason });
      return { ok: true, approved: false };
    }
    await app.db.query("update support_tickets set status = 'open' where id = $1", [a.ticket_id]);
    try {
      const res = await resolveTicket(app, a.ticket_id, { faultParty: a.fault_party as "abu9", refundAmount: a.amount, actorId: p.userId, note: `${a.note} (اعتماد: ${b.reason})` });
      await audit(app.db, ctx, { action: "refund.approved", entityType: "support_ticket", entityId: a.ticket_id, before: a, after: res, reason: b.reason });
      return { ok: true, approved: true, ...res };
    } catch (e) {
      // Execution failed (e.g. PSP error): return the proposal to pending so it can be retried.
      await app.db.query("update refund_approvals set status = 'pending', decided_by = null, decision_reason = null, decided_at = null where id = $1", [a.id]);
      await app.db.query("update support_tickets set status = 'pending_approval' where id = $1", [a.ticket_id]);
      throw e;
    }
  });
  r.get("/api/v1/admin/claims", async (ctx) => {
    requirePermission(ctx, "claims.resolve");
    return { claims: (await app.db.query("select c.*, o.number from compensation_claims c join orders o on o.id = c.order_id order by c.created_at desc limit 200")).rows };
  });
  r.post("/api/v1/admin/claims/:id/decide", async (ctx) => {
    const p = requirePermission(ctx, "claims.resolve");
    const b = await ctx.body(z.object({ accept: z.boolean(), reason: z.string().min(3) }));
    await decideClaim(app, ctx.params.id!, b.accept, p.userId);
    await audit(app.db, ctx, { action: b.accept ? "claim.accepted" : "claim.absorbed", entityType: "compensation_claim", entityId: ctx.params.id!, reason: b.reason });
    return { ok: true };
  });
  r.get("/api/v1/admin/incidents", async (ctx) => {
    requirePermission(ctx, "orders.read_all");
    return { incidents: (await app.db.query("select i.*, o.number from incidents i left join orders o on o.id = i.order_id order by (i.status <> 'resolved') desc, i.created_at desc limit 100")).rows };
  });
  r.post("/api/v1/admin/incidents/:id/status", async (ctx) => {
    requirePermission(ctx, "orders.intervene");
    const { status } = await ctx.body(z.object({ status: z.enum(["investigating", "resolved"]) }));
    await app.db.query("update incidents set status = $2 where id = $1", [ctx.params.id, status]);
    await audit(app.db, ctx, { action: `incident.${status}`, entityType: "incident", entityId: ctx.params.id! });
    return { ok: true };
  });

  // ── finance: ledger, settlements, reconciliation ──
  r.get("/api/v1/admin/ledger/trial-balance", async (ctx) => {
    requirePermission(ctx, "finance.ledger.read");
    return { accounts: (await app.db.query("select * from account_balances where debit <> 0 or credit <> 0 order by code")).rows };
  });
  r.get("/api/v1/admin/ledger/entries", async (ctx) => {
    requirePermission(ctx, "finance.ledger.read");
    return {
      entries: (await app.db.query(
        "select e.*, (select json_agg(json_build_object('account', l.account_code, 'debit', l.debit, 'credit', l.credit, 'memo', l.memo) order by l.id) from journal_lines l where l.entry_id = e.id) lines from journal_entries e order by e.posted_at desc limit 100",
      )).rows,
    };
  });
  r.get("/api/v1/admin/reconciliation", async (ctx) => {
    requirePermission(ctx, "finance.reconcile");
    return reconcile(app);
  });
  r.get("/api/v1/admin/settlements", async (ctx) => {
    requirePermission(ctx, "finance.settlements");
    return {
      settlements: (await app.db.query(
        `select s.*, coalesce(r.name_ar, lc.name_ar) party_name from settlements s left join restaurants r on s.party_type = 'restaurant' and r.id = s.party_id
         left join logistics_companies lc on s.party_type = 'logistics' and lc.id = s.party_id order by s.period_start desc, party_name`,
      )).rows,
    };
  });
  r.post("/api/v1/admin/settlements/generate", async (ctx) => {
    requirePermission(ctx, "finance.settlements");
    const b = await ctx.body(z.object({ partyType: z.enum(["restaurant", "logistics"]), at: z.string().datetime().optional() }));
    const period = periodFor(b.partyType, b.at ? new Date(b.at) : app.now());
    const parties = (await app.db.query<{ id: string }>(b.partyType === "restaurant" ? "select id from restaurants where status = 'active'" : "select id from logistics_companies where status = 'active'")).rows;
    const ids: string[] = [];
    for (const p of parties) ids.push((await generateSettlement(app, b.partyType, p.id, period)).id);
    await audit(app.db, ctx, { action: "settlements.generate", entityType: "settlement", entityId: null, after: { partyType: b.partyType, period, count: ids.length } });
    return { period, settlementIds: ids };
  });
  r.post("/api/v1/admin/settlements/:id/approve", async (ctx) => {
    const p = requirePermission(ctx, "finance.settlements");
    await approveSettlement(app, ctx.params.id!, p.userId);
    await audit(app.db, ctx, { action: "settlement.approve", entityType: "settlement", entityId: ctx.params.id! });
    return { ok: true };
  });
  r.post("/api/v1/admin/settlements/:id/paid", async (ctx) => {
    const p = requirePermission(ctx, "finance.settlements");
    const { payoutRef } = await ctx.body(z.object({ payoutRef: z.string().min(3).max(100) }));
    await markSettlementPaid(app, ctx.params.id!, payoutRef, p.userId);
    await audit(app.db, ctx, { action: "settlement.paid", entityType: "settlement", entityId: ctx.params.id!, after: { payoutRef } });
    return { ok: true };
  });

  // ── subscriptions, loyalty, promotions ──
  r.get("/api/v1/admin/subscriptions", async (ctx) => {
    requirePermission(ctx, "analytics.read");
    const [variants, byVariant, restaurants] = await Promise.all([
      app.db.query("select * from plus_price_variants order by price"),
      app.db.query(
        `select v.id, v.label, count(s.id)::int subscribers, count(s.id) filter (where s.status = 'active')::int active,
                (select count(*) from plus_benefit_uses u join plus_subscriptions s2 on s2.id = u.subscription_id where s2.price_variant_id = v.id)::int benefit_uses,
                (select coalesce(sum(u.discount),0) from plus_benefit_uses u join plus_subscriptions s2 on s2.id = u.subscription_id where s2.price_variant_id = v.id)::bigint benefit_cost
         from plus_price_variants v left join plus_subscriptions s on s.price_variant_id = v.id group by v.id order by v.price`,
      ),
      app.db.query("select rs.*, r.name_ar from restaurant_subscriptions rs join restaurants r on r.id = rs.restaurant_id where rs.status <> 'cancelled' order by r.name_ar"),
    ]);
    return { plusVariants: variants.rows, plusExperiment: byVariant.rows, restaurantSubscriptions: restaurants.rows, note: "ABU9+ prices are TEST prices, not approved commercial decisions." };
  });
  r.patch("/api/v1/admin/plus-variants/:id", async (ctx) => {
    requirePermission(ctx, "pricing.configure");
    const b = await ctx.body(z.object({ weight: z.number().int().min(0).max(100).optional(), active: z.boolean().optional(), reason: z.string().min(3) }));
    return app.db.tx(async (q) => {
      const before = (await q.query("select * from plus_price_variants where id = $1", [ctx.params.id])).rows[0];
      if (!before) throw notFound("variant");
      const after = (await q.query("update plus_price_variants set weight = coalesce($2, weight), active = coalesce($3, active) where id = $1 returning *", [ctx.params.id, b.weight ?? null, b.active ?? null])).rows[0];
      await audit(q, ctx, { action: "plus_variant.update", entityType: "plus_price_variant", entityId: ctx.params.id!, before, after, reason: b.reason });
      return { variant: after };
    });
  });
  r.get("/api/v1/admin/promotions", async (ctx) => {
    requirePermission(ctx, "promotions.approve");
    return {
      promotions: (await app.db.query("select p.*, r.name_ar restaurant, (select count(*) from promotion_redemptions x where x.promotion_id = p.id and x.status = 'applied')::int redemptions from promotions p left join restaurants r on r.id = p.restaurant_id order by p.created_at desc")).rows,
      loyaltyCampaigns: (await app.db.query("select c.*, r.name_ar restaurant from loyalty_campaigns c left join restaurants r on r.id = c.restaurant_id order by c.created_at desc")).rows,
      pointsOutstanding: (await app.db.query("select coalesce(sum(remaining),0)::bigint points from points_lots where expires_at > now()")).rows[0],
    };
  });
  r.patch("/api/v1/admin/promotions/:id", async (ctx) => {
    requirePermission(ctx, "promotions.approve");
    const b = await ctx.body(z.object({ active: z.boolean().optional(), budget: z.number().int().min(0).optional(), reason: z.string().min(3) }));
    return app.db.tx(async (q) => {
      const before = (await q.query("select active, budget, spent from promotions where id = $1 for update", [ctx.params.id])).rows[0] as { spent: number } | undefined;
      if (!before) throw notFound("promotion");
      if (b.budget !== undefined && b.budget < before.spent) throw badRequest("budget_below_spent", "budget cannot be lower than already spent");
      const after = (await q.query("update promotions set active = coalesce($2, active), budget = coalesce($3, budget), approved_by = $4 where id = $1 returning active, budget, spent", [ctx.params.id, b.active ?? null, b.budget ?? null, ctx.principal!.userId])).rows[0];
      await audit(q, ctx, { action: "promotion.update", entityType: "promotion", entityId: ctx.params.id!, before, after, reason: b.reason });
      return { promotion: after };
    });
  });

  // ── people & partners ──
  r.get("/api/v1/admin/restaurants", async (ctx) => {
    requirePermission(ctx, "restaurants.manage_all");
    return {
      restaurants: (await app.db.query(
        `select r.id, r.slug, r.name_ar, r.status, r.is_demo, r.activated_at, rs.plan_code, rs.status sub_status, rs.trial_ends_at,
                (select count(*) from orders o where o.restaurant_id = r.id and o.status = 'delivered' and o.created_at > now() - interval '30 days')::int orders_30d
         from restaurants r left join restaurant_subscriptions rs on rs.restaurant_id = r.id and rs.status <> 'cancelled' order by r.name_ar`,
      )).rows,
    };
  });
  r.get("/api/v1/admin/customers", async (ctx) => {
    requirePermission(ctx, "users.manage");
    const s = ctx.query.get("q");
    return {
      customers: (await app.db.query(
        `select u.id, u.name, u.phone, u.status, u.created_at, (select count(*) from orders o where o.customer_id = u.id)::int orders,
                exists(select 1 from plus_subscriptions p where p.user_id = u.id and p.status = 'active') plus
         from users u where exists(select 1 from user_roles ur where ur.user_id = u.id and ur.role = 'customer') and ($1::text is null or u.phone like '%' || $1 || '%' or u.name ilike '%' || $1 || '%')
         order by u.created_at desc limit 100`,
        [s],
      )).rows,
    };
  });
  r.post("/api/v1/admin/users/:id/status", async (ctx) => {
    requirePermission(ctx, "users.manage");
    const b = await ctx.body(z.object({ status: z.enum(["active", "suspended"]), reason: z.string().min(3) }));
    await app.db.tx(async (q) => {
      const before = (await q.query("select status from users where id = $1", [ctx.params.id])).rows[0];
      await q.query("update users set status = $2 where id = $1", [ctx.params.id, b.status]);
      if (b.status === "suspended") await q.query("update sessions set revoked_at = now() where user_id = $1 and revoked_at is null", [ctx.params.id]);
      await audit(q, ctx, { action: `user.${b.status}`, entityType: "user", entityId: ctx.params.id!, before, after: { status: b.status }, reason: b.reason });
    });
    return { ok: true };
  });
  r.get("/api/v1/admin/fraud", async (ctx) => {
    requirePermission(ctx, "orders.read_all");
    return { flags: (await app.db.query("select * from fraud_flags order by (status = 'open') desc, created_at desc limit 100")).rows };
  });
  r.post("/api/v1/admin/fraud/:id", async (ctx) => {
    const p = requirePermission(ctx, "orders.intervene");
    const { status } = await ctx.body(z.object({ status: z.enum(["confirmed", "dismissed"]) }));
    await app.db.query("update fraud_flags set status = $2, reviewed_by = $3 where id = $1", [ctx.params.id, status, p.userId]);
    await audit(app.db, ctx, { action: `fraud.${status}`, entityType: "fraud_flag", entityId: ctx.params.id! });
    return { ok: true };
  });
  r.get("/api/v1/admin/audit", async (ctx) => {
    requirePermission(ctx, "audit.read");
    return { logs: (await app.db.query("select a.*, u.name actor_name from audit_logs a left join users u on u.id = a.actor_id where ($1::text is null or a.entity_type = $1) order by a.id desc limit 200", [ctx.query.get("entityType")])).rows };
  });
}
