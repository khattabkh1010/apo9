import type { AppContext } from "./context.ts";
import { log } from "./log.ts";
import { rejectOrder } from "./services/orders.ts";
import { dispatchJob } from "./services/dispatch.ts";
import { recognizePlusRevenue, runRenewals } from "./services/plus.ts";
import { getSetting } from "./services/common.ts";
import { evaluatePlanAtCycleClose, RESTAURANT_PLANS, addInterval } from "../../../packages/domain/src/subscriptions.ts";
import { postRestaurantSubscriptionInvoice } from "../../../packages/domain/src/ledger.ts";
import { postEntry, notify } from "./services/common.ts";

/**
 * Background jobs (in-process scheduler). Each job takes a Postgres advisory lock so that with
 * several API instances only one runs it at a time. Production: move to a dedicated worker
 * process (same code) and/or a queue (BullMQ on Redis) for retries and visibility.
 */
interface Job {
  name: string;
  everyMs: number;
  run: (app: AppContext) => Promise<unknown>;
}

export const JOBS: Job[] = [
  {
    name: "restaurant_acceptance_timeout",
    everyMs: 15_000,
    async run(app) {
      const timeout = await getSetting<number>(app.db, "restaurant_acceptance_timeout_s", 240);
      const stale = (await app.db.query<{ id: string }>("select id from orders where status = 'placed' and placed_at < now() - ($1 || ' seconds')::interval", [String(timeout)])).rows;
      for (const o of stale) await rejectOrder(app, o.id, "system", null, "acceptance_timeout").catch((e) => log.warn("timeout_reject_failed", { orderId: o.id, error: String(e) }));
      return stale.length;
    },
  },
  {
    name: "dispatch_retry",
    everyMs: 20_000,
    async run(app) {
      const jobs = (await app.db.query<{ id: string }>("select id from delivery_jobs where status = 'unassigned' order by created_at limit 50")).rows;
      let assigned = 0;
      for (const j of jobs) {
        const d = await dispatchJob(app, j.id).catch(() => null);
        if (d?.assignment) assigned++;
      }
      return { pending: jobs.length, assigned };
    },
  },
  {
    name: "claims_become_deductible",
    everyMs: 60 * 60_000,
    async run(app) {
      return (await app.db.query("update compensation_claims set status = 'deductible' where status = 'open' and deductible_after is not null and deductible_after <= now()")).rowCount;
    },
  },
  { name: "abu9_plus_renewals", everyMs: 10 * 60_000, run: runRenewals },
  { name: "abu9_plus_revenue_recognition", everyMs: 60 * 60_000, run: recognizePlusRevenue },
  {
    name: "points_expiry",
    everyMs: 60 * 60_000,
    async run(app) {
      const lots = (await app.db.query<{ id: string; user_id: string; remaining: number }>("select id, user_id, remaining from points_lots where remaining > 0 and expires_at <= now() limit 500")).rows;
      for (const l of lots)
        await app.db.tx(async (q) => {
          await q.query("update points_lots set remaining = 0 where id = $1", [l.id]);
          await q.query("insert into points_transactions(user_id, delta, kind, lot_id) values ($1,$2,'expire',$3)", [l.user_id, -l.remaining, l.id]);
        });
      return lots.length;
    },
  },
  {
    name: "restaurant_billing_cycle",
    everyMs: 60 * 60_000,
    async run(app) {
      // Trial → paid on day 31; at each cycle close: invoice, and propose (never force) a plan change.
      const due = (await app.db.query<{ id: string; restaurant_id: string; plan_code: string; status: string; current_period_start: Date; current_period_end: Date; custom_monthly_price: number | null }>(
        "select * from restaurant_subscriptions where status in ('trialing','active') and current_period_end <= now()",
      )).rows;
      for (const s of due) {
        const orders = (await app.db.query<{ n: number }>("select count(*)::int n from orders where restaurant_id = $1 and status = 'delivered' and created_at >= $2 and created_at < $3", [s.restaurant_id, s.current_period_start, s.current_period_end])).rows[0]!.n;
        const nextStart = s.current_period_end;
        const nextEnd = addInterval(nextStart, "month");
        await app.db.tx(async (q) => {
          // Apply a plan change only if the owner consented to a proposal effective now.
          const consented = (await q.query<{ to_plan: string }>("select to_plan from plan_change_proposals where restaurant_id = $1 and status = 'accepted' and effective_at <= now() order by decided_at desc limit 1", [s.restaurant_id])).rows[0];
          const plan = consented?.to_plan ?? s.plan_code;
          await q.query("update restaurant_subscriptions set status = 'active', plan_code = $2, current_period_start = $3, current_period_end = $4 where id = $1", [s.id, plan, nextStart, nextEnd]);
          const price = plan === "enterprise" ? s.custom_monthly_price : RESTAURANT_PLANS.find((p) => p.code === plan)!.monthlyPrice;
          if (price) {
            // ASSUMPTION (confirm with finance): B2B plan prices are quoted excluding 15% VAT.
            const vat = Math.round(price * 0.15);
            const gross = price + vat;
            const inv = (await q.query<{ id: string }>("insert into restaurant_invoices(restaurant_id, subscription_id, period_start, period_end, plan_code, amount, vat) values ($1,$2,$3,$4,$5,$6,$7) on conflict do nothing returning id", [s.restaurant_id, s.id, nextStart, nextEnd, plan, gross, vat])).rows[0];
            if (inv) await postEntry(q, postRestaurantSubscriptionInvoice({ invoiceId: inv.id, restaurantId: s.restaurant_id, gross, vat, occurredAt: app.now() }));
          }
          const proposal = s.status === "trialing" ? null : evaluatePlanAtCycleClose(plan as "starter", orders, nextEnd);
          if (proposal) {
            await q.query("insert into plan_change_proposals(restaurant_id, from_plan, to_plan, reason, effective_at, notified_at) values ($1,$2,$3,$4,$5,now())", [s.restaurant_id, proposal.fromPlan, proposal.toPlan, proposal.reason, proposal.effectiveAt]);
            const owners = (await q.query<{ user_id: string }>("select user_id from restaurant_members where restaurant_id = $1 and role = 'owner'", [s.restaurant_id])).rows;
            for (const o of owners) await notify(app, q, o.user_id, { kind: "plan_change_proposal", titleAr: "اقتراح تغيير الباقة عند التجديد القادم", bodyAr: "لن يتم أي تغيير بدون موافقتك.", data: proposal as unknown as Record<string, unknown> });
          }
        });
      }
      return due.length;
    },
  },
];

export function startJobs(app: AppContext): () => void {
  const timers: NodeJS.Timeout[] = [];
  JOBS.forEach((job, i) => {
    let running = false;
    const tick = async () => {
      if (running) return;
      running = true;
      try {
        // Transaction-scoped lock on a dedicated connection: released automatically at commit,
        // so a crashed run can never leave the lock held.
        await app.db.tx(async (q) => {
          const got = (await q.query<{ ok: boolean }>("select pg_try_advisory_xact_lock(hashtext($1)) ok", [job.name])).rows[0]!.ok;
          if (!got) return;
          const result = await job.run(app);
          log.debug("job.ran", { job: job.name, result });
        });
      } catch (e) {
        log.error("job.failed", { job: job.name, error: String(e) });
      } finally {
        running = false;
      }
    };
    timers.push(setTimeout(() => void tick(), 2_000 + i * 500));
    timers.push(setInterval(() => void tick(), job.everyMs));
  });
  return () => timers.forEach((t) => clearInterval(t));
}
