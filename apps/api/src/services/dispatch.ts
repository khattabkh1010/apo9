import type { Queryable } from "../../../../packages/db/src/pg.ts";
import { incentiveFor, type IncentiveType } from "../../../../packages/domain/src/creators.ts";
import { DEFAULT_BATCHING, type BatchingConfig, type CourierCandidate, type DispatchJob, type DispatchDecision, type ActiveLeg } from "../../../../packages/domain/src/dispatch.ts";
import { haversineKm } from "../../../../packages/domain/src/geo.ts";
import { assertJobTransition, type DeliveryJobStatus } from "../../../../packages/domain/src/order-state.ts";
import { postDeliveryCost } from "../../../../packages/domain/src/ledger.ts";
import { logisticsCompensation } from "../../../../packages/domain/src/settlements.ts";
import { quoteEarn, DEFAULT_LOYALTY, type LoyaltyProgramConfig, type Campaign } from "../../../../packages/domain/src/loyalty.ts";
import type { AppContext } from "../context.ts";
import { ApiError, conflict, notFound } from "../http/router.ts";
import { getSetting, notify, postEntry } from "./common.ts";
import { transitionOrder } from "./orders.ts";
import { log } from "../log.ts";

const CANDIDATE_RADIUS_KM = 10;
const ACTIVE = ["assigned", "at_pickup", "picked_up", "at_dropoff"];

interface JobRow {
  id: string;
  order_id: string;
  status: DeliveryJobStatus;
  courier_id: string | null;
  branch_id: string;
  blat: number;
  blng: number;
  dropoff_lat: number;
  dropoff_lng: number;
  ready_at: Date | null;
  promised_by: Date;
}

async function loadJob(q: Queryable, jobId: string): Promise<JobRow> {
  const j = (
    await q.query<JobRow>(
      `select j.id, j.order_id, j.status, j.courier_id, o.branch_id, b.lat blat, b.lng blng, o.dropoff_lat, o.dropoff_lng, o.ready_at, o.promised_by
       from delivery_jobs j join orders o on o.id = j.order_id join branches b on b.id = o.branch_id where j.id = $1`,
      [jobId],
    )
  ).rows[0];
  if (!j) throw notFound("delivery job");
  return j;
}

const toDispatchJob = (j: JobRow, now: Date): DispatchJob => ({
  id: j.id,
  orderId: j.order_id,
  branchId: j.branch_id,
  pickup: { lat: j.blat, lng: j.blng },
  dropoff: { lat: j.dropoff_lat, lng: j.dropoff_lng },
  readyAt: j.ready_at ?? now,
  promisedBy: j.promised_by,
});

/**
 * Run the configured dispatch strategy for an unassigned job and persist the decision (with its
 * explanation) whether or not a courier was found. Safe to call repeatedly (retry job does so).
 */
