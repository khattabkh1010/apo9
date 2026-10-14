import type { LatLng, RoutingProvider } from "./geo.ts";

/**
 * Dispatch engine.
 *
 * Strategies implement `DispatchStrategy` so optimisation can be replaced over time
 * (e.g. batch assignment / Hungarian matching / learned ETAs) without touching callers.
 * The initial strategy is deterministic and explainable — every decision carries the
 * reasons it was made and why other couriers were rejected. There is no ML here.
 */

export interface DispatchJob {
  id: string;
  orderId: string;
  branchId: string;
  pickup: LatLng;
  dropoff: LatLng;
  /** When the restaurant expects the food to be ready. */
  readyAt: Date;
  /** Promised delivery deadline communicated to the customer. Never knowingly violated. */
  promisedBy: Date;
}

export interface ActiveLeg {
  job: DispatchJob;
  pickedUp: boolean;
}

export interface CourierCandidate {
  id: string;
  logisticsCompanyId: string;
  /** Committed-baseline couriers are preferred over on-demand peak capacity at equal quality. */
  capacityType: "committed" | "on_demand";
  location: LatLng;
  online: boolean;
  activeLegs: ActiveLeg[];
  /** Jobs this courier already rejected — never re-offer the same job. */
  rejectedJobIds?: string[];
}

export interface BatchingConfig {
  enabled: boolean;
  /** Hard cap: maximum simultaneous orders per courier. Business rule = 2. */
  maxOrdersPerCourier: number;
  /** Max extra km imposed on the existing order's route before it is delivered. Proposed = 2. */
  maxDetourKm: number;
  /** Max extra minutes added to the existing order's delivery. Proposed = 7. */
  maxAddedDelayMin: number;
}

export const DEFAULT_BATCHING: BatchingConfig = {
  enabled: true,
  maxOrdersPerCourier: 2,
  maxDetourKm: 2,
  maxAddedDelayMin: 7,
};

export interface DispatchContext {
  now: Date;
  routing: RoutingProvider;
  batching: BatchingConfig;
  handoverMinAtPickup?: number;
  handoverMinAtDropoff?: number;
}

export type StopKind = "pickup" | "dropoff";
export interface PlannedStop {
  jobId: string;
  kind: StopKind;
  at: LatLng;
  etaAt: Date;
}

export interface Assignment {
  courierId: string;
  logisticsCompanyId: string;
  mode: "single" | "batched";
  batchedWithJobId: string | null;
  plan: PlannedStop[];
  /** Hint to the courier: leave now / by this time to arrive as food is ready. */
  suggestedDepartAt: Date;
  newJobEta: Date;
  score: number;
  explanation: string[];
}

export interface RejectedCandidate {
  courierId: string;
  reason: string;
}

export interface DispatchDecision {
  jobId: string;
  strategy: string;
  assignment: Assignment | null;
  rejected: RejectedCandidate[];
  decidedAt: Date;
}

export interface DispatchStrategy {
  readonly name: string;
  decide(job: DispatchJob, candidates: CourierCandidate[], ctx: DispatchContext): Promise<DispatchDecision>;
}

const MIN = 60_000;

interface SimResult {
  stops: PlannedStop[];
  deliverAt: Map<string, Date>;
  kmUntil: Map<string, number>;
  totalKm: number;
  firstLegMin: number;
}

async function simulate(
  start: LatLng,
  sequence: Array<{ job: DispatchJob; kind: StopKind }>,
  ctx: DispatchContext,
): Promise<SimResult> {
  const hp = ctx.handoverMinAtPickup ?? 2;
  const hd = ctx.handoverMinAtDropoff ?? 3;
  let t = ctx.now.getTime();
  let pos = start;
  let km = 0;
  let firstLegMin = 0;
  const stops: PlannedStop[] = [];
  const deliverAt = new Map<string, Date>();
  const kmUntil = new Map<string, number>();
  for (let i = 0; i < sequence.length; i++) {
    const s = sequence[i]!;
    const target = s.kind === "pickup" ? s.job.pickup : s.job.dropoff;
    const leg = await ctx.routing.route(pos, target, new Date(t));
    if (i === 0) firstLegMin = leg.durationMin;
    t += leg.durationMin * MIN;
    km += leg.distanceKm;
    if (s.kind === "pickup") {
      t = Math.max(t, s.job.readyAt.getTime());
      stops.push({ jobId: s.job.id, kind: "pickup", at: target, etaAt: new Date(t) });
      t += hp * MIN;
    } else {
      stops.push({ jobId: s.job.id, kind: "dropoff", at: target, etaAt: new Date(t) });
      deliverAt.set(s.job.id, new Date(t));
      kmUntil.set(s.job.id, km);
      t += hd * MIN;
    }
    pos = target;
  }
  return { stops, deliverAt, kmUntil, totalKm: km, firstLegMin };
}

