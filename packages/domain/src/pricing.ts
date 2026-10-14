import { type Halalas, vatIncluded } from "./money.ts";

/**
 * Delivery pricing configuration. Configured per zone by ops (admin › Delivery pricing).
 * All consumer-facing amounts are VAT-inclusive (KSA display requirement); VAT is extracted for the breakdown.
 */
export interface DeliveryPricingConfig {
  /** Basic delivery fee covering the first `baseDistanceKm` of road distance. */
  basicFee: Halalas;
  /** Distance covered by the basic fee. ABU9+ waives exactly this portion. */
  baseDistanceKm: number;
  /** Fee per increment beyond the base distance. */
  additionalFeePerIncrement: Halalas;
  /** Billing increment in km for distance beyond the base (e.g. 0.5 = charged per started 500 m). */
  additionalIncrementKm: number;
  /** Optional cap on the additional distance fee. */
  additionalFeeCap?: Halalas;
  /** Platform service fee (other applicable charges). 0 disables it. */
  serviceFee: Halalas;
  /** Small order fee applied when food net is below the threshold. 0 disables it. */
  smallOrderFee: Halalas;
  smallOrderThreshold: Halalas;
  /** VAT rate in basis points (1500 = 15%). Configurable; confirm with tax advisor. */
  vatRateBps: number;
}

export interface Abu9PlusRules {
  /** Minimum eligible food basket AFTER food discounts and BEFORE delivery charges. */
  minEligibleBasket: Halalas;
  /** Waive service fee for members? Not an approved benefit — default false. */
  waiveServiceFee: boolean;
}

export const DEFAULT_PLUS_RULES: Abu9PlusRules = { minEligibleBasket: 3500, waiveServiceFee: false };

export interface PricingInput {
  foodSubtotal: Halalas;
  /** Total food discounts (promotions, promo codes, loyalty redemptions applied to food). */
  foodDiscount: Halalas;
  roadDistanceKm: number;
  /** Whether the customer has an ABU9+ subscription with active benefits right now. */
  hasActivePlus: boolean;
  /** Whether the order is inside active ABU9 coverage (from the coverage engine). */
  inActiveCoverage: boolean;
  config: DeliveryPricingConfig;
  plusRules?: Abu9PlusRules;
}

export type PriceLineCode =
  | "food_subtotal"
  | "food_discount"
  | "basic_delivery_fee"
  | "additional_distance_fee"
  | "abu9_plus_discount"
  | "service_fee"
  | "small_order_fee"
  | "total"
  | "vat_included";

export interface PriceLine {
  code: PriceLineCode;
  amount: Halalas;
  labelAr: string;
  labelEn: string;
  /** Informational lines (e.g. VAT included) are shown but not summed. */
  informational?: boolean;
}

export interface PlusEligibility {
  eligible: boolean;
  reasons: Array<"not_member" | "below_minimum_basket" | "outside_coverage">;
  /** Amount the customer must add to reach the ABU9+ minimum basket, if that is the only blocker. */
  amountToQualify: Halalas;
}

export interface PriceBreakdown {
  lines: PriceLine[];
  foodNet: Halalas;
  basicDeliveryFee: Halalas;
  additionalDistanceFee: Halalas;
  plusDiscount: Halalas;
  serviceFee: Halalas;
  smallOrderFee: Halalas;
  total: Halalas;
  /** VAT contained in ABU9's own fees (delivery + service + small order), net of discounts. */
  vatOnPlatformFees: Halalas;
  /** VAT contained in the food amount — the restaurant's VAT, collected on its behalf. */
  vatOnFood: Halalas;
  plus: PlusEligibility;
}

export function additionalDistanceFee(distanceKm: number, cfg: DeliveryPricingConfig): Halalas {
  const extraKm = Math.max(0, distanceKm - cfg.baseDistanceKm);
  if (extraKm <= 1e-9) return 0;
  const increments = Math.ceil(round6(extraKm / cfg.additionalIncrementKm));
  const fee = increments * cfg.additionalFeePerIncrement;
  return cfg.additionalFeeCap !== undefined ? Math.min(fee, cfg.additionalFeeCap) : fee;
}

export function evaluatePlusEligibility(input: Pick<PricingInput, "hasActivePlus" | "inActiveCoverage" | "plusRules">, foodNet: Halalas): PlusEligibility {
  const rules = input.plusRules ?? DEFAULT_PLUS_RULES;
  const reasons: PlusEligibility["reasons"] = [];
  if (!input.hasActivePlus) reasons.push("not_member");
  if (!input.inActiveCoverage) reasons.push("outside_coverage");
  if (foodNet < rules.minEligibleBasket) reasons.push("below_minimum_basket");
  return {
    eligible: reasons.length === 0,
    reasons,
    amountToQualify: Math.max(0, rules.minEligibleBasket - foodNet),
  };
}