export async function dispatchJob(app: AppContext, jobId: string): Promise<DispatchDecision> {
  const now = app.now();
  const job = await loadJob(app.db, jobId);
  if (job.status !== "unassigned") throw conflict("job_not_unassigned", `job is ${job.status}`);
  const djob = toDispatchJob(job, now);

  const couriers = (
    await app.db.query<{ id: string; company_id: string; capacity_type: "committed" | "on_demand"; last_lat: number; last_lng: number; status: string }>(
      "select id, company_id, capacity_type, last_lat, last_lng, status from couriers where status = 'online' and last_lat is not null and last_seen_at > now() - interval '10 minutes'",
    )
  ).rows.filter((c) => haversineKm({ lat: c.last_lat, lng: c.last_lng }, djob.pickup) <= CANDIDATE_RADIUS_KM);

  const ids = couriers.map((c) => c.id);
  const activeRows = ids.length
    ? (await app.db.query<JobRow & { courier_id: string }>(
        `select j.id, j.order_id, j.status, j.courier_id, o.branch_id, b.lat blat, b.lng blng, o.dropoff_lat, o.dropoff_lng, o.ready_at, o.promised_by
         from delivery_jobs j join orders o on o.id = j.order_id join branches b on b.id = o.branch_id
         where j.courier_id = any($1::uuid[]) and j.status = any($2::text[])`,
        [ids, ACTIVE],
      )).rows
    : [];
  const rejections = (await app.db.query<{ courier_id: string }>("select courier_id from courier_job_rejections where job_id = $1", [jobId])).rows.map((r) => r.courier_id);

  const candidates: CourierCandidate[] = couriers.map((c) => ({
    id: c.id,
    logisticsCompanyId: c.company_id,
    capacityType: c.capacity_type,
    location: { lat: c.last_lat, lng: c.last_lng },
    online: true,
    rejectedJobIds: rejections.includes(c.id) ? [jobId] : [],
    activeLegs: activeRows
      .filter((a) => a.courier_id === c.id)
      .map((a): ActiveLeg => ({ job: toDispatchJob(a, now), pickedUp: a.status === "picked_up" || a.status === "at_dropoff" })),
  }));

  const batching = await getSetting<BatchingConfig>(app.db, "batching", DEFAULT_BATCHING);
  const t0 = performance.now();
  const decision = await app.dispatch.decide(djob, candidates, { now, routing: app.routing, batching });
  app.metrics.inc("abu9_dispatch_decisions_total", { strategy: decision.strategy, outcome: decision.assignment ? decision.assignment.mode : "unassigned" });
  app.metrics.inc("abu9_dispatch_decide_ms_total", {}, Math.round(performance.now() - t0));

  await app.db.tx(async (q) => {
    await q.query("insert into dispatch_decisions(job_id, strategy, decision) values ($1,$2,$3)", [jobId, decision.strategy, decision]);
    if (!decision.assignment) {
      app.bus.publish("ops", { type: "dispatch.unassigned", jobId, orderId: job.order_id, rejected: decision.rejected.length });
      return;
    }
    const a = decision.assignment;
    const upd = await q.query(
      `update delivery_jobs set status = 'assigned', courier_id = $2, company_id = $3, batched_with_job_id = $4, assigned_at = now(),
         suggested_depart_at = $5, eta_at = $6, attempts = attempts + 1 where id = $1 and status = 'unassigned'`,
      [jobId, a.courierId, a.logisticsCompanyId, a.batchedWithJobId, a.suggestedDepartAt, a.newJobEta],
    );
    if (!upd.rowCount) throw conflict("job_taken", "job was assigned concurrently");
    await q.query("update orders set eta_at = $2 where id = $1", [job.order_id, a.newJobEta]);
    app.bus.publish(`courier:${a.courierId}`, { type: "job.assigned", jobId, orderId: job.order_id, mode: a.mode });
    app.bus.publish(`order:${job.order_id}`, { type: "courier.assigned", eta: a.newJobEta.toISOString() });
    app.bus.publish("ops", { type: "dispatch.assigned", jobId, courierId: a.courierId, mode: a.mode });
  });
  log.info("dispatch.decision", { jobId, strategy: decision.strategy, courier: decision.assignment?.courierId ?? null, mode: decision.assignment?.mode ?? null, candidates: candidates.length });
  return decision;
}

/** Ops manual override: assign a specific courier, bypassing scoring but never the hard capacity cap. */
export async function overrideAssign(app: AppContext, q: Queryable, jobId: string, courierId: string, actorId: string): Promise<void> {
  const job = await loadJob(q, jobId);
  if (!["unassigned", "assigned", "at_pickup"].includes(job.status)) throw conflict("job_not_reassignable", job.status);
  const c = (await q.query<{ id: string; company_id: string; status: string }>("select id, company_id, status from couriers where id = $1", [courierId])).rows[0];
  if (!c) throw notFound("courier");
  if (c.status === "suspended") throw conflict("courier_suspended");
  const load = (await q.query<{ n: number }>("select count(*)::int n from delivery_jobs where courier_id = $1 and status = any($2::text[]) and id <> $3", [courierId, ACTIVE, jobId])).rows[0]!.n;
  const batching = await getSetting<BatchingConfig>(q, "batching", DEFAULT_BATCHING);
  if (load >= Math.min(batching.maxOrdersPerCourier, 2)) throw conflict("courier_at_capacity", "courier already has the maximum number of orders");
  const prev = job.courier_id;
  await q.query("update delivery_jobs set status = 'assigned', courier_id = $2, company_id = $3, assigned_at = now(), batched_with_job_id = null where id = $1", [jobId, courierId, c.company_id]);
  await q.query("insert into dispatch_decisions(job_id, strategy, decision, overridden_by) values ($1,'manual-override',$2,$3)", [jobId, { from: prev, to: courierId }, actorId]);
  if (prev) app.bus.publish(`courier:${prev}`, { type: "job.unassigned", jobId });
  app.bus.publish(`courier:${courierId}`, { type: "job.assigned", jobId, orderId: job.order_id, mode: "manual" });
}

