import { allocate, type Halalas } from "./money.ts";

export interface Promotion {
  id: string;
  code: string | null; // null = automatic
  restaurantId: string | null; // null = any restaurant
  kind: "percent" | "fixed";
  /** percent: basis points; fixed: halalas */
  value: number;
  maxDiscount: Halalas | null;
  minFoodSubtotal: Halalas;
  /** Funding split (basis points) between ABU9 and restaurant. */
  abu9ShareBps: number;
  restaurantShareBps: number;
  budget: Halalas;
  spent: Halalas;
  perCustomerLimit: number;
  firstOrderOnly: boolean;
  startsAt: Date;
  endsAt: Date;
  active: boolean;
}

export type PromoRejection =
  | "inactive"
  | "not_started"
  | "expired"
  | "wrong_restaurant"
  | "below_minimum"
  | "budget_exhausted"
  | "customer_limit_reached"
  | "first_order_only";

export interface PromoResult {
  ok: boolean;
  rejection?: PromoRejection;
  discount: Halalas;
  funding: { abu9: Halalas; restaurant: Halalas };
}

/** Evaluate a promotion. Discount is capped by the remaining approved budget — no overspend. */
export function evaluatePromotion(p: Promotion, args: { restaurantId: string; foodSubtotal: Halalas; at: Date; customerUses: number; customerOrderCount: number }): PromoResult {
  const no = (r: PromoRejection): PromoResult => ({ ok: false, rejection: r, discount: 0, funding: { abu9: 0, restaurant: 0 } });
  if (!p.active) return no("inactive");
  if (args.at < p.startsAt) return no("not_started");
  if (args.at >= p.endsAt) return no("expired");
  if (p.restaurantId && p.restaurantId !== args.restaurantId) return no("wrong_restaurant");
  if (args.foodSubtotal < p.minFoodSubtotal) return no("below_minimum");
  if (args.customerUses >= p.perCustomerLimit) return no("customer_limit_reached");
  if (p.firstOrderOnly && args.customerOrderCount > 0) return no("first_order_only");
  let discount = p.kind === "percent" ? Math.floor((args.foodSubtotal * p.value) / 10_000) : p.value;
  if (p.maxDiscount !== null) discount = Math.min(discount, p.maxDiscount);
  discount = Math.min(discount, args.foodSubtotal);
  const remaining = Math.max(0, p.budget - p.spent);
  if (remaining <= 0) return no("budget_exhausted");
  discount = Math.min(discount, remaining);
  const [abu9, restaurant] = allocate(discount, [p.abu9ShareBps, p.restaurantShareBps]);
  return { ok: true, discount, funding: { abu9: abu9!, restaurant: restaurant! } };
}

export const PROMO_REJECTION_TEXT: Record<PromoRejection, { ar: string; en: string }> = {
  inactive: { ar: "الكود غير فعّال", en: "Code is not active" },
  not_started: { ar: "العرض لم يبدأ بعد", en: "Offer has not started" },
  expired: { ar: "انتهى العرض", en: "Offer has expired" },
  wrong_restaurant: { ar: "الكود لا ينطبق على هذا المطعم", en: "Code does not apply to this restaurant" },
  below_minimum: { ar: "الطلب أقل من الحد الأدنى للعرض", en: "Order is below the offer minimum" },
  budget_exhausted: { ar: "نفدت ميزانية العرض", en: "Offer budget exhausted" },
  customer_limit_reached: { ar: "استخدمت هذا الكود من قبل", en: "You have already used this code" },
  first_order_only: { ar: "العرض للطلب الأول فقط", en: "First order only" },
};
