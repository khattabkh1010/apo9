import { test } from "node:test";
import assert from "node:assert/strict";
import { priceOrder, assertBreakdownConsistent, additionalDistanceFee, type DeliveryPricingConfig } from "../src/pricing.ts";
import { allocate, vatIncluded, roundHalalas } from "../src/money.ts";
import { normalizeSaudiMobile } from "../src/phone.ts";

const cfg: DeliveryPricingConfig = {
  basicFee: 900, // SAR 9 covers first 2 km
  baseDistanceKm: 2,
  additionalFeePerIncrement: 100, // SAR 1 per started 0.5 km
  additionalIncrementKm: 0.5,
  serviceFee: 0,
  smallOrderFee: 0,
  smallOrderThreshold: 0,
  vatRateBps: 1500,
};

test("non-member pays basic + additional distance fee", () => {
  const b = priceOrder({ foodSubtotal: 5000, foodDiscount: 0, roadDistanceKm: 3.2, hasActivePlus: false, inActiveCoverage: true, config: cfg });
  assert.equal(b.basicDeliveryFee, 900);
  assert.equal(b.additionalDistanceFee, 300); // 1.2 km → 3 started half-km increments
  assert.equal(b.plusDiscount, 0);
  assert.equal(b.total, 5000 + 900 + 300);
  assert.deepEqual(b.plus.reasons, ["not_member"]);
  assertBreakdownConsistent(b);
});

test("ABU9+ waives ONLY the basic fee; customer still pays distance beyond 2 km", () => {
  const b = priceOrder({ foodSubtotal: 5000, foodDiscount: 0, roadDistanceKm: 4, hasActivePlus: true, inActiveCoverage: true, config: cfg });
  assert.equal(b.plus.eligible, true);
  assert.equal(b.plusDiscount, 900);
  assert.equal(b.additionalDistanceFee, 400);
  assert.equal(b.total, 5000 + 400);
  assert.ok(b.lines.some((l) => l.code === "abu9_plus_discount" && l.amount === -900));
  assertBreakdownConsistent(b);
});

test("ABU9+ within 2 km makes delivery fully free", () => {
  const b = priceOrder({ foodSubtotal: 3500, foodDiscount: 0, roadDistanceKm: 1.9, hasActivePlus: true, inActiveCoverage: true, config: cfg });
  assert.equal(b.total, 3500);
});

test("ABU9+ minimum basket is evaluated AFTER food discounts", () => {
  const b = priceOrder({ foodSubtotal: 4000, foodDiscount: 600, roadDistanceKm: 1, hasActivePlus: true, inActiveCoverage: true, config: cfg });
  assert.equal(b.foodNet, 3400);
  assert.equal(b.plus.eligible, false);
  assert.deepEqual(b.plus.reasons, ["below_minimum_basket"]);
  assert.equal(b.plus.amountToQualify, 100);
  assert.equal(b.total, 3400 + 900);
});

test("exactly SAR 35 qualifies", () => {
  const b = priceOrder({ foodSubtotal: 3500, foodDiscount: 0, roadDistanceKm: 2, hasActivePlus: true, inActiveCoverage: true, config: cfg });
  assert.equal(b.plus.eligible, true);
  assert.equal(b.additionalDistanceFee, 0);
});

test("ABU9+ benefit requires active coverage", () => {
  const b = priceOrder({ foodSubtotal: 9000, foodDiscount: 0, roadDistanceKm: 1, hasActivePlus: true, inActiveCoverage: false, config: cfg });
  assert.equal(b.plus.eligible, false);
  assert.ok(b.plus.reasons.includes("outside_coverage"));
});

test("additional fee cap and float boundaries", () => {
  assert.equal(additionalDistanceFee(2.5, cfg), 100);
  assert.equal(additionalDistanceFee(2.50000001, cfg), 100);
  assert.equal(additionalDistanceFee(2.51, cfg), 200);
  assert.equal(additionalDistanceFee(20, { ...cfg, additionalFeeCap: 1500 }), 1500);
});

test("VAT is extracted from inclusive amounts, breakdown stays consistent", () => {
  assert.equal(vatIncluded(11500, 1500), 1500);
  const b = priceOrder({ foodSubtotal: 11500, foodDiscount: 0, roadDistanceKm: 3, hasActivePlus: false, inActiveCoverage: true, config: { ...cfg, serviceFee: 200, smallOrderFee: 300, smallOrderThreshold: 2000 } });
  assert.equal(b.smallOrderFee, 0);
  assert.equal(b.vatOnFood, 1500);
  assertBreakdownConsistent(b);
});

test("rejects discount larger than subtotal", () => {
  assert.throws(() => priceOrder({ foodSubtotal: 1000, foodDiscount: 1001, roadDistanceKm: 1, hasActivePlus: false, inActiveCoverage: true, config: cfg }));
});

test("allocate always sums exactly", () => {
  for (const total of [1, 7, 100, 999, 12345]) {
    const parts = allocate(total, [3333, 3333, 3334]);
    assert.equal(parts.reduce((a, b) => a + b, 0), total);
  }
  assert.equal(roundHalalas(2.5), 2);
  assert.equal(roundHalalas(3.5), 4);
});

test("Saudi mobile normalisation", () => {
  assert.equal(normalizeSaudiMobile("0551234567"), "+966551234567");
  assert.equal(normalizeSaudiMobile("+966 55 123 4567"), "+966551234567");
  assert.equal(normalizeSaudiMobile("00966551234567"), "+966551234567");
  assert.equal(normalizeSaudiMobile("٠٥٥١٢٣٤٥٦٧"), "+966551234567");
  assert.equal(normalizeSaudiMobile("0112345678"), null); // landline
  assert.equal(normalizeSaudiMobile("05512"), null);
});
