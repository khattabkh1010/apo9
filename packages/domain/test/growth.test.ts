import { test } from "node:test";
import assert from "node:assert/strict";
import { quoteEarn, planRedemption, refundAdjustments, LoyaltyError, type Campaign } from "../src/loyalty.ts";
import { evaluatePromotion, type Promotion } from "../src/promotions.ts";
import {
  assignPriceVariant,
  PLUS_PRICE_EXPERIMENT,
  applyPlusEvent,
  plusBenefitsActive,
  addInterval,
  evaluatePlanAtCycleClose,
  planForVolume,
  trialEndsAt,
  type PlusSubscription,
} from "../src/subscriptions.ts";
import { recoveryPath, suggestedRefund } from "../src/refunds.ts";
import { buildStatement, weeklyPeriodContaining, monthlyPeriodContaining, logisticsCompensation } from "../src/settlements.ts";
import { assertOrderTransition, canTransitionOrder, assertJobTransition } from "../src/order-state.ts";
import { evaluateCoverage, type Zone } from "../src/coverage.ts";

const now = new Date("2026-10-14T16:00:00Z");
const later = new Date("2026-12-01T00:00:00Z");

const campaign = (over: Partial<Campaign> = {}): Campaign => ({
  id: "c1", restaurantId: "r1", status: "active", multiplier: 3, budget: 1000, spent: 0,
  abu9ShareBps: 5000, restaurantShareBps: 5000, startsAt: new Date("2026-01-01"), endsAt: later, ...over,
});

test("loyalty: campaign points never exceed remaining budget", () => {
  const q = quoteEarn({ eligibleFoodNet: 10_000, restaurantId: "r1", campaigns: [campaign({ spent: 950 })], earnedToday: 0, at: now });
  assert.equal(q.basePoints, 100);
  assert.equal(q.campaignPoints, 50); // wanted 200, only 50 halalas left
  assert.equal(q.cappedByBudget, true);
  assert.equal(q.campaignFunding.abu9 + q.campaignFunding.restaurant, 50);
});

test("loyalty: daily earn cap", () => {
  const q = quoteEarn({ eligibleFoodNet: 100_000, restaurantId: "r1", campaigns: [], earnedToday: 1900, at: now });
  assert.equal(q.basePoints, 100);
  assert.equal(q.cappedByDailyLimit, true);
});

test("loyalty: redemption consumes soonest-expiring lots and respects max share", () => {
  const lots = [
    { id: "late", remaining: 2000, expiresAt: later },
    { id: "soon", remaining: 300, expiresAt: new Date("2026-11-01") },
    { id: "dead", remaining: 999, expiresAt: new Date("2026-01-01") },
  ];
  const p = planRedemption({ requestedPoints: 5000, foodNet: 5000, lots, at: now });
  assert.equal(p.points, 1500); // 30% of SAR 50
  assert.deepEqual(p.consumed, [{ lotId: "soon", points: 300 }, { lotId: "late", points: 1200 }]);
  assert.throws(() => planRedemption({ requestedPoints: 100, foodNet: 5000, lots, at: now }), LoyaltyError);
  assert.deepEqual(refundAdjustments({ earnedOnOrder: 80, redeemedOnOrder: 500, refundShareBps: 10_000 }), { reverseEarned: 80, restoreRedeemed: 500 });
});

const promo = (over: Partial<Promotion> = {}): Promotion => ({
  id: "p", code: "WELCOME", restaurantId: null, kind: "percent", value: 2000, maxDiscount: 1500, minFoodSubtotal: 3000,
  abu9ShareBps: 10_000, restaurantShareBps: 0, budget: 100_000, spent: 0, perCustomerLimit: 1, firstOrderOnly: true,
  startsAt: new Date("2026-01-01"), endsAt: later, active: true, ...over,
});

