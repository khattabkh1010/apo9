import { createHash } from "node:crypto";
import type { Halalas } from "./money.ts";

// ═══════════════════════════ ABU9+ (customer) ═══════════════════════════

export type PlusStatus = "active" | "past_due" | "cancelled" | "expired";

export interface PlusSubscription {
  id: string;
  userId: string;
  status: PlusStatus;
  priceVariantId: string;
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
  cancelAtPeriodEnd: boolean;
  /** When a renewal payment failed; benefits continue during the grace period only. */
  pastDueSince: Date | null;
}

export interface PlusPriceVariant {
  id: string;
  label: string;
  interval: "month" | "year";
  price: Halalas;
  /** Relative assignment weight within an active experiment. */
  weight: number;
  active: boolean;
}

/** Test prices — NOT approved commercial decisions. Configurable by admins. */
export const PLUS_PRICE_EXPERIMENT: PlusPriceVariant[] = [
  { id: "plus_m_1999", label: "SAR 19.99 / month (test)", interval: "month", price: 1999, weight: 1, active: true },
  { id: "plus_m_2499", label: "SAR 24.99 / month (test)", interval: "month", price: 2499, weight: 1, active: true },
  { id: "plus_m_2999", label: "SAR 29.99 / month (test)", interval: "month", price: 2999, weight: 1, active: true },
];

export const PLUS_GRACE_DAYS = 3;

/** Deterministic, sticky experiment assignment: same user always sees the same price. */
export function assignPriceVariant(userId: string, experimentKey: string, variants: PlusPriceVariant[]): PlusPriceVariant {
  const live = variants.filter((v) => v.active && v.weight > 0).sort((a, b) => a.id.localeCompare(b.id));
  if (live.length === 0) throw new Error("no active ABU9+ price variants");
  const total = live.reduce((a, v) => a + v.weight, 0);
  const h = createHash("sha256").update(`${experimentKey}:${userId}`).digest().readUInt32BE(0) / 0x1_0000_0000;
  let acc = 0;
  for (const v of live) {
    acc += v.weight / total;
    if (h < acc) return v;
  }
  return live[live.length - 1]!;
}

export function addInterval(d: Date, interval: "month" | "year"): Date {
  const r = new Date(d);
  if (interval === "month") {
    const day = r.getUTCDate();
    r.setUTCMonth(r.getUTCMonth() + 1);
    if (r.getUTCDate() < day) r.setUTCDate(0); // clamp Jan 31 → Feb 28/29
  } else r.setUTCFullYear(r.getUTCFullYear() + 1);
  return r;
}

/** Are ABU9+ benefits usable right now? */
export function plusBenefitsActive(s: PlusSubscription | null, at: Date): boolean {
  if (!s) return false;
  if (at >= s.currentPeriodEnd && s.status !== "past_due") return false;
  if (s.status === "active") return at < s.currentPeriodEnd;
  if (s.status === "cancelled") return at < s.currentPeriodEnd; // cancel-at-period-end keeps benefits
  if (s.status === "past_due" && s.pastDueSince) return at.getTime() - s.pastDueSince.getTime() < PLUS_GRACE_DAYS * 86_400_000;
  return false;
}

export type PlusEvent =
  | { type: "renewal_succeeded"; at: Date; interval: "month" | "year" }
  | { type: "renewal_failed"; at: Date }
  | { type: "grace_expired"; at: Date }
  | { type: "cancel_requested"; at: Date }
  | { type: "resume_requested"; at: Date }
  | { type: "period_ended"; at: Date };

