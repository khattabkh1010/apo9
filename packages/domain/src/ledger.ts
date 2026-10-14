import type { Halalas } from "./money.ts";

/**
 * Double-entry ledger primitives.
 *
 * - Every financial event produces one balanced journal entry (Σdebits = Σcredits).
 * - Entries are immutable. Corrections are new entries (reversals / adjustments), never edits.
 * - GMV ≠ revenue: food money is a liability to the restaurant (merchant payable), collected on its behalf.
 *
 * Account codes are hierarchical strings; party-scoped accounts append the party id,
 * e.g. `liability:merchant_payable:<restaurantId>`.
 */

export type AccountType = "asset" | "liability" | "revenue" | "expense" | "equity";

export const ACCOUNTS = {
  pspClearing: "asset:psp_clearing", // money captured by PSP, not yet settled to ABU9 bank
  bank: "asset:bank",
  merchantReceivable: (rid: string) => `asset:merchant_receivable:${rid}`, // e.g. unpaid subscription invoices
  merchantPayable: (rid: string) => `liability:merchant_payable:${rid}`,
  logisticsPayable: (lid: string) => `liability:logistics_payable:${lid}`,
  vatPayable: "liability:vat_payable",
  deferredSubscriptionRevenue: "liability:deferred_revenue:abu9_plus",
  customerCredit: (uid: string) => `liability:customer_credit:${uid}`,
  deliveryFeeRevenue: "revenue:delivery_fees",
  serviceFeeRevenue: "revenue:service_fees",
  plusSubscriptionRevenue: "revenue:abu9_plus",
  restaurantSubscriptionRevenue: "revenue:restaurant_subscriptions",
  deliveryCost: "expense:delivery_cost",
  promotionExpense: "expense:promotions",
  loyaltyExpense: "expense:loyalty",
  customerCompensationExpense: "expense:customer_compensation",
  compensationRecovery: "expense:compensation_recovery", // contra-expense (credit balance)
  pspFees: "expense:psp_fees",
} as const;

export function accountType(code: string): AccountType {
  const t = code.split(":")[0];
  if (t === "asset" || t === "liability" || t === "revenue" || t === "expense" || t === "equity") return t;
  throw new Error(`unknown account type in code ${code}`);
}

export interface JournalLine {
  account: string;
  debit: Halalas;
  credit: Halalas;
  memo?: string;
}

export interface JournalEntryDraft {
  /** Idempotency key: the same business event can never be posted twice. */
  eventKey: string;
  eventType: string;
  occurredAt: Date;
  description: string;
  lines: JournalLine[];
  /** Reference to the entity that caused it (order id, settlement id…). */
  refType: string;
  refId: string;
  reversesEntryId?: string;
}

export class LedgerError extends Error {}

export function dr(account: string, amount: Halalas, memo?: string): JournalLine {
  return { account, debit: amount, credit: 0, memo };
}
export function cr(account: string, amount: Halalas, memo?: string): JournalLine {
  return { account, debit: 0, credit: amount, memo };
}

/** Validate and normalise an entry: drop zero lines, reject negatives and imbalance. */
export function finalizeEntry(e: JournalEntryDraft): JournalEntryDraft {
  const lines = e.lines.filter((l) => l.debit !== 0 || l.credit !== 0);
  for (const l of lines) {
    if (!Number.isSafeInteger(l.debit) || !Number.isSafeInteger(l.credit)) throw new LedgerError(`non-integer amount on ${l.account}`);
    if (l.debit < 0 || l.credit < 0) throw new LedgerError(`negative amount on ${l.account}`);
    if (l.debit > 0 && l.credit > 0) throw new LedgerError(`line on ${l.account} has both debit and credit`);
    accountType(l.account);
  }
  const d = lines.reduce((a, l) => a + l.debit, 0);
  const c = lines.reduce((a, l) => a + l.credit, 0);
  if (d !== c) throw new LedgerError(`unbalanced entry ${e.eventKey}: debits ${d} ≠ credits ${c}`);
  if (lines.length < 2) throw new LedgerError(`entry ${e.eventKey} needs at least two lines`);
  return { ...e, lines };
}