/**
 * Compute a fully transparent price breakdown.
 *
 * ABU9+ rule (approved): for eligible orders, the basic delivery fee (covering the first
 * `baseDistanceKm`, 2 km) is discounted in full. The customer still pays any additional
 * distance fee. ABU9+ is NOT unlimited free delivery at any distance.
 */
export function priceOrder(input: PricingInput): PriceBreakdown {
  const { config: cfg } = input;
  if (input.foodDiscount > input.foodSubtotal) throw new Error("food discount exceeds food subtotal");
  if (input.foodSubtotal < 0 || input.foodDiscount < 0) throw new Error("negative amounts not allowed");

  const foodNet = input.foodSubtotal - input.foodDiscount;
  const basic = cfg.basicFee;
  const additional = additionalDistanceFee(input.roadDistanceKm, cfg);
  const plus = evaluatePlusEligibility(input, foodNet);
  const rules = input.plusRules ?? DEFAULT_PLUS_RULES;
  const plusDiscount = plus.eligible ? basic : 0;
  const serviceFee = plus.eligible && rules.waiveServiceFee ? 0 : cfg.serviceFee;
  const smallOrderFee = cfg.smallOrderFee > 0 && foodNet < cfg.smallOrderThreshold ? cfg.smallOrderFee : 0;

  const platformFees = basic + additional - plusDiscount + serviceFee + smallOrderFee;
  const total = foodNet + platformFees;

  const lines: PriceLine[] = [
    { code: "food_subtotal", amount: input.foodSubtotal, labelAr: "قيمة الطعام", labelEn: "Food subtotal" },
  ];
  if (input.foodDiscount > 0)
    lines.push({ code: "food_discount", amount: -input.foodDiscount, labelAr: "خصومات الطعام", labelEn: "Food discounts" });
  lines.push({
    code: "basic_delivery_fee",
    amount: basic,
    labelAr: `رسوم التوصيل الأساسية (أول ${fmtKm(cfg.baseDistanceKm)} كم)`,
    labelEn: `Basic delivery fee (first ${fmtKm(cfg.baseDistanceKm)} km)`,
  });
  if (additional > 0)
    lines.push({
      code: "additional_distance_fee",
      amount: additional,
      labelAr: `رسوم المسافة الإضافية (${fmtKm(Math.max(0, input.roadDistanceKm - cfg.baseDistanceKm))} كم)`,
      labelEn: `Additional distance fee (${fmtKm(Math.max(0, input.roadDistanceKm - cfg.baseDistanceKm))} km)`,
    });
  if (plusDiscount > 0)
    lines.push({ code: "abu9_plus_discount", amount: -plusDiscount, labelAr: "خصم أبو9+", labelEn: "ABU9+ discount" });
  if (serviceFee > 0) lines.push({ code: "service_fee", amount: serviceFee, labelAr: "رسوم الخدمة", labelEn: "Service fee" });
  if (smallOrderFee > 0)
    lines.push({ code: "small_order_fee", amount: smallOrderFee, labelAr: "رسوم الطلب الصغير", labelEn: "Small order fee" });

  const vatOnPlatformFees = vatIncluded(platformFees, cfg.vatRateBps);
  const vatOnFood = vatIncluded(foodNet, cfg.vatRateBps);
  lines.push({ code: "vat_included", amount: vatOnPlatformFees + vatOnFood, labelAr: "ضريبة القيمة المضافة (مشمولة)", labelEn: "VAT (included)", informational: true });
  lines.push({ code: "total", amount: total, labelAr: "الإجمالي", labelEn: "Total" });

  return {
    lines,
    foodNet,
    basicDeliveryFee: basic,
    additionalDistanceFee: additional,
    plusDiscount,
    serviceFee,
    smallOrderFee,
    total,
    vatOnPlatformFees,
    vatOnFood,
    plus,
  };
}

/** Sum of non-informational, non-total lines must equal total. Used by tests and as a runtime guard. */
export function assertBreakdownConsistent(b: PriceBreakdown): void {
  const sum = b.lines.filter((l) => !l.informational && l.code !== "total").reduce((a, l) => a + l.amount, 0);
  if (sum !== b.total) throw new Error(`price breakdown inconsistent: lines=${sum} total=${b.total}`);
}

function fmtKm(km: number): string {
  return (Math.round(km * 10) / 10).toString();
}
function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}