function sequencesFor(existing: ActiveLeg, job: DispatchJob): Array<Array<{ job: DispatchJob; kind: StopKind }>> {
  const A = existing.job;
  const P = (j: DispatchJob) => ({ job: j, kind: "pickup" as const });
  const D = (j: DispatchJob) => ({ job: j, kind: "dropoff" as const });
  if (existing.pickedUp) {
    return [
      [D(A), P(job), D(job)], // chained: finish A first
      [P(job), D(A), D(job)],
      [P(job), D(job), D(A)],
    ];
  }
  return [
    [P(A), D(A), P(job), D(job)], // chained
    [P(A), P(job), D(A), D(job)],
    [P(A), P(job), D(job), D(A)],
    [P(job), P(A), D(A), D(job)],
    [P(job), P(A), D(job), D(A)],
  ];
}

function minutesBetween(a: Date, b: Date): number {
  return (b.getTime() - a.getTime()) / MIN;
}

/**
 * Deterministic, explainable strategy:
 *  1. Consider online couriers below the order cap who have not rejected this job.
 *  2. Idle couriers: plan pickup → dropoff.
 *  3. Couriers with one active order: try every valid stop sequence; keep those that respect
 *     detour ≤ maxDetourKm and added delay ≤ maxAddedDelayMin for the existing order, and
 *     meet BOTH promised deadlines.
 *  4. Score = new order's delivery minutes + 0.5 × courier idle wait at restaurant
 *            + 1 × added delay to existing order − 2 if committed capacity.
 *     Lowest score wins; ties broken by courier id for determinism.
 */
export class NearestFeasibleStrategy implements DispatchStrategy {
  readonly name = "nearest-feasible-v1";

  async decide(job: DispatchJob, candidates: CourierCandidate[], ctx: DispatchContext): Promise<DispatchDecision> {
    const rejected: RejectedCandidate[] = [];
    let best: Assignment | null = null;
    const sorted = [...candidates].sort((a, b) => a.id.localeCompare(b.id));

    for (const c of sorted) {
      if (!c.online) {
        rejected.push({ courierId: c.id, reason: "offline" });
        continue;
      }
      if (c.rejectedJobIds?.includes(job.id)) {
        rejected.push({ courierId: c.id, reason: "courier_previously_rejected_job" });
        continue;
      }
      const cap = Math.min(ctx.batching.enabled ? ctx.batching.maxOrdersPerCourier : 1, 2);
      if (c.activeLegs.length >= cap) {
        rejected.push({ courierId: c.id, reason: "at_capacity" });
        continue;
      }

      let candidate: Assignment | null = null;
      if (c.activeLegs.length === 0) {
        candidate = await this.planSingle(c, job, ctx, rejected);
      } else if (c.activeLegs.length === 1) {
        candidate = await this.planBatched(c, c.activeLegs[0]!, job, ctx, rejected);
      } else {
        rejected.push({ courierId: c.id, reason: "batching_only_supports_one_existing_order" });
      }
      if (candidate && (!best || candidate.score < best.score)) best = candidate;
    }

    return { jobId: job.id, strategy: this.name, assignment: best, rejected, decidedAt: ctx.now };
  }