export async function courierRejectJob(app: AppContext, jobId: string, courierId: string, reason: string): Promise<void> {
  await app.db.tx(async (q) => {
    const j = (await q.query<{ status: DeliveryJobStatus; courier_id: string }>("select status, courier_id from delivery_jobs where id = $1 for update", [jobId])).rows[0];
    if (!j || j.courier_id !== courierId) throw notFound("job");
    if (j.status !== "assigned") throw conflict("cannot_reject_now", "يمكن الرفض قبل الوصول للمطعم فقط");
    await q.query("insert into courier_job_rejections(job_id, courier_id, reason) values ($1,$2,$3) on conflict do nothing", [jobId, courierId, reason]);
    await q.query("update delivery_jobs set status = 'unassigned', courier_id = null, company_id = null, batched_with_job_id = null where id = $1", [jobId]);
  });
  await dispatchJob(app, jobId).catch((e) => log.warn("redispatch_failed", { jobId, error: String(e) }));
}

type CourierAction = "arrive_pickup" | "pickup" | "arrive_dropoff" | "deliver" | "fail";

export async function courierAction(app: AppContext, jobId: string, courierId: string, action: CourierAction, extra: { code?: string; reason?: string }): Promise<{ status: DeliveryJobStatus }> {
  const result = await app.db.tx(async (q) => {
    const j = (await q.query<{ id: string; status: DeliveryJobStatus; courier_id: string; order_id: string; pickup_code: string; dropoff_code: string }>("select * from delivery_jobs where id = $1 for update", [jobId])).rows[0];
    if (!j || j.courier_id !== courierId) throw notFound("job");
    const to: Record<CourierAction, DeliveryJobStatus> = { arrive_pickup: "at_pickup", pickup: "picked_up", arrive_dropoff: "at_dropoff", deliver: "delivered", fail: "failed" };
    const next = to[action];
    assertJobTransition(j.status, next);
    if (action === "pickup" && extra.code !== j.pickup_code) throw new ApiError(422, "pickup_code_invalid", "رمز الاستلام غير صحيح");
    if (action === "deliver" && extra.code !== j.dropoff_code) throw new ApiError(422, "dropoff_code_invalid", "رمز التسليم غير صحيح — اطلبه من العميل");
    if (action === "fail" && !extra.reason) throw new ApiError(422, "reason_required");
    const stamp = action === "pickup" ? ", picked_up_at = now()" : action === "deliver" ? ", delivered_at = now()" : "";
    await q.query(`update delivery_jobs set status = $2, failure_reason = $3 ${stamp} where id = $1`, [jobId, next, extra.reason ?? null]);
    if (action === "pickup") {
      const os = (await q.query<{ status: string }>("select status from orders where id = $1", [j.order_id])).rows[0]!.status;
      await transitionOrder(app, q, j.order_id, "picked_up", "courier", courierId, os === "ready_for_pickup" ? undefined : "picked up before marked ready");
    }
    if (action === "deliver") {
      await transitionOrder(app, q, j.order_id, "delivered", "courier", courierId);
      await onDelivered(app, q, jobId);
    }
    if (action === "fail") {
      await transitionOrder(app, q, j.order_id, "delivery_failed", "courier", courierId, extra.reason);
      await q.query("insert into incidents(order_id, job_id, reported_by, kind, description, severity) values ($1,$2,(select user_id from couriers where id = $3),'delivery_failed',$4,'high')", [j.order_id, jobId, courierId, extra.reason]);
    }
    app.bus.publish(`order:${j.order_id}`, { type: "job.status", status: next });
    return { status: next };
  });
  return result;
}

