import { test } from "node:test";
import assert from "node:assert/strict";
import { NearestFeasibleStrategy, DEFAULT_BATCHING, type CourierCandidate, type DispatchJob, type DispatchContext } from "../src/dispatch.ts";
import type { LatLng, RoutingProvider } from "../src/geo.ts";
import { haversineKm } from "../src/geo.ts";

// Deterministic routing for tests: road km = straight km × 1.3, 30 km/h.
const routing: RoutingProvider = {
  route(a: LatLng, b: LatLng) {
    const km = haversineKm(a, b) * 1.3;
    return { distanceKm: km, durationMin: (km / 30) * 60, source: "heuristic" };
  },
};

const now = new Date("2026-10-14T16:00:00Z");
const min = (m: number) => new Date(now.getTime() + m * 60_000);
// ~0.009° lat ≈ 1 km. Olaya-ish coordinates (fictional points).
const at = (dLatKm: number, dLngKm: number): LatLng => ({ lat: 24.69 + dLatKm * 0.009, lng: 46.685 + dLngKm * 0.0099 });

const ctx = (over: Partial<DispatchContext> = {}): DispatchContext => ({ now, routing, batching: DEFAULT_BATCHING, ...over });

function job(id: string, pickup: LatLng, dropoff: LatLng, readyIn = 10, deadlineIn = 45): DispatchJob {
  return { id, orderId: `o-${id}`, branchId: "b1", pickup, dropoff, readyAt: min(readyIn), promisedBy: min(deadlineIn) };
}
function courier(id: string, loc: LatLng, extra: Partial<CourierCandidate> = {}): CourierCandidate {
  return { id, logisticsCompanyId: "lc1", capacityType: "committed", location: loc, online: true, activeLegs: [], ...extra };
}

const strategy = new NearestFeasibleStrategy();

test("assigns the nearest feasible idle courier and explains why", async () => {
  const j = job("j1", at(0, 0), at(2, 0));
  const d = await strategy.decide(j, [courier("far", at(6, 0)), courier("near", at(0.5, 0)), courier("off", at(0, 0), { online: false })], ctx());
  assert.equal(d.assignment?.courierId, "near");
  assert.equal(d.assignment?.mode, "single");
  assert.ok(d.assignment!.explanation.length >= 3);
  assert.ok(d.rejected.some((r) => r.courierId === "off" && r.reason === "offline"));
});

test("is deterministic for identical inputs", async () => {
  const j = job("j1", at(0, 0), at(2, 0));
  const cs = [courier("a", at(1, 0)), courier("b", at(0, 1))];
  const d1 = await strategy.decide(j, cs, ctx());
  const d2 = await strategy.decide(j, [...cs].reverse(), ctx());
  assert.equal(d1.assignment?.courierId, d2.assignment?.courierId);
});

test("never knowingly violates the promised deadline", async () => {
  const j = job("j1", at(0, 0), at(3, 0), 10, 14);
  const d = await strategy.decide(j, [courier("c", at(5, 0))], ctx());
  assert.equal(d.assignment, null);
  assert.match(d.rejected[0]!.reason, /would_miss_deadline/);
});

test("skips couriers who rejected the job", async () => {
  const j = job("j1", at(0, 0), at(1, 0));
  const d = await strategy.decide(j, [courier("c", at(0, 0), { rejectedJobIds: ["j1"] }), courier("d", at(2, 0))], ctx());
  assert.equal(d.assignment?.courierId, "d");
});

test("batches two orders from the same restaurant going the same way", async () => {
  const A = job("A", at(0, 0), at(2, 0), 8, 40);
  const B = job("B", at(0, 0), at(2.3, 0.1), 9, 40);
  const busy = courier("busy", at(0.2, 0), { activeLegs: [{ job: A, pickedUp: false }] });
  const d = await strategy.decide(B, [busy], ctx());
  assert.equal(d.assignment?.mode, "batched");
  assert.equal(d.assignment?.batchedWithJobId, "A");
  assert.equal(d.assignment!.plan.length, 4);
});

test("refuses a batch whose detour on the existing order exceeds 2 km", async () => {
  const A = job("A", at(0, 0), at(2, 0), 0, 60);
  const B = job("B", at(0, 0), at(-4, 0), 0, 60); // opposite direction
  const busy = courier("busy", at(0, 0), { activeLegs: [{ job: A, pickedUp: true }] });
  // Disallow the "chained" plan by giving B a tight deadline that only an immediate detour could meet.
  const tightB = { ...B, promisedBy: min(14) };
  const d = await strategy.decide(tightB, [busy], ctx());
  assert.equal(d.assignment, null);
  assert.match(d.rejected[0]!.reason, /no_valid_batch/);
});

test("added-delay limit is configurable", async () => {
  const A = job("A", at(0, 0), at(3, 0), 0, 60);
  const B = job("B", at(0.5, 0.5), at(3.2, 0.3), 0, 25);
  const busy = courier("busy", at(0, 0), { activeLegs: [{ job: A, pickedUp: false }] });
  const strict = await strategy.decide(B, [busy], ctx({ batching: { ...DEFAULT_BATCHING, maxAddedDelayMin: 0.1, maxDetourKm: 0.1 } }));
  const loose = await strategy.decide(B, [busy], ctx());
  assert.equal(strict.assignment, null);
  assert.equal(loose.assignment?.mode, "batched");
});

test("never gives a courier a third order", async () => {
  const A = job("A", at(0, 0), at(1, 0));
  const B = job("B", at(0, 0), at(1, 0));
  const C = job("C", at(0, 0), at(1, 0));
  const full = courier("full", at(0, 0), { activeLegs: [{ job: A, pickedUp: false }, { job: B, pickedUp: false }] });
  const d = await strategy.decide(C, [full], ctx());
  assert.equal(d.assignment, null);
  assert.equal(d.rejected[0]!.reason, "at_capacity");
});

test("batching disabled → busy couriers are not considered", async () => {
  const A = job("A", at(0, 0), at(1, 0));
  const B = job("B", at(0, 0), at(1, 0));
  const busy = courier("busy", at(0, 0), { activeLegs: [{ job: A, pickedUp: false }] });
  const d = await strategy.decide(B, [busy], ctx({ batching: { ...DEFAULT_BATCHING, enabled: false } }));
  assert.equal(d.assignment, null);
});

test("prefers committed capacity at equal distance and suggests departure aligned to prep", async () => {
  const j = job("j", at(0, 0), at(1, 0), 25, 60);
  const d = await strategy.decide(j, [courier("od", at(1, 0), { capacityType: "on_demand" }), courier("cm", at(-1, 0))], ctx());
  assert.equal(d.assignment?.courierId, "cm");
  assert.ok(d.assignment!.suggestedDepartAt > now, "should suggest leaving later since food is ready in 25 min");
});
