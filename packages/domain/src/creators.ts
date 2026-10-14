/**
 * Creator campaign rules (pure). Incentives are OPT-IN and configurable per campaign; nothing is
 * paid unless the campaign is approved, the creator opted in and was approved, and budget remains.
 */
export type IncentiveType = "none" | "fixed_per_order" | "percent_of_food";

export interface CampaignDraft {
  incentiveType: IncentiveType;
  /** Halalas for fixed_per_order, basis points for percent_of_food. */
  incentiveValue: number;
  budget: number;
  startsAt?: Date | null;
  endsAt?: Date | null;
}

export const CAMPAIGN_LIMITS = {
  fixedMin: 100, // SAR 1
  fixedMax: 5_000, // SAR 50 per attributed order
  percentMaxBp: 3_000, // 30% of food value
  maxDays: 90,
};

export function validateCampaign(c: CampaignDraft, now = new Date()): string[] {
  const p: string[] = [];
  if (c.incentiveType === "none" && c.incentiveValue !== 0) p.push("incentive value must be 0 when there is no incentive");
  if (c.incentiveType === "fixed_per_order" && (c.incentiveValue < CAMPAIGN_LIMITS.fixedMin || c.incentiveValue > CAMPAIGN_LIMITS.fixedMax)) p.push("fixed incentive must be between SAR 1 and SAR 50 per order");
  if (c.incentiveType === "percent_of_food" && (c.incentiveValue < 1 || c.incentiveValue > CAMPAIGN_LIMITS.percentMaxBp)) p.push("percent incentive must be between 0.01% and 30%");
  if (c.incentiveType !== "none" && c.budget <= 0) p.push("a paid incentive needs a budget");
  if (c.incentiveType === "fixed_per_order" && c.budget > 0 && c.budget < c.incentiveValue) p.push("budget is smaller than one incentive");
  if (c.budget < 0) p.push("budget cannot be negative");
  if (c.startsAt && c.endsAt && c.endsAt <= c.startsAt) p.push("end must be after start");
  const start = c.startsAt ?? now;
  if (c.endsAt && c.endsAt.getTime() - start.getTime() > CAMPAIGN_LIMITS.maxDays * 86_400_000) p.push(`campaigns run at most ${CAMPAIGN_LIMITS.maxDays} days`);
  return p;
}

/** Incentive owed for one attributed order (before the budget check). */
export function incentiveFor(type: IncentiveType, value: number, foodNet: number): number {
  if (type === "fixed_per_order") return value;
  if (type === "percent_of_food") return Math.floor((foodNet * value) / 10_000);
  return 0;
}

/** Four-eyes: whoever proposed a campaign cannot approve it. */
export const canApprove = (proposedBy: string | null, approver: string) => proposedBy !== approver;