/**
 * Delivery completion side-effects (same transaction as the status change):
 *  - accrue logistics compensation per order (batched second order at the batch rate),
 *  - award loyalty points (campaign extras only within approved budget),
 *  - register creator incentives for opted-in, active campaigns.
 */
async function onDelivered(app: AppContext, q: Queryable, jobId: string): Promise<void> {
  const j = (await q.query<{ order_id: string; company_id: string; distance_km: string; batched_with_job_id: string | null }>("select order_id, company_id, distance_km, batched_with_job_id from delivery_jobs where id = $1", [jobId])).rows[0]!;
  const contract = (await q.query<{ per_order: number; per_batched_order: number; per_km_beyond: number; included_km: string; committed_hourly_minimum: number }>(
    "select * from logistics_contracts where company_id = $1 and effective_from <= now() and (effective_to is null or effective_to > now()) order by effective_from desc limit 1",
    [j.company_id],
  )).rows[0];
  if (contract) {
    const amount = logisticsCompensation(
      { perOrder: contract.per_order, perBatchedOrder: contract.per_batched_order, perKmBeyond: contract.per_km_beyond, includedKm: Number(contract.included_km), committedHourlyMinimum: contract.committed_hourly_minimum },
      { distanceKm: Number(j.distance_km), batchedSecond: !!j.batched_with_job_id },
    );
    await q.query("update delivery_jobs set compensation = $2 where id = $1", [jobId, amount]);
    await postEntry(q, postDeliveryCost({ orderId: j.order_id, deliveryJobId: jobId, logisticsCompanyId: j.company_id, occurredAt: app.now(), amount, batched: !!j.batched_with_job_id }));
  } else {
    await q.query("insert into fraud_flags(entity_type, entity_id, rule, score, details) values ('delivery_job',$1,'no_active_logistics_contract',80,$2)", [jobId, { companyId: j.company_id }]);
  }

  const o = (await q.query<{ customer_id: string; restaurant_id: string; pricing: { foodNet: number }; number: number }>("select customer_id, restaurant_id, pricing, number from orders where id = $1", [j.order_id])).rows[0]!;

  // Loyalty
  const cfg = await getSetting<LoyaltyProgramConfig>(q, "loyalty", DEFAULT_LOYALTY);
  const camps = (await q.query<Record<string, unknown>>("select * from loyalty_campaigns where status = 'active'")).rows.map(
    (c): Campaign => ({
      id: c.id as string, restaurantId: c.restaurant_id as string | null, status: "active", multiplier: Number(c.multiplier), budget: c.budget as number, spent: c.spent as number,
      abu9ShareBps: c.abu9_share_bps as number, restaurantShareBps: c.restaurant_share_bps as number, startsAt: c.starts_at as Date, endsAt: c.ends_at as Date,
    }),
  );
  const earnedToday = (await q.query<{ n: number }>("select coalesce(sum(delta),0)::int n from points_transactions where user_id = $1 and kind in ('earn','campaign_earn') and created_at > now() - interval '1 day'", [o.customer_id])).rows[0]!.n;
  const earn = quoteEarn({ eligibleFoodNet: o.pricing.foodNet, restaurantId: o.restaurant_id, campaigns: camps, earnedToday, at: app.now(), cfg });
  const expires = new Date(app.now().getTime() + cfg.expiryDays * 86_400_000);
  if (earn.basePoints > 0) {
    const lot = (await q.query<{ id: string }>("insert into points_lots(user_id, points, remaining, expires_at, source, order_id) values ($1,$2,$2,$3,'order',$4) returning id", [o.customer_id, earn.basePoints, expires, j.order_id])).rows[0]!;
    await q.query("insert into points_transactions(user_id, delta, kind, order_id, lot_id) values ($1,$2,'earn',$3,$4)", [o.customer_id, earn.basePoints, j.order_id, lot.id]);
  }
  if (earn.campaignPoints > 0 && earn.campaignId) {
    const upd = await q.query("update loyalty_campaigns set spent = spent + $2, status = case when spent + $2 >= budget then 'exhausted' else status end where id = $1 and spent + $2 <= budget", [earn.campaignId, earn.campaignCost]);
    if (upd.rowCount) {
      const lot = (await q.query<{ id: string }>("insert into points_lots(user_id, points, remaining, expires_at, source, order_id, campaign_id) values ($1,$2,$2,$3,'campaign',$4,$5) returning id", [o.customer_id, earn.campaignPoints, expires, j.order_id, earn.campaignId])).rows[0]!;
      await q.query("insert into points_transactions(user_id, delta, kind, order_id, lot_id, campaign_id, cost, note) values ($1,$2,'campaign_earn',$3,$4,$5,$6,$7)", [
        o.customer_id, earn.campaignPoints, j.order_id, lot.id, earn.campaignId, earn.campaignCost, `funding abu9=${earn.campaignFunding.abu9} restaurant=${earn.campaignFunding.restaurant}`,
      ]);
    }
  }

  // Creator incentive (only opt-in, approved, active campaigns with budget)
  const attr = (await q.query<{ creator_id: string | null }>("select creator_id from attributions where order_id = $1", [j.order_id])).rows[0];
  if (attr?.creator_id) {
    const camp = (await q.query<{ id: string; incentive_type: string; incentive_value: number }>(
      `select c.* from creator_campaigns c join creator_campaign_enrollments e on e.campaign_id = c.id and e.creator_id = $1 and e.status = 'approved'
       where c.status = 'active' and (c.restaurant_id is null or c.restaurant_id = $2)
         and (c.starts_at is null or c.starts_at <= now()) and (c.ends_at is null or c.ends_at > now())
       order by c.created_at limit 1`,
      [attr.creator_id, o.restaurant_id],
    )).rows[0];
    if (camp && camp.incentive_type !== "none") {
      const amount = incentiveFor(camp.incentive_type as IncentiveType, camp.incentive_value, o.pricing.foodNet);
      const flags: string[] = [];
      const self = (await q.query<{ n: number }>("select count(*)::int n from creators where id = $1 and user_id = $2", [attr.creator_id, o.customer_id])).rows[0]!.n;
      if (self) flags.push("self_referral");
      const upd = await q.query("update creator_campaigns set spent = spent + $2 where id = $1 and spent + $2 <= budget", [camp.id, flags.length ? 0 : amount]);
      if (upd.rowCount) await q.query("insert into creator_incentives(creator_id, campaign_id, order_id, amount, status, fraud_flags) values ($1,$2,$3,$4,$5,$6) on conflict do nothing", [attr.creator_id, camp.id, j.order_id, amount, flags.length ? "rejected" : "pending", flags]);
    }
  }
  await notify(app, q, o.customer_id, { kind: "rate_order", titleAr: `بالعافية! قيّم طلبك #${o.number}`, data: { orderId: j.order_id, pointsEarned: earn.basePoints + earn.campaignPoints } });
}

export async function recordCourierLocation(app: AppContext, courierId: string, lat: number, lng: number): Promise<void> {
  const jobs = (await app.db.query<{ id: string; order_id: string }>("select id, order_id from delivery_jobs where courier_id = $1 and status = any($2::text[])", [courierId, ACTIVE])).rows;
  await app.db.query("update couriers set last_lat = $2, last_lng = $3, last_seen_at = now() where id = $1", [courierId, lat, lng]);
  // Location history is stored only while on an active delivery (privacy: no off-shift tracking).
  for (const j of jobs) {
    await app.db.query("insert into courier_locations(courier_id, job_id, lat, lng) values ($1,$2,$3,$4)", [courierId, j.id, lat, lng]);
    app.bus.publish(`order:${j.order_id}`, { type: "courier.location", lat, lng });
  }
}
