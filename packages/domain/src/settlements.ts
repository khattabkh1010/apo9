import type { Halalas } from "./money.ts";

/**
 * Settlement period calculation in Asia/Riyadh (UTC+3, no DST).
 * Restaurants: weekly, Sunday 00:00 → next Sunday 00:00 Riyadh time (Saudi work week starts Sunday).
 * Logistics: monthly, 1st 00:00 → next month 1st 00:00 Riyadh time.
 */
const RIYADH_OFFSET_MS = 3 * 3_600_000;

export interface Period {
  start: Date;
  end: Date; // exclusive
}

export function weeklyPeriodContaining(at: Date): Period {
  const local = new Date(at.getTime() + RIYADH_OFFSET_MS);
  const dow = local.getUTCDay(); // 0 = Sunday
  const startLocal = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() - dow);
  const start = new Date(startLocal - RIYADH_OFFSET_MS);
  return { start, end: new Date(start.getTime() + 7 * 86_400_000) };
}

export function monthlyPeriodContaining(at: Date): Period {
  const local = new Date(at.getTime() + RIYADH_OFFSET_MS);
  const start = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), 1) - RIYADH_OFFSET_MS);
  const end = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth() + 1, 1) - RIYADH_OFFSET_MS);
  return { start, end };
}

export interface SettlementLineInput {
  kind: "order_payable" | "refund_authorized" | "compensation_recovery" | "adjustment" | "subscription_invoice_netting";
  amount: Halalas; // signed: + increases payout, − decreases
  refId: string;
  disputed: boolean;
}

export interface SettlementStatement {
  gross: Halalas;
  deductions: Halalas;
  withheldDisputed: Halalas;
  netPayable: Halalas;
  lines: SettlementLineInput[];
}

/**
 * Build a statement. Disputed negative lines are withheld from deduction (not applied) until resolved.
 * Undisputed balances are paid — they are never withheld because of an unrelated dispute.
 */
export function buildStatement(lines: SettlementLineInput[], opts: { allowSubscriptionNetting: boolean }): SettlementStatement {
  let gross = 0;
  let deductions = 0;
  let withheld = 0;
  const applied: SettlementLineInput[] = [];
  for (const l of lines) {
    if (l.kind === "subscription_invoice_netting" && !opts.allowSubscriptionNetting) continue;
    if (l.amount < 0 && l.disputed) {
      withheld += -l.amount;
      continue;
    }
    if (l.amount >= 0) gross += l.amount;
    else deductions += -l.amount;
    applied.push(l);
  }
  return { gross, deductions, withheldDisputed: withheld, netPayable: Math.max(0, gross - deductions), lines: applied };
}

export interface LogisticsRateCard {
  /** Per completed order, first (or only) order in a trip. */
  perOrder: Halalas;
  /** Per completed order when it was the second order in a batched trip. */
  perBatchedOrder: Halalas;
  /** Extra per km beyond included distance (per completed order). */
  perKmBeyond: Halalas;
  includedKm: number;
  /** Guaranteed hourly minimum for committed baseline capacity (if contracted). */
  committedHourlyMinimum: Halalas;
}

export function logisticsCompensation(rate: LogisticsRateCard, args: { distanceKm: number; batchedSecond: boolean }): Halalas {
  const base = args.batchedSecond ? rate.perBatchedOrder : rate.perOrder;
  const extra = Math.max(0, Math.ceil(args.distanceKm - rate.includedKm));
  return base + extra * rate.perKmBeyond;
}