/** A reversal mirrors every line of the original. */
export function reversalOf(original: JournalEntryDraft & { id: string }, eventKey: string, occurredAt: Date, reason: string): JournalEntryDraft {
  return finalizeEntry({
    eventKey,
    eventType: `${original.eventType}.reversal`,
    occurredAt,
    description: `Reversal of ${original.id}: ${reason}`,
    refType: original.refType,
    refId: original.refId,
    reversesEntryId: original.id,
    lines: original.lines.map((l) => ({ account: l.account, debit: l.credit, credit: l.debit, memo: `reversal: ${l.memo ?? ""}` })),
  });
}

/** Normal balance: assets/expenses are debit-normal; liabilities/revenue/equity credit-normal. */
export function signedBalance(account: string, debit: Halalas, credit: Halalas): Halalas {
  const t = accountType(account);
  return t === "asset" || t === "expense" ? debit - credit : credit - debit;
}

// ─────────────────────────── Posting rules ───────────────────────────

export interface OrderCaptureFacts {
  orderId: string;
  restaurantId: string;
  occurredAt: Date;
  /** Amount captured from the customer. */
  totalCharged: Halalas;
  foodSubtotal: Halalas;
  /** Food discounts funded by the restaurant (reduce merchant payable). */
  restaurantFundedDiscount: Halalas;
  /** Food discounts funded by ABU9 (promotion expense; merchant still receives full value). */
  abu9FundedDiscount: Halalas;
  /** Loyalty points redeemed as food discount, funded by ABU9. */
  loyaltyRedemption: Halalas;
  /** Platform fees actually charged (VAT-inclusive). */
  deliveryFeesCharged: Halalas;
  serviceFeesCharged: Halalas;
  vatOnPlatformFees: Halalas;
}

/**
 * At payment capture:
 *   Dr psp_clearing                    totalCharged
 *   Dr promotions expense              ABU9-funded food discount
 *   Dr loyalty expense                 points redeemed
 *   Cr merchant_payable[restaurant]    food subtotal − restaurant-funded discount   (NOT revenue)
 *   Cr delivery_fees revenue           delivery fees net of VAT
 *   Cr service_fees revenue            service fees net of VAT
 *   Cr vat_payable                     VAT on ABU9's own fees
 * Food VAT is the restaurant's and sits inside merchant payable. Marketplace VAT treatment must be
 * confirmed with a KSA tax advisor before launch (see docs/LAUNCH_BLOCKERS.md).
 */
export function postOrderCapture(f: OrderCaptureFacts): JournalEntryDraft {
  const platformGross = f.deliveryFeesCharged + f.serviceFeesCharged;
  const vatDelivery = platformGross === 0 ? 0 : Math.round((f.vatOnPlatformFees * f.deliveryFeesCharged) / platformGross);
  const vatService = f.vatOnPlatformFees - vatDelivery;
  return finalizeEntry({
    eventKey: `order.captured:${f.orderId}`,
    eventType: "order.captured",
    occurredAt: f.occurredAt,
    description: `Payment captured for order ${f.orderId}`,
    refType: "order",
    refId: f.orderId,
    lines: [
      dr(ACCOUNTS.pspClearing, f.totalCharged, "customer payment"),
      dr(ACCOUNTS.promotionExpense, f.abu9FundedDiscount, "ABU9-funded food discount"),
      dr(ACCOUNTS.loyaltyExpense, f.loyaltyRedemption, "points redemption"),
      cr(ACCOUNTS.merchantPayable(f.restaurantId), f.foodSubtotal - f.restaurantFundedDiscount, "food collected on behalf of restaurant"),
      cr(ACCOUNTS.deliveryFeeRevenue, f.deliveryFeesCharged - vatDelivery),
      cr(ACCOUNTS.serviceFeeRevenue, f.serviceFeesCharged - vatService),
      cr(ACCOUNTS.vatPayable, f.vatOnPlatformFees, "VAT on platform fees"),
    ],
  });
}