  private async planSingle(c: CourierCandidate, job: DispatchJob, ctx: DispatchContext, rejected: RejectedCandidate[]): Promise<Assignment | null> {
    const sim = await simulate(c.location, [{ job, kind: "pickup" }, { job, kind: "dropoff" }], ctx);
    const eta = sim.deliverAt.get(job.id)!;
    if (eta > job.promisedBy) {
      rejected.push({ courierId: c.id, reason: `would_miss_deadline_by_${Math.ceil(minutesBetween(job.promisedBy, eta))}_min` });
      return null;
    }
    const arrival = new Date(ctx.now.getTime() + sim.firstLegMin * MIN);
    const idleWait = Math.max(0, minutesBetween(arrival, job.readyAt));
    const deliveryMin = minutesBetween(ctx.now, eta);
    const score = deliveryMin + 0.5 * idleWait - (c.capacityType === "committed" ? 2 : 0);
    const departAt = new Date(Math.max(ctx.now.getTime(), job.readyAt.getTime() - sim.firstLegMin * MIN));
    return {
      courierId: c.id,
      logisticsCompanyId: c.logisticsCompanyId,
      mode: "single",
      batchedWithJobId: null,
      plan: sim.stops,
      suggestedDepartAt: departAt,
      newJobEta: eta,
      score: round2(score),
      explanation: [
        `idle courier ${fmt(sim.firstLegMin)} min from pickup`,
        `estimated delivery in ${fmt(deliveryMin)} min (deadline slack ${fmt(minutesBetween(eta, job.promisedBy))} min)`,
        idleWait > 0 ? `would wait ${fmt(idleWait)} min for food; suggested departure ${departAt.toISOString()}` : "arrives after food is ready",
        c.capacityType === "committed" ? "committed-capacity courier preferred" : "on-demand capacity",
      ],
    };
  }

  private async planBatched(c: CourierCandidate, existing: ActiveLeg, job: DispatchJob, ctx: DispatchContext, rejected: RejectedCandidate[]): Promise<Assignment | null> {
    if (!ctx.batching.enabled) {
      rejected.push({ courierId: c.id, reason: "batching_disabled" });
      return null;
    }
    const A = existing.job;
    const soloSeq = existing.pickedUp
      ? [{ job: A, kind: "dropoff" as const }]
      : [{ job: A, kind: "pickup" as const }, { job: A, kind: "dropoff" as const }];
    const solo = await simulate(c.location, soloSeq, ctx);
    const soloEtaA = solo.deliverAt.get(A.id)!;
    const soloKmA = solo.kmUntil.get(A.id)!;

    let best: Assignment | null = null;
    const reasons: string[] = [];
    for (const seq of sequencesFor(existing, job)) {
      const sim = await simulate(c.location, seq, ctx);
      const etaA = sim.deliverAt.get(A.id)!;
      const etaB = sim.deliverAt.get(job.id)!;
      const detourKm = sim.kmUntil.get(A.id)! - soloKmA;
      const addedDelay = minutesBetween(soloEtaA, etaA);
      if (detourKm > ctx.batching.maxDetourKm + 1e-9) { reasons.push(`detour_${fmt(detourKm)}km`); continue; }
      if (addedDelay > ctx.batching.maxAddedDelayMin + 1e-9) { reasons.push(`added_delay_${fmt(addedDelay)}min`); continue; }
      if (etaA > A.promisedBy) { reasons.push("existing_order_deadline"); continue; }
      if (etaB > job.promisedBy) { reasons.push("new_order_deadline"); continue; }

      const deliveryMin = minutesBetween(ctx.now, etaB);
      const score = deliveryMin + Math.max(0, addedDelay) - (c.capacityType === "committed" ? 2 : 0);
      if (!best || score < best.score) {
        best = {
          courierId: c.id,
          logisticsCompanyId: c.logisticsCompanyId,
          mode: "batched",
          batchedWithJobId: A.id,
          plan: sim.stops,
          suggestedDepartAt: ctx.now,
          newJobEta: etaB,
          score: round2(score),
          explanation: [
            `batched with order ${A.orderId} (${existing.pickedUp ? "already picked up" : "not yet picked up"})`,
            `existing order: detour ${fmt(detourKm)} km (limit ${ctx.batching.maxDetourKm}), added delay ${fmt(addedDelay)} min (limit ${ctx.batching.maxAddedDelayMin})`,
            `new order delivered in ${fmt(deliveryMin)} min; both deadlines respected`,
            `stop order: ${seq.map((s) => `${s.kind === "pickup" ? "P" : "D"}:${s.job.orderId}`).join(" → ")}`,
          ],
        };
      }
    }
    if (!best) rejected.push({ courierId: c.id, reason: `no_valid_batch(${[...new Set(reasons)].join(",")})` });
    return best;
  }
}

function fmt(n: number): string {
  return (Math.round(n * 10) / 10).toString();
}
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