test("promotions: cap, budget, limits", () => {
  const ok = evaluatePromotion(promo(), { restaurantId: "r", foodSubtotal: 10_000, at: now, customerUses: 0, customerOrderCount: 0 });
  assert.equal(ok.discount, 1500);
  assert.equal(evaluatePromotion(promo(), { restaurantId: "r", foodSubtotal: 10_000, at: now, customerUses: 0, customerOrderCount: 2 }).rejection, "first_order_only");
  const nearlyGone = evaluatePromotion(promo({ spent: 99_900 }), { restaurantId: "r", foodSubtotal: 10_000, at: now, customerUses: 0, customerOrderCount: 0 });
  assert.equal(nearlyGone.discount, 100);
  assert.equal(evaluatePromotion(promo({ spent: 100_000 }), { restaurantId: "r", foodSubtotal: 10_000, at: now, customerUses: 0, customerOrderCount: 0 }).rejection, "budget_exhausted");
  const split = evaluatePromotion(promo({ abu9ShareBps: 3000, restaurantShareBps: 7000, firstOrderOnly: false }), { restaurantId: "r", foodSubtotal: 5000, at: now, customerUses: 0, customerOrderCount: 3 });
  assert.deepEqual(split.funding, { abu9: 300, restaurant: 700 });
});

test("ABU9+: sticky price experiment assignment covers all variants", () => {
  const seen = new Set<string>();
  for (let i = 0; i < 300; i++) seen.add(assignPriceVariant(`user-${i}`, "plus-2026q4", PLUS_PRICE_EXPERIMENT).id);
  assert.equal(seen.size, 3);
  assert.equal(assignPriceVariant("u-42", "plus-2026q4", PLUS_PRICE_EXPERIMENT).id, assignPriceVariant("u-42", "plus-2026q4", PLUS_PRICE_EXPERIMENT).id);
});

test("ABU9+: lifecycle — renewal, failure grace, cancel keeps benefits to period end", () => {
  const s: PlusSubscription = { id: "s", userId: "u", status: "active", priceVariantId: "v", currentPeriodStart: new Date("2026-10-01T00:00:00Z"), currentPeriodEnd: new Date("2026-10-31T00:00:00Z"), cancelAtPeriodEnd: false, pastDueSince: null };
  assert.equal(plusBenefitsActive(s, now), true);
  const failed = applyPlusEvent(s, { type: "renewal_failed", at: new Date("2026-10-31T00:00:00Z") });
  assert.equal(plusBenefitsActive(failed, new Date("2026-11-01T00:00:00Z")), true);
  assert.equal(plusBenefitsActive(failed, new Date("2026-11-04T00:00:01Z")), false);
  assert.equal(applyPlusEvent(failed, { type: "grace_expired", at: new Date() }).status, "expired");
  const cancelled = applyPlusEvent(s, { type: "cancel_requested", at: now });
  assert.equal(plusBenefitsActive(cancelled, now), true);
  assert.equal(applyPlusEvent(cancelled, { type: "period_ended", at: s.currentPeriodEnd }).status, "expired");
  assert.equal(addInterval(new Date("2027-01-31T00:00:00Z"), "month").toISOString(), "2027-02-28T00:00:00.000Z");
});

test("restaurant plans: no mid-cycle charge, consent-gated change at renewal", () => {
  assert.equal(planForVolume(300).code, "starter");
  assert.equal(planForVolume(301).code, "growth");
  assert.equal(planForVolume(3001).code, "enterprise");
  const p = evaluatePlanAtCycleClose("starter", 450, later);
  assert.deepEqual({ to: p?.toPlan, consent: p?.requiresConsent, at: p?.effectiveAt }, { to: "growth", consent: true, at: later });
  assert.equal(evaluatePlanAtCycleClose("growth", 600, later), null);
  assert.equal(trialEndsAt(new Date("2026-10-01T00:00:00Z")).toISOString(), "2026-10-31T00:00:00.000Z");
});

test("refunds: no automatic partner deduction without contract + dispute window", () => {
  assert.equal(recoveryPath({ fault: "restaurant", reasonCode: "missing_item", openedAt: now, terms: null }).kind, "absorb");
  assert.equal(recoveryPath({ fault: "restaurant", reasonCode: "food_quality", openedAt: now, terms: { autoDeductReasonCodes: ["missing_item"], disputeWindowHours: 72 } }).kind, "absorb");
  const p = recoveryPath({ fault: "restaurant", reasonCode: "missing_item", openedAt: now, terms: { autoDeductReasonCodes: ["missing_item"], disputeWindowHours: 72 } });
  assert.equal(p.kind, "claim_pending");
  assert.equal(recoveryPath({ fault: "customer", reasonCode: "wrong_address", openedAt: now, terms: null }).kind, "none");
  assert.equal(suggestedRefund({ reasonCode: "very_late", affectedAmount: 8000 }), 2000);
});

