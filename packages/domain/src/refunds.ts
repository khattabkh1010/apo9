import type { Halalas } from "./money.ts";

/** Who the issue originated with. Determines who ultimately funds compensation — after due process. */
export type FaultParty = "abu9" | "restaurant" | "logistics" | "customer" | "external";

export interface ReasonCode {
  code: string;
  ar: string;
  en: string;
  defaultFault: FaultParty;
  /** Evidence the support agent / customer must attach before resolution. */
  evidence: Array<"photo" | "courier_gps" | "restaurant_statement" | "courier_statement" | "customer_statement" | "receipt">;
  /** Suggested resolution share of the affected amount (basis points). */
  suggestedShareBps: number;
  /** Eligible for instant automatic refund to the customer (ABU9 funds first). */
  instantEligible: boolean;
}

export const REASON_CODES: ReasonCode[] = [
  { code: "missing_item", ar: "صنف ناقص", en: "Missing item", defaultFault: "restaurant", evidence: ["customer_statement", "restaurant_statement"], suggestedShareBps: 10_000, instantEligible: true },
  { code: "wrong_item", ar: "صنف خاطئ", en: "Wrong item", defaultFault: "restaurant", evidence: ["photo"], suggestedShareBps: 10_000, instantEligible: true },
  { code: "food_quality", ar: "جودة الطعام", en: "Food quality", defaultFault: "restaurant", evidence: ["photo", "customer_statement"], suggestedShareBps: 5_000, instantEligible: false },
  { code: "spilled_damaged", ar: "طلب منسكب أو تالف", en: "Spilled or damaged", defaultFault: "logistics", evidence: ["photo", "courier_statement"], suggestedShareBps: 10_000, instantEligible: true },
  { code: "very_late", ar: "تأخير كبير", en: "Very late", defaultFault: "logistics", evidence: ["courier_gps"], suggestedShareBps: 2_500, instantEligible: true },
  { code: "never_arrived", ar: "لم يصل الطلب", en: "Never arrived", defaultFault: "logistics", evidence: ["courier_gps", "courier_statement"], suggestedShareBps: 10_000, instantEligible: false },
  { code: "restaurant_cancelled", ar: "ألغى المطعم بعد القبول", en: "Restaurant cancelled after acceptance", defaultFault: "restaurant", evidence: ["restaurant_statement"], suggestedShareBps: 10_000, instantEligible: true },
  { code: "app_error", ar: "خطأ تقني في التطبيق", en: "App / platform error", defaultFault: "abu9", evidence: [], suggestedShareBps: 10_000, instantEligible: true },
  { code: "customer_unreachable", ar: "تعذّر الوصول للعميل", en: "Customer unreachable", defaultFault: "customer", evidence: ["courier_gps", "courier_statement"], suggestedShareBps: 0, instantEligible: false },
  { code: "wrong_address", ar: "عنوان خاطئ", en: "Wrong address by customer", defaultFault: "customer", evidence: ["courier_gps"], suggestedShareBps: 0, instantEligible: false },
  { code: "weather_road_closure", ar: "ظروف طارئة (طقس/إغلاق طرق)", en: "Weather / road closure", defaultFault: "external", evidence: [], suggestedShareBps: 2_500, instantEligible: true },
];

export function reasonByCode(code: string): ReasonCode {
  const r = REASON_CODES.find((x) => x.code === code);
  if (!r) throw new Error(`unknown reason code ${code}`);
  return r;
}

export interface PartnerContractTerms {
  /** Contract explicitly authorises automatic deduction for these reason codes, if undisputed within the window. */
  autoDeductReasonCodes: string[];
  disputeWindowHours: number;
}

export type RecoveryPath =
  | { kind: "none"; why: string }
  | { kind: "absorb"; why: string } // ABU9 bears the cost
  | { kind: "claim_pending"; party: "restaurant" | "logistics"; deductibleAfter: Date; why: string };

/**
 * Decide how ABU9 may recover the cost of compensation from a partner. Never deducts immediately:
 * at best a claim is opened that becomes deductible only after the contractual dispute window passes
 * with no dispute, and only for reason codes the contract authorises.
 */
export function recoveryPath(args: { fault: FaultParty; reasonCode: string; openedAt: Date; terms: PartnerContractTerms | null }): RecoveryPath {
  if (args.fault === "abu9" || args.fault === "external") return { kind: "absorb", why: `fault=${args.fault}` };
  if (args.fault === "customer") return { kind: "none", why: "customer responsibility — no compensation" };
  const party = args.fault;
  if (!args.terms) return { kind: "absorb", why: `no signed terms with ${party}; recover only through manual dispute` };
  if (!args.terms.autoDeductReasonCodes.includes(args.reasonCode))
    return { kind: "absorb", why: `contract does not authorise deduction for ${args.reasonCode}; raise manual claim` };
  return {
    kind: "claim_pending",
    party,
    deductibleAfter: new Date(args.openedAt.getTime() + args.terms.disputeWindowHours * 3_600_000),
    why: `contract-authorised; deductible if undisputed after ${args.terms.disputeWindowHours}h`,
  };
}

export function suggestedRefund(args: { reasonCode: string; affectedAmount: Halalas }): Halalas {
  const r = reasonByCode(args.reasonCode);
  return Math.floor((args.affectedAmount * r.suggestedShareBps) / 10_000);
}