export function applyPlusEvent(s: PlusSubscription, e: PlusEvent): PlusSubscription {
  switch (e.type) {
    case "renewal_succeeded":
      if (s.cancelAtPeriodEnd) throw new Error("cannot renew a subscription set to cancel");
      return {
        ...s,
        status: "active",
        pastDueSince: null,
        currentPeriodStart: s.currentPeriodEnd,
        currentPeriodEnd: addInterval(s.currentPeriodEnd, e.interval),
      };
    case "renewal_failed":
      return { ...s, status: "past_due", pastDueSince: s.pastDueSince ?? e.at };
    case "grace_expired":
      return s.status === "past_due" ? { ...s, status: "expired" } : s;
    case "cancel_requested":
      if (s.status === "expired") return s;
      return { ...s, status: "cancelled", cancelAtPeriodEnd: true };
    case "resume_requested":
      if (s.status !== "cancelled" || e.at >= s.currentPeriodEnd) throw new Error("only a cancelled, unexpired subscription can be resumed");
      return { ...s, status: "active", cancelAtPeriodEnd: false };
    case "period_ended":
      return s.cancelAtPeriodEnd ? { ...s, status: "expired" } : s;
  }
}

/**
 * Refund policy (assumption, configurable): full refund if cancelled within the cooling-off window
 * with zero benefit usage; otherwise no refund for the current period — benefits run to period end.
 */
export function plusRefundOnCancel(args: { paid: Halalas; periodStart: Date; at: Date; benefitUses: number; coolingOffDays?: number }): Halalas {
  const days = args.coolingOffDays ?? 7;
  const within = args.at.getTime() - args.periodStart.getTime() <= days * 86_400_000;
  return within && args.benefitUses === 0 ? args.paid : 0;
}

// ═══════════════════════ Restaurant subscription plans ═══════════════════════

export interface RestaurantPlan {
  code: "starter" | "growth" | "pro" | "enterprise";
  nameAr: string;
  nameEn: string;
  monthlyPrice: Halalas | null; // null = custom
  minOrders: number;
  maxOrders: number | null;
}

/** Proposed plans, subject to validation. No percentage commission on food basket value. */
export const RESTAURANT_PLANS: RestaurantPlan[] = [
  { code: "starter", nameAr: "البداية", nameEn: "Starter", monthlyPrice: 69_900, minOrders: 0, maxOrders: 300 },
  { code: "growth", nameAr: "النمو", nameEn: "Growth", monthlyPrice: 99_900, minOrders: 301, maxOrders: 1000 },
  { code: "pro", nameAr: "المحترف", nameEn: "Pro", monthlyPrice: 189_900, minOrders: 1001, maxOrders: 3000 },
  { code: "enterprise", nameAr: "المؤسسات", nameEn: "Enterprise", monthlyPrice: null, minOrders: 3001, maxOrders: null },
];

export const RESTAURANT_TRIAL_DAYS = 30;

export function planForVolume(orders: number): RestaurantPlan {
  return RESTAURANT_PLANS.find((p) => orders >= p.minOrders && (p.maxOrders === null || orders <= p.maxOrders))!;
}

export function trialEndsAt(activatedAt: Date): Date {
  return new Date(activatedAt.getTime() + RESTAURANT_TRIAL_DAYS * 86_400_000);
}

export interface PlanChangeProposal {
  fromPlan: RestaurantPlan["code"];
  toPlan: RestaurantPlan["code"];
  reason: "volume_exceeded" | "volume_below" | "requested";
  effectiveAt: Date; // always the next renewal — never mid-cycle
  requiresConsent: true;
}

/**
 * Evaluated at cycle close. Volume over the plan ceiling never triggers a mid-cycle charge:
 * it produces a proposal effective at renewal, applied only after the restaurant consents.
 * What happens without consent (stay on plan / overage terms) is an OPEN COMMERCIAL DECISION.
 */
export function evaluatePlanAtCycleClose(current: RestaurantPlan["code"], ordersThisCycle: number, renewalAt: Date): PlanChangeProposal | null {
  const fitting = planForVolume(ordersThisCycle);
  if (fitting.code === current) return null;
  const order = RESTAURANT_PLANS.map((p) => p.code);
  const up = order.indexOf(fitting.code) > order.indexOf(current);
  return { fromPlan: current, toPlan: fitting.code, reason: up ? "volume_exceeded" : "volume_below", effectiveAt: renewalAt, requiresConsent: true };
}