test("settlements: disputed deductions withheld, undisputed balance paid", () => {
  const s = buildStatement(
    [
      { kind: "order_payable", amount: 50_000, refId: "o1", disputed: false },
      { kind: "compensation_recovery", amount: -3_000, refId: "c1", disputed: true },
      { kind: "compensation_recovery", amount: -1_000, refId: "c2", disputed: false },
      { kind: "subscription_invoice_netting", amount: -69_900, refId: "inv", disputed: false },
    ],
    { allowSubscriptionNetting: false },
  );
  assert.equal(s.netPayable, 49_000);
  assert.equal(s.withheldDisputed, 3_000);
});

test("settlement periods are in Riyadh time", () => {
  // Wed 14 Oct 2026 19:00 Riyadh → week Sun 11 Oct 00:00 Riyadh = Sat 10 Oct 21:00Z
  const w = weeklyPeriodContaining(now);
  assert.equal(w.start.toISOString(), "2026-10-10T21:00:00.000Z");
  // 31 Oct 22:30Z is already 1 Nov 01:30 in Riyadh → November period
  const m = monthlyPeriodContaining(new Date("2026-10-31T22:30:00Z"));
  assert.equal(m.start.toISOString(), "2026-10-31T21:00:00.000Z");
  assert.equal(logisticsCompensation({ perOrder: 1200, perBatchedOrder: 700, perKmBeyond: 100, includedKm: 3, committedHourlyMinimum: 0 }, { distanceKm: 4.2, batchedSecond: true }), 900);
});

test("order state machine enforces actors", () => {
  assert.equal(canTransitionOrder("placed", "accepted", "restaurant"), true);
  assert.equal(canTransitionOrder("placed", "accepted", "customer"), false);
  assert.throws(() => assertOrderTransition("delivered", "cancelled", "ops"));
  assert.throws(() => assertJobTransition("delivered", "assigned"));
  assertJobTransition("assigned", "unassigned"); // reassignment allowed
});

test("coverage is per branch-zone, not a global radius", () => {
  const zone: Zone = { id: "z", code: "OLAYA", nameAr: "العليا", nameEn: "Olaya", status: "active", slaMinutes: 45, polygon: [{ lat: 24.6, lng: 46.6 }, { lat: 24.6, lng: 46.8 }, { lat: 24.8, lng: 46.8 }, { lat: 24.8, lng: 46.6 }] };
  const base = {
    dropoff: { lat: 24.7, lng: 46.7 },
    branch: { id: "b1", isOpen: true, prepMinutes: 12 },
    zones: [zone],
    capacity: [{ zoneId: "z", availableCouriers: 5, openDeliveries: 3, maxLoadFactor: 1.6 }],
    route: { distanceKm: 4, durationMin: 12, source: "heuristic" as const },
    expectedCourierToPickupMin: 8,
  };
  assert.equal(evaluateCoverage({ ...base, rules: [{ branchId: "b1", zoneId: "z", enabled: true, maxRoadKm: 6, maxTravelMinutes: 20 }] }).eligible, true);
  assert.deepEqual(evaluateCoverage({ ...base, rules: [{ branchId: "b1", zoneId: "z", enabled: true, maxRoadKm: 3, maxTravelMinutes: 20 }] }).reasons, ["distance_exceeds_branch_limit"]);
  assert.deepEqual(evaluateCoverage({ ...base, rules: [] }).reasons, ["branch_not_serving_zone"]);
  const saturated = evaluateCoverage({ ...base, rules: [{ branchId: "b1", zoneId: "z", enabled: true, maxRoadKm: 6, maxTravelMinutes: 20 }], capacity: [{ zoneId: "z", availableCouriers: 2, openDeliveries: 4, maxLoadFactor: 1.6 }] });
  assert.ok(saturated.reasons.includes("no_courier_capacity"));
});
