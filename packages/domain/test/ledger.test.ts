import { test } from "node:test";
import assert from "node:assert/strict";
import {
  postOrderCapture,
  postDeliveryCost,
  postCustomerRefund,
  postPayout,
  postPlusPayment,
  recognizedToDate,
  reversalOf,
  finalizeEntry,
  signedBalance,
  ACCOUNTS,
  LedgerError,
  dr,
  cr,
  type JournalEntryDraft,
} from "../src/ledger.ts";
import { priceOrder } from "../src/pricing.ts";

function balances(entries: JournalEntryDraft[]): Map<string, number> {
  const m = new Map<string, { d: number; c: number }>();
  for (const e of entries)
    for (const l of e.lines) {
      const x = m.get(l.account) ?? { d: 0, c: 0 };
      x.d += l.debit;
      x.c += l.credit;
      m.set(l.account, x);
    }
  return new Map([...m].map(([k, v]) => [k, signedBalance(k, v.d, v.c)]));
}

const pricing = priceOrder({
  foodSubtotal: 8000,
  foodDiscount: 1000,
  roadDistanceKm: 3,
  hasActivePlus: false,
  inActiveCoverage: true,
  config: { basicFee: 900, baseDistanceKm: 2, additionalFeePerIncrement: 100, additionalIncrementKm: 0.5, serviceFee: 0, smallOrderFee: 0, smallOrderThreshold: 0, vatRateBps: 1500 },
});

const capture = postOrderCapture({
  orderId: "o1",
  restaurantId: "r1",
  occurredAt: new Date(),
  totalCharged: pricing.total,
  foodSubtotal: 8000,
  restaurantFundedDiscount: 600,
  abu9FundedDiscount: 400,
  loyaltyRedemption: 0,
  deliveryFeesCharged: pricing.basicDeliveryFee + pricing.additionalDistanceFee - pricing.plusDiscount,
  serviceFeesCharged: 0,
  vatOnPlatformFees: pricing.vatOnPlatformFees,
});

test("order capture is balanced and food is a merchant liability, not revenue", () => {
  const b = balances([capture]);
  assert.equal(b.get(ACCOUNTS.merchantPayable("r1")), 7400);
  assert.equal(b.get(ACCOUNTS.pspClearing), pricing.total);
  const deliveryRevenue = b.get(ACCOUNTS.deliveryFeeRevenue)!;
  assert.equal(deliveryRevenue + b.get(ACCOUNTS.vatPayable)!, 1100);
  assert.equal(b.get(ACCOUNTS.promotionExpense), 400);
  // No account called "food revenue" exists at all:
  assert.ok(![...b.keys()].some((k) => k.startsWith("revenue:") && k.includes("food")));
});

test("batched orders accrue delivery cost per order", () => {
  const e1 = postDeliveryCost({ orderId: "o1", deliveryJobId: "j1", logisticsCompanyId: "lc", occurredAt: new Date(), amount: 1200, batched: true });
  const e2 = postDeliveryCost({ orderId: "o2", deliveryJobId: "j2", logisticsCompanyId: "lc", occurredAt: new Date(), amount: 700, batched: true });
  assert.notEqual(e1.eventKey, e2.eventKey);
  assert.equal(balances([e1, e2]).get(ACCOUNTS.logisticsPayable("lc")), 1900);
});

test("refund funded by ABU9 does not touch merchant payable", () => {
  const r = postCustomerRefund({ refundId: "rf1", orderId: "o1", occurredAt: new Date(), amount: 2000, funding: "abu9", restaurantId: "r1", platformFeePortion: 0, platformFeeVatPortion: 0 });
  const b = balances([capture, r]);
  assert.equal(b.get(ACCOUNTS.merchantPayable("r1")), 7400);
  assert.equal(b.get(ACCOUNTS.customerCompensationExpense), 2000);
});

test("payout reduces payable to zero", () => {
  const p = postPayout({ payoutId: "p1", party: { kind: "restaurant", id: "r1" }, amount: 7400, occurredAt: new Date() });
  assert.equal(balances([capture, p]).get(ACCOUNTS.merchantPayable("r1")), 0);
});

test("reversal nets every account to zero", () => {
  const rev = reversalOf({ ...capture, id: "je1" }, "rev:je1", new Date(), "test");
  for (const [, v] of balances([capture, rev])) assert.equal(v, 0);
});

test("unbalanced, negative and single-line entries are rejected", () => {
  const base = { eventKey: "k", eventType: "t", occurredAt: new Date(), description: "", refType: "x", refId: "y" };
  assert.throws(() => finalizeEntry({ ...base, lines: [dr(ACCOUNTS.bank, 100), cr(ACCOUNTS.vatPayable, 99)] }), LedgerError);
  assert.throws(() => finalizeEntry({ ...base, lines: [dr(ACCOUNTS.bank, -1), cr(ACCOUNTS.vatPayable, -1)] }), LedgerError);
  assert.throws(() => finalizeEntry({ ...base, lines: [dr(ACCOUNTS.bank, 1.5), cr(ACCOUNTS.vatPayable, 1.5)] }), LedgerError);
  assert.throws(() => finalizeEntry({ ...base, lines: [dr(ACCOUNTS.bank, 0), cr(ACCOUNTS.vatPayable, 0)] }), LedgerError);
});

test("ABU9+ revenue is deferred then recognised straight-line", () => {
  const e = postPlusPayment({ invoiceId: "i1", userId: "u1", gross: 2499, vat: 326, occurredAt: new Date() });
  assert.equal(balances([e]).get(ACCOUNTS.deferredSubscriptionRevenue), 2173);
  const start = new Date("2026-10-01T00:00:00Z");
  const end = new Date("2026-10-31T00:00:00Z");
  assert.equal(recognizedToDate(2173, start, end, new Date("2026-10-16T00:00:00Z")), 1086);
  assert.equal(recognizedToDate(2173, start, end, new Date("2027-01-01T00:00:00Z")), 2173);
  assert.equal(recognizedToDate(2173, start, end, new Date("2026-09-01T00:00:00Z")), 0);
});