export interface DeliveryCostFacts {
  orderId: string;
  deliveryJobId: string;
  logisticsCompanyId: string;
  occurredAt: Date;
  /** Contracted compensation for this order (already reflects batch pricing if batched). */
  amount: Halalas;
  batched: boolean;
}

/** Each order in a batch posts its own delivery cost — financial accounting stays per order. */
export function postDeliveryCost(f: DeliveryCostFacts): JournalEntryDraft {
  return finalizeEntry({
    eventKey: `delivery.cost:${f.deliveryJobId}`,
    eventType: "delivery.cost_accrued",
    occurredAt: f.occurredAt,
    description: `Delivery cost for order ${f.orderId}${f.batched ? " (batched trip)" : ""}`,
    refType: "order",
    refId: f.orderId,
    lines: [dr(ACCOUNTS.deliveryCost, f.amount), cr(ACCOUNTS.logisticsPayable(f.logisticsCompanyId), f.amount)],
  });
}

export interface CustomerRefundFacts {
  refundId: string;
  orderId: string;
  occurredAt: Date;
  amount: Halalas;
  /**
   * How the refund is funded *at the time of refund*. Undisputed restaurant-fault items with
   * contractual authorisation may be charged to the restaurant; otherwise ABU9 funds it and
   * recovers later only through the dispute process.
   */
  funding: "abu9" | "restaurant_authorized";
  restaurantId: string;
  /** Portion of the refund that reverses platform fees (reduces revenue rather than compensation expense). */
  platformFeePortion: Halalas;
  platformFeeVatPortion: Halalas;
}

export function postCustomerRefund(f: CustomerRefundFacts): JournalEntryDraft {
  const foodPortion = f.amount - f.platformFeePortion;
  const feeNet = f.platformFeePortion - f.platformFeeVatPortion;
  const lines: JournalLine[] = [
    cr(ACCOUNTS.pspClearing, f.amount, "refund to customer"),
    dr(ACCOUNTS.deliveryFeeRevenue, feeNet, "fee refunded"),
    dr(ACCOUNTS.vatPayable, f.platformFeeVatPortion, "VAT on refunded fee"),
  ];
  if (f.funding === "restaurant_authorized") lines.push(dr(ACCOUNTS.merchantPayable(f.restaurantId), foodPortion, "authorized restaurant-fault refund"));
  else lines.push(dr(ACCOUNTS.customerCompensationExpense, foodPortion, "ABU9-funded refund"));
  return finalizeEntry({
    eventKey: `refund:${f.refundId}`,
    eventType: "refund.issued",
    occurredAt: f.occurredAt,
    description: `Refund ${f.refundId} for order ${f.orderId}`,
    refType: "order",
    refId: f.orderId,
    lines,
  });
}

/** After a dispute is resolved against a partner (or contractually auto-approved), recover the cost. */
export function postCompensationRecovery(args: {
  claimId: string;
  orderId: string;
  occurredAt: Date;
  amount: Halalas;
  party: { kind: "restaurant" | "logistics"; id: string };
}): JournalEntryDraft {
  const payable = args.party.kind === "restaurant" ? ACCOUNTS.merchantPayable(args.party.id) : ACCOUNTS.logisticsPayable(args.party.id);
  return finalizeEntry({
    eventKey: `compensation.recovery:${args.claimId}`,
    eventType: "compensation.recovered",
    occurredAt: args.occurredAt,
    description: `Recovery of compensation for order ${args.orderId} from ${args.party.kind} ${args.party.id}`,
    refType: "order",
    refId: args.orderId,
    lines: [dr(payable, args.amount), cr(ACCOUNTS.compensationRecovery, args.amount)],
  });
}

export function postPayout(args: {
  payoutId: string;
  party: { kind: "restaurant" | "logistics"; id: string };
  amount: Halalas;
  occurredAt: Date;
}): JournalEntryDraft {
  const payable = args.party.kind === "restaurant" ? ACCOUNTS.merchantPayable(args.party.id) : ACCOUNTS.logisticsPayable(args.party.id);
  return finalizeEntry({
    eventKey: `payout:${args.payoutId}`,
    eventType: "settlement.paid",
    occurredAt: args.occurredAt,
    description: `Settlement payout ${args.payoutId} to ${args.party.kind} ${args.party.id}`,
    refType: "settlement",
    refId: args.payoutId,
    lines: [dr(payable, args.amount), cr(ACCOUNTS.bank, args.amount)],
  });
}

/** ABU9+ payment: cash in, revenue deferred and recognised over the service period. */
export function postPlusPayment(args: { invoiceId: string; userId: string; gross: Halalas; vat: Halalas; occurredAt: Date }): JournalEntryDraft {
  return finalizeEntry({
    eventKey: `abu9plus.paid:${args.invoiceId}`,
    eventType: "abu9plus.paid",
    occurredAt: args.occurredAt,
    description: `ABU9+ invoice ${args.invoiceId} paid by ${args.userId}`,
    refType: "subscription_invoice",
    refId: args.invoiceId,
    lines: [
      dr(ACCOUNTS.pspClearing, args.gross),
      cr(ACCOUNTS.deferredSubscriptionRevenue, args.gross - args.vat),
      cr(ACCOUNTS.vatPayable, args.vat),
    ],
  });
}

/**
 * Straight-line recognition. Returns the cumulative amount that should be recognised by `asOf`
 * for a period [start, end). The caller posts the delta versus what is already recognised.
 */
export function recognizedToDate(netAmount: Halalas, start: Date, end: Date, asOf: Date): Halalas {
  const total = end.getTime() - start.getTime();
  if (total <= 0) throw new Error("invalid period");
  const elapsed = Math.min(Math.max(asOf.getTime() - start.getTime(), 0), total);
  return Math.floor((netAmount * elapsed) / total);
}

export function postRevenueRecognition(args: { invoiceId: string; seq: number; amount: Halalas; occurredAt: Date }): JournalEntryDraft {
  return finalizeEntry({
    eventKey: `abu9plus.recognized:${args.invoiceId}:${args.seq}`,
    eventType: "abu9plus.revenue_recognized",
    occurredAt: args.occurredAt,
    description: `ABU9+ revenue recognition for ${args.invoiceId}`,
    refType: "subscription_invoice",
    refId: args.invoiceId,
    lines: [dr(ACCOUNTS.deferredSubscriptionRevenue, args.amount), cr(ACCOUNTS.plusSubscriptionRevenue, args.amount)],
  });
}

/** Restaurant subscription invoice: billed as a receivable; NOT auto-netted against payables unless the contract allows it. */
export function postRestaurantSubscriptionInvoice(args: { invoiceId: string; restaurantId: string; gross: Halalas; vat: Halalas; occurredAt: Date }): JournalEntryDraft {
  return finalizeEntry({
    eventKey: `restaurant.subscription.invoiced:${args.invoiceId}`,
    eventType: "restaurant_subscription.invoiced",
    occurredAt: args.occurredAt,
    description: `Restaurant subscription invoice ${args.invoiceId}`,
    refType: "restaurant_invoice",
    refId: args.invoiceId,
    lines: [
      dr(ACCOUNTS.merchantReceivable(args.restaurantId), args.gross),
      cr(ACCOUNTS.restaurantSubscriptionRevenue, args.gross - args.vat),
      cr(ACCOUNTS.vatPayable, args.vat),
    ],
  });
}
